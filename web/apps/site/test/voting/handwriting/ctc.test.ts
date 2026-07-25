/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from "vitest";

import {
  greedyCtcDecode,
  marginConfidence,
  prefixBeamSearch,
} from "../../../src/voting/handwriting/recognition/ctc";
import {
  canonicalValue,
  evaluateRecognitionForCommit,
} from "../../../src/voting/handwriting/recognition/types";
import type { Recognition } from "../../../src/voting/handwriting/recognition/types";

const BLANK = 10;

function logitsForPath(path: number[]): Float32Array {
  const values = new Float32Array(path.length * 11).fill(-20);
  path.forEach((char, time) => {
    values[time * 11 + char] = 0;
  });
  return values;
}

function recognition(text: string, confidence: number): Recognition {
  return {
    requestId: 1,
    revision: 1,
    text,
    confidence,
    alternatives: [{ text, score: -1 }],
    inferenceMs: 1,
    diagnostics: {
      greedyText: text,
      topScore: -1,
      secondScore: -3,
      margin: 2,
      rawThreshold: 2,
      confidenceThreshold: 0.75,
      thresholdPassed: confidence >= 0.75,
      outputShape: [1, 63, 11],
      timing: {
        rasterizationMs: 0.5,
        inferenceMs: 1,
        decodeMs: 1,
        workerMs: 2,
        workerRoundTripMs: 3,
      },
    },
  };
}

describe("greedy CTC decoding", () => {
  it("collapses blanks and adjacent repeats but preserves blank-separated digits", () => {
    const values = logitsForPath([BLANK, 1, 1, BLANK, 1, BLANK, 0, 0, BLANK]);
    expect(greedyCtcDecode(values)).toBe("110");
  });

  it("returns empty text for blank-only and zero-step inputs", () => {
    expect(greedyCtcDecode(logitsForPath([BLANK, BLANK]))).toBe("");
    expect(greedyCtcDecode(new Float32Array())).toBe("");
  });
});

describe("prefix beam CTC decoding", () => {
  it("decodes repeated digits only when separated by a blank path", () => {
    const alternatives = prefixBeamSearch(logitsForPath([1, BLANK, 1]), 5);
    expect(alternatives[0]!.text).toBe("11");
    expect(alternatives[0]!.score).toBeGreaterThan(alternatives[1]!.score);
  });

  it("merges blank and repeated-label paths for the same prefix", () => {
    const values = new Float32Array(2 * 11).fill(Number.NEGATIVE_INFINITY);
    values[1] = Math.log(0.5);
    values[BLANK] = Math.log(0.5);
    values[11 + 1] = Math.log(0.5);
    values[11 + BLANK] = Math.log(0.5);

    const alternatives = prefixBeamSearch(values, 5);
    expect(alternatives[0]!.text).toBe("1");
    expect(alternatives[0]!.score).toBeCloseTo(Math.log(0.75), 6);
  });

  it("uses text ordering for exact score ties and retains the empty beam", () => {
    const tied = new Float32Array(11).fill(Math.log(1 / 11));
    expect(prefixBeamSearch(tied, 3).map(({ text }) => text)).toEqual([
      "",
      "0",
      "1",
    ]);
    expect(prefixBeamSearch(new Float32Array(), 10)).toEqual([
      { text: "", score: 0 },
    ]);
  });

  it("rejects malformed score matrices and invalid beam widths", () => {
    expect(() => prefixBeamSearch(new Float32Array(10))).toThrow(RangeError);
    expect(() => prefixBeamSearch(new Float32Array(11), 0)).toThrow(RangeError);
  });
});

describe("confidence and acceptance", () => {
  it("matches the selected margin formula at exact known values", () => {
    expect(marginConfidence(-1)).toBe(0);
    expect(marginConfidence(0)).toBe(0);
    expect(marginConfidence(Math.log(2))).toBeCloseTo(0.5, 14);
    expect(marginConfidence(Math.log(4))).toBeCloseTo(0.75, 14);
    expect(marginConfidence(6.916724525481752)).toBeCloseTo(
      0.9990089291427978,
      15,
    );
  });

  it("accepts only canonical unsigned decimal text from 0 through 255", () => {
    expect(canonicalValue("0")).toBe(0);
    expect(canonicalValue("13")).toBe(13);
    expect(canonicalValue("255")).toBe(255);
    for (const text of [
      "",
      "00",
      "01",
      "256",
      "999999999999999999999999999999",
      "-1",
      "1.0",
      " 1",
      "１２",
    ]) {
      expect(canonicalValue(text)).toBeNull();
    }
  });

  it("requires confidence, canonical text, and deck validity together", () => {
    const deck = new Set([1, 2, 3, 5, 8, 13]);
    expect(evaluateRecognitionForCommit(recognition("13", 0.8), deck)).toEqual({
      confidenceValid: true,
      canonicalValue: 13,
      canonicalValid: true,
      deckValid: true,
      canCommit: true,
    });
    expect(
      evaluateRecognitionForCommit(recognition("13", 0.74), deck).canCommit,
    ).toBe(false);
    expect(
      evaluateRecognitionForCommit(recognition("01", 1), deck).canCommit,
    ).toBe(false);
    expect(
      evaluateRecognitionForCommit(recognition("12", 1), deck).canCommit,
    ).toBe(false);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import metadataFixture from "../../../public/models/digits-crnn.json";
import { PREPROCESSING_CONFIG } from "../../../src/voting/handwriting/ink/rasterize";
import { marginConfidence } from "../../../src/voting/handwriting/recognition/ctc";
import type {
  InitializationDiagnostics,
  Recognition,
  RecognitionWorkerResponse,
} from "../../../src/voting/handwriting/recognition/types";
import {
  createRecognitionWorkerHandler,
  decodeRecognitionOutput,
  deckRelativeConfidence,
  validateModelMetadata,
} from "../../../src/voting/handwriting/recognition/worker";
import type { RecognitionWorkerBackend } from "../../../src/voting/handwriting/recognition/worker";

const initialization: InitializationDiagnostics = {
  ortVersion: "1.27.0",
  metadataUrl: "https://example.test/app/models/digits-crnn.json",
  modelUrl: "https://example.test/app/models/digits-crnn.onnx",
  metadataReady: true,
  modelReady: true,
  metadataFetchMs: 1,
  modelFetchMs: 1,
  modelVerifyMs: 1,
  sessionCreateMs: 2,
  initializationMs: 3,
};

const recognition: Recognition = {
  requestId: 7,
  revision: 4,
  text: "13",
  confidence: 0.9,
  alternatives: [
    { text: "13", score: -1 },
    { text: "18", score: -4 },
  ],
  inferenceMs: 1,
  diagnostics: {
    greedyText: "13",
    topScore: -1,
    secondScore: -4,
    margin: 3,
    rawConfidence: 0.9,
    deckConfidence: null,
    numericDeck: [1, 13],
    rawThreshold: 6.9,
    rawConfidenceThreshold: 0.99,
    rawThresholdPassed: false,
    outputShape: [1, 63, 11],
    timing: {
      rasterizationMs: null,
      inferenceMs: 1,
      decodeMs: 2,
      workerMs: 3,
      workerRoundTripMs: null,
    },
  },
};

const BLANK = 10;

function logitsForPath(path: readonly number[]): Float32Array {
  const values = new Float32Array(path.length * 11).fill(-20);
  path.forEach((label, time) => {
    values[time * 11 + label] = 0;
  });
  return values;
}

function logitsForDistribution(
  probabilities: Readonly<Record<number, number>>,
): Float32Array {
  const values = new Float32Array(11).fill(Number.NEGATIVE_INFINITY);
  for (const [label, probability] of Object.entries(probabilities)) {
    values[Number(label)] = Math.log(probability);
  }
  return values;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("model metadata validation", () => {
  it("accepts the committed model contract", () => {
    const metadata = validateModelMetadata(
      metadataFixture,
      PREPROCESSING_CONFIG.version,
    );
    expect(metadata.output.shape).toEqual([1, 63, 11]);
    expect(metadata.output.classes).toBe("0123456789");
    expect(metadata.output.blankIndex).toBe(10);
  });

  it.each([
    [
      "input shape",
      (value: typeof metadataFixture) => (value.input.shape[3] = 127),
    ],
    [
      "output classes",
      (value: typeof metadataFixture) => (value.output.classes = "123"),
    ],
    [
      "preprocessing version",
      (value: typeof metadataFixture) =>
        (value.input.preprocessingVersion = "other"),
    ],
    [
      "confidence formula",
      (value: typeof metadataFixture) => (value.confidence.formula = "other"),
    ],
  ])("rejects a changed %s", (_name, mutate) => {
    const changed = structuredClone(metadataFixture);
    mutate(changed);
    expect(() =>
      validateModelMetadata(changed, PREPROCESSING_CONFIG.version),
    ).toThrow("invalid model metadata");
  });
});

describe("deck-relative confidence", () => {
  it("compares a legal raw winner with the strongest other deck value", () => {
    const result = deckRelativeConfidence(
      logitsForPath([BLANK, 1, 3, BLANK]),
      "13",
      [8, 3, 1, 13, 5],
    );

    expect(result).toMatchObject({
      candidateValue: 13,
      competitorValue: 1,
    });
    expect(result?.confidence).toBeGreaterThan(0.95);
    expect(result?.confidence).toBe(
      marginConfidence(result?.margin ?? Number.NaN),
    );
  });

  it("does not promote an out-of-deck raw winner", () => {
    expect(
      deckRelativeConfidence(logitsForPath([7]), "7", [1, 3, 5, 8, 13]),
    ).toBeNull();
  });

  it("accepts a sole distinct deck value and ignores duplicates", () => {
    expect(
      deckRelativeConfidence(logitsForPath([1]), "1", [1, 1, 1]),
    ).toMatchObject({
      candidateValue: 1,
      competitorValue: null,
      competitorScore: null,
      margin: Number.POSITIVE_INFINITY,
      confidence: 1,
    });
  });

  it("returns zero confidence when another deck value scores higher", () => {
    expect(
      deckRelativeConfidence(logitsForPath([3]), "1", [1, 3]),
    ).toMatchObject({
      candidateValue: 1,
      competitorValue: 3,
      confidence: 0,
    });
  });
});

describe("recognition output decoding", () => {
  it("uses deck-relative confidence only when the raw winner is legal", () => {
    const decoded = decodeRecognitionOutput(
      logitsForDistribution({ 1: 0.5, 3: 0.01, 7: 0.49 }),
      [1, 3],
    );

    expect(decoded.text).toBe("1");
    expect(decoded.rawConfidence).toBeCloseTo(0.02, 6);
    expect(decoded.deckConfidence).toMatchObject({
      candidateValue: 1,
      competitorValue: 3,
    });
    expect(decoded.deckConfidence?.confidence).toBeCloseTo(0.98, 6);
    expect(decoded.confidence).toBeCloseTo(0.98, 6);
  });

  it("keeps raw confidence and never promotes a legal runner-up", () => {
    const decoded = decodeRecognitionOutput(
      logitsForDistribution({ 1: 0.49, 3: 0.01, 7: 0.5 }),
      [1, 3],
    );

    expect(decoded.text).toBe("7");
    expect(decoded.deckConfidence).toBeNull();
    expect(decoded.confidence).toBe(decoded.rawConfidence);
    expect(decoded.confidence).toBeCloseTo(0.02, 6);
  });
});

describe("recognition worker protocol", () => {
  it("reports initialization progress and returns correlated recognition", async () => {
    const responses: RecognitionWorkerResponse[] = [];
    const backend: RecognitionWorkerBackend = {
      initialize: vi.fn(async (_request, progress) => {
        progress({
          progress: 0.5,
          status: "Loading model",
          metadataReady: true,
          modelReady: false,
        });
        return initialization;
      }),
      recognize: vi.fn(async () => recognition),
    };
    const handle = createRecognitionWorkerHandler(
      (message) => responses.push(message),
      backend,
    );
    handle({
      type: "initialize",
      assetBaseUrl: "https://example.test/app/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    await flushPromises();
    handle({
      type: "recognize",
      requestId: 7,
      revision: 4,
      input: new ArrayBuffer(128 * 32 * 4),
      shape: [1, 1, 32, 128],
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      numericDeck: [1, 13],
    });
    await flushPromises();

    expect(responses.map(({ type }) => type)).toEqual([
      "status",
      "ready",
      "result",
    ]);
    expect(responses[2]).toMatchObject({
      type: "result",
      requestId: 7,
      revision: 4,
      recognition: { requestId: 7, revision: 4, text: "13" },
    });
  });

  it("never recognizes before readiness and structures inference failures", async () => {
    let finishInitialization:
      ((value: InitializationDiagnostics) => void) | undefined;
    const responses: RecognitionWorkerResponse[] = [];
    const backend: RecognitionWorkerBackend = {
      initialize: () =>
        new Promise((resolve) => {
          finishInitialization = resolve;
        }),
      recognize: vi.fn(async () => {
        throw new Error("session failed");
      }),
    };
    const handle = createRecognitionWorkerHandler(
      (message) => responses.push(message),
      backend,
    );
    const request = {
      type: "recognize" as const,
      requestId: 2,
      revision: 9,
      input: new ArrayBuffer(128 * 32 * 4),
      shape: [1, 1, 32, 128] as const,
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      numericDeck: [1, 13],
    };
    handle(request);
    expect(responses[0]).toMatchObject({
      type: "error",
      requestId: 2,
      error: { code: "not_ready", stage: "protocol" },
    });

    handle({
      type: "initialize",
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    finishInitialization?.(initialization);
    await flushPromises();
    handle(request);
    await flushPromises();
    expect(responses.at(-1)).toMatchObject({
      type: "error",
      requestId: 2,
      revision: 9,
      error: { code: "inference_failed", message: "session failed" },
    });
    expect(responses.some(({ type }) => type === "result")).toBe(false);
  });
});

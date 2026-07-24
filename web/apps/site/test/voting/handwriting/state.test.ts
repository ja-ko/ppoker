import { describe, expect, it } from "vitest";

import type { RecognizerStatus } from "../../../src/voting/handwriting/recognition/types";
import {
  classifyRecognition,
  initialRecognizerStatus,
  initialVoteInputState,
  HANDWRITING_CONFIDENCE_THRESHOLD,
  recognizerReducer,
  voteInputReducer,
} from "../../../src/voting/handwriting/state";
import type {
  VoteInputEvent,
  VoteInputState,
} from "../../../src/voting/handwriting/state";

function reduce(
  state: VoteInputState,
  ...events: VoteInputEvent[]
): VoteInputState {
  return events.reduce(voteInputReducer, state);
}

describe("vote input reducer", () => {
  it("follows the complete successful transition table", () => {
    const drawing = reduce(initialVoteInputState, {
      type: "POINTER_ACCEPTED",
      revision: 1,
    });
    expect(drawing.status).toBe("drawing");

    const settling = reduce(drawing, {
      type: "STROKE_COMPLETED",
      revision: 1,
    });
    expect(settling.status).toBe("settling");

    const committing = reduce(settling, {
      type: "BEGIN_COMMIT",
      revision: 1,
      value: 13,
      effectMotion: "full",
    });
    expect(committing).toMatchObject({ status: "committing", value: 13 });

    const committed = reduce(committing, {
      type: "EFFECT_COMPLETED",
      revision: 1,
    });
    expect(committed).toMatchObject({ status: "committed", value: 13 });

    const clearing = reduce(committed, {
      type: "CLEAR",
      revision: 2,
      effectMotion: "reduced",
    });
    expect(clearing).toMatchObject({
      status: "clearing",
      revision: 2,
      value: 13,
      effectMotion: "reduced",
    });
    expect(reduce(clearing, { type: "EFFECT_COMPLETED", revision: 2 })).toEqual(
      { ...initialVoteInputState, revision: 2 },
    );
  });

  it("models rejection, cancellation, unavailable runtime, and retry", () => {
    const settling = reduce(
      initialVoteInputState,
      { type: "POINTER_ACCEPTED", revision: 1 },
      { type: "STROKE_COMPLETED", revision: 1 },
    );
    const rejecting = reduce(settling, {
      type: "BEGIN_REJECTION",
      revision: 1,
      rejection: "invalid",
      effectMotion: "full",
    });
    expect(rejecting).toMatchObject({
      status: "rejecting",
      rejection: "invalid",
    });
    expect(
      reduce(rejecting, { type: "EFFECT_COMPLETED", revision: 1 }),
    ).toEqual({ ...initialVoteInputState, revision: 1 });

    const unavailable = reduce(settling, {
      type: "RECOGNIZER_UNAVAILABLE",
      revision: 1,
    });
    expect(unavailable.status).toBe("drawing");
    expect(
      reduce(unavailable, { type: "RETRY_SETTLING", revision: 1 }).status,
    ).toBe("settling");
    expect(
      reduce(unavailable, { type: "STROKE_CANCELLED", revision: 1 }).status,
    ).toBe("drawing");
  });

  it("returns inference failures to drawing without losing the revision", () => {
    const failed = reduce(
      initialVoteInputState,
      { type: "POINTER_ACCEPTED", revision: 1 },
      { type: "STROKE_COMPLETED", revision: 1 },
      { type: "INFERENCE_FAILED", revision: 1, message: "worker failed" },
    );
    expect(failed).toMatchObject({
      status: "drawing",
      revision: 1,
      inferenceError: "worker failed",
    });
  });

  it("cancels settling, committing, and rejecting with a newer pointer revision", () => {
    const base = reduce(
      initialVoteInputState,
      { type: "POINTER_ACCEPTED", revision: 1 },
      { type: "STROKE_COMPLETED", revision: 1 },
    );
    const states = [
      base,
      reduce(base, {
        type: "BEGIN_COMMIT",
        revision: 1,
        value: 5,
        effectMotion: "full",
      }),
      reduce(base, {
        type: "BEGIN_REJECTION",
        revision: 1,
        rejection: "unclaimed",
        effectMotion: "reduced",
      }),
    ];
    for (const state of states) {
      expect(reduce(state, { type: "POINTER_ACCEPTED", revision: 2 })).toEqual({
        status: "drawing",
        revision: 2,
        value: null,
        rejection: null,
        inferenceError: null,
        effectMotion: null,
      });
    }
  });

  it("guards stale effects and allows a replacement drawing after commit", () => {
    const committed = reduce(
      initialVoteInputState,
      { type: "POINTER_ACCEPTED", revision: 1 },
      { type: "STROKE_COMPLETED", revision: 1 },
      {
        type: "BEGIN_COMMIT",
        revision: 1,
        value: 8,
        effectMotion: "full",
      },
      { type: "EFFECT_COMPLETED", revision: 1 },
    );
    expect(reduce(committed, { type: "EFFECT_COMPLETED", revision: 0 })).toBe(
      committed,
    );
    expect(
      reduce(committed, { type: "POINTER_ACCEPTED", revision: 2 }),
    ).toMatchObject({ revision: 2, status: "drawing", value: null });
  });
});

describe("recognizer reducer", () => {
  it("tracks loading, failure, retry loading, and ready separately from input", () => {
    const failed: RecognizerStatus = {
      readiness: "failed",
      progress: 0,
      status: "model failed",
      metadataReady: true,
      modelReady: false,
      error: {
        code: "initialization_failed",
        message: "model failed",
        stage: "initialization",
        recoverable: true,
      },
    };
    const loading: RecognizerStatus = {
      ...initialRecognizerStatus,
      status: "Retrying",
    };
    const ready: RecognizerStatus = {
      readiness: "ready",
      progress: 1,
      status: "Recognizer ready",
      metadataReady: true,
      modelReady: true,
    };
    expect(
      recognizerReducer(initialRecognizerStatus, {
        type: "STATUS_CHANGED",
        status: failed,
      }),
    ).toBe(failed);
    expect(
      recognizerReducer(failed, { type: "STATUS_CHANGED", status: loading }),
    ).toBe(loading);
    expect(
      recognizerReducer(loading, { type: "STATUS_CHANGED", status: ready }),
    ).toBe(ready);
  });
});

describe("recognition disposition", () => {
  it.each([
    ["5", 0.95, [1, 5, 13], { type: "commit", value: 5, delay: "base" }],
    ["1", 0.95, [1, 13], { type: "commit", value: 1, delay: "prefix" }],
    ["1", 0.95, [13], { type: "reject", rejection: "incomplete" }],
    ["4", 0.95, [1, 5, 13], { type: "reject", rejection: "invalid" }],
    ["5", 0.89, [5], { type: "reject", rejection: "unclaimed" }],
    ["01", 1, [1], { type: "reject", rejection: "unclaimed" }],
    ["256", 1, [1], { type: "reject", rejection: "unclaimed" }],
    ["", 1, [1], { type: "reject", rejection: "unclaimed" }],
  ])(
    "classifies %s without deck snapping",
    (text, confidence, deck, expected) => {
      expect(classifyRecognition({ text, confidence }, deck)).toEqual(expected);
    },
  );

  it("uses one fixed handwriting usability threshold", () => {
    expect(HANDWRITING_CONFIDENCE_THRESHOLD).toBe(0.95);
  });
});

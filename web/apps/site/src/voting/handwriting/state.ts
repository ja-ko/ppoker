import { canonicalValue } from "./recognition/types";
import type { Recognition, RecognizerStatus } from "./recognition/types";

// Fixed usability heuristic from the browser POC, not a correctness probability.
export const HANDWRITING_CONFIDENCE_THRESHOLD = 0.95;

export type VoteInputStatus =
  | "empty"
  | "drawing"
  | "settling"
  | "committing"
  | "committed"
  | "rejecting"
  | "clearing";

export type RejectionKind = "incomplete" | "invalid" | "unclaimed";
export type EffectMotion = "full" | "reduced";

export interface VoteInputState {
  status: VoteInputStatus;
  revision: number;
  value: number | null;
  rejection: RejectionKind | null;
  inferenceError: string | null;
  effectMotion: EffectMotion | null;
}

export type VoteInputEvent =
  | { type: "POINTER_ACCEPTED"; revision: number }
  | { type: "STROKE_COMPLETED"; revision: number }
  | { type: "STROKE_CANCELLED"; revision: number }
  | { type: "RETRY_SETTLING"; revision: number }
  | { type: "RECOGNIZER_UNAVAILABLE"; revision: number }
  | { type: "INFERENCE_FAILED"; revision: number; message: string }
  | {
      type: "BEGIN_COMMIT";
      revision: number;
      value: number;
      effectMotion: EffectMotion;
    }
  | {
      type: "BEGIN_REJECTION";
      revision: number;
      rejection: RejectionKind;
      effectMotion: EffectMotion;
    }
  | { type: "EFFECT_COMPLETED"; revision: number }
  | { type: "CLEAR"; revision: number; effectMotion: EffectMotion };

export const initialVoteInputState: VoteInputState = {
  status: "empty",
  revision: 0,
  value: null,
  rejection: null,
  inferenceError: null,
  effectMotion: null,
};

function isCurrent(state: VoteInputState, revision: number): boolean {
  return revision === state.revision;
}

export function voteInputReducer(
  state: VoteInputState,
  event: VoteInputEvent,
): VoteInputState {
  switch (event.type) {
    case "POINTER_ACCEPTED":
      if (event.revision <= state.revision) {
        return state;
      }
      return {
        status: "drawing",
        revision: event.revision,
        value: null,
        rejection: null,
        inferenceError: null,
        effectMotion: null,
      };
    case "STROKE_COMPLETED":
    case "RETRY_SETTLING":
      if (!isCurrent(state, event.revision) || state.status !== "drawing") {
        return state;
      }
      return { ...state, status: "settling", inferenceError: null };
    case "STROKE_CANCELLED":
      if (!isCurrent(state, event.revision) || state.status !== "drawing") {
        return state;
      }
      return { ...state, inferenceError: null };
    case "RECOGNIZER_UNAVAILABLE":
      if (!isCurrent(state, event.revision) || state.status !== "settling") {
        return state;
      }
      return { ...state, status: "drawing" };
    case "INFERENCE_FAILED":
      if (!isCurrent(state, event.revision) || state.status !== "settling") {
        return state;
      }
      return {
        ...state,
        status: "drawing",
        inferenceError: event.message,
      };
    case "BEGIN_COMMIT":
      if (!isCurrent(state, event.revision) || state.status !== "settling") {
        return state;
      }
      return {
        ...state,
        status: "committing",
        value: event.value,
        rejection: null,
        inferenceError: null,
        effectMotion: event.effectMotion,
      };
    case "BEGIN_REJECTION":
      if (!isCurrent(state, event.revision) || state.status !== "settling") {
        return state;
      }
      return {
        ...state,
        status: "rejecting",
        value: null,
        rejection: event.rejection,
        inferenceError: null,
        effectMotion: event.effectMotion,
      };
    case "EFFECT_COMPLETED":
      if (!isCurrent(state, event.revision)) {
        return state;
      }
      if (state.status === "committing") {
        return { ...state, status: "committed", effectMotion: null };
      }
      if (state.status === "rejecting" || state.status === "clearing") {
        return {
          status: "empty",
          revision: state.revision,
          value: null,
          rejection: null,
          inferenceError: null,
          effectMotion: null,
        };
      }
      return state;
    case "CLEAR":
      if (event.revision <= state.revision) {
        return state;
      }
      return {
        status: "clearing",
        revision: event.revision,
        value: state.status === "committed" ? state.value : null,
        rejection: null,
        inferenceError: null,
        effectMotion: event.effectMotion,
      };
  }
}

export interface RecognizerEvent {
  type: "STATUS_CHANGED";
  status: RecognizerStatus;
}

export const initialRecognizerStatus: RecognizerStatus = {
  readiness: "loading",
  progress: 0,
  status: "Starting recognition worker",
  metadataReady: false,
  modelReady: false,
};

export function recognizerReducer(
  _state: RecognizerStatus,
  event: RecognizerEvent,
): RecognizerStatus {
  return event.status;
}

export type RecognitionDisposition =
  | { type: "commit"; value: number; delay: "base" | "prefix" }
  | { type: "reject"; rejection: RejectionKind };

export function classifyRecognition(
  recognition: Pick<Recognition, "text" | "confidence">,
  numericDeck: readonly number[],
): RecognitionDisposition {
  const value = canonicalValue(recognition.text);
  if (
    recognition.confidence < HANDWRITING_CONFIDENCE_THRESHOLD ||
    value === null
  ) {
    return { type: "reject", rejection: "unclaimed" };
  }

  const text = String(value);
  const exact = numericDeck.includes(value);
  const longerPrefix = numericDeck.some((deckValue) => {
    const deckText = String(deckValue);
    return deckText.length > text.length && deckText.startsWith(text);
  });

  if (exact) {
    return {
      type: "commit",
      value,
      delay: longerPrefix ? "prefix" : "base",
    };
  }
  if (longerPrefix) {
    return { type: "reject", rejection: "incomplete" };
  }
  return { type: "reject", rejection: "invalid" };
}

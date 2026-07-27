export const ORT_VERSION = "1.27.0";
export const MODEL_METADATA_PATH = "models/digits-crnn.json";
export const MODEL_SHA256 =
  "bea69199be71c01a35f4485ad853ef6fd11608c616c452598cb3f330922db9af";
export const MODEL_INPUT_SHAPE = [1, 1, 32, 128] as const;
export const MODEL_OUTPUT_SHAPE = [1, 63, 11] as const;
export const MODEL_CLASSES = "0123456789";
export const CTC_BLANK_INDEX = 10;
export const DEFAULT_BEAM_WIDTH = 10;
export const CONFIDENCE_FORMULA =
  "1 - exp(-max(top-minus-second CTC sequence log-score margin, 0))";

export type ModelInputShape = typeof MODEL_INPUT_SHAPE;
export type ModelOutputShape = typeof MODEL_OUTPUT_SHAPE;

export interface RecognitionAlternative {
  text: string;
  /** Beam-estimated natural-log CTC sequence score. */
  score: number;
}

export interface RecognitionTiming {
  /** Supplied by the caller when it measures rasterization before transfer. */
  rasterizationMs: number | null;
  /** Time spent in ONNX Runtime's session.run. */
  inferenceMs: number;
  decodeMs: number;
  /** Total tensor validation, inference, and decoding time in the worker. */
  workerMs: number;
  /** Filled by RecognitionClient after the worker response arrives. */
  workerRoundTripMs: number | null;
}

export interface DeckConfidenceDiagnostics {
  candidateValue: number;
  /** Exact natural-log CTC sequence score for the raw winner. */
  candidateScore: number;
  competitorValue: number | null;
  /** Exact score for the strongest other deck value, or null when absent. */
  competitorScore: number | null;
  margin: number;
  confidence: number;
}

export interface RecognitionDiagnostics {
  greedyText: string;
  topScore: number;
  secondScore: number;
  margin: number;
  /** Unrestricted beam top-versus-second confidence. */
  rawConfidence: number;
  /** Present only when the unrestricted winner is an exact deck value. */
  deckConfidence: DeckConfidenceDiagnostics | null;
  numericDeck: number[];
  rawThreshold: number;
  /** Synthetic model-metadata threshold for rawConfidence. */
  rawConfidenceThreshold: number;
  rawThresholdPassed: boolean;
  outputShape: ModelOutputShape;
  timing: RecognitionTiming;
}

export interface Recognition {
  requestId: number;
  revision: number;
  /** Raw unconstrained CTC prediction; it is not automatically safe to commit. */
  text: string;
  /** Effective margin heuristic used by the application, not a probability. */
  confidence: number;
  alternatives: RecognitionAlternative[];
  inferenceMs: number;
  diagnostics: RecognitionDiagnostics;
}

export interface InitializationDiagnostics {
  ortVersion: string;
  metadataUrl: string;
  modelUrl: string;
  metadataReady: boolean;
  modelReady: boolean;
  metadataFetchMs: number;
  modelFetchMs: number;
  modelVerifyMs: number;
  sessionCreateMs: number;
  initializationMs: number;
}

export type RecognizerReadiness = "loading" | "ready" | "failed";

export type RecognitionErrorStage =
  "initialization" | "inference" | "protocol" | "worker";

export interface RecognitionError {
  code: string;
  message: string;
  stage: RecognitionErrorStage;
  recoverable: boolean;
}

export interface RecognizerStatus {
  readiness: RecognizerReadiness;
  progress: number;
  status: string;
  metadataReady: boolean;
  modelReady: boolean;
  initialization?: InitializationDiagnostics;
  error?: RecognitionError;
}

export interface ModelMetadata {
  schemaVersion: number;
  model: {
    path: string;
    sha256: string;
    bytes: number;
  };
  input: {
    name: string;
    dtype: string;
    shape: number[];
    range: number[];
    polarity: string;
    preprocessingVersion: string;
  };
  output: {
    name: string;
    dtype: string;
    shape: number[];
    values: string;
    classes: string;
    blankIndex: number;
  };
  confidence: {
    decoder: string;
    heuristic: string;
    formula: string;
    raw_threshold: number;
    confidence_threshold: number;
    canonicalValidationRequiredForAcceptance: boolean;
    deckValidationRequiredForAcceptance: boolean;
  };
}

export interface RecognitionInput {
  data: Float32Array;
  shape: ModelInputShape;
  preprocessingVersion: string;
  rasterizationMs?: number;
}

export interface InitializeWorkerRequest {
  type: "initialize";
  assetBaseUrl: string;
  preprocessingVersion: string;
}

export interface RecognizeWorkerRequest {
  type: "recognize";
  requestId: number;
  revision: number;
  input: ArrayBuffer;
  shape: ModelInputShape;
  preprocessingVersion: string;
  numericDeck: number[];
}

export type RecognitionWorkerRequest =
  InitializeWorkerRequest | RecognizeWorkerRequest;

export interface WorkerStatusMessage {
  type: "status";
  progress: number;
  status: string;
  metadataReady: boolean;
  modelReady: boolean;
}

export interface WorkerReadyMessage {
  type: "ready";
  diagnostics: InitializationDiagnostics;
}

export interface WorkerResultMessage {
  type: "result";
  requestId: number;
  revision: number;
  recognition: Recognition;
}

export interface WorkerErrorMessage {
  type: "error";
  requestId?: number;
  revision?: number;
  error: RecognitionError;
}

export type RecognitionWorkerResponse =
  | WorkerStatusMessage
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

export function canonicalValue(text: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= 255 ? value : null;
}

export function normalizeNumericDeck(values: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
      throw new RangeError(
        "numeric deck values must be integers within 0..255",
      );
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => left - right);
}

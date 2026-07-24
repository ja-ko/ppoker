import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as ort from "onnxruntime-web/wasm";

import { greedyCtcDecode, marginConfidence, prefixBeamSearch } from "./ctc";
import type {
  InitializationDiagnostics,
  InitializeWorkerRequest,
  ModelMetadata,
  Recognition,
  RecognitionError,
  RecognitionWorkerRequest,
  RecognitionWorkerResponse,
  RecognizeWorkerRequest,
  WorkerStatusMessage,
} from "./types";
import {
  CONFIDENCE_FORMULA,
  CTC_BLANK_INDEX,
  DEFAULT_BEAM_WIDTH,
  MODEL_CLASSES,
  MODEL_INPUT_SHAPE,
  MODEL_METADATA_PATH,
  MODEL_OUTPUT_SHAPE,
  MODEL_SHA256,
  ORT_VERSION,
} from "./types";

const ORT_ASSETS = {
  mjs: "ort/ort-wasm-simd-threaded.mjs",
  wasm: "ort/ort-wasm-simd-threaded.wasm",
} as const;

function now(): number {
  return performance.now();
}

function arraysEqual(
  actual: readonly (number | string)[],
  expected: readonly number[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireContract(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`invalid model metadata: ${message}`);
  }
}

export function validateModelMetadata(
  value: unknown,
  preprocessingVersion: string,
): ModelMetadata {
  const root = requireRecord(value, "model metadata");
  const model = requireRecord(root["model"], "model");
  const input = requireRecord(root["input"], "input");
  const output = requireRecord(root["output"], "output");
  const confidence = requireRecord(root["confidence"], "confidence");

  requireContract(root["schemaVersion"] === 2, "schemaVersion must be 2");
  requireContract(
    model["path"] === "digits-crnn.onnx",
    "unexpected model path",
  );
  requireContract(model["sha256"] === MODEL_SHA256, "unexpected model SHA-256");
  requireContract(
    typeof model["bytes"] === "number" && model["bytes"] > 0,
    "model byte length must be positive",
  );
  requireContract(input["name"] === "input", "input name must be input");
  requireContract(input["dtype"] === "float32", "input type must be float32");
  requireContract(
    Array.isArray(input["shape"]) &&
      arraysEqual(input["shape"], MODEL_INPUT_SHAPE),
    "input shape must be [1,1,32,128]",
  );
  requireContract(
    Array.isArray(input["range"]) && arraysEqual(input["range"], [0, 1]),
    "input range must be [0,1]",
  );
  requireContract(
    input["polarity"] === "white ink on black",
    "input polarity must be white ink on black",
  );
  requireContract(
    input["preprocessingVersion"] === preprocessingVersion,
    `preprocessing version must be ${preprocessingVersion}`,
  );
  requireContract(output["name"] === "output", "output name must be output");
  requireContract(output["dtype"] === "float32", "output type must be float32");
  requireContract(
    Array.isArray(output["shape"]) &&
      arraysEqual(output["shape"], MODEL_OUTPUT_SHAPE),
    "output shape must be [1,63,11]",
  );
  requireContract(
    output["values"] === "natural-log probabilities",
    "output values must be natural-log probabilities",
  );
  requireContract(
    output["classes"] === MODEL_CLASSES,
    "classes must be 0 through 9",
  );
  requireContract(
    output["blankIndex"] === CTC_BLANK_INDEX,
    "blank index must be 10",
  );
  requireContract(
    confidence["decoder"] === "CTC prefix beam width 10",
    "decoder must be CTC prefix beam width 10",
  );
  requireContract(
    confidence["heuristic"] === "margin",
    "heuristic must be margin",
  );
  requireContract(
    confidence["formula"] === CONFIDENCE_FORMULA,
    "confidence formula does not match the runtime",
  );
  requireContract(
    typeof confidence["raw_threshold"] === "number" &&
      Number.isFinite(confidence["raw_threshold"]),
    "raw confidence threshold must be finite",
  );
  requireContract(
    typeof confidence["confidence_threshold"] === "number" &&
      confidence["confidence_threshold"] ===
        marginConfidence(confidence["raw_threshold"]),
    "confidence threshold does not match the margin formula",
  );
  requireContract(
    confidence["canonicalValidationRequiredForAcceptance"] === true &&
      confidence["deckValidationRequiredForAcceptance"] === true,
    "canonical and deck validation must be required",
  );
  return value as ModelMetadata;
}

export function verifyModelBytes(
  bytes: ArrayBuffer | Uint8Array,
  model: Pick<ModelMetadata["model"], "bytes" | "sha256">,
): Uint8Array {
  // Pure JS keeps verification available on plain LAN HTTP without SubtleCrypto.
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength !== model.bytes) {
    throw new Error(
      `model byte length ${String(data.byteLength)} does not match metadata ${String(model.bytes)}`,
    );
  }
  const actualSha256 = bytesToHex(sha256(data));
  if (actualSha256 !== model.sha256) {
    throw new Error(
      `model SHA-256 ${actualSha256} does not match metadata ${model.sha256}`,
    );
  }
  return data;
}

function validateSession(
  session: ort.InferenceSession,
  metadata: ModelMetadata,
): void {
  requireContract(
    session.inputNames.length === 1 &&
      session.inputNames[0] === metadata.input.name,
    "session input name does not match metadata",
  );
  requireContract(
    session.outputNames.length === 1 &&
      session.outputNames[0] === metadata.output.name,
    "session output name does not match metadata",
  );
  const input = session.inputMetadata[0];
  const output = session.outputMetadata[0];
  requireContract(
    input?.isTensor === true && input.type === "float32",
    "session input must be a float32 tensor",
  );
  requireContract(
    arraysEqual(input.shape, MODEL_INPUT_SHAPE),
    "session input shape does not match metadata",
  );
  requireContract(
    output?.isTensor === true && output.type === "float32",
    "session output must be a float32 tensor",
  );
  requireContract(
    arraysEqual(output.shape, MODEL_OUTPUT_SHAPE),
    "session output shape does not match metadata",
  );
}

function validateInput(request: RecognizeWorkerRequest): Float32Array {
  if (
    !arraysEqual(request.shape, MODEL_INPUT_SHAPE) ||
    request.input.byteLength !== MODEL_INPUT_SHAPE[2] * MODEL_INPUT_SHAPE[3] * 4
  ) {
    throw new RangeError("recognition input must be Float32 [1,1,32,128]");
  }
  const input = new Float32Array(request.input);
  for (const value of input) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        "recognition input values must be finite and within 0..1",
      );
    }
  }
  return input;
}

export interface RecognitionWorkerBackend {
  initialize(
    request: InitializeWorkerRequest,
    progress: (status: Omit<WorkerStatusMessage, "type">) => void,
  ): Promise<InitializationDiagnostics>;
  recognize(request: RecognizeWorkerRequest): Promise<Recognition>;
}

export class OrtRecognitionBackend implements RecognitionWorkerBackend {
  private session: ort.InferenceSession | null = null;
  private metadata: ModelMetadata | null = null;
  private preprocessingVersion: string | null = null;

  async initialize(
    request: InitializeWorkerRequest,
    progress: (status: Omit<WorkerStatusMessage, "type">) => void,
  ): Promise<InitializationDiagnostics> {
    if (this.session) {
      throw new Error("recognition worker is already initialized");
    }
    const startedAt = now();
    const baseUrl = new URL(request.assetBaseUrl);
    const metadataUrl = new URL(MODEL_METADATA_PATH, baseUrl).href;
    progress({
      progress: 0.1,
      status: "Loading model metadata",
      metadataReady: false,
      modelReady: false,
    });
    const metadataStartedAt = now();
    const response = await fetch(metadataUrl);
    if (!response.ok) {
      throw new Error(
        `model metadata request failed with HTTP ${String(response.status)}`,
      );
    }
    const metadata = validateModelMetadata(
      await response.json(),
      request.preprocessingVersion,
    );
    const metadataFetchMs = now() - metadataStartedAt;
    const modelUrl = new URL(metadata.model.path, metadataUrl).href;

    progress({
      progress: 0.35,
      status: "Fetching recognition model",
      metadataReady: true,
      modelReady: false,
    });
    const modelStartedAt = now();
    const modelResponse = await fetch(modelUrl);
    if (!modelResponse.ok) {
      throw new Error(
        `recognition model request failed with HTTP ${String(modelResponse.status)}`,
      );
    }
    const modelBuffer = await modelResponse.arrayBuffer();
    const modelFetchMs = now() - modelStartedAt;

    progress({
      progress: 0.5,
      status: "Verifying recognition model",
      metadataReady: true,
      modelReady: false,
    });
    const verifyStartedAt = now();
    const modelBytes = verifyModelBytes(modelBuffer, metadata.model);
    const modelVerifyMs = now() - verifyStartedAt;

    progress({
      progress: 0.65,
      status: "Initializing WASM runtime",
      metadataReady: true,
      modelReady: false,
    });
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = {
      mjs: new URL(ORT_ASSETS.mjs, baseUrl).href,
      wasm: new URL(ORT_ASSETS.wasm, baseUrl).href,
    };

    progress({
      progress: 0.75,
      status: "Loading recognition model",
      metadataReady: true,
      modelReady: false,
    });
    const sessionStartedAt = now();
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
    });
    validateSession(session, metadata);
    const sessionCreateMs = now() - sessionStartedAt;
    this.session = session;
    this.metadata = metadata;
    this.preprocessingVersion = request.preprocessingVersion;

    return {
      ortVersion: ORT_VERSION,
      metadataUrl,
      modelUrl,
      metadataReady: true,
      modelReady: true,
      metadataFetchMs,
      modelFetchMs,
      modelVerifyMs,
      sessionCreateMs,
      initializationMs: now() - startedAt,
    };
  }

  async recognize(request: RecognizeWorkerRequest): Promise<Recognition> {
    const session = this.session;
    const metadata = this.metadata;
    if (!session || !metadata || !this.preprocessingVersion) {
      throw new Error("recognition worker is not initialized");
    }
    if (request.preprocessingVersion !== this.preprocessingVersion) {
      throw new Error(
        "recognition input preprocessing version does not match model",
      );
    }
    const workerStartedAt = now();
    const input = validateInput(request);
    const tensor = new ort.Tensor("float32", input, [...MODEL_INPUT_SHAPE]);
    const inferenceStartedAt = now();
    const outputs = await session.run({ [metadata.input.name]: tensor });
    const inferenceMs = now() - inferenceStartedAt;
    const output = outputs[metadata.output.name];
    if (
      output?.type !== "float32" ||
      !arraysEqual(output.dims, MODEL_OUTPUT_SHAPE) ||
      !(output.data instanceof Float32Array)
    ) {
      throw new Error("model output does not match float32 [1,63,11]");
    }

    const decodeStartedAt = now();
    const alternatives = prefixBeamSearch(
      output.data,
      DEFAULT_BEAM_WIDTH,
      MODEL_OUTPUT_SHAPE[2],
      CTC_BLANK_INDEX,
    );
    const greedyText = greedyCtcDecode(output.data);
    const decodeMs = now() - decodeStartedAt;
    const topScore = alternatives[0]?.score ?? Number.NEGATIVE_INFINITY;
    const secondScore = alternatives[1]?.score ?? Number.NEGATIVE_INFINITY;
    const margin = topScore - secondScore;
    const confidence = marginConfidence(margin);

    return {
      requestId: request.requestId,
      revision: request.revision,
      text: alternatives[0]?.text ?? "",
      confidence,
      alternatives,
      inferenceMs,
      diagnostics: {
        greedyText,
        topScore,
        secondScore,
        margin,
        rawThreshold: metadata.confidence.raw_threshold,
        confidenceThreshold: metadata.confidence.confidence_threshold,
        thresholdPassed: confidence >= metadata.confidence.confidence_threshold,
        outputShape: MODEL_OUTPUT_SHAPE,
        timing: {
          rasterizationMs: null,
          inferenceMs,
          decodeMs,
          workerMs: now() - workerStartedAt,
          workerRoundTripMs: null,
        },
      },
    };
  }
}

function structuredError(
  error: unknown,
  stage: RecognitionError["stage"],
): RecognitionError {
  return {
    code:
      stage === "initialization" ? "initialization_failed" : "inference_failed",
    message: error instanceof Error ? error.message : String(error),
    stage,
    recoverable: true,
  };
}

export function createRecognitionWorkerHandler(
  postMessage: (message: RecognitionWorkerResponse) => void,
  backend: RecognitionWorkerBackend = new OrtRecognitionBackend(),
): (request: RecognitionWorkerRequest) => void {
  let ready = false;
  let initializationStarted = false;
  let inferenceQueue = Promise.resolve();

  return (request) => {
    if (request.type === "initialize") {
      if (initializationStarted) {
        postMessage({
          type: "error",
          error: structuredError(
            new Error("recognition worker initialization was requested twice"),
            "initialization",
          ),
        });
        return;
      }
      initializationStarted = true;
      void backend
        .initialize(request, (status) => {
          postMessage({ type: "status", ...status });
        })
        .then((diagnostics) => {
          ready = true;
          postMessage({ type: "ready", diagnostics });
        })
        .catch((error: unknown) => {
          postMessage({
            type: "error",
            error: structuredError(error, "initialization"),
          });
        });
      return;
    }

    if (!ready) {
      postMessage({
        type: "error",
        requestId: request.requestId,
        revision: request.revision,
        error: {
          code: "not_ready",
          message: "recognition worker is not ready",
          stage: "protocol",
          recoverable: true,
        },
      });
      return;
    }

    inferenceQueue = inferenceQueue.then(async () => {
      try {
        const recognition = await backend.recognize(request);
        postMessage({
          type: "result",
          requestId: request.requestId,
          revision: request.revision,
          recognition,
        });
      } catch (error) {
        postMessage({
          type: "error",
          requestId: request.requestId,
          revision: request.revision,
          error: structuredError(error, "inference"),
        });
      }
    });
  };
}

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<RecognitionWorkerRequest>) => void,
  ): void;
  postMessage(message: RecognitionWorkerResponse): void;
}

const workerScope = globalThis as unknown as Partial<WorkerScope>;
if (
  typeof document === "undefined" &&
  typeof workerScope.addEventListener === "function" &&
  typeof workerScope.postMessage === "function"
) {
  const handleMessage = createRecognitionWorkerHandler((message) => {
    workerScope.postMessage?.(message);
  });
  workerScope.addEventListener("message", (event) => {
    handleMessage(event.data);
  });
}

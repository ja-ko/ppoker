/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { describe, expect, it, vi } from "vitest";

import metadataFixture from "../../../public/models/digits-crnn.json";
import { PREPROCESSING_CONFIG } from "../../../src/voting/handwriting/ink/rasterize";
import type {
  InitializationDiagnostics,
  Recognition,
  RecognitionWorkerResponse,
} from "../../../src/voting/handwriting/recognition/types";
import {
  createRecognitionWorkerHandler,
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
    rawThreshold: 6.9,
    confidenceThreshold: 0.99,
    thresholdPassed: false,
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

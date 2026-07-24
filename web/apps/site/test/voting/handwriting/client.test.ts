/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PREPROCESSING_CONFIG } from "../../../src/voting/handwriting/ink/rasterize";
import { RecognitionClient } from "../../../src/voting/handwriting/recognition/client";
import type {
  InitializationDiagnostics,
  Recognition,
  RecognitionInput,
  RecognitionWorkerRequest,
  RecognitionWorkerResponse,
} from "../../../src/voting/handwriting/recognition/types";

class MockWorker {
  onmessage: ((event: MessageEvent<RecognitionWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: {
    message: RecognitionWorkerRequest;
    transfer: Transferable[];
  }[] = [];
  terminated = false;

  postMessage(
    message: RecognitionWorkerRequest,
    transfer: Transferable[],
  ): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: RecognitionWorkerResponse): void {
    this.onmessage?.({
      data: message,
    } as MessageEvent<RecognitionWorkerResponse>);
  }

  crash(message = "worker crashed"): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

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

function input(): RecognitionInput {
  return {
    data: new Float32Array(128 * 32),
    shape: [1, 1, 32, 128],
    preprocessingVersion: PREPROCESSING_CONFIG.version,
    rasterizationMs: 0.75,
  };
}

function recognition(text = "13", requestId = 1, revision = 0): Recognition {
  return {
    requestId,
    revision,
    text,
    confidence: 0.9,
    alternatives: [{ text, score: -1 }],
    inferenceMs: 1,
    diagnostics: {
      greedyText: text,
      topScore: -1,
      secondScore: -3,
      margin: 2,
      rawThreshold: 2,
      confidenceThreshold: 0.8,
      thresholdPassed: true,
      outputShape: [1, 63, 11],
      timing: {
        rasterizationMs: null,
        inferenceMs: 1,
        decodeMs: 1,
        workerMs: 2,
        workerRoundTripMs: null,
      },
    },
  };
}

function ready(worker: MockWorker): void {
  worker.emit({ type: "ready", diagnostics: initialization });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RecognitionClient", () => {
  it("tracks initialization and resolves correlated transferable requests", async () => {
    const worker = new MockWorker();
    let clock = 10;
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/app/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      now: () => clock,
    });
    expect(client.status.readiness).toBe("loading");
    expect(worker.sent[0]!.message).toEqual({
      type: "initialize",
      assetBaseUrl: "https://example.test/app/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    worker.emit({
      type: "status",
      progress: 0.5,
      status: "Loading model",
      metadataReady: true,
      modelReady: false,
    });
    expect(client.status).toMatchObject({
      readiness: "loading",
      progress: 0.5,
      metadataReady: true,
    });
    ready(worker);
    client.invalidate(8);

    const raster = input();
    const promise = client.recognize(raster, 8);
    const sent = worker.sent[1]!;
    expect(sent.message).toMatchObject({
      type: "recognize",
      requestId: 1,
      revision: 8,
    });
    expect(sent.transfer).toEqual([raster.data.buffer]);
    clock = 16;
    worker.emit({
      type: "result",
      requestId: 1,
      revision: 8,
      recognition: recognition("13", 1, 8),
    });
    await expect(promise).resolves.toMatchObject({
      requestId: 1,
      revision: 8,
      text: "13",
      diagnostics: {
        timing: { rasterizationMs: 0.75, workerRoundTripMs: 6 },
      },
    });
    client.dispose();
  });

  it("fails safely before readiness", async () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    client.invalidate(1);
    await expect(client.recognize(input(), 1)).rejects.toMatchObject({
      detail: { code: "not_ready" },
    });
    expect(worker.sent).toHaveLength(1);
    client.dispose();
  });

  it("fails stalled initialization with a recoverable bounded timeout", async () => {
    vi.useFakeTimers();
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      initializationTimeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(client.status.readiness).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);

    expect(worker.terminated).toBe(true);
    expect(client.status).toMatchObject({
      readiness: "failed",
      error: {
        code: "initialization_timeout",
        stage: "initialization",
        recoverable: true,
      },
    });
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it("cleans the initialization watchdog on retry, readiness, and disposal", async () => {
    vi.useFakeTimers();
    const firstWorker = new MockWorker();
    const readyWorker = new MockWorker();
    const disposedWorker = new MockWorker();
    const workers = [firstWorker, readyWorker, disposedWorker];
    const client = new RecognitionClient({
      workerFactory: () => workers.shift()!,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      initializationTimeoutMs: 50,
    });

    expect(vi.getTimerCount()).toBe(1);
    client.retry();
    expect(firstWorker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    ready(readyWorker);
    expect(client.status.readiness).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);

    client.retry();
    expect(readyWorker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    client.dispose();
    expect(disposedWorker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.status.error?.code).toBe("disposed");
  });

  it("rejects unbounded initialization timeout configuration", () => {
    expect(
      () =>
        new RecognitionClient({
          workerFactory: () => new MockWorker(),
          assetBaseUrl: "https://example.test/",
          preprocessingVersion: PREPROCESSING_CONFIG.version,
          initializationTimeoutMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(RangeError);
  });

  it("replaces a poisoned worker after timeout and recovers automatically", async () => {
    vi.useFakeTimers();
    const hungWorker = new MockWorker();
    const recoveredWorker = new MockWorker();
    const workers = [hungWorker, recoveredWorker];
    const client = new RecognitionClient({
      workerFactory: () => workers.shift()!,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
      timeoutMs: 50,
    });
    const readiness: string[] = [];
    client.subscribe((status) => readiness.push(status.readiness));
    ready(hungWorker);
    client.invalidate(1);
    const staleHandler = hungWorker.onmessage;
    const promise = client.recognize(input(), 1);
    const expectation = expect(promise).rejects.toMatchObject({
      detail: { code: "inference_timeout" },
    });
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
    expect(hungWorker.terminated).toBe(true);
    expect(recoveredWorker.sent[0]!.message.type).toBe("initialize");
    expect(client.status).toMatchObject({
      readiness: "loading",
      status: "Recovering recognizer after inference timeout",
    });

    staleHandler?.({
      data: {
        type: "result",
        requestId: 1,
        revision: 1,
        recognition: recognition("1", 1, 1),
      },
    } as MessageEvent<RecognitionWorkerResponse>);
    expect(client.status.readiness).toBe("loading");

    ready(recoveredWorker);
    const recovered = client.recognize(input(), 1);
    recoveredWorker.emit({
      type: "result",
      requestId: 2,
      revision: 1,
      recognition: recognition("13", 2, 1),
    });
    await expect(recovered).resolves.toMatchObject({
      requestId: 2,
      revision: 1,
      text: "13",
    });
    expect(readiness).toEqual(["loading", "ready", "loading", "ready"]);
    client.dispose();
  });

  it("invalidates pointerdown-style revisions and ignores their late replies", async () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    ready(worker);
    expect(client.invalidate(1)).toBe(1);
    const first = client.recognize(input(), 1);
    const firstExpectation = expect(first).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    expect(client.invalidate()).toBe(2);
    expect(client.revision).toBe(2);
    await firstExpectation;

    const second = client.recognize(input(), 2);
    worker.emit({
      type: "result",
      requestId: 1,
      revision: 1,
      recognition: recognition("1", 1, 1),
    });
    worker.emit({
      type: "result",
      requestId: 2,
      revision: 2,
      recognition: recognition("2", 2, 2),
    });
    await expect(second).resolves.toMatchObject({
      requestId: 2,
      revision: 2,
      text: "2",
    });

    expect(client.invalidate(4)).toBe(4);
    const fourthRevision = client.recognize(input(), 4);
    const fourthExpectation = expect(fourthRevision).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    expect(client.invalidate(7)).toBe(7);
    await fourthExpectation;
    worker.emit({
      type: "result",
      requestId: 3,
      revision: 4,
      recognition: recognition("4", 3, 4),
    });
    await expect(client.recognize(input(), 4)).rejects.toMatchObject({
      detail: { code: "stale_revision" },
    });
    client.dispose();
  });

  it("rejects superseded and revision-mismatched responses as stale", async () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    ready(worker);
    client.invalidate(1);
    const first = client.recognize(input(), 1);
    const firstExpectation = expect(first).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    const second = client.recognize(input(), 1);
    await firstExpectation;
    worker.emit({
      type: "result",
      requestId: 2,
      revision: 99,
      recognition: recognition("2", 2, 99),
    });
    await expect(second).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    client.dispose();
  });

  it("invalidates pending work across multiple drawing revisions", async () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    ready(worker);
    client.invalidate(1);
    const first = client.recognize(input(), 1);
    const firstExpectation = expect(first).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    client.invalidate(2);
    const second = client.recognize(input(), 2);
    const secondExpectation = expect(second).rejects.toMatchObject({
      detail: { code: "stale_response" },
    });
    client.invalidate(3);
    await Promise.all([firstExpectation, secondExpectation]);

    worker.emit({
      type: "result",
      requestId: 1,
      revision: 1,
      recognition: recognition("1", 1, 1),
    });
    worker.emit({
      type: "result",
      requestId: 2,
      revision: 2,
      recognition: recognition("2", 2, 2),
    });
    const current = client.recognize(input(), 3);
    worker.emit({
      type: "result",
      requestId: 3,
      revision: 3,
      recognition: recognition("3", 3, 3),
    });
    await expect(current).resolves.toMatchObject({
      requestId: 3,
      revision: 3,
      text: "3",
    });
    client.dispose();
  });

  it("moves worker failures to failed and retries with a fresh worker", () => {
    const failedWorker = new MockWorker();
    const retriedWorker = new MockWorker();
    const workers = [failedWorker, retriedWorker];
    const client = new RecognitionClient({
      workerFactory: () => workers.shift()!,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    failedWorker.crash("WASM crashed");
    expect(client.status).toMatchObject({
      readiness: "failed",
      error: { code: "worker_failed" },
    });
    expect(failedWorker.terminated).toBe(true);

    client.retry();
    expect(client.status.readiness).toBe("loading");
    expect(retriedWorker.sent[0]!.message.type).toBe("initialize");
    ready(retriedWorker);
    expect(client.status.readiness).toBe("ready");
    client.dispose();
  });

  it("surfaces worker construction failures and permits retry", () => {
    const worker = new MockWorker();
    let attempts = 0;
    const client = new RecognitionClient({
      workerFactory: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("workers unavailable");
        return worker;
      },
      assetBaseUrl: "https://example.test/app",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    expect(client.status).toMatchObject({
      readiness: "failed",
      error: { code: "worker_start_failed" },
    });
    client.retry();
    expect(worker.sent[0]!.message).toMatchObject({
      type: "initialize",
      assetBaseUrl: "https://example.test/app/",
    });
    client.dispose();
  });

  it("isolates throwing status subscribers from lifecycle and disposal", () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    let calls = 0;
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = client.subscribe(() => {
        calls += 1;
        throw new Error("diagnostics failed");
      });
    }).not.toThrow();
    expect(unsubscribe).toBeTypeOf("function");
    expect(() => {
      ready(worker);
    }).not.toThrow();
    expect(calls).toBe(2);
    expect(() => {
      client.dispose();
    }).not.toThrow();
    expect(calls).toBe(3);
    expect(worker.terminated).toBe(true);
    expect(client.status).toMatchObject({
      readiness: "failed",
      error: { code: "disposed" },
    });
    expect(() => unsubscribe?.()).not.toThrow();
  });

  it("explicitly disposes the worker and rejects further requests", async () => {
    const worker = new MockWorker();
    const client = new RecognitionClient({
      workerFactory: () => worker,
      assetBaseUrl: "https://example.test/",
      preprocessingVersion: PREPROCESSING_CONFIG.version,
    });
    ready(worker);
    client.invalidate(1);
    const pending = client.recognize(input(), 1);
    client.dispose();
    await expect(pending).rejects.toMatchObject({
      detail: { code: "disposed" },
    });
    expect(worker.terminated).toBe(true);
    expect(client.status).toMatchObject({
      readiness: "failed",
      error: { code: "disposed", recoverable: false },
    });
    await expect(client.recognize(input(), 1)).rejects.toMatchObject({
      detail: { code: "disposed" },
    });
  });
});

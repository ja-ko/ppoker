import type {
  Recognition,
  RecognitionError,
  RecognitionInput,
  RecognitionWorkerRequest,
  RecognitionWorkerResponse,
  RecognizerStatus,
  WorkerErrorMessage,
  WorkerResultMessage,
} from "./types";

interface WorkerPort {
  onmessage: ((event: MessageEvent<RecognitionWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(
    message: RecognitionWorkerRequest,
    transfer: Transferable[],
  ): void;
  terminate(): void;
}

interface PendingRequest {
  revision: number;
  startedAt: number;
  rasterizationMs: number | null;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (recognition: Recognition) => void;
  reject: (error: RecognitionRuntimeError) => void;
}

export interface RecognitionClientOptions {
  workerFactory?: () => WorkerPort;
  assetBaseUrl?: string;
  preprocessingVersion: string;
  initializationTimeoutMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 20_000;
const MAX_INITIALIZATION_TIMEOUT_MS = 120_000;

export class RecognitionRuntimeError extends Error {
  constructor(public readonly detail: RecognitionError) {
    super(detail.message);
    this.name = "RecognitionRuntimeError";
  }
}

function runtimeError(
  code: string,
  message: string,
  stage: RecognitionError["stage"],
  recoverable = true,
): RecognitionRuntimeError {
  return new RecognitionRuntimeError({ code, message, stage, recoverable });
}

function defaultAssetBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, globalThis.location.href).href;
}

function defaultWorkerFactory(): WorkerPort {
  return new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
}

export class RecognitionClient {
  private readonly workerFactory: () => WorkerPort;
  private readonly assetBaseUrl: string;
  private readonly preprocessingVersion: string;
  private readonly initializationTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<(status: RecognizerStatus) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private worker: WorkerPort | null = null;
  private nextRequestId = 1;
  private latestRequestId: number | null = null;
  private initializationWatchdog: ReturnType<typeof setTimeout> | null = null;
  private currentRevision = 0;
  private disposed = false;
  private currentStatus: RecognizerStatus = {
    readiness: "loading",
    progress: 0,
    status: "Starting recognition worker",
    metadataReady: false,
    modelReady: false,
  };

  constructor(options: RecognitionClientOptions) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    const assetBaseUrl = new URL(options.assetBaseUrl ?? defaultAssetBaseUrl());
    if (!assetBaseUrl.pathname.endsWith("/")) assetBaseUrl.pathname += "/";
    this.assetBaseUrl = assetBaseUrl.href;
    this.preprocessingVersion = options.preprocessingVersion;
    this.initializationTimeoutMs =
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    if (
      !Number.isFinite(this.initializationTimeoutMs) ||
      this.initializationTimeoutMs <= 0 ||
      this.initializationTimeoutMs > MAX_INITIALIZATION_TIMEOUT_MS
    ) {
      throw new RangeError(
        `initializationTimeoutMs must be within 1..${String(MAX_INITIALIZATION_TIMEOUT_MS)}`,
      );
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => performance.now());
    this.startWorker();
  }

  get status(): RecognizerStatus {
    return this.currentStatus;
  }

  get revision(): number {
    return this.currentRevision;
  }

  subscribe(listener: (status: RecognizerStatus) => void): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener, this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  invalidate(revision = this.currentRevision + 1): number {
    if (this.disposed) {
      throw runtimeError(
        "disposed",
        "recognition client is disposed",
        "protocol",
        false,
      );
    }
    if (!Number.isSafeInteger(revision) || revision <= this.currentRevision) {
      throw new RangeError("drawing revision must advance monotonically");
    }
    this.currentRevision = revision;
    for (const [requestId, pending] of this.pending) {
      if (pending.revision >= revision) continue;
      clearTimeout(pending.timeout);
      pending.reject(
        runtimeError(
          "stale_response",
          "recognition request belongs to an invalidated drawing revision",
          "protocol",
        ),
      );
      this.pending.delete(requestId);
      if (this.latestRequestId === requestId) this.latestRequestId = null;
    }
    return revision;
  }

  retry(): void {
    if (this.disposed) {
      throw runtimeError(
        "disposed",
        "recognition client is disposed",
        "protocol",
        false,
      );
    }
    this.stopWorker(
      runtimeError(
        "worker_restarted",
        "recognition worker was restarted",
        "worker",
      ),
    );
    this.startWorker();
  }

  recognize(input: RecognitionInput, revision: number): Promise<Recognition> {
    if (this.disposed) {
      return Promise.reject(
        runtimeError(
          "disposed",
          "recognition client is disposed",
          "protocol",
          false,
        ),
      );
    }
    if (this.currentStatus.readiness !== "ready" || !this.worker) {
      return Promise.reject(
        runtimeError("not_ready", "recognizer is not ready", "protocol"),
      );
    }
    if (revision !== this.currentRevision) {
      return Promise.reject(
        runtimeError(
          "stale_revision",
          `recognition revision ${String(revision)} is not current revision ${String(this.currentRevision)}`,
          "protocol",
          false,
        ),
      );
    }
    const buffer = input.data.buffer;
    if (
      !(buffer instanceof ArrayBuffer) ||
      input.data.byteOffset !== 0 ||
      input.data.byteLength !== buffer.byteLength
    ) {
      return Promise.reject(
        runtimeError(
          "invalid_transfer",
          "recognition data must own a transferable ArrayBuffer",
          "protocol",
          false,
        ),
      );
    }

    if (this.latestRequestId !== null) {
      const previous = this.pending.get(this.latestRequestId);
      if (previous) {
        clearTimeout(previous.timeout);
        previous.reject(
          runtimeError(
            "stale_response",
            "recognition request was superseded",
            "protocol",
          ),
        );
        this.pending.delete(this.latestRequestId);
      }
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.latestRequestId = requestId;
    const startedAt = this.now();
    return new Promise<Recognition>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleTimeout(requestId);
      }, this.timeoutMs);
      this.pending.set(requestId, {
        revision,
        startedAt,
        rasterizationMs: input.rasterizationMs ?? null,
        timeout,
        resolve,
        reject,
      });

      const request: RecognitionWorkerRequest = {
        type: "recognize",
        requestId,
        revision,
        input: buffer,
        shape: input.shape,
        preprocessingVersion: input.preprocessingVersion,
      };
      try {
        this.worker?.postMessage(request, [buffer]);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        this.latestRequestId = null;
        reject(
          runtimeError(
            "request_failed",
            error instanceof Error ? error.message : String(error),
            "protocol",
          ),
        );
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWorker(
      runtimeError(
        "disposed",
        "recognition client was disposed",
        "protocol",
        false,
      ),
    );
    this.setStatus({
      readiness: "failed",
      progress: 0,
      status: "Recognition client disposed",
      metadataReady: false,
      modelReady: false,
      error: {
        code: "disposed",
        message: "recognition client was disposed",
        stage: "protocol",
        recoverable: false,
      },
    });
    this.listeners.clear();
  }

  private startWorker(status = "Starting recognition worker"): void {
    let worker: WorkerPort;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.setStatus({
        readiness: "failed",
        progress: 0,
        status: error instanceof Error ? error.message : String(error),
        metadataReady: false,
        modelReady: false,
        error: {
          code: "worker_start_failed",
          message: error instanceof Error ? error.message : String(error),
          stage: "worker",
          recoverable: true,
        },
      });
      return;
    }
    this.worker = worker;
    this.setStatus({
      readiness: "loading",
      progress: 0,
      status,
      metadataReady: false,
      modelReady: false,
    });
    worker.onmessage = (event) => {
      if (worker !== this.worker) return;
      this.handleMessage(event.data);
    };
    worker.onerror = (event) => {
      if (worker !== this.worker) return;
      this.failWorker(event.message || "recognition worker crashed");
    };
    worker.onmessageerror = () => {
      if (worker !== this.worker) return;
      this.failWorker("recognition worker sent an unreadable message");
    };
    this.initializationWatchdog = setTimeout(() => {
      this.handleInitializationTimeout(worker);
    }, this.initializationTimeoutMs);
    try {
      worker.postMessage(
        {
          type: "initialize",
          assetBaseUrl: this.assetBaseUrl,
          preprocessingVersion: this.preprocessingVersion,
        },
        [],
      );
    } catch (error) {
      this.failWorker(error instanceof Error ? error.message : String(error));
    }
  }

  private handleMessage(message: RecognitionWorkerResponse): void {
    if (message.type === "status") {
      this.setStatus({
        readiness: "loading",
        progress: message.progress,
        status: message.status,
        metadataReady: message.metadataReady,
        modelReady: message.modelReady,
      });
      return;
    }
    if (message.type === "ready") {
      this.clearInitializationWatchdog();
      this.setStatus({
        readiness: "ready",
        progress: 1,
        status: "Recognizer ready",
        metadataReady: true,
        modelReady: true,
        initialization: message.diagnostics,
      });
      return;
    }
    if (message.type === "error") {
      this.handleError(message);
      return;
    }
    this.handleResult(message);
  }

  private handleResult(message: WorkerResultMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (
      this.latestRequestId !== message.requestId ||
      pending.revision !== message.revision ||
      message.recognition.requestId !== message.requestId ||
      message.recognition.revision !== message.revision ||
      message.revision !== this.currentRevision
    ) {
      if (this.latestRequestId === message.requestId)
        this.latestRequestId = null;
      pending.reject(
        runtimeError(
          "stale_response",
          "stale recognition response",
          "protocol",
        ),
      );
      return;
    }
    this.latestRequestId = null;
    pending.resolve({
      ...message.recognition,
      diagnostics: {
        ...message.recognition.diagnostics,
        timing: {
          ...message.recognition.diagnostics.timing,
          rasterizationMs: pending.rasterizationMs,
          workerRoundTripMs: this.now() - pending.startedAt,
        },
      },
    });
  }

  private handleError(message: WorkerErrorMessage): void {
    if (message.requestId !== undefined) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      if (this.latestRequestId === message.requestId)
        this.latestRequestId = null;
      pending.reject(new RecognitionRuntimeError(message.error));
      return;
    }
    this.failWorker(message.error.message, message.error);
  }

  private failWorker(message: string, detail?: RecognitionError): void {
    const error = detail ?? {
      code: "worker_failed",
      message,
      stage: "worker" as const,
      recoverable: true,
    };
    this.stopWorker(new RecognitionRuntimeError(error));
    this.setStatus({
      readiness: "failed",
      progress: 0,
      status: message,
      metadataReady: false,
      modelReady: false,
      error,
    });
  }

  private handleTimeout(requestId: number): void {
    if (!this.pending.has(requestId) || this.disposed) return;
    this.stopWorker(
      runtimeError(
        "inference_timeout",
        `recognition timed out after ${String(this.timeoutMs)} ms; worker restarted`,
        "inference",
      ),
    );
    this.startWorker("Recovering recognizer after inference timeout");
  }

  private handleInitializationTimeout(worker: WorkerPort): void {
    if (
      this.disposed ||
      worker !== this.worker ||
      this.currentStatus.readiness !== "loading"
    ) {
      return;
    }
    const message = `recognizer initialization timed out after ${String(this.initializationTimeoutMs)} ms`;
    this.failWorker(message, {
      code: "initialization_timeout",
      message,
      stage: "initialization",
      recoverable: true,
    });
  }

  private clearInitializationWatchdog(): void {
    if (this.initializationWatchdog !== null) {
      clearTimeout(this.initializationWatchdog);
      this.initializationWatchdog = null;
    }
  }

  private stopWorker(error: RecognitionRuntimeError): void {
    this.clearInitializationWatchdog();
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.latestRequestId = null;
  }

  private setStatus(status: RecognizerStatus): void {
    this.currentStatus = status;
    for (const listener of [...this.listeners]) {
      this.notifyListener(listener, status);
    }
  }

  private notifyListener(
    listener: (status: RecognizerStatus) => void,
    status: RecognizerStatus,
  ): void {
    try {
      listener(status);
    } catch {
      // Diagnostics consumers cannot be allowed to corrupt worker lifecycle.
    }
  }
}

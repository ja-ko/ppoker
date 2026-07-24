import type { InkPadHandle } from "./InkPad";
import type { RasterizedInk } from "./ink/rasterize";
import { canonicalValue, MODEL_INPUT_SHAPE } from "./recognition/types";
import type {
  Recognition,
  RecognitionInput,
  RecognizerStatus,
} from "./recognition/types";
import {
  classifyRecognition,
  type RejectionKind,
  type VoteInputEvent,
  type VoteInputState,
} from "./state";

export const BASE_QUIET_MS = 675;
export const PREFIX_COMMIT_MS = 1_000;
export const REJECTION_DEADLINE_MS = 1_100;
export const COMMIT_EFFECT_MS = 460;
export const REJECTION_EFFECT_MS = 420;
export const CLEAR_EFFECT_MS = 220;

export interface EffectDurations {
  commit: number;
  rejection: number;
  clear: number;
}

const REDUCED_EFFECT_DURATIONS: EffectDurations = {
  commit: 90,
  rejection: 110,
  clear: 90,
};

export function effectDurations(reducedMotion: boolean): EffectDurations {
  return reducedMotion
    ? REDUCED_EFFECT_DURATIONS
    : {
        commit: COMMIT_EFFECT_MS,
        rejection: REJECTION_EFFECT_MS,
        clear: CLEAR_EFFECT_MS,
      };
}

export type TimerReason =
  | "inference-wait"
  | "prefix-commit"
  | "incomplete"
  | "invalid"
  | "unclaimed"
  | "commit-effect"
  | "reject-effect"
  | "clear-effect";

export interface FlowDiagnostics {
  timerReason: TimerReason | null;
  timerDeadline: number | null;
  raster: Float32Array | null;
  rasterizationMs: number | null;
  recognition: Recognition | null;
  inferencePending: boolean;
  inferenceError: string | null;
  decision: RecognitionDecisionDiagnostics | null;
}

export interface RecognitionDecisionDiagnostics {
  outcome: "commit" | "reject";
  candidate: string | null;
  confidence: number | null;
  deckValid: boolean | null;
  rejection: RejectionKind | null;
}

export const initialFlowDiagnostics: FlowDiagnostics = {
  timerReason: null,
  timerDeadline: null,
  raster: null,
  rasterizationMs: null,
  recognition: null,
  inferencePending: false,
  inferenceError: null,
  decision: null,
};

function decisionDiagnostics(
  outcome: RecognitionDecisionDiagnostics["outcome"],
  recognition: Recognition | null,
  numericDeck: readonly number[],
  rejection: RejectionKind | null,
): RecognitionDecisionDiagnostics {
  const candidateValue = recognition ? canonicalValue(recognition.text) : null;
  const candidate = recognition?.text;
  return {
    outcome,
    candidate: candidate === "" ? null : (candidate ?? null),
    confidence: recognition?.confidence ?? null,
    deckValid:
      candidateValue === null ? null : numericDeck.includes(candidateValue),
    rejection,
  };
}

export interface RecognitionRuntime {
  readonly status: RecognizerStatus;
  readonly revision: number;
  subscribe(listener: (status: RecognizerStatus) => void): () => void;
  invalidate(revision?: number): number;
  retry(): void;
  recognize(input: RecognitionInput, revision: number): Promise<Recognition>;
  dispose(): void;
}

export interface RecognitionFlowOptions {
  getState: () => VoteInputState;
  dispatch: (event: VoteInputEvent) => void;
  getRecognizerStatus: () => RecognizerStatus;
  getNumericDeck: () => readonly number[];
  getInk: () => InkPadHandle | null;
  onDiagnostics: (patch: Partial<FlowDiagnostics>) => void;
  onCommit?: (value: number, revision: number) => void;
  onReject?: (rejection: RejectionKind, revision: number) => void;
  onFailure?: (
    error: unknown,
    revision: number,
    source: RecognitionFailureSource,
  ) => void;
  now?: () => number;
  commitEffectMs?: number;
  rejectionEffectMs?: number;
  clearEffectMs?: number;
  getReducedMotion?: () => boolean;
}

export type RecognitionFailureSource = "commit" | "inference" | "reject";

interface PendingRecognition {
  recognition: Recognition;
  revision: number;
  latestPointTime: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RecognitionFlow {
  private readonly options: RecognitionFlowOptions;
  private readonly now: () => number;
  private readonly commitEffectMs: number | undefined;
  private readonly rejectionEffectMs: number | undefined;
  private readonly clearEffectMs: number | undefined;
  private readonly getReducedMotion: () => boolean;
  private runtime: RecognitionRuntime | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private requestEpoch = 0;
  private resumeOnReady = false;
  private pendingRecognition: PendingRecognition | null = null;

  constructor(options: RecognitionFlowOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.commitEffectMs = options.commitEffectMs;
    this.rejectionEffectMs = options.rejectionEffectMs;
    this.clearEffectMs = options.clearEffectMs;
    this.getReducedMotion =
      options.getReducedMotion ??
      (() =>
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  setRuntime(runtime: RecognitionRuntime | null): void {
    this.runtime = runtime;
    if (!runtime) {
      this.cancelPending();
      this.resumeOnReady = false;
    }
  }

  pointerAccepted(): number {
    const state = this.options.getState();
    const revision = state.revision + 1;
    if (!this.runtime) {
      throw new Error("recognition runtime is not available");
    }

    // This must happen in the pointerdown call stack before React can render.
    this.options.getInk()?.restoreVectorInk();
    this.runtime.invalidate(revision);
    this.cancelPending();
    this.resumeOnReady = false;
    this.options.onDiagnostics({
      recognition: null,
      inferenceError: null,
      decision: null,
    });
    this.options.dispatch({ type: "POINTER_ACCEPTED", revision });
    return revision;
  }

  strokeCompleted(): void {
    const state = this.options.getState();
    const ink = this.options.getInk();
    const latestPointTime = ink?.getLatestPointTime() ?? null;
    if (
      state.status !== "drawing" ||
      !ink ||
      ink.isPointerActive() ||
      latestPointTime === null
    ) {
      return;
    }
    this.options.dispatch({
      type: "STROKE_COMPLETED",
      revision: state.revision,
    });
    this.scheduleInference(state.revision, latestPointTime);
  }

  strokeCancelled(): void {
    const state = this.options.getState();
    this.cancelPending();
    this.resumeOnReady = false;
    this.options.dispatch({
      type: "STROKE_CANCELLED",
      revision: state.revision,
    });
  }

  clear(): number {
    const revision = this.options.getState().revision + 1;
    const reducedMotion = this.getReducedMotion();
    this.runtime?.invalidate(revision);
    this.cancelPending();
    this.resumeOnReady = false;
    this.options.getInk()?.clear();
    this.options.onDiagnostics({
      raster: null,
      rasterizationMs: null,
      recognition: null,
      inferenceError: null,
      decision: null,
    });
    this.options.dispatch({
      type: "CLEAR",
      revision,
      effectMotion: reducedMotion ? "reduced" : "full",
    });
    const duration = this.clearEffectMs ?? effectDurations(reducedMotion).clear;
    this.scheduleAfter("clear-effect", duration, () => {
      this.options.dispatch({ type: "EFFECT_COMPLETED", revision });
    });
    return revision;
  }

  retry(): void {
    const runtime = this.runtime;
    if (!runtime) {
      return;
    }
    this.cancelPending();
    const ink = this.options.getInk();
    this.resumeOnReady =
      Boolean(ink && ink.getStats().strokeCount > 0) &&
      !(ink?.isPointerActive() ?? false);
    this.options.onDiagnostics({ inferenceError: null });
    runtime.retry();
  }

  recognitionConfigurationChanged(): void {
    if (this.pendingRecognition) {
      this.revalidateRecognition(this.pendingRecognition);
    }
  }

  recognizerStatusChanged(status: RecognizerStatus): void {
    const state = this.options.getState();
    if (status.readiness !== "ready" && state.status === "settling") {
      const ink = this.options.getInk();
      this.resumeOnReady = Boolean(
        ink && ink.getStats().strokeCount > 0 && !ink.isPointerActive(),
      );
      this.cancelPending();
      this.options.dispatch({
        type: "RECOGNIZER_UNAVAILABLE",
        revision: state.revision,
      });
      return;
    }

    if (status.readiness !== "ready" || !this.resumeOnReady) {
      return;
    }
    this.resumeOnReady = false;
    const current = this.options.getState();
    const ink = this.options.getInk();
    const latestPointTime = ink?.getLatestPointTime() ?? null;
    if (
      current.status !== "drawing" ||
      !ink ||
      ink.isPointerActive() ||
      latestPointTime === null ||
      ink.getStats().strokeCount === 0
    ) {
      return;
    }
    this.options.dispatch({
      type: "RETRY_SETTLING",
      revision: current.revision,
    });
    this.scheduleInference(current.revision, latestPointTime);
  }

  dispose(): void {
    this.cancelPending();
    this.runtime = null;
    this.resumeOnReady = false;
  }

  private scheduleInference(revision: number, latestPointTime: number): void {
    this.scheduleAt("inference-wait", latestPointTime + BASE_QUIET_MS, () => {
      this.runInference(revision, latestPointTime);
    });
  }

  private runInference(revision: number, latestPointTime: number): void {
    const state = this.options.getState();
    const ink = this.options.getInk();
    const runtime = this.runtime;
    if (
      state.revision !== revision ||
      state.status !== "settling" ||
      !ink ||
      ink.isPointerActive() ||
      !runtime ||
      this.options.getRecognizerStatus().readiness !== "ready"
    ) {
      return;
    }

    const rasterStartedAt = this.now();
    let raster: RasterizedInk | null;
    try {
      raster = ink.rasterize();
    } catch (error) {
      this.options.onDiagnostics({
        raster: null,
        rasterizationMs: this.now() - rasterStartedAt,
      });
      this.failInference(revision, error);
      return;
    }
    const rasterizationMs = this.now() - rasterStartedAt;
    this.options.onDiagnostics({
      raster: raster ? new Float32Array(raster.data) : null,
      rasterizationMs,
      inferenceError: null,
    });
    if (!raster) {
      this.scheduleRejection(
        revision,
        latestPointTime,
        "unclaimed",
        "unclaimed",
      );
      return;
    }

    const epoch = ++this.requestEpoch;
    this.options.onDiagnostics({ inferencePending: true });
    let request: Promise<Recognition>;
    try {
      request = runtime.recognize(
        {
          data: raster.data,
          shape: MODEL_INPUT_SHAPE,
          preprocessingVersion: raster.preprocessingVersion,
          rasterizationMs,
        },
        revision,
      );
    } catch (error) {
      this.failInference(revision, error);
      return;
    }
    void request
      .then((recognition) => {
        if (
          recognition.revision !== revision ||
          !this.isCurrentRequest(epoch, revision) ||
          ink.isPointerActive()
        ) {
          return;
        }
        this.options.onDiagnostics({ recognition, inferenceError: null });
        const pending = {
          recognition,
          revision,
          latestPointTime,
        };
        this.pendingRecognition = pending;
        this.revalidateRecognition(pending);
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRequest(epoch, revision)) {
          return;
        }
        this.failInference(revision, error);
      })
      .finally(() => {
        if (epoch === this.requestEpoch) {
          this.options.onDiagnostics({ inferencePending: false });
        }
      });
  }

  private revalidateRecognition(pending: PendingRecognition): void {
    if (
      this.pendingRecognition !== pending ||
      !this.isCurrentRevision(pending.revision) ||
      this.options.getInk()?.isPointerActive()
    ) {
      return;
    }
    const disposition = classifyRecognition(
      pending.recognition,
      this.options.getNumericDeck(),
    );
    const deadline =
      disposition.type === "commit"
        ? pending.latestPointTime +
          (disposition.delay === "base" ? BASE_QUIET_MS : PREFIX_COMMIT_MS)
        : pending.latestPointTime + REJECTION_DEADLINE_MS;
    const reason: TimerReason =
      disposition.type === "commit"
        ? disposition.delay === "base"
          ? "inference-wait"
          : "prefix-commit"
        : disposition.rejection;

    if (deadline > this.now()) {
      this.scheduleAt(reason, deadline, () => {
        this.revalidateRecognition(pending);
      });
      return;
    }
    if (disposition.type === "commit") {
      this.beginCommit(
        pending.revision,
        disposition.value,
        pending.recognition,
      );
    } else {
      this.beginRejection(
        pending.revision,
        disposition.rejection,
        pending.recognition,
      );
    }
  }

  private scheduleRejection(
    revision: number,
    latestPointTime: number,
    rejection: RejectionKind,
    reason: "incomplete" | "invalid" | "unclaimed",
  ): void {
    this.scheduleAt(reason, latestPointTime + REJECTION_DEADLINE_MS, () => {
      this.beginRejection(revision, rejection, null);
    });
  }

  private beginCommit(
    revision: number,
    value: number,
    recognition: Recognition,
  ): void {
    const state = this.options.getState();
    const ink = this.options.getInk();
    if (
      state.revision !== revision ||
      state.status !== "settling" ||
      ink?.isPointerActive()
    ) {
      return;
    }
    this.pendingRecognition = null;
    try {
      this.options.onCommit?.(value, revision);
    } catch (error: unknown) {
      this.failInference(revision, error, "commit");
      return;
    }
    const reducedMotion = this.getReducedMotion();
    this.options.onDiagnostics({
      decision: decisionDiagnostics(
        "commit",
        recognition,
        this.options.getNumericDeck(),
        null,
      ),
    });
    this.options.dispatch({
      type: "BEGIN_COMMIT",
      revision,
      value,
      effectMotion: reducedMotion ? "reduced" : "full",
    });
    const duration =
      this.commitEffectMs ?? effectDurations(reducedMotion).commit;
    this.scheduleAfter("commit-effect", duration, () => {
      const current = this.options.getState();
      if (current.revision !== revision || current.status !== "committing") {
        return;
      }
      this.options.getInk()?.clear();
      this.options.dispatch({ type: "EFFECT_COMPLETED", revision });
    });
  }

  private beginRejection(
    revision: number,
    rejection: RejectionKind,
    recognition: Recognition | null,
  ): void {
    const state = this.options.getState();
    const ink = this.options.getInk();
    if (
      state.revision !== revision ||
      state.status !== "settling" ||
      ink?.isPointerActive()
    ) {
      return;
    }
    this.pendingRecognition = null;
    try {
      this.options.onReject?.(rejection, revision);
    } catch (error: unknown) {
      this.failInference(revision, error, "reject");
      return;
    }
    const reducedMotion = this.getReducedMotion();
    this.options.onDiagnostics({
      decision: decisionDiagnostics(
        "reject",
        recognition,
        this.options.getNumericDeck(),
        rejection,
      ),
    });
    this.options.dispatch({
      type: "BEGIN_REJECTION",
      revision,
      rejection,
      effectMotion: reducedMotion ? "reduced" : "full",
    });
    const duration =
      this.rejectionEffectMs ?? effectDurations(reducedMotion).rejection;
    this.scheduleAfter("reject-effect", duration, () => {
      const current = this.options.getState();
      if (current.revision !== revision || current.status !== "rejecting") {
        return;
      }
      this.options.getInk()?.clear();
      this.options.dispatch({ type: "EFFECT_COMPLETED", revision });
    });
  }

  private isCurrentRequest(epoch: number, revision: number): boolean {
    return epoch === this.requestEpoch && this.isCurrentRevision(revision);
  }

  private isCurrentRevision(revision: number): boolean {
    const state = this.options.getState();
    return state.revision === revision && state.status === "settling";
  }

  private failInference(
    revision: number,
    error: unknown,
    source: RecognitionFailureSource = "inference",
  ): void {
    if (!this.isCurrentRevision(revision)) {
      return;
    }
    const message = errorMessage(error);
    this.cancelPending();
    this.options.onDiagnostics({ inferenceError: message });
    this.options.dispatch({
      type: "INFERENCE_FAILED",
      revision,
      message,
    });
    try {
      this.options.onFailure?.(error, revision, source);
    } catch {
      // Failure observers cannot change recognition state recovery semantics.
    }
  }

  private scheduleAfter(
    reason: TimerReason,
    delay: number,
    action: () => void,
  ): void {
    this.scheduleAt(reason, this.now() + Math.max(0, delay), action);
  }

  private scheduleAt(
    reason: TimerReason,
    deadline: number,
    action: () => void,
  ): void {
    this.clearTimer();
    const delay = deadline - this.now();
    if (delay <= 0) {
      this.options.onDiagnostics({
        timerReason: null,
        timerDeadline: null,
      });
      action();
      return;
    }
    this.options.onDiagnostics({
      timerReason: reason,
      timerDeadline: deadline,
    });
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.options.onDiagnostics({
        timerReason: null,
        timerDeadline: null,
      });
      action();
    }, delay);
  }

  private cancelPending(): void {
    this.requestEpoch += 1;
    this.pendingRecognition = null;
    this.clearTimer();
    this.options.onDiagnostics({
      timerReason: null,
      timerDeadline: null,
      inferencePending: false,
    });
  }

  private clearTimer(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

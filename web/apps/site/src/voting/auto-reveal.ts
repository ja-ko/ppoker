import type { ClientSnapshot, GamePhase } from "@ppoker/web-client";

import {
  isLocalSoleMissingVoter,
  isRevealEligible,
  votingCoverage,
} from "./participant-policy";

export const AUTO_REVEAL_DELAY_MS = 3_000;

declare const commandIntentBrand: unique symbol;
declare const drawingIntentBrand: unique symbol;

export interface CommandIntent {
  readonly [commandIntentBrand]: true;
}

export interface DrawingIntent {
  readonly [drawingIntentBrand]: true;
}

export type AutoRevealState =
  | { readonly deadline: null; readonly status: "idle" }
  | { readonly deadline: number; readonly status: "counting" };

export interface MonotonicScheduler {
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
}

export interface AutoRevealControllerOptions {
  readonly getSnapshot: () => ClientSnapshot;
  readonly onRevealError?: (error: unknown) => void;
  readonly scheduler?: MonotonicScheduler;
  readonly sendReveal: () => void;
}

export type RevealRequestResult =
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "ignored" }
  | { readonly status: "sent" };

interface RoundContext {
  readonly deck: readonly string[];
  readonly phase: GamePhase;
  readonly roomName: string;
  readonly roundNumber: number;
  readonly status: ClientSnapshot["status"];
}

interface Countdown {
  readonly context: RoundContext;
  readonly deadline: number;
  readonly generation: number;
  readonly validationRevision: number;
}

interface Drawing {
  readonly context: RoundContext;
  readonly interrupted: boolean;
  readonly intent: DrawingIntent;
  restartFrom: Countdown | undefined;
}

const IDLE_STATE = { deadline: null, status: "idle" } as const;

export function createCommandIntent(): CommandIntent {
  return Object.freeze({}) as CommandIntent;
}

export function createDrawingIntent(): DrawingIntent {
  return Object.freeze({}) as DrawingIntent;
}

export class AutoRevealController {
  readonly #getSnapshot: () => ClientSnapshot;
  readonly #listeners = new Set<() => void>();
  readonly #onRevealError: ((error: unknown) => void) | undefined;
  readonly #processedIntents = new WeakSet<object>();
  readonly #scheduler: MonotonicScheduler;
  readonly #sendReveal: () => void;

  #countdown: Countdown | undefined;
  #disposed = false;
  #drawing: Drawing | undefined;
  #generation = 0;
  #revealedContext: RoundContext | undefined;
  #state: AutoRevealState = IDLE_STATE;
  #timer: unknown;

  constructor(options: AutoRevealControllerOptions) {
    this.#getSnapshot = options.getSnapshot;
    this.#onRevealError = options.onRevealError;
    this.#scheduler = options.scheduler ?? browserScheduler();
    this.#sendReveal = options.sendReveal;
  }

  readonly getState = (): AutoRevealState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  observe(snapshot: ClientSnapshot): void {
    if (this.#disposed) {
      return;
    }

    const observedContext = roundContext(snapshot);
    if (
      this.#revealedContext !== undefined &&
      observedContext !== null &&
      !sameRound(this.#revealedContext, observedContext)
    ) {
      this.#revealedContext = undefined;
    }

    if (
      this.#countdown !== undefined &&
      !canContinueCountdown(snapshot, this.#countdown)
    ) {
      this.#cancelCountdown();
    }
    if (
      this.#drawing?.restartFrom !== undefined &&
      !canContinueCountdown(snapshot, this.#drawing.restartFrom)
    ) {
      this.#drawing.restartFrom = undefined;
    }
    if (
      this.#drawing !== undefined &&
      !canContinueDrawing(snapshot, this.#drawing)
    ) {
      this.#drawing = undefined;
    }
  }

  submitVote(intent: CommandIntent, submit: () => void): boolean {
    if (!this.#acceptIntent(intent)) {
      return false;
    }

    const before = this.#getSnapshot();
    const restartFrom = this.#countdown;
    const firstFinalVote = firstFinalVoteCountdown(before);
    this.#drawing = undefined;
    this.#cancelCountdown();

    submit();

    const latest = this.#getSnapshot();
    if (
      restartFrom !== undefined &&
      canContinueCountdown(latest, restartFrom)
    ) {
      this.#arm(countdownFromSnapshot(latest));
    } else if (
      firstFinalVote !== undefined &&
      canContinueCountdown(latest, firstFinalVote)
    ) {
      this.#arm(firstFinalVote);
    }
    return true;
  }

  startDrawing(intent: DrawingIntent = createDrawingIntent()): DrawingIntent {
    if (this.#disposed) {
      return intent;
    }
    if (this.#drawing?.intent === intent) {
      if (!canContinueDrawing(this.#getSnapshot(), this.#drawing)) {
        this.#drawing = undefined;
      }
      return intent;
    }
    const snapshot = this.#getSnapshot();
    const context = roundContext(snapshot);
    const restartFrom = this.#countdown;
    this.#cancelCountdown();
    if (context === null || !isRevealEligible(snapshot)) {
      this.#drawing = undefined;
      return intent;
    }
    this.#drawing = {
      context,
      intent,
      interrupted: restartFrom !== undefined,
      restartFrom,
    };
    return intent;
  }

  submitDrawingVote(
    intent: DrawingIntent,
    value: number,
    submit: (value: number) => void,
  ): boolean {
    const drawing = this.#drawing;
    if (
      this.#disposed ||
      drawing?.intent !== intent ||
      !canContinueDrawing(this.#getSnapshot(), drawing)
    ) {
      if (drawing?.intent === intent) {
        this.#drawing = undefined;
      }
      return false;
    }

    this.#drawing = undefined;
    const before = this.#getSnapshot();
    const firstFinalVote = firstFinalVoteCountdown(before);
    submit(value);

    const latest = this.#getSnapshot();
    if (
      drawing.restartFrom !== undefined &&
      canContinueCountdown(latest, drawing.restartFrom)
    ) {
      this.#arm(countdownFromSnapshot(latest));
    } else if (
      !drawing.interrupted &&
      firstFinalVote !== undefined &&
      canContinueCountdown(latest, firstFinalVote)
    ) {
      this.#arm(firstFinalVote);
    }
    return true;
  }

  rejectDrawing(intent: DrawingIntent): boolean {
    if (this.#disposed || this.#drawing?.intent !== intent) {
      return false;
    }
    this.#drawing = undefined;
    return true;
  }

  retract(intent: CommandIntent, submit: () => void): boolean {
    if (!this.#acceptIntent(intent)) {
      return false;
    }
    this.#drawing = undefined;
    this.#cancelCountdown();
    submit();
    return true;
  }

  cancel(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#drawing !== undefined) {
      this.#drawing.restartFrom = undefined;
    }
    this.#cancelCountdown();
  }

  requestManualReveal(): RevealRequestResult {
    if (this.#disposed) {
      return { status: "ignored" };
    }
    return this.#attemptReveal(this.#getSnapshot());
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#drawing = undefined;
    this.#cancelCountdown();
    this.#listeners.clear();
  }

  #acceptIntent(intent: CommandIntent): boolean {
    if (this.#disposed || this.#processedIntents.has(intent)) {
      return false;
    }
    this.#processedIntents.add(intent);
    return true;
  }

  #arm(source: Omit<Countdown, "deadline" | "generation">): void {
    if (this.#disposed) {
      return;
    }
    this.#cancelCountdown();
    const generation = ++this.#generation;
    const deadline = this.#scheduler.now() + AUTO_REVEAL_DELAY_MS;
    this.#countdown = { ...source, deadline, generation };
    this.#setState({ deadline, status: "counting" });
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timerExpired(generation);
    }, AUTO_REVEAL_DELAY_MS);
  }

  #timerExpired(generation: number): void {
    const countdown = this.#countdown;
    if (this.#disposed || countdown?.generation !== generation) {
      return;
    }

    const remaining = countdown.deadline - this.#scheduler.now();
    if (remaining > 0) {
      this.#timer = this.#scheduler.setTimeout(() => {
        this.#timerExpired(generation);
      }, remaining);
      return;
    }

    const latest = this.#getSnapshot();
    if (!canContinueCountdown(latest, countdown)) {
      this.#cancelCountdown();
      return;
    }
    this.#cancelCountdown();
    this.#attemptReveal(latest);
  }

  #attemptReveal(snapshot: ClientSnapshot): RevealRequestResult {
    const context = roundContext(snapshot);
    if (
      !isRevealEligible(snapshot) ||
      context === null ||
      sameRound(this.#revealedContext, context)
    ) {
      return { status: "ignored" };
    }

    this.#drawing = undefined;
    this.#cancelCountdown();
    this.#revealedContext = context;
    try {
      this.#sendReveal();
      return { status: "sent" };
    } catch (error: unknown) {
      this.#revealedContext = undefined;
      this.#onRevealError?.(error);
      return { error, status: "failed" };
    }
  }

  #cancelCountdown(): void {
    ++this.#generation;
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#countdown = undefined;
    this.#setState(IDLE_STATE);
  }

  #setState(state: AutoRevealState): void {
    if (
      this.#state.status === state.status &&
      this.#state.deadline === state.deadline
    ) {
      return;
    }
    this.#state = state;
    for (const listener of new Set(this.#listeners)) {
      listener();
    }
  }
}

function firstFinalVoteCountdown(
  snapshot: ClientSnapshot,
): Omit<Countdown, "deadline" | "generation"> | undefined {
  const context = roundContext(snapshot);
  return context !== null && isLocalSoleMissingVoter(snapshot)
    ? { context, validationRevision: snapshot.revision }
    : undefined;
}

function countdownFromSnapshot(
  snapshot: ClientSnapshot,
): Omit<Countdown, "deadline" | "generation"> {
  const context = roundContext(snapshot);
  if (context === null) {
    throw new Error("An auto-reveal countdown requires a room snapshot.");
  }
  return { context, validationRevision: snapshot.revision };
}

function canContinueCountdown(
  snapshot: ClientSnapshot,
  countdown: Pick<Countdown, "context" | "validationRevision">,
): boolean {
  const context = roundContext(snapshot);
  const coverage = votingCoverage(snapshot);
  if (
    !isRevealEligible(snapshot) ||
    context === null ||
    !sameContext(countdown.context, context) ||
    coverage.localVoter === null ||
    coverage.voters.length < 2 ||
    snapshot.revision < countdown.validationRevision
  ) {
    return false;
  }

  // The command API is non-optimistic. Its pre-command snapshot can still show
  // the local voter as missing until a strictly newer revision is observed.
  return (
    snapshot.revision === countdown.validationRevision ||
    coverage.allVotersCovered
  );
}

function canContinueDrawing(
  snapshot: ClientSnapshot,
  drawing: Pick<Drawing, "context">,
): boolean {
  return (
    isRevealEligible(snapshot) &&
    sameContext(drawing.context, roundContext(snapshot))
  );
}

export function votingContextKey(snapshot: ClientSnapshot): string | null {
  const context = roundContext(snapshot);
  return context === null
    ? null
    : JSON.stringify([
        context.status,
        context.roomName,
        context.roundNumber,
        context.phase,
        context.deck,
      ]);
}

function roundContext(snapshot: ClientSnapshot): RoundContext | null {
  const room = snapshot.room;
  return room === null
    ? null
    : {
        deck: [...room.deck],
        phase: room.phase,
        roomName: room.name,
        roundNumber: snapshot.roundNumber,
        status: snapshot.status,
      };
}

function sameContext(
  left: RoundContext | undefined,
  right: RoundContext | null,
): boolean {
  return (
    left !== undefined &&
    right !== null &&
    left.phase === right.phase &&
    left.roomName === right.roomName &&
    left.roundNumber === right.roundNumber &&
    left.status === right.status &&
    left.deck.length === right.deck.length &&
    left.deck.every((card, index) => card === right.deck[index])
  );
}

function sameRound(
  left: RoundContext | undefined,
  right: RoundContext,
): boolean {
  return (
    left?.roomName === right.roomName &&
    left.roundNumber === right.roundNumber &&
    left.deck.length === right.deck.length &&
    left.deck.every((card, index) => card === right.deck[index])
  );
}

function browserScheduler(): MonotonicScheduler {
  return {
    clearTimeout: (handle) => {
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      );
    },
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  };
}

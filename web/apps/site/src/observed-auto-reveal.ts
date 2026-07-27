import type { ClientSnapshot, PokerClient } from "@ppoker/web-client";
import { useEffect, useState } from "react";

export const MAX_OBSERVED_AUTO_REVEAL_MS = 60_000;

export interface ObservedAutoRevealScheduler {
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
}

export interface ObservedAutoReveal {
  readonly deadline: number;
  readonly durationMs: number;
  readonly key: number;
  readonly startedAt: number;
}

export interface ObservedAutoRevealPresentation {
  readonly initialProgress: number;
  readonly key: number;
  readonly remainingMs: number;
}

export function deriveObservedAutoRevealPresentation(
  countdown: ObservedAutoReveal,
  now: number,
): ObservedAutoRevealPresentation | null {
  if (!Number.isFinite(now)) {
    return null;
  }
  const remainingMs = Math.min(
    countdown.durationMs,
    Math.max(0, countdown.deadline - now),
  );
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null;
  }
  return {
    initialProgress: remainingMs / countdown.durationMs,
    key: countdown.key,
    remainingMs,
  };
}

interface CountdownContext {
  readonly roomName: string;
  readonly roundNumber: number;
}

interface ActiveCountdown {
  readonly context: CountdownContext;
  readonly generation: number;
  readonly presentation: ObservedAutoReveal;
}

interface ObservedAutoRevealControllerOptions {
  readonly getSnapshot: () => ClientSnapshot;
  readonly onChange: (countdown: ObservedAutoReveal | null) => void;
  readonly scheduler?: ObservedAutoRevealScheduler;
}

export class ObservedAutoRevealController {
  readonly #getSnapshot: () => ClientSnapshot;
  readonly #onChange: (countdown: ObservedAutoReveal | null) => void;
  readonly #scheduler: ObservedAutoRevealScheduler;

  #active: ActiveCountdown | undefined;
  #disposed = false;
  #generation = 0;
  #timer: unknown;

  constructor(options: ObservedAutoRevealControllerOptions) {
    this.#getSnapshot = options.getSnapshot;
    this.#onChange = options.onChange;
    this.#scheduler = options.scheduler ?? browserScheduler;
  }

  announce(countdownMs: number): void {
    if (this.#disposed) {
      return;
    }

    const context = countdownContext(this.#getSnapshot());
    const durationMs = sanitizedDuration(countdownMs);
    const startedAt = this.#scheduler.now();
    const deadline = startedAt + (durationMs ?? 0);
    if (
      context === null ||
      durationMs === null ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(deadline)
    ) {
      this.#clear();
      return;
    }

    this.#clearTimer();
    const generation = ++this.#generation;
    const presentation = {
      deadline,
      durationMs,
      key: generation,
      startedAt,
    } satisfies ObservedAutoReveal;
    this.#active = { context, generation, presentation };
    this.#onChange(presentation);
    this.#scheduleExpiry(generation, durationMs);
  }

  observe(snapshot: ClientSnapshot): void {
    const active = this.#active;
    if (this.#disposed || active === undefined) {
      return;
    }

    const context = countdownContext(snapshot);
    if (context === null || !sameContext(active.context, context)) {
      this.#clear();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#generation += 1;
    this.#active = undefined;
    this.#clearTimer();
  }

  #clear(): void {
    const hadActiveCountdown = this.#active !== undefined;
    this.#generation += 1;
    this.#active = undefined;
    this.#clearTimer();
    if (hadActiveCountdown) {
      this.#onChange(null);
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#scheduler.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #scheduleExpiry(generation: number, delayMs: number): void {
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timerExpired(generation);
    }, delayMs);
  }

  #timerExpired(generation: number): void {
    const active = this.#active;
    if (this.#disposed || active?.generation !== generation) {
      return;
    }

    const remaining = active.presentation.deadline - this.#scheduler.now();
    if (remaining > 0 && Number.isFinite(remaining)) {
      this.#scheduleExpiry(generation, remaining);
      return;
    }
    this.#clear();
  }
}

interface OwnedCountdown {
  readonly client: PokerClient;
  readonly countdown: ObservedAutoReveal | null;
  readonly room: string;
  readonly scheduler: ObservedAutoRevealScheduler | null;
}

export function useObservedAutoReveal(
  client: PokerClient,
  room: string,
  scheduler?: ObservedAutoRevealScheduler,
): ObservedAutoReveal | null {
  const [ownedCountdown, setOwnedCountdown] = useState<OwnedCountdown | null>(
    null,
  );
  const schedulerIdentity = scheduler ?? null;

  useEffect(() => {
    let active = true;
    const controller = new ObservedAutoRevealController({
      getSnapshot: client.getSnapshot,
      onChange: (countdown) => {
        if (active) {
          setOwnedCountdown({
            client,
            countdown,
            room,
            scheduler: schedulerIdentity,
          });
        }
      },
      ...(scheduler === undefined ? {} : { scheduler }),
    });
    const unsubscribeSnapshot = client.subscribe(() => {
      controller.observe(client.getSnapshot());
    });
    const unsubscribeAnnouncement = client.subscribeRoomEvent(
      "autoRevealAnnounced",
      ({ countdownMs }) => {
        controller.observe(client.getSnapshot());
        controller.announce(countdownMs);
      },
    );
    controller.observe(client.getSnapshot());

    return () => {
      active = false;
      unsubscribeAnnouncement();
      unsubscribeSnapshot();
      controller.dispose();
    };
  }, [client, room, scheduler, schedulerIdentity]);

  return ownedCountdown?.client === client &&
    ownedCountdown.room === room &&
    ownedCountdown.scheduler === schedulerIdentity
    ? ownedCountdown.countdown
    : null;
}

function countdownContext(snapshot: ClientSnapshot): CountdownContext | null {
  const room = snapshot.room;
  if (
    snapshot.status !== "open" ||
    snapshot.terminalError !== null ||
    room?.phase !== "playing"
  ) {
    return null;
  }
  const voters = room.players.filter((player) => player.userType === "player");
  if (
    voters.length === 0 ||
    voters.some((player) => player.vote.state === "missing")
  ) {
    return null;
  }
  return { roomName: room.name, roundNumber: snapshot.roundNumber };
}

function sameContext(left: CountdownContext, right: CountdownContext): boolean {
  return (
    left.roomName === right.roomName && left.roundNumber === right.roundNumber
  );
}

function sanitizedDuration(countdownMs: number): number | null {
  return Number.isFinite(countdownMs) && countdownMs > 0
    ? Math.min(countdownMs, MAX_OBSERVED_AUTO_REVEAL_MS)
    : null;
}

const browserScheduler: ObservedAutoRevealScheduler = {
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

import { useEffect, useRef, useState } from "react";
import type { ClientSnapshot } from "@ppoker/web-client";

export interface ObserverTimingSnapshot {
  readonly historyAges: ReadonlyMap<string, string>;
  readonly phaseElapsed: string;
}

export class ObserverTimingTracker {
  // This metadata is intentionally process-local; constructing a new tracker on
  // page reload resets phase and completion observations.
  readonly #historyObservedAt = new Map<string, number>();
  #phaseKey: string | undefined;
  #phaseObservedAt = 0;

  observe(snapshot: ClientSnapshot, now: number): ObserverTimingSnapshot {
    const room = snapshot.room;
    if (room !== null) {
      const phaseKey = `${snapshot.roundNumber.toString()}:${room.phase}`;
      if (phaseKey !== this.#phaseKey) {
        this.#phaseKey = phaseKey;
        this.#phaseObservedAt = now;
      }
    }

    snapshot.history.forEach((entry, sourceIndex) => {
      const key = historyObservationKey(entry.roundNumber, sourceIndex);
      if (!this.#historyObservedAt.has(key)) {
        this.#historyObservedAt.set(key, now);
      }
    });

    return {
      historyAges: new Map(
        [...this.#historyObservedAt].map(([key, observedAt]) => [
          key,
          formatRelativeAge(now - observedAt),
        ]),
      ),
      phaseElapsed:
        this.#phaseKey === undefined
          ? "--:--"
          : formatElapsed(now - this.#phaseObservedAt),
    };
  }
}

const systemNow = (): number => Date.now();

export function useObserverTiming(
  snapshot: ClientSnapshot,
  now: () => number = systemNow,
): ObserverTimingSnapshot {
  const tracker = useRef<ObserverTimingTracker | null>(null);
  tracker.current ??= new ObserverTimingTracker();
  const [, setCurrentTime] = useState(now);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCurrentTime(now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [now]);

  return tracker.current.observe(snapshot, now());
}

export function historyObservationKey(
  roundNumber: number,
  sourceIndex: number,
): string {
  return `${sourceIndex.toString()}:${roundNumber.toString()}`;
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatRelativeAge(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 10) {
    return "just now";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds.toString()} sec ago`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes.toString()} min ago`;
}

import type { ClientOptions, PokerClient } from "@ppoker/web-client";

import {
  bindPageLifecycle,
  createClientLifecycle,
  type ClientStartResult,
  type PokerClientLifecycle,
} from "./client-lifecycle";
import { SCOREBOARD_REVEAL_DELAY_MS } from "./animation";
import { spectatorClientOptions, type BroadcastConfig } from "./config";

export const DEFAULT_REVEAL_DELAY_MS = SCOREBOARD_REVEAL_DELAY_MS;

export type BroadcastSessionSnapshot =
  | { readonly status: "idle" }
  | {
      readonly revealAt: null;
      readonly room: string;
      readonly status: "starting";
    }
  | {
      readonly client: PokerClient;
      readonly connectError: unknown;
      readonly revealAt: number;
      readonly room: string;
      readonly status: "ready";
    }
  | {
      readonly error: unknown;
      readonly revealAt: null;
      readonly room: string;
      readonly status: "error";
    };

export interface BroadcastSessionManager {
  close(): void;
  dispose(): void;
  readonly getSnapshot: () => BroadcastSessionSnapshot;
  start(config: BroadcastConfig): void;
  readonly subscribe: (listener: () => void) => () => void;
}

interface BroadcastSessionDependencies {
  readonly bindLifecycle?: (
    lifecycle: PokerClientLifecycle,
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    reload: () => void,
  ) => () => void;
  readonly createLifecycle?: (options: ClientOptions) => PokerClientLifecycle;
  readonly now?: () => number;
  readonly pageTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  readonly reload: () => void;
  readonly revealDelayMs?: number;
}

interface ActiveSession {
  readonly key: string;
  readonly lifecycle: PokerClientLifecycle;
  readonly revealAt: number;
  unbindPageLifecycle: (() => void) | undefined;
}

const IDLE_SNAPSHOT = Object.freeze({ status: "idle" } as const);

export function createBroadcastSessionManager(
  dependencies: BroadcastSessionDependencies,
): BroadcastSessionManager {
  const bindLifecycle = dependencies.bindLifecycle ?? bindPageLifecycle;
  const createLifecycle = dependencies.createLifecycle ?? createClientLifecycle;
  const now = dependencies.now ?? Date.now;
  const revealDelayMs = dependencies.revealDelayMs ?? DEFAULT_REVEAL_DELAY_MS;
  const listeners = new Set<() => void>();
  let active: ActiveSession | undefined;
  let disposed = false;
  let snapshot: BroadcastSessionSnapshot = IDLE_SNAPSHOT;

  const getSnapshot = (): BroadcastSessionSnapshot => snapshot;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const publish = (next: BroadcastSessionSnapshot): void => {
    if (snapshot === next) {
      return;
    }
    snapshot = next;
    for (const listener of new Set(listeners)) {
      listener();
    }
  };
  const teardownActive = (): void => {
    const session = active;
    if (session === undefined) {
      return;
    }
    active = undefined;
    try {
      session.unbindPageLifecycle?.();
    } catch {
      // Continue through all owned cleanup steps.
    }
    try {
      session.lifecycle.close();
    } catch {
      // Replacement and page teardown must proceed even if client close fails.
    }
  };
  const close = (): void => {
    teardownActive();
    publish(IDLE_SNAPSHOT);
  };
  const acceptStart = (
    session: ActiveSession,
    room: string,
    result: ClientStartResult,
  ): void => {
    if (disposed || active !== session) {
      return;
    }

    const readySnapshot: BroadcastSessionSnapshot = {
      client: result.client,
      connectError: result.connectError,
      revealAt: session.revealAt,
      room,
      status: "ready",
    };
    publish(readySnapshot);
  };
  const rejectStart = (
    session: ActiveSession,
    room: string,
    error: unknown,
  ): void => {
    if (disposed || active !== session) {
      return;
    }
    publish({ error, revealAt: null, room, status: "error" });
  };
  const start = (config: BroadcastConfig): void => {
    if (disposed) {
      return;
    }
    const key = `${config.endpoint}\n${config.room}`;
    if (active?.key === key) {
      return;
    }

    const revealAt = now() + revealDelayMs;
    teardownActive();
    let lifecycle: PokerClientLifecycle;
    try {
      lifecycle = createLifecycle(spectatorClientOptions(config));
    } catch (error: unknown) {
      publish({ error, revealAt: null, room: config.room, status: "error" });
      return;
    }

    const session: ActiveSession = {
      key,
      lifecycle,
      revealAt,
      unbindPageLifecycle: undefined,
    };
    active = session;
    publish({ revealAt: null, room: config.room, status: "starting" });
    try {
      session.unbindPageLifecycle = bindLifecycle(
        lifecycle,
        dependencies.pageTarget,
        dependencies.reload,
      );
      void lifecycle.start().then(
        (result) => {
          acceptStart(session, config.room, result);
        },
        (error: unknown) => {
          rejectStart(session, config.room, error);
        },
      );
    } catch (error: unknown) {
      rejectStart(session, config.room, error);
    }
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    teardownActive();
    publish(IDLE_SNAPSHOT);
    listeners.clear();
  };

  return { close, dispose, getSnapshot, start, subscribe };
}

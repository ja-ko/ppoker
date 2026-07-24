import type { ClientOptions, PokerClient } from "@ppoker/web-client";

import {
  bindPageLifecycle,
  createClientLifecycle,
  type ClientStartResult,
  type PokerClientLifecycle,
} from "./client-lifecycle";
import { participantClientOptions, type VotingConfig } from "./config";
import {
  createVoterNameSession,
  type VoterNameSession,
} from "./voting/voter-session";

export type VotingSessionSnapshot =
  | { readonly status: "idle" }
  | {
      readonly initialName: string;
      readonly nameSession: VoterNameSession;
      readonly room: string;
      readonly status: "starting";
    }
  | {
      readonly client: PokerClient;
      readonly connectError: unknown;
      readonly initialName: string;
      readonly nameSession: VoterNameSession;
      readonly room: string;
      readonly status: "ready";
    }
  | {
      readonly error: unknown;
      readonly room: string;
      readonly status: "error";
    };

export interface VotingSessionManager {
  close(): void;
  dispose(): void;
  readonly getSnapshot: () => VotingSessionSnapshot;
  start(config: VotingConfig): void;
  readonly subscribe: (listener: () => void) => () => void;
}

interface VotingSessionDependencies {
  readonly bindLifecycle?: (
    lifecycle: PokerClientLifecycle,
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    reload: () => void,
  ) => () => void;
  readonly createLifecycle?: (options: ClientOptions) => PokerClientLifecycle;
  readonly createNameSession?: () => VoterNameSession;
  readonly pageTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  readonly reload: () => void;
}

interface ActiveSession {
  readonly endpoint: string;
  readonly initialName: string;
  readonly lifecycle: PokerClientLifecycle;
  readonly nameSession: VoterNameSession;
  readonly room: string;
  unbindPageLifecycle: (() => void) | undefined;
}

const IDLE_SNAPSHOT: VotingSessionSnapshot = Object.freeze({ status: "idle" });

export function createVotingSessionManager(
  dependencies: VotingSessionDependencies,
): VotingSessionManager {
  const bindLifecycle = dependencies.bindLifecycle ?? bindPageLifecycle;
  const createLifecycle = dependencies.createLifecycle ?? createClientLifecycle;
  const createNameSession =
    dependencies.createNameSession ?? createVoterNameSession;
  const listeners = new Set<() => void>();
  let active: ActiveSession | undefined;
  let disposed = false;
  let nameSession: VoterNameSession | undefined;
  let snapshot: VotingSessionSnapshot = IDLE_SNAPSHOT;

  const getSnapshot = (): VotingSessionSnapshot => snapshot;
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const publish = (next: VotingSessionSnapshot): void => {
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
    result: ClientStartResult,
  ): void => {
    if (disposed || active !== session) {
      return;
    }
    publish(
      Object.freeze({
        client: result.client,
        connectError: result.connectError,
        initialName: session.initialName,
        nameSession: session.nameSession,
        room: session.room,
        status: "ready",
      }),
    );
  };
  const rejectStart = (session: ActiveSession, error: unknown): void => {
    if (disposed || active !== session) {
      return;
    }
    publish(Object.freeze({ error, room: session.room, status: "error" }));
  };
  const start = (config: VotingConfig): void => {
    if (disposed) {
      return;
    }
    if (active?.endpoint === config.endpoint && active.room === config.room) {
      return;
    }

    teardownActive();
    let initialName: string;
    let lifecycle: PokerClientLifecycle;
    let sessionNames: VoterNameSession;
    try {
      sessionNames = nameSession ?? createNameSession();
      nameSession = sessionNames;
      initialName = sessionNames.load();
      lifecycle = createLifecycle(
        participantClientOptions(config, initialName),
      );
    } catch (error: unknown) {
      publish(Object.freeze({ error, room: config.room, status: "error" }));
      return;
    }

    const session: ActiveSession = {
      endpoint: config.endpoint,
      initialName,
      lifecycle,
      nameSession: sessionNames,
      room: config.room,
      unbindPageLifecycle: undefined,
    };
    active = session;
    publish(
      Object.freeze({
        initialName,
        nameSession: sessionNames,
        room: config.room,
        status: "starting",
      }),
    );
    try {
      session.unbindPageLifecycle = bindLifecycle(
        lifecycle,
        dependencies.pageTarget,
        dependencies.reload,
      );
      void lifecycle.start().then(
        (result) => {
          acceptStart(session, result);
        },
        (error: unknown) => {
          rejectStart(session, error);
        },
      );
    } catch (error: unknown) {
      if (active === session) {
        teardownActive();
        publish(Object.freeze({ error, room: session.room, status: "error" }));
      }
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

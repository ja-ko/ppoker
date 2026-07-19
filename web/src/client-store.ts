import { deepFreeze, type DeepReadonly } from "./readonly.js";
import type { ClientSnapshot } from "./wasm-client.js";

export type PokerClientSnapshot = DeepReadonly<ClientSnapshot>;

export interface PokerClientPort {
  connect(): void;
  poll(): boolean;
  snapshot(): ClientSnapshot;
  vote(value: string): void;
  retractVote(): void;
  rename(name: string): void;
  chat(message: string): void;
  reveal(): void;
  startNewRound(): void;
  close(): void;
}

export interface PokerClientStoreOptions {
  readonly pollIntervalMs?: number;
}

export interface PokerClientStore {
  readonly getSnapshot: () => PokerClientSnapshot;
  readonly getServerSnapshot: () => PokerClientSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly connect: () => void;
  readonly poll: () => boolean;
  readonly vote: (value: string) => void;
  readonly retractVote: () => void;
  readonly rename: (name: string) => void;
  readonly chat: (message: string) => void;
  readonly reveal: () => void;
  readonly startNewRound: () => void;
  readonly dispose: () => void;
  readonly [Symbol.dispose]: () => void;
}

const SERVER_SNAPSHOT: PokerClientSnapshot = deepFreeze({
  revision: 0,
  status: "disconnected",
  terminalError: null,
  room: null,
  localName: "",
  localVote: null,
  activity: [],
  currentRound: {
    number: 0,
    startedAtMs: null,
  },
  history: [],
  statistics: {
    average: null,
  },
});

const CLOSED_MESSAGE = "Client is closed.";
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 2_147_483_647;
const POLL_INTERVAL_ERROR =
  "pollIntervalMs must be a positive safe integer no greater than 2147483647.";

interface Subscription {
  active: boolean;
  lastNotifiedRevision: number;
  readonly listener: () => void;
}

export function createPokerClientStore(
  client: PokerClientPort,
  options: PokerClientStoreOptions = {},
): PokerClientStore {
  const configuredPollInterval: unknown = options.pollIntervalMs;
  const pollIntervalMs =
    configuredPollInterval === undefined
      ? DEFAULT_POLL_INTERVAL_MS
      : configuredPollInterval;
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isFinite(pollIntervalMs) ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new TypeError(POLL_INTERVAL_ERROR);
  }

  const subscriptions = new Set<Subscription>();
  let snapshot = deepFreeze(client.snapshot());
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let notifying = false;
  let notificationRequested = false;
  let clearSubscriptionsAfterNotification = false;

  const clearSubscriptions = (): void => {
    for (const subscription of subscriptions) {
      subscription.active = false;
    }
    subscriptions.clear();
  };

  const notifySubscribers = (): void => {
    notificationRequested = true;
    if (notifying) {
      return;
    }

    notifying = true;
    let firstError: unknown;
    let failed = false;
    try {
      while (notificationRequested) {
        notificationRequested = false;
        const revision = snapshot.revision;
        for (const subscription of [...subscriptions]) {
          if (snapshot.revision !== revision) {
            notificationRequested = true;
            break;
          }
          if (
            !subscription.active ||
            subscription.lastNotifiedRevision === revision
          ) {
            continue;
          }

          subscription.lastNotifiedRevision = revision;
          try {
            subscription.listener();
          } catch (error: unknown) {
            if (!failed) {
              firstError = error;
              failed = true;
            }
          }
          if (snapshot.revision !== revision) {
            notificationRequested = true;
            break;
          }
        }
      }
    } finally {
      notifying = false;
      if (clearSubscriptionsAfterNotification) {
        clearSubscriptionsAfterNotification = false;
        clearSubscriptions();
      }
    }
    if (failed) {
      throw firstError;
    }
  };

  const refresh = (): boolean => {
    const nextSnapshot = client.snapshot();
    if (nextSnapshot.revision === snapshot.revision) {
      return false;
    }

    snapshot = deepFreeze(nextSnapshot);
    notifySubscribers();
    return true;
  };

  const refreshAfterFailure = (operationError: unknown): never => {
    try {
      refresh();
    } catch {
      // The delegated operation's original error is authoritative.
    }
    throw operationError;
  };

  const stopPolling = (): void => {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const poll = (): boolean => {
    if (disposed) {
      return false;
    }
    try {
      client.poll();
    } catch (error: unknown) {
      return refreshAfterFailure(error);
    }
    return refresh();
  };

  const pollFromInterval = (): void => {
    try {
      poll();
    } catch {
      // Explicit polls propagate; interval polls have no error recipient.
    }
  };

  const assertActive = (): void => {
    if (disposed) {
      throw Object.assign(new Error(CLOSED_MESSAGE), {
        code: "Closed" as const,
      });
    }
  };

  const run = (operation: () => void): void => {
    assertActive();
    try {
      operation();
    } catch (error: unknown) {
      refreshAfterFailure(error);
    }
    refresh();
  };

  const subscribe = (listener: () => void): (() => void) => {
    if (disposed) {
      return () => undefined;
    }

    const subscription: Subscription = {
      active: true,
      lastNotifiedRevision: snapshot.revision,
      listener,
    };
    subscriptions.add(subscription);
    if (subscriptions.size === 1) {
      try {
        interval = setInterval(pollFromInterval, pollIntervalMs);
      } catch (error: unknown) {
        subscription.active = false;
        subscriptions.delete(subscription);
        throw error;
      }
    }

    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) {
        stopPolling();
      }
    };
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    stopPolling();
    let operationError: unknown;
    let failed = false;
    try {
      client.close();
    } catch (error: unknown) {
      operationError = error;
      failed = true;
    }
    try {
      refresh();
    } catch (error: unknown) {
      if (!failed) {
        operationError = error;
        failed = true;
      }
    } finally {
      if (notifying) {
        clearSubscriptionsAfterNotification = true;
      } else {
        clearSubscriptions();
      }
    }
    if (failed) {
      throw operationError;
    }
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    subscribe,
    connect: () => {
      run(() => {
        client.connect();
      });
    },
    poll,
    vote: (value) => {
      run(() => {
        client.vote(value);
      });
    },
    retractVote: () => {
      run(() => {
        client.retractVote();
      });
    },
    rename: (name) => {
      run(() => {
        client.rename(name);
      });
    },
    chat: (message) => {
      run(() => {
        client.chat(message);
      });
    },
    reveal: () => {
      run(() => {
        client.reveal();
      });
    },
    startNewRound: () => {
      run(() => {
        client.startNewRound();
      });
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

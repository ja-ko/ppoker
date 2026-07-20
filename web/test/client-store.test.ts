import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPokerClientStore,
  type PokerClientStore,
} from "../src/client-store.js";
import { deepFreeze } from "../src/readonly.js";
import {
  createFakeClient,
  makeRichSnapshot,
  makeSnapshot,
} from "./fake-client.js";

type FakeClient = ReturnType<typeof createFakeClient>["client"];

function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("operation did not throw");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createPokerClientStore options", () => {
  it("validates the polling interval before reading the client snapshot", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const invalidValues: unknown[] = [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER + 1,
      "50",
      null,
    ];

    for (const value of invalidValues) {
      const { client } = createFakeClient();
      const error = captureError(() => {
        Reflect.apply(createPokerClientStore, undefined, [
          client,
          { pollIntervalMs: value },
        ]);
      });
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({
        message:
          "pollIntervalMs must be a positive safe integer no greater than 2147483647.",
      });
      expect(client.snapshot).not.toHaveBeenCalled();
    }
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const { client } = createFakeClient();
    const store = createPokerClientStore(client, {
      pollIntervalMs: 2_147_483_647,
    });
    expect(store.getSnapshot().revision).toBe(0);
    expect(client.snapshot).toHaveBeenCalledOnce();
  });
});

describe("createPokerClientStore snapshots", () => {
  it("caches initial and server snapshots without server-side effects", () => {
    const first = createFakeClient(makeSnapshot(4, "open"));
    const second = createFakeClient();
    const firstStore = createPokerClientStore(first.client);
    const secondStore = createPokerClientStore(second.client);

    expect(firstStore.getSnapshot()).toBe(firstStore.getSnapshot());
    expect(firstStore.getSnapshot().revision).toBe(4);
    expect(firstStore.getServerSnapshot()).toBe(firstStore.getServerSnapshot());
    expect(firstStore.getServerSnapshot()).toBe(
      secondStore.getServerSnapshot(),
    );
    expect(firstStore.getServerSnapshot()).toEqual({
      revision: 0,
      status: "disconnected",
      terminalError: null,
      room: null,
      localName: "",
      localVote: null,
      log: [],
      roundNumber: 0,
      roundStartedAtMs: null,
      history: [],
      average: null,
    });
    expect(Object.isFrozen(firstStore.getServerSnapshot())).toBe(true);
    expect(Object.isFrozen(firstStore.getServerSnapshot().log)).toBe(true);
    expect(first.client.snapshot).toHaveBeenCalledOnce();
    expect(first.client.poll).not.toHaveBeenCalled();
    expect(first.client.connect).not.toHaveBeenCalled();
  });

  it("recursively freezes every nested snapshot structure", () => {
    const { client } = createFakeClient(makeRichSnapshot());
    const snapshot = createPokerClientStore(client).getSnapshot();

    const nestedValues = [
      snapshot,
      snapshot.terminalError,
      snapshot.room,
      snapshot.room?.deck,
      snapshot.room?.players,
      snapshot.room?.players[0],
      snapshot.room?.players[0]?.vote,
      snapshot.localVote,
      snapshot.log,
      snapshot.log[0],
      snapshot.history,
      snapshot.history[0],
      snapshot.history[0]?.votes,
      snapshot.history[0]?.votes[0],
      snapshot.history[0]?.deck,
      snapshot.history[0]?.ownVote,
    ];
    for (const value of nestedValues) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() =>
      Object.assign(snapshot.room?.players[0] ?? {}, { name: "Mutated" }),
    ).toThrow(TypeError);
    expect(snapshot.room?.players[0]?.name).toBe("Ada");
  });

  it("deeply freezes independently shallow-frozen port snapshots", () => {
    const rawSnapshot = makeRichSnapshot();
    Object.freeze(rawSnapshot);
    expect(Object.isFrozen(rawSnapshot)).toBe(true);
    expect(Object.isFrozen(rawSnapshot.room)).toBe(false);
    expect(Object.isFrozen(rawSnapshot.log)).toBe(false);
    expect(Object.isFrozen(rawSnapshot.history)).toBe(false);
    const { client } = createFakeClient(rawSnapshot);

    const snapshot = createPokerClientStore(client).getSnapshot();

    expect(Object.isFrozen(snapshot.room)).toBe(true);
    expect(Object.isFrozen(snapshot.room?.players)).toBe(true);
    expect(Object.isFrozen(snapshot.room?.players[0])).toBe(true);
    expect(Object.isFrozen(snapshot.log)).toBe(true);
    expect(Object.isFrozen(snapshot.log[0])).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.history[0])).toBe(true);
    expect(() =>
      Object.assign(snapshot.room?.players[0] ?? {}, { name: "Mutated" }),
    ).toThrow(TypeError);
    expect(snapshot.room?.players[0]?.name).toBe("Ada");
  });

  it("freezes cyclic and multiply referenced runtime values once", () => {
    const rawSnapshot = makeRichSnapshot();
    Object.defineProperty(rawSnapshot, "cycle", {
      enumerable: true,
      value: rawSnapshot,
    });
    const { client } = createFakeClient(rawSnapshot);

    const snapshot = createPokerClientStore(client).getSnapshot();

    expect(Reflect.get(snapshot, "cycle")).toBe(snapshot);
    expect(snapshot.room?.players[0]).toBe(snapshot.history[0]?.votes[0]);
    expect(Object.isFrozen(snapshot.room?.players[0])).toBe(true);
  });

  it("does not traverse an already deeply frozen snapshot again", () => {
    const rawSnapshot = makeRichSnapshot();
    const log = rawSnapshot.log;
    let logReads = 0;
    Object.defineProperty(rawSnapshot, "log", {
      configurable: true,
      enumerable: true,
      get: () => {
        logReads += 1;
        return log;
      },
    });
    const frozenSnapshot = deepFreeze(rawSnapshot);
    expect(logReads).toBe(1);
    expect(Object.isFrozen(log)).toBe(true);

    const { client } = createFakeClient(frozenSnapshot);
    const snapshot = createPokerClientStore(client).getSnapshot();

    expect(snapshot).toBe(frozenSnapshot);
    expect(logReads).toBe(1);
  });

  it("only remembers roots after recursive freezing succeeds", () => {
    const rawSnapshot = makeSnapshot();
    const log = rawSnapshot.log;
    const traversalError = new Error("nested traversal failed");
    let logReads = 0;
    Object.defineProperty(rawSnapshot, "log", {
      configurable: true,
      enumerable: true,
      get: () => {
        logReads += 1;
        if (logReads === 1) {
          throw traversalError;
        }
        return log;
      },
    });

    expect(captureError(() => deepFreeze(rawSnapshot))).toBe(traversalError);
    expect(Object.isFrozen(rawSnapshot)).toBe(false);
    expect(deepFreeze(rawSnapshot)).toBe(rawSnapshot);
    expect(logReads).toBe(2);
    expect(Object.isFrozen(rawSnapshot)).toBe(true);

    deepFreeze(rawSnapshot);
    expect(logReads).toBe(2);
  });

  it("skips snapshots for unchanged polls and publishes changed polls once", () => {
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    store.subscribe(listener);
    const initial = store.getSnapshot();

    expect(store.poll()).toBe(false);
    expect(store.getSnapshot()).toBe(initial);
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();

    state.value = makeSnapshot(1, "open");
    client.poll.mockReturnValueOnce(true);
    expect(store.poll()).toBe(true);
    const changed = store.getSnapshot();
    expect(changed).not.toBe(initial);
    expect(changed).toBe(store.getSnapshot());
    expect(listener).toHaveBeenCalledOnce();
    expect(client.snapshot).toHaveBeenCalledTimes(2);

    client.poll.mockReturnValueOnce(true);
    expect(store.poll()).toBe(false);
    expect(store.getSnapshot()).toBe(changed);
    expect(listener).toHaveBeenCalledOnce();
    expect(client.snapshot).toHaveBeenCalledTimes(3);
  });
});

describe("createPokerClientStore operations", () => {
  it("delegates connect and all commands and refreshes once per revision", () => {
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    store.subscribe(firstListener);
    store.subscribe(secondListener);
    const advance = (): void => {
      state.value = makeSnapshot(state.value.revision + 1, "open");
    };
    client.connect.mockImplementation(advance);
    client.vote.mockImplementation(advance);
    client.retractVote.mockImplementation(advance);
    client.rename.mockImplementation(advance);
    client.chat.mockImplementation(advance);
    client.reveal.mockImplementation(advance);
    client.startNewRound.mockImplementation(advance);

    store.connect();
    store.vote("8");
    store.retractVote();
    store.rename("Grace");
    store.chat("hello");
    store.reveal();
    store.startNewRound();

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.vote).toHaveBeenCalledWith("8");
    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(client.rename).toHaveBeenCalledWith("Grace");
    expect(client.chat).toHaveBeenCalledWith("hello");
    expect(client.reveal).toHaveBeenCalledOnce();
    expect(client.startNewRound).toHaveBeenCalledOnce();
    expect(client.snapshot).toHaveBeenCalledTimes(8);
    expect(store.getSnapshot().revision).toBe(7);
    expect(firstListener).toHaveBeenCalledTimes(7);
    expect(secondListener).toHaveBeenCalledTimes(7);
  });

  it("keeps authoritative successful commands unchanged until polling", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();

    store.vote("5");
    store.retractVote();
    store.rename("Authoritative name");
    store.startNewRound();

    expect(client.vote).toHaveBeenCalledWith("5");
    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(client.rename).toHaveBeenCalledWith("Authoritative name");
    expect(client.startNewRound).toHaveBeenCalledOnce();
    expect(client.snapshot).toHaveBeenCalledTimes(5);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("heals cache changes before rethrowing connect and command errors", () => {
    vi.useFakeTimers();
    const verifyFailure = (
      label: string,
      configure: (client: FakeClient, failure: () => never) => void,
      invoke: (store: PokerClientStore) => void,
      status: "connecting" | "closed",
    ): void => {
      const { client, state } = createFakeClient();
      const store = createPokerClientStore(client);
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      const initial = store.getSnapshot();
      const operationError = new Error(`${label} failed`);
      configure(client, () => {
        state.value = makeSnapshot(1, status);
        throw operationError;
      });

      expect(
        captureError(() => {
          invoke(store);
        }),
      ).toBe(operationError);
      expect(store.getSnapshot()).not.toBe(initial);
      expect(store.getSnapshot()).toMatchObject({ revision: 1, status });
      expect(Object.isFrozen(store.getSnapshot())).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(status === "closed" ? 0 : 1);

      expect(store.poll()).toBe(false);
      expect(client.snapshot).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
    };

    verifyFailure(
      "connect",
      (client, failure) => client.connect.mockImplementationOnce(failure),
      (store) => {
        store.connect();
      },
      "connecting",
    );
    verifyFailure(
      "vote",
      (client, failure) => client.vote.mockImplementationOnce(failure),
      (store) => {
        store.vote("5");
      },
      "closed",
    );
    verifyFailure(
      "retract vote",
      (client, failure) => client.retractVote.mockImplementationOnce(failure),
      (store) => {
        store.retractVote();
      },
      "closed",
    );
    verifyFailure(
      "rename",
      (client, failure) => client.rename.mockImplementationOnce(failure),
      (store) => {
        store.rename("Failed");
      },
      "closed",
    );
    verifyFailure(
      "chat",
      (client, failure) => client.chat.mockImplementationOnce(failure),
      (store) => {
        store.chat("Failed");
      },
      "closed",
    );
    verifyFailure(
      "reveal",
      (client, failure) => client.reveal.mockImplementationOnce(failure),
      (store) => {
        store.reveal();
      },
      "closed",
    );
    verifyFailure(
      "new round",
      (client, failure) => client.startNewRound.mockImplementationOnce(failure),
      (store) => {
        store.startNewRound();
      },
      "closed",
    );
  });

  it("propagates a poll failure without reading a snapshot and stops polling", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(2, "open"));
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    const pollError = new Error("transport closed while polling");
    client.poll.mockImplementationOnce(() => {
      throw pollError;
    });

    expect(captureError(() => store.poll())).toBe(pollError);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    expect(store.poll()).toBe(false);
    expect(store.getSnapshot()).toBe(initial);
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("preserves the operation error when its healing snapshot read fails", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    const operationError = new Error("original transport failure");
    const refreshError = new Error("secondary snapshot failure");
    client.connect.mockImplementationOnce(() => {
      state.value = makeSnapshot(1, "closed");
      throw operationError;
    });
    client.snapshot.mockImplementationOnce(() => {
      throw refreshError;
    });

    expect(
      captureError(() => {
        store.connect();
      }),
    ).toBe(operationError);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    client.poll.mockReturnValueOnce(true);
    expect(store.poll()).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      revision: 1,
      status: "closed",
    });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("propagates a required snapshot error and stops interval polling", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(2, "open"));
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    const snapshotError = new Error("snapshot unavailable after changed poll");
    client.poll.mockReturnValueOnce(true);
    client.snapshot.mockImplementationOnce(() => {
      throw snapshotError;
    });

    expect(captureError(() => store.poll())).toBe(snapshotError);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies remaining listeners without replacing an operation error", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const operationError = new Error("authoritative operation failure");
    const listenerError = new Error("secondary listener failure");
    const firstListener = vi.fn(() => {
      throw listenerError;
    });
    const secondListener = vi.fn();
    const firstUnsubscribe = store.subscribe(firstListener);
    const secondUnsubscribe = store.subscribe(secondListener);
    client.connect.mockImplementationOnce(() => {
      state.value = makeSnapshot(1, "closed");
      throw operationError;
    });

    expect(
      captureError(() => {
        store.connect();
      }),
    ).toBe(operationError);
    expect(store.getSnapshot()).toMatchObject({
      revision: 1,
      status: "closed",
    });
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
    firstUnsubscribe();
    secondUnsubscribe();
  });
});

describe("createPokerClientStore subscriptions", () => {
  it("shares one interval, stops on the last unsubscribe, and restarts", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    const store = createPokerClientStore(client, { pollIntervalMs: 20 });
    const firstUnsubscribe = store.subscribe(vi.fn());
    const secondUnsubscribe = store.subscribe(vi.fn());

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60);
    expect(client.poll).toHaveBeenCalledTimes(3);

    firstUnsubscribe();
    firstUnsubscribe();
    expect(vi.getTimerCount()).toBe(1);
    secondUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(40);
    expect(client.poll).toHaveBeenCalledTimes(3);
    const restartedUnsubscribe = store.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(20);
    expect(client.poll).toHaveBeenCalledTimes(4);
    restartedUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps initial closed snapshots stable without starting an interval", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(4, "closed"));
    const store = createPokerClientStore(client);
    const initial = store.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(client.poll).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
  });

  it("stops before notifying a remotely closed snapshot and never restarts", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient(makeSnapshot(1, "open"));
    const store = createPokerClientStore(client, { pollIntervalMs: 10 });
    const timerCounts: number[] = [];
    const unsubscribe = store.subscribe(() => {
      timerCounts.push(vi.getTimerCount());
    });
    client.poll.mockImplementationOnce(() => {
      state.value = makeSnapshot(2, "closed");
      return true;
    });

    vi.advanceTimersByTime(10);
    const closed = store.getSnapshot();
    expect(closed).toMatchObject({ revision: 2, status: "closed" });
    expect(timerCounts).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);

    const lateUnsubscribe = store.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30);
    expect(client.poll).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBe(closed);
    unsubscribe();
    lateUnsubscribe();
  });

  it("tracks duplicate callback subscriptions independently", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const listener = vi.fn();
    const firstUnsubscribe = store.subscribe(listener);
    const secondUnsubscribe = store.subscribe(listener);

    state.value = makeSnapshot(1, "open");
    client.poll.mockReturnValueOnce(true);
    store.poll();
    expect(listener).toHaveBeenCalledTimes(2);

    firstUnsubscribe();
    state.value = makeSnapshot(2, "open");
    client.poll.mockReturnValueOnce(true);
    store.poll();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    secondUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back a first subscription when timer registration fails", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const timerError = new Error("host timer registration failed");
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementationOnce(() => {
        throw timerError;
      });
    const failedListener = vi.fn();

    expect(
      captureError(() => {
        store.subscribe(failedListener);
      }),
    ).toBe(timerError);
    expect(vi.getTimerCount()).toBe(0);

    state.value = makeSnapshot(1, "open");
    client.poll.mockReturnValueOnce(true);
    expect(store.poll()).toBe(true);
    expect(failedListener).not.toHaveBeenCalled();

    const activeListener = vi.fn();
    const unsubscribe = store.subscribe(activeListener);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    state.value = makeSnapshot(2, "open");
    client.poll.mockReturnValueOnce(true);
    expect(store.poll()).toBe(true);
    expect(failedListener).not.toHaveBeenCalled();
    expect(activeListener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips removed listeners and defers new listeners during notification", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    const store = createPokerClientStore(client);
    const lateListener = vi.fn();
    const secondListener = vi.fn();
    const thirdListener = vi.fn();
    let lateUnsubscribe: (() => void) | undefined;
    let secondUnsubscribe = (): void => undefined;
    const firstListener = vi.fn(() => {
      if (lateUnsubscribe === undefined) {
        lateUnsubscribe = store.subscribe(lateListener);
        secondUnsubscribe();
      }
    });
    const firstUnsubscribe = store.subscribe(firstListener);
    secondUnsubscribe = store.subscribe(secondListener);
    const thirdUnsubscribe = store.subscribe(thirdListener);

    state.value = makeSnapshot(1, "open");
    client.poll.mockReturnValueOnce(true);
    store.poll();
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).not.toHaveBeenCalled();
    expect(thirdListener).toHaveBeenCalledOnce();
    expect(lateListener).not.toHaveBeenCalled();

    state.value = makeSnapshot(2, "open");
    client.poll.mockReturnValueOnce(true);
    store.poll();
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).not.toHaveBeenCalled();
    expect(thirdListener).toHaveBeenCalledTimes(2);
    expect(lateListener).toHaveBeenCalledOnce();

    firstUnsubscribe();
    thirdUnsubscribe();
    lateUnsubscribe?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes reentrant revisions so later listeners see latest once", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    client.connect.mockImplementation(() => {
      state.value = makeSnapshot(1, "open");
    });
    client.chat.mockImplementation(() => {
      state.value = makeSnapshot(2, "open");
    });
    const store = createPokerClientStore(client);
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    const firstUnsubscribe = store.subscribe(() => {
      const revision = store.getSnapshot().revision;
      firstRevisions.push(revision);
      if (revision === 1) {
        store.chat("commit the next revision");
      }
    });
    const secondUnsubscribe = store.subscribe(() => {
      secondRevisions.push(store.getSnapshot().revision);
    });

    store.connect();

    expect(firstRevisions).toEqual([1, 2]);
    expect(secondRevisions).toEqual([2]);
    expect(client.chat).toHaveBeenCalledOnce();
    firstUnsubscribe();
    secondUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops further ticks after an interval poll failure", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(1, "open"));
    const store = createPokerClientStore(client, { pollIntervalMs: 10 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    const pollError = new Error("asynchronous transport failure");
    client.poll.mockImplementationOnce(() => {
      throw pollError;
    });

    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(30);
    expect(client.poll).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBe(initial);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops interval polling when a changed poll cannot read a snapshot", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(1, "open"));
    const store = createPokerClientStore(client, { pollIntervalMs: 10 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getSnapshot();
    const snapshotError = new Error("asynchronous snapshot failure");
    client.poll.mockReturnValueOnce(true);
    client.snapshot.mockImplementationOnce(() => {
      throw snapshotError;
    });

    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(client.snapshot).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30);
    expect(client.poll).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("polls on a bounded real interval", async () => {
    const { client } = createFakeClient();
    const store = createPokerClientStore(client, { pollIntervalMs: 5 });
    let unsubscribe: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("real polling interval did not fire"));
        }, 500);
        client.poll.mockImplementationOnce(() => {
          clearTimeout(timeout);
          resolve();
          return false;
        });
        unsubscribe = store.subscribe(vi.fn());
      });
      expect(client.poll).toHaveBeenCalled();
    } finally {
      unsubscribe?.();
      store.dispose();
    }
  });
});

describe("createPokerClientStore disposal", () => {
  it("stops polling, closes once, publishes the final revision, and is terminal", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient(makeSnapshot(2, "open"));
    client.close.mockImplementation(() => {
      state.value = makeSnapshot(3, "closed");
    });
    const store = createPokerClientStore(client, { pollIntervalMs: 10 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispose();
    const finalSnapshot = store.getSnapshot();
    store.dispose();
    store[Symbol.dispose]();
    unsubscribe();

    expect(vi.getTimerCount()).toBe(0);
    expect(client.close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(finalSnapshot).toMatchObject({ revision: 3, status: "closed" });
    expect(Object.isFrozen(finalSnapshot)).toBe(true);
    expect(store.getSnapshot()).toBe(finalSnapshot);
    expect(store.poll()).toBe(false);
    expect(client.poll).not.toHaveBeenCalled();

    const lateUnsubscribe = store.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
    lateUnsubscribe();
    const terminalOperations = [
      () => {
        store.connect();
      },
      () => {
        store.vote("3");
      },
      () => {
        store.retractVote();
      },
      () => {
        store.rename("Closed");
      },
      () => {
        store.chat("Closed");
      },
      () => {
        store.reveal();
      },
      () => {
        store.startNewRound();
      },
    ];
    const closedErrors = terminalOperations.map((operation) =>
      captureError(operation),
    );
    for (const error of closedErrors) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error) || !("code" in error)) {
        throw new Error("store did not throw a structured Error");
      }
      expect(error).toMatchObject({
        code: "Closed",
        message: "Client is closed.",
        name: "Error",
      });
      expect(Object.keys(error)).toEqual(["code"]);
    }
    expect(new Set(closedErrors).size).toBe(closedErrors.length);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.vote).not.toHaveBeenCalled();
    expect(client.retractVote).not.toHaveBeenCalled();
    expect(client.rename).not.toHaveBeenCalled();
    expect(client.chat).not.toHaveBeenCalled();
    expect(client.reveal).not.toHaveBeenCalled();
    expect(client.startNewRound).not.toHaveBeenCalled();
  });

  it("is idempotently disposed even when close fails", () => {
    const { client } = createFakeClient();
    const closeError = new Error("close failed");
    client.close.mockImplementationOnce(() => {
      throw closeError;
    });
    const store = createPokerClientStore(client);

    expect(() => {
      store.dispose();
    }).toThrow(closeError);
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(() => {
      store.dispose();
    }).not.toThrow();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("deterministically deactivates listeners when disposed while notifying", () => {
    vi.useFakeTimers();
    const { client, state } = createFakeClient();
    client.connect.mockImplementation(() => {
      state.value = makeSnapshot(1, "open");
    });
    client.close.mockImplementation(() => {
      state.value = makeSnapshot(2, "closed");
    });
    const store = createPokerClientStore(client);
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    store.subscribe(() => {
      firstRevisions.push(store.getSnapshot().revision);
      store.dispose();
    });
    store.subscribe(() => {
      secondRevisions.push(store.getSnapshot().revision);
    });

    store.connect();

    expect(firstRevisions).toEqual([1, 2]);
    expect(secondRevisions).toEqual([2]);
    expect(store.getSnapshot()).toMatchObject({
      revision: 2,
      status: "closed",
    });
    expect(client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its interval when disposed from inside a poll tick", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    const store = createPokerClientStore(client, { pollIntervalMs: 10 });
    client.poll.mockImplementationOnce(() => {
      store.dispose();
      return false;
    });
    store.subscribe(vi.fn());

    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(client.poll).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientOptions,
  ClientSnapshot,
  PokerClient,
  PokerClientConfig,
} from "../src/index.js";
import { captureError, makeRichSnapshot, makeSnapshot } from "./fake-client.js";

interface RawClient {
  snapshotValue: ClientSnapshot;
  connect: ReturnType<typeof vi.fn<() => void>>;
  poll: ReturnType<typeof vi.fn<() => boolean>>;
  snapshot: ReturnType<typeof vi.fn<() => ClientSnapshot>>;
  vote: ReturnType<typeof vi.fn<(value: string) => void>>;
  retractVote: ReturnType<typeof vi.fn<() => void>>;
  rename: ReturnType<typeof vi.fn<(name: string) => void>>;
  chat: ReturnType<typeof vi.fn<(message: string) => void>>;
  reveal: ReturnType<typeof vi.fn<() => void>>;
  startNewRound: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  free: ReturnType<typeof vi.fn<() => void>>;
}

const generated = vi.hoisted(() => ({
  initialize: vi.fn<(input?: unknown) => Promise<unknown>>(),
  instances: [] as RawClient[],
  nextSnapshot: undefined as ClientSnapshot | undefined,
  options: [] as ClientOptions[],
}));

vi.mock("../src/generated/ppoker-wasm/ppoker_wasm.js", () => ({
  default: generated.initialize,
  WasmPokerClient: class implements RawClient {
    snapshotValue: ClientSnapshot;
    connect = vi.fn<() => void>();
    poll = vi.fn<() => boolean>(() => false);
    snapshot = vi.fn<() => ClientSnapshot>(() => this.snapshotValue);
    vote = vi.fn<(value: string) => void>();
    retractVote = vi.fn<() => void>();
    rename = vi.fn<(name: string) => void>();
    chat = vi.fn<(message: string) => void>();
    reveal = vi.fn<() => void>();
    startNewRound = vi.fn<() => void>();
    close = vi.fn<() => void>(() => {
      this.snapshotValue = {
        ...this.snapshotValue,
        revision: this.snapshotValue.revision + 1,
        status: "closed",
      };
    });
    free = vi.fn<() => void>();

    constructor(options: ClientOptions) {
      this.snapshotValue =
        generated.nextSnapshot ?? makeSnapshot(0, "disconnected", options.name);
      generated.nextSnapshot = undefined;
      generated.options.push(options);
      generated.instances.push(this);
    }
  },
}));

const options: ClientOptions = {
  endpoint: "wss://example.test/base",
  room: "planning",
  name: "Tester",
  role: "participant",
};

type Operation =
  | readonly ["connect" | "retractVote" | "reveal" | "startNewRound"]
  | readonly ["vote" | "rename" | "chat", string];

const OPERATIONS = [
  ["connect"],
  ["vote", "8"],
  ["retractVote"],
  ["rename", "Grace"],
  ["chat", "hello"],
  ["reveal"],
  ["startNewRound"],
] as const satisfies readonly Operation[];

async function loadApi() {
  return import("../src/index.js");
}

async function createTestClient(
  snapshot: ClientSnapshot = makeSnapshot(),
  config: PokerClientConfig = {},
): Promise<{ client: PokerClient; raw: RawClient }> {
  generated.nextSnapshot = snapshot;
  const { createPokerClient } = await loadApi();
  const client = await createPokerClient(options, config);
  const raw = generated.instances.at(-1);
  if (raw === undefined)
    throw new Error("generated client was not constructed");
  return { client, raw };
}

function invoke(client: PokerClient, [method, ...arguments_]: Operation): void {
  Reflect.apply(client[method], client, arguments_);
}

function setRawSnapshot(
  raw: RawClient,
  revision: number,
  status: ClientSnapshot["status"] = "open",
): void {
  raw.snapshotValue = makeSnapshot(revision, status);
}

function queuePoll(
  raw: RawClient,
  revision: number,
  status: ClientSnapshot["status"] = "open",
): void {
  setRawSnapshot(raw, revision, status);
  raw.poll.mockReturnValueOnce(true);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  generated.initialize.mockReset();
  generated.initialize.mockResolvedValue({});
  generated.instances.length = 0;
  generated.options.length = 0;
  generated.nextSnapshot = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PokerClient creation", () => {
  it("imports without WASM or network side effects", async () => {
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", WebSocket);

    expect((await loadApi()).createPokerClient).toBeTypeOf("function");
    expect(generated.initialize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it("shares concurrent and repeated successful initialization", async () => {
    const pending = deferred();
    generated.initialize.mockReturnValueOnce(pending.promise);
    const { createPokerClient } = await loadApi();
    const first = createPokerClient(options);
    const second = createPokerClient({ ...options, name: "Concurrent" });

    expect(generated.initialize).toHaveBeenCalledOnce();
    pending.resolve();
    const clients = await Promise.all([first, second]);
    clients.push(await createPokerClient({ ...options, name: "Repeated" }));

    expect(generated.initialize).toHaveBeenCalledOnce();
    clients.forEach((client) => {
      client.close();
    });
  });

  it.each(["asynchronous", "synchronous"] as const)(
    "retries after an %s initialization failure",
    async (mode) => {
      const failure = new Error(`${mode} initialization failure`);
      if (mode === "asynchronous") {
        generated.initialize.mockRejectedValueOnce(failure);
      } else {
        generated.initialize.mockImplementationOnce(() => {
          throw failure;
        });
      }
      const { createPokerClient } = await loadApi();

      await expect(createPokerClient(options)).rejects.toBe(failure);
      const client = await createPokerClient(options);
      expect(generated.initialize).toHaveBeenCalledTimes(2);
      client.close();
    },
  );

  it("normalizes views and preserves other custom WASM inputs", async () => {
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer, 7, 13);
    const module = new WebAssembly.Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    const inputs = [
      view,
      new ArrayBuffer(8),
      new Response(new ArrayBuffer(8)),
      module,
    ] as const;

    for (const input of inputs) {
      vi.resetModules();
      const callIndex = generated.initialize.mock.calls.length;
      const { createPokerClient } = await loadApi();
      const client = await createPokerClient(options, { wasm: input });
      const initializedWith = generated.initialize.mock.calls[callIndex]?.[0];
      if (input === view) {
        if (
          typeof initializedWith !== "object" ||
          initializedWith === null ||
          !("module_or_path" in initializedWith) ||
          !(initializedWith.module_or_path instanceof Uint8Array)
        ) {
          throw new Error("generated initialization did not receive bytes");
        }
        const bytes = initializedWith.module_or_path;
        expect([bytes.buffer, bytes.byteOffset, bytes.byteLength]).toEqual([
          buffer,
          7,
          13,
        ]);
      } else {
        expect(initializedWith).toEqual({ module_or_path: input });
      }
      client.close();
    }
  });

  it("validates polling before initialization or construction", async () => {
    const { createPokerClient } = await loadApi();
    const invalidValues: unknown[] = [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER + 1,
      "50",
      null,
    ];

    for (const pollIntervalMs of invalidValues) {
      await expect(
        Reflect.apply(createPokerClient, undefined, [
          options,
          { pollIntervalMs },
        ]),
      ).rejects.toThrow(
        "pollIntervalMs must be a positive safe integer no greater than 2147483647.",
      );
    }
    expect(generated.initialize).not.toHaveBeenCalled();
    expect(generated.instances).toHaveLength(0);

    const client = await createPokerClient(options, {
      pollIntervalMs: 2_147_483_647,
    });
    client.close();
  });

  it("frees a generated client when its initial snapshot cannot be cached", async () => {
    const traversalError = new Error("snapshot traversal failed");
    const snapshot = makeSnapshot();
    Object.defineProperty(snapshot, "log", {
      enumerable: true,
      get: () => {
        throw traversalError;
      },
    });
    generated.nextSnapshot = snapshot;
    const { createPokerClient } = await loadApi();

    await expect(createPokerClient(options)).rejects.toBe(traversalError);
    expect(generated.instances[0]?.free).toHaveBeenCalledOnce();
  });
});

describe("PokerClient snapshots", () => {
  it("caches the initial snapshot without polling, connecting, or timers", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(4, "open"));

    expect(client.getSnapshot()).toBe(client.getSnapshot());
    expect(client.getSnapshot().revision).toBe(4);
    expect(raw.snapshot).toHaveBeenCalledOnce();
    expect(raw.poll).not.toHaveBeenCalled();
    expect(raw.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("deeply freezes cyclic, shared, and shallow-frozen values", async () => {
    const source = makeRichSnapshot();
    Object.defineProperty(source, "cycle", { enumerable: true, value: source });
    Object.freeze(source);
    const { client } = await createTestClient(source);
    const snapshot = client.getSnapshot();

    for (const value of [
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
      snapshot.history[0]?.deck,
      snapshot.history[0]?.ownVote,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.get(snapshot, "cycle")).toBe(snapshot);
    expect(snapshot.room?.players[0]).toBe(snapshot.history[0]?.votes[0]);
    expect(() =>
      Object.assign(snapshot.room?.players[0] ?? {}, { name: "Mutated" }),
    ).toThrow(TypeError);
    client.close();
  });

  it("freezes each incoming snapshot once and caches by revision", async () => {
    const initial = makeSnapshot();
    const initialLog = initial.log;
    const initialReads = vi.fn(() => initialLog);
    Object.defineProperty(initial, "log", {
      enumerable: true,
      get: initialReads,
    });
    const { client, raw } = await createTestClient(initial);
    const listener = vi.fn();
    client.subscribe(listener);

    expect(initialReads).toHaveBeenCalledOnce();
    expect(client.poll()).toBe(false);
    expect(raw.snapshot).toHaveBeenCalledOnce();

    const changed = makeSnapshot(1, "open");
    const changedLog = changed.log;
    const changedReads = vi.fn(() => changedLog);
    Object.defineProperty(changed, "log", {
      enumerable: true,
      get: changedReads,
    });
    raw.snapshotValue = changed;
    raw.poll.mockReturnValueOnce(true);
    expect(client.poll()).toBe(true);
    expect(changedReads).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toBe(changed);
    expect(listener).toHaveBeenCalledOnce();

    queuePoll(raw, 1);
    expect(client.poll()).toBe(false);
    expect(client.getSnapshot()).toBe(changed);
    expect(listener).toHaveBeenCalledOnce();
    client.close();
  });
});

describe("PokerClient operations and failures", () => {
  it("delegates every operation and refreshes each revision", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient();
    const listener = vi.fn();
    client.subscribe(listener);
    const advance = (): void => {
      raw.snapshotValue = makeSnapshot(raw.snapshotValue.revision + 1, "open");
    };
    for (const [method] of OPERATIONS) {
      raw[method].mockImplementation(advance);
    }

    for (const operation of OPERATIONS) {
      invoke(client, operation);
      expect(raw[operation[0]]).toHaveBeenCalledWith(...operation.slice(1));
    }
    expect(raw.snapshot).toHaveBeenCalledTimes(OPERATIONS.length + 1);
    expect(client.getSnapshot().revision).toBe(OPERATIONS.length);
    expect(listener).toHaveBeenCalledTimes(OPERATIONS.length);
    client.close();
  });

  it("keeps a successful authoritative command stable at the same revision", async () => {
    const { client, raw } = await createTestClient();
    const listener = vi.fn();
    client.subscribe(listener);
    const initial = client.getSnapshot();

    client.vote("5");

    expect(raw.snapshot).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    client.close();
  });

  it("heals cache changes before rethrowing every operation error", async () => {
    for (const operation of OPERATIONS) {
      const { client, raw } = await createTestClient();
      const listener = vi.fn();
      client.subscribe(listener);
      const method = operation[0];
      const failure = new Error(`${method} failed`);
      const status = method === "connect" ? "connecting" : "closed";
      raw[method].mockImplementationOnce(() => {
        setRawSnapshot(raw, 1, status);
        throw failure;
      });

      expect(captureError(invoke.bind(undefined, client, operation))).toBe(
        failure,
      );
      expect(client.getSnapshot()).toMatchObject({ revision: 1, status });
      expect(listener).toHaveBeenCalledOnce();
      client.close();
    }
  });

  it("preserves raw operation errors when healing or listeners also fail", async () => {
    const operationError = new Error("authoritative operation failure");
    const { client, raw } = await createTestClient();
    const first = vi.fn(() => {
      throw new Error("secondary listener failure");
    });
    const second = vi.fn();
    const unsubscribeFirst = client.subscribe(first);
    const unsubscribeSecond = client.subscribe(second);
    raw.connect.mockImplementationOnce(() => {
      setRawSnapshot(raw, 1, "closed");
      throw operationError;
    });

    expect(captureError(client.connect.bind(client))).toBe(operationError);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribeFirst();
    unsubscribeSecond();

    const other = await createTestClient();
    other.raw.vote.mockImplementationOnce(() => {
      throw operationError;
    });
    other.raw.snapshot.mockImplementationOnce(() => {
      throw new Error("secondary snapshot failure");
    });
    expect(captureError(other.client.vote.bind(other.client, "5"))).toBe(
      operationError,
    );
    other.client.close();
    client.close();
  });

  it("propagates explicit poll and snapshot failures and stops timers", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(1, "open"));
    raw.connect.mockImplementationOnce(() => {
      setRawSnapshot(raw, 2, "connecting");
    });
    client.connect();
    const initial = client.getSnapshot();
    const pollError = new Error("transport closed while polling");
    raw.poll.mockImplementationOnce(() => {
      throw pollError;
    });

    expect(captureError(client.poll.bind(client))).toBe(pollError);
    expect(client.getSnapshot()).toBe(initial);
    expect(vi.getTimerCount()).toBe(0);

    client.connect();
    const snapshotError = new Error("snapshot unavailable");
    raw.poll.mockReturnValueOnce(true);
    raw.snapshot.mockImplementationOnce(() => {
      throw snapshotError;
    });
    expect(captureError(client.poll.bind(client))).toBe(snapshotError);
    expect(client.getSnapshot()).toBe(initial);
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });
});

describe("PokerClient polling and subscriptions", () => {
  it("starts one interval on connect and drains with zero subscribers", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(), {
      pollIntervalMs: 20,
    });

    client.connect();
    client.connect();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60);
    expect(raw.poll).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before notifying a remotely closed snapshot", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(1, "open"), {
      pollIntervalMs: 10,
    });
    const timerCounts: number[] = [];
    client.subscribe(() => timerCounts.push(vi.getTimerCount()));
    raw.poll.mockImplementationOnce(() => {
      setRawSnapshot(raw, 2, "closed");
      return true;
    });
    client.connect();

    vi.advanceTimersByTime(10);
    expect(client.getSnapshot()).toMatchObject({
      revision: 2,
      status: "closed",
    });
    expect(timerCounts).toEqual([0]);
    vi.advanceTimersByTime(30);
    expect(raw.poll).toHaveBeenCalledOnce();
    client.close();
  });

  it("tracks duplicate callback registrations independently", async () => {
    const { client, raw } = await createTestClient();
    const listener = vi.fn();
    const firstUnsubscribe = client.subscribe(listener);
    const secondUnsubscribe = client.subscribe(listener);

    queuePoll(raw, 1);
    client.poll();
    expect(listener).toHaveBeenCalledTimes(2);

    firstUnsubscribe();
    firstUnsubscribe();
    queuePoll(raw, 2);
    client.poll();
    expect(listener).toHaveBeenCalledTimes(3);
    secondUnsubscribe();
    client.close();
  });

  it("uses latest state without reentrant revision scheduling", async () => {
    const { client, raw } = await createTestClient();
    raw.connect.mockImplementation(() => {
      setRawSnapshot(raw, 1);
    });
    raw.chat.mockImplementation(() => {
      setRawSnapshot(raw, 2);
    });
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    client.subscribe(() => {
      const revision = client.getSnapshot().revision;
      firstRevisions.push(revision);
      if (revision === 1) client.chat("next revision");
    });
    client.subscribe(() => secondRevisions.push(client.getSnapshot().revision));

    client.connect();
    expect(firstRevisions).toEqual([1, 2]);
    expect(secondRevisions).toEqual([2, 2]);
    client.close();
  });

  it("continues listeners after failures and ignores them during timer ticks", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(undefined, {
      pollIntervalMs: 10,
    });
    const firstError = new Error("first listener failed");
    const first = vi.fn(() => {
      throw firstError;
    });
    const second = vi.fn(() => {
      throw new Error("second listener failed");
    });
    const third = vi.fn();
    const unsubscribes = [
      client.subscribe(first),
      client.subscribe(second),
      client.subscribe(third),
    ];
    queuePoll(raw, 1);

    expect(captureError(client.poll.bind(client))).toBe(firstError);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    unsubscribes.forEach((unsubscribe) => {
      unsubscribe();
    });

    const timerListener = vi.fn(() => {
      throw new Error("timer listener failed");
    });
    const unsubscribeTimer = client.subscribe(timerListener);
    raw.poll.mockImplementation(() => {
      raw.snapshotValue = makeSnapshot(raw.snapshotValue.revision + 1, "open");
      return true;
    });
    client.connect();
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(timerListener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    unsubscribeTimer();
    client.close();
  });

  it("uses copied listeners when callbacks remove and add subscriptions", async () => {
    const { client, raw } = await createTestClient();
    const late = vi.fn();
    const removed = vi.fn();
    let unsubscribeRemoved = (): void => undefined;
    client.subscribe(() => {
      client.subscribe(late);
      unsubscribeRemoved();
    });
    unsubscribeRemoved = client.subscribe(removed);
    queuePoll(raw, 1);

    client.poll();
    expect(removed).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
    queuePoll(raw, 2);
    client.poll();
    expect(late).toHaveBeenCalledOnce();
    client.close();
  });

  it("stops ticks after timer-driven poll and snapshot failures", async () => {
    vi.useFakeTimers();
    for (const failureSource of ["poll", "snapshot"] as const) {
      const { client, raw } = await createTestClient(makeSnapshot(1, "open"), {
        pollIntervalMs: 10,
      });
      client.connect();
      if (failureSource === "poll") {
        raw.poll.mockImplementationOnce(() => {
          throw new Error("asynchronous poll failure");
        });
      } else {
        raw.poll.mockReturnValueOnce(true);
        raw.snapshot.mockImplementationOnce(() => {
          throw new Error("asynchronous snapshot failure");
        });
      }

      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(30);
      expect(raw.poll).toHaveBeenCalledOnce();
      client.close();
    }
  });

  it("propagates timer registration failure after refreshing connect", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient();
    const timerError = new Error("host timer registration failed");
    vi.spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw timerError;
    });
    raw.connect.mockImplementationOnce(() => {
      setRawSnapshot(raw, 1, "connecting");
    });

    expect(captureError(client.connect.bind(client))).toBe(timerError);
    expect(client.getSnapshot()).toMatchObject({
      revision: 1,
      status: "connecting",
    });
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });
});

describe("PokerClient close", () => {
  it("publishes once, frees once, becomes terminal, and rejects every operation", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(2, "open"), {
      pollIntervalMs: 10,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    client.connect();

    client.close();
    const finalSnapshot = client.getSnapshot();
    client.close();
    client[Symbol.dispose]();

    expect(vi.getTimerCount()).toBe(0);
    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.free).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(finalSnapshot).toMatchObject({ revision: 3, status: "closed" });
    expect(client.getSnapshot()).toBe(finalSnapshot);
    expect(client.poll()).toBe(false);
    for (const operation of OPERATIONS) {
      expect(invoke.bind(undefined, client, operation)).toThrow(
        expect.objectContaining({
          code: "Closed",
          message: "Client is closed.",
        }),
      );
    }
    const closedListener = vi.fn();
    client.subscribe(closedListener)();
    expect(closedListener).not.toHaveBeenCalled();
  });

  it("does not publish when generated close retains the revision", async () => {
    const { client, raw } = await createTestClient(makeSnapshot(2, "closed"));
    raw.close.mockImplementationOnce(() => {
      return undefined;
    });
    const listener = vi.fn();
    client.subscribe(listener);

    client.close();
    expect(listener).not.toHaveBeenCalled();
    expect(raw.free).toHaveBeenCalledOnce();
  });

  it("reports free failure unless an earlier close failure is authoritative", async () => {
    const closeError = new Error("close failed");
    const freeError = new Error("free failed");
    for (const errorDuringClose of [undefined, closeError]) {
      const { client, raw } = await createTestClient();
      if (errorDuringClose !== undefined) {
        raw.close.mockImplementationOnce(() => {
          throw errorDuringClose;
        });
      }
      raw.free.mockImplementationOnce(() => {
        throw freeError;
      });

      expect(captureError(client.close.bind(client))).toBe(
        errorDuringClose ?? freeError,
      );
      expect(client.close.bind(client)).not.toThrow();
      expect(raw.close).toHaveBeenCalledOnce();
      expect(raw.free).toHaveBeenCalledOnce();
    }
  });

  it("uses copied-listener semantics when closed while notifying", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient();
    raw.connect.mockImplementation(() => {
      setRawSnapshot(raw, 1);
    });
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    client.subscribe(() => {
      const revision = client.getSnapshot().revision;
      firstRevisions.push(revision);
      if (revision === 1) client.close();
    });
    client.subscribe(() => secondRevisions.push(client.getSnapshot().revision));

    client.connect();
    expect(firstRevisions).toEqual([1, 2]);
    expect(secondRevisions).toEqual([2, 2]);
    expect(raw.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its interval when closed inside a poll tick", async () => {
    vi.useFakeTimers();
    const { client, raw } = await createTestClient(makeSnapshot(), {
      pollIntervalMs: 10,
    });
    raw.poll.mockImplementationOnce(() => {
      client.close();
      return true;
    });
    client.connect();

    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(raw.poll).toHaveBeenCalledOnce();
    expect(raw.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

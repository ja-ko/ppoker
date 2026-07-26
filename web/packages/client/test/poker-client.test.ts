import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientOptions,
  ClientSnapshot,
  PokerClient,
  PokerClientConfig,
  RoomEvent,
} from "../src/index.js";
import { captureError, makeRichSnapshot, makeSnapshot } from "./fake-client.js";

interface RawClient {
  snapshotValue: ClientSnapshot;
  onChange: ((roomEvents: RoomEvent[]) => void) | undefined;
  connect: ReturnType<
    typeof vi.fn<(onChange: (roomEvents: RoomEvent[]) => void) => void>
  >;
  snapshot: ReturnType<typeof vi.fn<() => ClientSnapshot>>;
  vote: ReturnType<typeof vi.fn<(value: string) => void>>;
  retractVote: ReturnType<typeof vi.fn<() => void>>;
  rename: ReturnType<typeof vi.fn<(name: string) => void>>;
  chat: ReturnType<typeof vi.fn<(message: string) => void>>;
  announceAutoReveal: ReturnType<typeof vi.fn<(countdownMs: number) => void>>;
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
    onChange: ((roomEvents: RoomEvent[]) => void) | undefined;
    connect = vi.fn<(onChange: (roomEvents: RoomEvent[]) => void) => void>(
      (onChange) => {
        this.onChange = onChange;
      },
    );
    snapshot = vi.fn<() => ClientSnapshot>(() => this.snapshotValue);
    vote = vi.fn<(value: string) => void>();
    retractVote = vi.fn<() => void>();
    rename = vi.fn<(name: string) => void>();
    chat = vi.fn<(message: string) => void>();
    announceAutoReveal = vi.fn<(countdownMs: number) => void>();
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
  | readonly ["vote" | "rename" | "chat", string]
  | readonly ["announceAutoReveal", number];

const OPERATIONS = [
  ["connect"],
  ["vote", "8"],
  ["retractVote"],
  ["rename", "Grace"],
  ["chat", "hello"],
  ["announceAutoReveal", 3_000],
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
  Reflect.apply(client[method].bind(client), undefined, arguments_);
}

function setRawSnapshot(
  raw: RawClient,
  revision: number,
  status: ClientSnapshot["status"] = "open",
): void {
  raw.snapshotValue = makeSnapshot(revision, status);
}

async function publishRaw(
  raw: RawClient,
  revision: number,
  status: ClientSnapshot["status"] = "open",
): Promise<void> {
  setRawSnapshot(raw, revision, status);
  await signalRaw(raw);
}

async function signalRaw(
  raw: RawClient,
  roomEvents: RoomEvent[] = [],
): Promise<void> {
  raw.onChange?.(roomEvents);
  await Promise.resolve();
}

function autoRevealEvent(countdownMs: number): RoomEvent {
  return { kind: "autoRevealAnnounced", value: { countdownMs } };
}

function snapshotWithRoomEvents(
  revision: number,
  countdowns: readonly number[],
): ClientSnapshot {
  return {
    ...makeSnapshot(revision, "open"),
    roomEvents: countdowns.map(autoRevealEvent),
  };
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
  it("caches the initial snapshot without connecting or timers", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { client, raw } = await createTestClient(makeSnapshot(4, "open"));

    expect(client.getSnapshot()).toBe(client.getSnapshot());
    expect(client.getSnapshot().revision).toBe(4);
    expect(raw.snapshot).toHaveBeenCalledOnce();
    expect(raw.connect).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
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
      snapshot.roomEvents,
      snapshot.roomEvents[0],
      snapshot.roomEvents[0]?.value,
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
    expect(raw.snapshot).toHaveBeenCalledOnce();
    client.connect();
    expect(initialReads).toHaveBeenCalledTimes(2);
    expect(raw.snapshot).toHaveBeenCalledTimes(2);

    const changed = makeSnapshot(1, "open");
    const changedLog = changed.log;
    const changedReads = vi.fn(() => changedLog);
    Object.defineProperty(changed, "log", {
      enumerable: true,
      get: changedReads,
    });
    raw.snapshotValue = changed;
    await signalRaw(raw);
    expect(changedReads).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toBe(changed);
    expect(listener).toHaveBeenCalledOnce();

    await publishRaw(raw, 1);
    expect(client.getSnapshot()).toBe(changed);
    expect(listener).toHaveBeenCalledOnce();
    client.close();
  });
});

describe("PokerClient operations and failures", () => {
  it("delegates every operation and refreshes each revision", async () => {
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
      if (operation[0] === "connect") {
        expect(raw.connect).toHaveBeenCalledWith(expect.any(Function));
      } else {
        expect(raw[operation[0]]).toHaveBeenCalledWith(...operation.slice(1));
      }
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
});

describe("PokerClient transport notifications and subscriptions", () => {
  it("connects without timers and refreshes with zero subscribers", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { client, raw } = await createTestClient();

    client.connect();
    client.connect();
    expect(raw.connect).toHaveBeenCalledTimes(2);
    expect(raw.connect.mock.calls[0]?.[0]).toBe(raw.connect.mock.calls[1]?.[0]);
    await publishRaw(raw, 1);
    expect(client.getSnapshot().revision).toBe(1);
    expect(setInterval).not.toHaveBeenCalled();
    client.close();
  });

  it("coalesces transport notifications into one snapshot refresh", async () => {
    const { client, raw } = await createTestClient();
    client.connect();
    setRawSnapshot(raw, 2);

    raw.onChange?.([]);
    raw.onChange?.([]);
    expect(client.getSnapshot().revision).toBe(0);
    await Promise.resolve();

    expect(client.getSnapshot().revision).toBe(2);
    expect(raw.snapshot).toHaveBeenCalledTimes(3);
    client.close();
  });

  it("provides typed history and live-only filtered and all-event subscriptions", async () => {
    const { client, raw } = await createTestClient(
      snapshotWithRoomEvents(1, [1_000]),
    );
    const filtered: { countdownMs: number; revision: number }[] = [];
    const all: RoomEvent[] = [];
    const betweenNotifications = vi.fn();
    const late = vi.fn();
    const unsubscribeFiltered = client.subscribeRoomEvent(
      "autoRevealAnnounced",
      ({ countdownMs }) => {
        filtered.push({
          countdownMs,
          revision: client.getSnapshot().revision,
        });
      },
    );
    client.subscribeRoomEvents((event) => all.push(event));

    expect(client.getRoomEvents("autoRevealAnnounced")).toEqual([
      { countdownMs: 1_000 },
    ]);
    client.connect();
    await signalRaw(raw);
    expect(filtered).toEqual([]);
    expect(all).toEqual([]);

    raw.snapshotValue = snapshotWithRoomEvents(2, [1_000, 2_000, 3_000]);
    raw.onChange?.([autoRevealEvent(2_000)]);
    const unsubscribeBetween = client.subscribeRoomEvent(
      "autoRevealAnnounced",
      betweenNotifications,
    );
    raw.onChange?.([autoRevealEvent(3_000)]);
    client.subscribeRoomEvent("autoRevealAnnounced", late);
    await Promise.resolve();

    expect(filtered).toEqual([
      { countdownMs: 2_000, revision: 2 },
      { countdownMs: 3_000, revision: 2 },
    ]);
    expect(all).toEqual([autoRevealEvent(2_000), autoRevealEvent(3_000)]);
    expect(betweenNotifications).toHaveBeenCalledOnce();
    expect(betweenNotifications).toHaveBeenCalledWith({ countdownMs: 3_000 });
    expect(late).not.toHaveBeenCalled();
    expect(client.getRoomEvents("autoRevealAnnounced")).toEqual([
      { countdownMs: 1_000 },
      { countdownMs: 2_000 },
      { countdownMs: 3_000 },
    ]);
    expect(Object.isFrozen(all[0])).toBe(true);
    expect(Object.isFrozen(all[0]?.value)).toBe(true);

    unsubscribeBetween();
    unsubscribeFiltered();
    unsubscribeFiltered();
    raw.snapshotValue = snapshotWithRoomEvents(3, [1_000, 2_000, 3_000, 4_000]);
    await signalRaw(raw, [autoRevealEvent(4_000)]);
    expect(filtered).toHaveLength(2);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith({ countdownMs: 4_000 });
    client.close();
  });

  it("uses copied live-listener semantics and isolates deferred listener errors", async () => {
    const { client, raw } = await createTestClient();
    const added = vi.fn();
    const removed = vi.fn();
    const survivor = vi.fn();
    let unsubscribeRemoved = (): void => undefined;
    let addedSubscription = false;
    client.subscribeRoomEvents(() => {
      if (!addedSubscription) {
        addedSubscription = true;
        client.subscribeRoomEvents(added);
      }
      unsubscribeRemoved();
    });
    unsubscribeRemoved = client.subscribeRoomEvents(removed);
    client.subscribeRoomEvents(() => {
      throw new Error("room event listener failed");
    });
    client.subscribeRoomEvents(survivor);
    client.connect();
    raw.snapshotValue = snapshotWithRoomEvents(1, [2_000, 3_000]);

    expect(() =>
      raw.onChange?.([autoRevealEvent(2_000), autoRevealEvent(3_000)]),
    ).not.toThrow();
    await Promise.resolve();

    expect(removed).toHaveBeenCalledOnce();
    expect(added).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledTimes(2);

    raw.snapshotValue = snapshotWithRoomEvents(2, [2_000, 3_000, 4_000]);
    await signalRaw(raw, [autoRevealEvent(4_000)]);
    expect(removed).toHaveBeenCalledOnce();
    expect(added).toHaveBeenCalledOnce();
    expect(survivor).toHaveBeenCalledTimes(3);
    client.close();
  });

  it("preserves copied live dispatch when a listener closes reentrantly", async () => {
    const { client, raw } = await createTestClient();
    const first: RoomEvent[] = [];
    const second: { event: RoomEvent; status: ClientSnapshot["status"] }[] = [];
    client.subscribeRoomEvents((event) => {
      first.push(event);
      client.close();
    });
    client.subscribeRoomEvents((event) => {
      second.push({ event, status: client.getSnapshot().status });
    });
    client.connect();
    raw.snapshotValue = snapshotWithRoomEvents(1, [2_000, 3_000]);

    raw.onChange?.([autoRevealEvent(2_000), autoRevealEvent(3_000)]);
    await Promise.resolve();

    expect(first).toEqual([autoRevealEvent(2_000)]);
    expect(second).toEqual([
      { event: autoRevealEvent(2_000), status: "closed" },
    ]);
    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.free).toHaveBeenCalledOnce();
  });

  it("tracks duplicate callback registrations independently", async () => {
    const { client, raw } = await createTestClient();
    const listener = vi.fn();
    const firstUnsubscribe = client.subscribe(listener);
    const secondUnsubscribe = client.subscribe(listener);
    client.connect();

    await publishRaw(raw, 1);
    expect(listener).toHaveBeenCalledTimes(2);

    firstUnsubscribe();
    firstUnsubscribe();
    await publishRaw(raw, 2);
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

  it("continues listeners and contains failures during deferred notifications", async () => {
    const { client, raw } = await createTestClient();
    const first = vi.fn(() => {
      throw new Error("first listener failed");
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
    client.connect();
    setRawSnapshot(raw, 1);
    expect(() => raw.onChange?.([])).not.toThrow();
    await Promise.resolve();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    unsubscribes.forEach((unsubscribe) => {
      unsubscribe();
    });

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
    client.connect();
    await publishRaw(raw, 1);
    expect(removed).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
    await publishRaw(raw, 2);
    expect(late).toHaveBeenCalledOnce();
    client.close();
  });

  it("recovers after a deferred snapshot failure", async () => {
    const { client, raw } = await createTestClient();
    client.connect();
    raw.snapshot.mockImplementationOnce(() => {
      throw new Error("snapshot unavailable");
    });
    setRawSnapshot(raw, 1);

    expect(() => raw.onChange?.([])).not.toThrow();
    await Promise.resolve();
    expect(client.getSnapshot().revision).toBe(0);

    await publishRaw(raw, 2);
    expect(client.getSnapshot().revision).toBe(2);
    client.close();
  });

  it("drains a retained live delta once after a command refresh succeeds", async () => {
    const { client, raw } = await createTestClient();
    const announcements: { countdownMs: number; revision: number }[] = [];
    client.subscribeRoomEvent("autoRevealAnnounced", ({ countdownMs }) => {
      announcements.push({
        countdownMs,
        revision: client.getSnapshot().revision,
      });
    });
    client.connect();
    raw.snapshot.mockImplementationOnce(() => {
      throw new Error("snapshot unavailable");
    });
    raw.snapshotValue = snapshotWithRoomEvents(1, [3_000]);

    raw.onChange?.([autoRevealEvent(3_000)]);
    await Promise.resolve();
    expect(client.getSnapshot().revision).toBe(0);
    expect(announcements).toEqual([]);

    client.chat("refresh snapshot");
    expect(client.getSnapshot().revision).toBe(1);
    expect(announcements).toEqual([{ countdownMs: 3_000, revision: 1 }]);

    client.chat("do not replay");
    await Promise.resolve();
    expect(announcements).toHaveLength(1);
    client.close();
  });
});

describe("PokerClient close", () => {
  it("publishes once, frees once, becomes terminal, and rejects every operation", async () => {
    const { client, raw } = await createTestClient(makeSnapshot(2, "open"));
    const listener = vi.fn();
    const roomEventListener = vi.fn();
    client.subscribe(listener);
    client.subscribeRoomEvents(roomEventListener);
    client.connect();
    const onChange = raw.onChange;

    client.close();
    const finalSnapshot = client.getSnapshot();
    client.close();
    client[Symbol.dispose]();

    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.free).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(roomEventListener).not.toHaveBeenCalled();
    expect(finalSnapshot).toMatchObject({ revision: 3, status: "closed" });
    expect(client.getSnapshot()).toBe(finalSnapshot);
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
    client.subscribeRoomEvents(roomEventListener)();
    onChange?.([autoRevealEvent(3_000)]);
    await Promise.resolve();
    expect(roomEventListener).not.toHaveBeenCalled();
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
  });

  it("ignores a transport refresh already scheduled when closed", async () => {
    const { client, raw } = await createTestClient();
    client.connect();
    const onChange = raw.onChange;
    setRawSnapshot(raw, 1);
    onChange?.([]);

    client.close();
    const snapshotCalls = raw.snapshot.mock.calls.length;
    await Promise.resolve();
    onChange?.([]);
    await Promise.resolve();

    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.snapshot).toHaveBeenCalledTimes(snapshotCalls);
  });
});

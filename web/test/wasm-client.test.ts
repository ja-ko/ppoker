import { waitFor } from "@testing-library/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOptions, ClientSnapshot } from "../src/wasm-client.js";

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

const generated = vi.hoisted(() => {
  const instances: RawClient[] = [];
  const options: ClientOptions[] = [];
  return {
    initialize: vi.fn<(input: unknown) => Promise<unknown>>(),
    instances,
    options,
  };
});

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
      this.snapshotValue = initialSnapshot(options.name);
      generated.options.push(options);
      generated.instances.push(this);
    }
  },
}));

const participantOptions: ClientOptions = {
  endpoint: "wss://example.test/base",
  room: "planning",
  name: "Participant",
  role: "participant",
};

function initialSnapshot(name: string): ClientSnapshot {
  return {
    revision: 0,
    status: "disconnected",
    terminalError: null,
    room: null,
    localName: name,
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
  };
}

function deferred(): { promise: Promise<unknown>; resolve: () => void } {
  let finish = (): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: finish };
}

async function loadApi() {
  return import("../src/index.js");
}

function rawClient(index = 0): RawClient {
  const client = generated.instances[index];
  if (client === undefined) {
    throw new Error(`raw client ${index.toString()} was not constructed`);
  }
  return client;
}

beforeEach(() => {
  vi.resetModules();
  generated.initialize.mockReset();
  generated.initialize.mockResolvedValue({});
  generated.instances.length = 0;
  generated.options.length = 0;
});

describe("WASM initialization", () => {
  it("imports without initialization, fetch, or socket side effects", async () => {
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", WebSocket);

    const api = await loadApi();

    expect(api.initializePpokerWasm).toBeTypeOf("function");
    expect(generated.initialize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it("shares concurrent and repeated successful initialization", async () => {
    const pending = deferred();
    generated.initialize.mockReturnValueOnce(pending.promise);
    const { initializePpokerWasm } = await loadApi();

    const first = initializePpokerWasm();
    const concurrent = initializePpokerWasm();

    expect(concurrent).toBe(first);
    await waitFor(() => {
      expect(generated.initialize).toHaveBeenCalledOnce();
    });
    pending.resolve();
    await first;
    expect(initializePpokerWasm()).toBe(first);
    expect(generated.initialize).toHaveBeenCalledOnce();
  });

  it("clears a failed attempt so the next call retries", async () => {
    const failure = new Error("invalid wasm bytes");
    generated.initialize.mockRejectedValueOnce(failure);
    const { initializePpokerWasm } = await loadApi();

    await expect(initializePpokerWasm()).rejects.toBe(failure);
    const retry = initializePpokerWasm(new Uint8Array());

    await expect(retry).resolves.toBeUndefined();
    expect(generated.initialize).toHaveBeenCalledTimes(2);
  });

  it("normalizes a ranged DataView to the same Uint8Array byte range", async () => {
    const { initializePpokerWasm } = await loadApi();
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer, 7, 13);

    await initializePpokerWasm(view);

    const call = generated.initialize.mock.calls[0];
    if (call === undefined) {
      throw new Error("generated initialization was not called");
    }
    const argument = call[0];
    if (
      typeof argument !== "object" ||
      argument === null ||
      !("module_or_path" in argument) ||
      !(argument.module_or_path instanceof Uint8Array)
    ) {
      throw new Error("generated initialization did not receive bytes");
    }
    expect(argument.module_or_path.buffer).toBe(buffer);
    expect(argument.module_or_path.byteOffset).toBe(7);
    expect(argument.module_or_path.byteLength).toBe(13);
  });

  it("preserves ArrayBuffer, Response, and WebAssembly.Module inputs", async () => {
    const moduleBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const inputs = [
      new ArrayBuffer(8),
      new Response(new ArrayBuffer(8)),
      new WebAssembly.Module(moduleBytes),
    ] satisfies (ArrayBuffer | Response | WebAssembly.Module)[];

    for (const input of inputs) {
      vi.resetModules();
      const callIndex = generated.initialize.mock.calls.length;
      const { initializePpokerWasm } = await loadApi();
      await initializePpokerWasm(input);
      expect(generated.initialize.mock.calls[callIndex]?.[0]).toEqual({
        module_or_path: input,
      });
    }
  });

  it("throws a structured NotReady error before initialization", async () => {
    const { WasmPokerClient } = await loadApi();

    expect(() => new WasmPokerClient(participantOptions)).toThrow(
      expect.objectContaining({
        code: "NotReady",
        message: "WASM is not initialized. Await initializePpokerWasm() first.",
      }),
    );
    expect(generated.instances).toHaveLength(0);
  });
});

describe("WasmPokerClient", () => {
  it("constructs synchronously for both typed roles without connecting", async () => {
    const { WasmPokerClient, initializePpokerWasm } = await loadApi();
    await initializePpokerWasm();
    const spectatorOptions: ClientOptions = {
      ...participantOptions,
      name: "Spectator",
      role: "spectator",
    };

    const participant = new WasmPokerClient(participantOptions);
    const spectator = new WasmPokerClient(spectatorOptions);

    expect(generated.options).toEqual([participantOptions, spectatorOptions]);
    expect(rawClient(0).connect).not.toHaveBeenCalled();
    expect(rawClient(1).connect).not.toHaveBeenCalled();
    expect(participant.snapshot()).toEqual(initialSnapshot("Participant"));
    expect(spectator.snapshot()).toEqual(initialSnapshot("Spectator"));
    expect(Object.isFrozen(participant.snapshot())).toBe(true);
    expect(Object.isFrozen(participant.snapshot().currentRound)).toBe(true);
    expect(Object.isFrozen(participant.snapshot().activity)).toBe(true);
  });

  it("delegates connect, poll, snapshots, and every command", async () => {
    const { WasmPokerClient, initializePpokerWasm } = await loadApi();
    await initializePpokerWasm();
    const client = new WasmPokerClient(participantOptions);
    const raw = rawClient();
    raw.poll.mockReturnValueOnce(true);
    raw.snapshotValue = {
      ...raw.snapshotValue,
      revision: 4,
      status: "open",
    };

    client.connect();
    expect(client.poll()).toBe(true);
    expect(client.snapshot()).toEqual(raw.snapshotValue);
    client.vote("5");
    client.retractVote();
    client.rename("New name");
    client.chat("hello");
    client.reveal();
    client.startNewRound();

    expect(raw.connect).toHaveBeenCalledOnce();
    expect(raw.poll).toHaveBeenCalledOnce();
    expect(raw.vote).toHaveBeenCalledWith("5");
    expect(raw.retractVote).toHaveBeenCalledOnce();
    expect(raw.rename).toHaveBeenCalledWith("New name");
    expect(raw.chat).toHaveBeenCalledWith("hello");
    expect(raw.reveal).toHaveBeenCalledOnce();
    expect(raw.startNewRound).toHaveBeenCalledOnce();
  });

  it("closes and frees exactly once while retaining the final snapshot", async () => {
    const { WasmPokerClient, initializePpokerWasm } = await loadApi();
    await initializePpokerWasm();
    const client = new WasmPokerClient(participantOptions);
    const raw = rawClient();

    client.close();
    const finalSnapshot = client.snapshot();
    client.close();
    client[Symbol.dispose]();

    expect(raw.close).toHaveBeenCalledOnce();
    expect(raw.free).toHaveBeenCalledOnce();
    expect(finalSnapshot).toMatchObject({ revision: 1, status: "closed" });
    expect(client.snapshot()).toBe(finalSnapshot);
    expect(client.poll()).toBe(false);
  });

  it("frees once and becomes terminal even if generated close throws", async () => {
    const { WasmPokerClient, initializePpokerWasm } = await loadApi();
    await initializePpokerWasm();
    const client = new WasmPokerClient(participantOptions);
    const raw = rawClient();
    const failure = new Error("generated close failed");
    raw.close.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => {
      client.close();
    }).toThrow(failure);
    expect(raw.free).toHaveBeenCalledOnce();
    expect(client.snapshot()).toEqual(initialSnapshot("Participant"));
    expect(() => {
      client.close();
    }).not.toThrow();
  });

  it("returns structured Closed errors for connect and all commands", async () => {
    const { WasmPokerClient, initializePpokerWasm } = await loadApi();
    await initializePpokerWasm();
    const client = new WasmPokerClient(participantOptions);
    client[Symbol.dispose]();

    const actions: (() => void)[] = [
      () => {
        client.connect();
      },
      () => {
        client.vote("5");
      },
      () => {
        client.retractVote();
      },
      () => {
        client.rename("Closed");
      },
      () => {
        client.chat("Closed");
      },
      () => {
        client.reveal();
      },
      () => {
        client.startNewRound();
      },
    ];
    for (const action of actions) {
      expect(action).toThrow(
        expect.objectContaining({
          code: "Closed",
          message: "Client is closed.",
        }),
      );
    }
  });

  it("does not expose generated lifecycle or ABI members", async () => {
    const api = await loadApi();
    await api.initializePpokerWasm();
    const client = new api.WasmPokerClient(participantOptions);

    expect(api).not.toHaveProperty("default");
    expect(api).not.toHaveProperty("initSync");
    expect(client).not.toHaveProperty("free");
    expect(client).not.toHaveProperty("__wbg_ptr");
  });
});

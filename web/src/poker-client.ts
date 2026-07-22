/// <reference lib="esnext.disposable" preserve="true" />

import initializeGeneratedWasm, {
  WasmPokerClient as GeneratedWasmPokerClient,
} from "./generated/ppoker-wasm/ppoker_wasm.js";
import type {
  ClientError as GeneratedClientError,
  ClientErrorCode,
  ClientOptions as GeneratedClientOptions,
  ClientSnapshot as GeneratedClientSnapshot,
  ConnectionRole,
  ConnectionStatus,
  GamePhase,
  HistoryEntry as GeneratedHistoryEntry,
  InvalidOptionsDetails as GeneratedInvalidOptionsDetails,
  LogEntry as GeneratedLogEntry,
  LogLevel,
  LogSource,
  Player as GeneratedPlayer,
  Room as GeneratedRoom,
  UserType,
  Vote as GeneratedVote,
  VoteData as GeneratedVoteData,
} from "./generated/ppoker-wasm/ppoker_wasm.js";

type Immutable<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly Immutable<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
      : Value;

export type ClientError = Immutable<GeneratedClientError>;
export type ClientOptions = Immutable<GeneratedClientOptions>;
export type ClientSnapshot = Immutable<GeneratedClientSnapshot>;
export type HistoryEntry = Immutable<GeneratedHistoryEntry>;
export type InvalidOptionsDetails = Immutable<GeneratedInvalidOptionsDetails>;
export type LogEntry = Immutable<GeneratedLogEntry>;
export type Player = Immutable<GeneratedPlayer>;
export type Room = Immutable<GeneratedRoom>;
export type Vote = Immutable<GeneratedVote>;
export type VoteData = Immutable<GeneratedVoteData>;
export type {
  ClientErrorCode,
  ConnectionRole,
  ConnectionStatus,
  GamePhase,
  LogLevel,
  LogSource,
  UserType,
};

export type PpokerWasmInitInput =
  ArrayBuffer | ArrayBufferView<ArrayBuffer> | Response | WebAssembly.Module;

export interface PokerClientConfig {
  readonly pollIntervalMs?: number;
  readonly wasm?: PpokerWasmInitInput;
}

export interface PokerClientError extends Error {
  readonly code: ClientErrorCode | "InvalidOptions";
  readonly details?: InvalidOptionsDetails;
}

export interface PokerClient {
  readonly getSnapshot: () => ClientSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  connect(): void;
  poll(): boolean;
  vote(value: string): void;
  retractVote(): void;
  rename(name: string): void;
  chat(message: string): void;
  reveal(): void;
  startNewRound(): void;
  close(): void;
  [Symbol.dispose](): void;
}

const CLOSED_MESSAGE = "Client is closed.";
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 2_147_483_647;
const POLL_INTERVAL_ERROR =
  "pollIntervalMs must be a positive safe integer no greater than 2147483647.";

let initialization: Promise<void> | undefined;

export async function createPokerClient(
  options: ClientOptions,
  config: PokerClientConfig = {},
): Promise<PokerClient> {
  const pollIntervalMs = validatePollInterval(config.pollIntervalMs);
  await initializePpokerWasm(config.wasm);

  const generatedClient = new GeneratedWasmPokerClient(options);
  try {
    return new AuthoredPokerClient(generatedClient, pollIntervalMs);
  } catch (error: unknown) {
    generatedClient.free();
    throw error;
  }
}

class AuthoredPokerClient implements PokerClient {
  readonly #listeners = new Set<() => void>();
  readonly #pollIntervalMs: number;
  #client: GeneratedWasmPokerClient | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #snapshot: ClientSnapshot;

  constructor(client: GeneratedWasmPokerClient, pollIntervalMs: number) {
    this.#client = client;
    this.#pollIntervalMs = pollIntervalMs;
    this.#snapshot = freezeSnapshot(client.snapshot());
  }

  readonly getSnapshot = (): ClientSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#client === undefined) {
      return () => undefined;
    }
    const subscription = (): void => {
      listener();
    };
    this.#listeners.add(subscription);
    return () => {
      this.#listeners.delete(subscription);
    };
  };

  connect(): void {
    const client = this.#openClient();
    try {
      client.connect();
      this.#startPolling();
    } catch (error: unknown) {
      this.#refreshAfterFailure(error);
    }
    this.#refresh();
  }

  poll(): boolean {
    const client = this.#client;
    if (client === undefined) {
      return false;
    }

    let changed: boolean;
    try {
      changed = client.poll();
    } catch (error: unknown) {
      this.#stopPolling();
      throw error;
    }
    return changed ? this.#refresh() : false;
  }

  vote(value: string): void {
    this.#run((client) => {
      client.vote(value);
    });
  }

  retractVote(): void {
    this.#run((client) => {
      client.retractVote();
    });
  }

  rename(name: string): void {
    this.#run((client) => {
      client.rename(name);
    });
  }

  chat(message: string): void {
    this.#run((client) => {
      client.chat(message);
    });
  }

  reveal(): void {
    this.#run((client) => {
      client.reveal();
    });
  }

  startNewRound(): void {
    this.#run((client) => {
      client.startNewRound();
    });
  }

  close(): void {
    const client = this.#client;
    if (client === undefined) {
      return;
    }

    this.#client = undefined;
    this.#stopPolling();
    let operationError: unknown;
    let failed = false;
    try {
      client.close();
      const nextSnapshot = freezeSnapshot(client.snapshot());
      if (nextSnapshot.revision !== this.#snapshot.revision) {
        this.#snapshot = nextSnapshot;
        this.#notifyListeners();
      }
    } catch (error: unknown) {
      operationError = error;
      failed = true;
    }
    try {
      client.free();
    } catch (error: unknown) {
      if (!failed) {
        operationError = error;
        failed = true;
      }
    } finally {
      this.#listeners.clear();
    }
    if (failed) {
      throw operationError;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #notifyListeners(): void {
    let firstError: unknown;
    let failed = false;
    for (const listener of new Set(this.#listeners)) {
      try {
        listener();
      } catch (error: unknown) {
        if (!failed) {
          firstError = error;
          failed = true;
        }
      }
    }
    if (failed) {
      throw firstError;
    }
  }

  #openClient(): GeneratedWasmPokerClient {
    if (this.#client === undefined) {
      throw clientError("Closed", CLOSED_MESSAGE);
    }
    return this.#client;
  }

  #pollFromInterval = (): void => {
    try {
      this.poll();
    } catch {
      // Raw poll and snapshot failures stop polling at their source. Listener
      // failures have no asynchronous recipient and do not affect transport.
    }
  };

  #refresh(): boolean {
    const client = this.#client;
    if (client === undefined) {
      return false;
    }

    let nextSnapshot: ClientSnapshot;
    try {
      nextSnapshot = freezeSnapshot(client.snapshot());
    } catch (error: unknown) {
      this.#stopPolling();
      throw error;
    }
    if (nextSnapshot.revision === this.#snapshot.revision) {
      return false;
    }

    this.#snapshot = nextSnapshot;
    if (nextSnapshot.status === "closed") {
      this.#stopPolling();
    }
    this.#notifyListeners();
    return true;
  }

  #refreshAfterFailure(operationError: unknown): never {
    try {
      this.#refresh();
    } catch {
      // The delegated operation's original error is authoritative.
    }
    throw operationError;
  }

  #run(operation: (client: GeneratedWasmPokerClient) => void): void {
    const client = this.#openClient();
    try {
      operation(client);
    } catch (error: unknown) {
      this.#refreshAfterFailure(error);
    }
    this.#refresh();
  }

  #startPolling(): void {
    if (this.#interval === undefined) {
      this.#interval = setInterval(
        this.#pollFromInterval,
        this.#pollIntervalMs,
      );
    }
  }

  #stopPolling(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
  }
}

function clientError(code: ClientErrorCode, message: string): PokerClientError {
  return Object.assign(new Error(message), { code });
}

function freezeSnapshot(snapshot: GeneratedClientSnapshot): ClientSnapshot {
  freezeValue(snapshot, new WeakSet<object>());
  return snapshot;
}

function freezeValue(value: unknown, visited: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const nested of Object.values(value)) {
    freezeValue(nested, visited);
  }
  Object.freeze(value);
}

function initializePpokerWasm(input?: PpokerWasmInitInput): Promise<void> {
  if (initialization !== undefined) {
    return initialization;
  }

  const generatedInitialization =
    input === undefined
      ? initializeGeneratedWasm()
      : initializeGeneratedWasm({ module_or_path: normalizeWasmInput(input) });
  const attempt = generatedInitialization.then(() => undefined);
  initialization = attempt.catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

function normalizeWasmInput(
  input: PpokerWasmInitInput,
): ArrayBuffer | Uint8Array<ArrayBuffer> | Response | WebAssembly.Module {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}

function validatePollInterval(value: unknown): number {
  const pollIntervalMs = value === undefined ? DEFAULT_POLL_INTERVAL_MS : value;
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isFinite(pollIntervalMs) ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new TypeError(POLL_INTERVAL_ERROR);
  }
  return pollIntervalMs;
}

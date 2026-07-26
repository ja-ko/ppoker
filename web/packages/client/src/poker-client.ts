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
  RoomEvent as GeneratedRoomEvent,
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
export type RoomEvent = Immutable<GeneratedRoomEvent>;
export type RoomEventKind = RoomEvent["kind"];
export type RoomEventPayload<Kind extends RoomEventKind> = Extract<
  RoomEvent,
  { readonly kind: Kind }
>["value"];
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
  readonly wasm?: PpokerWasmInitInput;
}

export interface PokerClientError extends Error {
  readonly code: ClientErrorCode | "InvalidOptions";
  readonly details?: InvalidOptionsDetails;
}

export interface PokerClient {
  readonly getSnapshot: () => ClientSnapshot;
  readonly getRoomEvents: <Kind extends RoomEventKind>(
    kind: Kind,
  ) => readonly RoomEventPayload<Kind>[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly subscribeRoomEvent: <Kind extends RoomEventKind>(
    kind: Kind,
    listener: (payload: RoomEventPayload<Kind>) => void,
  ) => () => void;
  readonly subscribeRoomEvents: (
    listener: (event: RoomEvent) => void,
  ) => () => void;
  connect(): void;
  vote(value: string): void;
  retractVote(): void;
  rename(name: string): void;
  chat(message: string): void;
  announceAutoReveal(countdownMs: number): void;
  reveal(): void;
  startNewRound(): void;
  close(): void;
  [Symbol.dispose](): void;
}

const CLOSED_MESSAGE = "Client is closed.";

let initialization: Promise<void> | undefined;

interface QueuedRoomEvent {
  readonly index: number;
  readonly event: RoomEvent;
}

interface RoomEventListenerSubscription {
  readonly startIndex: number;
  readonly listener: (event: RoomEvent) => void;
}

export async function createPokerClient(
  options: ClientOptions,
  config: PokerClientConfig = {},
): Promise<PokerClient> {
  await initializePpokerWasm(config.wasm);

  const generatedClient = new GeneratedWasmPokerClient(options);
  try {
    return new AuthoredPokerClient(generatedClient);
  } catch (error: unknown) {
    generatedClient.free();
    throw error;
  }
}

class AuthoredPokerClient implements PokerClient {
  readonly #listeners = new Set<() => void>();
  readonly #roomEventListeners = new Set<RoomEventListenerSubscription>();
  readonly #onTransportChange: (roomEvents: GeneratedRoomEvent[]) => void;
  #client: GeneratedWasmPokerClient | undefined;
  #pendingRoomEvents: QueuedRoomEvent[] = [];
  #receivedRoomEventCount = 0;
  #refreshScheduled = false;
  #snapshot: ClientSnapshot;

  constructor(client: GeneratedWasmPokerClient) {
    this.#client = client;
    this.#snapshot = freezeSnapshot(client.snapshot());
    const target = new WeakRef(this);
    this.#onTransportChange = (roomEvents): void => {
      const client = target.deref();
      if (client !== undefined) {
        client.#receiveTransportChange(roomEvents);
      }
    };
  }

  readonly getSnapshot = (): ClientSnapshot => this.#snapshot;

  readonly getRoomEvents = <Kind extends RoomEventKind>(
    kind: Kind,
  ): readonly RoomEventPayload<Kind>[] => {
    const payloads: RoomEventPayload<Kind>[] = [];
    for (const event of this.#snapshot.roomEvents) {
      if (roomEventHasKind(event, kind)) {
        payloads.push(event.value);
      }
    }
    return payloads;
  };

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

  readonly subscribeRoomEvent = <Kind extends RoomEventKind>(
    kind: Kind,
    listener: (payload: RoomEventPayload<Kind>) => void,
  ): (() => void) =>
    this.#addRoomEventListener((event) => {
      if (roomEventHasKind(event, kind)) {
        listener(event.value);
      }
    });

  readonly subscribeRoomEvents = (
    listener: (event: RoomEvent) => void,
  ): (() => void) => this.#addRoomEventListener(listener);

  connect(): void {
    const client = this.#openClient();
    try {
      client.connect(this.#onTransportChange);
    } catch (error: unknown) {
      this.#refreshAfterFailure(error);
    }
    this.#refresh();
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

  announceAutoReveal(countdownMs: number): void {
    this.#run((client) => {
      client.announceAutoReveal(countdownMs);
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
    this.#refreshScheduled = false;
    this.#pendingRoomEvents = [];
    let operationError: unknown;
    let failed = false;
    try {
      client.close();
      const nextSnapshot = freezeSnapshot(client.snapshot());
      this.#publishSnapshot(nextSnapshot, []);
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
      this.#roomEventListeners.clear();
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

  #addRoomEventListener(listener: (event: RoomEvent) => void): () => void {
    if (this.#client === undefined) {
      return () => undefined;
    }
    const subscription = {
      startIndex: this.#receivedRoomEventCount,
      listener,
    };
    this.#roomEventListeners.add(subscription);
    return () => {
      this.#roomEventListeners.delete(subscription);
    };
  }

  #notifyRoomEventListeners(events: readonly QueuedRoomEvent[]): void {
    let firstError: unknown;
    let failed = false;
    for (const event of events) {
      for (const subscription of new Set(this.#roomEventListeners)) {
        if (event.index < subscription.startIndex) {
          continue;
        }
        try {
          subscription.listener(event.event);
        } catch (error: unknown) {
          if (!failed) {
            firstError = error;
            failed = true;
          }
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

  #refreshFromTransport = (): void => {
    this.#refreshScheduled = false;
    try {
      this.#refresh();
    } catch {
      // Deferred snapshot and listener failures have no synchronous recipient.
    }
  };

  #receiveTransportChange(roomEvents: GeneratedRoomEvent[]): void {
    if (this.#client === undefined) {
      return;
    }
    for (const roomEvent of roomEvents) {
      this.#pendingRoomEvents.push({
        index: this.#receivedRoomEventCount,
        event: freezeRoomEvent(roomEvent),
      });
      this.#receivedRoomEventCount += 1;
    }
    this.#scheduleRefresh();
  }

  #scheduleRefresh(): void {
    if (this.#client === undefined || this.#refreshScheduled) {
      return;
    }
    this.#refreshScheduled = true;
    queueMicrotask(this.#refreshFromTransport);
  }

  #refresh(): boolean {
    const pendingCount = this.#pendingRoomEvents.length;
    const nextSnapshot = this.#readSnapshot();
    if (nextSnapshot === undefined) {
      return false;
    }
    const roomEvents = this.#pendingRoomEvents.splice(0, pendingCount);
    return this.#publishSnapshot(nextSnapshot, roomEvents);
  }

  #readSnapshot(): ClientSnapshot | undefined {
    const client = this.#client;
    return client === undefined ? undefined : freezeSnapshot(client.snapshot());
  }

  #publishSnapshot(
    nextSnapshot: ClientSnapshot,
    roomEvents: readonly QueuedRoomEvent[],
  ): boolean {
    const changed = nextSnapshot.revision !== this.#snapshot.revision;
    if (changed) {
      this.#snapshot = nextSnapshot;
    }

    let firstError: unknown;
    let failed = false;
    if (changed) {
      try {
        this.#notifyListeners();
      } catch (error: unknown) {
        firstError = error;
        failed = true;
      }
    }
    try {
      this.#notifyRoomEventListeners(roomEvents);
    } catch (error: unknown) {
      if (!failed) {
        firstError = error;
        failed = true;
      }
    }
    if (failed) {
      throw firstError;
    }
    return changed;
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
}

function clientError(code: ClientErrorCode, message: string): PokerClientError {
  return Object.assign(new Error(message), { code });
}

function freezeSnapshot(snapshot: GeneratedClientSnapshot): ClientSnapshot {
  freezeValue(snapshot, new WeakSet<object>());
  return snapshot;
}

function freezeRoomEvent(event: GeneratedRoomEvent): RoomEvent {
  freezeValue(event, new WeakSet<object>());
  return event;
}

function roomEventHasKind<Kind extends RoomEventKind>(
  event: RoomEvent,
  kind: Kind,
): event is Extract<RoomEvent, { readonly kind: Kind }> {
  return event.kind.localeCompare(kind) === 0;
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

import initializeGeneratedWasm, {
  WasmPokerClient as GeneratedWasmPokerClient,
} from "./generated/ppoker-wasm/ppoker_wasm.js";
import type {
  ActivityLevel,
  ActivitySnapshot,
  ActivitySource,
  ClientErrorSnapshot,
  ClientOptions,
  ClientRole,
  ClientSnapshot,
  CurrentRoundSnapshot,
  ErrorCode,
  ErrorDetails,
  HistorySnapshot,
  PhaseSnapshot,
  PlayerRole,
  PlayerSnapshot,
  RoomSnapshot,
  SnapshotStatus,
  StatisticsSnapshot,
  VoteSnapshot,
  VoteValueSnapshot,
} from "./generated/ppoker-wasm/ppoker_wasm.js";

export type {
  ActivityLevel,
  ActivitySnapshot,
  ActivitySource,
  ClientErrorSnapshot,
  ClientOptions,
  ClientRole,
  ClientSnapshot,
  CurrentRoundSnapshot,
  ErrorCode,
  ErrorDetails,
  HistorySnapshot,
  PhaseSnapshot,
  PlayerRole,
  PlayerSnapshot,
  RoomSnapshot,
  SnapshotStatus,
  StatisticsSnapshot,
  VoteSnapshot,
  VoteValueSnapshot,
};

export type PpokerWasmInitInput =
  ArrayBuffer | ArrayBufferView<ArrayBuffer> | Response | WebAssembly.Module;

export interface PpokerClientError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
}

let initialization: Promise<void> | undefined;
let initialized = false;

export function initializePpokerWasm(
  input?: PpokerWasmInitInput,
): Promise<void> {
  if (initialization !== undefined) {
    return initialization;
  }

  const generatedInitialization =
    input === undefined
      ? initializeGeneratedWasm()
      : initializeGeneratedWasm({ module_or_path: normalizeWasmInput(input) });
  const attempt = generatedInitialization.then(() => {
    initialized = true;
  });
  initialization = attempt.catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export class WasmPokerClient {
  #client: GeneratedWasmPokerClient | undefined;
  #lastSnapshot: ClientSnapshot;

  constructor(options: ClientOptions) {
    if (!initialized) {
      throw clientError(
        "NotReady",
        "WASM is not initialized. Await initializePpokerWasm() first.",
      );
    }

    this.#client = new GeneratedWasmPokerClient(options);
    this.#lastSnapshot = this.#client.snapshot();
  }

  connect(): void {
    this.#openClient().connect();
  }

  poll(): boolean {
    return this.#client?.poll() ?? false;
  }

  snapshot(): ClientSnapshot {
    if (this.#client !== undefined) {
      this.#lastSnapshot = this.#client.snapshot();
    }
    return this.#lastSnapshot;
  }

  vote(value: string): void {
    this.#openClient().vote(value);
  }

  retractVote(): void {
    this.#openClient().retractVote();
  }

  rename(name: string): void {
    this.#openClient().rename(name);
  }

  chat(message: string): void {
    this.#openClient().chat(message);
  }

  reveal(): void {
    this.#openClient().reveal();
  }

  startNewRound(): void {
    this.#openClient().startNewRound();
  }

  close(): void {
    const client = this.#client;
    if (client === undefined) {
      return;
    }

    this.#client = undefined;
    try {
      client.close();
      this.#lastSnapshot = client.snapshot();
    } finally {
      client.free();
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #openClient(): GeneratedWasmPokerClient {
    if (this.#client === undefined) {
      throw clientError("Closed", "Client is closed.");
    }
    return this.#client;
  }
}

function clientError(code: ErrorCode, message: string): PpokerClientError {
  return Object.assign(new Error(message), { code });
}

function normalizeWasmInput(
  input: PpokerWasmInitInput,
): ArrayBuffer | Uint8Array<ArrayBuffer> | Response | WebAssembly.Module {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}

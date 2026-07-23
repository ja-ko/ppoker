import { vi } from "vitest";
import type {
  ClientSnapshot,
  ConnectionStatus,
  PokerClient,
} from "../src/index.js";

export function makeSnapshot(
  revision = 0,
  status: ConnectionStatus = "disconnected",
  localName = "Tester",
): ClientSnapshot {
  return {
    revision,
    status,
    terminalError: null,
    room: null,
    localName,
    localVote: null,
    log: [],
    roundNumber: 0,
    history: [],
    average: null,
  };
}

export function makeRichSnapshot(revision = 3): ClientSnapshot {
  const player = {
    name: "Ada",
    vote: {
      state: "revealed" as const,
      value: { kind: "number" as const, value: 5 },
    },
    isYou: true,
    userType: "player" as const,
  };
  return {
    revision,
    status: "closed",
    terminalError: {
      code: "Transport",
      message: "connection lost",
    },
    room: {
      name: "planning",
      deck: ["3", "5"],
      phase: "revealed",
      players: [player],
    },
    localName: "Ada",
    localVote: { kind: "number", value: 5 },
    log: [
      {
        timestampMs: 12,
        level: "error",
        message: "connection lost",
        source: "client",
        serverIndex: null,
      },
    ],
    roundNumber: 2,
    history: [
      {
        roundNumber: 1,
        average: 5,
        votes: [player],
        deck: ["3", "5"],
        ownVote: { kind: "number", value: 5 },
      },
    ],
    average: 5,
  };
}

export function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("operation did not throw");
}

export function createFakeClient(initial = makeSnapshot()) {
  const state: { value: ClientSnapshot } = { value: initial };
  const listeners = new Set<() => void>();
  const client = {
    getSnapshot: vi.fn<() => ClientSnapshot>(() => state.value),
    subscribe: vi.fn<(listener: () => void) => () => void>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    connect: vi.fn<() => void>(),
    vote: vi.fn<(value: string) => void>(),
    retractVote: vi.fn<() => void>(),
    rename: vi.fn<(name: string) => void>(),
    chat: vi.fn<(message: string) => void>(),
    reveal: vi.fn<() => void>(),
    startNewRound: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    [Symbol.dispose]: vi.fn<() => void>(),
  } satisfies PokerClient;
  const publish = (snapshot: ClientSnapshot): void => {
    state.value = snapshot;
    for (const listener of new Set(listeners)) {
      listener();
    }
  };
  const activeListenerCount = (): number => listeners.size;
  return { activeListenerCount, client, publish };
}

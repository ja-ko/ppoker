import { vi } from "vitest";
import type { ClientSnapshot, ConnectionStatus } from "../src/wasm-client.js";
import type { PokerClientPort } from "../src/index.js";

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
    roundStartedAtMs: null,
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
    roundStartedAtMs: 4,
    history: [
      {
        roundNumber: 1,
        average: 5,
        lengthMs: 8,
        votes: [player],
        deck: ["3", "5"],
        ownVote: { kind: "number", value: 5 },
      },
    ],
    average: 5,
  };
}

export function createFakeClient(initial = makeSnapshot()) {
  const state: { value: ClientSnapshot } = { value: initial };
  const client = {
    connect: vi.fn<() => void>(),
    poll: vi.fn<() => boolean>(() => false),
    snapshot: vi.fn<() => ClientSnapshot>(() => state.value),
    vote: vi.fn<(value: string) => void>(),
    retractVote: vi.fn<() => void>(),
    rename: vi.fn<(name: string) => void>(),
    chat: vi.fn<(message: string) => void>(),
    reveal: vi.fn<() => void>(),
    startNewRound: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
  } satisfies PokerClientPort;
  return { client, state };
}

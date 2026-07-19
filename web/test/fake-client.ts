import { vi } from "vitest";
import type { ClientSnapshot, SnapshotStatus } from "../src/wasm-client.js";
import type { PokerClientPort } from "../src/client-store.js";

export function makeSnapshot(
  revision = 0,
  status: SnapshotStatus = "disconnected",
  localName = "Tester",
): ClientSnapshot {
  return {
    revision,
    status,
    terminalError: null,
    room: null,
    localName,
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

export function makeRichSnapshot(revision = 3): ClientSnapshot {
  const player = {
    name: "Ada",
    vote: {
      state: "revealed" as const,
      value: { kind: "number" as const, value: 5 },
    },
    isYou: true,
    role: "participant" as const,
  };
  return {
    revision,
    status: "closed",
    terminalError: {
      code: "Transport",
      message: "connection lost",
      details: {
        field: "socket",
        reason: "closed",
      },
    },
    room: {
      name: "planning",
      deck: ["3", "5"],
      phase: "revealed",
      players: [player],
    },
    localName: "Ada",
    localVote: { kind: "number", value: 5 },
    activity: [
      {
        timestampMs: 12,
        level: "error",
        message: "connection lost",
        source: "client",
        serverIndex: null,
      },
    ],
    currentRound: {
      number: 2,
      startedAtMs: 4,
    },
    history: [
      {
        roundNumber: 1,
        average: 5,
        durationMs: 8,
        votes: [player],
        deck: ["3", "5"],
        localVote: { kind: "number", value: 5 },
      },
    ],
    statistics: {
      average: 5,
    },
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

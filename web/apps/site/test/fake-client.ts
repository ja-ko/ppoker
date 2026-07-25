import type {
  ClientSnapshot,
  ConnectionStatus,
  PokerClient,
} from "@ppoker/web-client";
import { vi } from "vitest";

export function makeSnapshot(
  overrides: Partial<ClientSnapshot> = {},
): ClientSnapshot {
  return {
    average: null,
    history: [],
    localName: "Planning Poker Billboard",
    localVote: null,
    log: [],
    revision: 0,
    room: null,
    roundNumber: 0,
    status: "disconnected",
    terminalError: null,
    ...overrides,
  };
}

export function snapshotWithStatus(
  status: ConnectionStatus,
  revision = 1,
): ClientSnapshot {
  return makeSnapshot({ revision, status });
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
  return { client, publish };
}

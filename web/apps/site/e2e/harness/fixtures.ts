import type {
  ClientSnapshot,
  HistoryEntry,
  Player,
  Vote,
} from "@ppoker/web-client";

export const fixtureNames = [
  "playing",
  "revealed",
  "next-playing",
  "overflow",
  "connecting",
  "no-room",
  "terminal-error",
] as const;

export type SnapshotFixtureName = (typeof fixtureNames)[number];

const deck = ["1", "2", "3", "5", "8", "13", "?", "Break"] as const;
const names = [
  "Ada",
  "Ben",
  "Cleo",
  "Diego",
  "Erin",
  "Farah",
  "Gus",
  "Hana",
  "Ivo",
  "Jules",
] as const;
const revealedValues = [5, 3, 5, 8, 5, 3, 8, 5, "?", "Break"] as const;

export function fixtureSnapshot(name: SnapshotFixtureName): ClientSnapshot {
  switch (name) {
    case "playing":
      return playingSnapshot();
    case "revealed":
      return revealedSnapshot();
    case "next-playing":
      return nextPlayingSnapshot();
    case "overflow":
      return overflowSnapshot();
    case "connecting":
      return baseSnapshot({ revision: 20, status: "connecting" });
    case "no-room":
      return baseSnapshot({ revision: 21, status: "open" });
    case "terminal-error":
      return baseSnapshot({
        revision: 22,
        status: "closed",
        terminalError: {
          code: "Transport",
          message: "E2E fixture transport ended",
        },
      });
  }
}

export function isSnapshotFixtureName(
  value: string | null,
): value is SnapshotFixtureName {
  return value !== null && fixtureNames.some((name) => name === value);
}

function playingSnapshot(): ClientSnapshot {
  return baseSnapshot({
    history: completedHistory(8),
    revision: 9,
    room: {
      deck,
      name: "Authoritative E2E Room",
      phase: "playing",
      players: playingPlayers(),
    },
    roundNumber: 9,
    status: "open",
  });
}

function revealedSnapshot(): ClientSnapshot {
  return baseSnapshot({
    average: 5.3,
    history: completedHistory(9),
    revision: 10,
    room: {
      deck,
      name: "Authoritative E2E Room",
      phase: "revealed",
      players: revealedPlayers(),
    },
    roundNumber: 9,
    status: "open",
  });
}

function nextPlayingSnapshot(): ClientSnapshot {
  return baseSnapshot({
    history: completedHistory(9),
    revision: 11,
    room: {
      deck,
      name: "Authoritative E2E Room",
      phase: "playing",
      players: playingPlayers(),
    },
    roundNumber: 10,
    status: "open",
  });
}

function overflowSnapshot(): ClientSnapshot {
  const players = Array.from({ length: 18 }, (_, index) =>
    player(
      `Player ${(index + 1).toString()}`,
      index % 3 === 0 ? missingVote() : hiddenVote(),
    ),
  );
  return baseSnapshot({
    history: completedHistory(8),
    revision: 12,
    room: { deck, name: "overflow-room", phase: "playing", players },
    roundNumber: 9,
    status: "open",
  });
}

function baseSnapshot(overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
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

function completedHistory(lastRound: number): readonly HistoryEntry[] {
  const averages = new Map([
    [4, 3],
    [5, 5.6],
    [6, 8],
    [7, 3.8],
    [8, 5.3],
    [9, 5.3],
  ]);
  return Array.from({ length: lastRound - 3 }, (_, index) => {
    const roundNumber = index + 4;
    return {
      average: averages.get(roundNumber) ?? 5,
      deck,
      ownVote: null,
      roundNumber,
      votes: revealedPlayers(),
    } satisfies HistoryEntry;
  });
}

function playingPlayers(): readonly Player[] {
  return names.map((name, index) =>
    player(name, index < 6 ? hiddenVote() : missingVote()),
  );
}

function revealedPlayers(): readonly Player[] {
  return names.map((name, index) => {
    const value = revealedValues[index];
    if (value === undefined) {
      throw new Error("Revealed fixture vote missing.");
    }
    return player(
      name,
      typeof value === "number"
        ? revealedNumber(value)
        : revealedSpecial(value),
    );
  });
}

function player(name: string, vote: Vote): Player {
  return { isYou: false, name, userType: "player", vote };
}

function missingVote(): Vote {
  return { state: "missing" };
}

function hiddenVote(): Vote {
  return { state: "hidden" };
}

function revealedNumber(value: number): Vote {
  return { state: "revealed", value: { kind: "number", value } };
}

function revealedSpecial(value: string): Vote {
  return { state: "revealed", value: { kind: "special", value } };
}

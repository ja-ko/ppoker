import type {
  ClientSnapshot,
  HistoryEntry,
  Player,
  Vote,
} from "@ppoker/web-client";

export const fixtureNames = [
  "playing",
  "dense-playing",
  "first-playing",
  "revealed",
  "dense-revealed",
  "sorted-revealed",
  "next-playing",
  "overflow",
  "connecting",
  "no-room",
  "closed",
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
const denseNames = [...names, "Kai", "Lina"] as const;
const denseRevealedValues = [
  ...revealedValues,
  13,
  2,
] as const satisfies readonly (number | string)[];

export function fixtureSnapshot(name: SnapshotFixtureName): ClientSnapshot {
  switch (name) {
    case "playing":
      return playingSnapshot();
    case "dense-playing":
      return densePlayingSnapshot();
    case "first-playing":
      return firstPlayingSnapshot();
    case "revealed":
      return revealedSnapshot();
    case "dense-revealed":
      return denseRevealedSnapshot();
    case "sorted-revealed":
      return sortedRevealedSnapshot();
    case "next-playing":
      return nextPlayingSnapshot();
    case "overflow":
      return overflowSnapshot();
    case "connecting":
      return baseSnapshot({ revision: 20, status: "connecting" });
    case "no-room":
      return baseSnapshot({ revision: 21, status: "open" });
    case "closed":
      return baseSnapshot({ revision: 22, status: "closed" });
    case "terminal-error":
      return baseSnapshot({
        revision: 23,
        status: "closed",
        terminalError: {
          code: "Transport",
          message: "E2E fixture transport ended",
        },
      });
  }
}

function firstPlayingSnapshot(): ClientSnapshot {
  return baseSnapshot({
    revision: 1,
    room: {
      deck,
      name: "First Round Room",
      phase: "playing",
      players: names.slice(0, 1).map((name) => player(name, missingVote())),
    },
    roundNumber: 1,
    status: "open",
  });
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

function densePlayingSnapshot(): ClientSnapshot {
  return baseSnapshot({
    history: completedHistory(8),
    revision: 14,
    room: {
      deck,
      name: "Dense E2E Room",
      phase: "playing",
      players: denseNames.map((name, index) =>
        player(name, index < 7 ? hiddenVote() : missingVote()),
      ),
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

function denseRevealedSnapshot(): ClientSnapshot {
  return baseSnapshot({
    average: 5.8,
    history: completedHistory(8),
    revision: 15,
    room: {
      deck,
      name: "Dense E2E Room",
      phase: "revealed",
      players: denseNames.map((name, index) => {
        const value = denseRevealedValues[index];
        if (value === undefined) {
          throw new Error("Dense revealed fixture vote missing.");
        }
        return player(
          name,
          typeof value === "number"
            ? revealedNumber(value)
            : revealedSpecial(value),
        );
      }),
    },
    roundNumber: 9,
    status: "open",
  });
}

function sortedRevealedSnapshot(): ClientSnapshot {
  const votes = [
    player("Missing", missingVote()),
    player("Same", revealedNumber(8)),
    player("Unknown zebra", revealedSpecial("Zebra")),
    player("Zoe", revealedNumber(3)),
    player("Question", revealedSpecial("?")),
    player("Same", revealedNumber(8)),
    player("Unknown alpha", revealedSpecial("Alpha")),
    player("Five", revealedNumber(5)),
    player("Ada", revealedNumber(3)),
    player("Break", revealedSpecial("Break")),
  ];
  const immutableFinal = {
    average: 5.4,
    deck: ["1", "Break", "?"],
    ownVote: null,
    roundNumber: 7,
    votes,
  } satisfies HistoryEntry;
  return baseSnapshot({
    average: 1,
    history: [immutableFinal],
    revision: 13,
    room: {
      deck: ["1", "?", "Break"],
      name: "Sorted Reveal Room",
      phase: "revealed",
      players: [player("Mutable", revealedNumber(1))],
    },
    roundNumber: 7,
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

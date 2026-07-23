import type {
  ClientSnapshot,
  HistoryEntry,
  Player,
  Vote,
} from "@ppoker/web-client";
import { describe, expect, it } from "vitest";

import {
  historyObservationKey,
  type ObserverTimingSnapshot,
} from "../src/observer-timing";
import { deriveScoreboardModel } from "../src/scoreboard-adapter";
import { makeSnapshot } from "./fake-client";

const timing = {
  historyAges: new Map([
    [historyObservationKey(1, 0), "3 min ago"],
    [historyObservationKey(2, 1), "1 min ago"],
    [historyObservationKey(3, 2), "just now"],
  ]),
  phaseElapsed: "01:23",
} satisfies ObserverTimingSnapshot;

describe("snapshot scoreboard adapter", () => {
  it("derives playing players, response state, previous round and newest-first history", () => {
    const firstHistory = historyEntry(1, [player("Old", revealedNumber(3))]);
    const secondHistory = historyEntry(2, [
      player("Ada", revealedNumber(5)),
      player("Observer", missingVote, "spectator"),
      player("Ben", revealedSpecial("?")),
    ]);
    const snapshot = openSnapshot({
      history: [firstHistory, secondHistory],
      room: {
        deck: ["1", "3", "5", "?"],
        name: "Authoritative Planning Room",
        phase: "playing",
        players: [
          player("Observer", missingVote, "spectator"),
          player("Ada", hiddenVote),
          player("Ada", missingVote),
          player("Ben", revealedSpecial("?")),
        ],
      },
      roundNumber: 3,
    });

    const model = deriveScoreboardModel(snapshot, "planning", timing);
    expect(model?.phase).toBe("playing");
    if (model?.phase !== "playing") {
      throw new Error("expected playing model");
    }
    expect(model.observed).toBe("01:23");
    expect(model.displayTitle).toBe("Planning Poker Room");
    expect(model.roomName).toBe("Authoritative Planning Room");
    expect(model.participants).toEqual([
      { id: "player:Ada:1", locked: true, name: "Ada" },
      { id: "player:Ada:2", locked: false, name: "Ada" },
      { id: "player:Ben:1", locked: true, name: "Ben" },
    ]);
    expect(model.history.map(({ round }) => round)).toEqual([2, 1]);
    expect(model.previousRound).toMatchObject({
      average: "4.5",
      numericResponses: 1,
      observedAt: "1 min ago",
      responseCount: 2,
      round: 2,
      specialResponses: 1,
    });
  });

  it("derives the current revealed result and removes its matching history rail entry", () => {
    const immutableFinal = historyEntry(
      2,
      [
        player("Ada", revealedNumber(5)),
        player("Ben", revealedSpecial("Break")),
        player("Cleo", missingVote),
      ],
      ["1", "5", "?", "Break"],
      4.5,
    );
    const snapshot = openSnapshot({
      average: 8,
      history: [historyEntry(1, []), immutableFinal],
      room: {
        deck: ["8"],
        name: "planning",
        phase: "revealed",
        players: [player("Mutable room player", revealedNumber(8))],
      },
      roundNumber: 2,
    });

    const model = deriveScoreboardModel(snapshot, "planning", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase !== "revealed") {
      throw new Error("expected revealed model");
    }
    expect(model.history.map(({ round }) => round)).toEqual([1]);
    expect(model.participants).toEqual([
      { id: "player:Ada:1", name: "Ada", vote: "5" },
      {
        id: "player:Ben:1",
        name: "Ben",
        special: true,
        vote: "Break",
      },
      { id: "player:Cleo:1", name: "Cleo", special: true, vote: "-" },
    ]);
    expect(model.result).toMatchObject({
      average: "4.5",
      leadingCount: 1,
      numericResponses: 1,
      responseCount: 2,
      round: 2,
      specialResponses: 1,
    });
    expect(
      model.result.distribution.map(({ count, label }) => [label, count]),
    ).toEqual([
      ["1", 0],
      ["5", 1],
      ["?", 0],
      ["Break", 1],
    ]);
  });

  it("renders an initial revealed room without fabricated matching history", () => {
    const snapshot = openSnapshot({
      average: null,
      history: [],
      room: {
        deck: [],
        name: "fresh-room",
        phase: "revealed",
        players: [player("Ada", revealedSpecial("XL"))],
      },
      roundNumber: 1,
    });

    const model = deriveScoreboardModel(snapshot, "fresh-room", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase !== "revealed") {
      throw new Error("expected revealed model");
    }
    expect(model.history).toEqual([]);
    expect(model.result.average).toBe("-");
    expect(model.result.distribution).toMatchObject([
      { count: 1, label: "XL", leader: true, special: true },
    ]);
  });

  it("handles empty decks, no players and unknown room state", () => {
    const empty = openSnapshot({
      room: {
        deck: [],
        name: "empty",
        phase: "revealed",
        players: [player("Observer", missingVote, "spectator")],
      },
    });
    const model = deriveScoreboardModel(empty, "empty", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase === "revealed") {
      expect(model.participants).toEqual([]);
      expect(model.result.distribution).toEqual([]);
      expect(model.result.responseCount).toBe(0);
    }
    expect(
      deriveScoreboardModel(makeSnapshot({ status: "open" }), "empty", timing),
    ).toBeNull();
    expect(
      deriveScoreboardModel(
        openSnapshot({
          room: { deck: [], name: "empty", phase: "unknown", players: [] },
        }),
        "empty",
        timing,
      ),
    ).toBeNull();
  });

  it("normalizes deck labels with core-compatible u8 parsing", () => {
    const snapshot = openSnapshot({
      average: 5,
      room: {
        deck: ["05", "300"],
        name: "normalized",
        phase: "revealed",
        players: [
          player("Ada", revealedNumber(5)),
          player("Ben", revealedSpecial("300")),
        ],
      },
      roundNumber: 1,
    });

    const model = deriveScoreboardModel(snapshot, "normalized", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase === "revealed") {
      expect(model.result.distribution).toEqual([
        expect.objectContaining({ count: 1, label: "05" }),
        expect.objectContaining({ count: 1, label: "300", special: true }),
      ]);
      expect(model.result.distribution).toHaveLength(2);
    }
  });

  it("matches a leading-plus deck label to its numeric vote", () => {
    const snapshot = openSnapshot({
      average: 5,
      room: {
        deck: ["+5"],
        name: "leading-plus",
        phase: "revealed",
        players: [player("Ada", revealedNumber(5))],
      },
      roundNumber: 1,
    });

    const model = deriveScoreboardModel(snapshot, "leading-plus", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase === "revealed") {
      expect(model.result.distribution).toEqual([
        expect.objectContaining({ count: 1, label: "+5" }),
      ]);
      expect(model.result.distribution).toHaveLength(1);
    }
  });

  it("keeps leading-plus u8 boundaries numeric and invalid boundaries special", () => {
    const snapshot = openSnapshot({
      average: 127.5,
      room: {
        deck: ["+0", "+255", "+256", "-0", "-1"],
        name: "boundaries",
        phase: "revealed",
        players: [
          player("Zero", revealedNumber(0)),
          player("Maximum", revealedNumber(255)),
          player("Overflow", revealedSpecial("+256")),
          player("Negative zero", revealedSpecial("-0")),
          player("Negative", revealedSpecial("-1")),
        ],
      },
      roundNumber: 1,
    });

    const model = deriveScoreboardModel(snapshot, "boundaries", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase === "revealed") {
      expect(
        model.result.distribution.map(({ count, label, special }) => [
          label,
          count,
          special ?? false,
        ]),
      ).toEqual([
        ["+0", 1, false],
        ["+255", 1, false],
        ["+256", 1, true],
        ["-0", 1, true],
        ["-1", 1, true],
      ]);
    }
  });

  it("keeps duplicate round occurrences unique while featuring only the newest match", () => {
    const snapshot = openSnapshot({
      history: [
        historyEntry(2, [player("Earlier", revealedNumber(3))]),
        historyEntry(2, [player("Featured", revealedNumber(5))]),
      ],
      room: {
        deck: ["8"],
        name: "duplicates",
        phase: "revealed",
        players: [player("Mutable", revealedNumber(8))],
      },
      roundNumber: 2,
    });

    const model = deriveScoreboardModel(snapshot, "duplicates", timing);
    expect(model?.phase).toBe("revealed");
    if (model?.phase === "revealed") {
      expect(model.participants[0]?.name).toBe("Featured");
      expect(model.history).toEqual([
        expect.objectContaining({ id: "round:2:source:0", round: 2 }),
      ]);
    }
  });
});

const missingVote = { state: "missing" } as const satisfies Vote;
const hiddenVote = { state: "hidden" } as const satisfies Vote;

function revealedNumber(value: number): Vote {
  return { state: "revealed", value: { kind: "number", value } };
}

function revealedSpecial(value: string): Vote {
  return { state: "revealed", value: { kind: "special", value } };
}

function player(
  name: string,
  vote: Vote,
  userType: Player["userType"] = "player",
): Player {
  return { isYou: false, name, userType, vote };
}

function historyEntry(
  roundNumber: number,
  votes: readonly Player[],
  deck: readonly string[] = ["1", "3", "5", "?"],
  average: number | null = votes.length === 0 ? null : 4.5,
): HistoryEntry {
  return {
    average,
    deck,
    ownVote: null,
    roundNumber,
    votes,
  };
}

function openSnapshot(overrides: Partial<ClientSnapshot> = {}): ClientSnapshot {
  return makeSnapshot({
    revision: 1,
    status: "open",
    ...overrides,
  });
}

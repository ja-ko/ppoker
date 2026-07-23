import type {
  ClientSnapshot,
  HistoryEntry as ClientHistoryEntry,
  Player,
  VoteData,
} from "@ppoker/web-client";

import { BILLBOARD_TITLE_PLACEHOLDER } from "./config";
import {
  historyObservationKey,
  type ObserverTimingSnapshot,
} from "./observer-timing";
import type {
  BroadcastScoreboardModel,
  DistributionVote,
  HistoryEntry,
  PlayingParticipant,
  RevealedParticipant,
  RoundResult,
} from "./scoreboard-model";

export function deriveScoreboardModel(
  snapshot: ClientSnapshot,
  roomCode: string,
  timing: ObserverTimingSnapshot,
): BroadcastScoreboardModel | null {
  const room = snapshot.room;
  if (room === null || room.phase === "unknown") {
    return null;
  }

  const roomPlayers = room.players.filter(
    (player) => player.userType === "player",
  );
  const indexedHistory = snapshot.history.map((entry, sourceIndex) => ({
    entry,
    sourceIndex,
  }));
  const newestHistory = [...indexedHistory].reverse();
  const featuredCurrent =
    room.phase === "revealed"
      ? newestHistory.find(
          ({ entry }) => entry.roundNumber === snapshot.roundNumber,
        )
      : undefined;
  const railHistory =
    featuredCurrent === undefined
      ? newestHistory
      : newestHistory.filter(
          ({ sourceIndex }) => sourceIndex !== featuredCurrent.sourceIndex,
        );
  const base = {
    displayTitle: BILLBOARD_TITLE_PLACEHOLDER,
    history: railHistory.map((entry) => historySummary(entry, timing)),
    observed: timing.phaseElapsed,
    roomCode,
    roomName: room.name,
    round: snapshot.roundNumber,
  };

  if (room.phase === "playing") {
    return {
      ...base,
      participants: playingParticipants(room.players),
      phase: "playing",
      ...(newestHistory[0] === undefined
        ? {}
        : { previousRound: roundResult(newestHistory[0], timing) }),
    };
  }

  const finalPlayers = featuredCurrent?.entry.votes ?? room.players;
  const finalDeck = featuredCurrent?.entry.deck ?? room.deck;
  return {
    ...base,
    participants: revealedParticipants(finalPlayers, finalDeck),
    phase: "revealed",
    result:
      featuredCurrent === undefined
        ? resultFromRoom(snapshot, roomPlayers)
        : roundResult(featuredCurrent, timing),
  };
}

interface IndexedHistoryEntry {
  readonly entry: ClientHistoryEntry;
  readonly sourceIndex: number;
}

function playingParticipants(
  players: readonly Player[],
): readonly PlayingParticipant[] {
  return withViewIds(players).map(({ id, player }) => ({
    id,
    locked: player.vote.state !== "missing",
    name: player.name,
  }));
}

function revealedParticipants(
  players: readonly Player[],
  deck: readonly string[],
): readonly RevealedParticipant[] {
  const specialDeckOrder = new Map<string, number>();
  deck.forEach((label, index) => {
    const key = deckCardKey(label);
    if (key.startsWith("special:") && !specialDeckOrder.has(key)) {
      specialDeckOrder.set(key, index);
    }
  });

  return withViewIds(players)
    .toSorted((left, right) => {
      const leftVote = left.player.vote;
      const rightVote = right.player.vote;
      const leftRank = voteSortRank(leftVote, specialDeckOrder);
      const rightRank = voteSortRank(rightVote, specialDeckOrder);
      if (leftRank.group !== rightRank.group) {
        return leftRank.group - rightRank.group;
      }
      if (leftRank.order !== rightRank.order) {
        return leftRank.order - rightRank.order;
      }
      const valueOrder = compareText(leftRank.value, rightRank.value);
      if (valueOrder !== 0) {
        return valueOrder;
      }
      const nameOrder = compareText(left.player.name, right.player.name);
      return nameOrder === 0 ? left.sourceIndex - right.sourceIndex : nameOrder;
    })
    .map(({ id, player }) => {
      if (player.vote.state !== "revealed") {
        return { id, name: player.name, special: true, vote: "-" };
      }
      const vote = player.vote.value;
      return vote.kind === "special"
        ? { id, name: player.name, special: true, vote: vote.value }
        : { id, name: player.name, vote: vote.value.toString() };
    });
}

interface VoteSortRank {
  readonly group: number;
  readonly order: number;
  readonly value: string;
}

function voteSortRank(
  vote: Player["vote"],
  specialDeckOrder: ReadonlyMap<string, number>,
): VoteSortRank {
  if (vote.state !== "revealed") {
    return { group: 3, order: 0, value: "" };
  }
  if (vote.value.kind === "number") {
    return { group: 0, order: vote.value.value, value: "" };
  }
  const deckOrder = specialDeckOrder.get(`special:${vote.value.value}`);
  return deckOrder === undefined
    ? { group: 2, order: 0, value: vote.value.value }
    : { group: 1, order: deckOrder, value: vote.value.value };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Core has no player IDs. Name plus duplicate occurrence is deterministic for
// one ordered snapshot, but intentionally does not claim server identity.
function withViewIds(players: readonly Player[]): readonly {
  readonly id: string;
  readonly player: Player;
  readonly sourceIndex: number;
}[] {
  const occurrences = new Map<string, number>();
  return players.flatMap((player, sourceIndex) => {
    if (player.userType !== "player") {
      return [];
    }
    const occurrence = (occurrences.get(player.name) ?? 0) + 1;
    occurrences.set(player.name, occurrence);
    return [
      {
        id: `player:${encodeURIComponent(player.name)}:${occurrence.toString()}`,
        player,
        sourceIndex,
      },
    ];
  });
}

function resultFromRoom(
  snapshot: ClientSnapshot,
  players: readonly Player[],
): RoundResult {
  const room = snapshot.room;
  if (room === null) {
    throw new Error("Room result requires room state.");
  }
  return resultFromVotes(
    snapshot.roundNumber,
    snapshot.average,
    room.deck,
    players,
    "just now",
  );
}

function roundResult(
  indexedEntry: IndexedHistoryEntry,
  timing: ObserverTimingSnapshot,
): RoundResult {
  const { entry, sourceIndex } = indexedEntry;
  const players = entry.votes.filter((player) => player.userType === "player");
  return resultFromVotes(
    entry.roundNumber,
    entry.average,
    entry.deck,
    players,
    timing.historyAges.get(
      historyObservationKey(entry.roundNumber, sourceIndex),
    ) ?? "just now",
  );
}

function resultFromVotes(
  round: number,
  average: number | null,
  deck: readonly string[],
  players: readonly Player[],
  observedAt: string,
): RoundResult {
  const revealedVotes = players.flatMap((player) =>
    player.vote.state === "revealed" ? [player.vote.value] : [],
  );
  const distribution = voteDistribution(deck, revealedVotes);
  return {
    average: formatAverage(average),
    distribution,
    leadingCount: Math.max(0, ...distribution.map((item) => item.count)),
    numericResponses: revealedVotes.filter((vote) => vote.kind === "number")
      .length,
    observedAt,
    responseCount: revealedVotes.length,
    round,
    specialResponses: revealedVotes.filter((vote) => vote.kind === "special")
      .length,
  };
}

function voteDistribution(
  deck: readonly string[],
  votes: readonly VoteData[],
): readonly DistributionVote[] {
  const counts = new Map<string, number>();
  for (const vote of votes) {
    const key = voteKey(vote);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const cards: { readonly key: string; readonly label: string }[] = [];
  const seen = new Set<string>();
  for (const label of deck) {
    const key = deckCardKey(label);
    if (!seen.has(key)) {
      seen.add(key);
      cards.push({ key, label });
    }
  }
  for (const vote of votes) {
    const key = voteKey(vote);
    if (!seen.has(key)) {
      seen.add(key);
      cards.push({ key, label: voteLabel(vote) });
    }
  }
  const leadingCount = Math.max(0, ...counts.values());
  return cards.map(({ key, label }, index) => {
    const count = counts.get(key) ?? 0;
    const item = {
      count,
      id: `card:${index.toString()}:${encodeURIComponent(label)}`,
      label,
    };
    const leader = leadingCount > 0 && count === leadingCount;
    const special = key.startsWith("special:");
    return {
      ...item,
      ...(leader ? { leader: true } : {}),
      ...(special ? { special: true } : {}),
    };
  });
}

function historySummary(
  indexedEntry: IndexedHistoryEntry,
  timing: ObserverTimingSnapshot,
): HistoryEntry {
  const { entry, sourceIndex } = indexedEntry;
  const timingKey = historyObservationKey(entry.roundNumber, sourceIndex);
  return {
    age: timing.historyAges.get(timingKey) ?? "just now",
    average: formatAverage(entry.average),
    id: `round:${entry.roundNumber.toString()}:source:${sourceIndex.toString()}`,
    round: entry.roundNumber,
  };
}

function voteLabel(vote: VoteData): string {
  return vote.kind === "number" ? vote.value.toString() : vote.value;
}

function voteKey(vote: VoteData): string {
  return vote.kind === "number"
    ? `number:${vote.value.toString()}`
    : `special:${vote.value}`;
}

function deckCardKey(label: string): string {
  if (/^\+?\d+$/u.test(label)) {
    const value = Number(label);
    if (Number.isInteger(value) && value >= 0 && value <= 255) {
      return `number:${value.toString()}`;
    }
  }
  return `special:${label}`;
}

function formatAverage(average: number | null): string {
  return average === null ? "-" : average.toFixed(1);
}

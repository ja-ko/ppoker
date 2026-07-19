import type {
  ClientError,
  ClientOptions,
  ClientSnapshot,
  HistoryEntry,
  LogEntry,
  Player,
  Room,
  Vote,
  VoteData,
} from "../src/generated/ppoker-wasm/ppoker_wasm.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;

function notAny<Value>(value: IsAny<Value> extends true ? never : Value): void {
  void value;
}

function inspectVoteData(value: VoteData): number | string {
  return value.kind === "number" ? value.value : value.value;
}

function inspectVote(vote: Vote): number | string | null {
  switch (vote.state) {
    case "missing":
    case "hidden":
      return null;
    case "revealed":
      return inspectVoteData(vote.value);
    default: {
      const exhaustive: never = vote;
      return exhaustive;
    }
  }
}

function inspectPlayer(player: Player): void {
  notAny(player.name);
  notAny(player.vote);
  notAny(player.isYou);
  notAny(player.userType);
  void inspectVote(player.vote);
}

function inspectRoom(room: Room): void {
  notAny(room.name);
  notAny(room.deck);
  notAny(room.phase);
  room.players.forEach(inspectPlayer);
}

function inspectHistory(entry: HistoryEntry): void {
  const average: number | null = entry.average;
  const ownVote: VoteData | null = entry.ownVote;
  notAny(entry.lengthMs);
  entry.votes.forEach(inspectPlayer);
  void average;
  if (ownVote !== null) inspectVoteData(ownVote);
}

function inspectLog(entry: LogEntry): void {
  const serverIndex: number | null = entry.serverIndex;
  notAny(entry.timestampMs);
  notAny(entry.level);
  notAny(entry.source);
  void serverIndex;
}

function inspectError(error: ClientError): void {
  notAny(error.code);
  notAny(error.message);
}

function inspectSnapshot(snapshot: ClientSnapshot): void {
  notAny(snapshot.revision);
  notAny(snapshot.status);
  notAny(snapshot.roundStartedAtMs);
  if (snapshot.terminalError !== null) inspectError(snapshot.terminalError);
  if (snapshot.room !== null) inspectRoom(snapshot.room);
  if (snapshot.localVote !== null) inspectVoteData(snapshot.localVote);
  snapshot.log.forEach(inspectLog);
  snapshot.history.forEach(inspectHistory);
}

declare const options: ClientOptions;
declare const snapshot: ClientSnapshot;
notAny(options.role);
inspectSnapshot(snapshot);

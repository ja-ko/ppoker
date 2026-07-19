import type {
  ActivitySnapshot,
  ClientErrorSnapshot,
  ClientOptions,
  ClientSnapshot,
  HistorySnapshot,
  PlayerSnapshot,
  RoomSnapshot,
  VoteSnapshot,
  VoteValueSnapshot,
} from "../src/generated/ppoker-wasm/ppoker_wasm.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;

function notAny<Value>(value: IsAny<Value> extends true ? never : Value): void {
  void value;
}

function inspectVoteValue(value: VoteValueSnapshot): number | string {
  switch (value.kind) {
    case "number":
      return value.value;
    case "special":
      return value.value;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function inspectVote(vote: VoteSnapshot): number | string | null {
  switch (vote.state) {
    case "missing":
    case "hidden":
      return null;
    case "revealed":
      return inspectVoteValue(vote.value);
    default: {
      const exhaustive: never = vote;
      return exhaustive;
    }
  }
}

function inspectPlayer(player: PlayerSnapshot): void {
  notAny(player.name);
  notAny(player.vote);
  notAny(player.isYou);
  notAny(player.role);
  void inspectVote(player.vote);
}

function inspectRoom(room: RoomSnapshot): void {
  notAny(room.name);
  notAny(room.deck);
  notAny(room.phase);
  notAny(room.players);
  room.players.forEach(inspectPlayer);
}

function inspectHistory(history: HistorySnapshot): void {
  notAny(history.roundNumber);
  notAny(history.average);
  notAny(history.durationMs);
  notAny(history.votes);
  notAny(history.deck);
  notAny(history.localVote);
  history.votes.forEach(inspectPlayer);
  if (history.localVote !== null) inspectVoteValue(history.localVote);
}

function inspectActivity(activity: ActivitySnapshot): void {
  notAny(activity.timestampMs);
  notAny(activity.level);
  notAny(activity.message);
  notAny(activity.source);
  notAny(activity.serverIndex);
}

function inspectError(error: ClientErrorSnapshot): void {
  notAny(error.code);
  notAny(error.message);
  notAny(error.details);
  void error.details?.field;
  void error.details?.reason;
}

function inspectSnapshot(snapshot: ClientSnapshot): void {
  notAny(snapshot.revision);
  notAny(snapshot.status);
  notAny(snapshot.terminalError);
  notAny(snapshot.room);
  notAny(snapshot.localName);
  notAny(snapshot.localVote);
  notAny(snapshot.activity);
  notAny(snapshot.currentRound);
  notAny(snapshot.history);
  notAny(snapshot.statistics);
  if (snapshot.terminalError !== null) inspectError(snapshot.terminalError);
  if (snapshot.room !== null) inspectRoom(snapshot.room);
  if (snapshot.localVote !== null) inspectVoteValue(snapshot.localVote);
  snapshot.activity.forEach(inspectActivity);
  snapshot.history.forEach(inspectHistory);
}

declare const options: ClientOptions;
declare const snapshot: ClientSnapshot;
notAny(options.endpoint);
notAny(options.room);
notAny(options.name);
notAny(options.role);
inspectSnapshot(snapshot);

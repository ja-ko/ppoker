import {
  WasmPokerClient,
  createPokerClientStore,
  initializePpokerWasm,
  type ActivityLevel,
  type ActivitySnapshot,
  type ActivitySource,
  type ClientErrorSnapshot,
  type ClientOptions,
  type ClientRole,
  type ClientSnapshot,
  type DeepReadonly,
  type ErrorCode,
  type HistorySnapshot,
  type PhaseSnapshot,
  type PlayerRole,
  type PlayerSnapshot,
  type PokerClientPort,
  type PokerClientSnapshot,
  type PokerClientStore,
  type RoomSnapshot,
  type SnapshotStatus,
  type VoteSnapshot,
  type VoteValueSnapshot,
} from "../src/index.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Assert<Value extends true> = Value;
type NotAny<Value> = IsAny<Value> extends false ? true : false;
type HasNoRawFree = Assert<"free" extends keyof WasmPokerClient ? false : true>;

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
  const role: PlayerRole = player.role;
  notAny(player.name);
  notAny(player.vote);
  notAny(player.isYou);
  notAny(player.role);
  switch (role) {
    case "participant":
    case "spectator":
    case "unknown":
      break;
    default: {
      const exhaustive: never = role;
      void exhaustive;
    }
  }
  void player.name;
  void player.isYou;
  void inspectVote(player.vote);
}

function inspectRoom(room: RoomSnapshot): void {
  const phase: PhaseSnapshot = room.phase;
  notAny(room.name);
  notAny(room.deck);
  notAny(room.phase);
  notAny(room.players);
  switch (phase) {
    case "playing":
    case "revealed":
    case "unknown":
      break;
    default: {
      const exhaustive: never = phase;
      void exhaustive;
    }
  }
  void room.name;
  void room.deck[0];
  room.players.forEach(inspectPlayer);
}

function inspectHistory(entry: HistorySnapshot): void {
  const average: number | null = entry.average;
  const localVote: VoteValueSnapshot | null = entry.localVote;
  notAny(entry.roundNumber);
  notAny(entry.average);
  notAny(entry.durationMs);
  notAny(entry.votes);
  notAny(entry.deck);
  notAny(entry.localVote);
  void entry.roundNumber;
  void entry.durationMs;
  void average;
  void entry.deck[0];
  entry.votes.forEach(inspectPlayer);
  if (localVote !== null) {
    void inspectVoteValue(localVote);
  }
}

function inspectActivity(activity: ActivitySnapshot): void {
  const level: ActivityLevel = activity.level;
  const source: ActivitySource = activity.source;
  notAny(activity.timestampMs);
  notAny(activity.level);
  notAny(activity.message);
  notAny(activity.source);
  notAny(activity.serverIndex);
  switch (level) {
    case "chat":
    case "info":
    case "error":
      break;
    default: {
      const exhaustive: never = level;
      void exhaustive;
    }
  }
  switch (source) {
    case "server":
    case "client":
      break;
    default: {
      const exhaustive: never = source;
      void exhaustive;
    }
  }
  void activity.timestampMs;
  void activity.message;
  void activity.serverIndex;
}

function inspectError(error: ClientErrorSnapshot): void {
  const code: ErrorCode = error.code;
  notAny(error.code);
  notAny(error.message);
  notAny(error.details);
  switch (code) {
    case "InvalidOptions":
    case "NotReady":
    case "Closed":
    case "Transport":
    case "Protocol":
      break;
    default: {
      const exhaustive: never = code;
      void exhaustive;
    }
  }
  void error.message;
  void error.details?.field;
  void error.details?.reason;
}

function inspectSnapshot(snapshot: ClientSnapshot): void {
  const status: SnapshotStatus = snapshot.status;
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
  switch (status) {
    case "disconnected":
    case "connecting":
    case "open":
    case "closed":
      break;
    default: {
      const exhaustive: never = status;
      void exhaustive;
    }
  }
  void snapshot.revision;
  if (snapshot.terminalError !== null) inspectError(snapshot.terminalError);
  if (snapshot.room !== null) inspectRoom(snapshot.room);
  if (snapshot.localVote !== null) inspectVoteValue(snapshot.localVote);
  snapshot.activity.forEach(inspectActivity);
  void snapshot.currentRound.number;
  void snapshot.currentRound.startedAtMs;
  snapshot.history.forEach(inspectHistory);
  void snapshot.statistics.average;
}

declare const client: WasmPokerClient;
declare const snapshot: ClientSnapshot;
declare const port: PokerClientPort;
declare const store: PokerClientStore;
const participant: ClientRole = "participant";
const spectatorOptions: ClientOptions = {
  endpoint: "wss://example.test",
  room: "typed",
  name: "Spectator",
  role: "spectator",
};

client.connect();
void client.poll();
inspectSnapshot(client.snapshot());
client.vote("5");
client.retractVote();
client.rename("Typed name");
client.chat("Typed message");
client.reveal();
client.startNewRound();
client.close();
client[Symbol.dispose]();
void initializePpokerWasm;
void participant;
void spectatorOptions;
inspectSnapshot(snapshot);
inspectSnapshot(store.getSnapshot());
inspectSnapshot(store.getServerSnapshot());
const createdStore = createPokerClientStore(port, { pollIntervalMs: 25 });
createdStore.connect();
void createdStore.poll();
createdStore.vote("5");
createdStore.retractVote();
createdStore.rename("Store name");
createdStore.chat("Store message");
createdStore.reveal();
createdStore.startNewRound();
createdStore.dispose();
createdStore[Symbol.dispose]();

declare const readonlySnapshot: PokerClientSnapshot;
type DerivedReadonlySnapshot = DeepReadonly<ClientSnapshot>;
const derivedReadonlySnapshot: DerivedReadonlySnapshot = readonlySnapshot;
// @ts-expect-error snapshots are deeply readonly
readonlySnapshot.room.players[0].name = "mutated";
// @ts-expect-error snapshot collections are deeply readonly
readonlySnapshot.history[0] = snapshot.history[0];
void derivedReadonlySnapshot;

type SnapshotIsTyped = Assert<NotAny<ClientSnapshot>>;
type RoomIsTyped = Assert<NotAny<RoomSnapshot>>;
type PlayerIsTyped = Assert<NotAny<PlayerSnapshot>>;
type VoteIsTyped = Assert<NotAny<VoteSnapshot>>;
type StoreSnapshotIsTyped = Assert<NotAny<PokerClientSnapshot>>;
const noRawFree: HasNoRawFree = true;
const snapshotIsTyped: SnapshotIsTyped = true;
const roomIsTyped: RoomIsTyped = true;
const playerIsTyped: PlayerIsTyped = true;
const voteIsTyped: VoteIsTyped = true;
const storeSnapshotIsTyped: StoreSnapshotIsTyped = true;
void noRawFree;
void snapshotIsTyped;
void roomIsTyped;
void playerIsTyped;
void voteIsTyped;
void storeSnapshotIsTyped;

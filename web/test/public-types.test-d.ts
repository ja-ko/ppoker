import {
  WasmPokerClient,
  createPokerClientStore,
  initializePpokerWasm,
  type ClientError,
  type ClientErrorCode,
  type ClientOptions,
  type ClientSnapshot,
  type ConnectionRole,
  type ConnectionStatus,
  type DeepReadonly,
  type GamePhase,
  type HistoryEntry,
  type LogEntry,
  type Player,
  type PokerClientPort,
  type PokerClientSnapshot,
  type PokerClientStore,
  type Room,
  type UserType,
  type Vote,
  type VoteData,
} from "../src/index.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Assert<Value extends true> = Value;
type NotAny<Value> = IsAny<Value> extends false ? true : false;
type HasNoRawFree = Assert<"free" extends keyof WasmPokerClient ? false : true>;

function inspectVoteData(value: DeepReadonly<VoteData>): number | string {
  return value.value;
}

function inspectVote(vote: DeepReadonly<Vote>): number | string | null {
  return vote.state === "revealed" ? inspectVoteData(vote.value) : null;
}

function inspectPlayer(player: DeepReadonly<Player>): void {
  const userType: UserType = player.userType;
  void userType;
  void inspectVote(player.vote);
}

function inspectRoom(room: DeepReadonly<Room>): void {
  const phase: GamePhase = room.phase;
  room.players.forEach(inspectPlayer);
  void phase;
}

function inspectHistory(entry: DeepReadonly<HistoryEntry>): void {
  const average: number | null = entry.average;
  const ownVote: VoteData | null = entry.ownVote;
  entry.votes.forEach(inspectPlayer);
  void entry.lengthMs;
  void average;
  void ownVote;
}

function inspectLog(entry: DeepReadonly<LogEntry>): void {
  const serverIndex: number | null = entry.serverIndex;
  void entry.timestampMs;
  void serverIndex;
}

function inspectError(error: DeepReadonly<ClientError>): void {
  const code: ClientErrorCode = error.code;
  void code;
}

function inspectSnapshot(snapshot: ClientSnapshot): void {
  const status: ConnectionStatus = snapshot.status;
  if (snapshot.terminalError !== null) inspectError(snapshot.terminalError);
  if (snapshot.room !== null) inspectRoom(snapshot.room);
  snapshot.log.forEach(inspectLog);
  snapshot.history.forEach(inspectHistory);
  void snapshot.roundNumber;
  void snapshot.roundStartedAtMs;
  void snapshot.average;
  void status;
}

declare const client: WasmPokerClient;
declare const snapshot: ClientSnapshot;
declare const port: PokerClientPort;
declare const store: PokerClientStore;
const participant: ConnectionRole = "participant";
const spectatorOptions: ClientOptions = {
  endpoint: "wss://example.test",
  room: "typed",
  name: "Spectator",
  role: "spectator",
};

client.connect();
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
createdStore.dispose();

declare const readonlySnapshot: PokerClientSnapshot;
type DerivedReadonlySnapshot = DeepReadonly<ClientSnapshot>;
const derivedReadonlySnapshot: DerivedReadonlySnapshot = readonlySnapshot;
// @ts-expect-error snapshots are deeply readonly
readonlySnapshot.room.players[0].name = "mutated";
// @ts-expect-error snapshot collections are deeply readonly
readonlySnapshot.history[0] = snapshot.history[0];
void derivedReadonlySnapshot;

type SnapshotIsTyped = Assert<NotAny<ClientSnapshot>>;
type RoomIsTyped = Assert<NotAny<Room>>;
type PlayerIsTyped = Assert<NotAny<Player>>;
type VoteIsTyped = Assert<NotAny<Vote>>;
type StoreSnapshotIsTyped = Assert<NotAny<PokerClientSnapshot>>;
const assertions: [
  HasNoRawFree,
  SnapshotIsTyped,
  RoomIsTyped,
  PlayerIsTyped,
  VoteIsTyped,
  StoreSnapshotIsTyped,
] = [true, true, true, true, true, true];
void assertions;

import type { ComponentProps } from "react";
import type * as Generated from "../src/generated/ppoker-wasm/ppoker_wasm.js";
import {
  createPokerClient,
  type ClientError,
  type ClientErrorCode,
  type ClientOptions,
  type ClientSnapshot,
  type ConnectionRole,
  type ConnectionStatus,
  type GamePhase,
  type HistoryEntry,
  type LogEntry,
  type Player,
  type PokerClient,
  type PokerClientConfig,
  type Room,
  type RoomEvent,
  type RoomEventKind,
  type RoomEventPayload,
  type UserType,
  type Vote,
  type VoteData,
} from "../src/index.js";
import {
  PokerClientProvider,
  usePokerClient,
  usePokerClientSnapshot,
  type ClientSnapshot as ReactClientSnapshot,
  type PokerClient as ReactPokerClient,
} from "../src/react.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Assert<Value extends true> = Value;
type NotAny<Value> = IsAny<Value> extends false ? true : false;
type Missing<Value, Key extends PropertyKey> = Key extends keyof Value
  ? false
  : true;
type DeepNotAny<Value> =
  IsAny<Value> extends true
    ? false
    : Value extends readonly (infer Item)[]
      ? DeepNotAny<Item>
      : Value extends object
        ? false extends {
            [Key in keyof Value]-?: DeepNotAny<Value[Key]>;
          }[keyof Value]
          ? false
          : true
        : true;
type AllDeepTyped<Values extends readonly unknown[]> = false extends {
  [Key in keyof Values]: DeepNotAny<Values[Key]>;
}[number]
  ? false
  : true;
// prettier-ignore
type PublicShapes = [ClientError, ClientOptions, ClientSnapshot, HistoryEntry, LogEntry, Player, Room, RoomEvent, RoomEventPayload<"autoRevealAnnounced">, Vote, VoteData];
// prettier-ignore
type GeneratedShapes = [Generated.ClientError, Generated.ClientOptions, Generated.ClientSnapshot, Generated.HistoryEntry, Generated.LogEntry, Generated.Player, Generated.Room, Generated.RoomEvent, Generated.Vote, Generated.VoteData];

function inspectVote(vote: Vote | Generated.Vote): number | string | null {
  switch (vote.state) {
    case "missing":
    case "hidden":
      return null;
    case "revealed":
      return vote.value.kind === "number" ? vote.value.value : vote.value.value;
    default: {
      const exhaustive: never = vote;
      return exhaustive;
    }
  }
}

declare const client: PokerClient;
declare const snapshot: ClientSnapshot;
declare const generatedOptions: Generated.ClientOptions;
declare const generatedSnapshot: Generated.ClientSnapshot;
const generatedOptionsAsPublic: ClientOptions = generatedOptions;
const generatedSnapshotAsPublic: ClientSnapshot = generatedSnapshot;
const expectedValues: [
  ClientErrorCode,
  ConnectionRole,
  ConnectionStatus,
  GamePhase,
  UserType,
  number | null,
  VoteData | null,
  number | null,
] = [
  snapshot.terminalError?.code ?? "Transport",
  "participant",
  snapshot.status,
  snapshot.room?.phase ?? "unknown",
  snapshot.room?.players[0]?.userType ?? "player",
  snapshot.history[0]?.average ?? null,
  snapshot.history[0]?.ownVote ?? null,
  snapshot.log[0]?.serverIndex ?? null,
];

client.connect();
client.vote("5");
client.retractVote();
client.rename("Typed name");
client.chat("Typed message");
client.announceAutoReveal(3_000);
client.reveal();
client.startNewRound();
client.close();
client[Symbol.dispose]();
inspectVote(snapshot.room?.players[0]?.vote ?? { state: "missing" });
const roomEvent: RoomEvent | undefined = snapshot.roomEvents[0];
if (roomEvent?.kind === "autoRevealAnnounced") {
  const countdownMs: number = roomEvent.value.countdownMs;
  // @ts-expect-error room event values are deeply readonly
  roomEvent.value.countdownMs = 1_000;
  void countdownMs;
}
const roomEventKind: RoomEventKind = "autoRevealAnnounced";
const historicalAnnouncements: readonly RoomEventPayload<"autoRevealAnnounced">[] =
  client.getRoomEvents("autoRevealAnnounced");
const unsubscribeAnnouncement = client.subscribeRoomEvent(
  "autoRevealAnnounced",
  ({ countdownMs }) => {
    const countdown: number = countdownMs;
    void countdown;
    // @ts-expect-error narrowed listeners receive the payload, not the union
    void countdownMs.kind;
  },
);
const unsubscribeAllEvents = client.subscribeRoomEvents((event) => {
  const union: RoomEvent = event;
  void union;
});
void [
  generatedOptionsAsPublic,
  generatedSnapshotAsPublic,
  expectedValues,
  client.getSnapshot(),
  roomEventKind,
  historicalAnnouncements,
  unsubscribeAnnouncement,
  unsubscribeAllEvents,
];

const createdClient: Promise<PokerClient> = createPokerClient(
  generatedOptionsAsPublic,
  {
    wasm: new DataView(new ArrayBuffer(8)),
  } satisfies PokerClientConfig,
);
const firstPlayer = snapshot.room?.players[0];
if (firstPlayer !== undefined) {
  // @ts-expect-error snapshots are deeply readonly
  firstPlayer.name = "mutated";
}
// @ts-expect-error snapshot collections are deeply readonly
snapshot.history[0] = {} as HistoryEntry;
// @ts-expect-error room events are deeply readonly
snapshot.roomEvents[0] = {} as RoomEvent;

const providerProperties: ComponentProps<typeof PokerClientProvider> = {
  client,
};
const hookClient: ReactPokerClient = usePokerClient();
const hookSnapshot: ReactClientSnapshot = usePokerClientSnapshot();
void [
  createdClient,
  providerProperties,
  hookClient,
  hookSnapshot.room?.players[0]?.vote,
  hookSnapshot.history[0]?.votes[0]?.name,
  hookSnapshot.terminalError?.message,
  hookSnapshot.log[0]?.message,
  hookSnapshot.roomEvents[0],
];

export type TypeContracts = Assert<
  [
    Missing<PokerClient, "free">,
    Missing<PokerClient, "poll">,
    Missing<PokerClientConfig, "pollIntervalMs">,
    Missing<HistoryEntry, "lengthMs">,
    Missing<Generated.HistoryEntry, "lengthMs">,
    Missing<ClientSnapshot, "roundStartedAtMs">,
    Missing<Generated.ClientSnapshot, "roundStartedAtMs">,
    Missing<RoomEvent, "sequence">,
    AllDeepTyped<PublicShapes>,
    AllDeepTyped<GeneratedShapes>,
    NotAny<ReactClientSnapshot>,
    NotAny<ReactPokerClient>,
  ] extends true[]
    ? true
    : false
>;

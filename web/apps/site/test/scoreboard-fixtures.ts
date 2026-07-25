import type {
  DistributionVote,
  PlayingBroadcast,
  PlayingParticipant,
  RevealedBroadcast,
  RoundResult,
} from "../src/scoreboard-model";

const distribution = [
  { id: "one", label: "1", count: 0 },
  { id: "two", label: "2", count: 0 },
  { id: "three", label: "3", count: 2 },
  { id: "five", label: "5", count: 4, leader: true },
  { id: "eight", label: "8", count: 2 },
  { id: "thirteen", label: "13", count: 0 },
  { id: "unknown", label: "?", count: 1, special: true },
  { id: "break", label: "\u2615", count: 1, special: true },
] as const satisfies readonly DistributionVote[];

const previousRound = {
  average: "5.3",
  distribution,
  leadingCount: 4,
  numericResponses: 8,
  observedAt: "1 min ago",
  responseCount: 10,
  round: 8,
  specialResponses: 2,
} as const satisfies RoundResult;

export const playingFixture = {
  displayTitle: "Planning Poker Room",
  history: [
    { id: "round-8", round: 8, average: "5.3", age: "1 min ago" },
    { id: "round-7", round: 7, average: "3.8", age: "5 min ago" },
    { id: "round-6", round: 6, average: "8.0", age: "12 min ago" },
    { id: "round-5", round: 5, average: "5.6", age: "20 min ago" },
    { id: "round-4", round: 4, average: "3.0", age: "29 min ago" },
  ],
  observed: "00:47",
  participants: [
    { id: "ada", name: "Ada", locked: true },
    { id: "ben", name: "Ben", locked: true },
    { id: "cleo", name: "Cleo", locked: true },
    { id: "diego", name: "Diego", locked: false },
    { id: "erin", name: "Erin", locked: true },
    { id: "farah", name: "Farah", locked: false },
    { id: "gus", name: "Gus", locked: true },
    { id: "hana", name: "Hana", locked: true },
    { id: "ivo", name: "Ivo", locked: false },
    { id: "jules", name: "Jules", locked: false },
  ],
  phase: "playing",
  previousRound,
  roomCode: "PX-082",
  roomName: "Checkout Redesign",
  round: 9,
} as const satisfies PlayingBroadcast;

export const revealedFixture = {
  displayTitle: "Planning Poker Room",
  history: [
    { id: "round-7", round: 7, average: "3.8", age: "4 min ago" },
    { id: "round-6", round: 6, average: "8.0", age: "11 min ago" },
    { id: "round-5", round: 5, average: "5.6", age: "19 min ago" },
    { id: "round-4", round: 4, average: "3.0", age: "28 min ago" },
    { id: "round-3", round: 3, average: "7.2", age: "42 min ago" },
  ],
  observed: "02:14",
  participants: [
    { id: "ada", name: "Ada", vote: "5" },
    { id: "ben", name: "Ben", vote: "3" },
    { id: "cleo", name: "Cleo", vote: "5" },
    { id: "diego", name: "Diego", vote: "8" },
    { id: "erin", name: "Erin", vote: "5" },
    { id: "farah", name: "Farah", vote: "3" },
    { id: "gus", name: "Gus", vote: "8" },
    { id: "hana", name: "Hana", vote: "5" },
    { id: "ivo", name: "Ivo", vote: "?", special: true },
    {
      id: "jules",
      name: "Jules",
      vote: "\u2615",
      special: true,
    },
  ],
  phase: "revealed",
  result: previousRound,
  roomCode: "PX-082",
  roomName: "Checkout Redesign",
  round: 8,
} as const satisfies RevealedBroadcast;

export const overflowFixture = {
  ...playingFixture,
  participants: Array.from({ length: 18 }, (_, index): PlayingParticipant => ({
    id: `overflow-participant-${index.toString()}`,
    locked: index % 3 !== 0,
    name: `Player ${(index + 1).toString()}`,
  })),
  roomCode: "QA-018",
  roomName: "Overflow Fixture",
} satisfies PlayingBroadcast;

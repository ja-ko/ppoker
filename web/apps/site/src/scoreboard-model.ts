export interface DistributionVote {
  readonly count: number;
  readonly id: string;
  readonly label: string;
  readonly leader?: boolean;
  readonly special?: boolean;
}

export interface RoundResult {
  readonly average: string;
  readonly distribution: readonly DistributionVote[];
  readonly leadingCount: number;
  readonly numericResponses: number;
  readonly observedAt: string;
  readonly responseCount: number;
  readonly round: number;
  readonly specialResponses: number;
}

export interface PlayingParticipant {
  readonly id: string;
  readonly locked: boolean;
  readonly name: string;
}

export interface RevealedParticipant {
  readonly id: string;
  readonly name: string;
  readonly special?: boolean;
  readonly vote: string;
}

export interface HistoryEntry {
  readonly age: string;
  readonly average: string;
  readonly id: string;
  readonly round: number;
}

interface BroadcastBase {
  readonly displayTitle: string;
  readonly history: readonly HistoryEntry[];
  readonly observed: string;
  readonly roomCode: string;
  readonly roomName: string;
  readonly round: number;
}

export interface PlayingBroadcast extends BroadcastBase {
  readonly participants: readonly PlayingParticipant[];
  readonly phase: "playing";
  readonly previousRound?: RoundResult;
}

export interface RevealedBroadcast extends BroadcastBase {
  readonly participants: readonly RevealedParticipant[];
  readonly phase: "revealed";
  readonly result: RoundResult;
}

export type BroadcastScoreboardModel = PlayingBroadcast | RevealedBroadcast;

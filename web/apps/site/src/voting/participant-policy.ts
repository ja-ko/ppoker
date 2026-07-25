import type { ClientSnapshot, Player } from "@ppoker/web-client";

export const MINIMUM_AUTO_REVEAL_VOTERS = 2;

export interface VotingCoverage {
  readonly allVotersCovered: boolean;
  readonly localVoter: Player | null;
  readonly missingVoterCount: number;
  readonly voters: readonly Player[];
}

export type PhaseControlAction = "none" | "reset" | "reveal";
export type PhaseControlConfirmation = "missing-votes" | "reset" | null;

export interface PhaseControlPolicy {
  readonly action: PhaseControlAction;
  readonly confirmation: PhaseControlConfirmation;
  readonly disabled: boolean;
  readonly missingVoterCount: number;
  readonly position: "top-right";
}

export function selectVoters(
  participants: readonly Player[],
): readonly Player[] {
  return participants.filter(
    (participant) => participant.userType === "player",
  );
}

export function selectUniqueLocalParticipant(
  participants: readonly Player[],
): Player | null {
  const localParticipants = participants.filter(
    (participant) => participant.isYou,
  );
  return localParticipants.length === 1 ? (localParticipants[0] ?? null) : null;
}

export function selectUniqueLocalVoter(
  participants: readonly Player[],
): Player | null {
  const localParticipant = selectUniqueLocalParticipant(participants);
  return localParticipant?.userType === "player" ? localParticipant : null;
}

export function votingCoverage(snapshot: ClientSnapshot): VotingCoverage {
  const participants = snapshot.room?.players ?? [];
  const voters = selectVoters(participants);
  const missingVoterCount = voters.filter(
    (participant) => participant.vote.state === "missing",
  ).length;
  return {
    allVotersCovered: voters.length > 0 && missingVoterCount === 0,
    localVoter: selectUniqueLocalVoter(participants),
    missingVoterCount,
    voters,
  };
}

export function isRevealEligible(snapshot: ClientSnapshot): boolean {
  return snapshot.status === "open" && snapshot.room?.phase === "playing";
}

export function isAutoRevealReady(snapshot: ClientSnapshot): boolean {
  const coverage = votingCoverage(snapshot);
  return (
    isRevealEligible(snapshot) &&
    coverage.voters.length >= MINIMUM_AUTO_REVEAL_VOTERS &&
    coverage.localVoter !== null &&
    coverage.allVotersCovered
  );
}

export function isLocalSoleMissingVoter(snapshot: ClientSnapshot): boolean {
  const coverage = votingCoverage(snapshot);
  return (
    isRevealEligible(snapshot) &&
    coverage.voters.length >= MINIMUM_AUTO_REVEAL_VOTERS &&
    coverage.localVoter?.vote.state === "missing" &&
    coverage.missingVoterCount === 1
  );
}

export function phaseControlPolicy(
  snapshot: ClientSnapshot,
): PhaseControlPolicy {
  const phase = snapshot.room?.phase ?? "unknown";
  const missingVoterCount = votingCoverage(snapshot).missingVoterCount;
  const disabled = snapshot.status !== "open";

  if (phase === "playing") {
    return {
      action: "reveal",
      confirmation: missingVoterCount > 0 ? "missing-votes" : null,
      disabled,
      missingVoterCount,
      position: "top-right",
    };
  }
  if (phase === "revealed") {
    return {
      action: "reset",
      confirmation: "reset",
      disabled,
      missingVoterCount,
      position: "top-right",
    };
  }
  return {
    action: "none",
    confirmation: null,
    disabled: true,
    missingVoterCount,
    position: "top-right",
  };
}

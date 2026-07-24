import type { ClientSnapshot, Player, Vote } from "@ppoker/web-client";

export const voterFixtureNames = [
  "playing",
  "final-vote",
  "final-voted",
  "existing-vote",
  "revealed",
  "long-deck",
] as const;

export type VoterFixtureName = (typeof voterFixtureNames)[number];

const numericDeck = ["1", "3", "5", "8", "13", "?"] as const;

export function voterFixtureSnapshot(name: VoterFixtureName): ClientSnapshot {
  switch (name) {
    case "playing":
      return playingSnapshot();
    case "final-vote":
      return playingSnapshot({ peerVote: hiddenVote() });
    case "final-voted":
      return playingSnapshot({
        localVote: { kind: "number", value: 8 },
        localVoteState: hiddenVote(),
        peerVote: hiddenVote(),
        revision: 2,
      });
    case "existing-vote":
      return playingSnapshot({
        localVote: { kind: "number", value: 5 },
        localVoteState: hiddenVote(),
      });
    case "revealed":
      return {
        ...playingSnapshot({
          localVote: { kind: "number", value: 5 },
          localVoteState: revealedNumber(5),
          peerVote: revealedNumber(8),
          revision: 3,
        }),
        average: 6.5,
        room: {
          deck: numericDeck,
          name: "Voter E2E Room",
          phase: "revealed",
          players: [
            player("E2E Voter", revealedNumber(5), true),
            player("Ready Peer", revealedNumber(8)),
          ],
        },
      };
    case "long-deck":
      return playingSnapshot({
        deck: [
          ...numericDeck,
          "Needs another conversation with stakeholders",
          "Break / regroup",
        ],
      });
  }
}

export function isVoterFixtureName(
  value: string | null,
): value is VoterFixtureName {
  return value !== null && voterFixtureNames.some((name) => name === value);
}

interface PlayingSnapshotOptions {
  readonly deck?: readonly string[];
  readonly localVote?: ClientSnapshot["localVote"];
  readonly localVoteState?: Vote;
  readonly peerVote?: Vote;
  readonly revision?: number;
}

function playingSnapshot(options: PlayingSnapshotOptions = {}): ClientSnapshot {
  return {
    average: null,
    history: [],
    localName: "E2E Voter",
    localVote: options.localVote ?? null,
    log: [],
    revision: options.revision ?? 1,
    room: {
      deck: options.deck ?? numericDeck,
      name: "Voter E2E Room",
      phase: "playing",
      players: [
        player("E2E Voter", options.localVoteState ?? missingVote(), true),
        player("Ready Peer", options.peerVote ?? missingVote()),
      ],
    },
    roundNumber: 4,
    status: "open",
    terminalError: null,
  };
}

function player(name: string, vote: Vote, isYou = false): Player {
  return { isYou, name, userType: "player", vote };
}

function missingVote(): Vote {
  return { state: "missing" };
}

function hiddenVote(): Vote {
  return { state: "hidden" };
}

function revealedNumber(value: number): Vote {
  return { state: "revealed", value: { kind: "number", value } };
}

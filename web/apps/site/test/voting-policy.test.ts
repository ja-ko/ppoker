import type { ClientSnapshot, Player } from "@ppoker/web-client";
import { describe, expect, it } from "vitest";

import {
  isAutoRevealReady,
  isLocalSoleMissingVoter,
  phaseControlPolicy,
  selectUniqueLocalParticipant,
  selectUniqueLocalVoter,
  selectVoters,
  votingCoverage,
} from "../src/voting/participant-policy";
import { makeSnapshot } from "./fake-client";

describe("participant voting policy", () => {
  it("strictly treats only player user types as voters", () => {
    const participants = [
      player("Local", "missing", true),
      player("Observer", "missing", false, "spectator"),
      player("Pending role", "missing", false, "unknown"),
      player("Peer", "hidden"),
    ];

    expect(selectVoters(participants).map(({ name }) => name)).toEqual([
      "Local",
      "Peer",
    ]);
    expect(votingCoverage(snapshot({ participants })).missingVoterCount).toBe(
      1,
    );
    expect(isLocalSoleMissingVoter(snapshot({ participants }))).toBe(true);
  });

  it("requires one and only one isYou participant, who must be a voter", () => {
    const unique = [player("Local", "missing", true), player("Peer", "hidden")];
    expect(selectUniqueLocalParticipant(unique)?.name).toBe("Local");
    expect(selectUniqueLocalVoter(unique)?.name).toBe("Local");

    const spectator = [
      player("Local", "missing", true, "spectator"),
      player("Peer", "hidden"),
    ];
    expect(selectUniqueLocalParticipant(spectator)?.name).toBe("Local");
    expect(selectUniqueLocalVoter(spectator)).toBeNull();

    const duplicate = [
      player("Local", "missing", true),
      player("Duplicate local", "hidden", true, "spectator"),
      player("Peer", "hidden"),
    ];
    expect(selectUniqueLocalParticipant(duplicate)).toBeNull();
    expect(isLocalSoleMissingVoter(snapshot({ participants: duplicate }))).toBe(
      false,
    );
  });

  it("requires at least two strict voters for automatic reveal", () => {
    const soleVoter = snapshot({
      participants: [player("Local", "missing", true)],
    });
    expect(isLocalSoleMissingVoter(soleVoter)).toBe(false);

    const soleCoveredVoter = snapshot({
      participants: [player("Local", "hidden", true)],
    });
    expect(isAutoRevealReady(soleCoveredVoter)).toBe(false);
  });

  it("requires an open, playing room for reveal eligibility", () => {
    const participants = [
      player("Local", "hidden", true),
      player("Peer", "hidden"),
    ];
    expect(isAutoRevealReady(snapshot({ participants }))).toBe(true);
    expect(
      isAutoRevealReady(snapshot({ participants, status: "connecting" })),
    ).toBe(false);
    expect(
      isAutoRevealReady(snapshot({ participants, phase: "revealed" })),
    ).toBe(false);
  });
});

describe("phase controls", () => {
  it("keeps Reveal in the top-right and confirms only with missing votes", () => {
    const complete = snapshot({
      participants: [player("Local", "hidden", true), player("Peer", "hidden")],
    });
    expect(phaseControlPolicy(complete)).toEqual({
      action: "reveal",
      confirmation: null,
      disabled: false,
      missingVoterCount: 0,
      position: "top-right",
    });

    expect(
      phaseControlPolicy(
        snapshot({
          participants: [
            player("Local", "hidden", true),
            player("Missing player", "missing"),
            player("Missing spectator", "missing", false, "spectator"),
          ],
        }),
      ),
    ).toEqual({
      action: "reveal",
      confirmation: "missing-votes",
      disabled: false,
      missingVoterCount: 1,
      position: "top-right",
    });
  });

  it("always confirms Reset in the same position", () => {
    expect(phaseControlPolicy(snapshot({ phase: "revealed" }))).toEqual({
      action: "reset",
      confirmation: "reset",
      disabled: false,
      missingVoterCount: 0,
      position: "top-right",
    });
  });

  it("disables cached controls while disconnected and unknown phases", () => {
    expect(
      phaseControlPolicy(snapshot({ status: "disconnected" })),
    ).toMatchObject({ action: "reveal", disabled: true });
    expect(phaseControlPolicy(snapshot({ phase: "unknown" }))).toEqual({
      action: "none",
      confirmation: null,
      disabled: true,
      missingVoterCount: 0,
      position: "top-right",
    });
    expect(phaseControlPolicy(makeSnapshot())).toMatchObject({
      action: "none",
      disabled: true,
    });
  });
});

interface SnapshotOptions {
  readonly participants?: readonly Player[];
  readonly phase?: "playing" | "revealed" | "unknown";
  readonly revision?: number;
  readonly status?: ClientSnapshot["status"];
}

function snapshot(options: SnapshotOptions = {}): ClientSnapshot {
  return makeSnapshot({
    revision: options.revision ?? 1,
    room: {
      deck: ["1", "2", "3"],
      name: "Planning",
      phase: options.phase ?? "playing",
      players: options.participants ?? [],
    },
    roundNumber: 4,
    status: options.status ?? "open",
  });
}

function player(
  name: string,
  voteState: "hidden" | "missing" | "revealed",
  isYou = false,
  userType: Player["userType"] = "player",
): Player {
  const vote: Player["vote"] =
    voteState === "revealed"
      ? { state: "revealed", value: { kind: "number", value: 3 } }
      : { state: voteState };
  return { isYou, name, userType, vote };
}

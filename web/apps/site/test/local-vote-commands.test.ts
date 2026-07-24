import type { ClientSnapshot } from "@ppoker/web-client";
import { describe, expect, it } from "vitest";

import {
  effectiveLocalVote,
  enqueueLocalVoteCommand,
  pendingLocalVoteIntent,
  reconcileLocalVoteCommands,
  type LocalVoteCommandQueue,
} from "../src/voting/local-vote-commands";
import { makeSnapshot } from "./fake-client";

describe("ordered local vote command acknowledgements", () => {
  it("preserves the latest vote through vote 5 -> 8 -> 5 ABA acknowledgements", () => {
    const initial = snapshot(1, null);
    let queue: LocalVoteCommandQueue | null = issue(null, "5", initial);
    queue = issue(queue, "8", initial);
    queue = issue(queue, "5", initial);
    expect(tail(queue, initial)).toBe("5");

    queue = reconcileLocalVoteCommands(queue, snapshot(2, null));
    expect(queue?.commands.map(({ target }) => target)).toEqual([
      "5",
      "8",
      "5",
    ]);
    queue = reconcileLocalVoteCommands(queue, snapshot(3, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["8", "5"]);
    expect(tail(queue, snapshot(3, "5"))).toBe("5");

    queue = reconcileLocalVoteCommands(queue, snapshot(4, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["8", "5"]);
    queue = reconcileLocalVoteCommands(queue, snapshot(5, "8"));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["5"]);
    queue = reconcileLocalVoteCommands(queue, snapshot(6, "5"));
    expect(queue).toBeNull();
    expect(effectiveLocalVote(queue, snapshot(6, "5"))).toBe("5");
  });

  it("preserves retract -> vote 8 -> retract through old and unrelated snapshots", () => {
    const initial = snapshot(1, "5");
    let queue: LocalVoteCommandQueue | null = issue(null, null, initial);
    queue = issue(queue, "8", initial);
    queue = issue(queue, null, initial);
    expect(tail(queue, initial)).toBeNull();

    queue = reconcileLocalVoteCommands(queue, snapshot(2, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual([
      null,
      "8",
      null,
    ]);
    queue = reconcileLocalVoteCommands(queue, snapshot(3, null));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["8", null]);
    queue = reconcileLocalVoteCommands(queue, snapshot(4, null));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["8", null]);
    queue = reconcileLocalVoteCommands(queue, snapshot(5, "8"));
    expect(queue?.commands.map(({ target }) => target)).toEqual([null]);
    queue = reconcileLocalVoteCommands(queue, snapshot(6, null));
    expect(queue).toBeNull();
  });

  it("does not confuse an unchanged null with acknowledgement of a queued retract", () => {
    const initial = snapshot(1, null);
    let queue: LocalVoteCommandQueue | null = issue(null, "5", initial);
    queue = issue(queue, null, initial);

    queue = reconcileLocalVoteCommands(queue, snapshot(2, null));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["5", null]);
    queue = reconcileLocalVoteCommands(queue, snapshot(3, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual([null]);
    expect(tail(queue, snapshot(3, "5"))).toBeNull();
    queue = reconcileLocalVoteCommands(queue, snapshot(4, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual([null]);
    queue = reconcileLocalVoteCommands(queue, snapshot(5, null));
    expect(queue).toBeNull();
  });

  it("consumes at most one command per authoritative revision", () => {
    const initial = snapshot(1, null);
    let queue: LocalVoteCommandQueue | null = issue(null, "5", initial);
    queue = issue(queue, "5", initial);
    queue = reconcileLocalVoteCommands(queue, snapshot(2, "5"));
    expect(queue?.commands.map(({ target }) => target)).toEqual(["5"]);

    const sameRevision = reconcileLocalVoteCommands(queue, snapshot(2, "5"));
    expect(sameRevision).toBe(queue);
    queue = reconcileLocalVoteCommands(queue, snapshot(3, "5"));
    expect(queue).toBeNull();
  });

  it("drops queued commands when voting context changes", () => {
    const initial = snapshot(1, null);
    const queue = issue(null, "5", initial);
    const nextRound = { ...snapshot(2, null), roundNumber: 5 };
    expect(reconcileLocalVoteCommands(queue, nextRound)).toBeNull();
    expect(pendingLocalVoteIntent(queue, nextRound)).toBeNull();
  });
});

function issue(
  queue: LocalVoteCommandQueue | null,
  target: string | null,
  current: ClientSnapshot,
): LocalVoteCommandQueue {
  const next = enqueueLocalVoteCommand(queue, target, current, current);
  if (next === null) {
    throw new Error("Expected a queued local vote command.");
  }
  return next;
}

function tail(
  queue: LocalVoteCommandQueue | null,
  current: ClientSnapshot,
): string | null {
  const pending = pendingLocalVoteIntent(queue, current);
  if (pending === null) {
    throw new Error("Expected a pending local vote intent.");
  }
  return pending.value;
}

function snapshot(revision: number, vote: string | null): ClientSnapshot {
  return makeSnapshot({
    localName: "Local",
    localVote:
      vote === null
        ? null
        : Number.isFinite(Number(vote))
          ? { kind: "number", value: Number(vote) }
          : { kind: "special", value: vote },
    revision,
    room: {
      deck: ["1", "3", "5", "8", "13", "?"],
      name: "Planning",
      phase: "playing",
      players: [],
    },
    roundNumber: 4,
    status: "open",
  });
}

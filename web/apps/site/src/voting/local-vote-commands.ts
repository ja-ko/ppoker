import type { ClientSnapshot, VoteData } from "@ppoker/web-client";

import { votingContextKey } from "./auto-reveal";

export interface LocalVoteCommand {
  readonly issuedRevision: number;
  readonly target: string | null;
  readonly transitionObserved: boolean;
}

export interface LocalVoteCommandQueue {
  readonly commands: readonly LocalVoteCommand[];
  readonly contextKey: string;
  readonly lastObservedRevision: number;
}

export interface PendingLocalVoteIntent {
  readonly value: string | null;
}

export function enqueueLocalVoteCommand(
  queue: LocalVoteCommandQueue | null,
  target: string | null,
  before: ClientSnapshot,
  after: ClientSnapshot,
): LocalVoteCommandQueue | null {
  const contextKey = votingContextKey(before);
  if (contextKey === null || contextKey !== votingContextKey(after)) {
    return null;
  }
  const reconciled = reconcileLocalVoteCommands(queue, before);
  const current =
    reconciled?.contextKey === contextKey
      ? reconciled
      : {
          commands: [],
          contextKey,
          lastObservedRevision: before.revision,
        };
  const appended: LocalVoteCommandQueue = {
    commands: [
      ...current.commands,
      {
        issuedRevision: before.revision,
        target,
        transitionObserved: voteLabel(before.localVote) !== target,
      },
    ],
    contextKey,
    lastObservedRevision: Math.max(
      current.lastObservedRevision,
      before.revision,
    ),
  };
  return reconcileLocalVoteCommands(appended, after);
}

export function reconcileLocalVoteCommands(
  queue: LocalVoteCommandQueue | null,
  snapshot: ClientSnapshot,
): LocalVoteCommandQueue | null {
  if (queue === null) {
    return null;
  }
  if (queue.contextKey !== votingContextKey(snapshot)) {
    return null;
  }
  if (snapshot.revision <= queue.lastObservedRevision) {
    return queue;
  }

  const [head, ...remaining] = queue.commands;
  if (head === undefined) {
    return null;
  }
  const authoritative = voteLabel(snapshot.localVote);
  if (authoritative === head.target && head.transitionObserved) {
    const next = remaining[0];
    const adjustedRemaining =
      next !== undefined &&
      authoritative !== next.target &&
      !next.transitionObserved
        ? [{ ...next, transitionObserved: true }, ...remaining.slice(1)]
        : remaining;
    return adjustedRemaining.length === 0
      ? null
      : {
          ...queue,
          commands: adjustedRemaining,
          lastObservedRevision: snapshot.revision,
        };
  }
  const nextHead =
    authoritative !== head.target && !head.transitionObserved
      ? { ...head, transitionObserved: true }
      : head;
  return {
    ...queue,
    commands: [nextHead, ...remaining],
    lastObservedRevision: snapshot.revision,
  };
}

export function pendingLocalVoteIntent(
  queue: LocalVoteCommandQueue | null,
  snapshot: ClientSnapshot,
): PendingLocalVoteIntent | null {
  if (queue?.contextKey !== votingContextKey(snapshot)) {
    return null;
  }
  const tail = queue.commands.at(-1);
  return tail === undefined ? null : { value: tail.target };
}

export function effectiveLocalVote(
  queue: LocalVoteCommandQueue | null,
  snapshot: ClientSnapshot,
): string | null {
  const pending = pendingLocalVoteIntent(queue, snapshot);
  return pending === null ? voteLabel(snapshot.localVote) : pending.value;
}

export function voteLabel(vote: VoteData | null): string | null {
  if (vote === null) {
    return null;
  }
  return vote.kind === "number" ? String(vote.value) : vote.value;
}

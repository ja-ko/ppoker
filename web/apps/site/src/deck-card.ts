import type { VoteData } from "@ppoker/web-client";

export function voteKey(vote: VoteData): string {
  return vote.kind === "number"
    ? `number:${vote.value.toString()}`
    : `special:${vote.value}`;
}

export function deckCardKey(label: string): string {
  if (/^\+?\d+$/u.test(label)) {
    const value = Number(label);
    if (Number.isInteger(value) && value >= 0 && value <= 255) {
      return `number:${value.toString()}`;
    }
  }
  return `special:${label}`;
}

export function deckCardsMatch(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return deckCardKey(left) === deckCardKey(right);
}

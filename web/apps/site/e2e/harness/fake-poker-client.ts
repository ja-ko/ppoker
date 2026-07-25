import type { ClientSnapshot, PokerClient } from "@ppoker/web-client";

export const commandNames = [
  "connect",
  "vote",
  "retractVote",
  "rename",
  "chat",
  "reveal",
  "startNewRound",
  "close",
  "dispose",
] as const;

export type CommandName = (typeof commandNames)[number];
export type CommandCounts = Readonly<Record<CommandName, number>>;

export class FakePokerClient implements PokerClient {
  readonly #counts: Record<CommandName, number> = {
    chat: 0,
    close: 0,
    connect: 0,
    dispose: 0,
    rename: 0,
    retractVote: 0,
    reveal: 0,
    startNewRound: 0,
    vote: 0,
  };
  readonly #listeners = new Set<() => void>();
  #snapshot: ClientSnapshot;

  constructor(initialSnapshot: ClientSnapshot) {
    this.#snapshot = deepFreeze(initialSnapshot);
  }

  readonly getSnapshot = (): ClientSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  publish(snapshot: ClientSnapshot): void {
    this.#snapshot = deepFreeze(snapshot);
    for (const listener of new Set(this.#listeners)) {
      listener();
    }
  }

  commandCounts(): CommandCounts {
    return { ...this.#counts };
  }

  connect(): void {
    this.#counts.connect += 1;
  }

  vote(value: string): void {
    void value;
    this.#counts.vote += 1;
  }

  retractVote(): void {
    this.#counts.retractVote += 1;
  }

  rename(name: string): void {
    void name;
    this.#counts.rename += 1;
  }

  chat(message: string): void {
    void message;
    this.#counts.chat += 1;
  }

  reveal(): void {
    this.#counts.reveal += 1;
  }

  startNewRound(): void {
    this.#counts.startNewRound += 1;
  }

  close(): void {
    this.#counts.close += 1;
  }

  [Symbol.dispose](): void {
    this.#counts.dispose += 1;
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

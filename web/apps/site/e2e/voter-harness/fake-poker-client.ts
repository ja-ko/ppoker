import type { ClientSnapshot, PokerClient } from "@ppoker/web-client";

export const voterCommandNames = [
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

export type VoterCommandName = (typeof voterCommandNames)[number];

export interface VoterCommandRecord {
  readonly args: readonly string[];
  readonly index: number;
  readonly name: VoterCommandName;
}

export class FakeVoterPokerClient implements PokerClient {
  readonly #commands: VoterCommandRecord[] = [];
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

  commands(): readonly VoterCommandRecord[] {
    return this.#commands.map((command) => ({
      ...command,
      args: [...command.args],
    }));
  }

  publish(snapshot: ClientSnapshot): void {
    this.#snapshot = deepFreeze(snapshot);
    for (const listener of new Set(this.#listeners)) {
      listener();
    }
  }

  connect(): void {
    this.#record("connect");
  }

  vote(value: string): void {
    this.#record("vote", value);
  }

  retractVote(): void {
    this.#record("retractVote");
  }

  rename(name: string): void {
    this.#record("rename", name);
  }

  chat(message: string): void {
    this.#record("chat", message);
  }

  reveal(): void {
    this.#record("reveal");
  }

  startNewRound(): void {
    this.#record("startNewRound");
  }

  close(): void {
    this.#record("close");
  }

  [Symbol.dispose](): void {
    this.#record("dispose");
  }

  #record(name: VoterCommandName, ...args: string[]): void {
    this.#commands.push(
      Object.freeze({
        args: Object.freeze(args),
        index: this.#commands.length,
        name,
      }),
    );
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

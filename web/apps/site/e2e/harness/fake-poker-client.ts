import type {
  ClientSnapshot,
  PokerClient,
  RoomEvent,
  RoomEventKind,
  RoomEventPayload,
} from "@ppoker/web-client";

export const commandNames = [
  "connect",
  "announceAutoReveal",
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

interface RoomEventSubscription {
  readonly listener: (event: RoomEvent) => void;
  readonly startIndex: number;
}

export class FakePokerClient implements PokerClient {
  readonly #counts: Record<CommandName, number> = {
    announceAutoReveal: 0,
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
  readonly #roomEventListeners = new Set<RoomEventSubscription>();
  #receivedRoomEventCount = 0;
  #snapshot: ClientSnapshot;

  constructor(initialSnapshot: ClientSnapshot) {
    this.#snapshot = deepFreeze(initialSnapshot);
  }

  readonly getSnapshot = (): ClientSnapshot => this.#snapshot;

  readonly getRoomEvents = ((kind: string) =>
    this.#snapshot.roomEvents
      .filter((event) => event.kind.localeCompare(kind) === 0)
      .map((event) => event.value)) as PokerClient["getRoomEvents"];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly subscribeRoomEvent = <Kind extends RoomEventKind>(
    kind: Kind,
    listener: (payload: RoomEventPayload<Kind>) => void,
  ): (() => void) => {
    const eventListener = (event: RoomEvent): void => {
      if (roomEventHasKind(event, kind)) {
        listener(event.value);
      }
    };
    return this.#addRoomEventListener(eventListener);
  };

  readonly subscribeRoomEvents = (
    listener: (event: RoomEvent) => void,
  ): (() => void) => this.#addRoomEventListener(listener);

  publish(snapshot: ClientSnapshot): void {
    this.#snapshot = deepFreeze(snapshot);
    for (const listener of new Set(this.#listeners)) {
      listener();
    }
  }

  publishRoomEvent(event: RoomEvent): void {
    const eventIndex = this.#receivedRoomEventCount;
    this.#receivedRoomEventCount += 1;
    this.publish({
      ...this.#snapshot,
      revision: this.#snapshot.revision + 1,
      roomEvents: [...this.#snapshot.roomEvents, event],
    });
    for (const subscription of new Set(this.#roomEventListeners)) {
      if (eventIndex >= subscription.startIndex) {
        subscription.listener(event);
      }
    }
  }

  commandCounts(): CommandCounts {
    return { ...this.#counts };
  }

  connect(): void {
    this.#counts.connect += 1;
  }

  announceAutoReveal(countdownMs: number): void {
    void countdownMs;
    this.#counts.announceAutoReveal += 1;
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

  #addRoomEventListener(listener: (event: RoomEvent) => void): () => void {
    const subscription = {
      listener,
      startIndex: this.#receivedRoomEventCount,
    };
    this.#roomEventListeners.add(subscription);
    return () => {
      this.#roomEventListeners.delete(subscription);
    };
  }
}

function roomEventHasKind<Kind extends RoomEventKind>(
  event: RoomEvent,
  kind: Kind,
): event is Extract<RoomEvent, { readonly kind: Kind }> {
  return event.kind.localeCompare(kind) === 0;
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

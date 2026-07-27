import type {
  ClientSnapshot,
  ConnectionStatus,
  PokerClient,
  RoomEvent,
  RoomEventKind,
} from "@ppoker/web-client";
import { vi } from "vitest";

export function makeSnapshot(
  overrides: Partial<ClientSnapshot> = {},
): ClientSnapshot {
  return {
    average: null,
    history: [],
    localName: "Planning Poker Billboard",
    localVote: null,
    log: [],
    roomEvents: [],
    revision: 0,
    room: null,
    roundNumber: 0,
    status: "disconnected",
    terminalError: null,
    ...overrides,
  };
}

export function snapshotWithStatus(
  status: ConnectionStatus,
  revision = 1,
): ClientSnapshot {
  return makeSnapshot({ revision, status });
}

export function createFakeClient(initial = makeSnapshot()) {
  const state: { value: ClientSnapshot } = { value: initial };
  const listeners = new Set<() => void>();
  const roomEventListeners = new Set<{
    readonly listener: (event: RoomEvent) => void;
    readonly startIndex: number;
  }>();
  let receivedRoomEventCount = 0;
  const addRoomEventListener = (
    listener: (event: RoomEvent) => void,
  ): (() => void) => {
    const subscription = { listener, startIndex: receivedRoomEventCount };
    roomEventListeners.add(subscription);
    return () => {
      roomEventListeners.delete(subscription);
    };
  };
  const subscribeRoomEvent: PokerClient["subscribeRoomEvent"] = (
    kind,
    listener,
  ) => {
    const eventListener = (event: RoomEvent): void => {
      if (roomEventHasKind(event, kind)) {
        listener(event.value);
      }
    };
    return addRoomEventListener(eventListener);
  };
  const subscribeRoomEvents: PokerClient["subscribeRoomEvents"] = (listener) =>
    addRoomEventListener(listener);
  const client = {
    getSnapshot: vi.fn<() => ClientSnapshot>(() => state.value),
    getRoomEvents: ((kind: string) =>
      state.value.roomEvents
        .filter((event) => event.kind === kind)
        .map((event) => event.value)) as PokerClient["getRoomEvents"],
    subscribe: vi.fn<(listener: () => void) => () => void>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    subscribeRoomEvent: vi.fn(
      subscribeRoomEvent,
    ) as PokerClient["subscribeRoomEvent"],
    subscribeRoomEvents: vi.fn(
      subscribeRoomEvents,
    ) as PokerClient["subscribeRoomEvents"],
    connect: vi.fn<() => void>(),
    vote: vi.fn<(value: string) => void>(),
    retractVote: vi.fn<() => void>(),
    rename: vi.fn<(name: string) => void>(),
    chat: vi.fn<(message: string) => void>(),
    announceAutoReveal: vi.fn<(countdownMs: number) => void>(),
    reveal: vi.fn<() => void>(),
    startNewRound: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    [Symbol.dispose]: vi.fn<() => void>(),
  } satisfies PokerClient;

  const publish = (snapshot: ClientSnapshot): void => {
    state.value = snapshot;
    for (const listener of new Set(listeners)) {
      listener();
    }
  };
  const publishRoomEvent = (event: RoomEvent): void => {
    const eventIndex = receivedRoomEventCount;
    receivedRoomEventCount += 1;
    publish({
      ...state.value,
      revision: state.value.revision + 1,
      roomEvents: [...state.value.roomEvents, event],
    });
    for (const subscription of new Set(roomEventListeners)) {
      if (eventIndex >= subscription.startIndex) {
        subscription.listener(event);
      }
    }
  };
  const activeListenerCount = (): number => listeners.size;
  const activeRoomEventListenerCount = (): number => roomEventListeners.size;
  return {
    activeListenerCount,
    activeRoomEventListenerCount,
    client,
    publish,
    publishRoomEvent,
  };
}

function roomEventHasKind<Kind extends RoomEventKind>(
  event: RoomEvent,
  kind: Kind,
): event is Extract<RoomEvent, { readonly kind: Kind }> {
  return event.kind.localeCompare(kind) === 0;
}

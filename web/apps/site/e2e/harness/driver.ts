import type { ClientSnapshot } from "@ppoker/web-client";

import type { CommandCounts } from "./fake-poker-client";
import { FakePokerClient } from "./fake-poker-client";
import { fixtureSnapshot, type SnapshotFixtureName } from "./fixtures";

export interface BroadcastTestDriver {
  readonly commandCounts: () => CommandCounts;
  readonly getSnapshot: () => ClientSnapshot;
  readonly navigateToRoom: (room: string) => Promise<void>;
  readonly publish: (snapshot: ClientSnapshot) => void;
  readonly publishFixture: (name: SnapshotFixtureName) => void;
  readonly sessionState: () => JoinSessionState | null;
}

export interface JoinSessionState {
  readonly activeRoom: string | null;
  readonly closeCount: number;
  readonly startCount: number;
}

interface JoinDriverControls {
  readonly navigateToRoom: (room: string) => Promise<void>;
  readonly sessionState: () => JoinSessionState;
}

declare global {
  interface Window {
    __broadcastTestDriver: BroadcastTestDriver;
  }
}

export function createBroadcastTestDriver(
  client: FakePokerClient,
  joinControls?: JoinDriverControls,
): BroadcastTestDriver {
  return {
    commandCounts: () => client.commandCounts(),
    getSnapshot: () => client.getSnapshot(),
    navigateToRoom: (room) => {
      if (joinControls === undefined) {
        throw new Error("Room navigation requires the join harness.");
      }
      return joinControls.navigateToRoom(room);
    },
    publish: (snapshot) => {
      client.publish(snapshot);
    },
    publishFixture: (name) => {
      client.publish(fixtureSnapshot(name));
    },
    sessionState: () => joinControls?.sessionState() ?? null,
  };
}

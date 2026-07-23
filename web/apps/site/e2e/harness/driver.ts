import type { ClientSnapshot } from "@ppoker/web-client";

import type { CommandCounts } from "./fake-poker-client";
import { FakePokerClient } from "./fake-poker-client";
import { fixtureSnapshot, type SnapshotFixtureName } from "./fixtures";

export interface BroadcastTestDriver {
  readonly commandCounts: () => CommandCounts;
  readonly getSnapshot: () => ClientSnapshot;
  readonly publish: (snapshot: ClientSnapshot) => void;
  readonly publishFixture: (name: SnapshotFixtureName) => void;
}

declare global {
  interface Window {
    __broadcastTestDriver: BroadcastTestDriver;
  }
}

export function createBroadcastTestDriver(
  client: FakePokerClient,
): BroadcastTestDriver {
  return {
    commandCounts: () => client.commandCounts(),
    getSnapshot: () => client.getSnapshot(),
    publish: (snapshot) => {
      client.publish(snapshot);
    },
    publishFixture: (name) => {
      client.publish(fixtureSnapshot(name));
    },
  };
}

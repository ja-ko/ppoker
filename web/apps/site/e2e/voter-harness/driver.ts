import type { ClientSnapshot } from "@ppoker/web-client";

import type { VoterCommandRecord } from "./fake-poker-client";
import { FakeVoterPokerClient } from "./fake-poker-client";
import { voterFixtureSnapshot, type VoterFixtureName } from "./fixtures";

export interface VoterTestDriver {
  readonly commands: () => readonly VoterCommandRecord[];
  readonly getSnapshot: () => ClientSnapshot;
  readonly publish: (snapshot: ClientSnapshot) => void;
  readonly publishFixture: (name: VoterFixtureName) => void;
}

declare global {
  interface Window {
    __voterTestDriver: VoterTestDriver;
  }
}

export function createVoterTestDriver(
  client: FakeVoterPokerClient,
): VoterTestDriver {
  return Object.freeze({
    commands: () => client.commands(),
    getSnapshot: () => client.getSnapshot(),
    publish: (snapshot: ClientSnapshot) => {
      client.publish(snapshot);
    },
    publishFixture: (name: VoterFixtureName) => {
      client.publish(voterFixtureSnapshot(name));
    },
  });
}

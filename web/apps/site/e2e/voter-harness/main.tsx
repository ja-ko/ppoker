import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../src/styles.css";
import { VotingApp } from "../../src/voting/VotingApp";
import { createVoterNameSession } from "../../src/voting/voter-session";
import { createVoterTestDriver } from "./driver";
import { FakeVoterPokerClient } from "./fake-poker-client";
import { isVoterFixtureName, voterFixtureSnapshot } from "./fixtures";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) {
  throw new Error("Voter E2E harness root element not found.");
}

const requestedFixture = new URLSearchParams(window.location.search).get(
  "fixture",
);
const fixtureName = isVoterFixtureName(requestedFixture)
  ? requestedFixture
  : "playing";
const client = new FakeVoterPokerClient(voterFixtureSnapshot(fixtureName));
const nameSession = createVoterNameSession({
  generateName: () => "E2E Voter",
  storage: null,
});
window.__voterTestDriver = createVoterTestDriver(client);

createRoot(rootElement).render(
  <StrictMode>
    <VotingApp
      client={client}
      connectError={null}
      initialName={nameSession.load()}
      nameSession={nameSession}
      room="VOTER-E2E"
    />
  </StrictMode>,
);

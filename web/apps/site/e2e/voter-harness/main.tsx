import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../src/styles.css";
import {
  useScreenWakeLock,
  type ScreenWakeLockControl,
} from "../../src/voting/screen-wake-lock";
import { VotingApp } from "../../src/voting/VotingApp";
import { createVoterNameSession } from "../../src/voting/voter-session";
import { createVoterTestDriver } from "./driver";
import { FakeVoterPokerClient } from "./fake-poker-client";
import { isVoterFixtureName, voterFixtureSnapshot } from "./fixtures";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) {
  throw new Error("Voter E2E harness root element not found.");
}

const searchParams = new URLSearchParams(window.location.search);
const requestedFixture = searchParams.get("fixture");
const fixtureName = isVoterFixtureName(requestedFixture)
  ? requestedFixture
  : "playing";
const client = new FakeVoterPokerClient(voterFixtureSnapshot(fixtureName));
const nameSession = createVoterNameSession({
  generateName: () => "E2E Voter",
  storage: null,
});
window.__voterTestDriver = createVoterTestDriver(client);

function VoterHarness() {
  return searchParams.get("wakeLock") === "coordinator" ? (
    <CoordinatedVoterHarness />
  ) : (
    <VotingFixture wakeLock={{ request: () => undefined, status: "held" }} />
  );
}

function CoordinatedVoterHarness() {
  const wakeLock = useScreenWakeLock(true);
  return <VotingFixture wakeLock={wakeLock} />;
}

function VotingFixture({
  wakeLock,
}: {
  readonly wakeLock: ScreenWakeLockControl;
}) {
  return (
    <VotingApp
      client={client}
      connectError={null}
      initialName={nameSession.load()}
      nameSession={nameSession}
      onReconnect={() => undefined}
      room="VOTER-E2E"
      wakeLock={wakeLock}
    />
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <VoterHarness />
  </StrictMode>,
);

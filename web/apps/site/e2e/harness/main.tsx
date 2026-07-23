import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BroadcastApp } from "../../src/BroadcastApp";
import "../../src/styles.css";
import { createBroadcastTestDriver } from "./driver";
import { FakePokerClient } from "./fake-poker-client";
import { fixtureSnapshot, isSnapshotFixtureName } from "./fixtures";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) {
  throw new Error("E2E harness root element not found.");
}

const requestedFixture = new URLSearchParams(window.location.search).get(
  "fixture",
);
const fixtureName = isSnapshotFixtureName(requestedFixture)
  ? requestedFixture
  : "playing";
const client = new FakePokerClient(fixtureSnapshot(fixtureName));
window.__broadcastTestDriver = createBroadcastTestDriver(client);

createRoot(rootElement).render(
  <StrictMode>
    <BroadcastApp client={client} connectError={null} room="E2E-ROOM" />
  </StrictMode>,
);

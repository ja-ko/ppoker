import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import { BroadcastMotionConfig } from "../../src/animation";
import { bindSessionsToRouter, createSiteRoutes } from "../../src/app-router";
import { BroadcastApp } from "../../src/BroadcastApp";
import { createBroadcastSessionManager } from "../../src/broadcast-session";
import { createClientLifecycle } from "../../src/client-lifecycle";
import "../../src/styles.css";
import { createVoterNameSession } from "../../src/voting/voter-session";
import { createVotingSessionManager } from "../../src/voting-session";
import { createBroadcastTestDriver } from "./driver";
import { FakePokerClient } from "./fake-poker-client";
import { fixtureSnapshot, isSnapshotFixtureName } from "./fixtures";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (rootElement === null) {
  throw new Error("E2E harness root element not found.");
}

const search = new URLSearchParams(window.location.search);
const requestedFixture = search.get("fixture");
const joinMode = search.get("mode") === "join";
const fixtureName = isSnapshotFixtureName(requestedFixture)
  ? requestedFixture
  : "playing";
const client = new FakePokerClient(
  fixtureSnapshot(joinMode ? "connecting" : fixtureName),
);

const root = createRoot(rootElement);
if (joinMode) {
  const sessionState = {
    activeRoom: null as string | null,
    closeCount: 0,
    startCount: 0,
  };
  let activeLifecycle: symbol | undefined;
  const sessions = createBroadcastSessionManager({
    bindLifecycle: () => () => undefined,
    createLifecycle: (options) => {
      const lifecycle = createClientLifecycle(options, () =>
        Promise.resolve(client),
      );
      const identity = Symbol(options.room);
      let closed = false;
      return {
        close: () => {
          if (!closed) {
            closed = true;
            sessionState.closeCount += 1;
            if (activeLifecycle === identity) {
              activeLifecycle = undefined;
              sessionState.activeRoom = null;
            }
          }
          lifecycle.close();
        },
        start: () => {
          activeLifecycle = identity;
          sessionState.activeRoom = options.room;
          sessionState.startCount += 1;
          return lifecycle.start();
        },
      };
    },
    pageTarget: window,
    reload: () => undefined,
  });
  const votingSessions = createVotingSessionManager({
    bindLifecycle: () => () => undefined,
    createLifecycle: (options) =>
      createClientLifecycle(options, () => Promise.resolve(client)),
    createNameSession: () =>
      createVoterNameSession({
        generateName: () => "E2E Voter",
        storage: null,
      }),
    pageTarget: window,
    reload: () => undefined,
  });
  const router = createBrowserRouter(
    createSiteRoutes({
      broadcastSessions: sessions,
      endpoint: "wss://e2e.test/socket",
      votingSessions,
    }),
    { basename: "/e2e/harness" },
  );
  bindSessionsToRouter(router, {
    broadcast: sessions,
    voting: votingSessions,
  });
  window.__broadcastTestDriver = createBroadcastTestDriver(client, {
    navigateToRoom: (room) =>
      router.navigate(`/room?${new URLSearchParams({ room }).toString()}`),
    sessionState: () => ({ ...sessionState }),
  });
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
} else {
  window.__broadcastTestDriver = createBroadcastTestDriver(client);
  root.render(
    <StrictMode>
      <BroadcastMotionConfig>
        <div className="site-root">
          <BroadcastApp
            client={client}
            connectError={null}
            revealAt={null}
            room="E2E-ROOM"
          />
        </div>
      </BroadcastMotionConfig>
    </StrictMode>,
  );
}

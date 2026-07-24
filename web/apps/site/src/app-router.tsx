import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import {
  Form,
  useLocation,
  useLoaderData,
  useOutlet,
  type DataRouter,
  type RouteObject,
} from "react-router";

import { BroadcastMotionConfig, joinRouteExitTransition } from "./animation";
import { BroadcastApp } from "./BroadcastApp";
import type {
  BroadcastSessionManager,
  BroadcastSessionSnapshot,
} from "./broadcast-session";
import { BillboardStatus } from "./components/BillboardStatus";
import { parseBroadcastConfig, type ConfigError } from "./config";

interface SiteRouteDependencies {
  readonly endpoint: string | undefined;
  readonly sessions: BroadcastSessionManager;
}

const ROOM_ROUTE_ID = "room";

type RoomRouteData =
  | { readonly error: ConfigError; readonly room: null }
  | { readonly error: null; readonly room: string };

export function createSiteRoutes({
  endpoint,
  sessions,
}: SiteRouteDependencies): RouteObject[] {
  const roomLoader = ({
    request,
  }: {
    readonly request: Request;
  }): RoomRouteData => {
    const result = parseBroadcastConfig(endpoint, new URL(request.url).search);
    if (!result.ok) {
      sessions.close();
      return { error: result.error, room: null };
    }
    sessions.start(result.config);
    return { error: null, room: result.config.room };
  };

  return [
    {
      Component: RootLayout,
      HydrateFallback: RootFallback,
      children: [
        { Component: JoinScreen, id: "join", index: true },
        {
          Component: () => <RoomScreen sessions={sessions} />,
          id: ROOM_ROUTE_ID,
          loader: roomLoader,
          path: "room",
        },
      ],
      id: "root",
      path: "/",
    },
  ];
}

export function bindSessionToRouter(
  router: Pick<DataRouter, "subscribe">,
  sessions: Pick<BroadcastSessionManager, "close">,
): () => void {
  return router.subscribe((state) => {
    const roomMatched = state.matches.some(
      ({ route }) => route.id === ROOM_ROUTE_ID,
    );
    if (!roomMatched) {
      sessions.close();
    }
  });
}

function RootLayout() {
  const location = useLocation();
  const outlet = useOutlet();

  return (
    <BroadcastMotionConfig>
      <div className="site-root">
        <AnimatePresence initial={false} mode="wait">
          <RouteFrame key={location.pathname}>{outlet}</RouteFrame>
        </AnimatePresence>
      </div>
    </BroadcastMotionConfig>
  );
}

function RootFallback() {
  return <div className="site-root" />;
}

function RouteFrame({ children }: { readonly children: ReactNode }) {
  const isPresent = useIsPresent();

  return (
    <motion.div
      animate={{ opacity: 1 }}
      aria-hidden={isPresent ? undefined : true}
      className="site-route"
      data-route-state={isPresent ? "active" : "exiting"}
      exit={{ opacity: 0 }}
      initial={false}
      transition={joinRouteExitTransition}
    >
      {children}
    </motion.div>
  );
}

function JoinScreen() {
  const isPresent = useIsPresent();
  const roomInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isPresent) {
      return;
    }
    const focusTimer = window.setTimeout(() => {
      roomInput.current?.focus({ preventScroll: true });
    }, 100);
    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [isPresent]);

  return (
    <main className="join-screen">
      <h1>Planning Poker Live Desk</h1>
      <Form action="/room" className="join-screen__form" method="get">
        <label className="visually-hidden" htmlFor="join-room">
          Room name
        </label>
        <input
          autoComplete="off"
          autoFocus
          disabled={!isPresent}
          id="join-room"
          name="room"
          placeholder="Enter room name"
          ref={roomInput}
          required
          type="text"
        />
        <button aria-label="Join room" disabled={!isPresent} type="submit">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      </Form>
    </main>
  );
}

function RoomScreen({
  sessions,
}: {
  readonly sessions: BroadcastSessionManager;
}) {
  const data = useLoaderData<RoomRouteData>();
  const session = useSyncExternalStore(
    sessions.subscribe,
    sessions.getSnapshot,
    sessions.getSnapshot,
  );

  if (data.error !== null) {
    return <ConfigurationError error={data.error} />;
  }
  return <SessionView expectedRoom={data.room} session={session} />;
}

function SessionView({
  expectedRoom,
  session,
}: {
  readonly expectedRoom: string;
  readonly session: BroadcastSessionSnapshot;
}) {
  if (
    session.status === "idle" ||
    session.status === "starting" ||
    session.room !== expectedRoom
  ) {
    return null;
  }
  if (session.status === "error") {
    return (
      <BillboardStatus
        announcementRole="alert"
        detail={errorMessage(
          session.error,
          "The spectator client could not be created.",
        )}
        eyebrow="Client initialization"
        phaseLabel="Unavailable"
        roomCode={session.room}
        title="Scoreboard initialization failed"
      />
    );
  }
  return (
    <BroadcastApp
      client={session.client}
      connectError={session.connectError}
      entrance
      revealAt={session.revealAt}
      room={session.room}
    />
  );
}

function ConfigurationError({ error }: { readonly error: ConfigError }) {
  const noRoom = error.code === "missing-room";
  return (
    <BillboardStatus
      announcementRole="alert"
      detail={error.message}
      eyebrow={noRoom ? "Room selection" : "Build configuration"}
      phaseLabel={noRoom ? "No room" : "Configuration"}
      title={noRoom ? "No room selected" : "Invalid scoreboard configuration"}
    />
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

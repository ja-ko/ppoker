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
import {
  parseBroadcastConfig,
  parseVotingConfig,
  type ConfigError,
} from "./config";
import { VotingApp } from "./voting/VotingApp";
import { VotingStatus } from "./voting/VotingStatus";
import type {
  VotingSessionManager,
  VotingSessionSnapshot,
} from "./voting-session";

interface SiteRouteDependencies {
  readonly broadcastSessions: BroadcastSessionManager;
  readonly endpoint: string | undefined;
  readonly votingSessions: VotingSessionManager;
}

const ROOM_ROUTE_ID = "room";
const VOTE_ROUTE_ID = "vote";

type RoomRouteData =
  | { readonly error: ConfigError; readonly room: null }
  | { readonly error: null; readonly room: string };

export function createSiteRoutes({
  broadcastSessions,
  endpoint,
  votingSessions,
}: SiteRouteDependencies): RouteObject[] {
  const roomLoader = ({
    request,
  }: {
    readonly request: Request;
  }): RoomRouteData => {
    const result = parseBroadcastConfig(endpoint, new URL(request.url).search);
    if (!result.ok) {
      broadcastSessions.close();
      return { error: result.error, room: null };
    }
    broadcastSessions.start(result.config);
    return { error: null, room: result.config.room };
  };
  const voteLoader = ({
    request,
  }: {
    readonly request: Request;
  }): RoomRouteData => {
    const result = parseVotingConfig(endpoint, new URL(request.url).search);
    if (!result.ok) {
      votingSessions.close();
      return { error: result.error, room: null };
    }
    votingSessions.start(result.config);
    return { error: null, room: result.config.room };
  };

  return [
    {
      Component: RootLayout,
      HydrateFallback: RootFallback,
      children: [
        { Component: JoinScreen, id: "join", index: true },
        {
          Component: () => <RoomScreen sessions={broadcastSessions} />,
          id: ROOM_ROUTE_ID,
          loader: roomLoader,
          path: "room",
        },
        {
          Component: () => <VotingScreen sessions={votingSessions} />,
          id: VOTE_ROUTE_ID,
          loader: voteLoader,
          path: "vote",
        },
      ],
      id: "root",
      path: "/",
    },
  ];
}

export function bindSessionsToRouter(
  router: Pick<DataRouter, "subscribe">,
  sessions: {
    readonly broadcast: Pick<BroadcastSessionManager, "close">;
    readonly voting: Pick<VotingSessionManager, "close">;
  },
): () => void {
  return router.subscribe((state) => {
    if (state.navigation.state !== "idle") {
      return;
    }
    if (!routeMatched(state.matches, ROOM_ROUTE_ID)) {
      sessions.broadcast.close();
    }
    if (!routeMatched(state.matches, VOTE_ROUTE_ID)) {
      sessions.voting.close();
    }
  });
}

function routeMatched(
  matches: DataRouter["state"]["matches"],
  routeId: string,
): boolean {
  return matches.some(({ route }) => route.id === routeId);
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
  return <BroadcastSessionView expectedRoom={data.room} session={session} />;
}

function BroadcastSessionView({
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

function VotingScreen({
  sessions,
}: {
  readonly sessions: VotingSessionManager;
}) {
  const data = useLoaderData<RoomRouteData>();
  const session = useSyncExternalStore(
    sessions.subscribe,
    sessions.getSnapshot,
    sessions.getSnapshot,
  );

  if (data.error !== null) {
    return <VotingConfigurationError error={data.error} />;
  }
  return <VotingSessionView expectedRoom={data.room} session={session} />;
}

function VotingSessionView({
  expectedRoom,
  session,
}: {
  readonly expectedRoom: string;
  readonly session: VotingSessionSnapshot;
}) {
  if (session.status === "idle" || session.room !== expectedRoom) {
    return (
      <VotingStatus
        detail="Preparing a participant connection for this room."
        room={expectedRoom}
        title="Starting voter console"
      />
    );
  }
  if (session.status === "starting") {
    return (
      <VotingStatus
        detail={`Preparing a participant connection for ${session.initialName}.`}
        room={session.room}
        title="Starting voter console"
      />
    );
  }
  if (session.status === "error") {
    return (
      <VotingStatus
        detail={errorMessage(
          session.error,
          "The participant client could not be created.",
        )}
        role="alert"
        room={session.room}
        title="Voter initialization failed"
      />
    );
  }
  return (
    <VotingApp
      client={session.client}
      connectError={session.connectError}
      initialName={session.initialName}
      nameSession={session.nameSession}
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

function VotingConfigurationError({ error }: { readonly error: ConfigError }) {
  const noRoom = error.code === "missing-room";
  return (
    <VotingStatus
      detail={error.message}
      role="alert"
      title={noRoom ? "No room selected" : "Invalid voter configuration"}
    />
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

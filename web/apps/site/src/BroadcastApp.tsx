import type { PokerClient } from "@ppoker/web-client";
import { type ReactNode, useEffect, useState } from "react";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
} from "@ppoker/web-client/react";

import { BroadcastScoreboard } from "./BroadcastScoreboard";
import { BillboardStatus } from "./components/BillboardStatus";
import { useObserverTiming } from "./observer-timing";
import { deriveScoreboardModel } from "./scoreboard-adapter";
import type { BroadcastScoreboardModel } from "./scoreboard-model";

export interface BroadcastAppProps {
  readonly client: PokerClient;
  readonly connectError: unknown;
  readonly entrance?: boolean;
  readonly revealAt: number | null;
  readonly room: string;
}

export function BroadcastApp({
  client,
  connectError,
  entrance = false,
  revealAt,
  room,
}: BroadcastAppProps) {
  return (
    <PokerClientProvider client={client}>
      <BroadcastClientView
        connectError={connectError}
        entrance={entrance}
        revealAt={revealAt}
        room={room}
      />
    </PokerClientProvider>
  );
}

interface BroadcastRevealGateProps {
  readonly children: (scoreboard: BroadcastScoreboardModel) => ReactNode;
  readonly revealAt: number | null;
  readonly scoreboard: BroadcastScoreboardModel | null;
}

export function BroadcastRevealGate({
  children,
  revealAt,
  scoreboard,
}: BroadcastRevealGateProps) {
  const [gateOpen, setGateOpen] = useState(
    () => revealAt === null || Date.now() >= revealAt,
  );
  const deadlinePassed = revealAt === null || Date.now() >= revealAt;

  useEffect(() => {
    if (revealAt === null) {
      setGateOpen(true);
      return;
    }
    const remaining = revealAt - Date.now();
    if (remaining <= 0) {
      setGateOpen(true);
      return;
    }

    setGateOpen(false);
    const timer = window.setTimeout(() => {
      setGateOpen(true);
    }, remaining);
    return () => {
      window.clearTimeout(timer);
    };
  }, [revealAt]);

  return (gateOpen || deadlinePassed) && scoreboard !== null
    ? children(scoreboard)
    : null;
}

interface BroadcastClientViewProps {
  readonly connectError: unknown;
  readonly entrance: boolean;
  readonly revealAt: number | null;
  readonly room: string;
}

export function BroadcastClientView({
  connectError,
  entrance,
  revealAt,
  room,
}: BroadcastClientViewProps) {
  const snapshot = usePokerClientSnapshot();
  const timing = useObserverTiming(snapshot);
  const terminalError = snapshot.terminalError;
  const scoreboard = deriveScoreboardModel(snapshot, room, timing);

  if (terminalError !== null) {
    return (
      <BillboardStatus
        announcementRole="alert"
        detail={`${terminalError.message} (${terminalError.code})`}
        eyebrow="Terminal client error"
        phaseLabel="Offline"
        roomCode={room}
        title="Connection ended"
      />
    );
  }
  if (snapshot.status === "connecting" || snapshot.status === "disconnected") {
    if (connectError === null) {
      return null;
    }
    return (
      <BillboardStatus
        announcementRole="alert"
        detail={errorMessage(connectError)}
        eyebrow="Spectator connection"
        phaseLabel="Unavailable"
        roomCode={room}
        title="Connection failed"
      />
    );
  }
  if (snapshot.status === "closed") {
    return (
      <BillboardStatus
        announcementRole="alert"
        detail={
          connectError === null
            ? "The spectator connection closed without a terminal server error."
            : errorMessage(connectError)
        }
        eyebrow="Spectator connection"
        phaseLabel="Offline"
        roomCode={room}
        title="Connection closed"
      />
    );
  }
  if (snapshot.room?.phase === "unknown") {
    return (
      <BillboardStatus
        announcementRole="alert"
        detail="The server reported a game phase this billboard cannot display yet."
        eyebrow="Room synchronization"
        phaseLabel="Unknown"
        roomCode={room}
        title="Unknown room phase"
      />
    );
  }
  return (
    <BroadcastRevealGate revealAt={revealAt} scoreboard={scoreboard}>
      {(displayableScoreboard) => (
        <BroadcastScoreboard
          entrance={entrance}
          scoreboard={displayableScoreboard}
        />
      )}
    </BroadcastRevealGate>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The connection attempt failed.";
}

import type { PokerClient } from "@ppoker/web-client";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
} from "@ppoker/web-client/react";

import { BroadcastMotionConfig } from "./animation";
import { BroadcastScoreboard } from "./BroadcastScoreboard";
import { BillboardStatus } from "./components/BillboardStatus";
import { useObserverTiming } from "./observer-timing";
import { deriveScoreboardModel } from "./scoreboard-adapter";

interface BroadcastAppProps {
  readonly client: PokerClient;
  readonly connectError: unknown;
  readonly room: string;
}

export function BroadcastApp({
  client,
  connectError,
  room,
}: BroadcastAppProps) {
  return (
    <BroadcastMotionConfig>
      <PokerClientProvider client={client}>
        <BroadcastClientView connectError={connectError} room={room} />
      </PokerClientProvider>
    </BroadcastMotionConfig>
  );
}

interface BroadcastClientViewProps {
  readonly connectError: unknown;
  readonly room: string;
}

export function BroadcastClientView({
  connectError,
  room,
}: BroadcastClientViewProps) {
  const snapshot = usePokerClientSnapshot();
  const timing = useObserverTiming(snapshot);
  const terminalError = snapshot.terminalError;

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
  if (snapshot.status === "connecting") {
    return (
      <BillboardStatus
        detail="Waiting for the planning poker server to accept this spectator."
        eyebrow="Spectator connection"
        phaseLabel="Connecting"
        roomCode={room}
        title="Connecting to room"
      />
    );
  }
  if (snapshot.status === "disconnected") {
    return (
      <BillboardStatus
        announcementRole={connectError === null ? "status" : "alert"}
        detail={
          connectError === null
            ? "The spectator client is preparing its connection."
            : errorMessage(connectError)
        }
        eyebrow="Spectator connection"
        phaseLabel="Starting"
        roomCode={room}
        title={
          connectError === null ? "Preparing broadcast" : "Connection failed"
        }
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
  if (snapshot.room === null) {
    return (
      <BillboardStatus
        detail="Connected successfully; waiting for the first authoritative room snapshot."
        eyebrow="Room synchronization"
        phaseLabel="Waiting"
        roomCode={room}
        title="Waiting for room state"
      />
    );
  }
  if (snapshot.room.phase === "unknown") {
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

  const scoreboard = deriveScoreboardModel(snapshot, room, timing);
  if (scoreboard === null) {
    return (
      <BillboardStatus
        detail="The room snapshot is not ready for presentation."
        eyebrow="Room synchronization"
        phaseLabel="Waiting"
        roomCode={room}
        title="Waiting for scoreboard data"
      />
    );
  }
  return <BroadcastScoreboard scoreboard={scoreboard} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The connection attempt failed.";
}

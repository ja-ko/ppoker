import type { PokerClient } from "@ppoker/web-client";
import {
  PokerClientProvider,
  usePokerClient,
  usePokerClientSnapshot,
} from "@ppoker/web-client/react";

import type { MonotonicScheduler } from "./auto-reveal";
import type { RecognitionRuntime } from "./handwriting";
import { VotingRoom } from "./VotingRoom";
import { VotingStatus } from "./VotingStatus";
import type { VoterNameSession } from "./voter-session";

export interface VotingAppDependencies {
  readonly autoRevealScheduler?: MonotonicScheduler;
  readonly createRecognitionRuntime?: () => RecognitionRuntime;
}

export interface VotingAppProps extends VotingAppDependencies {
  readonly client: PokerClient;
  readonly connectError: unknown;
  readonly initialName: string;
  readonly nameSession: VoterNameSession;
  readonly onReconnect: () => void;
  readonly room: string;
}

export function VotingApp({ client, ...props }: VotingAppProps) {
  return (
    <PokerClientProvider client={client}>
      <VotingClientView {...props} />
    </PokerClientProvider>
  );
}

export function VotingClientView({
  autoRevealScheduler,
  connectError,
  createRecognitionRuntime,
  initialName,
  nameSession,
  onReconnect,
  room,
}: Omit<VotingAppProps, "client">) {
  const client = usePokerClient();
  const snapshot = usePokerClientSnapshot();

  if (snapshot.terminalError !== null) {
    return (
      <VotingStatus
        detail={`${snapshot.terminalError.message} (${snapshot.terminalError.code})`}
        role="alert"
        room={room}
        title="Connection ended"
        {...(snapshot.terminalError.code === "Transport"
          ? { action: { label: "Reconnect", onClick: onReconnect } }
          : {})}
      />
    );
  }
  if (snapshot.status === "closed") {
    return (
      <VotingStatus
        action={{ label: "Reconnect", onClick: onReconnect }}
        detail="The participant connection closed. Reconnect to continue."
        role="alert"
        room={room}
        title="Voter console offline"
      />
    );
  }
  if (snapshot.room !== null) {
    return (
      <VotingRoom
        client={client}
        initialName={initialName}
        nameSession={nameSession}
        roomCode={room}
        snapshot={snapshot}
        {...(autoRevealScheduler === undefined ? {} : { autoRevealScheduler })}
        {...(createRecognitionRuntime === undefined
          ? {}
          : { createRecognitionRuntime })}
      />
    );
  }
  if (snapshot.status === "connecting") {
    return (
      <VotingStatus
        detail="Waiting for the planning poker server to accept this participant."
        room={room}
        title="Connecting to room"
      />
    );
  }
  if (snapshot.status === "disconnected") {
    return (
      <VotingStatus
        detail={
          connectError === null
            ? "The participant connection is being prepared."
            : errorMessage(connectError)
        }
        role={connectError === null ? "status" : "alert"}
        room={room}
        title={
          connectError === null ? "Preparing connection" : "Connection failed"
        }
        {...(connectError === null
          ? {}
          : { action: { label: "Reconnect", onClick: onReconnect } })}
      />
    );
  }
  return (
    <VotingStatus
      detail="Connected; waiting for the first authoritative room snapshot."
      room={room}
      title="Synchronizing room"
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The connection attempt failed.";
}

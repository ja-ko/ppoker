import type { ClientOptions } from "@ppoker/web-client";
import type { ReactNode } from "react";

import { BroadcastApp } from "./BroadcastApp";
import {
  bindPageLifecycle,
  createClientLifecycle,
  type PokerClientLifecycle,
} from "./client-lifecycle";
import { BillboardStatus } from "./components/BillboardStatus";
import { spectatorClientOptions, type BroadcastConfig } from "./config";

export interface BroadcastRoot {
  render(children: ReactNode): void;
  unmount(): void;
}

interface BootstrapDependencies {
  readonly createLifecycle?: (options: ClientOptions) => PokerClientLifecycle;
  readonly pageTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  readonly reload: () => void;
}

export interface BroadcastBootstrap {
  dispose(): void;
}

export function startBroadcastClient(
  root: BroadcastRoot,
  config: BroadcastConfig,
  dependencies: BootstrapDependencies,
): BroadcastBootstrap {
  const lifecycle = (dependencies.createLifecycle ?? createClientLifecycle)(
    spectatorClientOptions(config),
  );
  let disposed = false;
  const render = (children: ReactNode): void => {
    if (!disposed) {
      root.render(children);
    }
  };
  const unbindPageLifecycle = bindPageLifecycle(
    lifecycle,
    dependencies.pageTarget,
    dependencies.reload,
  );

  render(
    <BillboardStatus
      detail="Loading the browser client and preparing the spectator connection."
      eyebrow="Client initialization"
      phaseLabel="Initializing"
      roomCode={config.room}
      title="Starting scoreboard"
    />,
  );
  void lifecycle.start().then(
    ({ client, connectError }) => {
      render(
        <BroadcastApp
          client={client}
          connectError={connectError}
          room={config.room}
        />,
      );
    },
    (error: unknown) => {
      render(
        <BillboardStatus
          detail={
            error instanceof Error
              ? error.message
              : "The spectator client could not be created."
          }
          eyebrow="Client initialization"
          phaseLabel="Unavailable"
          roomCode={config.room}
          title="Scoreboard initialization failed"
        />,
      );
    },
  );

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unbindPageLifecycle();
      try {
        lifecycle.close();
      } catch {
        // HMR teardown still must unmount the React root.
      } finally {
        root.unmount();
      }
    },
  };
}

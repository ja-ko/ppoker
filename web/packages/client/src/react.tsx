import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ClientSnapshot, PokerClient } from "./poker-client.js";

const PokerClientContext = createContext<PokerClient | null>(null);
const SERVER_SNAPSHOT: ClientSnapshot = Object.freeze({
  revision: 0,
  status: "disconnected",
  terminalError: null,
  room: null,
  localName: "",
  localVote: null,
  log: Object.freeze([]),
  roundNumber: 0,
  history: Object.freeze([]),
  average: null,
});
const getServerSnapshot = (): ClientSnapshot => SERVER_SNAPSHOT;

export interface PokerClientProviderProps {
  readonly children?: ReactNode;
  readonly client: PokerClient;
}

export function PokerClientProvider({
  children,
  client,
}: PokerClientProviderProps): ReactElement {
  return (
    <PokerClientContext.Provider value={client}>
      {children}
    </PokerClientContext.Provider>
  );
}

export function usePokerClient(): PokerClient {
  const client = useContext(PokerClientContext);
  if (client === null) {
    throw new Error(
      "Poker client hooks must be used within a PokerClientProvider.",
    );
  }
  return client;
}

export function usePokerClientSnapshot(): ClientSnapshot {
  const client = usePokerClient();
  return useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    getServerSnapshot,
  );
}

export type { ClientSnapshot, PokerClient } from "./poker-client.js";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PokerClientSnapshot, PokerClientStore } from "./client-store.js";

const PokerClientContext = createContext<PokerClientStore | null>(null);

export interface PokerClientProviderProps {
  readonly children?: ReactNode;
  readonly store: PokerClientStore;
}

export function PokerClientProvider({
  children,
  store,
}: PokerClientProviderProps): ReactElement {
  return (
    <PokerClientContext.Provider value={store}>
      {children}
    </PokerClientContext.Provider>
  );
}

export function usePokerClientStore(): PokerClientStore {
  const store = useContext(PokerClientContext);
  if (store === null) {
    throw new Error(
      "Poker client hooks must be used within a PokerClientProvider.",
    );
  }
  return store;
}

export function usePokerClientSnapshot(): PokerClientSnapshot {
  const store = usePokerClientStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}

export type {
  PokerClientSnapshot,
  PokerClientStore,
  PokerClientStoreOptions,
} from "./client-store.js";

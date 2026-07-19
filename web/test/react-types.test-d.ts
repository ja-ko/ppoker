import type { ComponentProps } from "react";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
  usePokerClientStore,
  type PokerClientSnapshot,
  type PokerClientStore,
  type PokerClientStoreOptions,
} from "../src/react.js";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type Assert<Value extends true> = Value;
type NotAny<Value> = IsAny<Value> extends false ? true : false;

declare const store: PokerClientStore;
declare const snapshot: PokerClientSnapshot;
const providerProperties: ComponentProps<typeof PokerClientProvider> = {
  store,
};
const options: PokerClientStoreOptions = { pollIntervalMs: 50 };
const hookStore: PokerClientStore = usePokerClientStore();
const hookSnapshot: PokerClientSnapshot = usePokerClientSnapshot();

void snapshot.room?.players[0]?.vote;
void snapshot.history[0]?.votes[0]?.name;
void snapshot.terminalError?.message;
void snapshot.log[0]?.message;
void providerProperties;
void options;
void hookStore;
void hookSnapshot;

type ReactSnapshotIsTyped = Assert<NotAny<PokerClientSnapshot>>;
type ReactStoreIsTyped = Assert<NotAny<PokerClientStore>>;
const reactSnapshotIsTyped: ReactSnapshotIsTyped = true;
const reactStoreIsTyped: ReactStoreIsTyped = true;
void reactSnapshotIsTyped;
void reactStoreIsTyped;

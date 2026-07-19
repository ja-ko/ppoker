# ppoker Web Client

`@ppoker/web-client` is the typed browser client foundation for ppoker. It wraps
the generated Rust/WASM client and provides an optional React external store,
provider, and hooks. Importing the package does not initialize WASM or open a
WebSocket. The root Rust package, core/WASM crates, and this private package use
one synchronized release version.

## Setup

Use Node.js 20.19 or newer and pnpm 10.34.5, as pinned by `package.json`.
Corepack can activate the pinned package manager:

```sh
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
```

WASM generation also requires the Rust target and `wasm-pack`. `wasm-pack`
selects the `wasm-bindgen` CLI compatible with `Cargo.lock`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
pnpm run wasm:generate
```

`wasm:generate` removes the previous generated directory before running
`wasm-pack build --target web`. Run pnpm commands in this `web` directory unless
a command below says otherwise.

## Package API

The authored base entrypoint is `@ppoker/web-client`. Initialize WASM before
constructing a client, then create and connect a store:

```ts
import {
  WasmPokerClient,
  createPokerClientStore,
  initializePpokerWasm,
} from "@ppoker/web-client";

await initializePpokerWasm();

const client = new WasmPokerClient({
  endpoint: "wss://planning.example/ws",
  room: "frontend",
  name: "Ada",
  role: "participant",
});
const store = createPokerClientStore(client);
store.connect();

const unsubscribe = store.subscribe(() => {
  console.log(store.getSnapshot());
});

unsubscribe();
store.dispose();
```

The authored React entrypoint is `@ppoker/web-client/react`:

```tsx
import type { PokerClientStore } from "@ppoker/web-client";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
  usePokerClientStore,
} from "@ppoker/web-client/react";

function Status() {
  const store = usePokerClientStore();
  const snapshot = usePokerClientSnapshot();
  return <button onClick={() => store.reveal()}>{snapshot.status}</button>;
}

function ClientView({ store }: { store: PokerClientStore }) {
  return (
    <PokerClientProvider store={store}>
      <Status />
    </PokerClientProvider>
  );
}
```

The provider does not connect, close, or dispose the store. The caller that
creates the store owns it and must call `dispose()` after its final use.
Provider unmount only removes hook subscriptions; it does not close the client.

Snapshot domain values use the `ppoker-core` model names directly: `Room`,
`Player`, `Vote`, `VoteData`, `GamePhase`, `UserType`, `LogEntry`,
`HistoryEntry`, `ConnectionStatus`, `ClientError`, and their related enums.
Log timestamps, history lengths, and the aggregate round start are finite,
JavaScript-safe millisecond `number` values. Optional snapshot values are
serialized as `null`.

## Validation

The package scripts are:

| Command                   | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm run wasm:generate`  | Regenerate ignored WASM output from a clean directory                                  |
| `pnpm run format:check`   | Check Prettier formatting                                                              |
| `pnpm run lint`           | Run ESLint with no warnings                                                            |
| `pnpm run typecheck`      | Run strict TypeScript checks without emitting                                          |
| `pnpm run declarations`   | Emit public declarations                                                               |
| `pnpm run test`           | Run Vitest                                                                             |
| `pnpm run coverage`       | Run Vitest and write frontend coverage                                                 |
| `pnpm run build`          | Clean output, regenerate WASM, emit declarations, and build both Vite entrypoints      |
| `pnpm run package:verify` | Pack and install an isolated consumer, then verify base/React and browser WASM loading |

Run the Rust and browser checks from the repository root. Headless browser
tests require Chrome/Chromium and a matching `chromedriver` on `PATH`; no live
server is used.

```sh
cargo check --workspace --all-targets
wasm-pack test --headless --chrome crates/ppoker-wasm
```

Generated files under `src/generated/`, build files under `dist/`, coverage,
package archives, and installed dependencies are disposable and ignored. Do
not edit or commit them.

## Browser WebSockets

The endpoint must be an absolute `ws://` or `wss://` URL. Pages served over
HTTPS require `wss://`, and the page's Content Security Policy must permit the
endpoint in `connect-src`. The browser controls the WebSocket `Origin`; callers
cannot override it or add arbitrary handshake headers. Browser WebSocket APIs
also cannot send protocol Ping frames, so servers must not require clients to
originate them.

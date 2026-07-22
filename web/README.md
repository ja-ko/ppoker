# Web/WASM Maintainer Guide

This directory contains the private TypeScript and React package built on the
shared Rust client. Run pnpm commands from `web/` unless noted otherwise.

## Prerequisites

Install package dependencies with `pnpm install --frozen-lockfile`. WASM
generation and browser tests also require the Rust WASM target, `wasm-pack`, and
Chrome/Chromium with a compatible WebDriver:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
```

Package browser verification launches the executable named by `CHROME_BIN`,
which defaults to `chromium`; set it to the installed browser path when that
command is unavailable.

## Daily Workflow

Use the deterministic aggregate check before pushing or reproducing web CI:

```sh
pnpm run check
```

It runs formatting checks, linting, production package verification, TypeScript
checks, Vitest with coverage, and deterministic Rust/WASM tests in headless
Chrome. It does not run either ignored live-upstream proof. Native workspace
tests are separate.

Run `pnpm run wasm:generate` after changing shared Rust models, the WASM facade,
or generated TypeScript contracts when you need fresh bindings without a full
build. Generation deletes and recreates `src/generated/ppoker-wasm/` using
`wasm-pack build --target web`.

`pnpm run build` cleans `dist/`, regenerates WASM, emits declarations, and builds
both package entrypoints. `pnpm run package:verify` performs that build, packs
and installs an offline isolated consumer, checks both public entrypoints, and
loads the packaged WASM in Chromium. The aggregate check already runs package
verification once.

## Live Upstream Checks

The two network-dependent proofs are ignored during normal Cargo and wasm-pack
runs. Run the native proof from the repository root:

```sh
cargo test --package ppoker --bin ppoker web::client::tests::real_upstream_accepts_native_participants -- --ignored --exact --nocapture
```

Run the browser/WASM proof from `web/`:

```sh
pnpm run test:wasm:live
```

Both commands require network access and the live upstream server. They use
unique rooms and bounded waits and retries. The workflow runs them as separate
`live-native` and `live-browser` jobs; branch protection should mark both jobs as
required checks.

## Package Contracts

The base entrypoint, `@ppoker/web-client`, exposes the asynchronous
`createPokerClient()` factory and its framework-neutral `PokerClient`. The React
entrypoint, `@ppoker/web-client/react`, exposes the provider and hooks. Importing
either entrypoint does not initialize WASM or open a socket. Creation initializes
WASM; callers explicitly connect the returned client.

```ts
import { createPokerClient } from "@ppoker/web-client";

const client = await createPokerClient({
  endpoint: "wss://pp.discordia.network/",
  room: "planning-room",
  name: "Browser user",
  role: "participant",
});
client.connect();

// Later:
client.close();
```

The client owns its generated WASM instance, immutable cached snapshot, polling,
subscriptions, commands, and lifecycle. Polling starts on `connect()`, runs even
without subscribers, and stops on close or a terminal failure. `poll()` remains
available for an immediate drain; callers do not need a second polling loop. The
creator must eventually call `close()` or `[Symbol.dispose]()`.

Subscriptions signal that the latest cached snapshot should be read with
`getSnapshot()`; they are not a lossless stream of revisions. Reentrant commands
may make callbacks observe a coalesced latest state or the same latest state
more than once.

`PokerClientProvider` is non-owning. Mounting and unmounting only add or remove
React subscriptions; they never connect, close, or dispose the supplied client.

Generated bindings under `src/generated/ppoker-wasm/`, production output under
`dist/`, coverage output, package archives, and `node_modules/` are disposable
and ignored. Regenerate them; do not edit or commit them.

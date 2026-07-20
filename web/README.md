# Web/WASM Maintainer Guide

This directory contains the private TypeScript and React package built on the
shared Rust client. This guide is for repository maintainers operating and
changing the web/WASM implementation.

Run pnpm commands from `web/` unless noted otherwise.

## Prerequisites

WASM generation and browser tests require the Rust WASM target, `wasm-pack`,
and Chrome/Chromium with a compatible WebDriver:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
```

The browser suite includes one bounded connection to the live upstream
Planning Poker server. Network access and upstream availability are therefore
required for the full validation gate. Package browser verification launches
the executable named by `CHROME_BIN`, which defaults to `chromium`; set it to
the installed browser path when that command is unavailable.

## Daily Workflow

Use the aggregate check before pushing and when reproducing the web CI job:

```sh
pnpm run check
```

It runs formatting, linting, the production package verification build,
TypeScript checks, Vitest with coverage, and Rust/WASM tests in headless Chrome.
The native Rust workspace suite is intentionally separate.

Run `pnpm run wasm:generate` after changing shared Rust models, the WASM facade,
or generated TypeScript contracts when you need fresh bindings without a full
build. Generation deletes and recreates `src/generated/ppoker-wasm/` using
`wasm-pack build --target web`.

`pnpm run build` cleans `dist/`, regenerates WASM, emits declarations, and
builds both package entrypoints. `pnpm run package:verify` owns that same
production build and then packs and installs an isolated consumer, checks the
base and React declarations, and loads the packaged WASM in Chromium. Run it
directly when diagnosing packaging or browser-loading failures; the aggregate
check already runs it once.

## Package Contracts

The base entrypoint, `@ppoker/web-client`, exposes explicit WASM initialization,
the authored client wrapper, and the external store. The React entrypoint,
`@ppoker/web-client/react`, exposes the provider and hooks. Importing either
entrypoint must not initialize WASM or open a socket; callers explicitly run
`initializePpokerWasm()`, construct the client, and connect it.

The store owns its client lifecycle and polling. Code that creates a store must
eventually call `dispose()`. `PokerClientProvider` is non-owning: mounting or
unmounting it does not connect, close, or dispose the supplied store.

Generated files under `src/generated/`, production output under `dist/`,
coverage output, package archives, and installed dependencies are disposable
and ignored. Do not edit or commit them.

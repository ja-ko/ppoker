# Web Client Foundation Handoff

## Status Metadata

| Item | Value |
| --- | --- |
| Branch | `web-client-rebuild` |
| Base | `a9aa2f95b90241bd742fe2e632915eb379f2b3f5` (`master` and `origin/master` at branch creation) |
| Worktree | `/home/opencode-agent/dev/ppoker` |
| State at handoff revision | `HEAD == master == origin/master`; branch has no upstream; only this handoff document is untracked |
| Primary deliverables | Portable Rust extraction, typed WASM facade, and React integration package |
| Package manager | pnpm from the first JavaScript commit |
| Coverage policy | Target at least 80% for every metric after every commit; measure and report, but do not enforce a threshold in CI yet |

## How To Use This Document

This file is an implementation handoff. Future agents should treat its requirements and restrictions as the source of truth for this branch.

- Every checklist box starts unchecked.
- Check a box only after the current branch state satisfies it.
- Implement the slices in order. Do not combine a mechanical move with a redesign.
- Keep each commit independently buildable, tested, and reviewable.
- Run coverage after each commit and target at least 80% in every applicable metric. Record the result in the commit or review handoff, but do not add `fail-under` arguments, Codecov status gates, or equivalent enforcement.
- If a required portability adaptation changes native behavior, stop and obtain explicit maintainer agreement before updating tests or snapshots.
- The abandoned `web-client` branch may be consulted for useful WASM facade, generated-type, React-store, and test ideas. It is not an implementation base and its core/session architecture is not an accepted contract.

## Feature Goal

Add a browser-consumable client foundation by mechanically extracting and adapting the existing native implementation.

The finished branch provides:

- A portable Rust crate containing the minimum existing model, protocol, and client behavior needed by both native Rust and WASM.
- A `wasm-bindgen` facade with generated, strongly typed TypeScript declarations.
- A pnpm-managed TypeScript/React package with a safe WASM lifecycle wrapper, external store, provider, and hooks.
- Focused deterministic, browser, type-contract, and package/build tests.
- Minimal CI and coverage-reporting additions required for those deliverables.

## Governing Restrictions

### Preserve The Existing Core

- Use the code on `master` as the implementation source.
- Prefer moving existing structs, enums, traits, implementations, and tests over rewriting them.
- Preserve existing names and control flow unless a concrete portability or public-API requirement makes a change necessary.
- Make pure moves in their own commits before changing the moved code. Keep source similarity high enough for Git and reviewers to recognize history.
- Keep the native `App` and TUI familiar. Extract only behavior that must be shared.
- Keep the existing `App` architecture; do not introduce a large reducer, effect system, or all-encompassing session state machine.
- Do not introduce speculative pending-command tracking, optimistic reconciliation, activity identity, connection generations, capability matrices, or reconnect scheduling.
- Do not add backward-compatibility layers for code that has not shipped.
- Do not move test implementations into companion files merely to influence coverage measurement.

### Preserve Native Behavior

- Existing keyboard behavior, room rendering, history rendering, logs, auto-reveal behavior, and command behavior are the baseline.
- Existing TUI snapshots should remain byte-for-byte unchanged unless a separately reviewed requirement necessitates a visible change.
- Test fixtures must use consistent names and room values. Fixture-value changes alone do not justify snapshot regeneration.
- Native update checking and self-update behavior are unrelated and must not be modified.
- The dependency baseline is the manifests and lockfile at `a9aa2f95b90241bd742fe2e632915eb379f2b3f5`. Preserve the existing platform-specific `self_update` manifest declarations and updater API, and generate lockfiles only with Cargo from those declarations so both platform graphs remain resolvable.
- Keep the current stable, platform-specific `self_update` dependencies and updater API unchanged.
- Keep release workflows, release runners, and release behavior unchanged. In particular, do not raise the Linux build environment above Ubuntu 22.04.

### Keep Notifications Native

- `disable_notifications` is native configuration and remains owned by the native application.
- Focus tracking for notification eligibility remains native.
- Notification timers, `NotificationHandler`, terminal bell behavior, and desktop notification delivery remain native.
- WASM connection options must not contain `notificationsEnabled` or an equivalent setting.
- WASM snapshots must not expose a notification condition.
- The WASM command API must not expose `setFocus`.
- Do not add a `notifyLastVoteMissing` browser event.

### Authoritative Ownership Boundary

- `Session<C: PokerClient>` owns its backend. Native `App`, the WASM facade, and future consumers must not retain and coordinate a separate client beside shared session state.
- `ppoker-core` is the sole authoritative owner of normalized room state, local identity and vote state required by shared commands, protocol/activity log collection and server-log deduplication, current round tracking, completed-round history, and statistics.
- The native application retains notification eligibility, focus tracking, notification timers and delivery, changelog state, content, and configuration, and all auto-reveal state and behavior.
- Notification, focus, changelog, and auto-reveal concerns must not appear in core configuration, WASM options, snapshots, commands, events, or authored web APIs. The ordinary manual reveal command remains part of the shared command contract.
- “Protocol/activity log” means the existing room activity associated with upstream messages and shared client behavior. It does not mean native diagnostic logging, file logging, or the `tui_logger` view implemented by `LogPage`; those remain native.
- Native-only presentation messages may be layered over the shared protocol/activity log by the TUI when required to preserve existing behavior. Notification-, changelog-, and auto-reveal-specific records must not enter shared state or the WASM API.
- The native `App` may retain familiar adapter methods and projections for the TUI, but it must not maintain a second authoritative copy of shared room, history, round, or protocol/activity-log state.

### Keep Changes In Scope

- Do not migrate `self_update` to a release candidate.
- Do not add a direct `self-replace` dependency.
- Do not perform general dependency modernization.
- Do not pin GitHub Actions to commit SHAs.
- Do not add a Dependabot ecosystem for GitHub Actions.
- Keep the existing CI files structurally intact and limit additions to focused WASM/web validation; do not create a repository-wide quality matrix.
- Do not add repository-wide coverage enforcement, cargo-audit enforcement, or unrelated quality gates.
- Keep the root `README.md` as end-user documentation. Change it only for end-user-visible installation, configuration, or usage; do not turn it into a developer guide.
- Do not add an OpenCode skill for this work.

## Target Repository Shape

The exact internal file split may stay smaller if that improves similarity to the existing code. New abstractions require a concrete use in both the native and WASM paths.

```text
Cargo.toml
crates/
  ppoker-core/
    Cargo.toml
    src/
      lib.rs
      models.rs or model.rs
      protocol.rs
      client.rs
      transport.rs              # only if a separate boundary is necessary
  ppoker-wasm/
    Cargo.toml
    src/lib.rs
src/                            # native App, TUI, config, notifications, updater
web/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
  eslint.config.js
  prettier.config.js
  vite.config.ts
  vitest.config.ts
  README.md
  src/
    generated/ppoker-wasm/      # ignored wasm-pack output
    wasm-client.ts
    client.ts
    context.tsx
    index.ts
  test/
```

There must be one normalized Rust representation of rooms, players, votes, phases, and history. Wire DTOs remain private. TypeScript consumes generated declarations or authored wrappers around those declarations; it must not maintain a handwritten duplicate domain model.

- Keep `default-members = ["."]` so existing unqualified native build and release commands continue to target the root package.
- Keep explicit synchronized versions on the root package, `ppoker-core`, and `ppoker-wasm`; release-please's Rust strategy updates the Cargo manifests and lockfile. The member crates remain unpublished and path dependencies remain unversioned.
- Keep the private web package version synchronized with the Rust release by listing `web/package.json` as an extra release-please JSON file. npm publication is not part of this feature.

## Required Functional Contracts

### Existing Domain Model

- Preserve the semantics of the existing `Room`, `Player`, vote, phase, user-role, log, and history types.
- Add serde and TypeScript-facing derives only where required.
- Follow the shared-time contract below for history, round, and protocol/activity-log values. Shared core types serialize their time fields as JavaScript-safe milliseconds for WASM consumers.
- Preserve player and vote ordering used by the TUI.
- Represent a numeric average as `Option<f32>` in shared state. No numeric votes means `None`, serialized to JavaScript as `null`; the native presentation adapter may preserve legacy rendering where necessary to keep existing snapshots unchanged.
- Rust integer fields exposed to JavaScript must remain within JavaScript's safe integer range and generate TypeScript `number`, not `BigInt`.

### Shared Time And Statistics

- `ppoker-core` uses a mandatory injected monotonic clock for shared protocol/activity-log timestamps, round starts, and completed-round durations.
- The native clock uses an `Instant` baseline. The WASM clock uses the browser monotonic clock. Deterministic tests use a manually advanced fake clock.
- Native notification and auto-reveal timers continue to use native `Instant` values and do not use the core clock.
- Shared models store clock-relative ticks and durations rather than serializing `Instant`.
- WASM serialization exposes finite integral milliseconds as JavaScript `number` values after checking the safe-integer range. It must not expose `Instant`, `Duration`, `u64`/`BigInt`, `NaN`, or infinity.
- The aggregate snapshot contains fixed round fields such as the round number and round-start tick. Do not include a continuously changing elapsed-duration value; consumers may derive elapsed time from the fixed start tick.
- Completed-round durations are fixed values and may be included in history.
- Reading a snapshot or advancing time alone never changes its revision.

### Protocol Boundary

- Keep upstream JSON DTOs and request tags private to the protocol module.
- Normalize upstream room, user, phase, vote-sentinel, and log fields into the shared model.
- Encode the existing commands: vote, retract vote, rename, chat, reveal, and start new round.
- Treat inbound room messages as authoritative full snapshots, matching current server behavior.
- Do not invent server acknowledgements, stable upstream IDs, or history that the protocol does not provide.
- A transport send indicates only that the message was handed to the transport. It is not server acknowledgement.
- Treat an endpoint as an absolute `ws:` or `wss:` base URL. Reject credentials, query strings, fragments, unsupported schemes, and invalid URLs during synchronous option validation.
- Preserve the endpoint base path, remove trailing path separators, and append the `rooms` path segment followed by the raw room value encoded exactly once as one path segment.
- Encode the raw name exactly once as the `user` query value. Append query parameters in the order `user`, then `userType`.
- Map participant and spectator roles to the exact upstream `userType` values `PARTICIPANT` and `SPECTATOR`.
- Keep the native CLI participant-only; do not add a native role option in this feature. The shared connection input and WASM options expose participant and spectator roles.
- Removing the current accidental double slash for endpoints with a trailing slash is an approved correctness adaptation.
- URL fixtures cover root and nested base paths, trailing slashes, `%`, `/`, `?`, `#`, `&`, `=`, spaces, and Unicode in room and name values.
- Spectators may use commands the server already permits, including rename and chat. Do not add a global read-only spectator switch.
- Unknown upstream enum values must not panic. Preserve an explicit unknown value or skip only data that has no safe normalized representation.

### Portable Client Behavior

- Begin from the existing `PokerClient` and `App` behavior and extract the smallest reusable boundary.
- Route commands through the backend owned by `Session`; command APIs do not accept a separately owned client.
- Use `Session::update()` to poll and apply backend updates, or `Session::update_with(...)` to observe each already-applied room transition for consumer policy such as TUI notifications and auto-reveal handling.
- Allow an initial snapshot only through `Session::with_room_snapshot` for bounded native startup; subsequent authoritative state enters exclusively through the owned backend update path.
- Keep update observation generic. Core owns lifecycle, terminal errors, shared state, and one visible revision increment at most per connect, update batch, command, or close operation.
- Keep native-only fields and behavior in native `App`; do not force all application state into the portable crate.
- Share command validation and room-update behavior only when doing so avoids a real native/WASM duplication.
- Move existing history, round tracking, protocol/activity logging, and statistics into `ppoker-core` while preserving their native semantics. Keep all auto-reveal behavior in the native application.
- Apply each authoritative room snapshot to shared state before the native adapter evaluates notification and auto-reveal effects. Preserve the existing observable ordering of phase, history, notification, and auto-reveal behavior.
- Do not add automatic reconnect behavior in this feature.
- Do not add a pending-command subsystem. The upstream protocol cannot confirm commands.
- Do not fabricate phase changes, other users, server logs, or completed rounds before an authoritative room snapshot arrives.
- Surface protocol, connection, and command failures through a small structured error type suitable for JavaScript.
- Keep connection lifecycle explicit enough for browser use: construction, connect, poll, snapshot, command dispatch, and terminal close.
- Closing must release the sender/receiver and be idempotent at the authored consumer boundary.

### Lifecycle And Snapshot Contract

- Importing the authored package has no initialization, network, or socket side effects.
- The web package exports an explicit asynchronous `initializePpokerWasm()` operation. Concurrent and repeated successful calls share one initialization result.
- After initialization, constructing `WasmPokerClient` is synchronous: it validates options and creates shared client state, but it does not open a socket.
- The initial snapshot has revision `0`, connection status `disconnected`, `room: null`, no terminal error, and empty log and history collections.
- `connect()` creates the transport exactly once and changes status to `connecting`. Repeated calls while connecting or open are idempotent. Calls after terminal close throw a structured `Closed` error.
- No application message is sent before the transport reports `opened`. Commands require an open connection and any authoritative room state needed for their validation; otherwise they throw a structured `NotReady` error.
- Public connection states are `disconnected`, `connecting`, `open`, and `closed`. A terminal asynchronous transport or protocol failure is retained as a structured optional error on the closed snapshot.
- `poll()` drains the internal transport-event queue without blocking and returns whether the externally visible snapshot changed. It returns `false` after terminal close.
- A poll batch commits at most one new externally visible snapshot revision, even if it drains multiple transport events. An unchanged poll and a snapshot read do not increment the revision.
- `close()` and `[Symbol.dispose]()` are synchronous and idempotent. The first effective close releases transport handles and callbacks and changes the snapshot and revision once. Later close callbacks, close calls, or disposal calls do not change it again.
- After close, snapshots remain readable, polling returns `false`, subscriptions may be removed safely, and all commands throw a structured `Closed` error.
- There is no public retained event queue in this foundation. Asynchronous terminal errors are represented in the snapshot.
- Structured JavaScript errors are actual `Error` objects with stable `code` and `message` fields and optional structured details.
- Native startup preserves the existing bounded initial-room wait and failure behavior; the asynchronous browser lifecycle does not alter native startup.

### Transport

- Extract a narrow transport boundary that allows the existing native socket implementation and a browser-compatible implementation to drive the same portable client behavior.
- Keep `ppoker-core` free of concrete native and browser WebSocket implementations. Define only the shared transport contract and deterministic fake there.
- Preserve the current native transport and its behavior by default. Replacing it requires a demonstrated portability need and explicit maintainer approval.
- Retain the sender for the connection lifetime and poll receiver events without blocking browser execution.
- Do not send application data before the socket reports opened.
- Handle text, opened, closed, and error events. Ignore or diagnose unsupported binary data without corrupting state.
- Preserve the existing native Ping behavior. Do not require or emulate protocol Ping frames in the browser transport because browser WebSocket APIs cannot originate them.
- Native WSS must remain functional. If a new native transport is explicitly approved, configure TLS deliberately and inspect the resolved dependency tree.
- Keep transport details and concrete handles out of public snapshots and generated TypeScript declarations.

### WASM Facade

The facade must provide safe lifecycle and conversion behavior over the owning shared `Session`.

- Add `crates/ppoker-wasm` as a workspace `cdylib`/`rlib` crate.
- Keep the facade thin: convert typed values, delegate to the portable client, and convert errors.
- Generate TypeScript declarations from Rust with maintained released tooling where possible.
- Enable optional Tsify support on `ppoker-core` from `ppoker-wasm` and generate declarations for the shared core models directly. Use `serde-wasm-bindgen` for runtime structured-value conversion; do not use Tsify's `into_wasm_abi` or `from_wasm_abi` conversion paths.
- Do not use deprecated or known-leaking wasm-bindgen conversion paths.
- Avoid unreleased Git dependencies. If no released dependency can safely implement a required conversion, stop for maintainer approval before adding an immutable Git revision and document its age, reviewed delta, license, risk, and replacement condition.
- Export structured JS values rather than JSON strings.
- Export a typed options object containing endpoint, room, name, role, and only other portable client preferences that are actually implemented.
- Export typed commands for vote, retract, rename, chat, reveal, and start new round.
- Export a minimal aggregate snapshot containing the core connection error/status, room, local vote, logs, and history directly, plus local name, round fields, average, and a monotonically changing revision suitable for an external store. Do not add parallel WASM domain snapshot types or compatibility aliases.
- Do not expose notification, focus, changelog, auto-reveal, or diagnostic-log configuration or state, nor speculative capabilities, pending commands, or reconnect state.
- Validate malformed options synchronously and return a stable structured JavaScript `Error`.
- Implement the concrete browser transport in `ppoker-wasm` with `web-sys::WebSocket`. Retain all open, message, error, and close callback closures for the connection lifetime; unregister them during terminal cleanup before releasing the closures and socket handle.
- Preserve native `tungstenite`; do not introduce a second native transport stack or require browser Ping support.
- Keep generated wasm-bindgen `free()` and raw ABI details behind an authored TypeScript wrapper.
- The authored wrapper must provide idempotent `close()` and `[Symbol.dispose]()` and deterministic post-close behavior.
- Generated WASM output is ignored, disposable build output. Never hand-edit or commit it.
- Regenerate from a clean generated directory before type checks, tests, and builds.

### React Integration Package

- Manage the package with pnpm from its first commit.
- Add an authored `WasmPokerClient` wrapper that owns the generated instance and hides raw generated exports.
- Add an injectable client port so store tests do not require a real browser socket.
- Add `createPokerClientStore` with `getSnapshot`, `getServerSnapshot`, `subscribe`, explicit polling/connection/command methods, and deterministic disposal.
- Cache snapshot object identity while its revision is unchanged.
- Expose deeply readonly snapshots and prevent consumers from corrupting the cached state.
- Start one polling interval when the first subscriber attaches, share it across subscribers, stop it after the last subscriber leaves, and always stop it on disposal.
- Notify state subscribers once per revision change and not for an unchanged poll.
- Keep command helpers as thin typed delegation; do not duplicate Rust command policy in TypeScript.
- Add `PokerClientProvider`, `usePokerClientStore`, and `usePokerClientSnapshot` using React's external-store contract.
- Ensure provider/hook behavior is balanced under React Strict Mode.
- `PokerClientProvider` receives an existing store and does not own, connect, close, or dispose it. The caller that creates the store is responsible for its final `dispose()`.
- Provider unmount removes only its hook subscriptions. Removing the last subscriber stops polling but does not close the client.
- `getServerSnapshot()` returns a stable, deeply immutable initial disconnected snapshot and performs no WASM initialization, polling, or connection.
- Recursively freeze authored snapshots before caching them, and expose their public type as deeply readonly.
- Keep React as a peer dependency, externalize it from the Vite library bundle, and use compatible React development dependencies for tests.
- Add an event API only if the implemented portable client has a concrete non-notification asynchronous event that cannot be represented by snapshot or thrown error. Do not introduce a speculative retained event queue.
- Export only the authored package entrypoints. Do not export the raw generated module.
- Build the package with Vite and verify that a clean built package can initialize its included WASM through the authored entrypoint.
- Generate WASM from a clean ignored directory with `wasm-pack build --target web`.
- Run `tsc --emitDeclarationOnly` as an explicit build step; Vite is not responsible for public declaration output.
- Ensure the built package emits or includes its generated `.wasm` asset without referring to repository source paths at runtime.
- Verify the package by creating a tarball, installing it into an isolated consumer fixture, importing only the public entrypoint, initializing the packaged WASM, and performing a no-network construct, snapshot, and close cycle.
- Keep the package private; npm publication is not required.

## Dependency And Supply-Chain Policy

### pnpm

- Use a pnpm release supported by Dependabot and containing `minimumReleaseAge` support.
- Pin the selected pnpm version in `packageManager`; the selected pnpm release itself must be at least five days old when introduced.
- Set `minimumReleaseAge: 7200` minutes in `pnpm-workspace.yaml`.
- The age policy applies to direct and transitive packages.
- Do not add broad `minimumReleaseAgeExclude` exceptions. A specific exception requires maintainer approval.
- Commit `pnpm-lock.yaml` and use frozen-lockfile installs in CI.
- Do not create `package-lock.json` or `yarn.lock`.

### Dependabot

- Keep the existing Cargo updater.
- Add an `npm` ecosystem entry for `/web`; Dependabot uses this ecosystem name for pnpm lockfiles.
- Keep the existing weekly Saturday schedule and grouped-update style.
- Add `cooldown.default-days: 5` to normal Cargo and web dependency version updates.
- Security updates may bypass the five-day cooldown.
- Do not add the `github-actions` ecosystem.

### Dependency Selection

- Select released stable dependencies whenever possible.
- New normal dependencies should have been publicly released for at least five days when selected.
- Keep dependency additions limited to the feature.
- Review lockfile changes for duplicate transport/TLS stacks and unexpected native-only dependencies in WASM builds.

## Testing And Coverage Policy

### Per-Commit Policy

Every commit must leave the branch buildable and tested. Commits that change behavior must include corresponding tests; pure move commits preserve and run the existing tests.

- Target at least 80% Rust line, region, and function coverage after each Rust commit.
- Target at least 80% frontend line, branch, function, and statement coverage after each frontend commit.
- Measure and report these values during implementation and review.
- Do not enforce these targets with `--fail-under`, Vitest threshold failure, Codecov statuses, or branch-protection changes in this feature.
- Do not restructure production or test source files solely to improve what coverage tools count.
- Coverage reports must exclude generated WASM glue and build output, but authored adapters remain included.

### Required Rust Tests

- Existing native unit and snapshot tests continue to pass unchanged.
- Model serialization tests cover direct core model names, JavaScript-safe generated shapes, and absent averages.
- Protocol tests cover every command and representative full room payloads.
- Protocol tests cover participant/spectator URLs, hostile path/query characters, Unicode, and unknown wire enum values.
- Transport tests use a deterministic fake and cover opened-before-send, text delivery, close, errors, and cleanup.
- Shared-clock tests cover protocol/activity timestamps, round starts, completed-round durations, and the rule that time advancement alone does not change a snapshot revision.
- Portable behavior tests cover shared commands, authoritative room updates, protocol/activity-log deduplication, round transitions, history, and statistics.
- Auto-reveal, notification, focus, changelog, and native diagnostic-log tests remain native.
- WASM facade unit tests cover serialization, delegation, structured errors, and close behavior without mirrored domain conversions.
- Deterministic wasm-bindgen browser tests cover structured values and both connection roles with fake WebSockets.
- One small bounded headless-Chrome test uses the real browser `WebSocket` to join a unique room on `wss://pp.discordia.network/` as a participant.
- Keep the existing live upstream tests working. Any new live test must remain small and bounded by deadlines; do not reorganize existing tests solely for coverage.

### Required Frontend Tests

- Strict declaration fixtures traverse representative generated nested types and discriminated unions without `any` or handwritten duplicates.
- WASM wrapper tests cover explicit initialization, invalid options, idempotent close/dispose, post-close behavior, and private raw ABI.
- Store tests cover stable snapshot identity, one subscriber update per revision, unchanged polls, one shared interval, unsubscribe cleanup, disposal, command delegation, and consumer immutability.
- Provider/hook tests cover missing-provider errors, snapshot updates, non-owning unmount cleanup, and Strict Mode balance.
- Build/package verification starts from clean generated and distribution output and exercises only the authored entrypoint from an isolated installation of the packaged WASM.

## CI And Codecov Policy

- Keep existing native build, release, release-please, and Rust coverage workflows structurally unchanged.
- Use existing action version tags rather than introducing SHA pins.
- Add only the steps or one focused workflow needed for WASM and web validation.
- Use Ubuntu 22.04 for any new Linux build job unless there is a concrete reason otherwise.
- Treat `pnpm run check` as the local and CI source of truth for web/WASM validation. It runs formatting, ESLint, deep package verification, `tsc --noEmit`, Vitest through coverage once, and wasm-pack Chrome tests once; package verification owns the production WASM/declaration/Vite build.
- Do not add a native OS matrix, cargo-audit gate, fixed repository-wide tool suite, or strict coverage gate.
- Keep `codecov.yml` defaults: range `55..75`, round down, precision 2, project status off, patch status off, and comments off.
- Add only frontend-specific Codecov reporting configuration: a distinct frontend flag/path rooted at tracked `web` sources and exclusions for generated WASM/build output.
- Keep Rust and frontend uploads distinguishable.
- Frontend coverage upload is reporting-only.
- Ensure frontend lcov source paths are repository-relative and match tracked `web` paths.

## Documentation Policy

- Keep the root `README.md` focused on end-user installation, configuration, and usage. Put the web/WASM maintainer workflow in `web/README.md`.
- Keep `web/README.md` concise and maintainer-oriented: non-standard prerequisites, daily generation/build/check operations, package lifecycle contracts, and disposable generated files.
- Keep architecture rationale short and local to the code/package it supports.
- Do not copy this handoff, review evidence, CI details, release policy, or agent instructions into user-facing documentation.

## Implementation Slices

### Slice 1: Mechanical Portable Model Extraction

**Suggested commit subject:** `refactor(core): move portable client models`

#### Implementation

- [x] [IMPLEMENTER] Convert the root manifest into a Cargo workspace without changing root binary or release behavior.
- [x] [IMPLEMENTER] Add `ppoker-core` with only dependencies required by the moved model.
- [x] [IMPLEMENTER] Move existing portable model definitions with minimal edits and update imports.
- [x] [IMPLEMENTER] Keep native-only model values native and expose shared core models directly where they are WASM-safe.
- [x] [IMPLEMENTER] Preserve existing ordering and display implementations.
- [x] [IMPLEMENTER] Keep existing tests recognizable and do not relocate unrelated test modules.

#### Acceptance

- [x] [TEST] Native tests pass without snapshot updates.
- [x] [TEST] `ppoker-core` checks for `wasm32-unknown-unknown`.
- [x] [TEST] Rust coverage is measured and targets at least 80% for lines, regions, and functions without enforcement.
- [x] [REVIEW] The diff is predominantly recognizable moves/import changes and contains no new session architecture.

### Slice 2: Private Protocol Extraction

**Suggested commit subject:** `refactor(protocol): isolate portable wire adapter`

#### Implementation

- [x] [IMPLEMENTER] Move existing DTO/request conversion into a private protocol module before redesigning it.
- [x] [IMPLEMENTER] Add only the normalization and URL adaptations required by the shared model and connection roles.
- [x] [IMPLEMENTER] Keep upstream sentinel/request details private.
- [x] [IMPLEMENTER] Preserve exact command JSON and full-snapshot behavior.

#### Acceptance

- [x] [TEST] Deterministic protocol fixtures cover decode, encode, unknown values, and URL safety.
- [x] [TEST] Existing native command behavior remains unchanged.
- [x] [TEST] Rust coverage is measured and targets at least 80% in every Rust metric without enforcement.
- [x] [REVIEW] No wire DTO is exposed to TUI, WASM, or TypeScript consumers.

### Slice 3: Minimal Portable Client And Transport

**Suggested commit subject:** `refactor(client): extract portable websocket client`

#### Implementation

- [x] [IMPLEMENTER] Extract the smallest shared behavior from existing `PokerClient`/`App` code.
- [x] [IMPLEMENTER] Introduce the shared transport boundary and mandatory monotonic clock used by both native and WASM clients.
- [x] [IMPLEMENTER] Preserve the existing native `tungstenite` socket behind the shared transport boundary and add a deterministic fake transport. Keep concrete browser WebSocket code out of `ppoker-core`.
- [x] [IMPLEMENTER] Move authoritative room state, protocol/activity logging, round tracking, completed-round history, and statistics into `ppoker-core`.
- [x] [IMPLEMENTER] Keep native notifications, focus, changelog, auto reveal, diagnostic logging, and their state and delivery outside `ppoker-core`.
- [x] [IMPLEMENTER] Keep native `App` methods and TUI reads as close to their original form as practical.
- [x] [IMPLEMENTER] Make `Session` own its backend and expose generic update observation while keeping TUI reactions in `App`.
- [x] [IMPLEMENTER] Add explicit participant/spectator connection input without global spectator read-only policy.
- [x] [IMPLEMENTER] Preserve native Ping behavior without requiring browser Ping support.
- [x] [IMPLEMENTER] Do not add reconnect, pending-command, effect/reducer, or notification-event systems.

#### Acceptance

- [x] [TEST] Existing native tests and snapshots pass unchanged.
- [x] [TEST] Deterministic fake transport tests pass without sleeps or network.
- [x] [TEST] Existing native live WSS tests pass in their existing organization.
- [x] [TEST] Core client checks for native and `wasm32-unknown-unknown`.
- [x] [TEST] Rust coverage is measured and targets at least 80% in every Rust metric without enforcement.
- [x] [REVIEW] A reviewer can trace moved native behavior directly into the shared code.

### Slice 4: Typed WASM Facade

**Suggested commit subject:** `feat(wasm): add typed client facade`

#### Implementation

- [x] [IMPLEMENTER] Add `ppoker-wasm` with a thin typed facade over the portable client.
- [x] [IMPLEMENTER] Add the concrete `web-sys::WebSocket` transport with retained callbacks and deterministic terminal cleanup.
- [x] [IMPLEMENTER] Keep one owning `Session<WebPokerClient>` in the facade; do not duplicate status/session revision merge state.
- [x] [IMPLEMENTER] Generate structured TypeScript types without handwritten domain duplication.
- [x] [IMPLEMENTER] Add structured JS errors and safe option conversion; keep malformed-option details facade-owned and use core errors for operational/terminal failures.
- [x] [IMPLEMENTER] Exclude notification, focus, changelog, auto-reveal, diagnostic-log, and speculative contracts from the generated API.
- [x] [IMPLEMENTER] Ignore generated wasm-pack output.

#### Acceptance

- [x] [TEST] Native facade unit tests pass.
- [x] [TEST] `wasm-pack build` succeeds from a clean output directory.
- [x] [TEST] Headless browser wasm-bindgen tests pass.
- [x] [TEST] `wasm-pack build` emits the expected generated declaration file; strict TypeScript consumption is validated in Slice 5.
- [x] [TEST] Rust coverage is measured and targets at least 80% in every Rust metric without enforcement.
- [x] [REVIEW] The facade contains conversion/lifecycle code only, not duplicated client behavior.

### Slice 5: pnpm TypeScript Client Package

**Suggested commit subject:** `feat(web): add typed wasm client package`

#### Implementation

- [x] [IMPLEMENTER] Create the web package with pnpm, Vite, TypeScript, ESLint, Prettier, Vitest, jsdom, Testing Library, and coverage tooling.
- [x] [IMPLEMENTER] Configure the five-day pnpm release-age policy before resolving dependencies.
- [x] [IMPLEMENTER] Add clean WASM generation, explicit asynchronous initialization, and the authored `WasmPokerClient` wrapper that hides raw generated lifecycle and ABI exports.
- [x] [IMPLEMENTER] Add declaration emission, Vite library build, and isolated installed-package verification.
- [x] [IMPLEMENTER] Add strict generated and public declaration fixtures.

#### Acceptance

- [x] [TEST] Frozen pnpm install succeeds.
- [x] [TEST] Formatting, ESLint, and `tsc --noEmit` checks pass.
- [x] [TEST] Vitest tests and frontend coverage generation pass.
- [x] [TEST] Generated and public declaration fixtures compile strictly and contain no authored `any` escape hatch.
- [x] [TEST] Frontend coverage is measured and targets at least 80% for lines, branches, functions, and statements without enforcement.
- [x] [TEST] Vite build and package verification pass from clean generated and distribution output.
- [x] [REVIEW] No npm/yarn lockfile or duplicate TypeScript domain model exists.

### Slice 6: React External Store And Hooks

**Suggested commit subject:** `feat(web): add react client store and hooks`

#### Implementation

- [x] [IMPLEMENTER] Add the external store with injectable port, stable snapshots, one shared polling interval, commands, and disposal.
- [x] [IMPLEMENTER] Add provider and hooks using `useSyncExternalStore`.
- [x] [IMPLEMENTER] Add deep-readonly public types and protect cached snapshots from mutation.
- [x] [IMPLEMENTER] Keep provider ownership non-owning: unmount unsubscribes but does not connect, close, or dispose the caller-owned store.
- [x] [IMPLEMENTER] Provide a stable, deeply immutable, side-effect-free server snapshot.
- [x] [IMPLEMENTER] Keep TypeScript policy limited to lifecycle and subscription behavior.
- [x] [IMPLEMENTER] Do not add speculative notification or event-queue infrastructure.

#### Acceptance

- [x] [TEST] Store lifecycle, revision, polling, command, immutability, and cleanup tests pass.
- [x] [TEST] Provider/hook and Strict Mode tests pass.
- [x] [TEST] Formatting, ESLint, `tsc --noEmit`, Vitest, coverage generation, and Vite build pass.
- [x] [TEST] Frontend coverage is measured and targets at least 80% in every frontend metric without enforcement.
- [x] [REVIEW] React code wraps generated/shared contracts and does not recreate Rust behavior.

### Slice 7: Focused Automation And Package Documentation

**Suggested commit subject:** `ci(docs): validate web client foundation`

#### Implementation

- [x] [IMPLEMENTER] Add only focused WASM/web CI validation while preserving existing native/release workflow structure.
- [x] [IMPLEMENTER] Add frontend Codecov reporting without statuses or threshold enforcement.
- [x] [IMPLEMENTER] Add Cargo and `/web` Dependabot cooldown configuration without GitHub Actions updates.
- [x] [IMPLEMENTER] Add concise `web/README.md` documentation.
- [x] [IMPLEMENTER] Provide `pnpm run check` as the single web/WASM validation command used by maintainers and CI.
- [x] [IMPLEMENTER] Add a bounded live upstream participant proof while keeping deterministic fake-WebSocket tests distinct.
- [x] [IMPLEMENTER] Verify action references remain version tags and Linux release builds remain on Ubuntu 22.04.

#### Acceptance

- [x] [TEST] Every locally applicable Rust, WASM, pnpm, browser, Vite, and package command passes.
- [x] [TEST] Rust and frontend coverage reports are valid, correctly attributed, and target at least 80% without enforcement.
- [x] [TEST] Workflow syntax is valid and workflow commands match documented local commands.
- [x] [REVIEW] The final diff contains no unrelated updater, release, dependency-policy, test-layout, README, or CI rework.

## Final Acceptance Checklist

- [x] The branch contains a recognizable mechanical extraction of existing native code with only focused portability adaptations.
- [x] Git history separates moves from behavioral adaptations.
- [x] Existing native behavior and TUI snapshots remain unchanged unless explicitly approved.
- [x] Native notifications, focus, changelog, auto reveal, diagnostic logging, and their configuration remain outside `ppoker-core` and the WASM/public web contract.
- [x] Shared room state, protocol/activity logging, round tracking, history, and statistics have one authoritative owner in `ppoker-core`.
- [x] Each application owns one assembled `Session` with its backend and uses the generic core update operation instead of coordinating a client/session pair.
- [x] One normalized Rust model serves native and WASM consumers; wire DTOs remain private.
- [x] Native and WASM use one intentionally selected WebSocket implementation or one narrow shared transport boundary.
- [x] Participant and spectator connections work with the commands supported by the server.
- [x] The WASM facade is typed, thin, structured, and safely disposable.
- [x] The React package provides stable external-store semantics, deterministic cleanup, and typed commands.
- [x] pnpm is used exclusively and enforces a five-day minimum release age for normal dependency resolution.
- [x] Dependabot normal Cargo/web updates use a five-day cooldown; security updates may bypass it.
- [x] Vite, Vitest, coverage, ESLint, TypeScript checks, WASM browser tests, and package verification are present and passing.
- [x] Every commit measured applicable coverage and targeted at least 80% in every metric without adding enforcement.
- [x] Codecov retains its existing non-gating policy and reports frontend coverage separately.
- [x] Existing native/release workflows, Ubuntu 22.04 release compatibility, and updater dependencies remain unchanged; any root README edits are strictly end-user-facing.
- [x] `web/README.md` is the concise maintainer workflow guide for the web/WASM package.
- [x] No unresolved review finding remains.

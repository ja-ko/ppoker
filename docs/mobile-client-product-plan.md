# Mobile Client Product Plan

## Status

This document describes the intended mobile web client after the handwriting
proof of concept has validated the core interaction. The proof-of-concept plan
is maintained separately in [handwriting-poc-plan.md](handwriting-poc-plan.md).

Checklist convention:

- `[x]` means the requirement or decision is settled.
- `[ ]` means implementation, verification, or a product decision remains.

## Product Outcome

Deliver a QR-accessible mobile web client for iOS and Android that supports the
complete planning-poker voting workflow. Handwriting is the primary way to play
numeric cards, while a deck picker provides a reliable fallback and access to
non-numeric cards.

## Product Requirements

### Access And Identity

- [x] A QR code represents room access only.
- [x] The QR URL does not contain a player name, vote, or personal credential.
- [x] Opening the URL in an iOS or Android browser starts the mobile client.
- [x] The client generates a random player name on first use.
- [x] The player can edit their generated name.
- [x] The generated profile ID and current name are persisted in browser storage.
- [x] A suspended client should reconnect automatically when it becomes active.
- [x] Client storage must allow a future server-issued, room-scoped resume token
  without changing the UI flow.
- [ ] Define the final room URL format before QR generation is implemented.
- [ ] Define the random-name vocabulary and collision behavior.
- [ ] Add true session resumption when the server protocol supports it.

The current server associates identity with a live WebSocket session and removes
the user immediately when that socket closes. Reconnecting therefore creates a
new participant today. The client must not treat a display name as a durable
identity or attempt to invent a client-only resumption protocol.

### Voting

- [x] The primary voting view is a fullscreen handwriting surface.
- [x] The recognizer supports unsigned integers containing one to three digits.
- [x] A recognized number is playable only when its canonical string occurs in
  the server-provided deck.
- [x] Non-numeric cards are entered through the deck picker.
- [x] Handwritten `?` recognition is optional and is not required for release.
- [x] The deck picker also exposes numeric cards as an accessible fallback.
- [x] A confident, deck-valid number commits automatically without confirmation.
- [x] A low-confidence result is dismissed without showing a pending candidate.
- [x] A confident number that is not in the deck shakes and then disappears.
- [x] Every result receives an inactivity grace period before commit or rejection.
- [x] A value that is both a card and a prefix of a longer card waits longer for
  another stroke. For example, `1` waits when `13` is in the deck.
- [x] Any new stroke cancels pending recognition, commit, or rejection work.
- [x] After commitment, the player sees the card they played.
- [x] An explicit clear/change control retracts the vote and returns to drawing.
- [x] Clearing a vote cancels any locally pending automatic reveal.
- [ ] Decide whether a scratch-out gesture should supplement the clear control.

### Ink Experience

- [x] Pointer input is captured as timestamped strokes rather than only pixels.
- [x] Velocity is derived from points and timestamps; it is not stored separately.
- [x] Finger, stylus, and mouse input use Pointer Events with coalesced events
  when available.
- [x] Visible ink rendering and recognition rasterization are separate concerns.
- [x] Successful ink settles, contracts, or dissolves into the typeset card.
- [x] Invalid ink shakes before it is erased.
- [x] Low-confidence ink dissipates without claiming a recognized value.
- [x] Interaction meaning is always conveyed visually, never only through haptics.
- [x] Android haptics are progressive enhancement through `navigator.vibrate()`.
- [x] Programmable iOS haptics are unavailable to this pure web release.
- [ ] Tune animation timing, easing, line shape, and haptic patterns on devices.
- [ ] Support the user's reduced-motion preference.

### Reveal

- [x] Every client that has voted sees a manual reveal button.
- [x] The button is visually faint while participant votes are outstanding.
- [x] The button becomes prominent when all participants have voted.
- [x] If the mobile client casts the final missing vote, it schedules a reveal
  approximately three seconds later.
- [x] Exact timing while the browser is backgrounded is not required.
- [x] The automatic reveal is cancelled when authoritative room state changes in
  a way that makes reveal inappropriate.
- [x] Reveal commands are safe to race with another client; the next server room
  snapshot is authoritative.
- [ ] Decide whether all clients should display the automatic-reveal countdown or
  only the client that scheduled it.

### Revealed Round

- [x] The revealed view displays the average prominently.
- [x] Vote distribution appears below the average.
- [x] A separate control opens the exact vote for every player.
- [x] Exact votes are displayed in a mobile-appropriate sheet or overlay.
- [x] A next-round control sends the reset/start-new-round command.
- [x] The next server snapshot, not optimistic local state, confirms the reset.
- [ ] Decide whether next-round and early-reveal actions require confirmation.

### Connectivity And Failure Handling

- [x] Complete server room snapshots are authoritative.
- [x] Unknown future enum values and extra JSON fields must not crash the client.
- [x] The UI distinguishes connecting, connected, reconnecting, offline, and
  terminally failed states.
- [x] Actions are disabled when the socket cannot safely send them.
- [x] Reconnection uses bounded exponential backoff and resumes when the page
  becomes visible or network connectivity returns.
- [x] Browser WebSockets rely on automatic responses to server ping frames.
- [ ] Verify the deployed server accepts the production web origin.
- [ ] Verify direct `wss://` access through the deployed reverse proxy.
- [ ] Verify reconnect behavior after iOS and Android suspension.

## Architecture Decisions

### Repository And Frontend

- [x] The web application uses React, TypeScript, and Vite.
- [x] The web application lives in a top-level `web-client/` directory.
- [x] UI state changes use React; high-frequency ink points remain outside React
  state and are rendered through refs.
- [x] Recognition runs locally in the browser through ONNX Runtime Web.
- [x] Model inference runs off the main UI thread.
- [x] The application does not upload or retain handwriting samples.

### Rust And WebAssembly

- [x] Poker protocol definitions and shared room-state logic remain authored in
  Rust rather than being independently maintained in TypeScript.
- [x] Existing Rust code will be restructured into crates before live room
  integration is added to the web client.
- [x] An I/O-free core crate will contain DTOs, domain mapping, card rules, and
  shared state transitions.
- [x] The native client will retain a native WebSocket transport.
- [x] The browser WASM client will use the browser WebSocket API through
  `web-sys`; `tungstenite` cannot be compiled into the browser transport.
- [x] Rust/WASM exports will provide generated TypeScript bindings.
- [ ] Finalize Cargo workspace and crate names during the protocol-extraction
  phase.
- [ ] Define the smallest React-facing WASM interface for snapshots, connection
  status, and commands.

A likely workspace shape is:

```text
crates/
├── ppoker-core/       # Protocol and domain logic; no terminal or socket I/O
├── ppoker-native/     # Native transport and terminal application
└── ppoker-web/        # wasm-bindgen/web-sys browser client adapter
web-client/            # React UI, ink capture, animation, and recognition
```

The exact split is intentionally deferred until the current Rust module
dependencies have been mapped. The architectural requirement is the separation
between shared logic and target-specific transport, not these names.

### Recognition Boundary

- [x] The recognizer exposes text, confidence, and alternatives through a stable
  TypeScript interface.
- [x] Alternatives are available to diagnostics but are not shown as a manual
  correction state in normal voting UI.
- [x] Deck validation and finish detection are application logic outside the
  neural-network model.
- [x] The current deck informs waiting and validation but never silently snaps an
  invalid number to another card.
- [x] Recognition continues to function without a server round trip after its
  static assets have loaded.

### Local Storage

- [x] Profile data and room-resumption data use separate storage records.
- [x] A room resume credential, if introduced, is opaque to the UI.
- [x] Clearing site data is allowed to reset the generated identity.
- [ ] Define storage schema versions and migration behavior.

## Application State Model

The implementation should make these state boundaries explicit:

```text
Application
  booting -> joining -> connected -> reconnecting -> failed

Round
  playing -> revealed -> playing

Vote input
  empty -> drawing -> settling -> committed
                         |             |
                         -> rejecting  -> clearing -> empty

Reveal timer
  idle -> scheduled -> revealing -> idle
           |              |
           -> cancelled   -> superseded by server state
```

- [x] Stale recognition responses are ignored with request/version IDs.
- [x] Stale server snapshots are ignored when the server provides a monotonic room
  version.
- [x] Local optimistic state never overrides a contradictory server snapshot.
- [ ] Specify reducer/event types when implementation begins.

## Delivery Plan

### Phase 0: Handwriting Proof Of Concept

- [ ] Complete the work in
  [handwriting-poc-plan.md](handwriting-poc-plan.md).
- [ ] Validate recognition and interaction on physical iOS and Android devices.
- [ ] Accept or reject the proposed recognition model using the documented gates.

### Phase 1: Rust Core Extraction

- [ ] Convert the Rust package into a Cargo workspace without changing terminal
  client behavior.
- [ ] Reconcile the local DTOs with the deployed/upstream protocol, including the
  room `version` and any newer enum variants.
- [ ] Extract protocol DTOs and room mapping into an I/O-free crate.
- [ ] Extract state transitions that should behave identically on native and web.
- [ ] Preserve or improve existing native tests.
- [ ] Add `wasm32-unknown-unknown` compilation to CI for the core crate.

### Phase 2: Browser Client Adapter

- [ ] Add the Rust WASM crate and generated TypeScript bindings.
- [ ] Implement browser WebSocket transport with `web-sys::WebSocket`.
- [ ] Expose connection status, room snapshots, and command methods to React.
- [ ] Add deterministic protocol tests and a local mock transport.
- [ ] Perform a browser-origin smoke test against a controlled server.

### Phase 3: Join And Voting Vertical Slice

- [ ] Parse room access from the page URL.
- [ ] Generate, persist, display, and edit the local player name.
- [ ] Join as a participant and render authoritative voting progress.
- [ ] Connect successful handwriting commits and deck-picker choices to
  `PlayCard`.
- [ ] Support retract/change vote.
- [ ] Add manual reveal and final-voter automatic reveal.

### Phase 4: Revealed Round

- [ ] Render average and distribution from revealed room state.
- [ ] Add exact-votes sheet.
- [ ] Add next-round action and confirmation behavior.
- [ ] Verify transition races with multiple native and mobile clients.

### Phase 5: Resilience And Product Polish

- [ ] Implement reconnection and suspension recovery.
- [ ] Add the storage abstraction for future server resume tokens.
- [ ] Add loading, offline, and terminal error experiences.
- [ ] Complete accessibility and reduced-motion testing.
- [ ] Tune animations and supported Android haptics.
- [ ] Test portrait, landscape, safe areas, browser chrome, and standalone mode if
  installability is later added.

### Phase 6: Delivery

- [ ] Choose static hosting and production URL.
- [ ] Configure CSP, caching, compression, and `connect-src` for the server.
- [ ] Add web build, unit tests, and browser tests to CI.
- [ ] Define web release/versioning independently from native binary releases.
- [ ] Generate QR codes only after the production URL format is stable.
- [ ] Run an end-to-end release test with mixed terminal and mobile clients.

## Product Acceptance Criteria

- [ ] A player can scan a room QR, join with a persisted random name, vote,
  reveal, inspect results, and start the next round without desktop UI.
- [ ] Numeric handwriting reliably supports all numeric values present in the
  supported one-to-three-digit decks.
- [ ] Special cards remain playable through the deck picker.
- [ ] Incorrect automatic commits are rare enough that handwriting is preferable
  to opening the picker.
- [ ] The interaction remains responsive on representative mid-range Android and
  supported iPhone devices.
- [ ] Suspension and network interruption produce a recoverable state without
  losing the local profile.
- [ ] The client behaves correctly when terminal and mobile clients race to
  reveal or reset.
- [ ] No handwriting data leaves the device.

## Non-Goals

- [x] Native Android or iOS applications are not part of the first product.
- [x] A native wrapper solely to obtain iOS haptics is not part of the first
  product.
- [x] Exact three-second reveal timing while backgrounded is not required.
- [x] Server-side automatic reveal is not required for this client release.
- [x] The mobile client does not generate or own the room QR code in the initial
  implementation.
- [x] Handwriting non-numeric special cards is not required.
- [x] Recognized numbers that are absent from the deck are not submitted.
- [x] Handwriting collection, personalization, or per-user model training is not
  part of the product.
- [x] Chat, local round history, and unrelated terminal-client feature parity are
  outside the described mobile voting workflow unless separately requested.
- [x] Offline room participation is not possible; only recognition assets can be
  cached locally.

## Open Decisions And Risks

- [ ] Current server session identity cannot survive a closed WebSocket. Decide
  whether to extend the existing server or introduce a new server protocol.
- [ ] Confirm reveal/reset authorization expectations; the current server allows
  participants to request both transitions.
- [ ] Confirm minimum supported iOS and Android browser versions.
- [ ] Select static hosting and validate production-origin WebSocket access.
- [ ] Decide whether installable PWA metadata is a release requirement or only an
  optional enhancement.
- [ ] Decide whether the exact-votes view includes spectators and missing votes.
- [ ] Define analytics policy. The default is no behavioral or handwriting
  telemetry.

## Current Protocol Notes

The current server joins a room by opening:

```text
wss://HOST/rooms/{room}?user={name}&userType=PARTICIPANT
```

Relevant commands are:

```json
{"requestType":"PlayCard","cardValue":"5"}
{"requestType":"PlayCard","cardValue":null}
{"requestType":"ChangeName","name":"New name"}
{"requestType":"RevealCards"}
{"requestType":"StartNewRound"}
```

The existing native definitions are in `src/web/dto.rs`, `src/web/ws.rs`, and
`src/web/client.rs`. The current upstream server snapshot also contains a
monotonic `version` field that the local `Room` DTO omits and Serde currently
ignores. Reconcile these definitions with the deployed server before making
them shared Rust code or connecting the web client to live rooms.

# Planning Poker Web App

This app serves a room join screen, a read-only spectator billboard, and a
participant voter. The billboard QR code is functional and links to the voter
for the current room. The voter can draw or tap a card, retract a vote, reveal
or reset with confirmation, and rename the persisted local participant.

## Configuration

`VITE_PPOKER_ENDPOINT` is required at build time and must be a `ws://` or
`wss://` endpoint without credentials, query parameters, or fragments. Select
the room at runtime with the `room` query parameter. The site routes are:

- `/` for the room join screen
- `/room?room=planning-room` for a direct scoreboard URL
- `/vote?room=planning-room` for a direct participant voter URL

```text
https://scoreboard.example/
https://scoreboard.example/room?room=planning-room
https://scoreboard.example/vote?room=planning-room
```

The large display title is intentionally the fixed `Planning Poker Room`
placeholder. The authoritative room name from the live snapshot is shown in
the header eyebrow and room-access panel.

Browser routing is the default for local development and hosts with an SPA
fallback. Set `VITE_PPOKER_ROUTER_MODE=hash` for static hosts without route
rewrites. Hash builds use relative static asset URLs so they can run from an
origin root or a repository path.

Elapsed phase time and history ages are observer-local. They describe when
this billboard observed state, are not server completion timestamps, and reset
on reload.

## Handwriting Recognition Safety

The fixed `0.95` handwriting confidence threshold is an explicit,
user-selected carry-over of the POC's usability behavior. It is a synthetic
margin heuristic, not a probability of correctness, calibrated safety bound,
or production-safe automatic-action threshold. The deterministic POC browser
corpus contains known false accepts above `0.95`, including a wide zigzag
decoded as `3` and an overlapping `13` decoded as `8`. Canonical number parsing
and deck membership remain necessary gates, but they do not make
out-of-distribution marks safe.

## Commands

Run commands from `web/`:

```sh
pnpm install
VITE_PPOKER_ENDPOINT=wss://poker.example pnpm run dev
pnpm run check
pnpm run test:e2e
VITE_PPOKER_ENDPOINT=wss://poker.example pnpm run build
VITE_PPOKER_ENDPOINT=wss://poker.example VITE_PPOKER_ROUTER_MODE=hash pnpm run build
```

For local development, open the printed Vite URL and use the join form, or open
`/room?room=planning-room` or `/vote?room=planning-room` directly. A browser
router production host must serve `index.html` for `/room`, `/vote`, and their
trailing-slash forms.

## GitHub Pages

`.github/workflows/pages.yml` builds and deploys `apps/site/dist` on pushes to
`web-client` or `master`. The Pages build embeds
`wss://pp.discordia.network/` and enables hash routing. The deployed routes are:

```text
https://pp.jko.dev/
https://pp.jko.dev/#/room?room=planning-room
https://pp.jko.dev/#/vote?room=planning-room
```

Vite embeds the endpoint in the JavaScript bundle, so changing it requires a
new deployment. The workflow validates the endpoint, builds the Rust WASM and
web workspaces, prepares the recognition assets, and uploads only the static
site output to GitHub Pages.

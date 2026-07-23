# Planning Poker Broadcast

This app is a read-only spectator billboard. It creates one spectator
`PokerClient` and never votes, reveals, starts rounds, chats, or renames. The
future voter client and a functional join code are outside this app's current
scope.

## Configuration

`VITE_PPOKER_ENDPOINT` is required at build time and must be a `ws://` or
`wss://` endpoint without credentials, query parameters, or fragments. Select
the room at runtime with the `room` query parameter:

```text
https://scoreboard.example/?room=planning-room
```

The large display title is intentionally the fixed `Planning Poker Room`
placeholder. The authoritative room name from the live snapshot is shown in
the header eyebrow and room-access panel. The QR-like artwork is explicitly a
nonfunctional preview; it does not encode the room yet.

Elapsed phase time and history ages are observer-local. They describe when
this billboard observed state, are not server completion timestamps, and reset
on reload.

## Commands

Run commands from `web/`:

```sh
pnpm install
VITE_PPOKER_ENDPOINT=wss://poker.example pnpm run dev
pnpm run check
pnpm run test:e2e
VITE_PPOKER_ENDPOINT=wss://poker.example pnpm run build
```

For local development, open the printed Vite URL with `?room=planning-room`.
The production output is static and uses root-relative asset URLs, so host
`apps/site/dist` at the origin root rather than under a path prefix.

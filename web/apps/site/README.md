# Planning Poker Broadcast

This app is a read-only spectator billboard. It creates one spectator
`PokerClient` and never votes, reveals, starts rounds, chats, or renames. The
future voter client and a functional room-access QR code are outside this app's
current scope.

## Configuration

`VITE_PPOKER_ENDPOINT` is required at build time and must be a `ws://` or
`wss://` endpoint without credentials, query parameters, or fragments. Select
the room at runtime with the `room` query parameter. The site routes are:

- `/` for the room join screen
- `/room?room=planning-room` for a direct scoreboard URL

```text
https://scoreboard.example/
https://scoreboard.example/room?room=planning-room
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

For local development, open the printed Vite URL and use the join form, or open
`/room?room=planning-room` directly. The production output is static and uses
root-relative asset URLs, so host `apps/site/dist` at the origin root with an
SPA fallback for `/room` rather than under a path prefix.

## Container

The production image must be built from the repository root because the web
client generates its WASM package from the repository's Rust crates. Supply
`VITE_PPOKER_ENDPOINT` as a required build argument:

```sh
docker build \
  --file web/apps/site/Dockerfile \
  --build-arg VITE_PPOKER_ENDPOINT=wss://poker.example \
  --tag ppoker-site:local \
  .
docker run --rm --publish 8080:8080 ppoker-site:local
```

Open `http://localhost:8080/` or
`http://localhost:8080/room?room=planning-room`. Vite embeds the endpoint in
the JavaScript bundle, so changing a runtime environment variable cannot
change it; rebuild the image for a different endpoint. The build rejects an
empty value, non-WebSocket schemes, missing hostnames, credentials (including
a bare `@`), query parameters, and fragments before the site build starts.

The runtime uses the maintained unprivileged nginx image, runs as UID/GID `101`,
contains only nginx and `apps/site/dist`, and listens on port `8080`. The Node
and nginx base versions are pinned by multi-platform manifest digest. Its
health check uses `/healthz`, and its SPA fallback serves `index.html` for
direct application routes such as `/room`. Missing static-looking paths,
including scripts, source maps, manifests, text files, and fonts, return `404`
without immutable cache headers.

Run the deterministic container smoke test from the repository root:

```sh
./web/apps/site/scripts/container-smoke.sh
```

To validate an image that is already loaded locally without rebuilding it:

```sh
SMOKE_PREBUILT=1 IMAGE=ppoker-site:local SMOKE_ENDPOINT=wss://poker.example \
  ./web/apps/site/scripts/container-smoke.sh
```

Set `CONTAINER_ENGINE=podman` to invoke Podman directly. The script requires
Bash 3.2 or newer, `curl`, and a Docker-compatible Linux container engine; on
macOS, use Docker Desktop or a running Podman machine. It checks rejected build
arguments, nginx configuration, health metadata, the nonroot UID, routes,
caches, MIME types, and cleanup. Podman builds use Docker image format so health
metadata is retained; where no systemd user session exists, the script disables
Podman's scheduler and executes the health command directly instead.

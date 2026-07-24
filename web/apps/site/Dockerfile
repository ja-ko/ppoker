# syntax=docker/dockerfile:1.7

# Build from the repository root so the web workspace and Rust crates are in context:
# docker build -f web/apps/site/Dockerfile --build-arg VITE_PPOKER_ENDPOINT=wss://poker.example -t ppoker-site .

# node:22.17.0-alpine, pinned to its multi-platform manifest digest.
FROM docker.io/library/node@sha256:fc3e945f920b7e3000cd1af86c4ae406ec70c72f328b667baf0f3a8910d69eed AS endpoint-validation

ARG VITE_PPOKER_ENDPOINT

WORKDIR /validation

COPY web/apps/site/scripts/validate-endpoint.mjs ./validate-endpoint.mjs

RUN node ./validate-endpoint.mjs && touch /endpoint-valid

# node:22.17.0-bookworm, pinned to its multi-platform manifest digest.
FROM docker.io/library/node@sha256:2fa6c977460b56d4d8278947ab56faeb312bc4cc6c4cf78920c6de27812f51c5 AS toolchain

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

WORKDIR /workspace/web

COPY web/package.json ./package.json

RUN --mount=type=cache,target=/root/.npm \
    npm install --global pnpm@10.34.5 \
    && test "$(pnpm --version)" = "10.34.5" \
    && test "$(node -p 'require("./package.json").packageManager')" = "pnpm@10.34.5"
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.89.0 --target wasm32-unknown-unknown \
    && cargo install wasm-pack --version 0.13.1 --locked

FROM toolchain AS dependencies

COPY web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
COPY web/apps/site/package.json apps/site/package.json
COPY web/packages/client/package.json packages/client/package.json

RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

FROM dependencies AS client-build

WORKDIR /workspace

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY src ./src
COPY web/packages/client ./web/packages/client

WORKDIR /workspace/web

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/workspace/target \
    pnpm --filter @ppoker/web-client run build

FROM client-build AS site-build

COPY web/apps/site ./apps/site
COPY --from=endpoint-validation /endpoint-valid /endpoint-valid

ARG VITE_PPOKER_ENDPOINT

RUN pnpm --filter @ppoker/site run build

# nginxinc/nginx-unprivileged:1.30.4-alpine, pinned to its multi-platform manifest digest.
FROM docker.io/nginxinc/nginx-unprivileged@sha256:44e36330f74d4f3a1d4e222acca9e23b401fb87811a7597024502bb759c4dd49 AS runtime

COPY web/apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=site-build /workspace/web/apps/site/dist/ /usr/share/nginx/html/

USER 101:101

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=2s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

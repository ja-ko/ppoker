import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmInvocation } from "./subprocess.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = pnpmInvocation();

function run(command, arguments_, cwd = packageRoot) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function runChromium(url) {
  const chromium = process.env.CHROME_BIN ?? "chromium";
  const child = spawn(
    chromium,
    [
      "--headless",
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-gpu",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--dump-dom",
      "--virtual-time-budget=10000",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let diagnostics = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 30_000);
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }

  if (
    timedOut ||
    status !== 0 ||
    !output.includes('data-result="passed"') ||
    !output.includes('data-default-init="passed"') ||
    !output.includes('data-data-view-init="passed"')
  ) {
    throw new Error(
      `packaged Chromium verification failed (status ${String(status)})\n${output}\n${diagnostics}`,
    );
  }
}

run(pnpm.command, [...pnpm.arguments, "run", "build"]);

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "ppoker-web-package-verification-"),
);
try {
  run(pnpm.command, [
    ...pnpm.arguments,
    "pack",
    "--pack-destination",
    temporaryRoot,
  ]);
  const archives = (await readdir(temporaryRoot)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error("pnpm pack did not create exactly one package archive");
  }

  const archive = join(temporaryRoot, archives[0]);
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "ppoker-package-consumer",
        private: true,
        type: "module",
        packageManager: "pnpm@10.34.5",
        dependencies: {
          "@ppoker/web-client": `file:${archive}`,
          "@types/react": "19.2.17",
          react: "19.2.7",
          "react-dom": "19.2.7",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    'packages:\n  - "."\n\nminimumReleaseAge: 7200\n',
  );
  run(
    pnpm.command,
    [...pnpm.arguments, "install", "--lockfile-only", "--ignore-scripts"],
    consumerRoot,
  );
  run(
    pnpm.command,
    [...pnpm.arguments, "install", "--frozen-lockfile", "--ignore-scripts"],
    consumerRoot,
  );

  const typeFixture = join(consumerRoot, "consumer.ts");
  await writeFile(
    typeFixture,
    `import {
  WasmPokerClient,
  initializePpokerWasm,
  type ClientOptions,
  type ClientSnapshot,
  type PpokerWasmInitInput,
  type Vote,
} from "@ppoker/web-client";

type Assert<Value extends true> = Value;
type HasNoRawFree = Assert<"free" extends keyof WasmPokerClient ? false : true>;

function inspectVote(vote: Vote): number | string | null {
  if (vote.state === "revealed") {
    return vote.value.value;
  }
  return null;
}

declare const options: ClientOptions;
declare const snapshot: ClientSnapshot;
const dataViewInput: PpokerWasmInitInput = new DataView(new ArrayBuffer(8));
const responseInput: PpokerWasmInitInput = new Response();
const hasNoRawFree: HasNoRawFree = true;
void initializePpokerWasm;
void options.role;
void snapshot.room?.players.map((player) => inspectVote(player.vote));
void dataViewInput;
void responseInput;
void hasNoRawFree;
`,
  );
  run(
    process.execPath,
    [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2023,DOM,DOM.Iterable,ESNext.Disposable",
      typeFixture,
    ],
    consumerRoot,
  );

  const reactTypeFixture = join(consumerRoot, "react-consumer.ts");
  await writeFile(
    reactTypeFixture,
    `import type { ComponentProps } from "react";
import {
  createPokerClientStore,
  type PokerClientPort,
  type PokerClientSnapshot,
} from "@ppoker/web-client";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
  usePokerClientStore,
} from "@ppoker/web-client/react";

declare const port: PokerClientPort;
const store = createPokerClientStore(port);
const provider: ComponentProps<typeof PokerClientProvider> = { store };
const snapshot: PokerClientSnapshot = usePokerClientSnapshot();
void usePokerClientStore;
void snapshot.room?.players[0]?.vote;
void provider;
`,
  );
  run(
    process.execPath,
    [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2023,DOM,DOM.Iterable,ESNext.Disposable",
      reactTypeFixture,
    ],
    consumerRoot,
  );

  const runtimeFixture = join(consumerRoot, "consumer.mjs");
  await writeFile(
    runtimeFixture,
    `import { readFile } from "node:fs/promises";

let fetchCount = 0;
let socketCount = 0;
globalThis.fetch = () => {
  fetchCount += 1;
  throw new Error("package verification forbids fetch");
};
globalThis.WebSocket = class {
  constructor() {
    socketCount += 1;
    throw new Error("package verification forbids WebSocket construction");
  }
};
class VerificationWindow {}
globalThis.Window = VerificationWindow;
globalThis.window = Object.assign(new VerificationWindow(), {
  performance: globalThis.performance,
});

const api = await import("@ppoker/web-client");
const entry = import.meta.resolve("@ppoker/web-client");
const bytes = Uint8Array.from(
  await readFile(new URL("./ppoker_wasm_bg.wasm", entry)),
);
const offset = 13;
const padded = new Uint8Array(bytes.byteLength + offset + 5);
padded.set(bytes, offset);
await api.initializePpokerWasm(
  new DataView(padded.buffer, offset, bytes.byteLength),
);

const client = new api.WasmPokerClient({
  endpoint: "wss://example.test/base",
  room: "package verification",
  name: "No network",
  role: "spectator",
});
const initial = client.snapshot();
if (
  initial.revision !== 0 ||
  initial.status !== "disconnected" ||
  initial.room !== null ||
  initial.terminalError !== null
) {
  throw new Error("packaged client returned an invalid initial snapshot");
}
client.close();
const closed = client.snapshot();
if (closed.revision !== 1 || closed.status !== "closed" || client.poll()) {
  throw new Error("packaged client did not close deterministically");
}
if ("free" in client) {
  throw new Error("authored client exposed the generated free method");
}
if (fetchCount !== 0 || socketCount !== 0) {
  throw new Error("packaged no-network lifecycle caused network activity");
}
`,
  );
  const noReactLoader = join(consumerRoot, "no-react-loader.mjs");
  await writeFile(
    noReactLoader,
    `export function resolve(specifier, context, nextResolve) {
  if (specifier === "react" || specifier.startsWith("react/")) {
    throw new Error("base entrypoint attempted to execute React");
  }
  return nextResolve(specifier, context);
}
`,
  );
  run(
    process.execPath,
    ["--experimental-loader", noReactLoader, runtimeFixture],
    consumerRoot,
  );

  const reactRuntimeFixture = join(consumerRoot, "react-consumer.mjs");
  await writeFile(
    reactRuntimeFixture,
    `import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createPokerClientStore } from "@ppoker/web-client";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
  usePokerClientStore,
} from "@ppoker/web-client/react";

let closeCount = 0;
let snapshot = {
  revision: 0,
  status: "disconnected",
  terminalError: null,
  room: null,
  localName: "React consumer",
  localVote: null,
  log: [],
  roundNumber: 0,
  roundStartedAtMs: null,
  history: [],
  average: null,
};
const client = {
  connect() {},
  poll() { return false; },
  snapshot() { return snapshot; },
  vote() {},
  retractVote() {},
  rename() {},
  chat() {},
  reveal() {},
  startNewRound() {},
  close() {
    closeCount += 1;
    snapshot = { ...snapshot, revision: 1, status: "closed" };
  },
};
const store = createPokerClientStore(client);
function View() {
  if (usePokerClientStore() !== store) {
    throw new Error("React entrypoint returned a different store");
  }
  const value = usePokerClientSnapshot();
  return createElement("span", null, value.status + ":" + value.revision);
}
const html = renderToString(
  createElement(
    PokerClientProvider,
    { store },
    createElement(View),
  ),
);
if (!html.includes("disconnected:0") || closeCount !== 0) {
  throw new Error("React entrypoint violated SSR or provider ownership");
}
store.dispose();
store.dispose();
if (closeCount !== 1 || store.getSnapshot().status !== "closed") {
  throw new Error("installed store did not dispose deterministically");
}
`,
  );
  run(process.execPath, [reactRuntimeFixture], consumerRoot);

  const installedDistribution = join(
    consumerRoot,
    "node_modules/@ppoker/web-client/dist",
  );
  await stat(join(installedDistribution, "index.js"));
  await stat(join(installedDistribution, "index.d.ts"));
  await stat(join(installedDistribution, "react.js"));
  await stat(join(installedDistribution, "react.d.ts"));
  await stat(join(installedDistribution, "ppoker_wasm_bg.wasm"));
  const installedFiles = await readdir(installedDistribution, {
    recursive: true,
  });
  const sourceMaps = installedFiles.filter((name) => name.endsWith(".map"));
  if (sourceMaps.length !== 0) {
    throw new Error(
      `packed distribution contains source maps: ${sourceMaps.join(", ")}`,
    );
  }
  const installedPackage = JSON.parse(
    await readFile(
      join(consumerRoot, "node_modules/@ppoker/web-client/package.json"),
      "utf8",
    ),
  );
  if (Object.keys(installedPackage.exports).join(",") !== ".,./react") {
    throw new Error("package exports include a non-authored entrypoint");
  }
  if (
    installedPackage.peerDependencies?.react !== "^18.0.0 || ^19.0.0" ||
    installedPackage.dependencies?.react !== undefined
  ) {
    throw new Error("packaged React dependency is not peer-only");
  }
  const installedIndex = await readFile(
    join(installedDistribution, "index.js"),
    "utf8",
  );
  const installedReact = await readFile(
    join(installedDistribution, "react.js"),
    "utf8",
  );
  if (/from\s*["']react(?:\/jsx-runtime)?["']/u.test(installedIndex)) {
    throw new Error("installed base entrypoint imports React");
  }
  if (
    !/from\s*["']react["']/u.test(installedReact) ||
    !/from\s*["']react\/jsx-runtime["']/u.test(installedReact)
  ) {
    throw new Error("installed React entrypoint did not externalize React");
  }

  const browserFixture = join(consumerRoot, "browser.html");
  await writeFile(
    browserFixture,
    `<!doctype html>
<body data-result="running">
<script type="module">
let socketCount = 0;
globalThis.WebSocket = class {
  constructor() {
    socketCount += 1;
    throw new Error("browser package verification forbids WebSocket construction");
  }
};

function verifyClient(api, name) {
  const client = new api.WasmPokerClient({
    endpoint: "wss://example.test/base",
    room: "browser package verification",
    name,
    role: "participant",
  });
  const initial = client.snapshot();
  if (
    initial.revision !== 0 ||
    initial.status !== "disconnected" ||
    initial.room !== null ||
    initial.terminalError !== null
  ) {
    throw new Error(name + " returned an invalid initial snapshot");
  }
  client.close();
  const closed = client.snapshot();
  if (closed.revision !== 1 || closed.status !== "closed" || client.poll()) {
    throw new Error(name + " did not close deterministically");
  }
  if ("free" in client) {
    throw new Error(name + " exposed the generated free method");
  }
}

try {
  const defaultApi = await import("/package/index.js?default-init");
  await defaultApi.initializePpokerWasm();
  verifyClient(defaultApi, "default initialization");
  document.body.dataset.defaultInit = "passed";

  const response = await fetch("/package/ppoker_wasm_bg.wasm");
  if (!response.ok) throw new Error("packaged WASM fetch failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const offset = 17;
  const padded = new Uint8Array(bytes.byteLength + offset + 9);
  padded.set(bytes, offset);
  const dataViewApi = await import("/package/index.js?data-view-init");
  await dataViewApi.initializePpokerWasm(
    new DataView(padded.buffer, offset, bytes.byteLength),
  );
  verifyClient(dataViewApi, "DataView initialization");
  document.body.dataset.dataViewInit = "passed";

  if (socketCount !== 0) {
    throw new Error("browser package verification created a WebSocket");
  }
  document.body.dataset.result = "passed";
} catch (error) {
  document.body.dataset.result = "failed";
  document.body.textContent = error instanceof Error ? error.stack : String(error);
}
</script>
</body>
`,
  );

  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".wasm", "application/wasm"],
  ]);
  let wasmRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      let file;
      if (pathname === "/") {
        file = browserFixture;
      } else if (pathname.startsWith("/package/")) {
        const relativePath = pathname.slice("/package/".length);
        file = normalize(join(installedDistribution, relativePath));
        if (!file.startsWith(`${installedDistribution}${sep}`)) {
          throw new Error("browser requested an invalid package path");
        }
        if (relativePath === "ppoker_wasm_bg.wasm") {
          wasmRequests += 1;
        }
      } else {
        throw new Error("browser requested a non-consumer path");
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          contentTypes.get(extname(file)) ?? "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("browser package verification server did not start");
    }
    await runChromium(`http://127.0.0.1:${address.port}/`);
    if (wasmRequests < 2) {
      throw new Error(
        `browser requested packaged WASM only ${wasmRequests.toString()} time(s)`,
      );
    }
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  console.log(
    `verified pnpm 10 isolated install, base and React declarations, React-blocked base import, one-instance React SSR, peer/external React, no-map package, no-network DataView initialization, default Chromium WASM loading, browser DataView initialization, zero WebSockets, and ${wasmRequests.toString()} packaged WASM requests`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

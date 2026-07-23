import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { packageRoot, pnpmInvocation, runCaptured } from "./subprocess.mjs";

const reactPeerRange = "^18.0.0 || ^19.0.0";
const manifest = JSON.parse(
  await fs.readFile(join(packageRoot, "package.json"), "utf8"),
);
const pnpm = pnpmInvocation();

const pnpmStore = runCaptured(pnpm.command, [
  ...pnpm.arguments,
  "store",
  "path",
  "--silent",
]).trim();
if (pnpmStore.length === 0) throw new Error("pnpm store path was empty");

async function runChromium(url) {
  const child = spawn(
    process.env.CHROME_BIN ?? "chromium",
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
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  if (status !== 0 || !stdout.includes('data-result="passed"')) {
    throw new Error(
      `packaged Chromium verification failed (status ${String(status)})\n${stdout}\n${stderr}`,
    );
  }
}

runCaptured(pnpm.command, [...pnpm.arguments, "run", "build"]);

const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "ppoker-web-package-"));
try {
  runCaptured(pnpm.command, [
    ...pnpm.arguments,
    "pack",
    "--pack-destination",
    temporaryRoot,
  ]);
  const archives = (await fs.readdir(temporaryRoot)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error("pnpm pack did not create exactly one archive");
  }

  const consumerRoot = join(temporaryRoot, "consumer");
  await fs.mkdir(consumerRoot);
  await fs.writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "ppoker-package-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@ppoker/web-client": `file:${join(temporaryRoot, archives[0])}`,
          "@types/react": manifest.devDependencies["@types/react"],
          react: manifest.devDependencies.react,
          "react-dom": manifest.devDependencies["react-dom"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    join(consumerRoot, "pnpm-workspace.yaml"),
    'packages:\n  - "."\n',
  );
  for (const lockfileMode of ["--lockfile-only", "--frozen-lockfile"]) {
    runCaptured(
      pnpm.command,
      [
        ...pnpm.arguments,
        "install",
        lockfileMode,
        "--ignore-scripts",
        ...(lockfileMode === "--frozen-lockfile" ? ["--offline"] : []),
        "--store-dir",
        pnpmStore,
      ],
      consumerRoot,
    );
  }
  runCaptured(
    process.execPath,
    [
      "-e",
      "try{require.resolve('vitest');process.exit(1)}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}",
    ],
    consumerRoot,
  );

  const runtimeConsumer = join(consumerRoot, "consumer.mjs");
  await fs.writeFile(
    runtimeConsumer,
    `import { createElement } from "react";
import { renderToString } from "react-dom/server";

let sideEffects = 0;
globalThis.fetch = () => { sideEffects += 1; throw new Error("package import fetched"); };
globalThis.WebSocket = class { constructor() { sideEffects += 1; throw new Error("package import opened a socket"); } };
const base = await import("@ppoker/web-client");
const react = await import("@ppoker/web-client/react");
if (Object.keys(base).join() !== "createPokerClient" ||
    Object.keys(react).join() !== "PokerClientProvider,usePokerClient,usePokerClientSnapshot" ||
    [...Object.values(base), ...Object.values(react)].some((value) => typeof value !== "function") || sideEffects !== 0) {
  throw new Error("packaged runtime exports or import side effects are invalid");
}
const client = {
  subscribe() { throw new Error("SSR subscribed to the client"); },
  getSnapshot() { throw new Error("SSR read the client snapshot"); },
};
function Snapshot() {
  if (react.usePokerClient() !== client) throw new Error("provider returned the wrong client");
  const snapshot = react.usePokerClientSnapshot();
  return snapshot.status + ":" + snapshot.revision;
}
const html = renderToString(createElement(react.PokerClientProvider, { client }, createElement(Snapshot)));
if (html !== "disconnected:0") throw new Error("packaged React SSR smoke failed: " + html);
`,
  );
  runCaptured(process.execPath, [runtimeConsumer], consumerRoot);

  const consumer = join(consumerRoot, "consumer.ts");
  await fs.writeFile(
    consumer,
    `import type { ComponentProps } from "react";
import { createPokerClient, type ClientOptions, type ClientSnapshot, type PokerClient } from "@ppoker/web-client";
import { PokerClientProvider, usePokerClient, usePokerClientSnapshot } from "@ppoker/web-client/react";

declare const client: PokerClient;
declare const options: ClientOptions;
declare const snapshot: ClientSnapshot;
const provider: ComponentProps<typeof PokerClientProvider> = { client };
const created: Promise<PokerClient> = createPokerClient(options, {
  wasm: new DataView(new ArrayBuffer(8)),
});
void [snapshot.room?.players[0]?.vote, usePokerClient, usePokerClientSnapshot, provider, created];
`,
  );
  await fs.writeFile(
    join(consumerRoot, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"noEmit":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","lib":["ES2023","DOM","DOM.Iterable","ESNext.Disposable"]},"files":["consumer.ts"]}\n',
  );
  // prettier-ignore
  runCaptured(process.execPath, [join(packageRoot, "node_modules/typescript/bin/tsc"), "-p", consumerRoot], consumerRoot);

  const installedRoot = join(consumerRoot, "node_modules/@ppoker/web-client");
  const distribution = join(installedRoot, "dist");
  const [installedManifestText, baseJavaScript, reactJavaScript] =
    await Promise.all([
      fs.readFile(join(installedRoot, "package.json"), "utf8"),
      fs.readFile(join(distribution, "index.js"), "utf8"),
      fs.readFile(join(distribution, "react.js"), "utf8"),
    ]);
  const installedManifest = JSON.parse(installedManifestText);
  if (
    Object.keys(installedManifest.exports).join() !== ".,./react" ||
    manifest.peerDependencies.react !== reactPeerRange ||
    installedManifest.peerDependencies?.react !== reactPeerRange ||
    installedManifest.dependencies?.react !== undefined
  ) {
    throw new Error("packaged exports or React dependency are invalid");
  }
  // prettier-ignore
  if ((await fs.readdir(distribution, { recursive: true })).some((file) => file.endsWith(".map"))) throw new Error("packed distribution contains source maps");
  if (
    /from\s*["']react(?:\/jsx-runtime)?["']/u.test(baseJavaScript) ||
    !/from\s*["']react["']/u.test(reactJavaScript) ||
    !/from\s*["']react\/jsx-runtime["']/u.test(reactJavaScript)
  ) {
    throw new Error("packaged entrypoints do not externalize React correctly");
  }

  const browserFixture = join(consumerRoot, "browser.html");
  await fs.writeFile(
    browserFixture,
    `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'">
<body data-result="running">
<script type="module">
const originalFetch = globalThis.fetch.bind(globalThis);
let wasmRequests = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin) throw new Error("external fetch: " + url.href);
  if (url.pathname.endsWith(".wasm")) wasmRequests += 1;
  return originalFetch(input, init);
};
const sockets = [];
globalThis.WebSocket = class {
  constructor(url) {
    this.url = new URL(url).href;
    this.binaryType = "blob";
    this.readyState = 0;
    this.sent = [];
    this.closeCount = 0;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    sockets.push(this);
  }
  send(message) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(message);
  }
  close() {
    this.closeCount += 1;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(data) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
};
try {
  const { createPokerClient } = await import("/package/index.js");
  const client = await createPokerClient({
    endpoint: "wss://example.test/base",
    room: "package smoke",
    name: "Browser",
    role: "participant",
  }, { pollIntervalMs: 5 });
  if ("free" in client) throw new Error("authored client exposed raw free");
  const initial = client.getSnapshot();
  client.connect();
  const socket = sockets[0];
  if (!socket || socket.binaryType !== "arraybuffer") throw new Error("packaged connect failed");
  socket.open();
  socket.receive(JSON.stringify({
    roomId: "package smoke",
    deck: ["3", "5", "8", "?"],
    gamePhase: "PLAYING",
    users: [{ username: "Browser", userType: "PARTICIPANT", yourUser: true, cardValue: "" }],
    average: "0",
    log: [{ level: "INFO", message: "joined" }],
  }));
  const deadline = performance.now() + 1000;
  while (client.getSnapshot().status !== "open") {
    if (performance.now() > deadline) throw new Error("cached open snapshot timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const open = client.getSnapshot();
  client.vote("5");
  if (socket.sent.join() !== '{"requestType":"PlayCard","cardValue":"5"}') {
    throw new Error("packaged command payload is invalid");
  }
  client.close();
  const closed = client.getSnapshot();
  if (initial.status !== "disconnected" || open.status !== "open" ||
      closed.status !== "closed" || closed.revision !== open.revision + 1 ||
      closed.terminalError !== null || client.poll() || wasmRequests !== 1 ||
      socket.closeCount !== 1 || socket.readyState !== 3 ||
      [socket.onopen, socket.onmessage, socket.onerror, socket.onclose].some(Boolean)) {
    throw new Error("packaged connected lifecycle cleanup failed");
  }
  document.body.dataset.result = "passed";
} catch (error) {
  document.body.dataset.result = "failed";
  document.body.textContent = error instanceof Error ? error.stack : String(error);
}
</script>
`,
  );

  const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".wasm", "application/wasm"],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const file =
        pathname === "/"
          ? browserFixture
          : normalize(join(distribution, pathname.replace("/package/", "")));
      if (
        pathname !== "/" &&
        (!pathname.startsWith("/package/") ||
          !file.startsWith(`${distribution}${sep}`))
      ) {
        throw new Error("invalid package path");
      }
      response.writeHead(200, {
        "Content-Type":
          contentTypes.get(extname(file)) ?? "application/octet-stream",
      });
      response.end(await fs.readFile(file));
    } catch (error) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("package verification server did not start");
    }
    await runChromium(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(
    "verified isolated package runtime/types/manifest, no maps/raw free, React SSR/peer boundaries, and Chromium WASM connected cleanup",
  );
} finally {
  await fs.rm(temporaryRoot, { force: true, recursive: true });
}

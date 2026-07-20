import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pnpmInvocation } from "./subprocess.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..");
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const installedWasmPack = join(
  cargoHome,
  "bin",
  process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack",
);
const wasmPack =
  process.env.WASM_PACK ??
  (existsSync(installedWasmPack) ? installedWasmPack : "wasm-pack");
const pnpm = pnpmInvocation();

function run(command, arguments_, cwd = packageRoot, env = process.env) {
  const result = spawnSync(command, arguments_, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runPnpm(script) {
  run(pnpm.command, [...pnpm.arguments, "run", script]);
}

runPnpm("format:check");
runPnpm("lint");
runPnpm("package:verify");
runPnpm("typecheck");
runPnpm("coverage");
run(
  wasmPack,
  ["test", "--headless", "--chrome", "crates/ppoker-wasm"],
  repositoryRoot,
  { ...process.env, WASM_BINDGEN_TEST_TIMEOUT: "30" },
);

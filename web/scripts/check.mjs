import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pnpmInvocation, wasmPackInvocation } from "./subprocess.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..");
const wasmPack = wasmPackInvocation();
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
  wasmPack.command,
  [
    ...wasmPack.arguments,
    "test",
    "--headless",
    "--chrome",
    "crates/ppoker-wasm",
  ],
  repositoryRoot,
  { ...process.env, WASM_BINDGEN_TEST_TIMEOUT: "30" },
);

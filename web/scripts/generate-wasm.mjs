import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(packageRoot, "src/generated/ppoker-wasm");
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const installedWasmPack = join(cargoHome, "bin", "wasm-pack");
const wasmPack =
  process.env.WASM_PACK ??
  (existsSync(installedWasmPack) ? installedWasmPack : "wasm-pack");

await rm(output, { force: true, recursive: true });
await mkdir(dirname(output), { recursive: true });

const result = spawnSync(
  wasmPack,
  [
    "build",
    join(packageRoot, "../crates/ppoker-wasm"),
    "--target",
    "web",
    "--out-dir",
    output,
  ],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

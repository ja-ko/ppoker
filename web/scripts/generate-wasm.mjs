import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { wasmPackInvocation } from "./subprocess.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(packageRoot, "src/generated/ppoker-wasm");
const wasmPack = wasmPackInvocation();

await rm(output, { force: true, recursive: true });
await mkdir(dirname(output), { recursive: true });

const result = spawnSync(
  wasmPack.command,
  [
    ...wasmPack.arguments,
    "build",
    join(packageRoot, "../crates/ppoker-wasm"),
    "--target",
    "web",
    "--out-dir",
    output,
    "--locked",
  ],
  { stdio: "inherit" },
);

if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

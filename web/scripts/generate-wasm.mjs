import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageRoot, runChecked, wasmPackInvocation } from "./subprocess.mjs";

const output = join(packageRoot, "src/generated/ppoker-wasm");
const wasmPack = wasmPackInvocation();

await rm(output, { force: true, recursive: true });
await mkdir(dirname(output), { recursive: true });

runChecked(wasmPack.command, [
  ...wasmPack.arguments,
  "build",
  join(packageRoot, "../crates/ppoker-wasm"),
  "--target",
  "web",
  "--out-dir",
  output,
]);

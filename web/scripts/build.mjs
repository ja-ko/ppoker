import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distribution = join(packageRoot, "dist");
const pnpm = process.env.PNPM_BIN ?? "pnpm";

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await rm(distribution, { force: true, recursive: true });
run(pnpm, ["run", "wasm:generate"]);
run(pnpm, [
  "exec",
  "tsc",
  "-p",
  "tsconfig.build.json",
  "--emitDeclarationOnly",
]);

const generatedDeclarations = join(
  distribution,
  "generated/ppoker-wasm/ppoker_wasm.d.ts",
);
await mkdir(dirname(generatedDeclarations), { recursive: true });
await copyFile(
  join(packageRoot, "src/generated/ppoker-wasm/ppoker_wasm.d.ts"),
  generatedDeclarations,
);
run(pnpm, ["exec", "vite", "build"]);

await stat(join(distribution, "ppoker_wasm_bg.wasm"));
const builtJavaScript = await readFile(join(distribution, "index.js"), "utf8");
const builtReact = await readFile(join(distribution, "react.js"), "utf8");
for (const forbiddenPath of ["src/generated", "../crates", packageRoot]) {
  if (
    builtJavaScript.includes(forbiddenPath) ||
    builtReact.includes(forbiddenPath)
  ) {
    throw new Error(`built JavaScript contains source path: ${forbiddenPath}`);
  }
}
if (/from\s*["']react(?:\/jsx-runtime)?["']/u.test(builtJavaScript)) {
  throw new Error("base entrypoint imports React");
}
if (!/from\s*["']react["']/u.test(builtReact)) {
  throw new Error("React entrypoint does not externalize React");
}

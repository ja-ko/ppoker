import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageRoot, pnpmInvocation, runChecked } from "./subprocess.mjs";

const distribution = join(packageRoot, "dist");
const pnpm = pnpmInvocation();

await rm(distribution, { force: true, recursive: true });
runChecked(pnpm.command, [...pnpm.arguments, "run", "wasm:generate"]);
runChecked(pnpm.command, [
  ...pnpm.arguments,
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
runChecked(pnpm.command, [...pnpm.arguments, "exec", "vite", "build"]);

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

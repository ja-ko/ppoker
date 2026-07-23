import { pnpmInvocation, runChecked } from "./subprocess.mjs";

const pnpm = pnpmInvocation();

function runPnpm(script, workspaceRoot = false) {
  runChecked(pnpm.command, [
    ...pnpm.arguments,
    ...(workspaceRoot ? ["--workspace-root"] : []),
    "run",
    script,
  ]);
}

runPnpm("format:check", true);
runPnpm("package:verify");
runPnpm("lint", true);
runPnpm("typecheck");
runPnpm("test");
runPnpm("test:wasm");

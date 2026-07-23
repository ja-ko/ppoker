import { pnpmInvocation, runChecked } from "./subprocess.mjs";

const pnpm = pnpmInvocation();

function runPnpm(script) {
  runChecked(pnpm.command, [...pnpm.arguments, "run", script]);
}

runPnpm("format:check");
runPnpm("package:verify");
runPnpm("lint");
runPnpm("typecheck");
runPnpm("coverage");
runPnpm("test:wasm");

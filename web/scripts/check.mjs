import { pnpmInvocation, runChecked } from "./subprocess.mjs";

const pnpm = pnpmInvocation();

function runPnpm(script) {
  runChecked(pnpm.command, [...pnpm.arguments, "run", script]);
}

runPnpm("format:check");
runPnpm("lint");
runPnpm("package:verify");
runPnpm("typecheck");
runPnpm("coverage");
runPnpm("test:wasm");

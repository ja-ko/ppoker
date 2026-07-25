import { pnpmInvocation, runChecked } from "./subprocess.mjs";

const pnpm = pnpmInvocation();
const arguments_ = process.argv.slice(2);

if (arguments_.some((argument) => argument !== "--coverage")) {
  throw new Error(`unsupported argument: ${arguments_.join(" ")}`);
}

function runPnpm(script, { filter, workspaceRoot = false } = {}) {
  runChecked(pnpm.command, [
    ...pnpm.arguments,
    ...(workspaceRoot ? ["--workspace-root"] : []),
    ...(filter === undefined ? [] : ["--filter", filter]),
    "run",
    script,
  ]);
}

runPnpm("format:check", { workspaceRoot: true });
runPnpm("package:verify");
runPnpm("lint", { workspaceRoot: true });
runPnpm("typecheck:workspace", { workspaceRoot: true });
if (arguments_.includes("--coverage")) {
  runPnpm("coverage");
  runPnpm("test", { filter: "@ppoker/site" });
} else {
  runPnpm("test:workspace", { workspaceRoot: true });
}
runPnpm("test:wasm");

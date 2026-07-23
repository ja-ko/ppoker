import { join } from "node:path";
import { packageRoot, runChecked, wasmPackInvocation } from "./subprocess.mjs";

const repositoryRoot = join(packageRoot, "../../..");
const wasmPack = wasmPackInvocation();
const arguments_ = process.argv.slice(2);

if (arguments_.some((argument) => argument !== "--live")) {
  throw new Error(`unsupported argument: ${arguments_.join(" ")}`);
}

const live = arguments_.includes("--live");
const testArguments = [
  ...wasmPack.arguments,
  "test",
  "--headless",
  "--chrome",
  "crates/ppoker-wasm",
];

if (live) {
  testArguments.push(
    "--lib",
    "--",
    "web_tests::real_upstream_accepts_a_browser_participant",
    "--include-ignored",
    "--exact",
    "--nocapture",
  );
}

runChecked(wasmPack.command, testArguments, repositoryRoot, {
  ...process.env,
  WASM_BINDGEN_TEST_TIMEOUT: "30",
});

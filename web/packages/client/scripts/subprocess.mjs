import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export function runChecked(
  command,
  arguments_,
  cwd = packageRoot,
  env = process.env,
) {
  const result = spawnSync(command, arguments_, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runCaptured(command, arguments_, cwd = packageRoot) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

export function pnpmInvocation(
  environment = process.env,
  platform = process.platform,
) {
  if (environment.PNPM_BIN !== undefined) {
    if (/\.(?:cmd|bat)$/iu.test(environment.PNPM_BIN)) {
      throw new Error(
        "PNPM_BIN must name a directly executable binary; Windows .cmd and .bat launchers are not supported.",
      );
    }
    return { command: environment.PNPM_BIN, arguments: [] };
  }
  if (environment.npm_execpath !== undefined) {
    return {
      command: process.execPath,
      arguments: [environment.npm_execpath],
    };
  }
  if (platform === "win32") {
    throw new Error(
      "pnpm could not be resolved. Run this command through `pnpm run` so npm_execpath is available, or set PNPM_BIN to a directly executable binary.",
    );
  }
  return {
    command: "pnpm",
    arguments: [],
  };
}

export function wasmPackInvocation(
  environment = process.env,
  platform = process.platform,
) {
  if (environment.WASM_PACK !== undefined) {
    if (/\.(?:cmd|bat)$/iu.test(environment.WASM_PACK)) {
      throw new Error(
        "WASM_PACK must name a directly executable binary; Windows .cmd and .bat launchers are not supported.",
      );
    }
    return { command: environment.WASM_PACK, arguments: [] };
  }

  const cargoHome = environment.CARGO_HOME ?? join(homedir(), ".cargo");
  const installed = join(
    cargoHome,
    "bin",
    platform === "win32" ? "wasm-pack.exe" : "wasm-pack",
  );
  return {
    command: existsSync(installed) ? installed : "wasm-pack",
    arguments: [],
  };
}

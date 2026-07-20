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

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const validator = join(process.cwd(), "scripts/validate-endpoint.mjs");

describe("deployment endpoint validation", () => {
  it.each(["ws://example.test", "wss://example.test/base"])(
    "accepts %s",
    (endpoint) => {
      const result = validate(endpoint);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it.each([undefined, ""])("rejects a missing endpoint", (endpoint) => {
    const result = validate(endpoint);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VITE_PPOKER_ENDPOINT is required and must not be empty",
    );
  });

  it.each([
    "https://example.test",
    "wss://",
    "wss://user:placeholder@example.test",
    "wss://@example.test",
    "wss://example.test?room=planning",
    "wss://example.test#planning",
  ])("rejects invalid endpoint %s", (endpoint) => {
    const result = validate(endpoint);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "VITE_PPOKER_ENDPOINT must be a valid ws:// or wss:// URL without credentials, query parameters, or fragments",
    );
    expect(result.stderr).not.toContain("user:placeholder");
  });
});

function validate(endpoint: string | undefined) {
  const env = { ...process.env };
  delete env["VITE_PPOKER_ENDPOINT"];
  if (endpoint !== undefined) env["VITE_PPOKER_ENDPOINT"] = endpoint;

  return spawnSync(process.execPath, [validator], {
    encoding: "utf8",
    env,
  });
}

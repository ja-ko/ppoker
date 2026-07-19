import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", ["lcov", { projectRoot: repositoryRoot }]],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/generated/**"],
    },
  },
});

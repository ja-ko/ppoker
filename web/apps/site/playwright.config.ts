import { defineConfig, devices } from "@playwright/test";

const port = 4321;
const baseURL = `http://127.0.0.1:${port.toString()}`;

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: process.env["CI"] !== undefined,
  fullyParallel: true,
  outputDir: "test-results",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: process.env["CI"] === undefined ? "list" : "github",
  retries: process.env["CI"] === undefined ? 0 : 2,
  testDir: "./e2e/specs",
  timeout: 20_000,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "on-first-retry",
  },
  webServer: {
    command: `pnpm --filter @ppoker/web-client run build && pnpm exec vite --host 127.0.0.1 --port ${port.toString()} --strictPort`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${baseURL}/e2e/harness/`,
  },
  ...(process.env["CI"] === undefined ? {} : { workers: 2 }),
});

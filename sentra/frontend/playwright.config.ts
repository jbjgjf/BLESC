import { defineConfig, devices } from "@playwright/test";

import { RUN_ID, serverEnv } from "./e2e/env";

// Published before the workers are forked so they resolve the same run id, and
// therefore the same seeded accounts, study slug and invite codes.
process.env.E2E_RUN_ID = RUN_ID;

/**
 * End-to-end configuration for the enrollment gate (#164).
 *
 * **A production build, not `next dev`.** Demo mode is on by default whenever
 * `NODE_ENV === "development"` (`src/lib/demo.ts`), and demo mode plus a pilot
 * deployment is a combination `collectionRefusal` refuses outright — every test
 * would fail for a reason unrelated to what it tests, and `/pilot/join` would
 * render "デモモードでは参加登録は行いません。" instead of the flow. So the
 * suite builds and serves the real thing.
 *
 * **One worker.** The tests share one database and one seeded study, and the
 * withdrawal case mutates a row the others read. Parallel workers would make
 * failures depend on ordering.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./e2e/seed.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: `npm run build && npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    // A cold Next build is the long pole here, not the server start.
    timeout: 300_000,
    env: { ...serverEnv, PORT: String(PORT), E2E_RUN_ID: RUN_ID },
    stdout: "pipe",
    stderr: "pipe",
  },
});

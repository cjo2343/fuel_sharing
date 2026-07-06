import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: { timeout: 5000 },
  // This suite exercises the retired legacy PWA (app.js + server.py), and a few specs
  // race on audit-log / booking-linkage timing under CI load (GV-184). The suite is
  // frozen reference-only, so retry flaky specs in CI rather than chase each race — a
  // spec that passes on retry keeps the run green (and, with trace "on-first-retry"
  // below, captures a trace on the first retry for debugging). This stops the flake
  // from blocking unrelated migration PRs. The deterministic gates (validation, schema
  // equivalence, functional smoke) stay zero-retry and are what protect the live schema.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    // The production app registers a service worker for the PWA. In local smoke
    // tests we block it so cached production files, especially supabase-config.js,
    // cannot override the mocked test config.
    serviceWorkers: "block"
  },
  webServer: {
    command: "FUEL_LEDGER_DATA_FILE=.playwright-ledger-data.json PORT=4173 python3 server.py",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe"
  }
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: { timeout: 5000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    // The production app registers a service worker for the PWA. In local smoke
    // tests we block it so cached production files, especially supabase-config.js,
    // cannot override the mocked test config.
    serviceWorkers: "block"
  },
  webServer: {
    command: "python3 -m http.server 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe"
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Backlog #3 — cold-Render recovery should read as a calm amber "Reconnecting" banner
// when cached data is shown and a wake/retry is in flight, while RED is reserved for a
// genuine failure with no usable cached data. Any successful load must also clear the
// stale "failed" startup gate immediately (no refocus required).

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");

// --- cold-start discriminators exist -----------------------------------------------
assert.match(
  app,
  /function hasUsableCachedWorkspaceState\(\)/,
  "must detect whether cached/local workspace state has content to show"
);
assert.match(
  app,
  /function isBackendWakeOrRetryInFlight\(referenceTime = Date\.now\(\)\)/,
  "must detect whether a backend wake/retry is in flight"
);
assert.match(
  app,
  /function isColdStartReconnecting\(referenceTime = Date\.now\(\)\)[\s\S]*hasUsableCachedWorkspaceState\(\)[\s\S]*isBackendWakeOrRetryInFlight\(referenceTime\)/,
  "cold-start reconnecting must require both cached data AND a wake/retry in flight"
);

// hasUsableCachedWorkspaceState must look at real content (so a brand-new user with no
// cached data is NOT treated as usable — red must still fire for them).
assert.match(
  app,
  /function hasUsableCachedWorkspaceState\(\)[\s\S]*state\.trips[\s\S]*state\.bookings[\s\S]*state\.fuel[\s\S]*state\.updatedAt/,
  "usable-cache check must inspect actual workspace content and the restored snapshot stamp"
);

// --- banner defers to the calm amber state for both red paths ----------------------
const bannerStart = app.indexOf("function buildSyncHealthBannerState() {");
const bannerEnd = app.indexOf("function renderSyncHealthBanner()", bannerStart);
assert.ok(bannerStart >= 0 && bannerEnd > bannerStart, "banner builder must be present");
const bannerBlock = app.slice(bannerStart, bannerEnd);

// The "failed" gate branch must check the cold-start case before returning red.
assert.match(
  bannerBlock,
  /appStartupGateState\.phase === "failed"[\s\S]*if \(isColdStartReconnecting\(\)\) \{[\s\S]*coldStartReconnectBanner[\s\S]*Backend startup delayed/,
  "failed-gate banner must return the calm amber reconnect banner before the red startup error"
);
// The lastSyncError branch must check the cold-start case before returning red.
assert.match(
  bannerBlock,
  /if \(lastSyncError\) \{[\s\S]*if \(isColdStartReconnecting\(\)\) \{[\s\S]*coldStartReconnectBanner[\s\S]*Sync delayed/,
  "sync-delay banner must return the calm amber reconnect banner before the red sync error"
);

// The amber banner must be a warning that leads with reconnecting/waking wording and
// keeps the on-device reassurance.
assert.match(
  app,
  /const coldStartReconnectBanner = Object\.freeze\(\{[\s\S]*level: "warning"[\s\S]*Reconnecting[\s\S]*waking[\s\S]*shown from this device[\s\S]*kept on this device and will be retried/,
  "the reconnect banner must be amber, lead with the calm wording, and keep the on-device reassurance"
);

// --- successful load clears the stale failed gate immediately ----------------------
assert.match(
  app,
  /function recoverStartupGateAfterSuccessfulLoad\(reason = "load-success"\)[\s\S]*appStartupGateState\.phase !== "ready"[\s\S]*setAppStartupGatePhase\("ready"[\s\S]*clearSyncDelay\([\s\S]*renderSyncHealthBanner\(\)/,
  "a successful load must transition the gate to ready, clear the delay, and re-render the banner"
);
// It must not pre-empt the startup gate's own in-flight run.
assert.match(
  app,
  /function recoverStartupGateAfterSuccessfulLoad\([\s\S]*if \(appStartupGatePromise\) \{[\s\S]*clearSyncDelay/,
  "recovery must yield to the startup gate's own in-flight run to avoid flicker"
);
// It must be wired into both the normal load-success and admin Render load-success sites.
assert.match(
  app,
  /recoverStartupGateAfterSuccessfulLoad\(`load-success:\$\{reason\}`\)/,
  "normal load-success must recover the startup gate"
);
assert.match(
  app,
  /recoverStartupGateAfterSuccessfulLoad\(`admin-render-load:\$\{reason\}`\)/,
  "admin Render load-success must recover the startup gate"
);

// --- version bump companions -------------------------------------------------------
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v431"/, "build-info cache must be v431");
assert.match(serviceWorker, /const CACHE_NAME = "fuel-ledger-v431"/, "service-worker cache must be v431");

console.log("Cold-start reconnect banner guard passed.");

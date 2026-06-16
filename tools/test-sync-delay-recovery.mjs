import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

assert.match(
  appSource,
  /function clearSyncDelay\(reason = "sync-recovered"\) \{[\s\S]*lastSyncError = "";[\s\S]*lastCloudRetryAt = "";/,
  "app.js should have one helper that clears stale sync delay state"
);

assert.match(
  appSource,
  /if \(result === true\) \{[\s\S]*clearSyncDelay\(`\$\{reason\}-completed`\);[\s\S]*renderSyncHealthBanner\(\);[\s\S]*\}/,
  "loadSupabaseStateWithTimeout should clear delayed banner state after a successful timed load"
);

assert.match(
  appSource,
  /clearSyncDelay\(`load-success:\$\{reason\}`\);[\s\S]*recordSyncDiagnostic\("load-success"/,
  "successful Supabase loads should clear stale delayed-sync errors before recording load-success"
);

assert.match(
  appSource,
  /function markRemoteSaveSucceeded\(label\) \{[\s\S]*clearSyncDelay\(`save-success:\$\{label \|\| "cloud"\}`\);[\s\S]*setSyncStatus\(label\);[\s\S]*\}/,
  "successful Supabase saves should also clear stale delayed-sync errors"
);

assert.match(
  appSource,
  /loadSupabaseStateWithTimeout\(\s*\{ reason: "window-focus", background: true \}/,
  "window-focus refresh should be treated as a background sync so a timeout after a healthy load does not show a scary delayed banner"
);

assert.match(
  appSource,
  /const syncDelayHealthyGraceMs = 10 \* 60 \* 1000;/,
  "background sync timeouts should allow a recent healthy sync grace window"
);

assert.match(
  appSource,
  /return shouldSurfaceBackgroundSyncDelay\(startedAt\);/,
  "background sync timeouts should only show the delayed banner when the last healthy sync is stale"
);

assert.doesNotMatch(
  appSource,
  /lastHealthySyncMs < startedAt/,
  "background sync timeouts must not treat every earlier successful sync as stale"
);

assert.match(
  appSource,
  /function hasRecentHealthyCloudSync\(referenceTime = Date\.now\(\), graceMs = syncDelayHealthyGraceMs\)/,
  "app.js should centralize recent healthy sync checks for background sync decisions"
);

assert.match(
  appSource,
  /if \(result === false && !timedOut\) \{[\s\S]*isBackgroundSync && !shouldShowDelayedStatus\(\)[\s\S]*background-sync-incomplete[\s\S]*markCloudSyncDidNotComplete/,
  "background focus syncs that return false after a healthy load should not flip the visible banner to delayed"
);

assert.match(
  appSource,
  /let lastFocusSyncAttemptAt = 0;[\s\S]*const recentHealthyFocusSyncGraceMs = 2 \* 60 \* 1000;/,
  "window-focus syncs should have an explicit attempt cooldown and a short healthy-sync grace window"
);

assert.match(
  appSource,
  /recentFocusAttempt \|\| recentLoadAttempt[\s\S]*focus-sync-skip[\s\S]*recordSyncDiagnostic\("focus-sync-skip"/,
  "window-focus sync cooldown skips should be recorded as diagnostics instead of delayed sync failures"
);

assert.match(
  appSource,
  /ledgerEventsChannel && ledgerEventsChannelLedgerId === ledgerId[\s\S]*ledger-events-subscription-skip/,
  "ledger event realtime subscriptions should be reused when the active ledger did not change"
);

assert.match(
  appSource,
  /supabaseStateChannel && supabaseStateChannelLedgerId === ledgerId[\s\S]*realtime-subscription-skip/,
  "broad realtime subscriptions should be reused when the active ledger did not change"
);


assert.match(
  appSource,
  /recordSyncDiagnostic\("service-worker-controllerchange", "New app shell is active and will be used on the next natural page load\."\)/,
  "service worker controller changes should be diagnostic-only instead of forcing an immediate reload"
);

assert.doesNotMatch(
  appSource,
  /controllerchange[\s\S]{0,250}window\.location\.reload\(\)/,
  "service worker controller changes should not force reloads that recreate Supabase sessions and realtime sockets"
);

assert.match(
  appSource,
  /const fuelPriceFetchTimeoutMs = 3500;[\s\S]*let fuelPriceInFlight = false;/,
  "live fuel price refresh should have a short timeout and in-flight guard"
);

assert.match(
  appSource,
  /function fetchFuelPriceWithTimeout\(url, timeoutMs = fuelPriceFetchTimeoutMs\)[\s\S]*AbortController[\s\S]*controller\.abort\(\)/,
  "live fuel price fetches should be abortable so a slow public API cannot stall the app"
);

assert.match(
  appSource,
  /if \(fuelPriceInFlight\) return;[\s\S]*finally \{[\s\S]*fuelPriceInFlight = false;[\s\S]*scheduleFuelPriceRefresh\(\);[\s\S]*\}/,
  "live fuel price refreshes should not pile up if the public API is slow"
);

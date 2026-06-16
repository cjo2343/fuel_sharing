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
  /const recentHealthySync = hasRecentHealthyCloudSync\(now, syncDelayHealthyGraceMs\);[\s\S]*foregroundWriteActive[\s\S]*focus-sync-skip/,
  "window-focus refreshes should be skipped after a healthy sync or while foreground writes are active"
);

assert.match(
  appSource,
  /function shouldDeferBackgroundCloudLoad\(reason = "background", referenceTime = Date\.now\(\)\)[\s\S]*hasForegroundWriteInFlight\(referenceTime\)/,
  "background cloud loads should defer while user writes are in flight"
);

assert.match(
  appSource,
  /shouldDeferBackgroundCloudLoad\(reason, now\)[\s\S]*background-load-deferred[\s\S]*return false;/,
  "loadSupabaseState should not overlap background refreshes with foreground writes"
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
  /recordSyncDiagnostic\("service-worker-controllerchange", "App update is ready; close\/reopen once so page files and the service-worker cache use the same build\."\)/,
  "service worker controller changes should explain the clean close/reopen version handoff"
);

assert.match(
  appSource,
  /service-worker-update-ready[\s\S]*Waiting service worker will activate after old pages are closed\./,
  "service worker updates should wait for close/reopen instead of forcing mixed-version control"
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

assert.match(
  appSource,
  /function shouldSurfaceManualSyncDelay\(referenceTime = Date\.now\(\)\) \{[\s\S]*return !hasRecentHealthyCloudSync\(referenceTime, syncDelayHealthyGraceMs\);[\s\S]*\}/,
  "manual sync timeouts should also respect a recent healthy cloud sync before showing the red banner"
);

assert.match(
  appSource,
  /async function handleManualSyncNow\(source = "manual"\) \{[\s\S]*clearSyncDelay\(`\$\{reason\}-start`\);[\s\S]*recordSyncDiagnostic\("manual-load-start"/,
  "manual Sync now should clear stale background/focus delay state before starting and record a manual start diagnostic"
);

assert.match(
  appSource,
  /\{ force: true, reason, manual: true \}/,
  "manual Sync now should pass an explicit manual flag into the timed Supabase load wrapper"
);

assert.match(
  appSource,
  /if \(isManualSync\) return shouldSurfaceManualSyncDelay\(startedAt\);/,
  "timed manual syncs should decide delayed-banner visibility through the manual sync policy"
);

assert.match(
  appSource,
  /manual-load-timeout-after-healthy-sync/,
  "manual sync timeouts after a recent healthy cloud sync should be diagnostic-only instead of red-banner failures"
);

assert.match(
  appSource,
  /manual-load-skipped-existing-sync/,
  "manual sync attempts skipped by an existing in-flight load should leave a specific diagnostic breadcrumb"
);


assert.match(
  appSource,
  /function clearRecoverableSyncDelayAfterHealthySync\(reason = "healthy-sync"\)[\s\S]*hasRecentHealthyCloudSync\(Date\.now\(\), syncDelayHealthyGraceMs\)[\s\S]*clearSyncDelay\(reason\)/,
  "recoverable manual/focus sync delay warnings should be cleared after a recent healthy normalized-table sync"
);

assert.match(
  appSource,
  /function buildSyncHealthBannerState\(\) \{[\s\S]*clearRecoverableSyncDelayAfterHealthySync\("render-banner-after-healthy-sync"\)/,
  "the visible sync-health banner should suppress stale recoverable delay state before rendering"
);

assert.match(
  appSource,
  /title: normalizedReadModeActive \? "Database tables" : "Database saving"[\s\S]*JSON is only a manual\/periodic backup snapshot/,
  "Admin follow-up should describe normalized table health separately from the JSON backup snapshot"
);

assert.match(
  appSource,
  /const visibleSyncingFailsafeMs = 30000;[\s\S]*let visibleSyncingStartedAt = 0;[\s\S]*let visibleSyncingFailsafeTimer = null;/,
  "visible Syncing status should have a failsafe timer so background paths cannot leave it stuck"
);

assert.match(
  appSource,
  /function clearStaleVisibleSyncingStatus\(reason = "syncing-failsafe"\)[\s\S]*syncing-stale-cleared[\s\S]*setSyncStatus\(getHealthySyncStatusLabel\(\)\)/,
  "stale visible Syncing state should clear back to the latest healthy cloud/database status"
);

assert.match(
  appSource,
  /function setSyncStatus\(label, options = \{\}\)[\s\S]*display\.status === "syncing"[\s\S]*recordSyncDiagnostic\("syncing-start"[\s\S]*scheduleVisibleSyncingFailsafe/,
  "setSyncStatus should centrally start the visible Syncing failsafe and diagnostic trail"
);

assert.match(
  appSource,
  /recordSyncDiagnostic\("syncing-clear"[\s\S]*clearVisibleSyncingFailsafe\(\)/,
  "leaving Syncing should centrally record a clear diagnostic and cancel the failsafe"
);

assert.match(
  appSource,
  /const visibleSyncBackgroundSources = new Set\(\[[\s\S]*"focus-refresh"[\s\S]*"realtime"[\s\S]*"service-worker"[\s\S]*"window-focus"[\s\S]*\]\);/,
  "background/focus/realtime/service-worker sources should be explicitly classified before they can affect the visible sync badge"
);

assert.match(
  appSource,
  /function shouldAllowVisibleSyncStatus\(label, source\)[\s\S]*isBackgroundVisibleSyncSource\(normalizedSource\)[\s\S]*return false;/,
  "background sources should be blocked from setting visible Saving/Syncing status"
);

assert.match(
  appSource,
  /function setSyncStatus\(label, options = \{\}\) \{[\s\S]*const requestedSource = normalizeVisibleSyncSource\(options\.source, label\);[\s\S]*recordBlockedVisibleSyncStatus\(label, requestedSource, options\);[\s\S]*return;/,
  "setSyncStatus should centrally block background attempts to show Saving/Syncing and record the blocked source"
);

assert.match(
  appSource,
  /setSyncStatus\("Saving", \{ source: "trip-save" \}\)[\s\S]*setSyncStatus\("Saving", \{ source: "fuel-save" \}\)[\s\S]*setSyncStatus\("Saving", \{ source: "booking-save" \}\)[\s\S]*setSyncStatus\("Saving", \{ source: "settlement-request-save" \}\)/,
  "foreground data writes should name their visible Saving source so stuck status reports identify the real write path"
);

assert.match(
  appSource,
  /setSyncStatus\("Syncing", \{ source: "server-load" \}\)[\s\S]*setSyncStatus\("Saving", \{ source: "server-save" \}\)/,
  "server fallback load/save paths should name their visible sync source"
);


assert.match(
  appSource,
  /function dataIoStatusForPhase\(phase, ok\) \{[\s\S]*if \(\/skip\/i\.test\(normalizedPhase\)\) return "skipped";[\s\S]*if \(ok \|\| normalizedPhase === "success"\) return "ok";/,
  "data I/O skip phases should render as skipped even when ok=true, instead of looking like active ok rows"
);

assert.match(
  appSource,
  /const duration = Number\.isFinite\(operation\.durationMs\) \? formatDurationMs\(operation\.durationMs\) : status === "active" \? "active" : "instant";/,
  "finished standalone data I/O diagnostics should not display as active when they have no paired duration"
);

assert.match(
  appSource,
  /function isSupabaseLoadNoiseEvent\(entry = \{\}\)[\s\S]*label\.startsWith\("sync-diagnostic:"\)[\s\S]*function supabaseLoadActivityEvents\(events = \[\]\)[\s\S]*filter\(\(entry\) => !isSupabaseLoadNoiseEvent\(entry\)\)/,
  "Admin activity totals should ignore diagnostic breadcrumbs and foreground-operation bookkeeping so the headline number reflects real app-side load/save work"
);

assert.match(
  appSource,
  /const activityEvents = supabaseLoadActivityEvents\(events\);[\s\S]*const lastMinute = activityEvents\.filter[\s\S]*const highActivity = lastMinute >= 20 \|\| \(lastMinute >= 10 && lastFiveMinutes >= 50\);[\s\S]*const coolingDown = !highActivity && lastFiveMinutes >= 50;/,
  "Admin activity severity should use filtered real activity and cool down when the last minute is quiet"
);

assert.match(
  appSource,
  /const visibleSavingFailsafeMs = 20000;[\s\S]*let visibleSavingStartedAt = 0;[\s\S]*let visibleSavingFailsafeTimer = null;/,
  "visible Saving status should have its own failsafe timer so foreground save labels cannot stay stuck"
);

assert.match(
  appSource,
  /function clearStaleVisibleSavingStatus\(reason = "saving-failsafe"\)[\s\S]*saving-stale-cleared[\s\S]*setSyncStatus\(getHealthySyncStatusLabel\(\)\)/,
  "stale visible Saving state should clear back to the latest healthy cloud/database status"
);

assert.match(
  appSource,
  /function clearPaymentActionSavingUi\(reason = "payment-action-finished"\)[\s\S]*finishForegroundOperationsBySource\("payment-status-action", reason\)[\s\S]*finishForegroundOperationsBySource\("settlement-request-save", reason\)[\s\S]*restoreHealthySyncStatusAfterQuietSync\(reason\)[\s\S]*clearVisibleSavingFailsafe\(\)/,
  "payment actions should clear payment and settlement foreground operations in their finally cleanup"
);

assert.match(
  appSource,
  /const paymentStatusActionTimeoutMs = 15000;[\s\S]*const paymentStatusActionNormalizedTimeoutMs = 45000;/,
  "payment actions should keep the short Render/API abort but give the outer normalized save enough time to fall back before reporting a timeout"
);

assert.match(
  appSource,
  /saveSettlementRequestToNormalizedTableFirst\(settlement, nextStatus, \{ previousStatus, auditEntry, skipVisibleSaving: true \}\),[\s\S]*"Payment status normalized save",[\s\S]*paymentStatusActionNormalizedTimeoutMs/,
  "the payment action outer watchdog should use one visible payment foreground operation and avoid starting a second settlement save latch"
);

assert.match(
  appSource,
  /error\.isRenderPaymentActionTimeout = true;[\s\S]*return \{ ok: false, error, shouldFallback: false, backend: "render-api" \}/,
  "Render payment API timeouts should reset the foreground action instead of falling through to a second direct Supabase fallback that can leave Saving active"
);

assert.match(
  appSource,
  /recordSupabaseLoadEvent\("payment-action-backend-start"[\s\S]*recordSyncDiagnostic\("payment-action-backend-start"/,
  "payment actions should record whether the backend write path was actually reached"
);


assert.match(
  appSource,
  /const foregroundOperationStaleMs = 20000;[\s\S]*const foregroundOperations = new Map\(\);[\s\S]*function beginForegroundOperation\(source = "foreground-write"[\s\S]*function finishAllForegroundOperations\(reason = "foreground-operation-finished"\)/,
  "visible Saving should be backed by a central foreground operation tracker instead of independent stuck latches"
);

assert.match(
  appSource,
  /function setSyncStatus\(label, options = \{\}\)[\s\S]*display\.status === "saving"[\s\S]*beginForegroundOperation\(requestedSource[\s\S]*finishAllForegroundOperations\(`status:\$\{String\(label \|\| display\.status \|\| "cleared"\)\}`\)/,
  "setSyncStatus should derive visible Saving from foreground operations and clear them when leaving Saving"
);

assert.match(
  appSource,
  /<span>Foreground save<\/span>[\s\S]*foregroundSummary[\s\S]*If Saving is visible, this card must name the operation causing it\./,
  "Admin diagnostics should show the active foreground save causing the visible Saving badge"
);

assert.match(
  appSource,
  /display\.status === "saving"[\s\S]*recordSyncDiagnostic\("saving-start"[\s\S]*scheduleVisibleSavingFailsafe/,
  "setSyncStatus should centrally start the visible Saving failsafe and diagnostic trail"
);

assert.match(
  appSource,
  /recordSyncDiagnostic\("saving-clear"[\s\S]*clearVisibleSavingFailsafe\(\)/,
  "leaving Saving should centrally record a clear diagnostic and cancel the failsafe"
);

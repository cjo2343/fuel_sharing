import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync("app.js", "utf8");

assert.match(appSource, /let adminAutoRefreshTimer = null;/, "Admin should have a calm auto-refresh timer state.");
assert.match(appSource, /const adminAutoRefreshIntervalMs = 15000;/, "Admin auto-refresh should run on a bounded 15s interval, not a tight loop.");
assert.match(appSource, /function startAdminAutoRefresh\(/, "Admin view should start the auto-refresh loop.");
assert.match(appSource, /function stopAdminAutoRefresh\(/, "Admin view should stop the auto-refresh loop when hidden or left.");
assert.match(appSource, /function runAdminAutoRefreshTick\(/, "Admin auto-refresh should use one central tick function.");
assert.match(appSource, /startAdminAutoRefresh\("admin-tab-open"\)/, "Opening Admin should start automatic refreshes.");
assert.match(appSource, /document\.addEventListener\("visibilitychange"/, "Admin auto-refresh should pause while the tab is hidden.");
assert.match(appSource, /renderAdminAutoRefreshCard\(\)/, "The Supabase load monitor should show Admin auto-refresh status.");
assert.match(appSource, /Admin auto-refresh keeps this overview moving; broad live sync can stay off to protect Supabase CPU\./, "Realtime copy should explain that auto-refresh, not broad live sync, keeps Admin smooth.");
assert.match(appSource, /activityLimit: 8/, "Global diagnostics auto-refresh should request a small bounded activity window.");
assert.match(appSource, /workspaceLimit: 40/, "Global diagnostics auto-refresh should keep workspace queries bounded.");
assert.match(appSource, /memberLimit: 120/, "Global diagnostics auto-refresh should keep member queries bounded.");
assert.doesNotMatch(appSource, /activityLimit: 120/, "Global diagnostics should not request huge activity payloads from the browser.");

console.log("Admin auto-refresh overview guardrail passed.");

assert.match(appSource, /dueAdminAutoRefreshTasks/, "Admin auto-refresh should compute due work before running optional checks.");
assert.match(appSource, /chooseAdminAutoRefreshTask/, "Admin auto-refresh should stagger heavy optional checks instead of firing all at once.");
assert.match(appSource, /lastGoodOwnerGlobalDiagnosticsStatus/, "Global diagnostics should preserve last-known-good data after optional refresh timeouts.");
assert.match(appSource, /ownerGlobalDiagnosticsReportStatus\(\)/, "Reports should use last-known-good global diagnostics instead of timeout-cleared empty data.");
assert.match(appSource, /isOptionalAdminHealthDiagnostic/, "Render admin-health timeouts should stay in optional Admin diagnostics, not the core Latest Data I\/O card.");

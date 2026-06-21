import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync("app.js", "utf8");

assert.match(appSource, /let adminAutoRefreshTimer = null;/, "Admin should have a calm auto-refresh timer state.");
assert.match(appSource, /const adminAutoRefreshIntervalMs = 30000;/, "Admin auto-refresh should run on a bounded 30s interval, not a tight loop.");
assert.match(appSource, /function startAdminAutoRefresh\(/, "Admin view should start the auto-refresh loop.");
assert.match(appSource, /function stopAdminAutoRefresh\(/, "Admin view should stop the auto-refresh loop when hidden or left.");
assert.match(appSource, /function runAdminAutoRefreshTick\(/, "Admin auto-refresh should use one central tick function.");
assert.match(appSource, /startAdminAutoRefresh\("admin-tab-open"\)/, "Opening Admin should start automatic refreshes.");
assert.match(appSource, /document\.addEventListener\("visibilitychange"/, "Admin auto-refresh should pause while the tab is hidden.");
assert.match(appSource, /renderAdminAutoRefreshCard\(\)/, "The Supabase load monitor should show Admin auto-refresh status.");
assert.match(appSource, /Admin background sync keeps this overview moving with lightweight cached checks; full Render health runs only in deep diagnostics\./, "Realtime copy should explain that lightweight cached sync keeps Admin smooth.");
assert.match(appSource, /activityLimit: 5/, "Global diagnostics auto-refresh should request a tiny bounded activity window.");
assert.match(appSource, /workspaceLimit: 40/, "Global diagnostics auto-refresh should keep workspace queries bounded.");
assert.match(appSource, /memberLimit: 80/, "Global diagnostics auto-refresh should keep member queries tightly bounded.");
assert.doesNotMatch(appSource, /activityLimit: 120/, "Global diagnostics should not request huge activity payloads from the browser.");

console.log("Admin auto-refresh overview guardrail passed.");

assert.match(appSource, /dueAdminAutoRefreshTasks/, "Admin auto-refresh should compute due work before running optional checks.");
assert.match(appSource, /chooseAdminAutoRefreshTask/, "Admin auto-refresh should stagger optional checks instead of firing all at once.");
assert.doesNotMatch(appSource, /tasks\.push\("health"\)/, "Admin auto-refresh must not enqueue heavy Render admin health.");
assert.match(appSource, /Full \/api\/admin\/health is an explicit/, "Full Render admin health should be explicit-only, not background-polled.");
assert.match(appSource, /lastGoodOwnerGlobalDiagnosticsStatus/, "Global diagnostics should preserve last-known-good data after optional refresh timeouts.");
assert.match(appSource, /ownerGlobalDiagnosticsReportStatus\(\)/, "Reports should use last-known-good global diagnostics instead of timeout-cleared empty data.");
assert.match(appSource, /isOptionalAdminHealthDiagnostic/, "Render admin-health timeouts should stay in optional Admin diagnostics, not the core Latest Data I\/O card.");

assert.match(appSource, /adminAutoOptionalFailureBackoffMs/, "Slow optional Admin checks should back off after failures.");
assert.match(appSource, /Export immediately from the current cached diagnostics snapshot/, "Load reports should not trigger slow global diagnostics refreshes.");
assert.doesNotMatch(appSource, /testman21 memberships/, "Admin global diagnostics should not render a hardcoded test-user card.");
assert.doesNotMatch(appSource, /targetEmail: appOwnerDiagnosticsTargetEmail\(\)/, "Global diagnostics should not hardcode a target test email in normal Admin.");

assert.match(appSource, /ownerActivityAutoRefreshEnabled = false/, "Owner Activity should be manual/cached and must not auto-hammer Render.");
assert.match(appSource, /limit: 30, includeMetadata: false/, "Owner Activity requests should be lightweight by default. ");
assert.doesNotMatch(appSource, /targetMemberships/, "Frontend should use generic memberRows instead of the old targeted membership debug field.");

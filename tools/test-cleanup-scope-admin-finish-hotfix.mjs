import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:197|198|199|200|201|202|203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253)"/, "build-info.js must be bumped to v297.");
assert.match(buildInfo, /buildLabel:\s*"(?:cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "build-info.js must use the v297 build label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[7-9]|3[0-9][0-9])"/, "build-info.js must expect the v297 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[7-9]|3[0-9][0-9])"/, "service-worker.js must use the v297 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "service-worker.js must use the v297 build label.");

const cleanupViaRenderStart = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTablesViaRender");
const cleanupViaRenderEnd = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason", cleanupViaRenderStart);
assert.ok(cleanupViaRenderStart >= 0 && cleanupViaRenderEnd > cleanupViaRenderStart, "app.js must include the Render cleanup helper.");
const cleanupViaRender = app.slice(cleanupViaRenderStart, cleanupViaRenderEnd);
assert.ok(!cleanupViaRender.includes("currentLedger"), "Render cleanup helper must not reference the out-of-scope currentLedger variable.");
assert.match(cleanupViaRender, /const ledgerId = getActiveLedgerId\(\);/, "Render cleanup helper must use the active ledger helper.");
assert.match(cleanupViaRender, /fetch\(renderAdminTestDataCleanupUrl/, "Render cleanup helper must still call the Render cleanup route.");

const securityListenerStart = app.indexOf('els.runSecurityScenario?.addEventListener("click", async () => {');
const securityListenerEnd = app.indexOf('els.exportTestLabReport?.addEventListener', securityListenerStart);
assert.ok(securityListenerStart >= 0 && securityListenerEnd > securityListenerStart, "Security Health listener must be present.");
const securityListener = app.slice(securityListenerStart, securityListenerEnd);
assert.match(securityListener, /requireTypedAdminConfirmation|requireRenderVerifiedAdvancedAdminAction/, "Security Health confirmation must happen before opening the admin Data I/O row.");
assert.match(securityListener, /traceAdminToolOperation\("security-health", "Run live Security Health", \(\) => runStandaloneSecurityHealthScenario\(\{ skipConfirmation: true \}\)(?:, \{ staleAfterMs: longAdminToolDataIoOperationStaleMs \})?\)/, "Security Health admin Data I/O row must run after confirmation without a second blocking prompt.");

const saveListenerStart = app.indexOf('els.saveTestLabReportCloud?.addEventListener("click", async () => {');
const saveListenerEnd = app.indexOf('els.cleanupTestLabData?.addEventListener', saveListenerStart);
assert.ok(saveListenerStart >= 0 && saveListenerEnd > saveListenerStart, "Save Test Lab report listener must be present.");
const saveListener = app.slice(saveListenerStart, saveListenerEnd);
assert.match(saveListener, /requireTypedAdminConfirmation|requireRenderVerifiedAdvancedAdminAction/, "Save report confirmation must happen before opening the admin Data I/O row.");
assert.match(saveListener, /traceAdminToolOperation\("save-test-lab-report-cloud", "Save Test Lab report to cloud", \(\) => saveCurrentTestLabReportToCloud\(\{ skipConfirmation: true \}\)\)/, "Save report admin Data I/O row must run after confirmation without a second blocking prompt.");
assert.match(app, /async function saveCurrentTestLabReportToCloud\(\{ skipConfirmation = false \} = \{\}\)/, "Save report helper must keep confirmation when called directly.");
assert.match(app, /async function runStandaloneSecurityHealthScenario\(\{ skipConfirmation = false \} = \{\}\)/, "Security Health helper must keep confirmation when called directly.");
assert.match(packageJson, /test-cleanup-scope-admin-finish-hotfix\.mjs/, "Validate script must run the v297 guard test.");

console.log("Cleanup scope and admin finish hotfix guard check passed.");

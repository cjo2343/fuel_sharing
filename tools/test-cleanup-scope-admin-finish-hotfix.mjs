import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReleaseMetadataAtLeast } from './release-metadata-helpers.mjs';

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assertReleaseMetadataAtLeast(buildInfo, serviceWorker, {
  minimumVersion: '2026.06.18.197',
  minimumCache: 297,
  message: 'Cleanup scope admin finish release metadata'
});

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

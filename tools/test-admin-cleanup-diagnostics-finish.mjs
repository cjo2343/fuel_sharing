import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:201|202|203)"/, "build-info.js must be bumped to v301.");
assert.match(buildInfo, /buildLabel:\s*"admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits"/, "build-info.js must use the v301 label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v30[1-3]"/, "build-info.js must expect the v301 cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v30[1-3]"/, "service-worker.js must use the v301 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits"/, "service-worker.js must use the v301 label.");

const cleanupFunctionStart = app.indexOf("async function cleanupGeneratedTestDataWithReport()");
const cleanupFunctionEnd = app.indexOf("function cloneForTestLab", cleanupFunctionStart);
assert.ok(cleanupFunctionStart >= 0 && cleanupFunctionEnd > cleanupFunctionStart, "cleanupGeneratedTestDataWithReport must be present.");
const cleanupFunction = app.slice(cleanupFunctionStart, cleanupFunctionEnd);
assert.match(
  cleanupFunction,
  /persistGeneratedAdminStateWithRenderMirror\("cleanup-test-lab-data",[\s\S]*\{\s*checkTables:\s*false\s*\}\)/,
  "cleanup Test Lab data must not run the redundant normalized table check after Render cleanup already set normalized health."
);

const renderCleanupStart = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTablesViaRender");
const renderCleanupEnd = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason", renderCleanupStart);
assert.ok(renderCleanupStart >= 0 && renderCleanupEnd > renderCleanupStart, "Render normalized cleanup helper must be present.");
const renderCleanup = app.slice(renderCleanupStart, renderCleanupEnd);
assert.match(
  renderCleanup,
  /recordDataIoDiagnostic\("success", \{ \.\.\.traceMeta, ok: true, ledgerId, detail: `soft-deleted \$\{result\.total\} generated normalized row\(s\)` \}\)/,
  "successful Render normalized cleanup diagnostics must be marked ok: true."
);

const retentionStart = app.indexOf("async function callRetentionAdminRoute");
const retentionEnd = app.indexOf("async function previewRetentionCleanupViaRender", retentionStart);
assert.ok(retentionStart >= 0 && retentionEnd > retentionStart, "Render retention route helper must be present.");
const retentionHelper = app.slice(retentionStart, retentionEnd);
assert.match(
  retentionHelper,
  /recordDataIoDiagnostic\("success", \{ \.\.\.traceMeta, ok: true, detail: `Render retention \$\{action\} completed` \}\)/,
  "successful Render retention diagnostics must be marked ok: true."
);

assert.match(packageJson, /test-admin-cleanup-diagnostics-finish\.mjs/, "Validate script must run the v301 guard test.");
assert.match(packageJson, /node --check tools\/test-admin-cleanup-diagnostics-finish\.mjs/, "Validate script must syntax-check the v301 guard test.");

console.log("Admin cleanup diagnostics finish guard check passed.");

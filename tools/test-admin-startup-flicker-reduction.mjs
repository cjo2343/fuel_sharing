import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReleaseMetadataAtLeast } from './release-metadata-helpers.mjs';

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assertReleaseMetadataAtLeast(buildInfo, serviceWorker, {
  minimumVersion: '2026.06.18.198',
  minimumCache: 298,
  message: 'Admin startup flicker release metadata'
});

assert.match(app, /let adminUiBatchDepth = 0;/, "app.js must track admin UI batch depth.");
assert.match(app, /async function withAdminUiBatch\(action\)/, "app.js must expose a batch wrapper for admin UI work.");
assert.match(app, /function scheduleSupabaseLoadMonitorRender\(\)/, "Data I/O monitor renders must be schedulable.");
assert.match(app, /adminUiLoadMonitorPending = true;/, "Data I/O monitor renders must be queued while admin work is active.");
assert.match(app, /adminUiRenderPending = true;/, "Full app renders must be queued while admin work is active.");
assert.match(app, /window\.requestAnimationFrame\(run\)/, "Queued admin UI refreshes should flush on animation frame when available.");

const recordStart = app.indexOf("function recordDataIoDiagnostic");
const recordEnd = app.indexOf("async function traceDataIo", recordStart);
assert.ok(recordStart >= 0 && recordEnd > recordStart, "recordDataIoDiagnostic must be present before traceDataIo.");
const recordBlock = app.slice(recordStart, recordEnd);
assert.match(recordBlock, /scheduleSupabaseLoadMonitorRender\(\);/, "Data I/O diagnostics must use the batched monitor render helper.");
assert.ok(!recordBlock.includes("renderSupabaseLoadMonitor();"), "Data I/O diagnostics must not force immediate monitor repaint during admin batches.");

const traceAdminStart = app.indexOf("async function traceAdminToolOperation");
const traceAdminEnd = app.indexOf("function recordAdminToolSkip", traceAdminStart);
assert.ok(traceAdminStart >= 0 && traceAdminEnd > traceAdminStart, "traceAdminToolOperation must be present.");
const traceAdminBlock = app.slice(traceAdminStart, traceAdminEnd);
assert.match(traceAdminBlock, /withAdminUiBatch\(\(\) => traceDataIo/, "Admin tool operations must batch start/success/error UI churn.");

const renderStart = app.indexOf("function render() {");
const renderEnd = app.indexOf("async function initializeSync", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, "render function must be present.");
const renderBlock = app.slice(renderStart, renderEnd);
assert.match(renderBlock, /if \(adminUiBatchDepth > 0\)/, "Full render must defer while an admin batch is active.");

assert.match(packageJson, /test-admin-startup-flicker-reduction\.mjs/, "Validate script must run the v298 guard test.");
console.log("Admin startup/admin flicker reduction guard check passed.");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:198|199|200|201|202|203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257|258|259|260|261)"/, "build-info.js must be bumped to v298.");
assert.match(buildInfo, /buildLabel:\s*"(?:admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "build-info.js must use the v298 build label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[8-9]|[34][0-9][0-9])"/, "build-info.js must expect the v298 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[8-9]|[34][0-9][0-9])"/, "service-worker.js must use the v298 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "service-worker.js must use the v298 build label.");

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

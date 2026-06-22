import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:19[3-9]|2[0-9][0-9])"/, "Build info must be bumped for v293.");
assert.match(buildInfo, /buildLabel:\s*"(?:post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|normalized-test-data-cleanup|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "Build label must describe normalized Test Lab cleanup or a later build preserving it.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[3-9]|[34][0-9][0-9])"/, "Expected service-worker cache must be v293.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[3-9]|[34][0-9][0-9])"/, "Service-worker cache must be v293.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|normalized-test-data-cleanup|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "Service-worker build label must be v293 or a later preserving label.");

assert.match(app, /async function cleanupGeneratedRowsFromNormalizedTables\(/, "Cleanup must include a normalized-table cleanup helper.");
assert.match(app, /source = "normalized-test-data-cleanup"/, "Normalized cleanup must have its own Data I\/O source.");
assert.match(app, /renderAdminTestDataCleanupUrl = "\/api\/admin\/test-data\/cleanup"/, "Cleanup must use the Render cleanup route.");
assert.match(app, /endpoint: renderAdminTestDataCleanupUrl/, "Cleanup Data I/O must identify the Render endpoint.");
assert.match(app, /Browser direct-table cleanup fallback is disabled/, "Browser direct-table cleanup fallback should be disabled after Render route is proven.");
assert.match(app, /recordSupabaseLoadEvent\("render-normalized-test-data-cleanup"/, "Render cleanup must leave a visible monitor event.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("cleanup-test-lab-data"\)/, "Clean Test Lab data must clean normalized tables before mirroring.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("remove-generated-test-data"\)/, "Remove generated test data must also clean normalized tables.");
assert.match(packageJson, /test-normalized-test-data-cleanup\.mjs/, "Validate script must run the v293 guard test.");

console.log("Normalized Test Lab cleanup guard check passed.");

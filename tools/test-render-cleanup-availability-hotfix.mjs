import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:196|197|198|199|200|201|202|203|204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224)"/, "build-info.js must be v296 or a later preserving hotfix.");
assert.match(buildInfo, /buildLabel:\s*"(?:render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "build-info.js must use the v296/v297 hotfix build label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[6-9]|3[0-9][0-9])"/, "build-info.js must expect the v296/v297 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[6-9]|3[0-9][0-9])"/, "service-worker.js must use the v296/v297 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, "service-worker.js must use the v296/v297 hotfix build label.");

const cleanupViaRenderStart = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTablesViaRender");
const cleanupViaRenderEnd = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason", cleanupViaRenderStart);
assert.ok(cleanupViaRenderStart >= 0 && cleanupViaRenderEnd > cleanupViaRenderStart, "app.js must include the Render cleanup helper.");
const cleanupViaRender = app.slice(cleanupViaRenderStart, cleanupViaRenderEnd);
assert.ok(!cleanupViaRender.includes("renderBackendAvailable"), "Render cleanup helper must not reference the undefined renderBackendAvailable flag.");
assert.match(cleanupViaRender, /typeof fetch !== "function"/, "Render cleanup helper should use a safe fetch availability check.");
assert.match(cleanupViaRender, /fetch\(renderAdminTestDataCleanupUrl/, "Render cleanup helper must still call the Render cleanup route.");
assert.match(cleanupViaRender, /Browser direct-table cleanup fallback is disabled/, "Render cleanup helper must fail closed instead of using browser cleanup fallback.");
assert.match(packageJson, /test-render-cleanup-availability-hotfix\.mjs/, "Validate script must run the v296 hotfix guard test.");

console.log("Render cleanup availability hotfix guard check passed.");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:195|196|197|198|199|200|201|202|203|204|203|204)"/, "build-info.js must be v295 or a later preserving hotfix.");
assert.match(buildInfo, /buildLabel:\s*"(?:render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|save-report-timeout-feedback)"/, "build-info.js must use the v295 build label or the v296 hotfix label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[5-9]|30[0-4])"/, "build-info.js must expect the v295/v296/v297 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[5-9]|30[0-4])"/, "service-worker.js must use the v295/v296/v297 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|save-report-timeout-feedback)"/, "service-worker.js must use the v295 build label or the v296 hotfix label.");

assert.match(app, /const renderAdminTestDataCleanupUrl = "\/api\/admin\/test-data\/cleanup";/, "app.js must define the Render admin cleanup URL.");
assert.match(app, /async function cleanupGeneratedRowsFromNormalizedTablesViaRender\(/, "app.js must include a Render normalized cleanup helper.");
assert.match(app, /cleanupGeneratedRowsFromNormalizedTablesViaRender\(reason\)/, "Normalized cleanup must try the Render route first.");
assert.match(app, /source: "normalized-test-data-cleanup", route: "render-api", endpoint: renderAdminTestDataCleanupUrl, operation: "soft-delete"/, "Render cleanup must record a render-api Data I/O operation.");
assert.match(app, /recordSupabaseLoadEvent\("render-normalized-test-data-cleanup"/, "Render cleanup must leave a monitor breadcrumb.");
assert.match(app, /Generated normalized cleanup through Render/, "Render cleanup must update normalized table status clearly.");

const cleanupFunction = app.slice(app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason"), app.indexOf("function normalizeTestLabReports"));
assert.ok(cleanupFunction.indexOf("cleanupGeneratedRowsFromNormalizedTablesViaRender(reason)") < cleanupFunction.indexOf("getNormalizedWriteContext({ source })"), "Render cleanup must run before browser direct-table fallback.");

assert.match(server, /if self\.path == "\/api\/admin\/test-data\/cleanup"/, "server.py must expose the Render admin cleanup route.");
assert.match(server, /def cleanup_admin_test_data_backend\(self\):/, "server.py must implement the cleanup backend handler.");
assert.match(server, /def cleanup_generated_test_data_as_user\(/, "server.py must perform cleanup server-side.");
assert.match(server, /Only workspace admins can clean generated test data/, "Server cleanup must require admin permission.");
assert.match(server, /soft_delete_generated_rows_as_user\("trips"/, "Server cleanup must soft-delete generated trips.");
assert.match(server, /soft_delete_generated_rows_as_user\("fuel_payments"/, "Server cleanup must soft-delete generated fuel rows.");
assert.match(server, /soft_delete_generated_rows_as_user\("car_bookings"/, "Server cleanup must soft-delete generated bookings.");

assert.match(packageJson, /test-render-normalized-test-data-cleanup-route\.mjs/, "Validate script must run the v295 guard test.");

console.log("Render normalized Test Lab cleanup route guard check passed.");

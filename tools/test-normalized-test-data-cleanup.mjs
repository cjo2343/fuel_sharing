import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:19[3-9]|200)"/, "Build info must be bumped for v293.");
assert.match(buildInfo, /buildLabel:\s*"(?:normalized-test-data-cleanup|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes)"/, "Build label must describe normalized Test Lab cleanup or a later build preserving it.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[3-9]|300)"/, "Expected service-worker cache must be v293.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[3-9]|300)"/, "Service-worker cache must be v293.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:normalized-test-data-cleanup|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes)"/, "Service-worker build label must be v293 or a later preserving label.");

assert.match(app, /async function cleanupGeneratedRowsFromNormalizedTables\(/, "Cleanup must include a normalized-table cleanup helper.");
assert.match(app, /source = "normalized-test-data-cleanup"/, "Normalized cleanup must have its own Data I\/O source.");
assert.match(app, /from\("trips"\)[\s\S]*select\("id,legacy_id,period_id,note,deleted_at"\)/, "Cleanup must inspect generated trip rows.");
assert.match(app, /from\("fuel_payments"\)[\s\S]*select\("id,legacy_id,period_id,station_name,deleted_at"\)/, "Cleanup must inspect generated fuel rows.");
assert.match(app, /from\("car_bookings"\)[\s\S]*select\("id,legacy_id,purpose,deleted_at"\)/, "Cleanup must inspect generated booking rows.");
assert.match(app, /softDeleteGeneratedNormalizedRows\("trips", trips, source\)/, "Generated trips must be soft-deleted from normalized tables.");
assert.match(app, /softDeleteGeneratedNormalizedRows\("fuel_payments", fuel, source\)/, "Generated fuel rows must be soft-deleted from normalized tables.");
assert.match(app, /softDeleteGeneratedNormalizedRows\("car_bookings", bookings, source\)/, "Generated booking rows must be soft-deleted from normalized tables.");
assert.match(app, /recordSupabaseLoadEvent\("normalized-test-data-cleanup"/, "Cleanup must leave a visible monitor event.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("cleanup-test-lab-data"\)/, "Clean Test Lab data must clean normalized tables before mirroring.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("remove-generated-test-data"\)/, "Remove generated test data must also clean normalized tables.");
assert.match(packageJson, /test-normalized-test-data-cleanup\.mjs/, "Validate script must run the v293 guard test.");

console.log("Normalized Test Lab cleanup guard check passed.");

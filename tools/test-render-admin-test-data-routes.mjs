import fs from 'fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(/version:\s*"2026\.06\.18\.(?:19[4-9]|2[0-9][0-9])"/.test(buildInfo), 'build-info.js must be v294 or later while preserving the admin test-data routes.');
assert(/buildLabel:\s*"(?:update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/.test(buildInfo), 'build-info.js must use the v294 build label or a later label preserving it.');
assert(/expectedServiceWorkerCache:\s*"fuel-ledger-v(?:29[4-9]|[34][0-9][0-9])"/.test(buildInfo), 'build-info.js must expect the v294/v295/v296/v297 service-worker cache.');
assert(/CACHE_NAME\s*=\s*"fuel-ledger-v(?:29[4-9]|[34][0-9][0-9])"/.test(serviceWorker), 'service-worker.js must use the v294/v295/v296/v297 cache.');
assert(/BUILD_LABEL\s*=\s*"(?:update-prompt-workspace-visibility-lane|general-action-route-timing-lane|action-session-cache-shell-lane|interactive-action-recovery-lane|write-context-fast-fail-lane|no-refresh-action-chain-lane|no-refresh-action-chain-lane|post-action-unblock-lane|multi-workspace-authority-lane|admin-panel-declutter-lane|workspace-switch-target-context-lane|startup-wake-gate-lane|render-workspace-tools-lane|render-owned-state-load-lane|workspace-state-scope-lane|app-session-hydrate-lane|render-admin-test-data-routes|render-normalized-test-data-cleanup-route|render-cleanup-availability-hotfix|cleanup-scope-admin-finish-hotfix|admin-startup-flicker-reduction|startup-auth-hydration-screen|render-retention-admin-routes|admin-cleanup-diagnostics-finish|render-admin-health-endpoint|server-route-rate-limits|save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/.test(serviceWorker), 'service-worker.js must use the v294 build label or a later label preserving it.');

assert(app.includes('const renderAdminTestDataCreateUrl = "/api/admin/test-data/create";'), 'app.js must define the Render admin test-data create URL.');
assert(app.includes('async function createGeneratedTestDataViaRender(type, entry)'), 'app.js must include a Render admin test-data helper.');
assert(app.includes('createGeneratedTestDataViaRender("trip", tripPayload)'), 'Generated test trips must use the Render admin route first.');
assert(app.includes('createGeneratedTestDataViaRender("fuel", fuelPayload)'), 'Generated test fuel must use the Render admin route first.');
assert(app.includes('No browser write-context setup is needed'), 'Generated test data success messages should describe the Render admin path.');
assert(app.includes('admin generated test data already saved through Render routes and JSON mirror backup'), 'Render-backed generated test data should skip the old browser full-state save path.');

const tripFunction = app.slice(app.indexOf('async function addGeneratedTestTrip()'), app.indexOf('async function addGeneratedTestFuel()'));
const fuelFunction = app.slice(app.indexOf('async function addGeneratedTestFuel()'), app.indexOf('async function removeGeneratedTestData()'));
assert(tripFunction.includes('createGeneratedTestDataViaRender("trip", tripPayload)'), 'Generated test trip must use the Render admin route.');
assert(fuelFunction.includes('createGeneratedTestDataViaRender("fuel", fuelPayload)'), 'Generated test fuel must use the Render admin route.');
assert(!tripFunction.includes('saveTripToNormalizedTablesFirst(tripPayload)'), 'Generated test trip browser normalized-write fallback should be disabled.');
assert(!fuelFunction.includes('saveFuelToNormalizedTablesFirst(fuelPayload)'), 'Generated test fuel browser normalized-write fallback should be disabled.');

assert(server.includes('if self.path == "/api/admin/test-data/create"'), 'server.py must expose the Render admin test-data create route.');
assert(server.includes('def build_admin_test_data_rpc_payload'), 'server.py must build admin test-data RPC payloads server-side.');
assert(server.includes('def create_admin_test_data_backend'), 'server.py must implement the admin test-data backend handler.');
assert(server.includes('context.get("canAdmin")'), 'Render admin test-data route must require admin permission.');
assert(server.includes('upsert_trip_with_participants') && server.includes('upsert_fuel_payment'), 'Render admin test-data route must create trip and fuel rows with existing Supabase RPCs.');

assert(pkg.includes('tools/test-render-admin-test-data-routes.mjs'), 'package.json validate must include the v294 guard test.');

console.log('Render admin test-data route guard check passed.');

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

assert(buildInfo.includes('version: "2026.06.18.194"'), 'build-info.js must be bumped to v294.');
assert(buildInfo.includes('buildLabel: "render-admin-test-data-routes"'), 'build-info.js must use the v294 build label.');
assert(buildInfo.includes('expectedServiceWorkerCache: "fuel-ledger-v294"'), 'build-info.js must expect the v294 service-worker cache.');
assert(serviceWorker.includes('CACHE_NAME = "fuel-ledger-v294"'), 'service-worker.js must use the v294 cache.');
assert(serviceWorker.includes('BUILD_LABEL = "render-admin-test-data-routes"'), 'service-worker.js must use the v294 build label.');

assert(app.includes('const renderAdminTestDataCreateUrl = "/api/admin/test-data/create";'), 'app.js must define the Render admin test-data create URL.');
assert(app.includes('async function createGeneratedTestDataViaRender(type, entry)'), 'app.js must include a Render admin test-data helper.');
assert(app.includes('createGeneratedTestDataViaRender("trip", tripPayload)'), 'Generated test trips must use the Render admin route first.');
assert(app.includes('createGeneratedTestDataViaRender("fuel", fuelPayload)'), 'Generated test fuel must use the Render admin route first.');
assert(app.includes('No browser write-context setup is needed'), 'Generated test data success messages should describe the Render admin path.');
assert(app.includes('admin generated test data already saved through Render routes and JSON mirror backup'), 'Render-backed generated test data should skip the old browser full-state save path.');

const tripFunction = app.slice(app.indexOf('async function addGeneratedTestTrip()'), app.indexOf('async function addGeneratedTestFuel()'));
const fuelFunction = app.slice(app.indexOf('async function addGeneratedTestFuel()'), app.indexOf('async function removeGeneratedTestData()'));
assert(tripFunction.indexOf('createGeneratedTestDataViaRender("trip", tripPayload)') < tripFunction.indexOf('saveTripToNormalizedTablesFirst(tripPayload)'), 'Generated test trip must try Render before browser normalized write fallback.');
assert(fuelFunction.indexOf('createGeneratedTestDataViaRender("fuel", fuelPayload)') < fuelFunction.indexOf('saveFuelToNormalizedTablesFirst(fuelPayload)'), 'Generated test fuel must try Render before browser normalized write fallback.');

assert(server.includes('if self.path == "/api/admin/test-data/create"'), 'server.py must expose the Render admin test-data create route.');
assert(server.includes('def build_admin_test_data_rpc_payload'), 'server.py must build admin test-data RPC payloads server-side.');
assert(server.includes('def create_admin_test_data_backend'), 'server.py must implement the admin test-data backend handler.');
assert(server.includes('context.get("canAdmin")'), 'Render admin test-data route must require admin permission.');
assert(server.includes('upsert_trip_with_participants') && server.includes('upsert_fuel_payment'), 'Render admin test-data route must create trip and fuel rows with existing Supabase RPCs.');

assert(pkg.includes('tools/test-render-admin-test-data-routes.mjs'), 'package.json validate must include the v294 guard test.');

console.log('Render admin test-data route guard check passed.');

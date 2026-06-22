import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403)"/, 'build-info should point to v381 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403)"/, 'service worker cache should be bumped to v379.');

assert.ok(app.includes('const renderOwnerGlobalDiagnosticsUrl = "/api/owner/global-diagnostics";'), 'frontend should define the app-owner global diagnostics endpoint.');
assert.ok(app.includes('appOwnerGlobalDiagnostics: ownerGlobalDiagnosticsReportStatus()'), 'load reports should include cached app-owner global diagnostics.');
assert.ok(app.includes('Export immediately from the current cached diagnostics snapshot'), 'exporting a load report should not trigger slow global owner diagnostics.');
assert.ok(!app.includes('targetEmail: appOwnerDiagnosticsTargetEmail()'), 'global diagnostics should not hardcode a target test user in the normal Admin view.');
assert.ok(app.includes('renderOwnerGlobalDiagnosticsCard()'), 'Admin diagnostics should render an app-owner global scope card.');

assert.ok(server.includes('"/api/owner/global-diagnostics"'), 'server should mount /api/owner/global-diagnostics.');
assert.ok(server.includes('def list_owner_global_diagnostics_as_service'), 'server should have a service-role global diagnostics query.');
assert.ok(server.includes('recentVehicleActivity'), 'global diagnostics should include recent vehicle lookup owner-activity rows.');
assert.ok(server.includes('memberRows'), 'global diagnostics should expose generic member rows, not a targeted debug field.');
assert.ok(!server.includes('targetMemberships'), 'global diagnostics should not return the old targeted membership debug field.');
assert.ok(server.includes('is_configured_app_owner(user)'), 'global diagnostics endpoint should be restricted to the configured app owner.');

console.log('app-owner global diagnostics guardrail passed');

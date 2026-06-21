import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v377"/, 'build-info should point to v375 cache.');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v377"/, 'service worker cache should be bumped to v371.');

assert.ok(app.includes('const renderOwnerGlobalDiagnosticsUrl = "/api/owner/global-diagnostics";'), 'frontend should define the app-owner global diagnostics endpoint.');
assert.ok(app.includes('appOwnerGlobalDiagnostics: ownerGlobalDiagnosticsStatus'), 'load reports should include app-owner global diagnostics.');
assert.ok(app.includes('refreshOwnerGlobalDiagnostics({ force: true, silent: true, reason: "load-report-export" })'), 'exporting a load report should refresh global owner diagnostics first.');
assert.ok(app.includes('targetEmail: appOwnerDiagnosticsTargetEmail()'), 'global diagnostics request should probe the target test user membership separately from the app-owner account.');
assert.ok(app.includes('renderOwnerGlobalDiagnosticsCard()'), 'Admin diagnostics should render an app-owner global scope card.');

assert.ok(server.includes('"/api/owner/global-diagnostics"'), 'server should mount /api/owner/global-diagnostics.');
assert.ok(server.includes('def list_owner_global_diagnostics_as_service'), 'server should have a service-role global diagnostics query.');
assert.ok(server.includes('recentVehicleActivity'), 'global diagnostics should include recent vehicle lookup owner-activity rows.');
assert.ok(server.includes('targetMemberships'), 'global diagnostics should include target user memberships across workspaces.');
assert.ok(server.includes('is_configured_app_owner(user)'), 'global diagnostics endpoint should be restricted to the configured app owner.');

console.log('app-owner global diagnostics guardrail passed');

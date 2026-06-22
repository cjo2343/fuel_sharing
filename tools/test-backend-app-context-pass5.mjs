import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const build = fs.readFileSync('build-info.js', 'utf8');
const sw = fs.readFileSync('service-worker.js', 'utf8');

assert.match(app, /let adminDiagnosticsLaneStatus = \{/, 'admin diagnostics lane status should be tracked separately');
assert.match(app, /function startAdminDiagnosticsLane\(/, 'admin tab should use a separated diagnostics lane');
assert.match(app, /owner\/global diagnostics remain explicit actions/i, 'admin lane should document explicit owner/global diagnostics');
assert.match(app, /function isAdminAutoRefreshActive\(\) \{[\s\S]*return false;/, 'optional Admin auto-refresh must not run as part of normal sync');
assert.match(app, /renderBackendAppContextCard\(\)/, 'Admin panel should render backend app context summary');
assert.match(app, /Backend context workspace\/permission summary/, 'Admin should show backend workspace and permission summary');
assert.match(app, /adminDiagnosticsLane: adminDiagnosticsLaneStatus/, 'load reports should include separated admin diagnostics lane state');
assert.match(app, /No owner\/global snapshot has been loaded in this session[\s\S]*Backend app context card above/, 'empty owner/global snapshots should point to backend context instead of showing scary zero cards');
assert.match(build, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421)/, 'build-info expected cache should be v392');
assert.match(sw, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421)/, 'service worker cache should be v392');

console.log('backend app context pass 5 guardrails passed');

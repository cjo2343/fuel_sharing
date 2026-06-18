import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(app, /function makeAdminToolDiagnosticMeta\(source, detail = "", operation = "run"\)/, 'admin tool diagnostic metadata helper is missing');
assert.match(app, /async function traceAdminToolOperation\(source, detail, action, \{ operation = "run" \} = \{\}\)/, 'admin tool trace wrapper is missing');
assert.match(app, /route: "admin-tool"/, 'admin tool operations must use the admin-tool route so they group in Data I/O');

const requiredTools = [
  'add-test-trip',
  'add-test-fuel',
  'remove-test-data',
  'advanced-stress-test',
  'rapid-save-test',
  'full-test-lab',
  'scenario-matrix',
  'security-health',
  'save-test-lab-report-cloud',
  'cleanup-test-lab-data',
  'save-json-backup',
  'clean-stale-requests',
  'production-activity-reset',
  'add-member',
  'refresh-members',
  'refresh-workspace-invites',
  'create-workspace',
  'create-invite',
  'revoke-invite',
  'save-member',
  'deactivate-member',
  'reactivate-member',
  'refresh-database-diagnostics'
];

for (const name of requiredTools) {
  assert.ok(app.includes(`traceAdminToolOperation("${name}"`), `missing Data I/O wrapper for admin tool: ${name}`);
}

assert.match(buildInfo, /Admin tools that trigger cloud work now wrap their action in a Data I\/O operation row/, 'build-info release notes must keep the admin tool Data I/O status pass');
assert.match(serviceWorker, /fuel-ledger-v(?:29[1-9]|30[0-5])/, 'service worker cache must be at least v291 for admin tool Data I/O runtime changes');
assert.match(pkg, /test-admin-tool-dataio-status\.mjs/, 'validate script must include the admin tool Data I/O status guard');

console.log('Admin tool Data I/O status guard check passed.');

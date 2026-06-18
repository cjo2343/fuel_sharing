import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(app, /async function persistGeneratedAdminStateWithRenderMirror\(reason, message, \{ checkTables = true \} = \{\}\)/, 'shared Render mirror persistence helper is missing');
assert.match(app, /async function cleanupGeneratedTestDataWithReport\(\) \{[\s\S]*persistGeneratedAdminStateWithRenderMirror\("cleanup-test-lab-data"/, 'cleanup Test Lab data must use the Render mirror helper so the admin-tool row can finish');
assert.doesNotMatch(app, /async function cleanupGeneratedTestDataWithReport\(\) \{[\s\S]*?await flushStressSave\(`/, 'cleanup Test Lab data must not use the old flushStressSave path that can leave admin-tool rows active');
assert.match(app, /async function flushStressSave\(label\) \{[\s\S]*persistGeneratedAdminStateWithRenderMirror\("advanced-stress", label\);[\s\S]*?\}/, 'advanced stress should use the Render mirror helper instead of saveSupabaseState');
assert.doesNotMatch(app, /async function flushStressSave\(label\) \{[\s\S]*?await saveSupabaseState\(\{ reason: "advanced-stress" \}\)/, 'advanced stress must not call the old full-state save directly');
assert.match(app, /finishForegroundOperationsBySource\("advanced-stress", "Render backup path completed"\)/, 'Render-backed stress path must clear any advanced-stress foreground operation');
assert.match(app, /browser-full-state-save-skip/, 'Render-backed admin generated-data paths should record browser full-state save skip breadcrumbs');
assert.match(buildInfo, /finish-admin-cleanup-and-stress-status|normalized-test-data-cleanup|render-admin-test-data-routes/, 'build label should preserve or build on the admin cleanup/stress finish patch');
assert.match(serviceWorker, /fuel-ledger-v29[234]/, 'service worker cache must stay bumped for runtime app.js changes');
assert.match(pkg, /test-finish-admin-cleanup-and-stress-status\.mjs/, 'validate script must include the cleanup/stress status guard');

console.log('Admin cleanup/stress finish status guard check passed.');

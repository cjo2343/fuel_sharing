import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const app = readFileSync('app.js', 'utf8');
const buildInfo = readFileSync('build-info.js', 'utf8');
const headers = readFileSync('_headers', 'utf8');
const serviceWorker = readFileSync('service-worker.js', 'utf8');

assert.match(app, /navigator\.serviceWorker\.register\("\/service-worker\.js", \{ updateViaCache: "none" \}\)/, 'app.js should bypass browser HTTP cache when checking the service worker script');
assert.match(buildInfo, /navigator\.serviceWorker\.register\("\/service-worker\.js", \{ updateViaCache: "none" \}\)/, 'build-info should bypass browser HTTP cache when checking the service worker script');
assert.match(buildInfo, /fuel-ledger-build-update-available/, 'build-info should notify app.js when a newer deploy is detected');
assert.match(app, /window\.addEventListener\("fuel-ledger-build-update-available"/, 'app.js should listen for build-info update notifications');
assert.match(app, /window\.FuelLedgerApp\.checkForAppUpdate = checkForReadyAppUpdate/, 'app.js should expose a manual update check bridge');
const initializePwaBody = app.match(/async function initializePwa\(\) \{([\s\S]*?)\n\}\n\nasync function refreshPushState/)?.[1] || '';
assert.ok(initializePwaBody, 'test should locate initializePwa body');
assert.doesNotMatch(initializePwaBody, /\bforce\b/, 'startup PWA initialization must not reference the manual force option before it exists');
assert.match(app, /async function checkForReadyAppUpdate[\s\S]{0,220}const force = Boolean\(options\?\.force\)/, 'manual update checks should keep the force option scoped to the explicit update-check helper');
assert.match(buildInfo, /data-build-info-update-now>Update now/, 'About/Admin version panel should expose a user-triggered update fallback button');
assert.match(headers, /\/service-worker\.js[\s\S]*Cache-Control: no-cache, no-store, must-revalidate/, 'service-worker.js should be served with no-cache headers');
assert.match(headers, /\/build-info\.js[\s\S]*Cache-Control: no-cache, no-store, must-revalidate/, 'build-info.js should be served with no-cache headers');
assert.match(buildInfo, /fuel-ledger-v416/, 'build-info should publish v414');
assert.match(serviceWorker, /fuel-ledger-v416/, 'service worker should publish v414');

console.log('Update prompt discovery bridge guardrail passed.');

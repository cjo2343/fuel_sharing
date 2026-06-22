import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const checklist = fs.readFileSync('DEPLOYMENT-CHECKLIST.md', 'utf8');

assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409)"/, 'build-info should expect v386 cache');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409)"/, 'service worker should publish v386 cache');
assert.match(checklist, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409)/, 'deployment checklist should document v386 cache');
assert.match(buildInfo, /function scheduleBuildInfoRefresh/, 'build-info should wrap background refresh calls');
assert.match(buildInfo, /requestServiceWorkerInfo\(\)\.catch\(\(\) => null\)/, 'service-worker status polling should be best-effort');
assert.match(buildInfo, /channel\.port1\.onmessageerror = \(\) => settle\(null\)/, 'message-channel errors should resolve quietly');
assert.match(buildInfo, /channel\.port1\.close\(\)/, 'message-channel ports should close after status polling');
assert.match(serviceWorker, /url\.pathname === "\/favicon\.ico"/, 'service worker should handle favicon.ico');
assert.match(serviceWorker, /\/favicon\.ico/, 'favicon should be in the app-shell cache');
assert.match(index, /rel="icon" href="\/favicon\.ico"/, 'index should declare favicon.ico');
assert.match(app, /const ownerGlobalDiagnosticsAutoRefreshEnabled = false/, 'optional global diagnostics should not auto-run while idle');
assert.doesNotMatch(app, /ownerActivityStatus\.message = "Manual refresh"/, 'owner activity should not display confusing Manual refresh text');
assert.match(app, /Optional owner activity is paused until you refresh this card/, 'owner activity should explain that only optional audit is paused');

console.log('Idle background cleanup guardrail passed.');

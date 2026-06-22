import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const checklist = fs.readFileSync('DEPLOYMENT-CHECKLIST.md', 'utf8');

assert.doesNotMatch(index, /id="refresh(?:About)?BuildInfo"/, 'version panels should not expose legacy manual build-info refresh buttons');
assert.doesNotMatch(app, /refreshBuildInfo: document\.querySelector\("#refreshBuildInfo"\)/, 'app should not wire a manual version refresh button');
assert.match(buildInfo, /function startAutoBuildInfoRefresh\(\)/, 'build-info should poll version/service-worker state automatically');
assert.match(buildInfo, /function startAutoBuildInfoRefresh\(\)/, 'version poll should still detect updates automatically');
assert.match(app, /markAppUpdateReady\(newWorker, registration, "installed"\)/, 'app should mark waiting service workers as update-ready instead of activating automatically');
assert.match(app, /activateReadyAppUpdate\("toast-button"\)/, 'app should activate updates only from the update toast button');
assert.match(app, /window\.FuelLedgerApp\.hasPendingLocalChanges/, 'app should expose pending-change status for safe automatic reloads');
assert.match(app, /window\.FuelLedgerApp\.hasForegroundWriteInFlight/, 'app should expose foreground-write status for safe automatic reloads');
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415)"/, 'build-info should expect v381 cache');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415)"/, 'service worker should publish v381 cache');
assert.match(checklist, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415)/, 'deployment checklist should document v382 cache');
assert.match(buildInfo, /New version available|manual update prompt|Update prompt/, 'release notes should describe manual update prompt lifecycle');

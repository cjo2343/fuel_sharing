import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const checklist = fs.readFileSync('DEPLOYMENT-CHECKLIST.md', 'utf8');

assert.doesNotMatch(index, /id="refresh(?:About)?BuildInfo"/, 'version panels should not expose manual update/refresh buttons');
assert.doesNotMatch(app, /refreshBuildInfo: document\.querySelector\("#refreshBuildInfo"\)/, 'app should not wire a manual version refresh button');
assert.match(buildInfo, /function startAutoBuildInfoRefresh\(\)/, 'build-info should poll version/service-worker state automatically');
assert.match(buildInfo, /setInterval\(\(\) => \{[\s\S]*scheduleBuildInfoRefresh\(\{ activateUpdates: true \}\)/, 'automatic version poll should refresh and activate updates');
assert.match(buildInfo, /activateWaitingServiceWorker\(registration\)/, 'build-info should activate waiting service workers automatically');
assert.match(buildInfo, /reloadWhenSafe\(\)/, 'build-info should safely reload after automatic update activation');
assert.match(app, /window\.FuelLedgerApp\.hasPendingLocalChanges/, 'app should expose pending-change status for safe automatic reloads');
assert.match(app, /window\.FuelLedgerApp\.hasForegroundWriteInFlight/, 'app should expose foreground-write status for safe automatic reloads');
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v388"/, 'build-info should expect v381 cache');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v388"/, 'service worker should publish v381 cache');
assert.match(checklist, /fuel-ledger-v388/, 'deployment checklist should document v382 cache');
assert.match(buildInfo, /without user update buttons/, 'release notes should describe automatic update lifecycle');

import assert from 'node:assert/strict';
import fs from 'node:fs';

const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const checklist = fs.readFileSync('DEPLOYMENT-CHECKLIST.md', 'utf8');

assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v389"/, 'build-info should expect v382 cache');
assert.match(serviceWorker, /CACHE_NAME = "fuel-ledger-v389"/, 'service worker should publish v382 cache');
assert.match(checklist, /fuel-ledger-v389/, 'deployment checklist should document v382 cache');
assert.match(buildInfo, /function getServiceWorkerRegistration\(\)/, 'build-info should inspect existing service-worker registrations');
assert.match(buildInfo, /registration\?\.active/, 'build-info should read active worker status even before page control attaches');
assert.match(buildInfo, /active-uncontrolled/, 'build-info should label active but uncontrolled workers for self-heal status');
assert.match(buildInfo, /ensureAutomaticServiceWorkerControl/, 'build-info should run automatic service-worker control recovery');
assert.match(buildInfo, /sessionStorage\?\.setItem\(reloadKey, "1"\)/, 'service-worker control recovery should guard against reload loops');
assert.match(buildInfo, /document\.addEventListener\("visibilitychange"/, 'build-info should retry service-worker status on visible resume');
assert.match(buildInfo, /window\.addEventListener\("pageshow"/, 'build-info should retry service-worker status on page show/bfcache restore');
assert.match(buildInfo, /window\.addEventListener\("popstate"/, 'build-info should retry service-worker status after workspace URL changes');
assert.doesNotMatch(buildInfo, /!navigator\.serviceWorker\.controller \|\| typeof MessageChannel/, 'service-worker info should not require an existing controller before querying active registration');

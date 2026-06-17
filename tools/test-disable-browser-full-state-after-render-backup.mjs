import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

assert(app.includes('function saveState(options = {})'), 'saveState should accept options so Render-backed cleanup can avoid the generic browser full-state queue.');
assert(app.includes('queueRemote = true'), 'saveState should keep queued remote save as the default for normal paths.');
assert(app.includes('browser-full-state-save-skip'), 'App should record when it deliberately skips the old browser full-state save.');
assert(app.includes('saveState({ reason: "remove generated test data", queueRemote: false })'), 'Generated-test cleanup should save locally without queuing the old browser full-state save.');
assert(app.includes('remove generated test data cleanup JSON mirror backup'), 'Generated-test cleanup should write the cleaned state through the Render JSON mirror route.');
assert(app.includes('lastRenderJsonMirrorBackupAt = Date.now()'), 'Successful Render JSON mirror backups should remember their completion time.');
assert(app.includes('suppressNextQueuedRemoteSaveReason'), 'There should be a one-shot guard for stale queued saveRemoteState calls after Render backup.');
assert(!/markNormalizedReconciliationDirty\("remove generated test data"\);\s*saveState\(\);/.test(app), 'Generated-test cleanup must not use the old dirty+generic saveState path.');
assert(buildInfo.includes('version: "2026.06.17.190"'), 'build-info.js should be bumped to 2026.06.17.190.');
assert(buildInfo.includes('buildLabel: "disable-browser-full-state-after-render-backup"'), 'build-info.js should use the v290 build label.');
assert(buildInfo.includes('expectedServiceWorkerCache: "fuel-ledger-v290"'), 'build-info.js should expect cache v290.');
assert(serviceWorker.includes('fuel-ledger-v290'), 'service-worker.js should use cache v290.');
assert(serviceWorker.includes('disable-browser-full-state-after-render-backup'), 'service-worker.js should use the v290 build label.');

console.log('Disable browser full-state after Render backup guard check passed.');

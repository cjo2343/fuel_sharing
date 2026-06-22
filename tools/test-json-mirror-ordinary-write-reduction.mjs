import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');

assert.match(app, /function classifyJsonMirrorBackupReason\(reason = "", force = false\)/, 'JSON mirror writes should be classified by purpose.');
assert.match(app, /json-mirror-blocked-ordinary-save/, 'Ordinary app saves should be blocked from writing the full JSON mirror.');
assert.match(app, /purpose=\$\{mirrorPurpose\}/, 'JSON mirror diagnostics should record why the mirror write was allowed.');
assert.match(app, /manual JSON mirror backup/, 'Manual JSON mirror backups should have an explicit allowed reason.');
assert.match(app, /production activity reset JSON mirror backup/, 'Production reset mirror writes should use an explicit safety reason.');
assert.match(app, /admin reconciliation safety backup/, 'Admin reconciliation mirror writes should use an explicit safety reason.');
assert.doesNotMatch(app, /saveJsonMirrorBackup\(\{ force: true \}\)/, 'Forced JSON mirror writes must not be reasonless.');
assert.match(pkg, /test-json-mirror-ordinary-write-reduction\.mjs/, 'Validation should run the ordinary JSON mirror reduction guard.');
assert.match(buildInfo, /Ordinary app saves now fail closed away from full-state JSON mirror writes/, 'Release notes should mention ordinary JSON mirror write reduction.');

console.log('JSON mirror ordinary write reduction guard check passed.');

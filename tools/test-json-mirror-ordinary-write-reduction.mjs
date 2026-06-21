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
assert.match(buildInfo, /version: "2026\.06\.18\.(?:215|216|217|218|219|220|221|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257|258)"/, 'Runtime version should be bumped for app.js changes.');
assert.match(buildInfo, /expectedServiceWorkerCache: "fuel-ledger-v(?:315|316|317|318|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392|393)"/, 'Expected service worker cache should be bumped.');
assert.match(serviceWorker, /fuel-ledger-v(?:315|316|317|318|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386|387|388|389|390|391|392|393)/, 'Service worker cache should be bumped with build-info.');

console.log('JSON mirror ordinary write reduction guard check passed.');

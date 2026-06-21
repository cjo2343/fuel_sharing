import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const buildInfo = readFileSync('build-info.js', 'utf8');
const serviceWorker = readFileSync('service-worker.js', 'utf8');

assert.match(app, /async function requireRenderVerifiedAdvancedAdminAction/, 'advanced admin/Test Lab actions must use a shared Render-admin verification gate.');
assert.match(app, /checkRenderAdminHealth\(\{ silent: true \}\)/, 'the shared gate must verify workspace admin through the Render admin-health route before risky work starts.');
assert.match(app, /check\?\.id === "workspace-admin" && check\.ok === true/, 'the shared gate must require the Render workspace-admin check, not only local canManageSettings().');

for (const [button, phrase] of [
  ['els.addTestTrip', 'ADD TEST TRIP'],
  ['els.addTestFuel', 'ADD TEST FUEL'],
  ['els.removeTestData', 'REMOVE TEST DATA'],
  ['els.cleanupTestLabData', 'CLEAN TEST DATA'],
  ['els.removeTestUsers', 'REMOVE TEST USERS'],
  ['els.runStressTest', 'RUN STRESS TEST'],
  ['els.runRapidSaveTest', 'RUN RAPID SAVE TEST']
]) {
  const start = app.indexOf(`${button}?.addEventListener`);
  assert.notEqual(start, -1, `${button} listener must exist.`);
  const block = app.slice(start, app.indexOf('\n});', start) + 4);
  assert.match(block, /requireRenderVerifiedAdvancedAdminAction/, `${button} must use the Render-admin verification gate.`);
  assert.match(block, new RegExp(`phrase:\\s*"${phrase}"`), `${button} must require typed confirmation phrase ${phrase}.`);
}

const purgeStart = app.indexOf('els.purgeSoftDeletedTestRows?.addEventListener');
assert.notEqual(purgeStart, -1, 'soft-deleted generated row purge listener must exist.');
const purgeBlock = app.slice(purgeStart, app.indexOf('\n});', purgeStart) + 4);
assert.match(purgeBlock, /requireRenderVerifiedAdvancedAdminAction/, 'soft-deleted generated row purge must use Render-admin verification before preview/purge.');
assert.match(purgeBlock, /requireUnlock:\s*true/, 'soft-deleted generated row purge must require the advanced admin unlock.');
assert.match(purgeBlock, /typed !== "PURGE TEST ROWS"/, 'soft-deleted generated row purge must still require a final typed purge phrase after preview.');

const productionStart = app.indexOf('async function runProductionActivityReset');
assert.notEqual(productionStart, -1, 'production reset function must exist.');
const productionBlock = app.slice(productionStart, app.indexOf('\n}\n\n\n', productionStart));
assert.match(productionBlock, /requireRenderVerifiedAdvancedAdminAction/, 'production activity reset must require Render-admin verification.');
assert.match(productionBlock, /phrase:\s*"RESET PRODUCTION"/, 'production activity reset must use the RESET PRODUCTION typed phrase.');
assert.match(productionBlock, /exportAdminSafetyBackup\("production activity reset"\)/, 'production activity reset must still take a fresh safety backup.');

for (const [button, phrase] of [
  ['els.runSecurityScenario', 'RUN SECURITY HEALTH'],
  ['els.saveTestLabReportCloud', 'SAVE REPORT TO CLOUD']
]) {
  const start = app.indexOf(`${button}?.addEventListener`);
  assert.notEqual(start, -1, `${button} listener must exist.`);
  const block = app.slice(start, app.indexOf('\n});', start) + 4);
  assert.match(block, /requireRenderVerifiedAdvancedAdminAction/, `${button} must use Render-admin verification.`);
  assert.match(block, /requireUnlock:\s*false/, `${button} should not require the advanced unlock because it is a normal admin diagnostic/report action.`);
  assert.match(block, new RegExp(`phrase:\\s*"${phrase}"`), `${button} must keep typed confirmation phrase ${phrase}.`);
}

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257)"/, 'runtime version must be bumped for app.js changes.');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:31[456789]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368)"/, 'build-info must expect the bumped service-worker cache.');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:31[456789]|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368)"/, 'service-worker cache must be bumped with runtime changes.');

console.log('Admin/Test Lab protection guard check passed.');

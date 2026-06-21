import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`Render JSON mirror backup guard failed: ${message}`);
    process.exit(1);
  }
}

assert(app.includes('const renderJsonMirrorBackupUrl = "/api/backups/json-mirror";'), 'app should define Render JSON mirror backup URL');
assert(app.includes('async function saveJsonMirrorBackupViaRender'), 'app should include Render JSON mirror helper');
assert(app.includes('source: "json-mirror-backup", route: "render-api", endpoint: renderJsonMirrorBackupUrl'), 'helper should record Render Data I/O diagnostics');
assert(app.includes('recordSupabaseLoadEvent("render-json-mirror-backup"'), 'Render JSON mirror success should be visible in load monitor');
assert(app.includes('body: JSON.stringify({ ledgerId, state, reason, force, updatedAt: savedAt })'), 'Render JSON mirror request should include ledger, state, reason, force, and timestamp');
assert(app.includes('const renderResult = await saveJsonMirrorBackupViaRender({ force, reason, savedAt, stateScope });'), 'saveJsonMirrorBackup should try Render first');
assert(app.includes('if (renderResult.ok) {'), 'successful Render JSON mirror backup should be handled');
assert(app.includes('if (!renderResult.shouldFallback) {'), 'non-fallback Render JSON mirror failures should not silently use browser writes');
const saveFunction = app.slice(app.indexOf('async function saveJsonMirrorBackup({ force = false, reason = "" } = {})'));
assert(saveFunction.indexOf('const renderResult = await saveJsonMirrorBackupViaRender({ force, reason, savedAt, stateScope });') < saveFunction.indexOf('.from("car_share_ledgers")'), 'Render JSON mirror backup should run before direct car_share_ledgers fallback');
assert(app.includes('route: "direct-table",\n    table: "car_share_ledgers"'), 'direct JSON mirror fallback should remain diagnosed');

assert(server.includes('if self.path == "/api/backups/json-mirror":'), 'server should route /api/backups/json-mirror');
assert(server.includes('def save_json_mirror_backup_backend'), 'server should implement JSON mirror backup backend');
assert(server.includes('def build_json_mirror_backup_payload'), 'server should validate JSON mirror backup payload');
assert(server.includes('JSON mirror backup requires a state object'), 'server should require a state object');
assert(server.includes('assert_user_can_admin_ledger(ledger_id, user, token)'), 'server should verify workspace admin permission before JSON mirror writes');
assert(server.includes('def upsert_json_mirror_as_user'), 'server should upsert JSON mirror as signed-in user');
assert(server.includes('/rest/v1/car_share_ledgers?on_conflict=id&select=id,updated_at'), 'server should upsert car_share_ledgers through Supabase REST');
assert(server.includes('"backend": "render"'), 'server should return stable Render envelope');

assert(pkg.includes('node tools/test-render-json-mirror-backup.mjs'), 'validate should run JSON mirror Render guard');
assert(pkg.includes('node --check tools/test-render-json-mirror-backup.mjs'), 'validate should syntax-check JSON mirror Render guard');

console.log('Render JSON mirror backup guard check passed.');

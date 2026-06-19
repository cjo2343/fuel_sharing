import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`Render ledger directory sync guard failed: ${message}`);
    process.exit(1);
  }
}

assert(app.includes('const renderLedgerDirectorySyncUrl = "/api/ledgers/sync";'), 'app should define Render ledger-directory sync URL');
assert(app.includes('async function syncLedgerDirectoryViaRender'), 'app should include Render ledger-directory helper');
assert(app.includes('source, route: "render-api", endpoint: renderLedgerDirectorySyncUrl'), 'helper should record Render Data I/O diagnostics');
assert(app.includes('recordSupabaseLoadEvent("render-ledger-directory-sync"'), 'Render ledger-directory success should be visible in load monitor');
assert(app.includes('const renderResult = await syncLedgerDirectoryViaRender(ledgerPayload, memberPayloads);'), 'admin directory sync should try Render first');
assert(app.includes('if (renderResult.ok) return;'), 'successful Render directory sync should skip browser direct-table upsert');
assert(app.includes('Browser ledger-directory direct-table fallback is disabled'), 'Render failure should fail closed instead of browser direct-table fallback');
const syncStart = app.indexOf('async function syncLedgerDirectoryForAdmin');
const syncEnd = app.indexOf('async function saveTripToNormalizedTablesFirst', syncStart);
const syncBody = app.slice(syncStart, syncEnd);
assert(!syncBody.includes('await upsertLedgerSettings(ledgerPayload);'), 'ledger sync should not direct-upsert ledgers after Render failure');
assert(!/from\("ledger_members"\)\s*\.upsert/.test(syncBody), 'ledger sync should not direct-upsert members after Render failure');

assert(server.includes('if self.path == "/api/ledgers/sync":'), 'server should route /api/ledgers/sync');
assert(server.includes('def sync_ledger_directory_backend'), 'server should implement ledger directory sync backend');
assert(server.includes('def build_ledger_directory_sync_payload'), 'server should validate ledger directory payload');
assert(server.includes('def assert_user_can_admin_ledger'), 'server should verify workspace admin permission');
assert(server.includes('Only workspace admins can sync the ledger directory'), 'server should fail closed for non-admin directory sync');
assert(server.includes('def upsert_ledger_directory_as_user'), 'server should sync ledgers and ledger_members as the signed-in user');
assert(server.includes('/rest/v1/ledgers?on_conflict=id&select=id,slug'), 'server should upsert ledgers through Supabase REST');
assert(server.includes('/rest/v1/ledger_members?on_conflict=ledger_id,name&select=id,name,role'), 'server should upsert ledger_members through Supabase REST');
assert(server.includes('"backend": "render"'), 'server should return stable Render envelope');

assert(pkg.includes('node tools/test-render-ledger-directory-sync.mjs'), 'validate should run ledger-directory Render guard');
assert(pkg.includes('node --check tools/test-render-ledger-directory-sync.mjs'), 'validate should syntax-check ledger-directory Render guard');

console.log('Render ledger directory sync guard check passed.');

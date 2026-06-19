import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(app, /function dataIoResultCodeFor\(phase, ok, meta = \{\}\)/, 'Data I/O diagnostics should derive stable result/status codes centrally');
assert.match(app, /code: resultCode,/, 'Data I/O exported diagnostics should include a code field');
assert.match(app, /resultCode,/, 'Data I/O exported diagnostics should include resultCode');
assert.match(app, /statusCode: resultCode,/, 'Data I/O exported diagnostics should include statusCode for easy scanning');
assert.match(app, /errorCode: summarizedError\?\.code \|\| ""/, 'Data I/O diagnostics should preserve Supabase/API error codes separately');
assert.match(app, /source: "workspace-invite-create"/, 'Invite creation should have its own RPC-level Data I/O row, not only the generic admin-tool wrapper');
assert.match(app, /rpc: "create_ledger_invite"/, 'Invite creation Data I/O row should name the RPC');
assert.match(app, /resultCode: inviteCode \? "INVITE_CREATED" : "OK"/, 'Invite creation success should report an explicit INVITE_CREATED result code');
assert.match(app, /resultCode: timedOut \? "INVITE_CREATE_TIMEOUT" : "INVITE_CREATE_ERROR"/, 'Invite creation failures should report explicit timeout/error result codes');
assert.match(app, /const workspaceInviteRequestTimeoutMs = 15000;/, 'Invite creation should not race the old 8-second edge timeout');
assert.match(app, /code \${escapeHtml\(code\)}/, 'Admin Data I/O operation rows should render result codes visibly');
assert.match(buildInfo, /Data I\/O diagnostics now include stable result\/status codes/, 'release notes should mention Data I/O result/status codes');
assert.match(pkg, /test-data-io-result-codes\.mjs/, 'validate script must run Data I/O result-code guardrails');

console.log('Data I/O result code guardrails passed.');

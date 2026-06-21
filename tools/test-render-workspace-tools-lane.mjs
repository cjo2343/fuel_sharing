import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');

assert.match(app, /const renderWorkspaceToolsUrl = "\/api\/workspace\/tools"/, 'frontend should define a Render workspace tools route');
assert.match(app, /async function refreshWorkspaceToolsViaRender/, 'workspace tools refresh should use a Render helper');
assert.match(app, /callRenderJson\(renderWorkspaceToolsUrl/, 'workspace tools refresh should call Render, not Supabase directly');
assert.match(app, /workspaceInviteStatus\.rawLedgers = ledgers/, 'workspace panel should store the backend linked-workspaces rows before normalization');
assert.match(app, /updateWorkspaceMembershipProbeFromBackendContext\(context \|\| getBackendAppContext\(\), reason\)/, 'workspace panel membership probe should derive from backend context');
assert.doesNotMatch(app, /supabaseClient\.rpc\("list_my_ledgers"/, 'normal frontend workspace refresh must not call list_my_ledgers directly');
assert.doesNotMatch(app, /withWorkspaceInviteRequestTimeout\(\s*supabaseClient\s*\.from\("ledger_invites"\)/, 'normal invite list refresh must not query ledger_invites directly from the browser');
assert.match(server, /if self\.path == "\/api\/workspace\/tools"/, 'Render should expose workspace tools route');
assert.match(server, /def workspace_tools_backend\(self\):/, 'Render should implement workspace tools backend');
assert.match(server, /build_app_context_response\(payload, user\)/, 'workspace tools route should reuse backend app context');
assert.match(server, /list_workspace_invites_for_context_as_service/, 'workspace tools route should load optional invites server-side');

console.log('Render workspace tools lane guard passed.');

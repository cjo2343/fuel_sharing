import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const server = readFileSync('server.py', 'utf8');

assert.match(app, /const\s+renderMemberManagementUrl\s*=\s*renderApiEndpoints\.memberManagement\s*\|\|\s*"\/api\/members\/manage"/, 'frontend should define the backend-owned member-management route');
assert.match(app, /async function callMemberManagementRoute\(action, payload = \{\}\)/, 'frontend should call one Render member-management helper');
assert.match(app, /callMemberManagementRoute\("list"\)/, 'member refresh should load through Render');
assert.match(app, /async function upsertManagedMemberRpc\(payload\)[\s\S]*callMemberManagementRoute\("upsert"/, 'member add/edit should save through Render');
assert.match(app, /async function setManagedMemberActiveRpc\(memberId, isActive\)[\s\S]*callMemberManagementRoute\("set-active"/, 'member deactivate/reactivate should go through Render');
assert.doesNotMatch(app, /supabaseClient\.rpc\("upsert_ledger_member_admin"/, 'frontend must not call member-management RPC directly');
assert.doesNotMatch(app, /supabaseClient\.rpc\("set_ledger_member_active_admin"/, 'frontend must not call member activation RPC directly');
assert.doesNotMatch(app, /\.from\("ledger_members"\)\s*\.select\("id,ledger_id,name,email,role,is_active,mobilepay_phone,created_at,updated_at"\)/s, 'member management refresh should not directly select ledger_members in the browser');

assert.match(server, /if self\.path == "\/api\/members\/manage":\n\s+self\.manage_members_backend\(\)/, 'server should mount /api/members/manage');
assert.match(server, /def manage_members_backend\(self\):/, 'server should implement member management route');
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/, 'backend should verify workspace admin scope');
assert.match(server, /upsert_ledger_member_admin/, 'backend should call existing member upsert RPC server-side');
assert.match(server, /set_ledger_member_active_admin/, 'backend should call existing activation RPC server-side');
assert.match(server, /"memberManagement", "\/api\/members\/manage"/, 'Render admin health should include member management route');

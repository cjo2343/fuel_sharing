import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(app, /source: "workspace-create"/, 'workspace creation should use a stable member-action Data I/O source');
assert.match(app, /rpc: "create_private_ledger_workspace"/, 'workspace creation Data I/O should name the Supabase RPC');
assert.match(app, /resultCode: "WORKSPACE_CREATE_STARTED"/, 'workspace creation should record a started code');
assert.match(app, /resultCode: "WORKSPACE_CREATED"/, 'workspace creation should record a success code');
assert.match(app, /WORKSPACE_CREATE_TIMEOUT/, 'workspace creation should record a timeout code');
assert.match(app, /WORKSPACE_CREATE_ERROR/, 'workspace creation should record a generic error code');
assert.match(app, /activeMemberActionOperations\.has\(actionKey\)/, 'workspace creation should block duplicate in-flight create attempts');
assert.match(app, /async function reconcileWorkspaceCreateAfterTimeout/, 'workspace timeout should run a follow-up verification path');
assert.match(app, /WORKSPACE_CREATE_VERIFY_STARTED/, 'workspace timeout verification should record start code');
assert.match(app, /WORKSPACE_CREATE_CONFIRMED_AFTER_TIMEOUT/, 'workspace timeout verification should record recovered success code');
assert.match(app, /WORKSPACE_CREATE_NOT_CONFIRMED_AFTER_TIMEOUT/, 'workspace timeout verification should record not-confirmed code');
assert.match(app, /WORKSPACE_CREATE_VERIFY_ERROR/, 'workspace timeout verification should record verification errors');
assert.doesNotMatch(app, /traceMemberActionOperation\("workspace-create"/, 'workspace creation should not be wrapped by a generic success-only member tracer');
assert.match(buildInfo, /Workspace creation now records its own member-action Data I\/O/, 'release notes should mention workspace creation Data I/O hardening');
assert.match(pkg, /test-workspace-create-dataio-timeout\.mjs/, 'validate script should run workspace creation Data I/O timeout guardrail');

console.log('Workspace creation Data I/O timeout guardrails passed.');

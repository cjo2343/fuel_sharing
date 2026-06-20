import fs from 'fs';
import assert from 'assert';

const app = fs.readFileSync('app.js', 'utf8');
const validations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(app, /function makeWorkspaceScopedStorageKey\(/, 'local browser state must be scoped per workspace/ledger');
assert.match(app, /storageKey: makeWorkspaceScopedStorageKey\(\)/, 'load/save must use the active workspace scoped storage key');
assert.match(app, /function markActiveWorkspaceLoading\(/, 'workspace switches must mark the selected workspace as loading');
assert.match(app, /function isActiveWorkspaceDataConfirmed\(/, 'app must track whether selected workspace data was confirmed');
assert.match(app, /assertActiveWorkspaceDataConfirmed\("save settings"\)/, 'settings saves must be blocked until selected workspace data is confirmed');
assert.match(app, /assertActiveWorkspaceDataConfirmed\("lookup vehicle information"\)/, 'vehicle lookup must be blocked until selected workspace data is confirmed');
assert.match(app, /Workspace status/, 'Admin/About workspace summary should show workspace load confirmation status');
assert.match(app, /Workspace: \$\{escapeHtml\(entry\.workspaceLabel/, 'Data I/O rows must show the workspace they belong to');
assert.match(app, /markActiveWorkspaceConfirmed\(reason\)/, 'successful cloud loads must confirm the selected workspace');
assert.match(app, /markActiveWorkspaceLoadFailed\(reason\)/, 'failed cloud loads must leave the workspace unconfirmed');
assert.match(validations, /test-workspace-switch-safety\.mjs/, 'validation suite must run workspace switch safety guardrail');

console.log('Workspace switch safety guardrail passed.');

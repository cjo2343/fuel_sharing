import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(app, /async function traceMemberActionOperation\(/, 'member actions should have a shared Data I/O tracer');
assert.match(app, /const activeMemberActionOperations = new Set\(\)/, 'member actions should dedupe repeated clicks independently from admin tools');
assert.match(app, /function dataIoOperationGroup\(/, 'Admin diagnostics should group Data I/O operations');
assert.match(app, /Member actions/, 'Admin diagnostics should render a Member actions group');
assert.match(app, /Sync\/load\/write actions/, 'Admin diagnostics should keep sync\/write rows separate from member actions');
assert.match(app, /traceMemberActionOperation\("workspace-tools-refresh"/, 'workspace refresh should be tracked as a member action');
assert.match(app, /traceMemberActionOperation\("workspace-create"/, 'workspace create should be tracked as a member action');
assert.match(app, /traceMemberActionOperation\("workspace-invite-redeem"/, 'invite redeem should be tracked as a member action');
assert.match(app, /traceMemberActionOperation\("workspace-switch"/, 'workspace switching should be tracked as a member action');
assert.doesNotMatch(app, /if \(!button \|\| !canManageSettings\(\)\) return;\n  if \(button\.dataset\.workspaceAction === "switch"\)/, 'regular linked members should be able to switch workspace from Account list');
assert.match(app, /resultCode: "WORKSPACE_CREATE_STARTED"/, 'workspace create should expose started result code');
assert.match(app, /resultCode: timedOut \? "WORKSPACE_CREATE_TIMEOUT" : "WORKSPACE_CREATE_ERROR"/, 'workspace create should expose timeout/error result codes');
assert.match(app, /resultCode: "WORKSPACE_REFRESH_STARTED"/, 'workspace refresh should expose started result code');
assert.match(app, /resultCode: timedOut \? "WORKSPACE_REFRESH_TIMEOUT" : "WORKSPACE_REFRESH_ERROR"/, 'workspace refresh should expose timeout/error result codes');
assert.match(app, /resultCode: "INVITE_REDEEM_STARTED"/, 'invite redeem should expose started result code');
assert.match(app, /resultCode: "INVITE_REDEEMED"/, 'invite redeem should expose success result code');
assert.match(app, /resultCode: "WORKSPACE_SWITCHED"/, 'workspace switch should expose success result code');
assert.match(buildInfo, /Member-facing onboarding actions now have their own Admin Data I\/O flight-recorder group/, 'release notes should mention member Data I/O overview');
assert.match(pkg, /test-member-action-dataio-overview\.mjs/, 'validate script must run member action Data I/O guardrail');

console.log('Member action Data I/O overview guardrails passed.');

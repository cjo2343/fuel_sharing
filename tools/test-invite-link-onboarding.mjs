import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(app, /inviteDeepLinkParamNames = Object\.freeze\(\["invite", "invite_code", "workspaceInvite", "workspace_invite"\]\)/, 'invite links should accept stable invite query parameter spellings');
assert.match(app, /function readInviteCodeFromCurrentUrl\(\)/, 'app should read invite codes from the current URL');
assert.match(app, /function removeInviteCodeFromCurrentUrl\(\)/, 'app should strip invite codes from browser history after storing them');
assert.match(app, /localStorage\.setItem\(pendingWorkspaceInviteCodeKey, inviteCode\)/, 'URL invite codes should be stored for post-login redemption');
assert.match(app, /function buildWorkspaceInviteLink\(inviteCode\)/, 'admin invite creation should build a copyable invite link');
assert.match(app, /url\.searchParams\.set\("invite", code\)/, 'copyable invite links should use the canonical ?invite=CODE parameter');
assert.match(app, /data-copy="\$\{escapeHtml\(inviteLink\)\}"/, 'created invites should expose a copy invite link button');
assert.match(app, /data-copy="\$\{escapeHtml\(inviteCode\)\}"/, 'created invites should still expose a copy code button');
assert.match(app, /initializeInviteDeepLink\(\);\nrender\(\);/, 'startup should hydrate invite links before the first render');
assert.match(app, /currentSession = session;\n    initializeInviteDeepLink\(\);/, 'auth state changes should capture invite links opened by already signed-in users');
assert.match(html, /open an invite link/i, 'login copy should explain invite links');
assert.match(html, /copy the invite link or one-time code/i, 'admin invite copy should mention invite links');
assert.match(buildInfo, /Invite links now use a copyable \?invite=CODE URL/, 'release notes should mention invite link onboarding polish');

console.log('Invite link onboarding guardrails passed.');

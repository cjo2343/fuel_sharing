import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const schema = fs.readFileSync('supabase-schema.sql', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');

assert.match(html, /Invite link\/code = permission to join a workspace/, 'login UI should explain invite code vs email login code');
assert.match(html, /Email login code = proof you own the email/, 'login UI should explain email auth code');
assert.match(html, /memberProfileSetupPanel/, 'new members should have a profile setup panel');
assert.match(html, /Your member profile/, 'profile setup heading should be present');
assert.match(html, /Email restriction.*exact-login email/s, 'invite admin UI should explain exact-email restrictions');

assert.match(app, /function renderMemberProfileSetupPanel\(\)/, 'app should render member profile setup');
assert.match(app, /function saveOwnMemberProfileFromSetup\(\)/, 'app should save own member profile');
assert.match(app, /rpc\("update_own_ledger_member_profile"/, 'profile setup should use self-service RPC');
assert.match(app, /PROFILE_SAVE_STARTED/, 'profile save should produce Data I/O start code');
assert.match(app, /PROFILE_SAVED/, 'profile save should produce Data I/O success code');
assert.match(app, /PROFILE_SAVE_ERROR/, 'profile save should produce Data I/O error code');
assert.match(app, /Returning users only need email \+ email login code/, 'returning login requirements should be explicit');
assert.match(app, /If the invite was restricted to one email, it will only redeem for this exact email/, 'wrong-email invite behavior should be explicit');

assert.match(schema, /create or replace function public\.update_own_ledger_member_profile\(/, 'schema should include self-service profile RPC');
assert.match(schema, /Current user is not an active member of this workspace/, 'self-service RPC should enforce active workspace membership');
assert.match(schema, /Another active member in this workspace already uses that display name/, 'self-service RPC should protect display-name collisions');
assert.match(schema, /036_invite_profile_setup/, 'schema migration expectation should include 036');
assert.match(pkg, /test-invite-identity-onboarding\.mjs/, 'validate script should run invite identity onboarding guardrail');
assert.match(buildInfo, /Invite onboarding now explains invite codes versus email login codes/, 'release notes should mention invite identity onboarding');

console.log('Invite identity onboarding guardrails passed.');

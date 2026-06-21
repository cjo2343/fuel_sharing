import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');

assert.match(app, /let lastAppStartupGateReadyAt = 0;/, 'startup gate should remember when it became ready');
assert.match(app, /const postStartupGateAuthLoadSuppressMs = 10000;/, 'post-gate auth load suppression window should be explicit and bounded');
assert.match(app, /function shouldSuppressPostStartupGateAuthStateLoad\(authEvent = ""\)/, 'auth state-load suppression should be centralized');
assert.match(app, /AUTH_STATE_LOAD_SUPPRESSED_AFTER_STARTUP_GATE/, 'duplicate post-gate auth loads should leave a clear diagnostic');
assert.match(app, /lastAuthCloudSyncUserKey = gateUserKey;[\s\S]*lastAuthCloudSyncAt = lastAppStartupGateReadyAt;/, 'successful startup gate should seed auth sync cooldown for the current user');
assert.match(app, /if \(shouldSuppressPostStartupGateAuthStateLoad\(authEvent\)\) \{[\s\S]*finishStartupHydration\(`auth-skip-post-gate:\$\{authEvent\}`\);[\s\S]*return;\n\s*\}/, 'auth handler should return before the duplicate loadSupabaseState path after a fresh startup gate');
assert.match(app, /function completeAdminDiagnosticsLaneFromContext\(context, reason = "admin"\)/, 'Admin diagnostics should share a completion helper');
assert.match(app, /ADMIN_DIAGNOSTICS_CONTEXT_REUSED/, 'Admin tab should mark context reuse as a completed skip instead of a loading lane');
assert.match(app, /return completeAdminDiagnosticsLaneFromContext\(activeContext, reason\);/, 'fresh backend context should complete Admin diagnostics without setting loading=true');
assert.match(app, /return completeAdminDiagnosticsLaneFromContext\(context, reason\);/, 'joined or fetched Admin context should also clear loading through the shared helper');

const startAdmin = app.match(/async function startAdminDiagnosticsLane[\s\S]*?function stopAdminAutoRefresh/);
assert.ok(startAdmin, 'should find startAdminDiagnosticsLane body');
assert.ok(startAdmin[0].indexOf('return completeAdminDiagnosticsLaneFromContext(activeContext, reason);') < startAdmin[0].indexOf('loading: true'), 'fresh Admin context reuse should happen before setting loading=true');

console.log('Post-startup duplicate load and Admin diagnostics guard passed.');

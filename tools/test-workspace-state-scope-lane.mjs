import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const build = readFileSync('build-info.js', 'utf8');
const sw = readFileSync('service-worker.js', 'utf8');
const checklist = readFileSync('DEPLOYMENT-CHECKLIST.md', 'utf8');

assert.match(app, /function getActiveWorkspaceStateScope\(\{ context = getBackendAppContext\(\), reason = "state-scope" \} = \{\}\)/, 'app should expose one active workspace state scope helper');
assert.match(app, /async function resolveActiveWorkspaceStateScope\(\{ reason = "state-scope", operation = "load", forceHydrate = false \} = \{\}\)/, 'state load should resolve workspace scope through the app-session hydrate lane');
assert.match(app, /async function requireActiveWorkspaceWriteScope\(\{ reason = "save", forceHydrate = false \} = \{\}\)/, 'state writes should require a validated active workspace scope');
assert.match(app, /WORKSPACE_WRITE_SCOPE_MISMATCH/, 'stale selected-vs-loaded workspace writes should fail closed');
assert.match(app, /stateScope = await resolveActiveWorkspaceStateScope\(\{ reason, operation: "load" \}\)/, 'normal cloud state load should resolve one workspace scope before loading data');
assert.match(app, /const renderStateRows = await getRenderNormalizedStateRows\(ledgerId\);/, 'JSON mirror load should use the canonical scoped ledger id through Render state rows');
assert.match(app, /loadStateFromNormalizedTables\(jsonState, \{ reason, stateScope, renderStateRows \}\)/, 'normalized table loads should reuse the already resolved state scope and Render state rows');
assert.match(app, /const stateScope = await requireActiveWorkspaceWriteScope\(\{ reason \}\)/, 'saveSupabaseState should validate write scope before writing');
assert.match(app, /saveJsonMirrorBackupViaRender\(\{ force, reason, savedAt, stateScope \}\)/, 'JSON mirror backup should pass the canonical write scope to Render');
assert.match(build, /render-owned-state-load-lane/, 'build label should describe the state scope lane');
assert.match(build, /fuel-ledger-v395/, 'build-info expected cache should be v395');
assert.match(sw, /fuel-ledger-v395/, 'service worker cache should be v395');
assert.match(checklist, /Render-owned state load lane - v395/, 'deployment checklist should document the Render-owned state load pass');

console.log('workspace state scope lane guardrails passed');

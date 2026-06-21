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
assert.match(app, /\.from\("car_share_ledgers"\)[\s\S]*\.eq\("id", ledgerId\)/, 'JSON mirror load should use the canonical scoped ledger id');
assert.match(app, /loadStateFromNormalizedTables\(jsonState, \{ reason, stateScope \}\)/, 'normalized table loads should reuse the already resolved state scope');
assert.match(app, /const stateScope = await requireActiveWorkspaceWriteScope\(\{ reason \}\)/, 'saveSupabaseState should validate write scope before writing');
assert.match(app, /saveJsonMirrorBackupViaRender\(\{ force, reason, savedAt, stateScope \}\)/, 'JSON mirror backup should pass the canonical write scope to Render');
assert.match(build, /workspace-state-scope-lane/, 'build label should describe the state scope lane');
assert.match(build, /fuel-ledger-v394/, 'build-info expected cache should be v394');
assert.match(sw, /fuel-ledger-v394/, 'service worker cache should be v394');
assert.match(checklist, /Workspace state scope lane - v394/, 'deployment checklist should document the state scope lane pass');

console.log('workspace state scope lane guardrails passed');

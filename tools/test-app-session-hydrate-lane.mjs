import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const build = readFileSync('build-info.js', 'utf8');
const sw = readFileSync('service-worker.js', 'utf8');

assert.match(app, /async function hydrateAppSessionContext\(\{[\s\S]*reason = "sync"[\s\S]*preferredWorkspaceId = ""[\s\S]*force = false[\s\S]*source = "normal-app-session"/, 'normal app session hydrate helper should be the central frontend context lane');
assert.match(app, /source: "app-session-context"[\s\S]*operation: "hydrate"[\s\S]*APP_SESSION_CONTEXT_FRESH/, 'hydrate lane should record fresh-context skips instead of starting duplicate sync work');
assert.match(app, /APP_SESSION_CONTEXT_JOINED_IN_FLIGHT/, 'hydrate lane should join an in-flight app context request');
assert.match(app, /async function ensureBackendAppContextForSyncLane\(reason = "sync"\) \{[\s\S]*return hydrateAppSessionContext\(\{[\s\S]*source: "normal-sync-lane"/, 'legacy sync callers should delegate to the single hydrate lane');
assert.match(app, /await hydrateAppSessionContext\(\{ reason: "initial-session", source: "startup" \}\)|await ensureAppStartupWakeGate\("initial-session", \{ force: true \}\)/, 'startup should hydrate through the single app session lane or startup wake gate');
assert.match(app, /await hydrateAppSessionContext\(\{ reason: `auth-\$\{authEvent\}`, source: "auth" \}\)|await ensureAppStartupWakeGate\(`auth-\$\{authEvent\}`, \{ force: !lastCloudSyncAt \}\)/, 'auth changes should hydrate through the single app session lane or startup wake gate');
assert.match(app, /stateScope = await resolveActiveWorkspaceStateScope\(\{ reason, operation: "load" \}\)/, 'normal state loads should resolve the app-session-backed workspace state scope before workspace data loads');
assert.match(app, /await resolveActiveWorkspaceStateScope\(\{ reason: "state-load", operation: "load" \}\)/, 'normalized state load should reuse the single app-session-backed state scope lane');
assert.match(app, /await hydrateAppSessionContext\(\{[\s\S]*reason: `workspace-switch:\$\{source\}`[\s\S]*force: true[\s\S]*source: "workspace-switch"/, 'workspace switch should confirm backend context through the hydrate lane');
assert.match(app, /hydrateAppSessionContext\(\{ reason: `admin-diagnostics:\$\{String\(reason \|\| "admin"\)\}`[\s\S]*source: "admin-diagnostics"/, 'Admin diagnostics may inspect backend context but must stay labeled outside normal app UX');
assert.doesNotMatch(app, /scheduleWorkspaceInviteRefresh\("admin-tab-open"\)/, 'Admin tab open must not revive the old workspace tools auto-refresh lane');
assert.match(build, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421)/, 'build-info expected cache should be v394');
assert.match(sw, /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421)/, 'service worker cache should be v394');

console.log('app session hydrate lane guardrails passed');

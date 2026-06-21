import fs from 'fs';

const app = fs.readFileSync('app.js', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

assert(app.includes('backendAppContextFreshMs'), 'backend app context freshness window should be defined');
assert(app.includes('backendAppContextSyncPromise'), 'backend context sync lane should coalesce in-flight context loads');
assert(app.includes('async function ensureBackendAppContextForSyncLane'), 'single sync lane helper should exist');
assert(app.includes('reason: `app-session:${reasonLabel}`'), 'sync lane context requests should be labeled through app-session hydration');
assert(app.includes('stateScope = await resolveActiveWorkspaceStateScope({ reason, operation: "load" })'), 'loadSupabaseState should resolve backend-context-backed state scope before loading state');
assert(app.includes('const scope = stateScope || await resolveActiveWorkspaceStateScope({ reason: "state-load", operation: "load" });'), 'normalized state load should reuse the resolved backend-context-backed state scope instead of refetching/guessing');
assert(!app.includes('await refreshLinkedWorkspacesAfterInvite().catch((error) => console.warn("Initial workspace list refresh failed", error));'), 'startup should no longer run a separate workspace RPC before backend context');
assert(!app.includes('scheduleWorkspaceInviteRefresh("startup-session");'), 'startup should not schedule a separate workspace tools refresh before context-driven load');
assert(!app.includes('scheduleWorkspaceInviteRefresh("auth-session");'), 'auth change should not schedule a separate workspace tools refresh before context-driven load');
assert(app.includes('await hydrateAppSessionContext({ reason: "initial-session", source: "startup" })') || app.includes('await ensureAppStartupWakeGate("initial-session", { force: true })'), 'initial session should use backend context through startup wake gate as the first sync lane step');
assert(app.includes('await hydrateAppSessionContext({ reason: `auth-${authEvent}`, source: "auth" })') || app.includes('await ensureAppStartupWakeGate(`auth-${authEvent}`, { force: !lastCloudSyncAt })'), 'auth session should use backend context through startup wake gate as the first sync lane step');

console.log('Backend app context pass 4 checks passed');

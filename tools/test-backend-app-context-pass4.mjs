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
assert(app.includes('await hydrateAppSessionContext({ reason, source: "loadSupabaseState" }).catch'), 'loadSupabaseState should hydrate backend context before loading state');
assert(app.includes('isBackendAppContextFreshForWorkspace(ledgerId)\n    ? getBackendAppContext()'), 'normalized state load should reuse fresh backend context instead of refetching/guessing');
assert(!app.includes('await refreshLinkedWorkspacesAfterInvite().catch((error) => console.warn("Initial workspace list refresh failed", error));'), 'startup should no longer run a separate workspace RPC before backend context');
assert(!app.includes('scheduleWorkspaceInviteRefresh("startup-session");'), 'startup should not schedule a separate workspace tools refresh before context-driven load');
assert(!app.includes('scheduleWorkspaceInviteRefresh("auth-session");'), 'auth change should not schedule a separate workspace tools refresh before context-driven load');
assert(app.includes('await hydrateAppSessionContext({ reason: "initial-session", source: "startup" })'), 'initial session should use backend context as the first sync lane step');
assert(app.includes('await hydrateAppSessionContext({ reason: `auth-${String(event || "session").toLowerCase()}`, source: "auth" })'), 'auth session should use backend context as the first sync lane step');

console.log('Backend app context pass 4 checks passed');

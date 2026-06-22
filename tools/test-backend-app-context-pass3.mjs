import fs from "node:fs";

const server = fs.readFileSync("server.py", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const build = fs.readFileSync("build-info.js", "utf8");
const sw = fs.readFileSync("service-worker.js", "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

assert(server.includes('payload.get("preferredWorkspaceId"),\n        payload.get("selectedWorkspaceId"),\n        payload.get("urlWorkspaceId"),\n        payload.get("loadedWorkspaceId"),\n        payload.get("ledgerId")'), "backend app context prefers explicit workspace intent before legacy/default ledger id");
assert(app.includes('preferredWorkspaceId = ""') && app.includes('preferredWorkspaceIdAtRequest') && app.includes('preferredWorkspaceId: preferredWorkspaceIdAtRequest'), "frontend sends a request-scoped preferredWorkspaceId to backend app context");
assert(app.includes('workspace-switch:${source}') && app.includes('WORKSPACE_SWITCH_BACKEND_CONTEXT_BLOCKED'), "workspace switch asks backend context and blocks unconfirmed switches");
assert(app.includes('const scope = stateScope || await resolveActiveWorkspaceStateScope({ reason: "state-load", operation: "load" });'), "state load uses the app-session-backed active workspace state scope before configured default ledger");
assert(app.includes('await resolveActiveWorkspaceStateScope({ reason: "state-load", operation: "load" })'), "state load sends active workspace through the app session state scope lane");
assert(server.includes('def workspace_identity_values(row):') && server.includes('def build_workspace_identity_index(workspaces):'), "backend app context indexes workspace ids and slugs");
assert(server.includes('by_identity = build_workspace_identity_index(workspaces)') && server.includes('if requested and requested in by_identity:'), "backend app context can resolve requested workspace aliases such as slugs");
assert(app.includes('function getWorkspaceIdentityValues(ledger = {})') && app.includes('function buildWorkspaceIdentityLookup(ledgers = [])'), "frontend workspace resolution indexes ledger ids and slugs");
assert(app.includes('const linkedIdentityLookup = buildWorkspaceIdentityLookup(ledgers);') && app.includes('const urlWorkspace = urlWorkspaceId ? linkedIdentityLookup.get(urlWorkspaceId) : null;'), "frontend URL workspace resolution accepts slug aliases and stores canonical ledger ids");
assert(app.includes('stale-backend-context-ignored') && app.includes('selectedWorkspaceIdAtRequest'), "frontend ignores late backend app-context responses for a workspace the user has already left");
assert((/fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420)/.test(build) && /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420)/.test(sw)), "runtime cache bumped to v393");

console.log("Backend app context pass 3 guardrail passed.");

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
assert(app.includes('preferredWorkspaceId = ""') && app.includes('preferredWorkspaceId: preferredWorkspaceId || ledgerId || getActiveLedgerId()'), "frontend can send preferredWorkspaceId to backend app context");
assert(app.includes('workspace-switch:${source}') && app.includes('WORKSPACE_SWITCH_BACKEND_CONTEXT_BLOCKED'), "workspace switch asks backend context and blocks unconfirmed switches");
assert(app.includes('let ledgerId = getActiveLedgerId() || supabaseHelpers.getLedgerId(supabaseConfig);'), "state load uses active workspace before configured default ledger");
assert(app.includes('getRenderAppContext({ ledgerId, preferredWorkspaceId: ledgerId, reason: "state-load" })'), "state load sends active workspace as preferred backend context");
assert(build.includes("fuel-ledger-v392") && sw.includes("fuel-ledger-v392"), "runtime cache bumped to v390");

console.log("Backend app context pass 3 guardrail passed.");

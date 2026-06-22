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

assert(server.includes('if self.path == "/api/app/context"'), "server routes /api/app/context");
assert(server.includes("def build_app_context_response"), "server builds canonical app context response");
assert(server.includes("linkedWorkspaces") && server.includes("activeWorkspace") && server.includes("activeMember") && server.includes("permissions"), "context includes active workspace, active member, linked workspaces, and permissions");
assert(/const\s+renderAppContextUrl\s*=\s*renderApiEndpoints\.appContext\s*\|\|\s*"\/api\/app\/context"/.test(app), "frontend declares app context endpoint");
assert(app.includes("async function getRenderAppContext"), "frontend can load backend app context");
assert(app.includes("applyBackendAppContext"), "frontend applies backend app context");
assert(app.includes('reason: "state-load"') && app.includes("backendWorkspaceId"), "state load asks backend context before loading rows");
assert(app.includes("appBackendContext: appBackendContextStatus"), "load reports export backend app context status");
assert((/fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421|422)/.test(build) && /fuel-ledger-v(?:394|395|396|397|398|399|400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|420|421|422)/.test(sw)), "runtime cache bumped to v388");

console.log("Backend app context guardrail passed.");

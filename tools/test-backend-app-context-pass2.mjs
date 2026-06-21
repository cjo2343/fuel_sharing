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

assert(server.includes('"activeMember": active_member'), "backend app context returns activeMember");
assert(server.includes('"canLookupVehicle"') && server.includes('"canManageSettings"'), "backend app context returns vehicle/settings permissions");
assert(app.includes("function getBackendAppContextPermission") && app.includes("function getBackendActiveMemberProfile"), "frontend has backend context permission/member helpers");
assert(app.includes('const backendPermission = getBackendAppContextPermission("canManageSettings")'), "settings permissions prefer backend context");
assert(app.includes('const backendOwnerPermission = getBackendAppContextPermission("canUseAppOwnerDiagnostics")'), "global admin permission prefers backend context");
assert(app.includes('reason: "vehicle-lookup"') && app.includes('VEHICLE_LOOKUP_BACKEND_CONTEXT_DENIED'), "vehicle lookup refreshes backend context before running");
assert(app.includes('backendCanLookupVehicle: getBackendAppContextPermission("canLookupVehicle")'), "vehicle readiness report exports backend vehicle permission");
assert(build.includes("fuel-ledger-v390") && sw.includes("fuel-ledger-v390"), "runtime cache bumped to v389");

console.log("Backend app context pass 2 guardrail passed.");

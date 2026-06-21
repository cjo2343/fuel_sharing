import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("app.js", "utf8");
const server = fs.readFileSync("server.py", "utf8");

assert.match(app, /memberRows:\s*\[\]/, "global diagnostics status should initialize generic memberRows.");
assert.match(app, /const memberRows = Array\.isArray\(diagnostics\.memberRows\)/, "frontend should read generic memberRows from global diagnostics.");
assert.doesNotMatch(app, /targetMemberships/, "frontend should not expose the old targeted membership field.");
assert.match(server, /"memberRows": member_rows\[:50\]/, "backend should return generic memberRows.");
assert.doesNotMatch(server, /"targetMemberships"/, "backend should not return targetMemberships anymore.");
assert.match(server, /include_metadata = payload\.get\("includeMetadata"\)/, "owner activity should support metadata-light requests.");
assert.match(app, /ownerActivityAutoRefreshEnabled = false/, "owner activity should stay manual/cached instead of auto-refreshing.");

console.log("owner global diagnostics generic cache guardrail passed");

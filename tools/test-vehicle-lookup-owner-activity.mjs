import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");

assert.match(app, /callRenderJson\(renderVehicleLookupUrl[\s\S]*timeoutLabel: "Vehicle lookup"/, "vehicle lookup should use the shared Render helper so fetch and response-body reads share one timeout");
assert.doesNotMatch(app, /const fetchPromise = fetch\(renderVehicleLookupUrl/, "vehicle lookup should not use a hand-rolled fetch timeout path");
assert.doesNotMatch(app, /const timeoutPromise = new Promise[\s\S]{0,500}Vehicle lookup/, "vehicle lookup should not leave orphaned timeout promises");
assert.match(app, /VEHICLE_LOOKUP_STARTED/, "vehicle lookup should record a start diagnostic");
assert.match(app, /VEHICLE_LOOKUP_TIMEOUT/, "vehicle lookup should record a timeout diagnostic");
assert.match(app, /maybeRefreshOwnerActivityAfterMemberAction\(\{ reason: "vehicle-lookup", success: true \}\)/, "vehicle lookup should record a quiet audit skip instead of auto-refreshing owner activity");
assert.match(app, /shouldRefreshOwnerActivityAfterLookup = !timedOut && !providerUnavailable/, "vehicle lookup should avoid owner activity refreshes when Render/provider is already slow");
assert.match(app, /ownerActivityVisibleRowLimit = 6/, "owner activity should keep the global audit view compact by default");
assert.match(app, /body: ownerActivityScope === "all" \? \{ limit: 120 \} : \{ limit: 120, ledgerId: ownerActivityLoadedWorkspaceId\(\) \}/, "owner activity current-workspace requests should be scoped by ledgerId");

assert.match(server, /record_owner_activity_as_service\(ledger_id, user, action="vehicle-lookup"[\s\S]*result_code="VEHICLE_LOOKUP_ERROR"/, "server should record failed vehicle lookups in owner activity before returning an error");
assert.match(server, /result_code="VEHICLE_LOOKUP_FORBIDDEN"/, "server should record forbidden vehicle lookups in owner activity");
assert.match(server, /self\.send_json\(\{"ok": False, "code": "VEHICLE_LOOKUP_ERROR"/, "server vehicle lookup should return structured JSON on unexpected errors");

console.log("ok - vehicle lookup uses shared helper and records owner activity on success/failure");

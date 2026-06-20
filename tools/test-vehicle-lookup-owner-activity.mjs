import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");

assert.match(app, /callRenderJson\(renderVehicleLookupUrl[\s\S]*timeoutLabel: "Vehicle lookup"/, "vehicle lookup should use the shared Render helper so fetch and response-body reads share one timeout");
assert.doesNotMatch(app, /const fetchPromise = fetch\(renderVehicleLookupUrl/, "vehicle lookup should not use a hand-rolled fetch timeout path");
assert.doesNotMatch(app, /const timeoutPromise = new Promise[\s\S]{0,500}Vehicle lookup/, "vehicle lookup should not leave orphaned timeout promises");
assert.match(app, /VEHICLE_LOOKUP_STARTED/, "vehicle lookup should record a start diagnostic");
assert.match(app, /VEHICLE_LOOKUP_TIMEOUT/, "vehicle lookup should record a timeout diagnostic");
assert.match(app, /refreshOwnerActivity\(\{ force: true, silent: true \}\)\.catch/, "vehicle lookup should refresh owner activity after every lookup attempt");
assert.match(app, /const rows = allRows\.slice\(0, 20\)/, "owner activity should show enough rows for vehicle lookups to be visible");
assert.match(app, /body: \{ limit: 120 \}/, "owner activity fetch should request enough rows for recent vehicle lookups");

assert.match(server, /record_owner_activity_as_service\(ledger_id, user, action="vehicle-lookup"[\s\S]*result_code="VEHICLE_LOOKUP_ERROR"/, "server should record failed vehicle lookups in owner activity before returning an error");
assert.match(server, /result_code="VEHICLE_LOOKUP_FORBIDDEN"/, "server should record forbidden vehicle lookups in owner activity");
assert.match(server, /self\.send_json\(\{"ok": False, "code": "VEHICLE_LOOKUP_ERROR"/, "server vehicle lookup should return structured JSON on unexpected errors");

console.log("ok - vehicle lookup uses shared helper and records owner activity on success/failure");

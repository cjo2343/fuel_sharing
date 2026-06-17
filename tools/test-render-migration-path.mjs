import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const server = readFileSync("server.py", "utf8");
const pathDoc = readFileSync("RENDER-MIGRATION-PATH.md", "utf8");

for (const endpoint of [
  "/api/trips/upsert",
  "/api/fuel/upsert",
  "/api/payments/status-action",
  "/api/bookings/upsert",
  "/api/bookings/delete"
]) {
  assert.ok(app.includes(endpoint) || server.includes(endpoint), `Render endpoint ${endpoint} must be tracked in app/server code`);
  assert.ok(pathDoc.includes(endpoint), `Render endpoint ${endpoint} must be documented in the migration path`);
}

assert.ok(app.includes("const renderBookingUpsertUrl = \"/api/bookings/upsert\";"), "booking saves must have a Render API endpoint constant");
assert.ok(app.includes("const renderBookingDeleteUrl = \"/api/bookings/delete\";"), "booking deletes must have a Render API endpoint constant");
assert.ok(app.includes("async function saveBookingViaRender"), "booking saves must prefer a Render backend helper");
assert.ok(app.includes("async function softDeleteBookingViaRender"), "booking deletes must prefer a Render backend helper");
assert.ok(app.includes('route: "render-api", endpoint: renderBookingUpsertUrl'), "booking save diagnostics must identify the Render route");
assert.ok(app.includes('route: "render-api", endpoint: renderBookingDeleteUrl'), "booking delete diagnostics must identify the Render route");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "booking-save" }), "booking-save")'), "booking saves must time-bound pre-backend normalized context setup");

assert.ok(server.includes('if self.path == "/api/bookings/upsert":'), "server must route booking upserts through Render");
assert.ok(server.includes('if self.path == "/api/bookings/delete":'), "server must route booking deletes through Render");
assert.ok(server.includes("def build_booking_upsert_rpc_payload"), "server must validate booking upsert payloads before RPC calls");
assert.ok(server.includes("def build_booking_delete_rpc_payload"), "server must validate booking delete payloads before RPC calls");
assert.ok(server.includes('call_supabase_rpc_as_user("upsert_car_booking"'), "booking upserts must call Supabase RPC as the signed-in user");
assert.ok(server.includes('call_supabase_rpc_as_user("soft_delete_car_booking"'), "booking deletes must call Supabase RPC as the signed-in user");

console.log("Render migration path check passed.");

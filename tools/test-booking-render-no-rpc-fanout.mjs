import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.ok(app.includes("async function saveBookingRpc"), "booking save helper must remain present");
assert.ok(app.includes("const renderResult = await saveBookingViaRender(context, payload);"), "booking saves must try Render first");
assert.ok(app.includes("if (renderResult.ok || !renderResult.shouldFallback) return renderResult;"), "booking saves must return after a successful Render save instead of falling through to browser RPC");
assert.ok(!app.includes('recordDataIoDiagnostic("start", { source: "booking-save", route: "supabase-rpc", rpc: "upsert_car_booking", operation: "save", ok: true });'), "booking saves must not pre-record browser RPC diagnostics before Render has failed");
assert.ok(app.includes('if (rpcResult.backend === "supabase-rpc") {\n        recordDataIoDiagnostic("success", { source: "booking-save", route: "supabase-rpc", rpc: "upsert_car_booking", operation: "save", ok: true });'), "booking RPC success diagnostics must only be recorded when the RPC fallback actually ran");

console.log("Booking Render no-RPC fanout guard check passed.");

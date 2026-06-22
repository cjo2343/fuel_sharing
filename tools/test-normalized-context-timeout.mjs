import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.ok(app.includes("const normalizedWriteContextTimeoutMs = 6000;"), "normalized write context timeout must be shorter than the visible Saving stale failsafe");
assert.ok(app.includes("async function withNormalizedWriteContextTimeout"), "app must expose a timeout wrapper for pre-backend normalized write setup");
assert.ok(app.includes("isNormalizedWriteContextTimeout"), "timeout wrapper must mark normalized context timeouts for diagnostics");
assert.ok(app.includes('recordDataIoDiagnostic("timeout", {'), "timeout wrapper must record a Data I/O timeout diagnostic");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "trip-save", requireRenderContext: true }), "trip-save")'), "trip saves must time-bound normalized write context setup");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "fuel-save", requireRenderContext: true }), "fuel-save")'), "fuel saves must time-bound normalized write context setup");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "booking-save", requireRenderContext: true }), "booking-save")'), "booking saves must time-bound normalized write context setup");
assert.ok(!app.includes('const context = await getNormalizedWriteContext({ source: "trip-save" });'), "trip saves must not call normalized write context without timeout");
assert.ok(!app.includes('const context = await getNormalizedWriteContext({ source: "fuel-save" });'), "fuel saves must not call normalized write context without timeout");
assert.ok(!app.includes('const context = await getNormalizedWriteContext({ source: "booking-save" });'), "booking saves must not call normalized write context without timeout");

console.log("Normalized context timeout guard check passed.");

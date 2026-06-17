import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.ok(app.includes("const normalizedWriteContextTimeoutMs = 10000;"), "normalized write context timeout must be shorter than the visible Saving stale failsafe");
assert.ok(app.includes("async function withNormalizedWriteContextTimeout"), "app must expose a timeout wrapper for pre-backend normalized write setup");
assert.ok(app.includes("isNormalizedWriteContextTimeout"), "timeout wrapper must mark normalized context timeouts for diagnostics");
assert.ok(app.includes('recordDataIoDiagnostic("timeout", {'), "timeout wrapper must record a Data I/O timeout diagnostic");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "trip-save" }), "trip-save")'), "trip saves must time-bound normalized write context setup");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "fuel-save" }), "fuel-save")'), "fuel saves must time-bound normalized write context setup");
assert.ok(!app.includes('const context = await getNormalizedWriteContext({ source: "trip-save" });'), "trip saves must not call normalized write context without timeout");
assert.ok(!app.includes('const context = await getNormalizedWriteContext({ source: "fuel-save" });'), "fuel saves must not call normalized write context without timeout");

console.log("Normalized context timeout guard check passed.");

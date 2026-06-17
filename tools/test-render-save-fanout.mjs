import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.ok(app.includes("let cachedNormalizedWriteContext = null;"), "normalized write context should be cached for render-first saves");
assert.ok(app.includes("function getCachedNormalizedWriteContext"), "render-first saves should reuse recent member/open-period context");
assert.ok(app.includes('recordSupabaseLoadEvent("normalized-context-cache"'), "cache hits should be visible in diagnostics");
assert.ok(app.includes('getNormalizedWriteContext({ syncDirectory: false, source: "trip-save" })'), "trip saves must not sync ledger directory before Render save");
assert.ok(app.includes('getNormalizedWriteContext({ syncDirectory: false, source: "fuel-save" })'), "fuel saves must not sync ledger directory before Render save");
assert.ok(app.includes('getNormalizedWriteContext({ syncDirectory: false, source: "booking-save" })'), "booking saves must not sync ledger directory before Render save");
assert.ok(app.includes('markNextLocalSaveCoveredByNormalizedWrite("trip-save")'), "trip saves should mark the next local save as already persisted remotely");
assert.ok(app.includes('markNextLocalSaveCoveredByNormalizedWrite("fuel-save")'), "fuel saves should mark the next local save as already persisted remotely");
assert.ok(app.includes('markNextLocalSaveCoveredByNormalizedWrite("booking-save")'), "booking saves should mark the next local save as already persisted remotely");
assert.ok(app.includes('recordSupabaseLoadEvent("remote-save-skip"'), "covered local saves should skip the generic full-state remote save");
assert.ok(!app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "trip-save" }), "trip-save")'), "trip saves must not use directory-syncing context setup");
assert.ok(!app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "fuel-save" }), "fuel-save")'), "fuel saves must not use directory-syncing context setup");
assert.ok(!app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "booking-save" }), "booking-save")'), "booking saves must not use directory-syncing context setup");

console.log("Render save fanout guard check passed.");

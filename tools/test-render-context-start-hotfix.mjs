import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "trip-save" }), "trip-save")'), "trip saves must use the proven context setup before Render writes");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "fuel-save" }), "fuel-save")'), "fuel saves must use the proven context setup before Render writes");
assert.ok(app.includes('withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "booking-save" }), "booking-save")'), "booking saves must use the proven context setup before Render writes");
assert.ok(!app.includes("cachedNormalizedWriteContext"), "v280 normalized context cache must not remain on the save-start hotfix path");
assert.ok(!app.includes("nextLocalSaveCoveredByNormalizedWrite"), "v280 full-state-save suppression must not remain until save-start reliability is restored");

console.log("Render context start hotfix check passed.");

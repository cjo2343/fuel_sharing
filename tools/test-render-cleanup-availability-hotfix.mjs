import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReleaseMetadataAtLeast } from "./release-metadata-helpers.mjs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assertReleaseMetadataAtLeast(buildInfo, serviceWorker, {
  minimumVersion: "2026.06.18.196",
  minimumCache: 296,
  message: "Render cleanup availability release metadata"
});

const cleanupViaRenderStart = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTablesViaRender");
const cleanupViaRenderEnd = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason", cleanupViaRenderStart);
assert.ok(cleanupViaRenderStart >= 0 && cleanupViaRenderEnd > cleanupViaRenderStart, "app.js must include the Render cleanup helper.");
const cleanupViaRender = app.slice(cleanupViaRenderStart, cleanupViaRenderEnd);
assert.ok(!cleanupViaRender.includes("renderBackendAvailable"), "Render cleanup helper must not reference the undefined renderBackendAvailable flag.");
assert.match(cleanupViaRender, /typeof fetch !== "function"/, "Render cleanup helper should use a safe fetch availability check.");
assert.match(cleanupViaRender, /fetch\(renderAdminTestDataCleanupUrl/, "Render cleanup helper must still call the Render cleanup route.");
assert.match(cleanupViaRender, /Browser direct-table cleanup fallback is disabled/, "Render cleanup helper must fail closed instead of using browser cleanup fallback.");
assert.match(packageJson, /test-render-cleanup-availability-hotfix\.mjs/, "Validate script must run the v296 hotfix guard test.");

console.log("Render cleanup availability hotfix guard check passed.");

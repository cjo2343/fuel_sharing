import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");

assert.match(buildInfo, /version:\s*"2026\.06\.18\.196"/, "build-info.js must be bumped to v296.");
assert.match(buildInfo, /buildLabel:\s*"render-cleanup-availability-hotfix"/, "build-info.js must use the v296 hotfix build label.");
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v296"/, "build-info.js must expect the v296 service-worker cache.");
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v296"/, "service-worker.js must use the v296 cache.");
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"render-cleanup-availability-hotfix"/, "service-worker.js must use the v296 hotfix build label.");

const cleanupViaRenderStart = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTablesViaRender");
const cleanupViaRenderEnd = app.indexOf("async function cleanupGeneratedRowsFromNormalizedTables(reason", cleanupViaRenderStart);
assert.ok(cleanupViaRenderStart >= 0 && cleanupViaRenderEnd > cleanupViaRenderStart, "app.js must include the Render cleanup helper.");
const cleanupViaRender = app.slice(cleanupViaRenderStart, cleanupViaRenderEnd);
assert.ok(!cleanupViaRender.includes("renderBackendAvailable"), "Render cleanup helper must not reference the undefined renderBackendAvailable flag.");
assert.match(cleanupViaRender, /typeof fetch !== "function"/, "Render cleanup helper should use a safe fetch availability check.");
assert.match(cleanupViaRender, /fetch\(renderAdminTestDataCleanupUrl/, "Render cleanup helper must still call the Render cleanup route.");
assert.match(cleanupViaRender, /falling back to browser cleanup/, "Render cleanup helper must keep a clear fallback diagnostic.");
assert.match(packageJson, /test-render-cleanup-availability-hotfix\.mjs/, "Validate script must run the v296 hotfix guard test.");

console.log("Render cleanup availability hotfix guard check passed.");

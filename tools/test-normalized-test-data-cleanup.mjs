import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");


assert.match(app, /async function cleanupGeneratedRowsFromNormalizedTables\(/, "Cleanup must include a normalized-table cleanup helper.");
assert.match(app, /source = "normalized-test-data-cleanup"/, "Normalized cleanup must have its own Data I\/O source.");
assert.match(app, /renderAdminTestDataCleanupUrl\s*=\s*renderApiEndpoints\.adminTestDataCleanup\s*\|\|\s*"\/api\/admin\/test-data\/cleanup"/, "Cleanup must use the Render cleanup route.");
assert.match(app, /endpoint: renderAdminTestDataCleanupUrl/, "Cleanup Data I/O must identify the Render endpoint.");
assert.match(app, /Browser direct-table cleanup fallback is disabled/, "Browser direct-table cleanup fallback should be disabled after Render route is proven.");
assert.match(app, /recordSupabaseLoadEvent\("render-normalized-test-data-cleanup"/, "Render cleanup must leave a visible monitor event.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("cleanup-test-lab-data"\)/, "Clean Test Lab data must clean normalized tables before mirroring.");
assert.match(app, /const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables\("remove-generated-test-data"\)/, "Remove generated test data must also clean normalized tables.");
assert.match(packageJson, /test-normalized-test-data-cleanup\.mjs/, "Validate script must run the v293 guard test.");

console.log("Normalized Test Lab cleanup guard check passed.");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReleaseMetadataAtLeast } from './release-metadata-helpers.mjs';

const app = readFileSync("app.js", "utf8");
const buildInfo = readFileSync("build-info.js", "utf8");
const serviceWorker = readFileSync("service-worker.js", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const noiseTest = readFileSync("tools/test-supabase-activity-headline-noise.mjs", "utf8");

assert.match(app, /const activeAdminToolOperations = new Set\(\)/, "admin tools should track active operations by source.");
assert.match(app, /function normalizeAdminToolSource\(source = "admin-tool"\)/, "admin tool sources should be normalized before dedupe checks.");
assert.match(app, /activeAdminToolOperations\.has\(normalizedSource\)[\s\S]*recordAdminToolSkip\(normalizedSource, skipDetail, \{ operation \}\)[\s\S]*reason: "admin-tool-already-running"/, "duplicate admin tool runs should be skipped with a clear diagnostic result.");
assert.match(app, /activeAdminToolOperations\.add\(normalizedSource\)[\s\S]*finally \{\s*activeAdminToolOperations\.delete\(normalizedSource\);\s*\}/, "admin tool dedupe locks must clear in a finally block.");
assert.match(app, /recordDataIoDiagnostic\("skip", \{ \.\.\.makeAdminToolDiagnosticMeta\(source, detail, operation\), ok: false \}\)/, "admin tool skips should be rendered as skipped Data I/O rows instead of OK rows.");
assert.match(app, /showUserWarning\("That admin action is already running\. Wait for it to finish before running it again\."\)/, "duplicate clicks should show a calm user-facing warning.");
assert.match(noiseTest, /data-io:admin-tool:security-health:skip/, "headline-noise tests should cover duplicate admin-tool skip rows.");
assert.match(packageJson, /test-admin-tool-dedup-guard\.mjs/, "validate script should include the admin tool dedupe guard.");
assertReleaseMetadataAtLeast(buildInfo, serviceWorker, {
  minimumVersion: '2026.06.18.219',
  minimumCache: 319,
  message: 'Admin tool dedupe release metadata'
});
assert.match(buildInfo, /Admin and Test Lab tools now skip duplicate in-flight clicks/, "release note should describe the admin tool duplicate-run guard.");

console.log("Admin tool duplicate-run guard check passed.");

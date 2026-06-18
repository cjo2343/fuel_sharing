#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

assert.match(app, /localLoadMonitorEventMinutes: 60/, "local load-monitor retention window should be policy-driven");
assert.match(app, /maxStoredReportReleaseNotes: 5/, "stored reports should cap release-note history");
assert.match(app, /maxStoredReportDiagnosticRows: 20/, "stored reports should cap diagnostic row samples");
assert.match(app, /function sanitizeStoredDiagnosticReport\(value\)/, "stored diagnostic report sanitizer must exist");
assert.match(app, /delete sanitized\.browser/, "stored reports must remove browser metadata");
assert.match(app, /delete sanitized\.events/, "stored reports must remove raw event history");
assert.match(app, /delete sanitized\.dataIoDiagnostics/, "stored reports must remove raw Data I\/O diagnostics");
assert.match(app, /delete sanitized\.dataIoOperations/, "stored reports must remove paired Data I\/O operation history");
assert.match(app, /releaseNotes: trimArrayForPrivacy/, "stored reports must trim long release-note history");
assert.match(app, /summary\.latest = trimArrayForPrivacy/, "stored reports must trim latest diagnostic samples");
assert.match(app, /privacyPruned = true/, "stored reports should mark that privacy pruning happened");
assert.match(app, /return sanitizeStoredDiagnosticReport\(value\)/, "cloud report redaction should use the storage sanitizer");
assert.match(app, /const reportToStore = sanitizeStoredDiagnosticReport\(report\)/, "local report persistence should use the storage sanitizer");
assert.match(app, /await exportAdminSafetyBackup\("retention cleanup"\)/, "retention cleanup should take a fresh safety backup");
assert.match(app, /assertFreshAdminSafetyBackup\("retention cleanup"\)/, "retention cleanup should verify a fresh safety backup");
assert.match(app, /"retention cleanup"/, "retention cleanup should be a known safety-backup reason");
assert.match(app, /entry\.at \|\| entry\.iso/, "load-monitor retention should understand event ISO timestamps");

console.log("Retention privacy cleanup guard checks passed.");

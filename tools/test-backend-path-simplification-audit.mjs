#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const audit = fs.readFileSync('BACKEND-PATH-AUDIT.md', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');


assert.match(app, /const testLabReportCloudSaveTimeoutMs\s*=\s*(?:25000|35000);/, 'report cloud save timeout should avoid false 15s boundary failures');
assert.match(app, /function normalizeAdminToolResult/, 'admin tool result normalization should be centralized');
assert.match(app, /function runTracedAdminToolAction/, 'admin tool actions should share one normalization wrapper');
assert.match(app, /return normalizeAdminToolResult\(result\);/, 'admin tool wrapper should normalize action results before traceDataIo finishes');
assert.match(app, /lastSyncError\s*=\s*"";\s*\n\s*clearSyncDelay/, 'successful remote saves should clear stale sync errors');
assert.match(app, /return \{ ok: false, error \};/, 'report-save failure should return an error result for the shared admin-tool tracker');
assert.match(app, /return \{ ok: true, destination: "normalized-report-store" \};/, 'normalized report save success should return a structured success result');

assert.match(audit, /Backend Path Simplification Audit/, 'backend path audit should exist');
assert.match(audit, /Trip save\s*\| Render primary \| `POST \/api\/trips\/upsert`/, 'audit should map trip save ownership');
assert.match(audit, /Test Lab report save\s*\| Render primary/, 'audit should map report-save ownership honestly');
assert.match(audit, /Emergency fallback only/, 'audit should define emergency fallback policy');
assert.match(packageJson, /test-backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route\.mjs/, 'validate should run v305 guard test');

console.log('Backend path simplification audit guard check passed.');

#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const audit = fs.readFileSync('BACKEND-PATH-AUDIT.md', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243|244|245|246|247|248|249|250|251|252|253|254|255|256|257)"/, 'build-info should publish v305');
assert.match(buildInfo, /buildLabel:\s*"(?:backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'build-info should use v305 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:305|306|307|308|309|310|311|312|313|314|315|316|317|318|319|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386)"/, 'build-info should expect v305 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:305|306|307|308|309|310|311|312|313|314|315|316|317|318|319|319|320|321|322|323|324|325|326|327|328|329|330|331|332|333|334|335|336|337|338|339|340|341|342|343|344|345|346|347|348|349|350|351|352|352|353|354|355|356|357|358|359|360|361|362|363|364|365|366|367|368|369|370|371|372|373|374|375|376|377|378|379|380|381|382|384|385|386)"/, 'service worker cache should be v305');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'service worker label should match v305');

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

#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');
const audit = fs.readFileSync('BACKEND-PATH-AUDIT.md', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:207|208|209|210|211|212|213)"/, 'build-info should publish v307 or a preserving v309 patch');
assert.match(buildInfo, /buildLabel:\s*"render-admin-report-save-route"/, 'build-info should use v307 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v3[0-9][0-9]"/, 'build-info should expect v307 or a preserving v309 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v3[0-9][0-9]"/, 'service worker should use v307 or a preserving v309 cache');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"render-admin-report-save-route"/, 'service worker label should match v307');

assert.match(app, /const renderAdminReportSaveUrl = "\/api\/admin\/reports\/save";/, 'app should define the Render admin report-save URL');
assert.match(app, /async function saveTestLabReportViaRender\(report\)/, 'app should save reports through Render');
assert.match(app, /source: "admin-report-save"/, 'app should record Render report-save diagnostics');
assert.match(app, /fetch\(renderAdminReportSaveUrl/, 'app should call the Render report-save route');
assert.doesNotMatch(app, /supabaseClient\.rpc\("upsert_test_lab_report"/, 'browser should no longer call report-save RPC directly');
assert.doesNotMatch(app, /recordSupabaseLoadEvent\("test-lab-report-rpc-save"/, 'browser should not record direct report RPC save activity');

assert.match(server, /"\/api\/admin\/reports\/save"/, 'server should mount the report-save route');
assert.match(server, /def save_admin_report_backend\(self\):/, 'server should implement the report-save handler');
assert.match(server, /def save_admin_report_as_user\(payload, user, user_token\):/, 'server should save reports as the signed-in user');
assert.match(server, /assert_user_can_admin_ledger\(ledger_id, user, user_token\)/, 'server report save should verify workspace admin permission');
assert.match(server, /call_supabase_rpc_as_user\("upsert_test_lab_report"/, 'server should call the report save RPC');
assert.match(server, /"adminReportSave", "\/api\/admin\/reports\/save"/, 'admin health should list the report-save route');

assert.match(audit, /Render primary.*Browser report RPC removed/, 'audit should mark report save as Render-owned');
assert.match(packageJson, /test-render-admin-report-save-route\.mjs/, 'validate should run the v307 guard test');

console.log('Render admin report-save route guard check passed.');

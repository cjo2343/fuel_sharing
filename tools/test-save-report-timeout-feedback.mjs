#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:204|205|206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241)"/, 'build-info should publish v304 or later');
assert.match(buildInfo, /buildLabel:\s*"(?:save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'build-info should use v304 or later label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v3[0-9][0-9]"/, 'build-info should expect v304 or later cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v3[0-9][0-9]"/, 'service worker cache should be v304 or later');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:save-report-timeout-feedback|backend-path-simplification-audit|remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'service worker label should match v304 or later');

assert.match(app, /const testLabReportCloudSaveTimeoutMs\s*=\s*(?:15000|25000|35000);/, 'report cloud save should have an explicit timeout');
assert.match(app, /async function withTestLabReportCloudSaveTimeout/, 'report cloud save timeout helper should exist');
assert.match(app, /error\.isTestLabReportCloudSaveTimeout\s*=\s*true;/, 'report cloud save timeout should be identifiable');
assert.match(app, /fetch\(renderAdminReportSaveUrl/, 'report save should use the Render admin report route');
assert.match(app, /Render report save timed out after/, 'report save timeout should name the Render report action');
assert.match(app, /Render admin health is currently OK, so this is treated as a slow Supabase probe warning rather than a failed backend safety check\./, 'security health timeout warnings should mention healthy Render backend');
assert.match(app, /Run Check Render health to separate Render\/backend health from a slow Supabase probe\./, 'security health timeout warnings should tell admins how to separate causes');
assert.match(packageJson, /test-save-report-timeout-feedback\.mjs/, 'validate should run v304 guard test');

console.log('Save report timeout feedback guard check passed.');

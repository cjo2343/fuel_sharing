#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.204"/, 'build-info should publish v304');
assert.match(buildInfo, /buildLabel:\s*"save-report-timeout-feedback"/, 'build-info should use v304 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v304"/, 'build-info should expect v304 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v304"/, 'service worker cache should be v304');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"save-report-timeout-feedback"/, 'service worker label should match v304');

assert.match(app, /const testLabReportCloudSaveTimeoutMs\s*=\s*15000;/, 'report cloud save should have a short explicit timeout');
assert.match(app, /async function withTestLabReportCloudSaveTimeout/, 'report cloud save timeout helper should exist');
assert.match(app, /error\.isTestLabReportCloudSaveTimeout\s*=\s*true;/, 'report cloud save timeout should be identifiable');
assert.match(app, /withTestLabReportCloudSaveTimeout\(supabaseClient\.rpc\("upsert_test_lab_report"/, 'report RPC save should be time-bound');
assert.match(app, /Save Test Lab report to cloud"\);/, 'report save timeout should name the admin action');
assert.match(app, /Render admin health is currently OK, so this is treated as a slow Supabase probe warning rather than a failed backend safety check\./, 'security health timeout warnings should mention healthy Render backend');
assert.match(app, /Run Check Render health to separate Render\/backend health from a slow Supabase probe\./, 'security health timeout warnings should tell admins how to separate causes');
assert.match(packageJson, /test-save-report-timeout-feedback\.mjs/, 'validate should run v304 guard test');

console.log('Save report timeout feedback guard check passed.');

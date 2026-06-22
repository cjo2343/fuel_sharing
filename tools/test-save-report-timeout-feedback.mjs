#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v[34][0-9][0-9]"/, 'service worker cache should be v304 or later');

assert.match(app, /const testLabReportCloudSaveTimeoutMs\s*=\s*(?:15000|25000|35000);/, 'report cloud save should have an explicit timeout');
assert.match(app, /async function withTestLabReportCloudSaveTimeout/, 'report cloud save timeout helper should exist');
assert.match(app, /error\.isTestLabReportCloudSaveTimeout\s*=\s*true;/, 'report cloud save timeout should be identifiable');
assert.match(app, /fetch\(renderAdminReportSaveUrl/, 'report save should use the Render admin report route');
assert.match(app, /Render report save timed out after/, 'report save timeout should name the Render report action');
assert.match(app, /Render admin health is currently OK, so this is treated as a slow Supabase probe warning rather than a failed backend safety check\./, 'security health timeout warnings should mention healthy Render backend');
assert.match(app, /Run Check Render health to separate Render\/backend health from a slow Supabase probe\./, 'security health timeout warnings should tell admins how to separate causes');
assert.match(packageJson, /test-save-report-timeout-feedback\.mjs/, 'validate should run v304 guard test');

console.log('Save report timeout feedback guard check passed.');

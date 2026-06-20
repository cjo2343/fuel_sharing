#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const audit = fs.readFileSync('BACKEND-PATH-AUDIT.md', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:206|207|208|209|210|211|212|213|214|215|216|217|218|219|220|221|222|222|222|222|222|222|222|222|222|222|222|222|222|222|222|223|224|225|226|227|228|229|230|231|232|233|234|235|236|237|238|239|240|241|242|243)"/, 'build-info should publish v306');
assert.match(buildInfo, /buildLabel:\s*"(?:remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'build-info should use v306 label');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v3[0-9][0-9]"/, 'build-info should expect v306 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v3[0-9][0-9]"/, 'service worker should use v306 cache');
assert.match(serviceWorker, /BUILD_LABEL\s*=\s*"(?:remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route)"/, 'service worker label should match v306');

assert.match(app, /Browser retention RPC fallback is disabled/, 'retention failures should explicitly fail closed through Render');
assert.doesNotMatch(app, /supabaseClient\.rpc\("preview_retention_cleanup"/, 'browser preview retention RPC fallback should be removed');
assert.doesNotMatch(app, /supabaseClient\.rpc\("run_retention_cleanup"/, 'browser retention cleanup RPC fallback should be removed');
assert.doesNotMatch(app, /falling back to browser retention RPC/, 'retention diagnostics should not announce browser fallback');

assert.match(app, /Browser test-data fallback is disabled/, 'generated test-data create should fail closed through Render');
const generatedTripBlock = app.slice(app.indexOf('async function addGeneratedTestTrip'), app.indexOf('async function addGeneratedTestFuel'));
const generatedFuelBlock = app.slice(app.indexOf('async function addGeneratedTestFuel'), app.indexOf('async function removeGeneratedTestData'));
assert.doesNotMatch(generatedTripBlock, /saveTripToNormalizedTablesFirst\(tripPayload\)/, 'generated test trip should not fallback to browser trip save');
assert.doesNotMatch(generatedFuelBlock, /saveFuelToNormalizedTablesFirst\(fuelPayload\)/, 'generated test fuel should not fallback to browser fuel save');

assert.match(app, /Browser direct-table cleanup fallback is disabled/, 'generated cleanup should fail closed when Render cleanup route fails');
assert.doesNotMatch(app, /from\("trips"\)\s*\.select\("id,legacy_id,period_id,note,deleted_at"\)/, 'generated cleanup should not directly select trips in browser');
assert.doesNotMatch(app, /from\("fuel_payments"\)\s*\.select\("id,legacy_id,period_id,station_name,deleted_at"\)/, 'generated cleanup should not directly select fuel payments in browser');
assert.doesNotMatch(app, /from\("car_bookings"\)\s*\.select\("id,legacy_id,purpose,deleted_at"\)/, 'generated cleanup should not directly select bookings in browser');

assert.match(app, /JSON mirror report-save fallback is disabled/, 'report save should fail closed rather than JSON mirror fallback');
assert.doesNotMatch(app, /destination:\s*"json-mirror-fallback"/, 'report-save JSON mirror destination should be removed');
assert.doesNotMatch(app, /reason:\s*"Test Lab report JSON fallback"/, 'report save should not wake JSON mirror fallback');

assert.match(audit, /v306 remove proven browser fallbacks pass 1/, 'audit should document v306 fallback removal');
assert.match(packageJson, /test-remove-proven-browser-fallbacks-pass-1|render-admin-report-save-route\.mjs/, 'validate should run v306 guard test');

console.log('Remove proven browser fallbacks pass 1 guard check passed.');

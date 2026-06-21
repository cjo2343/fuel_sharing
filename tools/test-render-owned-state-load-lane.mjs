#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');
const pkg = fs.readFileSync('package.json', 'utf8');
const runValidations = fs.readFileSync('tools/run-validations.mjs', 'utf8');

assert.match(server, /"jsonMirror": json_mirror/, 'Render /api/state/load should include the JSON mirror row in its stateRows response');
assert.match(server, /car_share_ledgers\?select=state,updated_at&id=eq\.\{ledger_q\}/, 'Render state load should read the JSON mirror server-side');

const loadStart = app.indexOf('async function loadSupabaseState');
const loadEnd = app.indexOf('\nasync function saveSupabaseState', loadStart);
assert.notEqual(loadStart, -1, 'loadSupabaseState should exist');
const loadBody = app.slice(loadStart, loadEnd);
assert.match(loadBody, /const renderStateRows = await getRenderNormalizedStateRows\(ledgerId\);/, 'normal state load should ask Render for state rows');
assert.match(loadBody, /route: "browser-read-fallback"/, 'normal state load should diagnose blocked browser read fallback');
assert.match(loadBody, /RENDER_STATE_LOAD_REQUIRED/, 'normal state load should fail closed when Render state load is unavailable');
assert.doesNotMatch(loadBody, /\.from\("car_share_ledgers"\)[\s\S]*?\.select\("state,updated_at"\)/, 'normal state load must not read car_share_ledgers directly in the browser');

const normalizedStart = app.indexOf('async function loadStateFromNormalizedTables');
const normalizedEnd = app.indexOf('\nfunction markSupabaseLoadTimedOut', normalizedStart);
assert.notEqual(normalizedStart, -1, 'loadStateFromNormalizedTables should exist');
const normalizedBody = app.slice(normalizedStart, normalizedEnd);
assert.match(normalizedBody, /allowBrowserReadFallback = false/, 'browser normalized table read fallback should be opt-in only');
assert.match(normalizedBody, /BROWSER_STATE_READ_FALLBACK_DISABLED/, 'blocked normalized table read fallback should have a result code');

assert.match(app, /BROWSER_JSON_MIRROR_WRITE_FALLBACK_DISABLED/, 'JSON mirror direct browser write fallback should be blocked');
assert.doesNotMatch(app.slice(app.indexOf('async function saveJsonMirrorBackup')), /\.from\("car_share_ledgers"\)\s*\.upsert/, 'saveJsonMirrorBackup must not upsert car_share_ledgers directly from the browser');

assert.match(pkg, /test-render-owned-state-load-lane\.mjs/, 'package validation should include the Render-owned state load guard');
assert.match(runValidations, /test-render-owned-state-load-lane\.mjs/, 'run-validations should include the Render-owned state load guard');

console.log('Render-owned state load lane guard passed.');

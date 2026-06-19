#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync('app.js', 'utf8');
const audit = fs.readFileSync('BACKEND-PATH-AUDIT.md', 'utf8');
const migrationPath = fs.readFileSync('RENDER-MIGRATION-PATH.md', 'utf8');
const buildInfo = fs.readFileSync('build-info.js', 'utf8');
const serviceWorker = fs.readFileSync('service-worker.js', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

assert.match(buildInfo, /version:\s*"2026\.06\.18\.(?:217|218|219|220|221|222|222|222|222|223|224)"/, 'runtime version must be bumped for browser write fallback lockdown');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:31[789]|320|321|322|323|324)"/, 'build-info must point at v317 cache');
assert.match(serviceWorker, /CACHE_NAME\s*=\s*"fuel-ledger-v(?:31[789]|320|321|322|323|324)"/, 'service worker must use v317 cache');
assert.match(buildInfo, /Normal trip, fuel, booking, payment-status, and ledger-directory writes now fail closed through Render/, 'release note should describe fallback lockdown');

assert.match(app, /function failClosedBrowserWriteFallback\(/, 'app should centralize browser write fallback blocking');
assert.match(app, /route:\s*"browser-write-fallback"/, 'blocked browser write fallback diagnostics should use a clear route name');

const guardedFunctions = [
  ['saveTripWithParticipantsRpc', 'Browser trip Supabase RPC/table fallback is disabled', 'supabaseClient.rpc("upsert_trip_with_participants"'],
  ['saveFuelPaymentRpc', 'Browser fuel Supabase RPC/table fallback is disabled', 'supabaseClient.rpc("upsert_fuel_payment"'],
  ['saveBookingRpc', 'Browser booking Supabase RPC/table fallback is disabled', 'supabaseClient.rpc("upsert_car_booking"'],
  ['softDeleteBookingRpc', 'Browser booking-delete Supabase RPC/table fallback is disabled', 'supabaseClient.rpc("soft_delete_car_booking"'],
  ['applyPaymentStatusActionRpc', 'Browser payment-action Supabase RPC fallback is disabled', 'supabaseClient.rpc("apply_payment_status_action"']
];

for (const [functionName, blockedMessage, forbiddenCall] of guardedFunctions) {
  const start = app.indexOf(`async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const next = app.indexOf('\nasync function ', start + 1);
  const body = app.slice(start, next === -1 ? app.length : next);
  assert.match(body, /failClosedBrowserWriteFallback\(/, `${functionName} should fail closed instead of falling back to browser writes`);
  assert.match(body, new RegExp(blockedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${functionName} should name the blocked fallback`);
  assert.doesNotMatch(body, new RegExp(forbiddenCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${functionName} should not call the browser Supabase RPC fallback`);
}

const syncStart = app.indexOf('async function syncLedgerDirectoryForAdmin');
const syncEnd = app.indexOf('\nasync function saveTripToNormalizedTablesFirst', syncStart);
const syncBody = app.slice(syncStart, syncEnd);
assert.match(syncBody, /Browser ledger-directory direct-table fallback is disabled/, 'ledger directory sync should fail closed instead of direct-table fallback');
assert.doesNotMatch(syncBody, /await upsertLedgerSettings\(ledgerPayload\)/, 'ledger directory sync should not upsert ledgers directly after Render failure');
assert.doesNotMatch(syncBody, /from\("ledger_members"\)\s*\.upsert/, 'ledger directory sync should not upsert members directly after Render failure');

assert.match(audit, /v317 Render-owned write fallback lockdown/, 'backend path audit should document this pass');
assert.match(migrationPath, /Browser write fallback lockdown/, 'Render migration path should document this pass');
assert.match(packageJson, /test-render-owned-write-fallback-lockdown\.mjs/, 'validation should run this guardrail');

console.log('Render-owned write fallback lockdown guard passed.');

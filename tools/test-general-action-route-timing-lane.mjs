import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('app.js', 'utf8');
const server = readFileSync('server.py', 'utf8');
const buildInfo = readFileSync('build-info.js', 'utf8');

assert.match(buildInfo, /buildLabel:\s*"update-prompt-bridge-workspace-retention-lane|update-prompt-workspace-visibility-lane|general-action-route-timing-lane"/, 'build label should describe the general action route timing lane');
assert.match(buildInfo, /expectedServiceWorkerCache:\s*"fuel-ledger-v(?:409|410|411|412|413|414|415)"/, 'service worker cache must be bumped for runtime changes');

assert.match(server, /def action_timing_mark\(/, 'server should expose action timing breadcrumbs for action routes');
assert.match(server, /def best_effort_owner_activity_as_service\(/, 'owner activity logging should be isolated as best-effort work');
assert.match(server, /def action_route_response\(/, 'action routes should return structured route timing metadata');

for (const route of ['/api/bookings/upsert', '/api/bookings/delete', '/api/trips/upsert', '/api/fuel/upsert', '/api/payments/status-action']) {
  assert.match(server, new RegExp(`routeTiming[\\s\\S]{0,160}${route.replaceAll('/', '\\/')}`), `${route} should include routeTiming in its success response`);
}

assert.match(server, /self\.send_json\(\{"ok": True, "result": result[\s\S]{0,260}best_effort_owner_activity_as_service/, 'server should send the action response before optional owner activity logging');
assert.doesNotMatch(server, /record_owner_activity_as_service\(rpc_payload[\s\S]{0,220}\n\s*self\.send_json\(\{"ok": True, "result": result/, 'action routes must not block responses on owner activity logging');

assert.match(app, /routeTiming:\s*meta\.routeTiming \|\| null/, 'Data I/O diagnostics should preserve routeTiming metadata');
assert.match(app, /serverTimings:\s*Array\.isArray\(meta\.serverTimings\)/, 'Data I/O diagnostics should preserve server timing phase lists');
for (const code of ['BOOKING_SAVED', 'BOOKING_DELETED', 'TRIP_SAVED', 'FUEL_SAVED']) {
  assert.match(app, new RegExp(`routeTiming:\\s*result\\.routeTiming[\\s\\S]{0,220}resultCode:\\s*"${code}"|resultCode:\\s*"${code}"[\\s\\S]{0,220}routeTiming:\\s*result\\.routeTiming`), `${code} success diagnostics should include routeTiming`);
}

assert.match(app, /BOOKING_SAVE_UNCAUGHT_CAUGHT/, 'booking submit should catch unexpected promise errors and record a diagnostic');
assert.match(app, /recoverInteractiveActionControls\("booking-submit-catch"\)/, 'booking submit catch should recover controls without a refresh');

console.log('✅ General action route timing lane guardrail passed');

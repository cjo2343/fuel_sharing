import fs from 'node:fs';

const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.py', 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

assert(app.includes('ownerActivityFetchStartedAt'), 'owner activity tracks fetch start time');
assert(app.includes('ownerActivityInFlightTraceMeta'), 'owner activity keeps trace metadata for forced timeout finish rows');
assert(app.includes('OWNER_ACTIVITY_REFRESH_IN_FLIGHT'), 'duplicate owner activity refreshes are explicitly skipped');
assert(app.includes('OWNER_ACTIVITY_TIMEOUT'), 'stale owner activity refreshes record timeout finish rows');
assert(app.includes('const requestAndReadPromise = (async () => {\n      const headers = await buildRenderRequestHeaders'), 'Render API timeout wraps token/header setup and fetch/body read');
assert(app.includes('refreshOwnerActivity({ force: true, silent: true }).catch(() => {})'), 'vehicle lookup refreshes owner activity after attempts');

assert(server.includes('def get_member_context_as_service_fast'), 'server has fast member-only vehicle lookup authorization');
assert(server.includes('context = get_member_context_as_service_fast(ledger_id, user, timeout=5)'), 'vehicle lookup avoids slow open-period state-load context');
assert(server.includes('def record_lookup_activity'), 'vehicle lookup has one guaranteed owner activity recorder');
assert(server.includes('VEHICLE_LOOKUP_CLIENT_CLOSED'), 'vehicle lookup records client disconnects');
assert(server.includes('VEHICLE_LOOKUP_TIMEOUT'), 'vehicle lookup records timeout outcomes');
assert(!server.includes('get_state_load_context_as_service(ledger_id, user)\n            result, status = fetch_vehicle_lookup'), 'vehicle lookup no longer waits on full state-load context before provider call');

console.log('Owner activity and vehicle lookup reliability guardrails passed.');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Migration 144 (GVM-428): the deferred-fuel escape hatch. The functional replay
// (tools/test-deferred-fuel-close-functional.sh) proves the behaviour; this cheap
// guard runs in `npm run validate` and pins the properties that are easy to lose
// in a later re-declaration — the ones whose absence is silent rather than loud.

const sql = readFileSync('supabase/migrations/144_close_deferred_booking_fuel.sql', 'utf8');
const schema = readFileSync('supabase-schema.sql', 'utf8');

const SIGNATURE = 'create or replace function public.close_deferred_booking_fuel(\n  target_ledger_id text,\n  target_trip_id uuid,\n  event_title text default null,\n  event_body text default null\n)';

assert.ok(
  sql.includes(SIGNATURE),
  'close_deferred_booking_fuel must keep its (ledger, trip, event_title, event_body) signature — no amount, no litres',
);

const fn = sql.slice(sql.indexOf(SIGNATURE));

// It resolves to not_refuelled and detaches nothing else. A close that wrote any
// other resolution would leave the entry nagging exactly as before.
assert.match(fn, /set fuel_resolution = 'not_refuelled',\s*\n\s*completion_fuel_legacy_id = null/i);
assert.match(fn, /and t\.fuel_resolution = 'deferred'/i);

// SECURITY DEFINER bypasses RLS, so the function gates itself: member, then
// admin OR driver OR creator (GV-253).
assert.match(fn, /security definer/i);
assert.match(fn, /public\.is_ledger_member\(target_ledger_id\)/i);
assert.match(fn, /public\.current_ledger_member_id\(target_ledger_id\)/i);
assert.match(
  fn,
  /public\.is_ledger_admin\(target_ledger_id\)[\s\S]{0,200}v_trip\.driver_member_id = v_actor_member_id[\s\S]{0,200}v_trip\.created_by_member_id = v_actor_member_id/i,
  'the close must stay gated to admin OR driver OR creator',
);

// Row lock, so two devices closing at once serialize instead of racing.
assert.match(fn, /for update of t/i);

// The whole point: an entry whose period already closed must still be closable.
assert.match(fn, /set_config\('govehlo\.pii_scrub', '1', true\)/i);
assert.match(fn, /set_config\('govehlo\.pii_scrub', '', true\)/i);

// Idempotent, and never destructive towards a receipt that landed first.
assert.match(fn, /v_trip\.fuel_resolution = 'not_refuelled'[\s\S]{0,300}'already_closed', true/i);
assert.match(fn, /v_trip\.fuel_resolution = 'logged' and v_trip\.completion_fuel_legacy_id is not null/i);

// Cross-client live sync IS a ledger_events insert — without it the other members'
// devices keep nagging about an entry that is already resolved.
assert.match(
  fn,
  /insert into public\.ledger_events \(\s*\n\s*ledger_id, event_type, title, body, actor_member_id, actor_email, metadata\s*\n\s*\) values \(\s*\n\s*target_ledger_id, 'trip_fuel_closed'/i,
  'the close must write a trip_fuel_closed ledger_event or other devices never learn about it',
);
assert.match(fn, /auth\.jwt\(\) ->> 'email'/i);

// Client-callable; anon is not.
assert.match(fn, /grant execute on function public\.close_deferred_booking_fuel\(text, uuid, text, text\) to authenticated;/i);
assert.match(fn, /revoke all on function public\.close_deferred_booking_fuel\(text, uuid, text, text\) from anon;/i);

// The consolidated schema must carry the same definition byte-for-byte (the
// equivalence check diffs function bodies, in-body comments included).
const migrationBlock = sql.slice(sql.indexOf(SIGNATURE), sql.indexOf('insert into public.fuel_ledger_schema_migrations'));
assert.ok(
  schema.includes(migrationBlock),
  'supabase-schema.sql must mirror close_deferred_booking_fuel byte-identically',
);

console.log('ok - deferred booking fuel has a no-amount escape hatch to not_refuelled (GVM-428)');

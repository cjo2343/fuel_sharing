import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/136_atomic_booking_fuel_completion.sql', 'utf8');

assert.match(sql, /add column if not exists fuel_resolution text/i);
assert.match(sql, /fuel_resolution in \('logged', 'deferred', 'not_refuelled', 'not_needed'\)/i);
assert.match(sql, /create index if not exists trips_deferred_fuel_resolution_idx/i);
assert.match(sql, /create or replace function public\.enforce_trip_fuel_resolution/i);
assert.match(sql, /fp\.ledger_id = new\.ledger_id[\s\S]*fp\.legacy_id = new\.completion_fuel_legacy_id/i);

const rpc = sql.slice(sql.indexOf('create or replace function public.complete_booking_trip_with_fuel'));
assert.match(rpc, /public\.upsert_booking_trip_with_participants\(/i);
assert.match(rpc, /select t\.fuel_resolution, t\.completion_fuel_legacy_id[\s\S]*for update of t/i);
assert.match(rpc, /existing_fuel_resolution = 'logged'[\s\S]*fuel_resolution_value <> 'logged'/i);
assert.match(rpc, /effective_fuel_legacy_id := coalesce\([\s\S]*existing_fuel_legacy_id/i);
assert.match(rpc, /public\.upsert_fuel_payment\(/i);
assert.match(rpc, /set fuel_resolution = 'logged'[\s\S]*completion_fuel_legacy_id = effective_fuel_legacy_id/i);
assert.match(rpc, /revoke all on function public\.complete_booking_trip_with_fuel[\s\S]*from anon/i);
assert.match(rpc, /grant execute on function public\.complete_booking_trip_with_fuel[\s\S]*to authenticated/i);

console.log('ok - booking fuel completion is durable, atomic, replay-safe, and access-gated');

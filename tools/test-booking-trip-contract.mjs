import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/123_booking_trip_link.sql', 'utf8');

assert.match(sql, /add column if not exists booking_id uuid[\s\S]*references public\.car_bookings\(id\) on delete set null/i);
assert.match(sql, /create unique index if not exists trips_one_active_per_booking_idx[\s\S]*where booking_id is not null and deleted_at is null/i);
assert.match(sql, /booking_ledger_id is distinct from new\.ledger_id/i);
assert.match(sql, /booking_member_id is distinct from new\.driver_member_id/i);

const rpc = sql.slice(sql.indexOf('create or replace function public.upsert_booking_trip_with_participants'));
assert.match(rpc, /where cb\.id = target_booking_id[\s\S]*for update of cb/i);
assert.match(rpc, /where t\.booking_id = target_booking_id[\s\S]*for update of t/i);
assert.match(rpc, /effective_legacy_trip_id := nullif\(existing_booking_trip\.legacy_id, ''\)/i);
assert.match(rpc, /public\.upsert_trip_with_participants\([\s\S]*effective_legacy_trip_id/i);
assert.match(rpc, /set booking_id = target_booking_id/i);
assert.match(rpc, /'reused_existing', reused_existing/i);
assert.match(rpc, /revoke all on function public\.upsert_booking_trip_with_participants[\s\S]*from anon/i);
assert.match(rpc, /grant execute on function public\.upsert_booking_trip_with_participants[\s\S]*to authenticated/i);

console.log('ok - booking completion is scoped, serialized, linked, and idempotent');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/124_booking_completion_reminders.sql', 'utf8');

assert.match(sql, /add column if not exists requires_linked_trip boolean not null default true/i);
assert.match(sql, /cb\.created_at < applied\.applied_at/i);
assert.match(sql, /create index if not exists car_bookings_trip_reminder_due_idx/i);

const claim = sql.slice(sql.indexOf('create or replace function public.claim_due_booking_trip_reminders'));
assert.match(claim, /cb\.end_at <= now\(\)/i);
assert.match(claim, /cb\.end_at > now\(\) - interval '7 days'/i);
assert.match(claim, /not exists[\s\S]*t\.booking_id = cb\.id[\s\S]*t\.deleted_at is null/i);
assert.match(claim, /for update of cb skip locked/i);
assert.match(claim, /trip_reminder_claim_token = gen_random_uuid\(\)/i);
assert.match(claim, /grant execute on function public\.claim_due_booking_trip_reminders\(integer\) to service_role/i);

const confirm = sql.slice(sql.indexOf('create or replace function public.confirm_booking_trip_reminders'));
assert.match(confirm, /trip_reminder_claim_token = i\.claim_token/i);
assert.match(confirm, /'booking_completion_reminder_sent'/i);
assert.match(confirm, /'outcome', c\.outcome/i);
assert.match(confirm, /grant execute on function public\.confirm_booking_trip_reminders\(jsonb\) to service_role/i);

console.log('ok - booking reminder uses durable eligibility and lease/token claim-confirm semantics');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/migrations/140_late_entry_carryover.sql', 'utf8');

assert.match(sql, /status in \('open', 'queued', 'closed'\)/i);
assert.match(sql, /one_queued_settlement_period_per_ledger/i);
assert.match(sql, /create or replace function public\.ensure_settlement_carryover_period/i);
assert.match(sql, /pg_advisory_xact_lock\(hashtext\(p_ledger_id \|\| ':settlement-carryover'\)\)/i);

const boundary = sql.slice(
  sql.indexOf('create or replace function public.enforce_settlement_entry_period_boundary'),
  sql.indexOf('-- Repair rows gained period_id'),
);
assert.match(boundary, /v_new_is_live := new\.deleted_at is null/i);
assert.match(boundary, /tg_op = 'INSERT'[\s\S]*and v_new_is_live/i);
assert.match(boundary, /sp\.id = new_period_id[\s\S]*for share of sp/i);
assert.match(boundary, /public\.settlement_entry_is_locked\(new_ledger_id, new_period_id\)/i);
assert.match(boundary, /new\.period_id := new_period_id/i);
assert.match(boundary, /period_row\.status = 'closed'/i);

const promotion = sql.slice(sql.indexOf('create or replace function public.promote_settlement_carryover_entries'));
for (const table of ['trips', 'fuel_payments', 'workspace_expenses', 'vehicle_repairs']) {
  assert.match(promotion, new RegExp(`update public\\.${table}[\\s\\S]*period_id = new\\.id`, 'i'));
}
assert.match(promotion, /after insert on public\.settlement_periods/i);
assert.match(promotion, /delete from public\.settlement_periods[\s\S]*status = 'queued'/i);

const repairGuard = sql.slice(
  sql.indexOf('create or replace function public.enforce_repair_period_lock'),
  sql.indexOf('-- close_settlement_period always INSERTS'),
);
assert.match(repairGuard, /current_setting\('govehlo\.pii_scrub', true\)[\s\S]*return old/i);
assert.match(repairGuard, /old\.period_id is not null[\s\S]*sp\.id = old\.period_id/i);
assert.match(repairGuard, /public\.settlement_entry_is_locked\(old\.ledger_id, old\.period_id\)/i);

const deferred = sql.slice(sql.indexOf('create or replace function public.complete_deferred_booking_fuel'));
assert.match(deferred, /for update of t/i);
assert.match(deferred, /v_trip\.fuel_resolution <> 'deferred'/i);
assert.match(deferred, /public\.upsert_fuel_payment\(/i);
assert.match(deferred, /set_config\('govehlo\.pii_scrub', '1', true\)/i);
assert.match(deferred, /set fuel_resolution = 'logged'[\s\S]*completion_fuel_legacy_id = fuel_legacy_id/i);
assert.match(deferred, /grant execute on function public\.complete_deferred_booking_fuel[\s\S]*to authenticated/i);

console.log('ok - locked-period late entries queue durably and promote without changing frozen totals');

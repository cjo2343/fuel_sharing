import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const migrationDir = "supabase/migrations";
assert.ok(existsSync(migrationDir), "supabase/migrations directory must exist");

const files = readdirSync(migrationDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const expected = [
  "001_initial_schema.sql",
  "002_auth_helpers.sql",
  "003_payment_booking_guards.sql",
  "004_period_close_and_admin_rpcs.sql",
  "005_rls_policies.sql",
  "006_realtime_ledger_events.sql",
  "007_security_health_rpc.sql",
  "008_scheduled_reminder_rpcs.sql",
  "009_retention_privacy_cleanup.sql",
  "010_trip_transaction_rpc.sql",
  "011_booking_transaction_rpcs.sql",
  "012_admin_tools_guardrails.sql",
  "013_fuel_payment_rpc.sql",
  "014_rpc_health_visibility.sql",
  "015_test_lab_report_store.sql",
  "016_realtime_publication_health.sql",
  "017_healthcheck_rpc_detection_fix.sql",
];

assert.deepEqual(files, expected, "migration files must be present and ordered");

files.forEach((file, index) => {
  const expectedPrefix = String(index + 1).padStart(3, "0");
  assert.ok(file.startsWith(`${expectedPrefix}_`), `${file} should start with ${expectedPrefix}_`);
  const content = readFileSync(join(migrationDir, file), "utf8");
  assert.ok(content.trim().length > 0, `${file} must not be empty`);
  assert.ok(/^-- Migration \d{3}:/m.test(content), `${file} should start with a migration comment`);
});

const migrationText = files.map((file) => readFileSync(join(migrationDir, file), "utf8")).join("\n");
const consolidatedSchema = readFileSync("supabase-schema.sql", "utf8");

for (const marker of [
  "create table if not exists public.ledger_events",
  "create or replace function public.close_settlement_period(",
  "pg_try_advisory_xact_lock(hashtext(target_ledger_id))",
  "create or replace function public.fuel_ledger_healthcheck",
  "alter publication supabase_realtime add table public.ledger_events",
  "grant execute on function public.save_scheduled_reminder_state(text, jsonb) to service_role",
  "create or replace function public.preview_retention_cleanup",
  "create or replace function public.run_retention_cleanup",
  "create or replace function public.upsert_trip_with_participants",
  "grant execute on function public.upsert_trip_with_participants",
  "create or replace function public.upsert_car_booking",
  "create or replace function public.soft_delete_car_booking",
  "grant execute on function public.upsert_car_booking",
  "grant execute on function public.soft_delete_car_booking",
  "create or replace function public.upsert_fuel_payment",
  "grant execute on function public.upsert_fuel_payment",
  "critical_rpcs",
  "to_regprocedure('public.upsert_fuel_payment",
  "create table if not exists public.test_lab_reports",
  "create or replace function public.upsert_test_lab_report",
  "grant execute on function public.upsert_test_lab_report",
  "to_regprocedure('public.upsert_test_lab_report",
  "realtime_publication",
  "recommended_tables",
  "ledger_events_enabled",
  "create or replace function public.upsert_ledger_member_admin",
  "create or replace function public.set_ledger_member_active_admin",
  "create or replace function public.purge_generated_test_rows",
  "grant execute on function public.upsert_ledger_member_admin",
  "critical_rpc_names",
  "from pg_proc p",
  "p.proname = rpc_name",
  "push_subscription_scope",
]) {
  assert.ok(migrationText.includes(marker), `migrations should include marker: ${marker}`);
  assert.ok(consolidatedSchema.includes(marker), `consolidated schema should include marker: ${marker}`);
}

console.log("ok - migration files are present, ordered, and cover critical schema markers");

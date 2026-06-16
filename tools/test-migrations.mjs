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
  "018_realtime_publication_cleanup.sql",
  "019_immutable_test_lab_report_history.sql",
  "020_bootstrap_lock.sql",
  "021_cloud_test_lab_report_retention.sql",
  "022_settlement_request_transaction_rpc.sql",
  "023_schema_migration_tracking.sql",
  "024_schema_drift_healthcheck.sql",
  "025_workspace_foundation.sql",
  "026_invite_onboarding_foundation.sql",
  "027_invite_code_generation_pgcrypto_fix.sql",
];

assert.deepEqual(files, expected, "migration files must be present and ordered");

files.forEach((file, index) => {
  const expectedPrefix = String(index + 1).padStart(3, "0");
  assert.ok(file.startsWith(`${expectedPrefix}_`), `${file} should start with ${expectedPrefix}_`);
  const content = readFileSync(join(migrationDir, file), "utf8");
  assert.ok(content.trim().length > 0, `${file} must not be empty`);
  assert.ok(/^-- Migration \d{3}:/m.test(content), `${file} should start with a migration comment`);
});

files.forEach((file) => {
  const migrationNumber = Number(file.slice(0, 3));
  if (migrationNumber >= 23) {
    const content = readFileSync(join(migrationDir, file), "utf8");
    const migrationId = file.replace(/\.sql$/, "").replace(/^0*(\d+)_/, (match, number) => `${number.padStart(3, "0")}_`);
    assert.ok(
      content.includes("public.fuel_ledger_schema_migrations"),
      `${file} should update the Fuel Ledger schema migration tracker`,
    );
    assert.ok(
      content.includes(migrationId),
      `${file} should insert its own migration id (${migrationId}) into the tracker`,
    );
  }
});

const migrationText = files.map((file) => readFileSync(join(migrationDir, file), "utf8")).join("\n");
const consolidatedSchema = readFileSync("supabase-schema.sql", "utf8");

assert.doesNotMatch(
  migrationText,
  /auth_user_id/,
  "migrations must not reference ledger_members.auth_user_id; live member auth is email-based",
);
assert.doesNotMatch(
  consolidatedSchema,
  /auth_user_id/,
  "consolidated schema must not reference ledger_members.auth_user_id; live member auth is email-based",
);

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
  "immutable_history",
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
  "alter publication supabase_realtime drop table public.car_share_ledgers",
  "alter publication supabase_realtime add table public.ledger_events",
  "bootstrap_locked_at",
  "create or replace function public.lock_ledger_bootstrap_when_admin_email_attached",
  "create trigger lock_ledger_bootstrap_on_admin_email",
  "cloud Test Lab report history in retention cleanup",
  "test_lab_report_days",
  "keep_latest_test_lab_reports",
  "grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer)",
  "create or replace function public.upsert_settlement_request_status",
  "grant execute on function public.upsert_settlement_request_status",
  "upsert_settlement_request_status",
  "create table if not exists public.fuel_ledger_schema_migrations",
  "grant select on public.fuel_ledger_schema_migrations to authenticated",
  "'023_schema_migration_tracking'",
  "'schema_migrations'",
  "missing_migrations",
  "latest_expected",
  "'024_schema_drift_healthcheck'",
  "'schema_drift', jsonb_build_object",
  "expected_tables(table_name) as",
  "expected_columns(table_name, column_name) as",
  "expected_policies(table_name, policy_name) as",
  "missing_tables",
  "missing_columns",
  "missing_policies",
  "fuel_ledger_schema_migrations_admin_select",
  "027_invite_code_generation_pgcrypto_fix",
  "extensions.gen_random_bytes",
]) {
  assert.ok(migrationText.includes(marker), `migrations should include marker: ${marker}`);
  assert.ok(consolidatedSchema.includes(marker), `consolidated schema should include marker: ${marker}`);
}

console.log("ok - migration files are present, ordered, and cover critical schema markers");

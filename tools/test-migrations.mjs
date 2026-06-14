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
]) {
  assert.ok(migrationText.includes(marker), `migrations should include marker: ${marker}`);
  assert.ok(consolidatedSchema.includes(marker), `consolidated schema should include marker: ${marker}`);
}

console.log("ok - migration files are present, ordered, and cover critical schema markers");

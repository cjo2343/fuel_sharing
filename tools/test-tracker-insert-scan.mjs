// Unit test for tools/lib/tracker-insert-scan.mjs (GV-392).
//
// The scanner exists because the mirror check in test-migrations.mjs used to be a bare
// substring test, and three migrations' tracker rows went missing from
// supabase-schema.sql anyway — their ids appeared in the file, inside
// fuel_ledger_healthcheck's own expected_schema_migrations VALUES list. So every case
// below is really one question: does the scanner distinguish "this row gets written"
// from "this string is present"? A scanner that answers that wrongly must fail HERE, as
// a broken scanner, rather than downstream as a repo full of unmirrored migrations —
// the same reason lib/markup-hex-scan.mjs and lib/rpc-call-scan.mjs have unit tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trackerInsertedIds, splitStatements, MIGRATION_ID } from "./lib/tracker-insert-scan.mjs";

// ── The real INSERT shapes this repo uses ────────────────────────────────────
assert.deepEqual(
  [...trackerInsertedIds(`
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('146_acknowledge_inspection_booking', 'Some description.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();
`)],
  ["146_acknowledge_inspection_booking"],
  "single-row INSERT with ON CONFLICT",
);

assert.deepEqual(
  [...trackerInsertedIds(`
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values
  ('024_schema_drift_healthcheck', 'a'),
  ('033_onboarding_rate_limit_scope_key_alignment', 'b'),
  ('036_invite_profile_setup', 'c')
on conflict (migration_id) do nothing;
`)].sort(),
  ["024_schema_drift_healthcheck", "033_onboarding_rate_limit_scope_key_alignment", "036_invite_profile_setup"],
  "multi-row INSERT (the GV-392 backfill shape)",
);

// Unqualified table name, and a description containing a semicolon — a naive
// split-on-semicolon would truncate the statement and lose the id.
assert.deepEqual(
  [...trackerInsertedIds(`
insert into fuel_ledger_schema_migrations (migration_id, description)
values ('099_x', 'One thing; then another thing.');
`)],
  ["099_x"],
  "unqualified table name, semicolon inside the description string",
);

// Doubled quotes are how these descriptions escape apostrophes, and they are
// everywhere in this repo's tracker rows.
assert.deepEqual(
  [...trackerInsertedIds(`
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('100_y', 'It''s got an apostrophe, and it''s fine.');
`)],
  ["100_y"],
  "'' escapes inside the description",
);

// ── The near-misses that must NOT count ──────────────────────────────────────

// THE GV-392 CASE. The id appears in the text, inside a dollar-quoted function body
// that is a healthcheck's expectation list. This is precisely what satisfied the old
// substring check while the tracker row was missing.
const healthcheckBody = `
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb language sql stable as $$
  with expected_schema_migrations(migration_id) as (
    values
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('036_invite_profile_setup')
  )
  select 1;
$$;
`;
assert.equal(
  trackerInsertedIds(healthcheckBody).size,
  0,
  "an expectation list inside a dollar-quoted body is not a tracker INSERT — this is the GV-392 masking",
);
assert.ok(
  healthcheckBody.includes("024_schema_drift_healthcheck"),
  "sanity: the substring really is present, which is why the old check passed",
);

// A description narrating an EARLIER migration must not mirror that migration.
assert.deepEqual(
  [...trackerInsertedIds(`
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('147_retire_dead_rpcs', 'Re-declared off 143_drop_production_reset_and_sweep_visibility, which itself followed 130_something_else.');
`)],
  ["147_retire_dead_rpcs"],
  "ids named inside a description string do not count as mirrored",
);

// Comments never count, in either idiom, including a full INSERT that is commented out.
assert.equal(trackerInsertedIds(`
-- insert into public.fuel_ledger_schema_migrations (migration_id) values ('012_admin_tools_guardrails');
/* insert into public.fuel_ledger_schema_migrations (migration_id) values ('013_fuel_payment_rpc'); */
`).size, 0, "commented-out INSERTs do not count");

// A different table with a similar name must not be mistaken for the tracker.
assert.equal(
  trackerInsertedIds(`insert into public.other_schema_migrations (migration_id) values ('014_rpc_health_visibility');`).size,
  0,
  "only public.fuel_ledger_schema_migrations counts",
);

// An INSERT written INSIDE a function body is not executed by the file.
assert.equal(
  trackerInsertedIds(`
create or replace function public.f() returns void language plpgsql as $$
begin
  insert into public.fuel_ledger_schema_migrations (migration_id) values ('015_test_lab_report_store');
end;
$$;
`).size,
  0,
  "an INSERT inside a dollar-quoted body is a string, not a statement the file runs",
);

// Values that are not migration ids are ignored even inside a real tracker INSERT.
assert.deepEqual(
  [...trackerInsertedIds(`
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('016_realtime_publication_health', 'main-car'), ('not-an-id', 'x');
`)],
  ["016_realtime_publication_health"],
  "only strings shaped like a migration id are collected",
);

// ── The lexer's own edges ────────────────────────────────────────────────────
assert.equal(splitStatements(`select 'a;b'; select 2;`).length, 2, "a semicolon inside a string does not split");
assert.equal(splitStatements(`do $tag$ select 1; select 2; $tag$; select 3;`).length, 2, "named dollar tags are honoured");
assert.equal(splitStatements(`select "we;ird"; select 2;`).length, 2, "a semicolon inside a quoted identifier does not split");
assert.ok(MIGRATION_ID.test("147_retire_dead_rpcs_and_legacy_push_subscriptions"));
assert.ok(!MIGRATION_ID.test("supabase-schema"));
assert.ok(!MIGRATION_ID.test("14_short_prefix"));

// ── Against the real files, which is the claim that actually matters ─────────
const consolidated = readFileSync("supabase-schema.sql", "utf8");
const mirrored = trackerInsertedIds(consolidated);
for (const id of [
  "024_schema_drift_healthcheck",
  "033_onboarding_rate_limit_scope_key_alignment",
  "036_invite_profile_setup",
]) {
  assert.ok(mirrored.has(id), `${id} must have a real tracker INSERT in supabase-schema.sql (GV-392)`);
}

console.log(`ok - tracker-insert scanner separates real INSERTs from mentions (${mirrored.size} ids mirrored in supabase-schema.sql)`);

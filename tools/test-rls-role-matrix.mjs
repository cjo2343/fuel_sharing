#!/usr/bin/env node
// Role-matrix behavioral test suite (GV-248).
//
// WHY THIS EXISTS
// ----------------
// check-schema-equivalence.mjs proves the objects EXIST and match; it cannot
// prove they BEHAVE. The GV-259 client-trusted cancel sweep and the GV-260
// amount-mismatch hole both shipped through green structural CI. This suite
// executes the money-moving transitions as REAL Postgres role/actor
// combinations against a disposable database and asserts allow/deny + the
// resulting state — the layer that would have caught those bugs.
//
// HOW IT WORKS
// ------------
//   1. One disposable Postgres 17 container (matches prod Supabase, which runs
//      17.x), repo mounted read-only. All psql runs INSIDE the container; the
//      host needs only Docker. Reuses the exact mechanics of
//      check-schema-equivalence.mjs.
//   2. A Supabase-faithful prelude: roles anon / authenticated / service_role
//      (service_role carries BYPASSRLS like production), auth.jwt()/auth.uid()
//      reading request.jwt.claims, extensions.pgcrypto, supabase_realtime, and
//      — crucially — Supabase's DEFAULT PRIVILEGES (ALL on tables, EXECUTE on
//      functions to the three roles). Without those default grants the schema's
//      own `revoke ... from public` / `grant ... to authenticated` statements
//      would not reproduce the real production grant state, and RLS would never
//      actually be exercised (a plain `set role authenticated` would just hit a
//      missing-table-grant error). The schema's grants run ON TOP of the
//      defaults, exactly as in a real Supabase project.
//   3. supabase-schema.sql is replayed ONCE. A committed fixture is then built
//      through the real RPCs where possible (create_private_ledger_workspace as
//      user A; a second unrelated workspace as user E; members B/C/G + inactive
//      member D inserted as the service role) plus a trip + fuel log that make
//      calculate_period_settlement yield a real debtor->creditor pair (B owes A
//      300 kr).
//   4. Each matrix case runs in its OWN transaction that is always ROLLED BACK,
//      so cases never see each other's writes (except an explicit per-case
//      `setup` sequence run inside the same transaction). Role/JWT is emulated
//      per case: `set local role <pg role>` + set_config('request.jwt.claims').
//
// The verdict for every case is decided INSIDE a plpgsql DO block (so the SQL
// layer — where role/JWT emulation is natural — owns the assertion) and
// surfaces as either `raise notice 'CASEOK <name>'` (psql exits 0) or
// `raise exception 'CASEFAIL <name>: ...'` (psql exits non-zero). An
// expected-exception case that unexpectedly SUCCEEDS raises CASEFAIL; an
// expected-success case that throws raises CASEFAIL printing the real
// SQLSTATE + message. Nothing is swallowed.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD A MATRIX ROW  (this file is where future security fixes park their
// regression case — do it here, not only in a migration comment)
// ─────────────────────────────────────────────────────────────────────────────
// Append an object to the CASES array below. Two shapes:
//
//   rpcCase({
//     name:   'unique-short-name',
//     desc:   'human sentence naming actor + operation + expectation',
//     setup:  [ step(ACTOR, 'sql run before the operation, same txn') , ... ],  // optional
//     actor:  ACTOR,                 // A / B / C / G / E / ADMIN2 / ANON / SERVICE
//     op:     'a SINGLE plpgsql statement, e.g. perform public.some_rpc(...)',
//     expect: 'ok'  |  '<SQLSTATE>', // e.g. '42501', '23514'
//     post:   'optional plpgsql that RAISES on a bad resulting state',          // optional
//   })
//
//   queryCase({ name, desc, setup?, actor, assert: 'plpgsql body that RAISES on
//               a wrong value' })   // for read-visibility / silent-RLS-deny rows
//
// ACTORs are the objects defined after the fixture ids are fetched. `expect` is
// the SQLSTATE the OPERATION must raise (see the function bodies for the exact
// codes: 42501 permission, 23514 check-violation, 22023 invalid-parameter).
// Keep the fixture deterministic; if you need new fixture rows add them to the
// SEED block and re-fetch ids.
//
// ─────────────────────────────────────────────────────────────────────────────
// SECOND HALF: THIS GUARD AUDITS ITS OWN COVERAGE (GV-379)
// ─────────────────────────────────────────────────────────────────────────────
// Proving a case passes says nothing about whether production ever runs that path.
// GV-277 (migration 114) built the entire recurring-suspension feature on
// set_ledger_member_active_admin, which no client calls — both clients deactivate
// through upsert_ledger_member_admin. The feature was dark until migration 145, and
// GVM-330's whole reading half sat built and unreachable. CI never blinked, because
// THIS FILE is that function's only caller anywhere: the guard exercised the fixed
// function and certified a code path production never takes.
//
// So after the matrix runs, a coverage block (just before cleanup() at the end)
// intersects what this guard exercises, what `authenticated` may actually execute in
// the replayed database, and what the two sibling client repos call. Anything in all
// three needs a reviewed, dated entry in tools/role-matrix-coverage-allowlist.mjs.
// A missing sibling repo warns rather than fails (fuel_sharing CI checks out this repo
// alone); --strict makes it a failure. Adding a case for an uncalled function is
// therefore a decision you have to write down, not a silent one.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Replay image comes from the canonical constant so this guard can't drift onto
// a different major version than the other Docker-backed checks (GV-314).
import { IMAGE } from "./lib/replay-container.mjs";
// Coverage check (GV-379) — see the block just before cleanup() at the end of this file.
import { coverageExceptions } from "./role-matrix-coverage-allowlist.mjs";
import { exercisedFunctions, findClientCallers } from "./lib/rpc-call-scan.mjs";

const CONTAINER = `govehlo-role-matrix-${process.pid}`;
const REPO = process.cwd();
const DB = "role_matrix";

// A missing sibling repo cannot be a hard failure by default: fuel_sharing's own CI
// checks out this repo alone, so the client half of the coverage check is simply not
// determinable there. --strict makes an absent sibling a failure, for a future umbrella
// workflow that checks out all three repos side by side. Same convention, same reason,
// as tools/check-token-drift.mjs (GV-256) — read that file's header for the precedent.
const STRICT = process.argv.includes("--strict");

// Supabase-faithful prelude. Default privileges are set BEFORE the schema so
// every object the schema creates is granted to anon/authenticated/service_role
// exactly as in a real project; the schema's explicit revoke/grant lines then
// carve the production grant state on top. service_role gets BYPASSRLS.
const PRELUDE = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Supabase's storage schema (GV-393). Until this existed here, migration 139's
-- incident-photo object policies were wrapped in
-- \`if exists (select 1 from information_schema.schemata where schema_name = 'storage')\`
-- and therefore never created in ANY replay — the block was a no-op on both sides of
-- the equivalence check (symmetric, no diff, zero coverage), and the only thing
-- guarding who may upload or delete incident photos in production was a regex over
-- the SQL text in tools/test-incident-photo-storage-contract.mjs. That is a
-- GDPR-relevant surface: incident photos are pictures of vehicles, plausibly showing
-- number plates. Creating the schema makes the block fire, so the policies below can
-- be exercised for real by the storage-* cases.
--
-- Only the columns the policies actually reference are modelled (bucket_id, name,
-- owner_id) plus an id/created_at, and foldername() is Supabase's own definition:
-- string_to_array on '/' minus the final element, so 'ws/incident/photo.jpg' yields
-- {ws, incident} and satisfies cardinality(...) = 2.
create schema if not exists storage;
-- Migration 138 seeds the private incident-photos bucket row and adds the SELECT
-- policy; 139 replaces the insert/delete ones. Both blocks are armed by the schema
-- existing, so buckets must be modelled too.
create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text,
  name text,
  owner_id text,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable
as $fn$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$fn$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
grant usage on schema public to anon, authenticated, service_role;
-- Real Supabase grants usage on the auth schema to these roles, and its helpers are
-- callable directly from RLS policy expressions. Without this, any policy that
-- evaluates auth.uid() OUTSIDE a security-definer function raises "permission denied
-- for schema auth" — which is SQLSTATE 42501, the very code the deny-cases assert, so
-- a case could pass for entirely the wrong reason (GV-393).
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

function log(msg) { process.stdout.write(`${msg}\n`); }
function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}
function cleanup() { spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); }
function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  cleanup();
  process.exit(1);
}

// Run a SQL string through psql inside the container. Returns {status, stdout, stderr}.
function psql(sql, extraArgs = []) {
  return spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", DB, ...extraArgs],
    { encoding: "utf8", input: sql, maxBuffer: 64 * 1024 * 1024 },
  );
}

// ── 1. Container ─────────────────────────────────────────────────────────────
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  fail("Docker is not available (daemon not running?). This check needs Docker to host disposable Postgres.");
}
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

log(`⏳ Starting ${IMAGE} as ${CONTAINER}…`);
docker(["run", "-d", "--name", CONTAINER, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-v", `${REPO}:/work:ro`, IMAGE]);

let ready = false;
for (let i = 0; i < 60; i++) {
  const res = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
  if (res.status === 0) { ready = true; break; }
  execFileSync("sleep", ["1"]);
}
if (!ready) fail("Postgres did not become ready within 60s.");
execFileSync("sleep", ["2"]); // settle across the bootstrap restart

// ── 2. Database + prelude + schema ───────────────────────────────────────────
{
  const c = spawnSync("docker", ["exec", CONTAINER, "createdb", "-U", "postgres", DB], { encoding: "utf8" });
  if (c.status !== 0) fail(`createdb failed:\n${c.stderr}`);
}
{
  const r = psql(PRELUDE);
  if (r.status !== 0) fail(`Prelude failed:\n${r.stderr}`);
}
log("✅ Prelude applied (roles + BYPASSRLS service_role, auth.jwt(), default privileges).");
{
  const r = psql("", ["-f", "/work/supabase-schema.sql"]);
  if (r.status !== 0) fail(`Consolidated schema replay failed:\n${r.stderr}`);
}
log("✅ Replayed supabase-schema.sql.");

// ── 3. Fixture (committed) ───────────────────────────────────────────────────
// Fixed member ids so the generated case SQL can reference them as literals.
const ID = {
  B: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  C: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  D: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  G: "99999999-9999-9999-9999-999999999999",
};
const WS1 = "rolematrix-one";
const WS2 = "rolematrix-two";
const EMAIL = {
  A: "a@rolematrix.test",
  B: "b@rolematrix.test",
  C: "c@rolematrix.test",
  D: "d@rolematrix.test",
  G: "g@rolematrix.test",
  E: "e@rolematrix.test",
};
const claimsAuth = (email) =>
  `{"sub":"00000000-0000-0000-0000-0000000000${email.charCodeAt(0).toString(16)}","email":"${email}","role":"authenticated"}`;

const SEED = `
-- Workspace 1 created by A (real onboarding RPC → A is the sole admin).
select set_config('request.jwt.claims', '${claimsAuth(EMAIL.A)}', false);
set role authenticated;
select public.create_private_ledger_workspace('Rolematrix One', '${WS1}');
reset role;

-- A second, unrelated workspace created by E (isolation boundary for RLS tests).
select set_config('request.jwt.claims', '${claimsAuth(EMAIL.E)}', false);
set role authenticated;
select public.create_private_ledger_workspace('Rolematrix Two', '${WS2}');
reset role;

-- Members B (debtor), C (bystander), G (second admin), D (INACTIVE) added as the
-- service role, as the spec allows.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set role service_role;
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${ID.B}', '${WS1}', 'Bo',    '${EMAIL.B}', 'member', true),
  ('${ID.C}', '${WS1}', 'Cille', '${EMAIL.C}', 'member', true),
  ('${ID.G}', '${WS1}', 'Gitte', '${EMAIL.G}', 'admin',  true),
  ('${ID.D}', '${WS1}', 'Dan',   '${EMAIL.D}', 'member', false);
reset role;
select set_config('request.jwt.claims', '', false);

-- A trip driven by B (100 km) + a 300 kr fuel log paid by A, in ws1's open
-- period → calculate_period_settlement makes B owe A 300 kr (single clean pair).
insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, note, created_by_member_id)
values (
  '11111111-2222-3333-4444-555555555555', '${WS1}',
  (select id from public.settlement_periods where ledger_id = '${WS1}' and status = 'open' limit 1),
  '${ID.B}', current_date, 1000, 1100, 'Base tur', '${ID.B}');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount, station_name, created_by_member_id)
values (
  '22222222-3333-4444-5555-666666666666', '${WS1}',
  (select id from public.settlement_periods where ledger_id = '${WS1}' and status = 'open' limit 1),
  (select id from public.ledger_members where ledger_id = '${WS1}' and email = '${EMAIL.A}'),
  current_date, 300.00, 'Circle K Aarhus N',
  (select id from public.ledger_members where ledger_id = '${WS1}' and email = '${EMAIL.A}'));
`;
{
  const r = psql(SEED);
  if (r.status !== 0) fail(`Fixture seed failed:\n${r.stderr}`);
}

// Fetch the RPC-generated ids (A member, E member, both open periods).
const idRes = psql(
  `select
     (select id from public.ledger_members where ledger_id = '${WS1}' and email = '${EMAIL.A}'),
     (select id from public.ledger_members where ledger_id = '${WS2}' and email = '${EMAIL.E}'),
     (select id from public.settlement_periods where ledger_id = '${WS1}' and status = 'open' limit 1),
     (select id from public.settlement_periods where ledger_id = '${WS2}' and status = 'open' limit 1);`,
  ["-tA", "-F", "\t"],
);
if (idRes.status !== 0) fail(`Fixture id fetch failed:\n${idRes.stderr}`);
const [A_ID, E_ID, P1, P2] = idRes.stdout.trim().split("\t");
if (!A_ID || !E_ID || !P1 || !P2) fail(`Could not resolve fixture ids: got "${idRes.stdout.trim()}"`);
ID.A = A_ID;
ID.E = E_ID;
log(`✅ Fixture built (ws1=${WS1} p1=${P1.slice(0, 8)}…, ws2=${WS2} p2=${P2.slice(0, 8)}…; B owes A 300).`);

// ── 4. Actors ────────────────────────────────────────────────────────────────
const A = { label: "A (admin+creditor)", role: "authenticated", claims: claimsAuth(EMAIL.A) };
const B = { label: "B (debtor)", role: "authenticated", claims: claimsAuth(EMAIL.B) };
const C = { label: "C (bystander)", role: "authenticated", claims: claimsAuth(EMAIL.C) };
const G = { label: "G (2nd admin)", role: "authenticated", claims: claimsAuth(EMAIL.G) };
const E = { label: "E (other workspace)", role: "authenticated", claims: claimsAuth(EMAIL.E) };
const D = { label: "D (inactive member)", role: "authenticated", claims: claimsAuth(EMAIL.D) };
const ANON = { label: "anon", role: "anon", claims: '{"role":"anon"}' };
const SERVICE = { label: "service_role", role: "service_role", claims: '{"role":"service_role"}' };
const SUPER = { label: "postgres", role: null, claims: null }; // setup-only, RLS-bypassing

function step(actor, sql) { return { actor, sql }; }

// Snapshot that reconciles the fixture's server calculation (used by the close
// cases). Built dynamically from calculate_period_settlement so it stays correct
// if the fixture numbers ever change. B->A settlement = -(B's net) = 300.
const CLOSE_SNAPSHOT = `(
  select jsonb_build_object(
    'label', 'Role-matrix close',
    'entryFingerprint', public.calculate_period_entry_fingerprint('${WS1}', '${P1}'),
    'totalKm', s->'totalKm',
    'totalPaid', s->'totalPaid',
    'people', s->'people',
    'settlements', jsonb_build_array(
      jsonb_build_object('fromId', '${ID.B}', 'toId', '${A_ID}',
        'amount', round(-((select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.B}')), 2))
    )
  )
  from (select public.calculate_period_settlement('${WS1}', '${P1}') as s) q
)`;

// A helper op fragment: create the live B->A 'requested' row at 300 as A.
const CREATE_REQ_300 = `perform public.upsert_settlement_request_status('${WS1}', '${P1}', '${ID.B}', '${A_ID}', 300, 'DKK', 'requested');`;

// Migration 135: admin_soft_delete_workspace now requires both pre-decommission
// acknowledgements strictly true AND writes a durable owner_activity_log attestation
// on the path that performs a NEW soft-delete. Fixture steps that only need a
// workspace tombstoned decommission through this helper — both acks true plus an
// operator email so the attestation row is complete. (The idempotent alreadyApplied
// path and the permission-denied path deliberately need no acks, so a bare one-arg
// call is used where those paths are what is under test.)
const OP_EMAIL = "operator@rolematrix.test";
const SOFT_DELETE_WS1 = `perform public.admin_soft_delete_workspace('${WS1}', true, true, '${OP_EMAIL}');`;

// GVM-396 vehicle-incident helpers. B logs one incident into ws1; later steps
// resolve it via the workspace's newest incident id (each case is isolated, so
// there is exactly one). The event_title arg makes the create write a feed event.
const LOG_INCIDENT_B = `perform public.log_vehicle_incident('${WS1}', current_date, 'Ridse i lak', 'Ridse ved parkering', null, null, null, null, 'open', null, 'new_incident', 'Skade logget', 'Bo loggede en skade');`;
const LATEST_WS1_INCIDENT = `(select id from public.vehicle_incidents where ledger_id = '${WS1}' order by created_at desc, id desc limit 1)`;

// GVM-537 fuel-receipt helpers (migration 169). FP1 is the fixture's own 300 kr fuel
// log in ws1's OPEN period; the paths follow the convention the RPC enforces,
// <ledger_id>/<fuel_payment_id>/<file>.
const FP1 = "22222222-3333-4444-5555-666666666666";
const RECEIPT_PATH = `${WS1}/${FP1}/kvittering.jpg`;
const RECEIPT_PATH_2 = `${WS1}/${FP1}/kvittering-2.jpg`;
const ATTACH_RECEIPT_B = `perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH}');`;
const WS1_RECEIPT_ID = `(select id from public.fuel_payment_receipts where ledger_id = '${WS1}' order by created_at desc, id desc limit 1)`;

// A CLOSED period in ws1 carrying its own fuel log + receipt — the fixture the
// retention cases below vary the payment state around. Seeded as postgres (setup
// only, RLS bypassed); the closed-period entry lock stands aside for the fuel-log
// insert through the same transaction-local govehlo.pii_scrub flag the retention
// sweep itself uses, exactly as the repair row in the existing retention case does.
const CLOSED_PERIOD = "16900000-0000-0000-0000-000000000001";
const CLOSED_FUEL = "16900000-0000-0000-0000-000000000002";
const CLOSED_REQUEST = "16900000-0000-0000-0000-000000000003";
const CLOSED_RECEIPT_PATH = `${WS1}/${CLOSED_FUEL}/kvittering.jpg`;
const SEED_CLOSED_PERIOD_RECEIPT = `
  insert into public.settlement_periods (id, ledger_id, status, label, opened_at, closed_at)
  values ('${CLOSED_PERIOD}', '${WS1}', 'closed', 'Kvitteringsperiode', now() - interval '40 days', now() - interval '10 days');
  perform set_config('govehlo.pii_scrub', '1', true);
  insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount, created_by_member_id)
  values ('${CLOSED_FUEL}', '${WS1}', '${CLOSED_PERIOD}', '${ID.B}', current_date - 20, 250.00, '${ID.B}');
  perform set_config('govehlo.pii_scrub', '', true);
  insert into public.fuel_payment_receipts (fuel_payment_id, ledger_id, storage_path, uploader_member_id)
  values ('${CLOSED_FUEL}', '${WS1}', '${CLOSED_RECEIPT_PATH}', '${ID.B}');`;
// A receipt on the fixture's OPEN-period fuel log, seeded alongside the closed one so
// every retention case proves SELECTIVITY inside a single sweep, not just a count.
const SEED_OPEN_PERIOD_RECEIPT = `
  insert into public.fuel_payment_receipts (fuel_payment_id, ledger_id, storage_path, uploader_member_id)
  values ('${FP1}', '${WS1}', '${RECEIPT_PATH}', '${ID.B}');`;
// B->A obligation inside the closed period. Requests can only be INSERTed as
// 'requested' (migration 090 refuses a fresh paid/paid_pending row), so anything
// further is reached by transitioning it — the same path production takes.
const seedClosedRequest = (status) => `
  insert into public.settlement_requests (id, ledger_id, period_id, from_member_id, to_member_id, amount, currency, status, requested_by_member_id)
  values ('${CLOSED_REQUEST}', '${WS1}', '${CLOSED_PERIOD}', '${ID.B}', '${ID.A}', 250.00, 'DKK', 'requested', '${ID.A}');${
    status === "requested"
      ? ""
      : `
  update public.settlement_requests set status = '${status}' where id = '${CLOSED_REQUEST}';`
  }`;

// GVM-529 vehicle-handover helpers (migration 164). Two bookings in ws1 — one held by
// B (the normal writer) and one held by the INACTIVE member D — inserted as the
// service role, because this suite's fixture has no bookings of its own and routing
// them through upsert_car_booking would drag migration 159/162's caps into a failure
// message that is not about handovers. Windows are anchored to 09:00–13:00 UTC on a
// whole day rather than to `now() + N hours`: PR #224's lesson is that the latter
// crosses Copenhagen midnight on any evening run.
const HANDOVER_BOOKING_B = "55555555-0000-0000-0000-000000000001";
const HANDOVER_BOOKING_D = "55555555-0000-0000-0000-000000000002";
// D is INACTIVE in the fixture and migration 103's enforce_identity_reassignment
// refuses to insert a booking for an inactive member, so D is reactivated for the
// length of that one INSERT and deactivated again — which models the real history
// (you book while you are in the group, then you leave) rather than a state the
// product cannot reach. The whole setup rolls back with the case.
// PAST days since migration 191 (GVM-561): a handover on a booking that has not
// started is refused with 22023, so a fixture booking that goes through the RPC
// must already have begun.
const SEED_HANDOVER_BOOKINGS = `insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id) values
  ('${HANDOVER_BOOKING_B}', '${WS1}', '${ID.B}',
   date_trunc('day', now()) - interval '1 day' + interval '9 hour',
   date_trunc('day', now()) - interval '1 day' + interval '13 hour', '${ID.B}');
update public.ledger_members set is_active = true where id = '${ID.D}';
insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id) values
  ('${HANDOVER_BOOKING_D}', '${WS1}', '${ID.D}',
   date_trunc('day', now()) - interval '2 day' + interval '9 hour',
   date_trunc('day', now()) - interval '2 day' + interval '13 hour', '${ID.B}');
update public.ledger_members set is_active = false where id = '${ID.D}';`;
// B hands the car over. The event_title arg makes the CREATE write a feed event.
//
// NAMED arguments throughout, for migration 170's reason (GVM-540): the two pin
// parameters were inserted BEFORE the trailing event pair, so a positional call that
// carries an event title would silently hand it to parking_lat. Named notation is also
// what govehlo-mobile posts, so these read like the real requests.
const SAVE_HANDOVER_B = `perform public.upsert_booking_handover(
  target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
  end_odometer_value => 82345, fuel_fraction_value => 0.5,
  parking_location_value => 'P-kaelder niveau 2, plads 14',
  key_location_value => 'Noegler i postkassen',
  condition_ok_value => true, condition_note_value => null,
  note_to_next_value => 'Husk at tanke', keys_confirmed_value => true,
  parking_lat_value => null, parking_lng_value => null,
  event_title => 'Bo har afleveret bilen', event_body => 'Parkeret i P-kaelderen');`;
const HANDOVER_TOKEN_B = `(select bh.updated_at from public.booking_handovers bh where bh.booking_id = '${HANDOVER_BOOKING_B}')`;
// A handover that says nothing about where the car or the keys were left — the shape
// the mirror's null-preserving rule exists for (migration 167). Same booking as
// SAVE_HANDOVER_B, so the two cannot be used in one case without colliding on the
// unique key, which is exactly what the mirroring cases want.
const SAVE_HANDOVER_B_NO_LOCATION = `perform public.upsert_booking_handover(
  target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
  end_odometer_value => 82345, fuel_fraction_value => 0.5,
  parking_location_value => null, key_location_value => null,
  condition_ok_value => true, condition_note_value => null,
  note_to_next_value => 'Husk at tanke', keys_confirmed_value => true,
  parking_lat_value => null, parking_lng_value => null,
  event_title => null, event_body => null, expected_updated_at => null);`;

// GVM-520 vehicle-location helpers (migration 167). The car's CURRENT parking and key
// placement live on the ledgers row; set_vehicle_location is the standalone writer and
// upsert_booking_handover mirrors into the same two columns.
//
// NAMED arguments throughout, since migration 168 (GVM-536) inserted the two pin
// parameters BEFORE the trailing event pair: a positional call would silently hand the
// event title to parking_lat. Named notation is also what both clients post, so these
// read like the real requests.
const SET_LOCATION_B = `perform public.set_vehicle_location(
  target_ledger_id => '${WS1}',
  parking_location_value => 'P-plads bag Netto, plads 12',
  key_location_value => 'Noegler hos Bo, 2. sal',
  parking_lat_value => null, parking_lng_value => null,
  event_title => 'Bo flyttede bilen', event_body => 'Den staar bag Netto nu');`;
const SET_LOCATION_C = `perform public.set_vehicle_location(
  target_ledger_id => '${WS1}',
  parking_location_value => 'Gaden foran nr. 14',
  key_location_value => 'Noegler i postkassen hos Cille',
  parking_lat_value => null, parking_lng_value => null,
  event_title => null, event_body => null);`;
// GVM-536: the same save WITH a pin. Copenhagen, four decimals — the precision a phone
// actually reports for a parked car. Cases that need an existing pin to be cleared use
// this as their setup.
const PIN_LAT = "55.6761";
const PIN_LNG = "12.5683";
const SET_LOCATION_B_WITH_PIN = `perform public.set_vehicle_location(
  target_ledger_id => '${WS1}',
  parking_location_value => 'P-plads bag Netto, plads 12',
  key_location_value => 'Noegler hos Bo, 2. sal',
  parking_lat_value => ${PIN_LAT}, parking_lng_value => ${PIN_LNG},
  event_title => 'Bo satte en naal', event_body => 'Den staar bag Netto nu');`;
// GVM-540 (migration 170): the handover sheet can now carry a pin of its own, so the
// driver standing at the car drops one on the form they are already filling in. Same
// booking as SAVE_HANDOVER_B — one handover per booking — and the same Copenhagen
// coordinates, so a case can assert the pin the handover wrote against the same pair
// set_vehicle_location writes.
const SAVE_HANDOVER_B_WITH_PIN = `perform public.upsert_booking_handover(
  target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
  end_odometer_value => 82345, fuel_fraction_value => 0.5,
  parking_location_value => 'P-kaelder niveau 2, plads 14',
  key_location_value => 'Noegler i postkassen',
  condition_ok_value => true, condition_note_value => null,
  note_to_next_value => 'Husk at tanke', keys_confirmed_value => true,
  parking_lat_value => ${PIN_LAT}, parking_lng_value => ${PIN_LNG},
  event_title => 'Bo har afleveret bilen', event_body => 'Parkeret i P-kaelderen');`;
// EXACTLY the body govehlo-mobile's shipped handover call sends: the thirteen named keys
// that existed before migration 170, and no mention of the pin. PostgREST resolves it
// against the fifteen-argument signature through the two defaults.
const SAVE_HANDOVER_B_OLD_SIGNATURE = `perform public.upsert_booking_handover(
  target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
  end_odometer_value => 82345, fuel_fraction_value => 0.5,
  parking_location_value => 'Gammel klient flyttede bilen',
  key_location_value => 'Noegler i postkassen',
  condition_ok_value => true, condition_note_value => null,
  note_to_next_value => 'Husk at tanke', keys_confirmed_value => true,
  event_title => 'Bo har afleveret bilen', event_body => 'Parkeret i P-kaelderen',
  expected_updated_at => null);`;
// Reading the two columns and the two stamps back, as one string, so a CASEFAIL says
// what the row actually holds instead of just "not what was expected".
const WS1_LOCATION = `(select coalesce(l.parking_location, 'NULL') || ' / ' || coalesce(l.key_location, 'NULL')
  from public.ledgers l where l.id = '${WS1}')`;
const WS1_LOCATION_AUTHOR = `(select coalesce(l.location_updated_by_member_id::text, 'NULL')
  from public.ledgers l where l.id = '${WS1}')`;
const WS1_PIN = `(select coalesce(l.parking_lat::text, 'NULL') || ' / ' || coalesce(l.parking_lng::text, 'NULL')
  from public.ledgers l where l.id = '${WS1}')`;
// GV-475 (migration 195). The odometer mirror migration 193 keeps on the ledgers row,
// read back as text so a CASEFAIL can print NULL rather than say nothing.
const WS1_ODOMETER_MIRROR = `(select coalesce(l.max_handover_odometer::text, 'NULL')
  from public.ledgers l where l.id = '${WS1}')`;
// The fat finger, and the correction. B hands the car over at 82345 (SAVE_HANDOVER_B),
// then edits the SAME handover down — always allowed, migration 195 caps only upward
// moves — and 193's mirror is monotone by design, so the ledgers row keeps 82345 while
// the surviving handover says 8234. That gap is precisely what
// recompute_handover_mirror exists to close, and it is the state every case below
// starts from.
const EDIT_HANDOVER_B_DOWN = `perform public.upsert_booking_handover(
  target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
  end_odometer_value => 8234, fuel_fraction_value => 0.25,
  parking_location_value => 'P-kaelder niveau 2, plads 14',
  key_location_value => 'Noegler i postkassen',
  condition_ok_value => true, condition_note_value => null,
  note_to_next_value => 'Rettet: et ciffer for meget', keys_confirmed_value => true,
  parking_lat_value => null, parking_lng_value => null,
  event_title => null, event_body => null, expected_updated_at => null);`;
const POISONED_MIRROR = [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B), step(B, EDIT_HANDOVER_B_DOWN)];

// Push devices for the migration-150 target RPCs (GV-398). Deliberately shaped to
// carry the two arguments those functions exist for: one owner with TWO devices (so
// pruning by owner instead of by token would take the live one down with the dead
// one), and an address stored with capitals (upsert_push_token writes
// current_user_email() verbatim, and the old lower-cased in.() URL filter never
// matched it). expo_push_tokens is not workspace-scoped, so these rows stand alone.
const SEED_PUSH_TOKENS = `insert into public.expo_push_tokens (user_id, email, token, platform) values
  ('99999999-0000-0000-0000-000000000001', 'Lars@Test.dk', 'ExponentPushToken[phone]', 'ios'),
  ('99999999-0000-0000-0000-000000000001', 'Lars@Test.dk', 'ExponentPushToken[tablet]', 'ios'),
  ('99999999-0000-0000-0000-000000000002', 'mette@test.dk', 'ExponentPushToken[dead]', 'android');`;

// ── 5. SQL generation ────────────────────────────────────────────────────────
function impersonate(actor) {
  // Sets JWT claims (session-level; discarded on the case's rollback) — role is
  // set locally right before the operation so a thrown op auto-reverts it.
  if (actor.role === null) return `select set_config('request.jwt.claims', '', false);`;
  return `select set_config('request.jwt.claims', ${actor.claims === "" ? "''" : `'${actor.claims}'`}, false);`;
}
function setupBlock(setup) {
  if (!setup || setup.length === 0) return "";
  // Each setup step runs inside its own DO block so that `perform <rpc>()` is
  // valid (it is not a top-level SQL statement) and `set local role` works
  // (we are inside the case transaction). SUPER steps run as postgres (RLS
  // bypassed); role is reset after every step.
  return setup
    .map((s) => {
      const claims = s.actor.role === null ? "''" : `'${s.actor.claims}'`;
      const roleLine = s.actor.role === null ? "reset role;" : `set local role ${s.actor.role};`;
      return `do $SETUP$
begin
  perform set_config('request.jwt.claims', ${claims}, true);
  ${roleLine}
  ${s.sql}
end
$SETUP$;
reset role;`;
    })
    .join("\n");
}

// Double single quotes so a desc containing an apostrophe ("A/B's request")
// stays a valid SQL string literal inside the generated raise messages.
const esc = (s) => String(s).replace(/'/g, "''");

function rpcCase({ name, desc, setup, actor, op, expect, post }) {
  const roleSet = actor.role === null ? "reset role;" : `set local role ${actor.role};`;
  const d = esc(desc);
  const verdict =
    expect === "ok"
      ? `if not v_ok then raise exception 'CASEFAIL ${name}: ${d} — expected success but got SQLSTATE % (%)', v_state, v_msg; end if;`
      : `if v_ok then raise exception 'CASEFAIL ${name}: ${d} — expected SQLSTATE ${expect} but the call SUCCEEDED'; end if;
         if v_state <> '${expect}' then raise exception 'CASEFAIL ${name}: ${d} — expected SQLSTATE ${expect} but got % (%)', v_state, v_msg; end if;`;
  return {
    name,
    desc,
    sql: `begin;
${setupBlock(setup)}
${impersonate(actor)}
do $CASE$
declare v_ok boolean; v_state text; v_msg text;
begin
  begin
    ${roleSet}
    ${op}
    v_ok := true;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    v_ok := false;
  end;
  reset role;
  ${verdict}
  ${post || ""}
  raise notice 'CASEOK ${name}';
end
$CASE$;
rollback;`,
  };
}

function queryCase({ name, desc, setup, actor, assert }) {
  const roleSet = actor.role === null ? "reset role;" : `set local role ${actor.role};`;
  return {
    name,
    desc,
    sql: `begin;
${setupBlock(setup)}
${impersonate(actor)}
do $CASE$
begin
  ${roleSet}
  ${assert};
  reset role;
  raise notice 'CASEOK ${name}';
end
$CASE$;
rollback;`,
  };
}

// ── 6. The matrix ────────────────────────────────────────────────────────────
const upsert = (ledger, period, payer, recip, amount, status, extra = "") =>
  `perform public.upsert_settlement_request_status('${ledger}', '${period}', '${payer}', '${recip}', ${amount}, 'DKK', '${status}'${extra});`;

// Assert (as postgres, RLS bypassed) that the live B->A row is still 'requested'.
const ASSERT_BA_REQUESTED = `if (select status from public.settlement_requests
      where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is distinct from 'requested'
    then raise exception 'CASEFAIL: the B->A request was altered (expected still requested)'; end if;`;

// A due paid_pending B->A claim aged `ageHours` past its paid_claimed_at, for the
// migration-118 confirm-receipt reminder cases. A requests, B marks paid_pending, then
// SUPER ages paid_claimed_at (a same-status update never fires the 090 role gates, and
// the 117 amount trigger returns early for a non-'requested' row — same technique the
// paidpending-never-auto-confirms fixture already uses).
const SETUP_DUE_PP = (ageHours) => [
  step(A, CREATE_REQ_300),
  step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
  step(SUPER, `update public.settlement_requests
    set paid_claimed_at = now() - interval '${ageHours} hours'
    where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
];
// Count how many rows the confirm-reminder claim RPC returns for the B->A request.
const CLAIM_CONFIRM_BA_COUNT = `select count(*) into rows from public.claim_due_confirm_reminders(200)
    where request_id = (select id from public.settlement_requests
      where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}')`;

const CASES = [
  // ── Owner-only settlement integrity batch (migration 127) ─────────────────
  rpcCase({
    name: "owner-integrity-batch-service-role",
    desc: "service role can run the bounded cross-workspace integrity batch",
    actor: SERVICE,
    op: "perform public.owner_settlement_integrity_batch(200);",
    expect: "ok",
  }),
  rpcCase({
    name: "owner-integrity-batch-member-blocked",
    desc: "an authenticated workspace admin cannot invoke the owner integrity batch",
    actor: A,
    op: "perform public.owner_settlement_integrity_batch(200);",
    expect: "42501",
  }),
  rpcCase({
    name: "owner-integrity-batch-limit-validated",
    desc: "the owner integrity batch rejects unbounded requests",
    actor: SERVICE,
    op: "perform public.owner_settlement_integrity_batch(501);",
    expect: "22023",
  }),

  // ── Set-based owner workspace overview (migration 129) ───────────────────
  queryCase({
    name: "owner-workspace-overview-service-role",
    desc: "service role receives an exact, bounded workspace overview page",
    actor: SERVICE,
    assert: `if (public.owner_workspace_overview_page(1, 0)->>'totalWorkspaces')::integer <>
        (select count(*)::integer from public.ledgers) then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: totalWorkspaces mismatch';
    end if;
    if jsonb_array_length(public.owner_workspace_overview_page(1, 0)->'workspaces') <> 1 then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: page was not bounded';
    end if;
    if public.owner_workspace_overview_page(1, 0)->'workspaces'->0->>'id' is distinct from
        (select id from public.ledgers order by created_at asc, id asc limit 1) then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: first page id mismatch';
    end if;
    if (select (item->>'memberCount')::integer
        from jsonb_array_elements(public.owner_workspace_overview_page(200, 0)->'workspaces') item
        where item->>'id' = '${WS1}') <> 4 then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: active member count mismatch';
    end if;
    if (select (item->'health'->>'openPeriod')::boolean
        from jsonb_array_elements(public.owner_workspace_overview_page(200, 0)->'workspaces') item
        where item->>'id' = '${WS1}') is distinct from true then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: open-period health mismatch';
    end if;
    if public.owner_workspace_overview_page(1, 1)->'workspaces'->0->>'id' is distinct from
        (select id from public.ledgers order by created_at asc, id asc limit 1 offset 1) then
      raise exception 'CASEFAIL owner-workspace-overview-service-role: offset page id mismatch';
    end if`,
  }),
  rpcCase({
    name: "owner-workspace-overview-member-blocked",
    desc: "an authenticated workspace admin cannot invoke the cross-workspace overview",
    actor: A,
    op: "perform public.owner_workspace_overview_page(100, 0);",
    expect: "42501",
  }),
  rpcCase({
    name: "owner-workspace-overview-bounds-validated",
    desc: "the owner workspace overview rejects oversized pages and offsets",
    actor: SERVICE,
    op: "perform public.owner_workspace_overview_page(201, 0);",
    expect: "22023",
  }),

  // ── Operational retention cleanup (migration 130) ─────────────────────────
  queryCase({
    name: "operational-retention-service-role-dry-run",
    desc: "service role receives a dry-run retention summary with the expected keys",
    actor: SERVICE,
    assert: `if not (public.run_operational_retention(180, true) ?& array[
        'staleExpoPushTokens', 'expiredLedgerEvents', 'deletedMessages',
        'deletedBookings', 'deletedRecurringTemplates', 'deletedTrips',
        'deletedFuelPayments', 'deletedWorkspaceExpenses', 'deletedVehicleRepairs',
        'deletedOwnerActivity', 'dryRun', 'staleDays', 'shortRetentionDays',
        'financialRetentionYears', 'auditRetentionMonths', 'ranAt'
      ]) then
      raise exception 'CASEFAIL operational-retention-service-role-dry-run: summary is missing expected keys';
    end if;
    if (public.run_operational_retention(180, true)->>'dryRun')::boolean is distinct from true then
      raise exception 'CASEFAIL operational-retention-service-role-dry-run: dryRun flag not true';
    end if`,
  }),
  rpcCase({
    name: "operational-retention-member-blocked",
    desc: "an authenticated workspace admin cannot invoke the operational retention job",
    actor: A,
    op: "perform public.run_operational_retention(180, true);",
    expect: "42501",
  }),
  rpcCase({
    name: "operational-retention-bounds-validated",
    desc: "the operational retention job rejects an out-of-range stale-days window",
    actor: SERVICE,
    op: "perform public.run_operational_retention(10, false);",
    expect: "22023",
  }),
  queryCase({
    name: "operational-retention-purges-approved-classes",
    desc: "service role purges expired short-lived, financial-tombstone and owner-audit rows",
    setup: [
      step(SUPER, `insert into public.messages
          (id, ledger_id, sender_member_id, body, created_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000001', '${WS1}', '${ID.B}', 'expired message', now() - interval '100 days', now() - interval '91 days');
        insert into public.messages
          (id, ledger_id, sender_member_id, body, created_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000010', '${WS1}', '${ID.B}', 'recently deleted message', now() - interval '89 days', now() - interval '89 days');
        insert into public.car_bookings
          (id, ledger_id, member_id, start_at, end_at, purpose, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000002', '${WS1}', '${ID.B}', now() - interval '200 days', now() - interval '199 days', 'expired booking', '${ID.B}', now() - interval '200 days', now() - interval '91 days', now() - interval '91 days');
        insert into public.recurring_expenses
          (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000003', '${WS1}', 'other', 'expired template', 100, 'monthly', current_date, '${ID.B}', now() - interval '200 days', now() - interval '91 days', now() - interval '91 days');
        insert into public.trips
          (id, ledger_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000004', '${WS1}', '${ID.B}', date '2018-01-01', 1, 2, '${ID.B}', timestamptz '2018-01-01', timestamptz '2018-01-01', timestamptz '2018-01-02');
        insert into public.trips
          (id, ledger_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000011', '${WS1}', '${ID.B}', current_date - 1, 3, 4, '${ID.B}', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day');
        insert into public.fuel_payments
          (id, ledger_id, payer_member_id, payment_date, amount, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000005', '${WS1}', '${ID.B}', date '2018-01-01', 100, '${ID.B}', timestamptz '2018-01-01', timestamptz '2018-01-01', timestamptz '2018-01-02');
        insert into public.workspace_expenses
          (id, ledger_id, category, description, amount_dkk, expense_date, paid_by_member_id, created_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000006', '${WS1}', 'other', 'expired expense', 100, date '2018-01-01', '${ID.B}', '${ID.B}', timestamptz '2018-01-01', timestamptz '2018-01-01', timestamptz '2018-01-02');
        insert into public.settlement_periods
          (id, ledger_id, status, label, opened_at, closed_at, created_at, updated_at)
        values ('13100000-0000-0000-0000-000000000009', '${WS1}', 'closed', 'expired repair period', timestamptz '2017-01-01', timestamptz '2019-01-01', timestamptz '2017-01-01', timestamptz '2019-01-01');
        perform set_config('govehlo.pii_scrub', '1', true);
        insert into public.vehicle_repairs
          (id, ledger_id, period_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id, created_at, updated_at, deleted_at)
        values ('13100000-0000-0000-0000-000000000007', '${WS1}', '13100000-0000-0000-0000-000000000009', date '2018-01-01', 'expired repair', 100, '${ID.B}', '${ID.B}', timestamptz '2018-01-01', timestamptz '2018-01-01', timestamptz '2018-01-02');
        perform set_config('govehlo.pii_scrub', '', true);
        insert into public.owner_activity_log
          (id, created_at, ledger_id, actor_role, route, action, result_code, status_code, ok, summary)
        values ('13100000-0000-0000-0000-000000000008', now() - interval '25 months', '${WS1}', 'owner', '/test', 'retention_test', 'ok', 200, true, 'expired audit');`),
    ],
    actor: SERVICE,
    assert: `declare result jsonb;
begin
  result := public.run_operational_retention(180, false);
  if exists (
    select 1 from public.messages where id = '13100000-0000-0000-0000-000000000001'
    union all select 1 from public.car_bookings where id = '13100000-0000-0000-0000-000000000002'
    union all select 1 from public.recurring_expenses where id = '13100000-0000-0000-0000-000000000003'
    union all select 1 from public.trips where id = '13100000-0000-0000-0000-000000000004'
    union all select 1 from public.fuel_payments where id = '13100000-0000-0000-0000-000000000005'
    union all select 1 from public.workspace_expenses where id = '13100000-0000-0000-0000-000000000006'
    union all select 1 from public.vehicle_repairs where id = '13100000-0000-0000-0000-000000000007'
    union all select 1 from public.owner_activity_log where id = '13100000-0000-0000-0000-000000000008'
  ) then
    raise exception 'CASEFAIL operational-retention-purges-approved-classes: one or more expired rows survived';
  end if;
  if not exists (select 1 from public.messages where id = '13100000-0000-0000-0000-000000000010')
     or not exists (select 1 from public.trips where id = '13100000-0000-0000-0000-000000000011') then
    raise exception 'CASEFAIL operational-retention-purges-approved-classes: an in-window tombstone was deleted';
  end if;
  if (result->>'deletedMessages')::integer <> 1
     or (result->>'deletedBookings')::integer <> 1
     or (result->>'deletedRecurringTemplates')::integer <> 1
     or (result->>'deletedTrips')::integer <> 1
     or (result->>'deletedFuelPayments')::integer <> 1
     or (result->>'deletedWorkspaceExpenses')::integer <> 1
     or (result->>'deletedVehicleRepairs')::integer <> 1
     or (result->>'deletedOwnerActivity')::integer <> 1 then
    raise exception 'CASEFAIL operational-retention-purges-approved-classes: unexpected summary %', result;
  end if;
end`,
  }),

  // ── 1. upsert_settlement_request_status ────────────────────────────────────
  rpcCase({
    name: "upsert-creditor-creates",
    desc: "creditor A creates the B->A request",
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested"),
    expect: "ok",
    post: `if not exists (select 1 from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}' and status = 'requested')
      then raise exception 'CASEFAIL upsert-creditor-creates: request row not created'; end if;`,
  }),
  rpcCase({
    name: "upsert-creditor-wrong-server-amount",
    desc: "creditor A cannot create B->A at an amount that differs from the server pair",
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 275, "requested"),
    expect: "23514",
  }),
  rpcCase({
    name: "upsert-debtor-paidpending-stored",
    desc: "debtor B -> paid_pending carrying the stored amount",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending"),
    expect: "ok",
  }),
  queryCase({
    name: "payment-lifecycle-request-claim-confirm",
    desc: "creditor requests, debtor claims paid, and creditor confirms the same stored amount",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    assert: `declare current_status text; current_amount numeric; claimed_at timestamptz; confirmed_at timestamptz; event_count integer;
begin
  perform public.upsert_settlement_request_status('${WS1}', '${P1}', '${ID.B}', '${A_ID}', 300, 'DKK', 'paid', array[]::text[]);
  select status, amount, paid_claimed_at, paid_at
    into current_status, current_amount, claimed_at, confirmed_at
  from public.settlement_requests
  where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  if current_status is distinct from 'paid' or current_amount is distinct from 300::numeric then
    raise exception 'CASEFAIL payment-lifecycle-request-claim-confirm: status=% amount=%', current_status, current_amount;
  end if;
  if claimed_at is null or confirmed_at is null then
    raise exception 'CASEFAIL payment-lifecycle-request-claim-confirm: claimed_at=% paid_at=%', claimed_at, confirmed_at;
  end if;
  select count(*) into event_count
  from public.ledger_events
  where ledger_id = '${WS1}' and event_type in ('payment_requested', 'payment_claimed', 'payment_paid');
  if event_count <> 3 then
    raise exception 'CASEFAIL payment-lifecycle-request-claim-confirm: lifecycle events=% (expected 3)', event_count;
  end if;
end`,
  }),
  rpcCase({
    name: "payment-lifecycle-debtor-cannot-confirm",
    desc: "debtor cannot confirm their own paid_pending claim",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid"),
    expect: "42501",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300)
      then raise exception 'CASEFAIL payment-lifecycle-debtor-cannot-confirm: claim changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "payment-lifecycle-confirm-amount-locked",
    desc: "creditor cannot confirm paid_pending with a changed amount",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 275, "paid"),
    expect: "23514",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300)
      then raise exception 'CASEFAIL payment-lifecycle-confirm-amount-locked: claim changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "upsert-debtor-paidpending-diff-amount",
    desc: "debtor B -> paid_pending with a DIFFERENT amount (GV-259 amount lock)",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 250, "paid_pending"),
    expect: "23514",
  }),
  rpcCase({
    name: "upsert-recipient-dispute-diff-amount",
    desc: "recipient A cannot rewrite the amount while disputing a paid_pending claim",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 275, "requested"),
    expect: "23514",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300)
      then raise exception 'CASEFAIL upsert-recipient-dispute-diff-amount: claim changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "upsert-recipient-rerequest-amount",
    desc: "recipient A cannot re-request a live request at a non-server amount",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 275, "requested"),
    expect: "23514",
    post: `if (select amount from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') <> 300
      then raise exception 'CASEFAIL upsert-recipient-rerequest-amount: stored amount changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "upsert-bystander-transition",
    desc: "bystander C transitions A/B's request (GV-244 party-or-admin gate)",
    setup: [step(A, CREATE_REQ_300)],
    actor: C,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending"),
    expect: "42501",
  }),
  rpcCase({
    name: "upsert-bystander-empty-pairkeys-no-sweep",
    desc: "bystander C with empty current_pair_keys must NOT cancel A/B's request (GV-259)",
    setup: [step(A, CREATE_REQ_300)],
    actor: C,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested", ", array[]::text[]"),
    expect: "42501",
    post: ASSERT_BA_REQUESTED,
  }),
  rpcCase({
    name: "upsert-bogus-pairkeys-ignored",
    desc: "admin A re-requests passing a BOGUS current_pair_keys; server recomputes, B->A survives (GV-259)",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested", ", array['00000000-0000-0000-0000-000000000000->00000000-0000-0000-0000-000000000000']"),
    expect: "ok",
    post: ASSERT_BA_REQUESTED,
  }),
  rpcCase({
    name: "upsert-admin-acts",
    desc: "second admin G (non-party) transitions A/B's request",
    setup: [step(A, CREATE_REQ_300)],
    actor: G,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending"),
    expect: "ok",
  }),
  rpcCase({
    name: "upsert-anon-denied",
    desc: "anon calls upsert (denied)",
    actor: ANON,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested"),
    expect: "42501",
  }),
  rpcCase({
    name: "upsert-foreign-member-denied",
    desc: "member E of the other workspace acts on ws1's request (denied)",
    setup: [step(A, CREATE_REQ_300)],
    actor: E,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending"),
    expect: "42501",
  }),

  // ── 2. close_settlement_period ─────────────────────────────────────────────
  rpcCase({
    name: "close-with-matching-request",
    desc: "admin A closes with a matching-amount request present",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "ok",
    post: `if (select status from public.settlement_periods where id = '${P1}') <> 'closed'
      then raise exception 'CASEFAIL close-with-matching-request: period not closed'; end if;`,
  }),
  rpcCase({
    name: "close-blocked-amount-mismatch",
    desc: "close blocked when only a 0,01 kr request exists for a 300 kr settlement (GV-260)",
    setup: [
      step(A, CREATE_REQ_300),
      // Corrupt the fixture with triggers disabled to prove close still rejects
      // historical/bypassed bad data even though migration 117 prevents new rows.
      step(SUPER, `perform set_config('session_replication_role', 'replica', true);
        update public.settlement_requests set amount = 0.01
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
        perform set_config('session_replication_role', 'origin', true);`),
    ],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "42501",
  }),
  rpcCase({
    name: "close-rule-off-no-requests",
    desc: "close allowed without requests when rule_require_requests_before_close = false",
    setup: [step(SUPER, `update public.ledgers set rule_require_requests_before_close = false where id = '${WS1}';`)],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "ok",
  }),
  rpcCase({
    name: "close-nonadmin-denied",
    desc: "non-admin B closes (current gate: admin required)",
    actor: B,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', jsonb_build_object('label', 'x'));`,
    expect: "42501",
  }),
  rpcCase({
    name: "close-unlocked-implementation-not-callable",
    desc: "authenticated admins cannot bypass the locking wrapper",
    actor: A,
    op: `perform public.close_settlement_period_unlocked('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "42501",
  }),

  queryCase({
    name: "paidpending-never-auto-confirms",
    desc: "an old unreviewed payment claim remains paid_pending until the recipient confirms",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
      step(SUPER, `update public.settlement_requests
        set paid_claimed_at = now() - interval '7 days'
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: SERVICE,
    assert: `declare claimed integer; current_status text;
begin
  claimed := public.claim_due_settlement_confirmations(72, 200);
  select status into current_status from public.settlement_requests
    where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  if claimed <> 0 then
    raise exception 'CASEFAIL paidpending-never-auto-confirms: RPC returned % (expected 0)', claimed;
  end if;
  if current_status is distinct from 'paid_pending' then
    raise exception 'CASEFAIL paidpending-never-auto-confirms: status=% (expected paid_pending)', current_status;
  end if;
end`,
  }),

  // ── 3. enforce_identity_reassignment (trips / fuel / bookings) ──────────────
  rpcCase({
    name: "identity-insert-inactive-driver",
    desc: "insert a trip whose driver is INACTIVE member D",
    actor: A,
    op: `insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
         values ('${WS1}', '${P1}', '${ID.D}', current_date, 2000, 2100, '${A_ID}');`,
    expect: "23514",
  }),
  rpcCase({
    name: "identity-insert-inactive-payer",
    desc: "insert a fuel log whose payer is INACTIVE member D",
    actor: A,
    op: `insert into public.fuel_payments (ledger_id, period_id, payer_member_id, payment_date, amount, created_by_member_id)
         values ('${WS1}', '${P1}', '${ID.D}', current_date, 99.00, '${A_ID}');`,
    expect: "23514",
  }),
  rpcCase({
    name: "identity-insert-inactive-booking-member",
    desc: "insert a car booking whose member is INACTIVE member D",
    actor: A,
    op: `insert into public.car_bookings (ledger_id, member_id, start_at, end_at, created_by_member_id)
         values ('${WS1}', '${ID.D}', now() + interval '1 day', now() + interval '2 day', '${A_ID}');`,
    expect: "23514",
  }),
  rpcCase({
    name: "identity-creator-reassigns",
    desc: "creator B reassigns their trip's driver to active member C",
    setup: [step(SUPER, `insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
      values ('33333333-0000-0000-0000-000000000001', '${WS1}', '${P1}', '${ID.B}', current_date, 3000, 3100, '${ID.B}');`)],
    actor: B,
    op: `update public.trips set driver_member_id = '${ID.C}' where id = '33333333-0000-0000-0000-000000000001';`,
    expect: "ok",
  }),
  rpcCase({
    name: "identity-noncreator-reassigns-denied",
    desc: "driver-but-not-creator C reassigns an admin-created trip (passes RLS, denied by trigger)",
    setup: [step(SUPER, `insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
      values ('33333333-0000-0000-0000-000000000002', '${WS1}', '${P1}', '${ID.C}', current_date, 3200, 3300, '${A_ID}');`)],
    actor: C,
    op: `update public.trips set driver_member_id = '${ID.B}' where id = '33333333-0000-0000-0000-000000000002';`,
    expect: "42501",
  }),
  rpcCase({
    name: "identity-admin-reassigns",
    desc: "admin A reassigns another member's trip driver to active member C",
    setup: [step(SUPER, `insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
      values ('33333333-0000-0000-0000-000000000003', '${WS1}', '${P1}', '${ID.B}', current_date, 3400, 3500, '${ID.B}');`)],
    actor: A,
    op: `update public.trips set driver_member_id = '${ID.C}' where id = '33333333-0000-0000-0000-000000000003';`,
    expect: "ok",
  }),

  // ── 4. RLS read isolation ──────────────────────────────────────────────────
  queryCase({
    name: "rls-foreign-member-sees-nothing",
    desc: "E (other workspace) reads ws1 trips/requests/members -> zero rows",
    setup: [step(A, CREATE_REQ_300)],
    actor: E,
    assert: `declare n1 int; n2 int; n3 int;
begin
  select count(*) into n1 from public.trips where ledger_id = '${WS1}';
  select count(*) into n2 from public.settlement_requests where ledger_id = '${WS1}';
  select count(*) into n3 from public.ledger_members where ledger_id = '${WS1}';
  if n1 <> 0 or n2 <> 0 or n3 <> 0 then
    raise exception 'CASEFAIL rls-foreign-member-sees-nothing: E saw trips=% requests=% members=% (expected 0/0/0)', n1, n2, n3;
  end if;
end`,
  }),
  queryCase({
    name: "rls-member-sees-own-ledger",
    desc: "member B reads ws1 trips/requests/members -> rows visible",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    assert: `declare n1 int; n2 int; n3 int;
begin
  select count(*) into n1 from public.trips where ledger_id = '${WS1}';
  select count(*) into n2 from public.settlement_requests where ledger_id = '${WS1}';
  select count(*) into n3 from public.ledger_members where ledger_id = '${WS1}';
  if n1 < 1 or n2 < 1 or n3 < 1 then
    raise exception 'CASEFAIL rls-member-sees-own-ledger: B saw trips=% requests=% members=% (expected all >=1)', n1, n2, n3;
  end if;
end`,
  }),
  queryCase({
    name: "rls-anon-sees-nothing",
    desc: "anon reads ws1 trips -> nothing (zero rows or permission denied)",
    actor: ANON,
    assert: `declare n int;
begin
  begin
    select count(*) into n from public.trips where ledger_id = '${WS1}';
  exception when insufficient_privilege then n := 0;
  end;
  if n <> 0 then raise exception 'CASEFAIL rls-anon-sees-nothing: anon saw % trips (expected 0)', n; end if;
end`,
  }),

  // ── 5. Direct writes bypassing the RPCs (as authenticated) ─────────────────
  queryCase({
    name: "direct-foreign-pair-update-blocked",
    desc: "bystander C directly UPDATEs A/B's settlement_request -> RLS makes it a no-op",
    setup: [step(A, CREATE_REQ_300)],
    actor: C,
    assert: `declare n int; st text;
begin
  update public.settlement_requests set status = 'cancelled'
    where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  get diagnostics n = row_count;
  reset role;
  select status into st from public.settlement_requests
    where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  if n <> 0 or st is distinct from 'requested' then
    raise exception 'CASEFAIL direct-foreign-pair-update-blocked: rows=% status=% (expected 0 rows, still requested)', n, st;
  end if;
end`,
  }),
  rpcCase({
    name: "direct-foreign-ledger-insert-blocked",
    desc: "member B directly INSERTs a trip into foreign workspace ws2 -> RLS with-check rejects",
    actor: B,
    op: `insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
         values ('${WS2}', '${P2}', '${E_ID}', current_date, 10, 20, '${E_ID}');`,
    expect: "42501",
  }),

  // ── 6. Repairs split mode (GVM-307 / GV-268) ────────────────────────────────
  // These cases deactivate C and G for the duration of their own (rolled-back)
  // transaction so the fixture keeps yielding a single clean debtor->creditor
  // pair (only A and B remain active), matching the CLOSE_SNAPSHOT helper's
  // hardcoded B->A pair. calculate_period_settlement is called fresh inside
  // each case, so it always reflects that case's own setup.
  queryCase({
    name: "repairs-ligeligt-active-member-nets",
    desc: "ligeligt mode: a repair logged by active member B folds into calculate_period_settlement nets (GVM-307 fixture math)",
    setup: [
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
      step(B, `perform public.insert_repair('${WS1}', current_date, 'Ny kileem', 100.00, null, 'Bilxtra Aarhus');`),
    ],
    actor: A,
    assert: `declare s jsonb; a_net numeric; b_net numeric; total_repairs numeric;
begin
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  a_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${A_ID}');
  b_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.B}');
  total_repairs := (s->>'totalRepairs')::numeric;
  if a_net is distinct from 250 or b_net is distinct from -250 or total_repairs is distinct from 100 then
    raise exception 'CASEFAIL repairs-ligeligt-active-member-nets: A=% B=% totalRepairs=% (expected 250/-250/100 -- fuelPaid+repairPaid-tripCost-repairShare, repair 100 split 50/50 over A+B)', a_net, b_net, total_repairs;
  end if;
end`,
  }),
  rpcCase({
    name: "repairs-ligeligt-close-with-matching-request",
    desc: "admin A closes a ligeligt-repairs-inflated period with a matching 250 kr request (GVM-307/GV-268)",
    setup: [
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
      step(B, `perform public.insert_repair('${WS1}', current_date, 'Ny kileem', 100.00, null, 'Bilxtra Aarhus');`),
      step(A, upsert(WS1, P1, ID.B, A_ID, 250, "requested")),
    ],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "ok",
    post: `if (select status from public.settlement_periods where id = '${P1}') <> 'closed'
      then raise exception 'CASEFAIL repairs-ligeligt-close-with-matching-request: period not closed'; end if;`,
  }),
  queryCase({
    name: "repairs-inactive-payer-credited-when-folded",
    desc: "credit-only (GV-274): an inactive payer's repair is retained — they are credited exactly what they paid with zero share and the period nets to zero when the mode folds; only deles_ikke (which folds nothing) drops them",
    setup: [
      // Only A + B active so the split universe is clean; D is the fixture's inactive member.
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
      step(SUPER, `insert into public.vehicle_repairs (ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id)
        values ('${WS1}', current_date, 'Logget, derefter inaktiv', 100.00, '${ID.D}', '${ID.D}');`),
    ],
    actor: A,
    assert: `declare s jsonb; d_net numeric; d_paid numeric; d_share numeric; total_repairs numeric; sum_net numeric; mode text; d_present boolean;
begin
  -- Folded modes: the inactive payer D is credited exactly what they paid, bears
  -- ZERO share (the 100 kr splits over the ACTIVE members only), and everything
  -- still nets to zero — the mode-independent invariants of the credit-only rule.
  foreach mode in array array['ligeligt', 'efter_koersel'] loop
    perform public.update_ledger_settings('${WS1}', null, null, null, mode);
    s := public.calculate_period_settlement('${WS1}', '${P1}');
    d_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.D}');
    d_paid := (select (p->>'repairPaid')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.D}');
    d_share := (select (p->>'repairShare')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.D}');
    total_repairs := (s->>'totalRepairs')::numeric;
    sum_net := (select sum((p->>'net')::numeric) from jsonb_array_elements(s->'people') p);
    if d_net is distinct from 100 or d_paid is distinct from 100 or d_share is distinct from 0 or total_repairs is distinct from 100 or sum_net is distinct from 0 then
      raise exception 'CASEFAIL repairs-inactive-payer-credited-when-folded: mode=% Dnet=% DrepairPaid=% DrepairShare=% totalRepairs=% sumNet=% (expected 100/100/0/100/0 -- inactive payer is credit-only)', mode, d_net, d_paid, d_share, total_repairs, sum_net;
    end if;
  end loop;
  -- deles_ikke folds no repairs, so D paid nothing that counts and must NOT appear.
  perform public.update_ledger_settings('${WS1}', null, null, null, 'deles_ikke');
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  d_present := exists (select 1 from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.D}');
  total_repairs := (s->>'totalRepairs')::numeric;
  if d_present or total_repairs is distinct from 0 then
    raise exception 'CASEFAIL repairs-inactive-payer-credited-when-folded: deles_ikke Dpresent=% totalRepairs=% (expected false/0 -- an inactive member who paid nothing is excluded)', d_present, total_repairs;
  end if;
end`,
  }),
  rpcCase({
    name: "repairs-split-mode-nonadmin-denied",
    desc: "non-admin B calls update_ledger_settings to change repairs_split_mode (denied)",
    actor: B,
    op: `perform public.update_ledger_settings('${WS1}', null, null, null, 'deles_ikke');`,
    expect: "42501",
  }),
  rpcCase({
    name: "repairs-split-mode-admin-succeeds",
    desc: "admin A sets repairs_split_mode via update_ledger_settings",
    actor: A,
    op: `perform public.update_ledger_settings('${WS1}', null, null, null, 'efter_koersel');`,
    expect: "ok",
    post: `if (select repairs_split_mode from public.ledgers where id = '${WS1}') <> 'efter_koersel'
      then raise exception 'CASEFAIL repairs-split-mode-admin-succeeds: repairs_split_mode was not updated'; end if;`,
  }),
  rpcCase({
    name: "repairs-split-mode-invalid-value-rejected",
    desc: "admin A sets an invalid repairs_split_mode value (rejected)",
    actor: A,
    op: `perform public.update_ledger_settings('${WS1}', null, null, null, 'not_a_real_mode');`,
    expect: "22023",
  }),
  // ── GV-292: a real settlement-rule change logs one settings_changed feed event;
  //    a no-op (equal or null param) logs nothing; non-admins are still denied. ──
  rpcCase({
    name: "settings-change-settlement-mode-emits-event",
    desc: "admin A switches settlement_mode monthly->running: exactly one settings_changed event with {field,old,new} (GV-292)",
    actor: A,
    op: `perform public.update_ledger_settings('${WS1}', 'running', null, null, null);`,
    expect: "ok",
    post: `if (select count(*) from public.ledger_events where ledger_id = '${WS1}' and event_type = 'settings_changed') <> 1
      then raise exception 'CASEFAIL settings-change-settlement-mode-emits-event: expected exactly 1 settings_changed event'; end if;
    if not exists (
      select 1 from public.ledger_events
      where ledger_id = '${WS1}' and event_type = 'settings_changed'
        and title = 'Afregning ændret' and body = 'Gruppen afregner nu løbende.'
        and actor_member_id = '${A_ID}'
        and metadata->>'field' = 'settlement_mode'
        and metadata->>'old' = 'monthly' and metadata->>'new' = 'running'
    ) then raise exception 'CASEFAIL settings-change-settlement-mode-emits-event: settlement_mode event missing or wrong content'; end if;`,
  }),
  rpcCase({
    name: "settings-change-repairs-mode-emits-event",
    desc: "admin A switches repairs_split_mode ligeligt->deles_ikke: exactly one settings_changed event (GV-292)",
    actor: A,
    op: `perform public.update_ledger_settings('${WS1}', null, null, null, 'deles_ikke');`,
    expect: "ok",
    post: `if (select count(*) from public.ledger_events where ledger_id = '${WS1}' and event_type = 'settings_changed') <> 1
      then raise exception 'CASEFAIL settings-change-repairs-mode-emits-event: expected exactly 1 settings_changed event'; end if;
    if not exists (
      select 1 from public.ledger_events
      where ledger_id = '${WS1}' and event_type = 'settings_changed'
        and title = 'Reparationsdeling ændret' and body = 'Reparationer deles ikke længere.'
        and metadata->>'field' = 'repairs_split_mode'
        and metadata->>'old' = 'ligeligt' and metadata->>'new' = 'deles_ikke'
    ) then raise exception 'CASEFAIL settings-change-repairs-mode-emits-event: repairs event missing or wrong content'; end if;`,
  }),
  rpcCase({
    name: "settings-noop-emits-no-event",
    desc: "admin A re-saves the SAME settlement_mode (monthly) with a null repairs param: no settings_changed event (GV-292 no-op suppression)",
    actor: A,
    op: `perform public.update_ledger_settings('${WS1}', 'monthly', null, null, null);`,
    expect: "ok",
    post: `if exists (select 1 from public.ledger_events where ledger_id = '${WS1}' and event_type = 'settings_changed')
      then raise exception 'CASEFAIL settings-noop-emits-no-event: a no-op call emitted a settings_changed event'; end if;`,
  }),
  rpcCase({
    name: "settings-change-settlement-mode-nonadmin-denied",
    desc: "non-admin B calls update_ledger_settings to change settlement_mode (denied 42501) (GV-292)",
    actor: B,
    op: `perform public.update_ledger_settings('${WS1}', 'running', null, null, null);`,
    expect: "42501",
  }),
  // Migration 125: fuel settings have one validated command boundary. Admins can
  // use it, ordinary members cannot, and even admins cannot UPDATE ledgers directly.
  rpcCase({
    name: "fuel-settings-admin-succeeds",
    desc: "admin A updates canonical fuel settings through the narrow RPC",
    actor: A,
    op: `perform public.update_ledger_fuel_settings('${WS1}', 'benzin', 6.2, 48, 15.25);`,
    expect: "ok",
    post: `if not exists (
      select 1 from public.ledgers
       where id = '${WS1}'
         and fuel_type = 'benzin'
         and estimated_consumption_l_per_100km = 6.2
         and fuel_tank_capacity_l = 48
         and fallback_fuel_price = 15.25
    ) then raise exception 'CASEFAIL fuel-settings-admin-succeeds: settings were not stored'; end if;
    if not exists (
      select 1 from public.ledger_events
       where ledger_id = '${WS1}'
         and event_type = 'settings_changed'
         and metadata->'changed' ?& array['fuel_type', 'consumption', 'tank_capacity', 'fallback_price']
    ) then raise exception 'CASEFAIL fuel-settings-admin-succeeds: redacted change event missing'; end if;`,
  }),
  rpcCase({
    name: "fuel-settings-nonadmin-denied",
    desc: "member B cannot update workspace fuel settings through the RPC",
    actor: B,
    op: `perform public.update_ledger_fuel_settings('${WS1}', 'benzin', 6.2, 48, 15.25);`,
    expect: "42501",
  }),
  rpcCase({
    name: "fuel-settings-invalid-values-rejected",
    desc: "admin A cannot store an unsupported fuel type or nonsensical values",
    actor: A,
    op: `perform public.update_ledger_fuel_settings('${WS1}', 'petrol98', 0, 48, 15.25);`,
    expect: "22023",
  }),
  rpcCase({
    name: "ledger-direct-admin-update-denied",
    desc: "admin A cannot bypass settings RPCs with a direct ledgers UPDATE",
    actor: A,
    op: `update public.ledgers set join_code = 'ATTACK' where id = '${WS1}';`,
    expect: "42501",
  }),
  // Migration 126: app-wide announcements are operator infrastructure. Only the
  // service role can replace/clear, and replacement preserves one active row.
  rpcCase({
    name: "announcement-replace-service-role-succeeds",
    desc: "service role atomically replaces the active app announcement",
    setup: [
      step(SUPER, `insert into public.app_announcements (text, active) values ('Old banner', true);`),
    ],
    actor: SERVICE,
    op: `perform public.replace_app_announcement('New banner', 'https://vehloshare.app/news', 'success', null, null, 'owner@example.dk');`,
    expect: "ok",
    post: `if (select count(*) from public.app_announcements where active = true) <> 1
      then raise exception 'CASEFAIL announcement-replace-service-role-succeeds: expected exactly one active row'; end if;
    if not exists (select 1 from public.app_announcements where active = true and text = 'New banner' and variant = 'success')
      then raise exception 'CASEFAIL announcement-replace-service-role-succeeds: replacement row missing'; end if;
    if exists (select 1 from public.app_announcements where text = 'Old banner' and active = true)
      then raise exception 'CASEFAIL announcement-replace-service-role-succeeds: old row remained active'; end if;`,
  }),
  rpcCase({
    name: "announcement-replace-authenticated-denied",
    desc: "authenticated workspace admin A cannot call the operator announcement command",
    actor: A,
    op: `perform public.replace_app_announcement('Not allowed', null, 'info', null, null, 'a@rolematrix.test');`,
    expect: "42501",
  }),
  rpcCase({
    name: "announcement-replace-invalid-input-preserves-current",
    desc: "invalid replacement is rejected before the current active banner changes",
    setup: [
      step(SUPER, `insert into public.app_announcements (text, active) values ('Keep me', true);`),
    ],
    actor: SERVICE,
    op: `perform public.replace_app_announcement('Bad replacement', 'javascript://alert(1)', 'info', null, null, 'owner@example.dk');`,
    expect: "22023",
    post: `if not exists (select 1 from public.app_announcements where text = 'Keep me' and active = true)
      then raise exception 'CASEFAIL announcement-replace-invalid-input-preserves-current: current banner changed'; end if;`,
  }),
  rpcCase({
    name: "announcement-insert-failure-rolls-back-deactivation",
    desc: "a database failure during replacement insert rolls back retirement of the current banner",
    setup: [
      step(SUPER, `insert into public.app_announcements (text, active) values ('Still live', true);`),
      step(SUPER, `alter table public.app_announcements add constraint rolematrix_reject_announcement check (text <> 'Force failure');`),
    ],
    actor: SERVICE,
    op: `perform public.replace_app_announcement('Force failure', null, 'info', null, null, 'owner@example.dk');`,
    expect: "23514",
    post: `if not exists (select 1 from public.app_announcements where text = 'Still live' and active = true)
      then raise exception 'CASEFAIL announcement-insert-failure-rolls-back-deactivation: original banner was retired'; end if;
    if exists (select 1 from public.app_announcements where text = 'Force failure')
      then raise exception 'CASEFAIL announcement-insert-failure-rolls-back-deactivation: rejected replacement was stored'; end if;`,
  }),
  rpcCase({
    name: "announcement-clear-service-role-succeeds",
    desc: "service role clears the active app announcement through the serialized command",
    setup: [
      step(SUPER, `insert into public.app_announcements (text, active) values ('Clear me', true);`),
    ],
    actor: SERVICE,
    op: `perform public.clear_app_announcements();`,
    expect: "ok",
    post: `if exists (select 1 from public.app_announcements where active = true)
      then raise exception 'CASEFAIL announcement-clear-service-role-succeeds: active row remained'; end if;`,
  }),
  queryCase({
    name: "repairs-deles-ikke-matches-baseline",
    desc: "mode='deles_ikke': a repair logged by active member C is excluded, nets match the no-repairs baseline",
    setup: [
      step(SUPER, `update public.ledgers set repairs_split_mode = 'deles_ikke' where id = '${WS1}';`),
      step(C, `perform public.insert_repair('${WS1}', current_date, 'Skal ikke deles', 500.00);`),
    ],
    actor: A,
    assert: `declare s jsonb; a_net numeric; b_net numeric; c_net numeric; g_net numeric; total_repairs numeric;
begin
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  a_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${A_ID}');
  b_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.B}');
  c_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.C}');
  g_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.G}');
  total_repairs := (s->>'totalRepairs')::numeric;
  if a_net is distinct from 300 or b_net is distinct from -300 or c_net is distinct from 0 or g_net is distinct from 0 or total_repairs is distinct from 0 then
    raise exception 'CASEFAIL repairs-deles-ikke-matches-baseline: A=% B=% C=% G=% totalRepairs=% (expected 300/-300/0/0/0 -- deles_ikke excludes repairs entirely)', a_net, b_net, c_net, g_net, total_repairs;
  end if;
end`,
  }),
  rpcCase({
    name: "repair-after-request-carries-into-next-period",
    desc: "a repair logged after the request leaves its 300 kr frozen and is promoted into the next period on close",
    setup: [
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
      step(A, CREATE_REQ_300),
      step(A, `perform public.insert_repair('${WS1}', current_date, 'Ny bremseskive', 100.00);`),
    ],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "ok",
    post: `if (select status from public.settlement_periods where id = '${P1}') <> 'closed'
      then raise exception 'CASEFAIL repair-after-request-carries-into-next-period: source period should close'; end if;
    if not exists (
      select 1
      from public.vehicle_repairs vr
      join public.settlement_periods sp on sp.id = vr.period_id
      where vr.ledger_id = '${WS1}'
        and vr.description = 'Ny bremseskive'
        and sp.status = 'open'
    ) then
      raise exception 'CASEFAIL repair-after-request-carries-into-next-period: repair was not promoted to the new open period';
    end if;
    if exists (select 1 from public.settlement_periods where ledger_id = '${WS1}' and status = 'queued') then
      raise exception 'CASEFAIL repair-after-request-carries-into-next-period: queued period survived promotion';
    end if;`,
  }),

  // ── 7. Repair payer + validation + largest-remainder rounding (GV-269) ──────
  rpcCase({
    name: "repair-cost-zero-rejected",
    desc: "insert_repair rejects a zero cost (repairs are financial records, 22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Nul kroner', 0, null, null, null);`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-cost-negative-rejected",
    desc: "insert_repair rejects a negative cost (22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Negativ pris', -50.00, null, null, null);`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-blank-description-rejected",
    desc: "insert_repair rejects a whitespace-only description (btrim gate, 22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, '   ', 100.00, null, null, null);`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-negative-odometer-rejected",
    desc: "insert_repair rejects a negative odometer reading (22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Negativt odometer', 100.00, -1, null, null);`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-payer-inactive-rejected",
    desc: "insert_repair rejects INACTIVE member D as payer (22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Inaktiv betaler', 100.00, null, null, '${ID.D}');`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-payer-foreign-rejected",
    desc: "insert_repair rejects a member of ANOTHER workspace (E) as payer (22023)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Fremmed betaler', 100.00, null, null, '${ID.E}');`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-payer-other-active-member-allowed",
    desc: "B logs a repair naming ACTIVE member C as payer (any-member attribution, 2026-07-10 decision)",
    actor: B,
    op: `perform public.insert_repair('${WS1}', current_date, 'Betalt af Cille', 100.00, null, null, '${ID.C}');`,
    expect: "ok",
    post: `if not exists (select 1 from public.vehicle_repairs
        where ledger_id = '${WS1}' and description = 'Betalt af Cille'
          and created_by_member_id = '${ID.B}' and paid_by_member_id = '${ID.C}')
      then raise exception 'CASEFAIL repair-payer-other-active-member-allowed: row missing or payer/creator not recorded as B->C'; end if;`,
  }),
  queryCase({
    name: "repairs-lr-six-100kr-sum-exact",
    desc: "largest remainder: six 100 kr ligeligt repairs over 3 members sum to EXACTLY 600.00 and the nets to exactly zero (GV-269; per-member rounding left a 0,06 kr residual)",
    setup: [
      step(SUPER, `update public.ledger_members set is_active = false where id = '${ID.G}';`),
      step(A, `perform public.insert_repair('${WS1}', current_date, 'LR reparation 1', 100.00, null, null, null);
  perform public.insert_repair('${WS1}', current_date, 'LR reparation 2', 100.00, null, null, null);
  perform public.insert_repair('${WS1}', current_date, 'LR reparation 3', 100.00, null, null, null);
  perform public.insert_repair('${WS1}', current_date, 'LR reparation 4', 100.00, null, null, null);
  perform public.insert_repair('${WS1}', current_date, 'LR reparation 5', 100.00, null, null, null);
  perform public.insert_repair('${WS1}', current_date, 'LR reparation 6', 100.00, null, null, null);`),
    ],
    actor: A,
    assert: `declare s jsonb; share_sum numeric; net_sum numeric; total_repairs numeric; sh1 numeric; sh2 numeric; sh3 numeric;
begin
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  select sum((p->>'repairShare')::numeric), sum((p->>'net')::numeric)
    into share_sum, net_sum
    from jsonb_array_elements(s->'people') p;
  total_repairs := (s->>'totalRepairs')::numeric;
  -- people is ordered by member id (text, collate C); each 100 kr item gives its
  -- single leftover oere to the LOWEST member id, so 6 items => 200.04 for the
  -- first member and 199.98 for the other two.
  select max(q.sh) filter (where q.ord = 1),
         max(q.sh) filter (where q.ord = 2),
         max(q.sh) filter (where q.ord = 3)
    into sh1, sh2, sh3
    from (select (t.p->>'repairShare')::numeric as sh, t.ord
          from jsonb_array_elements(s->'people') with ordinality t(p, ord)) q;
  if total_repairs is distinct from 600.00 or share_sum is distinct from 600.00 or net_sum is distinct from 0 then
    raise exception 'CASEFAIL repairs-lr-six-100kr-sum-exact: totalRepairs=% shareSum=% netSum=% (expected EXACTLY 600.00 / 600.00 / 0 — no tolerance)', total_repairs, share_sum, net_sum;
  end if;
  if sh1 is distinct from 200.04 or sh2 is distinct from 199.98 or sh3 is distinct from 199.98 then
    raise exception 'CASEFAIL repairs-lr-six-100kr-sum-exact: shares by id order = % / % / % (expected 200.04 / 199.98 / 199.98)', sh1, sh2, sh3;
  end if;
end`,
  }),
  queryCase({
    name: "repairs-created-at-scoping",
    desc: "a repair logged NOW with an old repair_date lands in the settling period — insert_repair stamps the open period_id (GV-277), so repair_date never drops it (GV-269; under 107 it was silently dropped)",
    setup: [
      step(B, `perform public.insert_repair('${WS1}', date '2021-06-15', 'Gammel dato, logget nu', 120.00, null, null, null);`),
    ],
    actor: A,
    assert: `declare s jsonb; share_sum numeric; total_repairs numeric;
begin
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  total_repairs := (s->>'totalRepairs')::numeric;
  select sum((p->>'repairShare')::numeric) into share_sum
    from jsonb_array_elements(s->'people') p;
  if total_repairs is distinct from 120.00 or share_sum is distinct from 120.00 then
    raise exception 'CASEFAIL repairs-created-at-scoping: totalRepairs=% shareSum=% (expected 120.00/120.00 — the old-dated repair must fold into the period it was logged in)', total_repairs, share_sum;
  end if;
end`,
  }),

  // ── 8. Release-blocker remediation (migration 112: GV-273/274/275) ───────────
  // GV-273 — repairs freeze once the period they were logged in closes. now() is
  // fixed within a transaction, so the repair is created at now() and the period
  // is closed with closed_at = now() + 1s to put created_at strictly inside the
  // closed [opened_at, closed_at) window.
  rpcCase({
    name: "repair-update-blocked-in-closed-period",
    desc: "creator B's soft-delete of a repair is rejected once its period is closed (GV-273 lock trigger, 22023)",
    setup: [
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id, created_at)
        values ('a1a1a1a1-0000-0000-0000-000000000001', '${WS1}', current_date, 'Låst reparation', 100.00, '${ID.B}', '${ID.B}', now());`),
      step(SUPER, `update public.settlement_periods set status = 'closed', closed_at = now() + interval '1 second' where id = '${P1}';`),
    ],
    actor: B,
    op: `update public.vehicle_repairs set deleted_at = now() where id = 'a1a1a1a1-0000-0000-0000-000000000001';`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-delete-blocked-in-closed-period",
    desc: "admin A's hard DELETE of a repair is rejected once its period is closed (GV-273 lock trigger, 22023)",
    setup: [
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id, created_at)
        values ('a1a1a1a1-0000-0000-0000-000000000002', '${WS1}', current_date, 'Låst reparation 2', 100.00, '${ID.B}', '${ID.B}', now());`),
      step(SUPER, `update public.settlement_periods set status = 'closed', closed_at = now() + interval '1 second' where id = '${P1}';`),
    ],
    actor: A,
    op: `delete from public.vehicle_repairs where id = 'a1a1a1a1-0000-0000-0000-000000000002';`,
    expect: "22023",
  }),
  rpcCase({
    name: "repair-update-allowed-in-open-period",
    desc: "creator B edits a repair while its period is still OPEN — the GV-273 lock does not apply (ok)",
    setup: [
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id, created_at)
        values ('a1a1a1a1-0000-0000-0000-000000000003', '${WS1}', current_date, 'Åben reparation', 100.00, '${ID.B}', '${ID.B}', now());`),
    ],
    actor: B,
    op: `update public.vehicle_repairs set description = 'Opdateret i åben periode' where id = 'a1a1a1a1-0000-0000-0000-000000000003';`,
    expect: "ok",
    post: `if (select description from public.vehicle_repairs where id = 'a1a1a1a1-0000-0000-0000-000000000003') <> 'Opdateret i åben periode'
      then raise exception 'CASEFAIL repair-update-allowed-in-open-period: the open-period edit did not persist'; end if;`,
  }),

  // GV-274 — recurring hardening.
  rpcCase({
    name: "recurring-amount-zero-rejected",
    desc: "admin A's recurring template with amount 0 is rejected (GV-274, 22023)",
    actor: A,
    op: `perform public.upsert_recurring_expense('${WS1}', null, 'other', 'Nul beløb', 0, 'monthly', current_date);`,
    expect: "22023",
  }),
  rpcCase({
    name: "recurring-amount-negative-rejected",
    desc: "admin A's recurring template with a negative amount is rejected (GV-274, 22023)",
    actor: A,
    op: `perform public.upsert_recurring_expense('${WS1}', null, 'other', 'Negativt beløb', -50.00, 'monthly', current_date);`,
    expect: "22023",
  }),
  rpcCase({
    name: "recurring-old-due-date-rejected",
    desc: "admin A's recurring template dated 2019 (outside today-90d..today+5y) is rejected (GV-274, 22023)",
    actor: A,
    op: `perform public.upsert_recurring_expense('${WS1}', null, 'other', 'Gammel forfaldsdato', 100.00, 'monthly', date '2019-01-01');`,
    expect: "22023",
  }),
  queryCase({
    name: "recurring-catchup-cap-24",
    desc: "a monthly template due ~40 months back generates EXACTLY 24 rows in one run and advances next_due_date only through what was generated (GV-274 catch-up cap)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('c0c0c0c0-0000-0000-0000-000000000024', '${WS1}', 'other', 'Fast udgift', 100.00, 'monthly', (current_date - interval '40 months')::date, '${A_ID}', true, '${A_ID}');`),
    ],
    actor: A,
    assert: `declare cnt integer; ndd date; expected_ndd date;
begin
  perform public.generate_due_recurring_expenses('${WS1}');
  select count(*) into cnt from public.workspace_expenses where recurring_expense_id = 'c0c0c0c0-0000-0000-0000-000000000024';
  select next_due_date into ndd from public.recurring_expenses where id = 'c0c0c0c0-0000-0000-0000-000000000024';
  expected_ndd := ((current_date - interval '40 months') + interval '24 months')::date;
  if cnt <> 24 then
    raise exception 'CASEFAIL recurring-catchup-cap-24: generated % rows (expected exactly 24 — the per-run cap)', cnt;
  end if;
  if ndd is distinct from expected_ndd then
    raise exception 'CASEFAIL recurring-catchup-cap-24: next_due_date=% (expected % — advance only through what was generated)', ndd, expected_ndd;
  end if;
end`,
  }),

  // GV-274 — credit-only inactive payer, the settlement regression.
  queryCase({
    name: "settlement-inactive-payer-credited-expense",
    desc: "an expense paid by C who is then deactivated: settlement still nets to zero and credits C exactly what they paid, with zero share (GV-274 credit-only)",
    setup: [
      step(SUPER, `insert into public.workspace_expenses (ledger_id, period_id, category, description, amount_dkk, expense_date, paid_by_member_id, created_by_member_id)
        values ('${WS1}', '${P1}', 'other', 'Betalt af snart-inaktiv C', 300.00, current_date, '${ID.C}', '${ID.C}');`),
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
    ],
    actor: A,
    assert: `declare s jsonb; a_net numeric; b_net numeric; c_net numeric; c_paid numeric; c_share numeric; total_expenses numeric; sum_net numeric; d_present boolean; g_present boolean;
begin
  s := public.calculate_period_settlement('${WS1}', '${P1}');
  a_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${A_ID}');
  b_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.B}');
  c_net := (select (p->>'net')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.C}');
  c_paid := (select (p->>'expensePaid')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.C}');
  c_share := (select (p->>'expenseShare')::numeric from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.C}');
  total_expenses := (s->>'totalExpenses')::numeric;
  sum_net := (select sum((p->>'net')::numeric) from jsonb_array_elements(s->'people') p);
  d_present := exists (select 1 from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.D}');
  g_present := exists (select 1 from jsonb_array_elements(s->'people') p where p->>'id' = '${ID.G}');
  -- A gets fuel 300 minus a 150 expense share; B owes trip 300 plus a 150 share;
  -- the 300 expense splits over the ACTIVE pair (A,B) only, and C is credited +300.
  if a_net is distinct from 150 or b_net is distinct from -450 or c_net is distinct from 300 then
    raise exception 'CASEFAIL settlement-inactive-payer-credited-expense: A=% B=% C=% (expected 150/-450/300)', a_net, b_net, c_net;
  end if;
  if c_paid is distinct from 300 or c_share is distinct from 0 then
    raise exception 'CASEFAIL settlement-inactive-payer-credited-expense: C expensePaid=% expenseShare=% (expected 300/0 -- credit-only, zero weight)', c_paid, c_share;
  end if;
  if total_expenses is distinct from 300 or sum_net is distinct from 0 then
    raise exception 'CASEFAIL settlement-inactive-payer-credited-expense: totalExpenses=% sumNet=% (expected 300/0)', total_expenses, sum_net;
  end if;
  if d_present or g_present then
    raise exception 'CASEFAIL settlement-inactive-payer-credited-expense: Dpresent=% Gpresent=% (expected false/false -- inactive members who paid nothing are excluded)', d_present, g_present;
  end if;
end`,
  }),
  queryCase({
    name: "fingerprint-includes-in-scope-repairs",
    desc: "calculate_period_entry_fingerprint appends a repairs key with the in-scope repair as an [id,oere] PAIR, and omits it entirely when the period has no repair (GV-277 close-staleness, financial revision)",
    setup: [
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id, created_at)
        values ('f1f1f1f1-0000-0000-0000-000000000001', '${WS1}', current_date, 'Fingerprint reparation', 100.00, '${ID.B}', '${ID.B}', now());`),
    ],
    actor: A,
    assert: `declare fp_with text; fp_after_edit text; fp_without text;
begin
  -- GV-277: the repair component is an [id,oere] pair (100.00 kr => 10000 oere), so
  -- a repair-cost edit — which moves neither totalKm nor totalPaid — changes the
  -- fingerprint and busts a prepared close. A legacy null-period row is scoped by
  -- created_at here (it was seeded directly, not through insert_repair).
  fp_with := public.calculate_period_entry_fingerprint('${WS1}', '${P1}');
  if position('"repairs":[["f1f1f1f1-0000-0000-0000-000000000001",10000]]' in fp_with) = 0 then
    raise exception 'CASEFAIL fingerprint-includes-in-scope-repairs: fingerprint=% (expected an [id,oere] repair pair in a repairs key)', fp_with;
  end if;
  update public.vehicle_repairs set cost_dkk = 150.00 where id = 'f1f1f1f1-0000-0000-0000-000000000001';
  fp_after_edit := public.calculate_period_entry_fingerprint('${WS1}', '${P1}');
  if fp_after_edit = fp_with or position('",15000]]' in fp_after_edit) = 0 then
    raise exception 'CASEFAIL fingerprint-includes-in-scope-repairs: edited fingerprint=% (expected the oere amount to change to 15000)', fp_after_edit;
  end if;
  -- Soft-delete the repair: the period now has no in-scope repair, so the repairs
  -- key must disappear entirely (byte-identical to the pre-112 trips/fuel/expenses
  -- string, matching the client which omits the key when empty).
  update public.vehicle_repairs set deleted_at = now() where id = 'f1f1f1f1-0000-0000-0000-000000000001';
  fp_without := public.calculate_period_entry_fingerprint('${WS1}', '${P1}');
  if position('repairs' in fp_without) <> 0 then
    raise exception 'CASEFAIL fingerprint-includes-in-scope-repairs: fingerprint=% (expected NO repairs key when the period has no in-scope repair)', fp_without;
  end if;
end`,
  }),

  // ── 9. Repair↔period binding + payer deactivation (migration 114: GV-277) ─────
  queryCase({
    name: "insert-repair-stamps-open-period",
    desc: "insert_repair stamps the row's period_id with the ledger's open period (GV-277 repair↔period binding)",
    setup: [
      step(B, `perform public.insert_repair('${WS1}', current_date, 'Stemplet reparation', 100.00, null, null, null);`),
    ],
    actor: A,
    assert: `declare stamped uuid;
begin
  select period_id into stamped
  from public.vehicle_repairs
  where ledger_id = '${WS1}' and description = 'Stemplet reparation' and deleted_at is null
  order by created_at desc limit 1;
  if stamped is distinct from '${P1}'::uuid then
    raise exception 'CASEFAIL insert-repair-stamps-open-period: period_id=% (expected the open period %)', stamped, '${P1}';
  end if;
end`,
  }),
  // Migration 147 dropped set_ledger_member_active_admin, which this case used to
  // call. That is the resolution of the GV-379 finding, not a loss of coverage: the
  // case now exercises upsert_ledger_member_admin — the RPC both clients actually
  // deactivate through, and where migration 145 moved this behaviour. The assertion
  // is unchanged, so it went from certifying a path production never takes to
  // certifying the one it does.
  queryCase({
    name: "deactivation-suspends-payer-recurring",
    desc: "deactivating a member suspends every recurring template they pay for and writes a recurring_suspended event (GV-277 via migration 145's upsert_ledger_member_admin)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('c1c1c1c1-0000-0000-0000-000000000001', '${WS1}', 'other', 'Cilles abonnement', 100.00, 'monthly', current_date, '${ID.C}', true, '${A_ID}');`),
    ],
    actor: A,
    assert: `declare still_active boolean; evt_count integer; evt_body text;
begin
  perform public.upsert_ledger_member_admin('${WS1}', '${ID.C}', 'Cille', '${EMAIL.C}', null, 'member', false);
  select is_active into still_active from public.recurring_expenses where id = 'c1c1c1c1-0000-0000-0000-000000000001';
  if still_active is distinct from false then
    raise exception 'CASEFAIL deactivation-suspends-payer-recurring: template is_active=% (expected false — suspended on payer deactivation)', still_active;
  end if;
  select count(*), max(body) into evt_count, evt_body
  from public.ledger_events
  where ledger_id = '${WS1}' and event_type = 'recurring_suspended';
  if evt_count < 1 or position('Cilles abonnement' in coalesce(evt_body, '')) = 0 then
    raise exception 'CASEFAIL deactivation-suspends-payer-recurring: evt_count=% body=% (expected a recurring_suspended event naming the template)', evt_count, evt_body;
  end if;
end`,
  }),
  queryCase({
    name: "generator-skips-inactive-payer-template",
    desc: "generate_due_recurring_expenses skips a due template whose payer is an inactive member (GV-277 defense in depth)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('c2c2c2c2-0000-0000-0000-000000000002', '${WS1}', 'other', 'Inaktiv-betaler skabelon', 100.00, 'monthly', current_date, '${ID.D}', true, '${A_ID}');`),
    ],
    actor: A,
    assert: `declare gen_count integer;
begin
  perform public.generate_due_recurring_expenses('${WS1}');
  select count(*) into gen_count from public.workspace_expenses where recurring_expense_id = 'c2c2c2c2-0000-0000-0000-000000000002';
  if gen_count <> 0 then
    raise exception 'CASEFAIL generator-skips-inactive-payer-template: generated % rows (expected 0 — D is inactive)', gen_count;
  end if;
end`,
  }),

  // ── 9. Payment evidence notes (migration 115: GV-279) ────────────────────────
  // A trailing p_note is persisted only by the debtor's paid_pending claim
  // (paid_note) and the creditor's dispute (dispute_note); both are immutable
  // once set, and any other actor/transition ignores it.
  rpcCase({
    name: "note-debtor-sets-paid-note",
    desc: "debtor B's paid_pending claim writes p_note to paid_note",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], 'MobilePay 12345678'"),
    expect: "ok",
    post: `if (select paid_note from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is distinct from 'MobilePay 12345678'
      then raise exception 'CASEFAIL note-debtor-sets-paid-note: paid_note not stored'; end if;`,
  }),
  rpcCase({
    name: "note-creditor-cannot-set-paid-note",
    desc: "creditor A's own paid_pending transition does NOT write paid_note (debtor-only)",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], 'ikke min note'"),
    expect: "ok",
    post: `if (select paid_note from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is not null
      then raise exception 'CASEFAIL note-creditor-cannot-set-paid-note: creditor wrote paid_note'; end if;`,
  }),
  rpcCase({
    name: "note-paid-note-immutable",
    desc: "a second paid_pending call by debtor B does NOT overwrite the stored paid_note",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], 'MobilePay foerste'")),
    ],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], 'MobilePay anden'"),
    expect: "ok",
    post: `if (select paid_note from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is distinct from 'MobilePay foerste'
      then raise exception 'CASEFAIL note-paid-note-immutable: paid_note was overwritten'; end if;`,
  }),
  rpcCase({
    name: "note-creditor-dispute-sets-dispute-note",
    desc: "creditor A's dispute (paid_pending -> requested) writes p_note to dispute_note",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested", ", array[]::text[], 'Har ikke modtaget beloebet'"),
    expect: "ok",
    post: `if (select dispute_note from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is distinct from 'Har ikke modtaget beloebet'
      then raise exception 'CASEFAIL note-creditor-dispute-sets-dispute-note: dispute_note not stored'; end if;
      if (select status from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') <> 'requested'
      then raise exception 'CASEFAIL note-creditor-dispute-sets-dispute-note: status not reopened to requested'; end if;`,
  }),
  rpcCase({
    name: "note-dispute-note-immutable",
    desc: "a second dispute by creditor A does NOT overwrite the stored dispute_note",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
      step(A, upsert(WS1, P1, ID.B, A_ID, 300, "requested", ", array[]::text[], 'Foerste indsigelse'")),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "requested", ", array[]::text[], 'Anden indsigelse'"),
    expect: "ok",
    post: `if (select dispute_note from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') is distinct from 'Foerste indsigelse'
      then raise exception 'CASEFAIL note-dispute-note-immutable: dispute_note was overwritten'; end if;`,
  }),
  rpcCase({
    name: "note-unrelated-member-rejected",
    desc: "member E of the other workspace cannot claim+note ws1's request (party-or-admin gate)",
    setup: [step(A, CREATE_REQ_300)],
    actor: E,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], 'fremmed note'"),
    expect: "42501",
  }),
  rpcCase({
    name: "note-too-long-rejected",
    desc: "a paid_note longer than 280 chars is rejected by the CHECK (23514)",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending", ", array[]::text[], repeat('x', 281)"),
    expect: "23514",
  }),

  // ── 10. Recurring generation vs entry lock (migration 142: GV-360) ───────────
  // A locked open period (an active settlement request) must neither crash recurring
  // generation nor defer it. Migration 116 (GV-281) short-circuited both generators on
  // the lock; migration 142 deleted those short-circuits, because migration 121's
  // assert_settlement_period_boundary_expenses trigger fires before the entry-lock
  // trigger and (since migration 140) rebinds the insert into the queued carry-over
  // period. So an occurrence due during a payment freeze is materialised NOW into the
  // queued successor — exactly like a manually logged expense — and the frozen period's
  // requested amount is untouched. ledgers_skipped survives as the per-ledger FAILURE
  // counter (/api/hooks/recurring-generate reads it) and must now read 0 for a lock.
  queryCase({
    name: "recurring-sweep-carries-locked-ledger-into-queued-period",
    desc: "generate_all_due_recurring_expenses materialises into the queued carry-over period when the open period is entry-locked: no skip, no error, nothing added to the frozen period (GV-360)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d1d1d1d1-0000-0000-0000-000000000001', '${WS1}', 'other', 'Laast-periode skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: SERVICE,
    assert: `declare res jsonb; occ integer; occ_frozen integer; occ_queued integer;
begin
  res := public.generate_all_due_recurring_expenses(200);
  if not (res ? 'ledgers_skipped') then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: the ledgers_skipped key was dropped from the return contract';
  end if;
  if (res->>'ledgers_skipped')::int <> 0 then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: ledgers_skipped=% (expected 0 — GV-360 removed the entry-lock deferral)', res->>'ledgers_skipped';
  end if;
  if res->>'first_error' is not null then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: first_error=% (expected null — the carry-over must not raise)', res->>'first_error';
  end if;
  if (res->>'ledgers_touched')::int < 1 then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: ledgers_touched=% (expected >=1 — the locked ledger generated)', res->>'ledgers_touched';
  end if;
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd1d1d1d1-0000-0000-0000-000000000001';
  if occ <> 1 then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: generated % occurrence(s) (expected 1)', occ;
  end if;
  select count(*) into occ_frozen from public.workspace_expenses
    where recurring_expense_id = 'd1d1d1d1-0000-0000-0000-000000000001' and period_id = '${P1}';
  if occ_frozen <> 0 then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: % occurrence(s) landed in the frozen period (expected 0)', occ_frozen;
  end if;
  select count(*) into occ_queued from public.workspace_expenses we
    join public.settlement_periods sp on sp.id = we.period_id
    where we.recurring_expense_id = 'd1d1d1d1-0000-0000-0000-000000000001'
      and sp.ledger_id = '${WS1}' and sp.status = 'queued';
  if occ_queued <> 1 then
    raise exception 'CASEFAIL recurring-sweep-carries-locked-ledger-into-queued-period: % occurrence(s) in the queued successor (expected 1)', occ_queued;
  end if;
end`,
  }),
  queryCase({
    name: "recurring-sweep-generates-unlocked-alongside-locked",
    desc: "a locked and an unlocked ledger in the same sweep both generate; neither poisons the batch (GV-360)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d2d2d2d2-0000-0000-0000-000000000001', '${WS1}', 'other', 'Laast skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}'),
               ('d2d2d2d2-0000-0000-0000-000000000002', '${WS2}', 'other', 'Ulaast skabelon', 100.00, 'monthly', current_date, '${E_ID}', true, '${E_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: SERVICE,
    assert: `declare res jsonb; occ_locked integer; occ_unlocked integer;
begin
  res := public.generate_all_due_recurring_expenses(200);
  if (res->>'ledgers_skipped')::int <> 0 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: ledgers_skipped=% (expected 0 — neither ledger is deferred)', res->>'ledgers_skipped';
  end if;
  if (res->>'ledgers_touched')::int < 2 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: ledgers_touched=% (expected >=2 — both ledgers generated)', res->>'ledgers_touched';
  end if;
  select count(*) into occ_locked from public.workspace_expenses where recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000001';
  select count(*) into occ_unlocked from public.workspace_expenses where recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000002';
  if occ_locked <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: locked ledger generated % (expected 1 — carried into the queue)', occ_locked;
  end if;
  if occ_unlocked <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: unlocked ledger generated % (expected 1)', occ_unlocked;
  end if;
  if not exists (
    select 1 from public.workspace_expenses we
    join public.settlement_periods sp on sp.id = we.period_id
    where we.recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000001' and sp.status = 'queued'
  ) then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: the locked ledger''s occurrence did not land in the queued successor';
  end if;
  if not exists (
    select 1 from public.workspace_expenses we
    join public.settlement_periods sp on sp.id = we.period_id
    where we.recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000002' and sp.status = 'open'
  ) then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: the unlocked ledger''s occurrence did not land in its open period';
  end if;
end`,
  }),
  queryCase({
    name: "recurring-sweep-carryover-not-double-generated",
    desc: "an occurrence carried into the queue during a lock is not generated a second time once the request is cancelled (GV-360 — the idempotence key is period-independent)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d3d3d3d3-0000-0000-0000-000000000001', '${WS1}', 'other', 'Udskudt skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: SERVICE,
    assert: `declare res jsonb; occ integer;
begin
  res := public.generate_all_due_recurring_expenses(200);
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd3d3d3d3-0000-0000-0000-000000000001';
  if occ <> 1 then
    raise exception 'CASEFAIL recurring-sweep-carryover-not-double-generated: first sweep generated % (expected 1 — carried into the queue)', occ;
  end if;
  -- Cancel the live request → the period is no longer entry-locked. The occurrence
  -- already exists, so a further sweep must add nothing.
  update public.settlement_requests
    set status = 'cancelled'
    where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  res := public.generate_all_due_recurring_expenses(200);
  if (res->>'ledgers_skipped')::int <> 0 then
    raise exception 'CASEFAIL recurring-sweep-carryover-not-double-generated: second sweep ledgers_skipped=% (expected 0)', res->>'ledgers_skipped';
  end if;
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd3d3d3d3-0000-0000-0000-000000000001';
  if occ <> 1 then
    raise exception 'CASEFAIL recurring-sweep-carryover-not-double-generated: after cancel there are % occurrence(s) (expected still 1)', occ;
  end if;
end`,
  }),
  queryCase({
    name: "recurring-client-carries-into-queued-period-when-locked",
    desc: "generate_due_recurring_expenses (client catch-up) materialises into the queued carry-over period instead of returning reason:'locked' (GV-360)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d4d4d4d4-0000-0000-0000-000000000001', '${WS1}', 'other', 'Klient laast skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: A,
    assert: `declare res jsonb; occ integer; occ_queued integer;
begin
  res := public.generate_due_recurring_expenses('${WS1}');
  if (res->>'generated')::int <> 1 then
    raise exception 'CASEFAIL recurring-client-carries-into-queued-period-when-locked: generated=% (expected 1 — the lock no longer defers)', res->>'generated';
  end if;
  if res->>'reason' is not null then
    raise exception 'CASEFAIL recurring-client-carries-into-queued-period-when-locked: reason=% (expected null — reason:''locked'' was removed)', res->>'reason';
  end if;
  select count(*) into occ from public.workspace_expenses
    where recurring_expense_id = 'd4d4d4d4-0000-0000-0000-000000000001' and period_id = '${P1}';
  if occ <> 0 then
    raise exception 'CASEFAIL recurring-client-carries-into-queued-period-when-locked: % occurrence(s) landed in the frozen period (expected 0)', occ;
  end if;
  select count(*) into occ_queued from public.workspace_expenses we
    join public.settlement_periods sp on sp.id = we.period_id
    where we.recurring_expense_id = 'd4d4d4d4-0000-0000-0000-000000000001'
      and sp.ledger_id = '${WS1}' and sp.status = 'queued';
  if occ_queued <> 1 then
    raise exception 'CASEFAIL recurring-client-carries-into-queued-period-when-locked: % occurrence(s) in the queued successor (expected 1)', occ_queued;
  end if;
end`,
  }),

  // ── 11. Confirm-receipt reminders (migration 118: GV-286) ────────────────────
  // After migration 117 removed the 3-day auto-confirm, a paid_pending claim hangs
  // until the CREDITOR confirms — so nudge the creditor. Two-phase claim/confirm with
  // a per-lease token (mirrors migrations 102/106); both RPCs are service-role only.
  rpcCase({
    name: "confirm-reminder-claim-authenticated-denied",
    desc: "creditor A (authenticated) cannot call the service-role claim RPC (execute denied, 42501)",
    actor: A,
    op: `perform public.claim_due_confirm_reminders(200);`,
    expect: "42501",
  }),
  rpcCase({
    name: "confirm-reminder-confirm-authenticated-denied",
    desc: "debtor B (authenticated) cannot call the service-role confirm RPC (execute denied, 42501)",
    actor: B,
    op: `perform public.confirm_confirm_reminders('[]'::jsonb);`,
    expect: "42501",
  }),
  queryCase({
    name: "confirm-reminder-grace-boundary",
    desc: "a paid_pending claim inside the 24h grace window is NOT claimed; once older than 24h it is (GV-286)",
    setup: SETUP_DUE_PP(12), // 12h old → still inside the grace window
    actor: SERVICE,
    assert: `declare rows integer;
begin
  ${CLAIM_CONFIRM_BA_COUNT};
  if rows <> 0 then
    raise exception 'CASEFAIL confirm-reminder-grace-boundary: a 12h-old claim was claimed (expected 0 — inside the 24h grace)';
  end if;
  update public.settlement_requests set paid_claimed_at = now() - interval '25 hours'
    where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  ${CLAIM_CONFIRM_BA_COUNT};
  if rows <> 1 then
    raise exception 'CASEFAIL confirm-reminder-grace-boundary: a 25h-old claim was not claimed (expected 1)';
  end if;
end`,
  }),
  queryCase({
    name: "confirm-reminder-cadence-boundary",
    desc: "a due claim nudged <24h ago is NOT re-claimed; >24h ago it is (GV-286 once-per-24h)",
    setup: [
      ...SETUP_DUE_PP(72), // 3-day-old claim, well past the grace window
      step(SUPER, `update public.settlement_requests set last_confirm_reminder_at = now() - interval '12 hours'
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: SERVICE,
    assert: `declare rows integer;
begin
  ${CLAIM_CONFIRM_BA_COUNT};
  if rows <> 0 then
    raise exception 'CASEFAIL confirm-reminder-cadence-boundary: re-claimed 12h after the last reminder (expected 0)';
  end if;
  update public.settlement_requests set last_confirm_reminder_at = now() - interval '25 hours'
    where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  ${CLAIM_CONFIRM_BA_COUNT};
  if rows <> 1 then
    raise exception 'CASEFAIL confirm-reminder-cadence-boundary: not re-claimed 25h after the last reminder (expected 1)';
  end if;
end`,
  }),
  queryCase({
    name: "confirm-reminder-lease-and-token-gated-confirm",
    desc: "claim leases the row (no re-claim within 15 min); confirm advances the cadence only with the live lease's token, a wrong token is a no-op (GV-286 / migration 106 discipline)",
    setup: SETUP_DUE_PP(48),
    actor: SERVICE,
    assert: `declare rid uuid; tok uuid; n integer; rows integer; last_at timestamptz; lease timestamptz; leftover uuid;
begin
  -- Claim → 15-min lease + fresh token, returned to the caller.
  select request_id, claim_token into rid, tok from public.claim_due_confirm_reminders(200)
    where request_id = (select id from public.settlement_requests
      where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}');
  if rid is null or tok is null then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: the due claim was not claimed';
  end if;
  -- A second claim within the live lease window must NOT re-claim the row.
  ${CLAIM_CONFIRM_BA_COUNT};
  if rows <> 0 then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: row re-claimed while its lease is live (expected 0)';
  end if;
  -- A WRONG token neither advances the cadence nor clears the lease.
  n := public.confirm_confirm_reminders(jsonb_build_array(jsonb_build_object(
    'id', rid, 'token', gen_random_uuid(), 'outcome', 'delivered')));
  select last_confirm_reminder_at, confirm_reminder_claimed_at into last_at, lease
    from public.settlement_requests where id = rid;
  if n <> 0 or last_at is not null or lease is null then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: a wrong token advanced state (confirmed=% last=% lease=%)', n, last_at, lease;
  end if;
  -- The RIGHT token advances the cadence, clears the lease + token, logs the outcome.
  n := public.confirm_confirm_reminders(jsonb_build_array(jsonb_build_object(
    'id', rid, 'token', tok, 'outcome', 'delivered')));
  select last_confirm_reminder_at, confirm_reminder_claimed_at, confirm_reminder_claim_token
    into last_at, lease, leftover from public.settlement_requests where id = rid;
  if n <> 1 or last_at is null or lease is not null or leftover is not null then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: the live token did not finalize (confirmed=% last=% lease=% token=%)', n, last_at, lease, leftover;
  end if;
  if not exists (select 1 from public.ledger_events
    where ledger_id = '${WS1}' and event_type = 'confirm_reminder_sent'
      and metadata->>'settlement_request_id' = rid::text and metadata->>'outcome' = 'delivered') then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: no confirm_reminder_sent event carrying the outcome';
  end if;
  if not exists (select 1 from public.settlement_request_events
    where settlement_request_id = rid and event_type = 'confirmation_reminder_sent'
      and actor_member_id is null and occurred_at = last_at) then
    raise exception 'CASEFAIL confirm-reminder-lease-and-token-gated-confirm: no durable confirmation reminder event';
  end if;
end`,
  }),

  // ── 12. GV-293: settlement amount immutability via DIRECT authenticated writes ─
  // Finding 1 — enforce_settlement_request_exact_amount (migration 117) early-returned
  // for any row whose new status was not 'requested', and only guarded the paid_pending
  // dispute edge, so a settlement party could rewrite the amount through a direct
  // PostgREST UPDATE (RLS lets from/to members update their own request) while claiming,
  // confirming, or cancelling a payment. The generalized guard rejects any change to the
  // ledger/period/pair/amount/currency on ANY transition whose result is not 'requested'
  // (23514) while status-only moves and the dispute path stay allowed. These cases hit
  // the TABLE trigger directly, not the RPC (which has its own GV-259 lock).
  rpcCase({
    name: "direct-requested-to-paidpending-changed-amount-blocked",
    desc: "payer B directly UPDATEs requested->paid_pending with a CHANGED amount -> trigger rejects 23514",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: `update public.settlement_requests set status = 'paid_pending', amount = 250
         where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`,
    expect: "23514",
    post: ASSERT_BA_REQUESTED,
  }),
  rpcCase({
    name: "direct-requested-to-paidpending-same-amount-ok",
    desc: "payer B directly UPDATEs requested->paid_pending keeping the amount -> allowed (status-only)",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: `update public.settlement_requests set status = 'paid_pending'
         where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`,
    expect: "ok",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300)
      then raise exception 'CASEFAIL direct-requested-to-paidpending-same-amount-ok: expected paid_pending at 300'; end if;`,
  }),
  rpcCase({
    name: "direct-paidpending-to-paid-changed-amount-blocked",
    desc: "recipient A directly UPDATEs paid_pending->paid with a CHANGED amount -> trigger rejects 23514",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `update public.settlement_requests set status = 'paid_pending'
        where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: A,
    op: `update public.settlement_requests set status = 'paid', amount = 275
         where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`,
    expect: "23514",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300)
      then raise exception 'CASEFAIL direct-paidpending-to-paid-changed-amount-blocked: claim changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "direct-lifecycle-claim-confirm-same-pair-ok",
    desc: "direct-write lifecycle request->paid_pending->paid with the pair unchanged still works end to end",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `update public.settlement_requests set status = 'paid_pending'
        where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: A,
    op: `update public.settlement_requests set status = 'paid'
         where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`,
    expect: "ok",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid' and amount = 300)
      then raise exception 'CASEFAIL direct-lifecycle-claim-confirm-same-pair-ok: expected paid at 300'; end if;`,
  }),
  rpcCase({
    name: "direct-dispute-preserving-amount-ok",
    desc: "recipient A directly disputes (paid_pending->requested) preserving the amount -> allowed",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `update public.settlement_requests set status = 'paid_pending'
        where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: A,
    op: `update public.settlement_requests set status = 'requested'
         where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`,
    expect: "ok",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'requested' and amount = 300)
      then raise exception 'CASEFAIL direct-dispute-preserving-amount-ok: expected requested at 300'; end if;`,
  }),

  // ── 13. Migration 121: complete period ownership + old/new boundaries ──────
  rpcCase({
    name: "direct-request-cross-ledger-period-blocked",
    desc: "creditor cannot insert a ws1 request carrying ws2's period id",
    actor: A,
    op: `insert into public.settlement_requests
         (ledger_id, period_id, from_member_id, to_member_id, amount, currency, status, requested_by_member_id)
         values ('${WS1}', '${P2}', '${ID.B}', '${A_ID}', 999, 'DKK', 'requested', '${A_ID}');`,
    expect: "23514",
  }),
  rpcCase({
    name: "direct-entry-cross-ledger-period-blocked",
    desc: "member cannot hide a ws1 trip behind ws2's open period id",
    actor: B,
    op: `insert into public.trips
         (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
         values ('${WS1}', '${P2}', '${ID.B}', current_date, 1300, 1310, '${ID.B}');`,
    expect: "23514",
  }),
  rpcCase({
    name: "direct-entry-cannot-move-from-closed-period",
    desc: "creator cannot move a historical trip from its old closed period into the open period",
    setup: [step(SUPER, `insert into public.settlement_periods
        (id, ledger_id, status, label, opened_at, closed_at)
        values ('a9a9a9a9-0000-0000-0000-000000000121', '${WS1}', 'closed', 'Historical boundary', now() - interval '10 days', now() - interval '5 days');
      perform set_config('govehlo.pii_scrub', '1', true);
      insert into public.trips
        (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
      values ('b9b9b9b9-0000-0000-0000-000000000121', '${WS1}',
        'a9a9a9a9-0000-0000-0000-000000000121', '${ID.B}', current_date - 7, 800, 810, '${ID.B}');
      perform set_config('govehlo.pii_scrub', '', true);`)],
    actor: B,
    op: `update public.trips set period_id = '${P1}'
         where id = 'b9b9b9b9-0000-0000-0000-000000000121';`,
    expect: "22023",
  }),
  rpcCase({
    name: "direct-repair-binds-open-period",
    desc: "a direct repair insert without period_id is bound to the ledger's open period",
    actor: B,
    op: `insert into public.vehicle_repairs
         (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, paid_by_member_id)
         values ('c9c9c9c9-0000-0000-0000-000000000121', '${WS1}', current_date,
           'Direct repair boundary', 123, '${ID.B}', '${ID.B}');`,
    expect: "ok",
    post: `if (select period_id from public.vehicle_repairs
        where id = 'c9c9c9c9-0000-0000-0000-000000000121') is distinct from '${P1}'::uuid
      then raise exception 'CASEFAIL direct-repair-binds-open-period: repair did not bind to the open period'; end if;`,
  }),

  // ── 14. Migration 122: request-id transition commands ─────────────────────
  rpcCase({
    name: "transition-by-id-uses-canonical-request",
    desc: "debtor claims a request by id while the server preserves its stored amount and pair",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: `perform public.transition_settlement_request_status(
      (select id from public.settlement_requests
       where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
      'paid_pending', 'MobilePay ref 122');`,
    expect: "ok",
    post: `if not exists (select 1 from public.settlement_requests
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'
          and status = 'paid_pending' and amount = 300 and paid_note = 'MobilePay ref 122')
      then raise exception 'CASEFAIL transition-by-id-uses-canonical-request: canonical row was not claimed'; end if;`,
  }),
  rpcCase({
    name: "transition-by-id-retry-is-idempotent",
    desc: "retrying an already-paid-pending claim is a no-op and does not emit another event",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `perform public.transition_settlement_request_status(
        (select id from public.settlement_requests
         where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
        'paid_pending');`),
    ],
    actor: B,
    op: `perform public.transition_settlement_request_status(
      (select id from public.settlement_requests
       where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
      'paid_pending');`,
    expect: "ok",
    post: `if (select count(*) from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'payment_claimed'
          and metadata->>'settlement_request_id' = (select id::text from public.settlement_requests
            where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}')) <> 1
      then raise exception 'CASEFAIL transition-by-id-retry-is-idempotent: duplicate payment_claimed event'; end if;`,
  }),
  queryCase({
    name: "transition-by-id-lifecycle-journey",
    desc: "request-id commands carry one canonical request through claim, confirm, and an idempotent retry",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `perform public.transition_settlement_request_status(
        (select id from public.settlement_requests
         where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
        'paid_pending', 'MobilePay journey 122');`),
    ],
    actor: A,
    assert: `declare request_id uuid; confirm_result jsonb; retry_result jsonb;
      current_status text; current_amount numeric; claimed_at timestamptz;
      confirmed_at timestamptz; lifecycle_events integer;
begin
  select id into request_id
  from public.settlement_requests
  where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';

  confirm_result := public.transition_settlement_request_status(request_id, 'paid');
  retry_result := public.transition_settlement_request_status(request_id, 'paid');

  if confirm_result->>'settlement_request_id' is distinct from request_id::text
     or confirm_result->>'status' is distinct from 'paid'
     or coalesce((confirm_result->>'noop')::boolean, true) then
    raise exception 'CASEFAIL transition-by-id-lifecycle-journey: invalid confirm result %', confirm_result;
  end if;
  if retry_result->>'status' is distinct from 'paid'
     or not coalesce((retry_result->>'noop')::boolean, false) then
    raise exception 'CASEFAIL transition-by-id-lifecycle-journey: retry was not an idempotent paid no-op %', retry_result;
  end if;

  select status, amount, paid_claimed_at, paid_at
    into current_status, current_amount, claimed_at, confirmed_at
  from public.settlement_requests
  where id = request_id;
  if current_status is distinct from 'paid' or current_amount is distinct from 300::numeric then
    raise exception 'CASEFAIL transition-by-id-lifecycle-journey: status=% amount=%', current_status, current_amount;
  end if;
  if claimed_at is null or confirmed_at is null then
    raise exception 'CASEFAIL transition-by-id-lifecycle-journey: claimed_at=% paid_at=%', claimed_at, confirmed_at;
  end if;

  select count(*) into lifecycle_events
  from public.ledger_events
  where ledger_id = '${WS1}'
    and event_type in ('payment_requested', 'payment_claimed', 'payment_paid')
    and metadata->>'settlement_request_id' = request_id::text;
  if lifecycle_events <> 3 then
    raise exception 'CASEFAIL transition-by-id-lifecycle-journey: lifecycle events=% (expected 3)', lifecycle_events;
  end if;
end`,
  }),
  rpcCase({
    name: "transition-by-id-bystander-blocked",
    desc: "an unrelated active member cannot transition another pair's request by id",
    setup: [step(A, CREATE_REQ_300)],
    actor: C,
    op: `perform public.transition_settlement_request_status(
      (select id from public.settlement_requests
       where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
      'paid_pending');`,
    expect: "42501",
    post: ASSERT_BA_REQUESTED,
  }),
  rpcCase({
    name: "transition-batch-rolls-back-on-late-failure",
    desc: "a valid first claim is rolled back when a later request has an invalid transition",
    setup: [step(SUPER, `insert into public.settlement_requests
        (id, ledger_id, period_id, from_member_id, to_member_id, amount, currency, status, requested_by_member_id)
      values
        ('00000000-0000-0000-0000-000000000122', '${WS1}', '${P1}', '${ID.B}', '${A_ID}', 300, 'DKK', 'requested', '${A_ID}'),
        ('ffffffff-ffff-ffff-ffff-fffffffff122', '${WS1}', '${P1}', '${ID.B}', '${ID.C}', 10, 'DKK', 'open', '${ID.C}');`)],
    actor: B,
    op: `perform public.transition_settlement_requests_status(
      array['00000000-0000-0000-0000-000000000122'::uuid,
            'ffffffff-ffff-ffff-ffff-fffffffff122'::uuid],
      'paid_pending');`,
    expect: "22023",
    post: `if (select status from public.settlement_requests
        where id = '00000000-0000-0000-0000-000000000122') is distinct from 'requested'
      then raise exception 'CASEFAIL transition-batch-rolls-back-on-late-failure: first request was partially committed'; end if;
      if (select status from public.settlement_requests
        where id = 'ffffffff-ffff-ffff-ffff-fffffffff122') is distinct from 'open'
      then raise exception 'CASEFAIL transition-batch-rolls-back-on-late-failure: second request changed unexpectedly'; end if;`,
  }),

  // ── Operator workspace decommission lifecycle (migration 132, GV-316) ──────
  rpcCase({
    name: "workspace-soft-delete-authenticated-blocked",
    desc: "an authenticated workspace admin cannot decommission a workspace (service-role-only)",
    actor: A,
    op: `perform public.admin_soft_delete_workspace('${WS1}');`,
    expect: "42501",
    post: `if (select deleted_at from public.ledgers where id = '${WS1}') is not null
      then raise exception 'CASEFAIL workspace-soft-delete-authenticated-blocked: workspace was decommissioned'; end if;`,
  }),
  rpcCase({
    name: "workspace-restore-authenticated-blocked",
    desc: "an authenticated workspace admin cannot restore a workspace (service-role-only)",
    actor: A,
    op: `perform public.admin_restore_workspace('${WS1}');`,
    expect: "42501",
  }),
  rpcCase({
    name: "workspace-soft-delete-service-role-emits-event",
    desc: "service role decommissions a workspace and writes a Danish notification event with a system actor",
    actor: SERVICE,
    op: SOFT_DELETE_WS1,
    expect: "ok",
    post: `if (select deleted_at from public.ledgers where id = '${WS1}') is null
      then raise exception 'CASEFAIL workspace-soft-delete-service-role-emits-event: deleted_at not stamped'; end if;
      if not exists (
        select 1 from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'workspace_decommissioned'
          and actor_member_id is null and actor_email is null
          and body like '%slettes permanent efter 90 dage%'
      ) then raise exception 'CASEFAIL workspace-soft-delete-service-role-emits-event: notification event missing'; end if;`,
  }),
  // GV-328 idempotency contract: a repeat soft-delete of a tombstoned workspace
  // (and a restore of a live one) is now an honest NO-OP — alreadyApplied=true
  // with NO second lifecycle event — instead of migration 132's mislabelled
  // 22023 "already decommissioned" error.
  queryCase({
    name: "workspace-soft-delete-idempotent-noop",
    desc: "repeating soft-delete on a tombstoned workspace is a no-op (alreadyApplied, no acks required) and emits exactly one decommission event",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: SERVICE,
    // The repeat call passes NO acknowledgements (bare one-arg): migration 135's
    // alreadyApplied no-op path must not require them, since nothing new happens.
    assert: `declare result jsonb; n_events int;
begin
  result := public.admin_soft_delete_workspace('${WS1}');
  if coalesce((result->>'alreadyApplied')::boolean, false) is not true then
    raise exception 'CASEFAIL workspace-soft-delete-idempotent-noop: expected alreadyApplied=true, got %', result;
  end if;
  select count(*) into n_events from public.ledger_events
    where ledger_id = '${WS1}' and event_type = 'workspace_decommissioned';
  if n_events <> 1 then
    raise exception 'CASEFAIL workspace-soft-delete-idempotent-noop: expected exactly 1 decommission event, got %', n_events;
  end if;
end`,
  }),
  queryCase({
    name: "workspace-restore-live-idempotent-noop",
    desc: "restoring a workspace that is already live is a no-op (alreadyApplied) and emits no restore event",
    actor: SERVICE,
    assert: `declare result jsonb; n_events int;
begin
  result := public.admin_restore_workspace('${WS1}');
  if coalesce((result->>'alreadyApplied')::boolean, false) is not true then
    raise exception 'CASEFAIL workspace-restore-live-idempotent-noop: expected alreadyApplied=true, got %', result;
  end if;
  select count(*) into n_events from public.ledger_events
    where ledger_id = '${WS1}' and event_type = 'workspace_restored';
  if n_events <> 0 then
    raise exception 'CASEFAIL workspace-restore-live-idempotent-noop: expected 0 restore events, got %', n_events;
  end if;
end`,
  }),
  rpcCase({
    name: "workspace-restore-after-grace-rejected",
    desc: "restoring a workspace whose tombstone has outlived the 90-day grace window is rejected (purge-pending, errcode GV328)",
    setup: [step(SUPER, `update public.ledgers set deleted_at = now() - interval '91 days' where id = '${WS1}';`)],
    actor: SERVICE,
    op: `perform public.admin_restore_workspace('${WS1}');`,
    expect: "GV328",
    post: `if (select deleted_at from public.ledgers where id = '${WS1}') is null
      then raise exception 'CASEFAIL workspace-restore-after-grace-rejected: tombstone was cleared despite expired grace window'; end if;`,
  }),
  queryCase({
    name: "workspace-lifecycle-rpcs-lock-row-for-update",
    desc: "both lifecycle RPCs take select ... for update on the ledgers row so concurrent calls serialize (GV-328 concurrency guard present in the function body)",
    actor: SUPER,
    assert: `declare soft_def text; restore_def text;
begin
  soft_def := lower(pg_get_functiondef('public.admin_soft_delete_workspace(text, boolean, boolean, text)'::regprocedure));
  restore_def := lower(pg_get_functiondef('public.admin_restore_workspace(text)'::regprocedure));
  if position('for update' in soft_def) = 0 then
    raise exception 'CASEFAIL workspace-lifecycle-rpcs-lock-row-for-update: admin_soft_delete_workspace has no FOR UPDATE row lock';
  end if;
  if position('for update' in restore_def) = 0 then
    raise exception 'CASEFAIL workspace-lifecycle-rpcs-lock-row-for-update: admin_restore_workspace has no FOR UPDATE row lock';
  end if;
end`,
  }),
  queryCase({
    name: "workspace-soft-delete-hides-from-member",
    desc: "after decommission a member sees nothing of the workspace (ledger, trips, requests, members)",
    setup: [
      step(A, CREATE_REQ_300),
      step(SERVICE, SOFT_DELETE_WS1),
    ],
    actor: B,
    assert: `declare n_ledger int; n_trips int; n_req int; n_members int;
begin
  select count(*) into n_ledger from public.ledgers where id = '${WS1}';
  select count(*) into n_trips from public.trips where ledger_id = '${WS1}';
  select count(*) into n_req from public.settlement_requests where ledger_id = '${WS1}';
  select count(*) into n_members from public.ledger_members where ledger_id = '${WS1}';
  if n_ledger <> 0 or n_trips <> 0 or n_req <> 0 or n_members <> 0 then
    raise exception 'CASEFAIL workspace-soft-delete-hides-from-member: B saw ledger=% trips=% requests=% members=% (expected 0/0/0/0)', n_ledger, n_trips, n_req, n_members;
  end if;
end`,
  }),
  rpcCase({
    name: "workspace-soft-delete-blocks-member-rls-write",
    desc: "after decommission a member's direct trip insert is rejected by RLS",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: A,
    op: `insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
         values ('${WS1}', '${P1}', '${A_ID}', current_date, 5000, 5100, '${A_ID}');`,
    expect: "42501",
  }),
  rpcCase({
    name: "workspace-soft-delete-blocks-member-rpc-write",
    desc: "after decommission a member's presence heartbeat is rejected (membership no longer resolves)",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: B,
    op: `perform public.touch_member_presence('${WS1}');`,
    expect: "22023",
  }),
  queryCase({
    name: "workspace-restore-brings-visibility-back",
    desc: "restoring a decommissioned workspace makes it visible to its members again",
    setup: [
      step(SERVICE, SOFT_DELETE_WS1),
      step(SERVICE, `perform public.admin_restore_workspace('${WS1}');`),
    ],
    actor: B,
    assert: `declare n_ledger int; n_trips int; n_members int;
begin
  select count(*) into n_ledger from public.ledgers where id = '${WS1}';
  select count(*) into n_trips from public.trips where ledger_id = '${WS1}';
  select count(*) into n_members from public.ledger_members where ledger_id = '${WS1}';
  if n_ledger < 1 or n_trips < 1 or n_members < 1 then
    raise exception 'CASEFAIL workspace-restore-brings-visibility-back: B saw ledger=% trips=% members=% (expected all >=1)', n_ledger, n_trips, n_members;
  end if;
end`,
  }),
  queryCase({
    name: "retention-purges-past-window-workspace-only",
    desc: "retention permanently purges a workspace past the 90-day grace window but keeps an in-window tombstone",
    setup: [step(SUPER, `update public.ledgers set deleted_at = now() - interval '100 days' where id = '${WS2}';
        update public.ledgers set deleted_at = now() - interval '10 days' where id = '${WS1}';`)],
    actor: SERVICE,
    assert: `declare result jsonb;
begin
  result := public.run_operational_retention(180, false);
  if exists (select 1 from public.ledgers where id = '${WS2}') then
    raise exception 'CASEFAIL retention-purges-past-window-workspace-only: past-window workspace survived';
  end if;
  if not exists (select 1 from public.ledgers where id = '${WS1}') then
    raise exception 'CASEFAIL retention-purges-past-window-workspace-only: in-window workspace was purged early';
  end if;
  if (result->>'purgedWorkspaces')::integer <> 1 then
    raise exception 'CASEFAIL retention-purges-past-window-workspace-only: purgedWorkspaces=% (expected 1)', result->>'purgedWorkspaces';
  end if;
end`,
  }),
  queryCase({
    name: "workspace-soft-delete-excluded-from-list-my-ledgers",
    desc: "a soft-deleted workspace drops out of the member's list_my_ledgers switcher/resolver",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: B,
    assert: `if exists (select 1 from public.list_my_ledgers() where ledger_id = '${WS1}') then
      raise exception 'CASEFAIL workspace-soft-delete-excluded-from-list-my-ledgers: soft-deleted workspace still listed';
    end if`,
  }),
  queryCase({
    name: "workspace-soft-delete-invite-resolve-reveals-nothing",
    desc: "resolving a decommissioned workspace's join code reveals nothing",
    setup: [
      step(SUPER, `update public.ledgers set join_code = 'NEDLAGT99' where id = '${WS1}';`),
      step(SERVICE, SOFT_DELETE_WS1),
    ],
    actor: C,
    assert: `if (select count(*) from public.resolve_ledger_invite('NEDLAGT99')) <> 0 then
      raise exception 'CASEFAIL workspace-soft-delete-invite-resolve-reveals-nothing: resolve returned a decommissioned workspace';
    end if`,
  }),
  rpcCase({
    name: "workspace-soft-delete-invite-redeem-blocked",
    desc: "no one can redeem an invite into a decommissioned workspace",
    setup: [
      step(SUPER, `update public.ledgers set join_code = 'NEDLAGT99' where id = '${WS1}';`),
      step(SERVICE, SOFT_DELETE_WS1),
    ],
    actor: E,
    op: `perform public.redeem_ledger_invite('NEDLAGT99');`,
    expect: "P0001",
  }),

  // ── GV-333: decommission attestation + get_my_decommissioned_workspaces ─────
  // The durable in-app decommission notice (migration 134) deliberately crosses the
  // deleted_at boundary that hides a tombstoned workspace from its members, so its
  // visibility rules and its post-135 grants matter. get_my_decommissioned_workspaces
  // reproduces is_ledger_member EXCEPT the deleted_at gate: exactly the tombstoned
  // workspaces the ACTIVE caller still belongs to, and nothing else.
  queryCase({
    name: "decommissioned-notice-active-member-sees-own-row",
    desc: "an active member of a tombstoned workspace sees exactly its row with purge_after = deleted_at + 90 days",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: B,
    assert: `declare r record; n int;
begin
  select count(*) into n from public.get_my_decommissioned_workspaces();
  if n <> 1 then
    raise exception 'CASEFAIL decommissioned-notice-active-member-sees-own-row: expected exactly 1 notice, got %', n;
  end if;
  select * into r from public.get_my_decommissioned_workspaces();
  if r.ledger_id <> '${WS1}' then
    raise exception 'CASEFAIL decommissioned-notice-active-member-sees-own-row: expected ledger_id ${WS1}, got %', r.ledger_id;
  end if;
  if r.deleted_at is null then
    raise exception 'CASEFAIL decommissioned-notice-active-member-sees-own-row: deleted_at was null on a tombstoned workspace';
  end if;
  if r.purge_after is distinct from (r.deleted_at + interval '90 days') then
    raise exception 'CASEFAIL decommissioned-notice-active-member-sees-own-row: purge_after (%) is not deleted_at + 90 days (%)', r.purge_after, r.deleted_at + interval '90 days';
  end if;
end`,
  }),
  queryCase({
    name: "decommissioned-notice-non-member-sees-nothing",
    desc: "a non-member (E, in another workspace) sees no decommission notice for the tombstoned workspace",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: E,
    assert: `declare n int;
begin
  select count(*) into n from public.get_my_decommissioned_workspaces();
  if n <> 0 then
    raise exception 'CASEFAIL decommissioned-notice-non-member-sees-nothing: non-member E saw % notice(s)', n;
  end if;
end`,
  }),
  queryCase({
    name: "decommissioned-notice-inactive-member-sees-nothing",
    desc: "an inactive (is_active=false) member of a tombstoned workspace sees no decommission notice",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: D,
    assert: `declare n int;
begin
  select count(*) into n from public.get_my_decommissioned_workspaces();
  if n <> 0 then
    raise exception 'CASEFAIL decommissioned-notice-inactive-member-sees-nothing: inactive member D saw % notice(s)', n;
  end if;
end`,
  }),
  rpcCase({
    name: "decommissioned-notice-anon-execute-denied",
    desc: "the anon role cannot execute get_my_decommissioned_workspaces (migration 135 revokes the implicit PUBLIC/anon grant; authenticated only)",
    actor: ANON,
    op: `perform public.get_my_decommissioned_workspaces();`,
    expect: "42501",
  }),
  queryCase({
    name: "decommissioned-notice-cleared-after-restore",
    desc: "after admin_restore_workspace the decommission notice disappears for the member",
    setup: [
      step(SERVICE, SOFT_DELETE_WS1),
      step(SERVICE, `perform public.admin_restore_workspace('${WS1}');`),
    ],
    actor: B,
    assert: `if exists (select 1 from public.get_my_decommissioned_workspaces() where ledger_id = '${WS1}') then
      raise exception 'CASEFAIL decommissioned-notice-cleared-after-restore: a restored workspace still shows a decommission notice';
    end if`,
  }),
  queryCase({
    name: "decommissioned-notice-gone-after-purge",
    desc: "after the retention sweep permanently purges the workspace, its decommission notice is gone",
    setup: [
      step(SERVICE, SOFT_DELETE_WS1),
      step(SUPER, `update public.ledgers set deleted_at = now() - interval '100 days' where id = '${WS1}';`),
      step(SERVICE, `perform public.run_operational_retention(180, false);`),
    ],
    actor: B,
    assert: `begin
  if exists (select 1 from public.ledgers where id = '${WS1}') then
    raise exception 'CASEFAIL decommissioned-notice-gone-after-purge: workspace was not purged (precondition)';
  end if;
  if exists (select 1 from public.get_my_decommissioned_workspaces() where ledger_id = '${WS1}') then
    raise exception 'CASEFAIL decommissioned-notice-gone-after-purge: purged workspace still shows a decommission notice';
  end if;
end`,
  }),
  // GV-333 atomic attestation: a NEW soft-delete requires both acknowledgements and
  // writes exactly one durable owner_activity_log row IN THE SAME TRANSACTION.
  queryCase({
    name: "workspace-soft-delete-writes-durable-attestation",
    desc: "a successful decommission writes exactly one owner_activity_log attestation row (acks recorded, source=rpc, NULL ledger_id so it survives the purge cascade)",
    setup: [step(SERVICE, SOFT_DELETE_WS1)],
    actor: SERVICE,
    assert: `declare n int; m jsonb;
begin
  select count(*) into n from public.owner_activity_log oal
    where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc';
  if n <> 1 then
    raise exception 'CASEFAIL workspace-soft-delete-writes-durable-attestation: expected exactly 1 rpc attestation row, got %', n;
  end if;
  select oal.metadata into m from public.owner_activity_log oal
    where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc' limit 1;
  if (m->'acknowledgements'->>'exportOffered') is distinct from 'true'
     or (m->'acknowledgements'->>'noLegalHold') is distinct from 'true' then
    raise exception 'CASEFAIL workspace-soft-delete-writes-durable-attestation: attestation acknowledgements not both true (%)', m;
  end if;
  if exists (
    select 1 from public.owner_activity_log oal
    where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc'
      and oal.ledger_id is not null
  ) then
    raise exception 'CASEFAIL workspace-soft-delete-writes-durable-attestation: attestation row has a non-null ledger_id (would cascade-delete at the 90-day purge)';
  end if;
  if not exists (
    select 1 from public.owner_activity_log oal
    where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc'
      and oal.actor_role = 'owner' and oal.actor_email = '${OP_EMAIL}'
      and oal.workspace_label is not null and (oal.metadata->>'ledgerId') = '${WS1}'
  ) then
    raise exception 'CASEFAIL workspace-soft-delete-writes-durable-attestation: attestation row shape (owner/actor_email/workspace_label/metadata.ledgerId) is wrong';
  end if;
end`,
  }),
  queryCase({
    name: "workspace-soft-delete-attestation-survives-purge",
    desc: "the decommission attestation survives the 90-day workspace-purge cascade (NULL ledger_id keeps it out of ON DELETE CASCADE)",
    setup: [
      step(SERVICE, SOFT_DELETE_WS1),
      step(SUPER, `update public.ledgers set deleted_at = now() - interval '100 days' where id = '${WS1}';`),
      step(SERVICE, `perform public.run_operational_retention(180, false);`),
    ],
    actor: SERVICE,
    assert: `declare n int;
begin
  if exists (select 1 from public.ledgers where id = '${WS1}') then
    raise exception 'CASEFAIL workspace-soft-delete-attestation-survives-purge: workspace was not purged (precondition)';
  end if;
  select count(*) into n from public.owner_activity_log oal
    where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc'
      and (oal.metadata->>'ledgerId') = '${WS1}';
  if n <> 1 then
    raise exception 'CASEFAIL workspace-soft-delete-attestation-survives-purge: attestation row did not survive the purge (found %)', n;
  end if;
end`,
  }),
  rpcCase({
    name: "workspace-soft-delete-rejects-false-acknowledgement",
    desc: "a NEW decommission with a false acknowledgement is rejected (errcode GV333); nothing is tombstoned or journaled",
    actor: SERVICE,
    op: `perform public.admin_soft_delete_workspace('${WS1}', true, false, '${OP_EMAIL}');`,
    expect: "GV333",
    post: `if (select deleted_at from public.ledgers where id = '${WS1}') is not null then
      raise exception 'CASEFAIL workspace-soft-delete-rejects-false-acknowledgement: workspace was tombstoned despite a rejected acknowledgement';
    end if;
    if exists (
      select 1 from public.owner_activity_log oal
      where oal.action = 'owner.workspace.decommission' and (oal.metadata->>'source') = 'rpc'
    ) then
      raise exception 'CASEFAIL workspace-soft-delete-rejects-false-acknowledgement: an attestation row was written despite a rejected acknowledgement';
    end if;`,
  }),
  rpcCase({
    name: "workspace-soft-delete-rejects-omitted-acknowledgements",
    desc: "a NEW decommission called without acknowledgements (both default null) is rejected (errcode GV333)",
    actor: SERVICE,
    op: `perform public.admin_soft_delete_workspace('${WS1}');`,
    expect: "GV333",
    post: `if (select deleted_at from public.ledgers where id = '${WS1}') is not null then
      raise exception 'CASEFAIL workspace-soft-delete-rejects-omitted-acknowledgements: workspace was tombstoned despite omitted acknowledgements';
    end if;`,
  }),

  // ── GV-336: durable settlement event history (migration 137) ──────────────
  queryCase({
    name: "settlement-history-captures-lifecycle-once",
    desc: "request, claim, confirm, and an idempotent retry produce one exact durable event per lifecycle edge",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, `perform public.transition_settlement_request_status(
        (select id from public.settlement_requests
         where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
        'paid_pending');`),
    ],
    actor: A,
    assert: `declare rid uuid; total_events integer; matching_events integer;
begin
  select id into rid from public.settlement_requests
  where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';

  perform public.transition_settlement_request_status(rid, 'paid');
  perform public.transition_settlement_request_status(rid, 'paid');

  select count(*) into total_events
  from public.settlement_request_events
  where settlement_request_id = rid;
  if total_events <> 4 then
    raise exception 'CASEFAIL settlement-history-captures-lifecycle-once: events=%', total_events;
  end if;

  select count(*) into matching_events
  from public.settlement_request_events
  where settlement_request_id = rid
    and (
      (event_type = 'calculated' and from_status is null and to_status = 'open')
      or (event_type = 'requested' and from_status = 'open' and to_status = 'requested'
          and actor_member_id = '${A_ID}'::uuid)
      or (event_type = 'marked_paid' and from_status = 'requested' and to_status = 'paid_pending'
          and actor_member_id = '${ID.B}'::uuid)
      or (event_type = 'confirmed' and from_status = 'paid_pending' and to_status = 'paid'
          and actor_member_id = '${A_ID}'::uuid)
    );
  if matching_events <> 4 then
    raise exception 'CASEFAIL settlement-history-captures-lifecycle-once: matching events=%', matching_events;
  end if;
  if exists (
    select 1 from public.settlement_request_events
    where settlement_request_id = rid and event_source <> 'live'
  ) then
    raise exception 'CASEFAIL settlement-history-captures-lifecycle-once: non-live source found';
  end if;
end`,
  }),
  queryCase({
    name: "settlement-history-captures-dispute",
    desc: "a creditor dispute is a distinct paid_pending-to-requested event with the creditor actor",
    setup: [
      step(A, CREATE_REQ_300),
      step(B, upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending")),
    ],
    actor: A,
    assert: `declare rid uuid; n integer;
begin
  select id into rid from public.settlement_requests
  where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  perform public.transition_settlement_request_status(rid, 'requested', 'Ikke modtaget');
  select count(*) into n from public.settlement_request_events
  where settlement_request_id = rid
    and event_type = 'disputed'
    and from_status = 'paid_pending'
    and to_status = 'requested'
    and actor_member_id = '${A_ID}'::uuid;
  if n <> 1 then
    raise exception 'CASEFAIL settlement-history-captures-dispute: matching disputes=%', n;
  end if;
end`,
  }),
  queryCase({
    name: "settlement-history-member-can-read-workspace",
    desc: "an active bystander member can read the workspace settlement history used by the shared timeline",
    setup: [step(A, CREATE_REQ_300)],
    actor: C,
    assert: `if (select count(*) from public.settlement_request_events where ledger_id = '${WS1}') <> 2 then
      raise exception 'CASEFAIL settlement-history-member-can-read-workspace: expected calculated + requested';
    end if`,
  }),
  queryCase({
    name: "settlement-history-outsider-isolated",
    desc: "a member of another workspace cannot read settlement history across the RLS boundary",
    setup: [step(A, CREATE_REQ_300)],
    actor: E,
    assert: `if exists (select 1 from public.settlement_request_events where ledger_id = '${WS1}') then
      raise exception 'CASEFAIL settlement-history-outsider-isolated: cross-workspace event leaked';
    end if`,
  }),
  rpcCase({
    name: "settlement-history-client-insert-denied",
    desc: "an authenticated workspace admin cannot forge an audit event",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: `insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, occurred_at
    ) values (
      (select id from public.settlement_requests
       where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}'),
      '${WS1}', 'confirmed', now()
    );`,
    expect: "42501",
  }),
  rpcCase({
    name: "settlement-history-client-update-denied",
    desc: "an authenticated workspace admin cannot rewrite a durable audit event",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: `update public.settlement_request_events set event_type = 'confirmed' where ledger_id = '${WS1}';`,
    expect: "42501",
  }),
  rpcCase({
    name: "settlement-history-client-delete-denied",
    desc: "an authenticated workspace admin cannot delete a durable audit event",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: `delete from public.settlement_request_events where ledger_id = '${WS1}';`,
    expect: "42501",
  }),
  queryCase({
    name: "settlement-history-schema-is-privacy-minimised",
    desc: "the durable table carries no amount, evidence note, email, token, or arbitrary metadata columns",
    actor: SUPER,
    assert: `declare leaked text[];
begin
  select array_agg(column_name order by column_name) into leaked
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'settlement_request_events'
    and column_name in (
      'amount', 'currency', 'paid_note', 'dispute_note', 'actor_email',
      'target_email', 'claim_token', 'push_token', 'metadata'
    );
  if leaked is not null then
    raise exception 'CASEFAIL settlement-history-schema-is-privacy-minimised: sensitive columns=%', leaked;
  end if;
end`,
  }),
  queryCase({
    name: "settlement-history-captures-payment-reminder",
    desc: "a token-confirmed payment reminder appends its exact durable reminder ordinal and timestamp",
    setup: [
      step(A, CREATE_REQ_300),
      step(SUPER, `update public.settlement_requests
        set requested_at = now() - interval '4 days'
        where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';`),
    ],
    actor: SERVICE,
    assert: `declare rid uuid; tok uuid; confirmed integer; reminder_at timestamptz;
begin
  select request_id, claim_token into rid, tok
  from public.claim_due_payment_reminders(200)
  where request_id = (select id from public.settlement_requests
    where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}');
  if rid is null or tok is null then
    raise exception 'CASEFAIL settlement-history-captures-payment-reminder: due request was not claimed';
  end if;
  confirmed := public.confirm_payment_reminders(jsonb_build_array(jsonb_build_object(
    'id', rid, 'token', tok, 'outcome', 'delivered')));
  select last_reminder_at into reminder_at from public.settlement_requests where id = rid;
  if confirmed <> 1 or reminder_at is null then
    raise exception 'CASEFAIL settlement-history-captures-payment-reminder: confirm=% at=%', confirmed, reminder_at;
  end if;
  if not exists (select 1 from public.settlement_request_events
    where settlement_request_id = rid and event_type = 'payment_reminder_sent'
      and reminder_number = 1 and actor_member_id is null and occurred_at = reminder_at) then
    raise exception 'CASEFAIL settlement-history-captures-payment-reminder: durable reminder event missing';
  end if;
end`,
  }),

  // ── 8. Vehicle incidents + photos (GVM-396) ───────────────────────────────
  rpcCase({
    name: "incident-member-logs",
    desc: "active member A logs a vehicle incident into their own workspace",
    actor: A,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Bulet doer', 'Parkeringsskade', null, null, null, 12345, 'open', 'SKADE-99', 'new_incident', 'Skade logget', 'A loggede en skade');`,
    expect: "ok",
    post: `if not exists (select 1 from public.vehicle_incidents
        where ledger_id = '${WS1}' and title = 'Bulet doer' and repair_status = 'open'
          and odometer = 12345 and insurance_ref = 'SKADE-99'
          and damage_kind = 'new_incident' and repair_id is null
          and reporter_member_id = '${A_ID}')
      then raise exception 'CASEFAIL incident-member-logs: incident row not created with reporter = caller'; end if;`,
  }),
  // ── GVM-521: existing damage vs new incident ──────────────────────────────
  // Through log_vehicle_incident / update_vehicle_incident, both of which the mobile
  // client already calls, so these cases certify a path production takes (GV-379).
  rpcCase({
    name: "incident-existing-damage-logged",
    desc: "a member can log damage that was ALREADY on the car as existing_damage (GVM-521)",
    actor: A,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Gammel bule', 'Var der da vi overtog bilen', null, null, null, null, 'open', null, 'existing_damage', 'Eksisterende skade', 'A registrerede en eksisterende skade');`,
    expect: "ok",
    post: `if (select damage_kind from public.vehicle_incidents where ledger_id = '${WS1}') <> 'existing_damage'
      then raise exception 'CASEFAIL incident-existing-damage-logged: damage_kind not stored'; end if;`,
  }),
  rpcCase({
    name: "incident-invalid-damage-kind-rejected",
    desc: "a damage kind outside the two allowed values is rejected before any row is written",
    actor: A,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Skade', 'Ridser', null, null, null, null, 'open', null, 'maybe', 't', 'b');`,
    expect: "22023",
    post: `if exists (select 1 from public.vehicle_incidents where ledger_id = '${WS1}')
      then raise exception 'CASEFAIL incident-invalid-damage-kind-rejected: a row was written anyway'; end if;`,
  }),
  rpcCase({
    name: "incident-reporter-can-reclassify",
    desc: "the reporter can move an incident to existing_damage after the fact (GVM-521)",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    op: `perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, null, null, null, null, null, 'existing_damage', 'Omklassificeret', 'Bo rettede skadetypen');`,
    expect: "ok",
    post: `if (select damage_kind from public.vehicle_incidents where ledger_id = '${WS1}') <> 'existing_damage'
      then raise exception 'CASEFAIL incident-reporter-can-reclassify: damage_kind not updated'; end if;`,
  }),
  rpcCase({
    name: "incident-old-client-edit-preserves-damage-kind",
    desc: "an edit that omits damage_kind_value leaves the stored classification alone (GV-417 shape)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(B, `perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, null, null, null, null, null, 'existing_damage', null, null);`),
    ],
    actor: B,
    op: `perform public.update_vehicle_incident(target_incident_id => ${LATEST_WS1_INCIDENT}, repair_status_value => 'under_repair');`,
    expect: "ok",
    post: `if (select damage_kind from public.vehicle_incidents where ledger_id = '${WS1}') <> 'existing_damage'
      then raise exception 'CASEFAIL incident-old-client-edit-preserves-damage-kind: a pre-GVM-521 client reclassified the incident'; end if;`,
  }),
  rpcCase({
    name: "incident-foreign-member-log-denied",
    desc: "member E of another workspace cannot log an incident into ws1",
    actor: E,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Fusk', 'Uautoriseret', null, null, null, null, 'open', null, 'new_incident', 'x', 'y');`,
    expect: "42501",
  }),
  rpcCase({
    name: "incident-anon-log-denied",
    desc: "anon cannot log an incident",
    actor: ANON,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Fusk', 'Uautoriseret', null, null, null, null, 'open', null, 'new_incident', 'x', 'y');`,
    expect: "42501",
  }),
  rpcCase({
    name: "incident-cross-workspace-booking-link-rejected",
    desc: "a booking from another workspace cannot be linked as the incident's booking",
    setup: [step(SUPER, `insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
      values ('44444444-0000-0000-0000-000000000001', '${WS2}', '${E_ID}', now() + interval '1 day', now() + interval '2 day', '${E_ID}');`)],
    actor: A,
    op: `perform public.log_vehicle_incident('${WS1}', current_date, 'Skade', 'Ridser', null, '44444444-0000-0000-0000-000000000001', null, null, 'open', null, 'new_incident', 't', 'b');`,
    expect: "22023",
  }),
  queryCase({
    name: "incident-member-can-read-workspace",
    desc: "a bystander member C can read incidents logged in their own workspace",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: C,
    assert: `if (select count(*) from public.vehicle_incidents where ledger_id = '${WS1}') < 1 then
      raise exception 'CASEFAIL incident-member-can-read-workspace: bystander member saw no incidents';
    end if`,
  }),
  queryCase({
    name: "incident-outsider-isolated",
    desc: "a member of another workspace cannot read ws1 incidents across the RLS boundary",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: E,
    assert: `if exists (select 1 from public.vehicle_incidents where ledger_id = '${WS1}') then
      raise exception 'CASEFAIL incident-outsider-isolated: cross-workspace incident leaked';
    end if`,
  }),
  rpcCase({
    name: "incident-nonadmin-nonreporter-edit-denied",
    desc: "bystander C (not admin, not reporter B) cannot edit the incident (GV-253)",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: C,
    op: `perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, 'under_repair', null, null, null, null, null, 'x', 'y');`,
    expect: "42501",
    post: `if (select repair_status from public.vehicle_incidents where ledger_id = '${WS1}') <> 'open'
      then raise exception 'CASEFAIL incident-nonadmin-nonreporter-edit-denied: status changed after rejection'; end if;`,
  }),
  rpcCase({
    name: "incident-reporter-can-edit",
    desc: "the reporter B can change their own incident's repair status",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    op: `perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, 'repaired', null, null, null, null, null, 'Skade repareret', 'Bo opdaterede status');`,
    expect: "ok",
    post: `if (select repair_status from public.vehicle_incidents where ledger_id = '${WS1}') <> 'repaired'
      then raise exception 'CASEFAIL incident-reporter-can-edit: status not updated'; end if;`,
  }),
  rpcCase({
    name: "incident-admin-can-edit",
    desc: "a workspace admin A (not the reporter) can edit the incident (GV-253)",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: A,
    op: `perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, 'closed', null, null, null, null, null, null, null);`,
    expect: "ok",
    post: `if (select repair_status from public.vehicle_incidents where ledger_id = '${WS1}') <> 'closed'
      then raise exception 'CASEFAIL incident-admin-can-edit: status not updated'; end if;`,
  }),
  queryCase({
    name: "incident-status-change-logs-event",
    desc: "an incident status edit with an event_title writes an incident_updated feed event",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: A,
    assert: `begin
  perform public.update_vehicle_incident(${LATEST_WS1_INCIDENT}, null, null, 'under_repair', null, null, null, null, null, 'Under reparation', 'A opdaterede status');
  if not exists (select 1 from public.ledger_events
    where ledger_id = '${WS1}' and event_type = 'incident_updated'
      and (metadata->>'repair_status') = 'under_repair') then
    raise exception 'CASEFAIL incident-status-change-logs-event: no incident_updated event with new status';
  end if;
end`,
  }),
  // ── GVM-521: set_incident_repair — the repair link's ONLY writer ───────────
  // Coverage was first pinned solely by tools/test-incident-repair-link-contract.mjs
  // on the "no client caller yet" argument; the mobile caller merged within hours
  // (govehlo-mobile #560), so the GV-379 coverage rule applies and the RPC is
  // exercised here like every other authenticated-granted function. The fixtures
  // are SUPER inserts (the matrix already carries open periods, so the
  // entry-period trigger is satisfied), with explicit ids per case isolation.
  rpcCase({
    name: "incident-repair-link-reporter",
    desc: "the reporter B links a live same-workspace repair to their incident (GVM-521)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
        values ('52100000-0000-0000-0000-000000000001', '${WS1}', current_date, 'Ny kofanger', 4200.00, '${A_ID}');`),
    ],
    actor: B,
    op: `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, '52100000-0000-0000-0000-000000000001'::uuid, null, null);`,
    expect: "ok",
    post: `if (select repair_id from public.vehicle_incidents where ledger_id = '${WS1}') is distinct from '52100000-0000-0000-0000-000000000001'::uuid
      then raise exception 'CASEFAIL incident-repair-link-reporter: repair_id not written'; end if;`,
  }),
  rpcCase({
    name: "incident-repair-unlink-null",
    desc: "null means UNLINK — a mis-linked repair is never permanent (GVM-521)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
        values ('52100000-0000-0000-0000-000000000002', '${WS1}', current_date, 'Lakering', 2500.00, '${A_ID}');`),
      step(B, `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, '52100000-0000-0000-0000-000000000002'::uuid, null, null);`),
    ],
    actor: B,
    op: `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, null, null, null);`,
    expect: "ok",
    post: `if (select repair_id from public.vehicle_incidents where ledger_id = '${WS1}') is not null
      then raise exception 'CASEFAIL incident-repair-unlink-null: null did not unlink'; end if;`,
  }),
  rpcCase({
    name: "incident-repair-link-bystander-denied",
    desc: "bystander C (not admin, not reporter) cannot re-attribute B's incident to a repair (GV-253)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
        values ('52100000-0000-0000-0000-000000000003', '${WS1}', current_date, 'Bremser', 900.00, '${A_ID}');`),
    ],
    actor: C,
    op: `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, '52100000-0000-0000-0000-000000000003'::uuid, null, null);`,
    expect: "42501",
    post: `if (select repair_id from public.vehicle_incidents where ledger_id = '${WS1}') is not null
      then raise exception 'CASEFAIL incident-repair-link-bystander-denied: link written after rejection'; end if;`,
  }),
  rpcCase({
    name: "incident-repair-link-foreign-denied",
    desc: "member E of another workspace cannot link anything to ws1's incident, even holding its id",
    // RLS already hides ws1's incidents from E, so resolving the id via a subquery
    // dies earlier (22023 Missing incident id) and never reaches the gate under
    // test. The incident is therefore SUPER-inserted with an explicit id: the pin
    // is that an outsider who somehow HOLDS a leaked id is still denied 42501.
    setup: [
      step(SUPER, `insert into public.vehicle_incidents (id, ledger_id, reporter_member_id, incident_date, title, description)
        values ('52100000-0000-0000-0000-000000000014', '${WS1}', '${ID.B}', current_date, 'Ridse i lak', 'Ridse ved parkering');`),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
        values ('52100000-0000-0000-0000-000000000004', '${WS1}', current_date, 'Ruder', 700.00, '${A_ID}');`),
    ],
    actor: E,
    op: `perform public.set_incident_repair('52100000-0000-0000-0000-000000000014'::uuid, '52100000-0000-0000-0000-000000000004'::uuid, null, null);`,
    expect: "42501",
    post: `if (select repair_id from public.vehicle_incidents where id = '52100000-0000-0000-0000-000000000014') is not null
      then raise exception 'CASEFAIL incident-repair-link-foreign-denied: link written after rejection'; end if;`,
  }),
  rpcCase({
    name: "incident-repair-crossws-rejected",
    desc: "ANOTHER workspace's repair is rejected — vehicle_repairs.id is globally unique, the FK alone accepts it (GVM-521)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id)
        values ('52100000-0000-0000-0000-000000000005', '${WS2}', current_date, 'Andres reparation', 9900.00, '${E_ID}');`),
    ],
    actor: B,
    op: `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, '52100000-0000-0000-0000-000000000005'::uuid, null, null);`,
    expect: "22023",
    post: `if (select repair_id from public.vehicle_incidents where ledger_id = '${WS1}') is not null
      then raise exception 'CASEFAIL incident-repair-crossws-rejected: cross-workspace link written'; end if;`,
  }),
  rpcCase({
    name: "incident-repair-softdeleted-rejected",
    desc: "a soft-deleted repair in the same workspace is rejected (22023)",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(SUPER, `insert into public.vehicle_repairs (id, ledger_id, repair_date, description, cost_dkk, created_by_member_id, deleted_at)
        values ('52100000-0000-0000-0000-000000000006', '${WS1}', current_date, 'Fortrudt', 100.00, '${A_ID}', now());`),
    ],
    actor: B,
    op: `perform public.set_incident_repair(${LATEST_WS1_INCIDENT}, '52100000-0000-0000-0000-000000000006'::uuid, null, null);`,
    expect: "22023",
  }),
  rpcCase({
    name: "incident-direct-insert-denied",
    desc: "authenticated admin A cannot bypass the RPC with a direct table INSERT",
    actor: A,
    op: `insert into public.vehicle_incidents (ledger_id, incident_date, title, description)
         values ('${WS1}', current_date, 'Direkte', 'Uautoriseret');`,
    expect: "42501",
  }),
  rpcCase({
    name: "incident-direct-update-denied",
    desc: "authenticated admin A cannot bypass the RPC with a direct table UPDATE",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: A,
    op: `update public.vehicle_incidents set repair_status = 'closed' where ledger_id = '${WS1}';`,
    expect: "42501",
  }),
  rpcCase({
    name: "incident-direct-delete-denied",
    desc: "authenticated admin A cannot bypass the RPC with a direct table DELETE",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: A,
    op: `delete from public.vehicle_incidents where ledger_id = '${WS1}';`,
    expect: "42501",
  }),
  rpcCase({
    name: "incident-photo-direct-insert-denied",
    desc: "authenticated admin A cannot directly INSERT an incident-photo row",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: A,
    op: `insert into public.vehicle_incident_photos (incident_id, ledger_id, storage_path)
         values (${LATEST_WS1_INCIDENT}, '${WS1}', '${WS1}/x/y.jpg');`,
    expect: "42501",
  }),
  // ── storage.objects: migration 139's incident-photo object policies ────────
  // Until GV-393 these had NO behavioural coverage at all — the migration wraps
  // them in an `if exists (schema_name = 'storage')` guard and no replay ever
  // created that schema, so the block was a symmetric no-op that the equivalence
  // check could not see. The PRELUDE now creates a faithful storage.objects, so
  // these cases exercise the real policies. Upload is bound to an EXISTING incident
  // in the SAME workspace; direct delete is uploader-or-admin only.
  //
  // `sub` in claimsAuth() is what auth.uid() returns, so owner_id is written as that
  // same uuid to model Storage stamping the uploader.
  queryCase({
    name: "storage-incident-photo-upload-allowed",
    desc: "member B uploads an object under <ws>/<incident>/ for a real incident in her workspace",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    assert: `begin
  insert into storage.objects (bucket_id, name, owner_id)
  values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg', auth.uid()::text);
  if not exists (select 1 from storage.objects where bucket_id = 'incident-photos') then
    raise exception 'CASEFAIL storage-incident-photo-upload-allowed: object not stored';
  end if;
end`,
  }),
  rpcCase({
    name: "storage-incident-photo-upload-unknown-incident-denied",
    desc: "an object naming a non-existent incident id is rejected (upload must bind to a real incident)",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    op: `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/99999999/photo.jpg', auth.uid()::text);`,
    expect: "42501",
  }),
  rpcCase({
    name: "storage-incident-photo-upload-foreign-workspace-denied",
    desc: "E (other workspace) cannot upload under ws1's prefix",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: E,
    op: `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg', auth.uid()::text);`,
    expect: "42501",
  }),
  // Isolates the `cardinality(storage.foldername(name)) = 2` clause specifically.
  // A bucket-root path ('loose-photo.jpg') would NOT do that: foldername() returns
  // an empty array, so [1] is null and is_ledger_member(null) already denies it —
  // the case would pass with the cardinality clause deleted, guarding nothing.
  // Mutation-tested: removing that clause from the policy turns THIS case red.
  // A nested path keeps [1] = a real workspace and [2] = a real incident, so
  // membership and the incident-binding both hold and only cardinality can reject.
  rpcCase({
    name: "storage-incident-photo-upload-nested-path-denied",
    desc: "an object nested deeper than <ws>/<incident>/ is rejected by the cardinality clause alone",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    op: `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/nested/photo.jpg', auth.uid()::text);`,
    expect: "42501",
  }),
  rpcCase({
    name: "storage-incident-photo-delete-noncreator-denied",
    desc: "bystander C (member, not uploader, not admin) cannot delete B's uploaded object",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(
        B,
        `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg', auth.uid()::text);`,
      ),
    ],
    actor: C,
    op: `delete from storage.objects where bucket_id = 'incident-photos';
         if not found then raise exception 'CASEFAIL: delete silently matched nothing' using errcode = '42501'; end if;`,
    expect: "42501",
  }),
  queryCase({
    name: "storage-incident-photo-delete-admin-allowed",
    desc: "workspace admin G can delete another member's incident photo object",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(
        B,
        `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg', auth.uid()::text);`,
      ),
    ],
    actor: G,
    assert: `begin
  delete from storage.objects where bucket_id = 'incident-photos';
  if exists (select 1 from storage.objects where bucket_id = 'incident-photos') then
    raise exception 'CASEFAIL storage-incident-photo-delete-admin-allowed: object survived an admin delete';
  end if;
end`,
  }),
  queryCase({
    name: "storage-incident-photo-delete-uploader-allowed",
    desc: "the uploader B can delete her own incident photo object",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(
        B,
        `insert into storage.objects (bucket_id, name, owner_id)
         values ('incident-photos', '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg', auth.uid()::text);`,
      ),
    ],
    actor: B,
    assert: `begin
  delete from storage.objects where bucket_id = 'incident-photos';
  if exists (select 1 from storage.objects where bucket_id = 'incident-photos') then
    raise exception 'CASEFAIL storage-incident-photo-delete-uploader-allowed: object survived the uploader''s delete';
  end if;
end`,
  }),

  rpcCase({
    name: "incident-photo-wrong-prefix-rejected",
    desc: "add_incident_photo rejects a storage path outside the incident's workspace/incident prefix",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    op: `perform public.add_incident_photo(${LATEST_WS1_INCIDENT}, '${WS2}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg');`,
    expect: "22023",
  }),
  queryCase({
    name: "incident-photo-add-and-read",
    desc: "a member registers a correctly-prefixed photo and it is readable in the workspace",
    setup: [step(B, LOG_INCIDENT_B)],
    actor: B,
    assert: `begin
  perform public.add_incident_photo(${LATEST_WS1_INCIDENT}, '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg');
  if not exists (select 1 from public.vehicle_incident_photos
    where ledger_id = '${WS1}' and created_by_member_id = '${ID.B}'
      and storage_path = '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg') then
    raise exception 'CASEFAIL incident-photo-add-and-read: photo row not registered';
  end if;
end`,
  }),
  rpcCase({
    name: "incident-photo-delete-noncreator-denied",
    desc: "bystander C (not admin, not uploader) cannot delete B's incident photo",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(B, `perform public.add_incident_photo(${LATEST_WS1_INCIDENT}, '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg');`),
    ],
    actor: C,
    op: `perform public.delete_incident_photo((select id from public.vehicle_incident_photos where ledger_id = '${WS1}' limit 1));`,
    expect: "42501",
    post: `if not exists (select 1 from public.vehicle_incident_photos where ledger_id = '${WS1}')
      then raise exception 'CASEFAIL incident-photo-delete-noncreator-denied: photo deleted after rejection'; end if;`,
  }),
  rpcCase({
    name: "incident-photo-delete-admin-ok",
    desc: "a workspace admin A can delete an incident photo uploaded by B",
    setup: [
      step(B, LOG_INCIDENT_B),
      step(B, `perform public.add_incident_photo(${LATEST_WS1_INCIDENT}, '${WS1}/' || ${LATEST_WS1_INCIDENT}::text || '/photo.jpg');`),
    ],
    actor: A,
    op: `perform public.delete_incident_photo((select id from public.vehicle_incident_photos where ledger_id = '${WS1}' limit 1));`,
    expect: "ok",
    post: `if exists (select 1 from public.vehicle_incident_photos where ledger_id = '${WS1}')
      then raise exception 'CASEFAIL incident-photo-delete-admin-ok: photo survived admin delete'; end if;`,
  }),

  // ── Fuel-receipt photos (migration 169, GVM-537) ──────────────────────────
  // Two owner decisions are under test here, not just an authorization surface:
  // storage is OPT-IN per tankning (so the ONLY writer is a member calling the RPC —
  // the direct-write cases below are what makes that true), and a receipt is deleted
  // by the retention sweep once its period is closed AND its payment cycle is
  // finished (the retention cases below are the whole definition of "settled").
  queryCase({
    name: "fuel-receipt-attach-and-read",
    desc: "a member attaches a correctly-prefixed receipt and it is readable in the workspace",
    actor: B,
    assert: `begin
  perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH}');
  if not exists (select 1 from public.fuel_payment_receipts
    where ledger_id = '${WS1}' and fuel_payment_id = '${FP1}'
      and uploader_member_id = '${ID.B}' and storage_path = '${RECEIPT_PATH}') then
    raise exception 'CASEFAIL fuel-receipt-attach-and-read: receipt row not registered';
  end if;
end`,
  }),
  rpcCase({
    name: "fuel-receipt-wrong-prefix-rejected",
    desc: "attach rejects a storage path outside the fuel log's workspace/payment prefix",
    actor: B,
    op: `perform public.attach_fuel_payment_receipt('${FP1}', '${WS2}/${FP1}/kvittering.jpg');`,
    expect: "22023",
  }),
  rpcCase({
    name: "fuel-receipt-attach-foreign-member-denied",
    desc: "E (another workspace) cannot attach a receipt to ws1's fuel log",
    actor: E,
    op: `perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH}');`,
    expect: "42501",
    post: `if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}')
      then raise exception 'CASEFAIL fuel-receipt-attach-foreign-member-denied: a receipt was registered anyway'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-attach-deleted-fuel-log-rejected",
    desc: "attach refuses a soft-deleted fuel log",
    setup: [
      step(SUPER, `perform set_config('govehlo.pii_scrub', '1', true);
        update public.fuel_payments set deleted_at = now() where id = '${FP1}';
        perform set_config('govehlo.pii_scrub', '', true);`),
    ],
    actor: B,
    op: `perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH}');`,
    expect: "22023",
  }),
  queryCase({
    name: "fuel-receipt-replace-keeps-exactly-one-row",
    desc: "a second attach REPLACES the receipt and hands back the superseded path",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: B,
    assert: `declare v_result jsonb;
begin
  v_result := public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH_2}');
  if (select count(*) from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') <> 1 then
    raise exception 'CASEFAIL fuel-receipt-replace-keeps-exactly-one-row: a tankning ended up with more than one receipt';
  end if;
  if (select storage_path from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') <> '${RECEIPT_PATH_2}' then
    raise exception 'CASEFAIL fuel-receipt-replace-keeps-exactly-one-row: the replacement path did not win';
  end if;
  if (v_result->>'replaced') <> 'true' or (v_result->>'replaced_storage_path') <> '${RECEIPT_PATH}' then
    raise exception 'CASEFAIL fuel-receipt-replace-keeps-exactly-one-row: the caller was not told which object to delete: %', v_result;
  end if;
end`,
  }),
  rpcCase({
    name: "fuel-receipt-replace-noncreator-denied",
    desc: "bystander C cannot overwrite B's receipt (a replace destroys the other member's attachment)",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: C,
    op: `perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH_2}');`,
    expect: "42501",
    post: `if (select storage_path from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') <> '${RECEIPT_PATH}'
      then raise exception 'CASEFAIL fuel-receipt-replace-noncreator-denied: B''s receipt was overwritten after the rejection'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-replace-admin-ok",
    desc: "a workspace admin A may replace a receipt uploaded by B",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: A,
    op: `perform public.attach_fuel_payment_receipt('${FP1}', '${RECEIPT_PATH_2}');`,
    expect: "ok",
    post: `if (select count(*) from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') <> 1
        or (select storage_path from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') <> '${RECEIPT_PATH_2}'
      then raise exception 'CASEFAIL fuel-receipt-replace-admin-ok: the admin replace did not land as one row'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-detach-noncreator-denied",
    desc: "bystander C (not admin, not uploader) cannot detach B's receipt",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: C,
    op: `perform public.detach_fuel_payment_receipt(${WS1_RECEIPT_ID});`,
    expect: "42501",
    post: `if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}')
      then raise exception 'CASEFAIL fuel-receipt-detach-noncreator-denied: receipt deleted after rejection'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-detach-uploader-ok",
    desc: "the uploader B may detach her own receipt and is told which object to delete",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: B,
    op: `if (public.detach_fuel_payment_receipt(${WS1_RECEIPT_ID}) ->> 'storage_path') <> '${RECEIPT_PATH}' then
           raise exception 'detach did not return the removed storage path' using errcode = '22023';
         end if;`,
    expect: "ok",
    post: `if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}')
      then raise exception 'CASEFAIL fuel-receipt-detach-uploader-ok: receipt survived the uploader''s detach'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-detach-admin-ok",
    desc: "a workspace admin A may detach a receipt uploaded by B",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: A,
    op: `perform public.detach_fuel_payment_receipt(${WS1_RECEIPT_ID});`,
    expect: "ok",
    post: `if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}')
      then raise exception 'CASEFAIL fuel-receipt-detach-admin-ok: receipt survived the admin detach'; end if;`,
  }),
  rpcCase({
    name: "fuel-receipt-direct-insert-denied",
    desc: "a signed-in member cannot write the receipt table directly — the RPC is the only writer",
    actor: B,
    op: `insert into public.fuel_payment_receipts (fuel_payment_id, ledger_id, storage_path, uploader_member_id)
         values ('${FP1}', '${WS1}', '${RECEIPT_PATH}', '${ID.B}');`,
    expect: "42501",
  }),
  rpcCase({
    name: "fuel-receipt-direct-delete-denied",
    desc: "a signed-in member cannot delete a receipt row directly, bypassing the uploader/admin gate",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: C,
    op: `delete from public.fuel_payment_receipts where fuel_payment_id = '${FP1}';`,
    expect: "42501",
  }),
  queryCase({
    name: "fuel-receipt-foreign-workspace-cannot-read",
    desc: "E sees no receipt rows from ws1 (RLS denies silently rather than raising)",
    setup: [step(B, ATTACH_RECEIPT_B)],
    actor: E,
    assert: `begin
  if exists (select 1 from public.fuel_payment_receipts where ledger_id = '${WS1}') then
    raise exception 'CASEFAIL fuel-receipt-foreign-workspace-cannot-read: another workspace''s receipt was visible';
  end if;
end`,
  }),

  // Retention (the owner's decision 2): a receipt dies with the settlement it
  // documented — closed period AND nothing left in flight. Each case seeds ONE
  // receipt in the OPEN period alongside the closed-period one, so a passing case
  // proves the sweep is selective rather than merely destructive.
  queryCase({
    name: "fuel-receipt-retention-open-period-keeps",
    desc: "the sweep never touches a receipt whose period is still open",
    setup: [step(SUPER, SEED_OPEN_PERIOD_RECEIPT)],
    actor: SERVICE,
    assert: `declare v_result jsonb;
begin
  v_result := public.run_operational_retention(180, false);
  if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') then
    raise exception 'CASEFAIL fuel-receipt-retention-open-period-keeps: an open period lost its receipt';
  end if;
  if (v_result->>'purgedFuelReceipts')::integer <> 0 then
    raise exception 'CASEFAIL fuel-receipt-retention-open-period-keeps: unexpected summary %', v_result;
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-closed-unpaid-keeps",
    desc: "a closed period with money still owed keeps its receipt",
    setup: [step(SUPER, SEED_OPEN_PERIOD_RECEIPT + SEED_CLOSED_PERIOD_RECEIPT + seedClosedRequest("requested"))],
    actor: SERVICE,
    assert: `declare v_result jsonb;
begin
  v_result := public.run_operational_retention(180, false);
  if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-unpaid-keeps: a receipt was destroyed while a payment was still requested';
  end if;
  if (v_result->>'purgedFuelReceipts')::integer <> 0 then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-unpaid-keeps: unexpected summary %', v_result;
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-paid-pending-keeps",
    desc: "an unconfirmed paid_pending claim is NOT settled — the creditor can still dispute it",
    setup: [step(SUPER, SEED_OPEN_PERIOD_RECEIPT + SEED_CLOSED_PERIOD_RECEIPT + seedClosedRequest("paid_pending"))],
    actor: SERVICE,
    assert: `declare v_result jsonb;
begin
  v_result := public.run_operational_retention(180, false);
  if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-paid-pending-keeps: the receipt a disputed claim would be argued with was deleted';
  end if;
  if (v_result->>'purgedFuelReceipts')::integer <> 0 then
    raise exception 'CASEFAIL fuel-receipt-retention-paid-pending-keeps: unexpected summary %', v_result;
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-closed-and-paid-purges",
    desc: "closed AND confirmed paid: the receipt is deleted, and only that one",
    setup: [step(SUPER, SEED_OPEN_PERIOD_RECEIPT + SEED_CLOSED_PERIOD_RECEIPT + seedClosedRequest("paid"))],
    actor: SERVICE,
    assert: `declare v_result jsonb;
begin
  v_result := public.run_operational_retention(180, false);
  if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-and-paid-purges: a settled receipt survived the sweep';
  end if;
  if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${FP1}') then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-and-paid-purges: the open period''s receipt was swept too';
  end if;
  if (v_result->>'purgedFuelReceipts')::integer <> 1
     or (v_result->>'fuelReceiptRetentionRule') <> 'closed_and_fully_paid' then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-and-paid-purges: unexpected summary %', v_result;
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-closed-cancelled-only-purges",
    desc: "a closed period whose only request was cancelled (nobody owed anybody) is settled",
    setup: [step(SUPER, SEED_CLOSED_PERIOD_RECEIPT + seedClosedRequest("cancelled"))],
    actor: SERVICE,
    assert: `begin
  perform public.run_operational_retention(180, false);
  if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-cancelled-only-purges: a settled receipt survived the sweep';
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-closed-no-requests-purges",
    desc: "a closed period with no payment requests at all (\"I er kvit\") is settled",
    setup: [step(SUPER, SEED_CLOSED_PERIOD_RECEIPT)],
    actor: SERVICE,
    assert: `begin
  perform public.run_operational_retention(180, false);
  if exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-closed-no-requests-purges: a settled receipt survived the sweep';
  end if;
end`,
  }),
  queryCase({
    name: "fuel-receipt-retention-dry-run-reports-without-deleting",
    desc: "the dry run counts what tonight's cron would destroy and destroys nothing",
    setup: [step(SUPER, SEED_CLOSED_PERIOD_RECEIPT + seedClosedRequest("paid"))],
    actor: SERVICE,
    assert: `declare v_result jsonb;
begin
  v_result := public.run_operational_retention(180, true);
  if (v_result->>'purgedFuelReceipts')::integer <> 1 then
    raise exception 'CASEFAIL fuel-receipt-retention-dry-run-reports-without-deleting: the dry run did not report the settled receipt: %', v_result;
  end if;
  if not exists (select 1 from public.fuel_payment_receipts where fuel_payment_id = '${CLOSED_FUEL}') then
    raise exception 'CASEFAIL fuel-receipt-retention-dry-run-reports-without-deleting: the DRY RUN deleted a row';
  end if;
end`,
  }),

  // ── Push-target RPCs (migration 150, GV-398) ──────────────────────────────
  // These exist so govehlo-web's push engine can pass addresses and device tokens in
  // a POST body instead of a query string. They are service-role only and carry NO
  // in-body gate — the privilege system IS the gate, so the denial cases below are
  // the whole authorisation contract.
  queryCase({
    name: "push-targets-service-role-resolves",
    desc: "service role resolves addresses to devices, case-insensitively, and never to everybody",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: SERVICE,
    assert: `if (select count(*) from public.resolve_push_targets(array['lars@test.dk'])) <> 2 then
      raise exception 'CASEFAIL push-targets-service-role-resolves: expected both of Lars devices';
    end if;
    if (select count(*) from public.resolve_push_targets(array['LARS@Test.DK'])) <> 2 then
      raise exception 'CASEFAIL push-targets-service-role-resolves: matching must lower-case BOTH sides — a row stored with a capitalised address was the silent drop this RPC fixes';
    end if;
    if exists (select 1 from public.resolve_push_targets(array['lars@test.dk']) t where t.user_id is null) then
      raise exception 'CASEFAIL push-targets-service-role-resolves: user_id must come back, the mute filter keys on it';
    end if;
    if (select count(*) from public.resolve_push_targets(array[]::text[])) <> 0 then
      raise exception 'CASEFAIL push-targets-service-role-resolves: an empty list must resolve to nobody';
    end if;
    if (select count(*) from public.resolve_push_targets(null)) <> 0 then
      raise exception 'CASEFAIL push-targets-service-role-resolves: a null list must resolve to nobody, never to every device';
    end if`,
  }),
  rpcCase({
    name: "push-targets-member-blocked",
    desc: "an authenticated workspace admin cannot resolve anyone's push devices",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: A,
    op: `perform public.resolve_push_targets(array['lars@test.dk']);`,
    expect: "42501",
  }),
  rpcCase({
    name: "push-targets-anon-blocked",
    desc: "anon cannot resolve push devices",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: ANON,
    op: `perform public.resolve_push_targets(array['lars@test.dk']);`,
    expect: "42501",
  }),
  queryCase({
    name: "prune-push-tokens-service-role",
    desc: "service role prunes exactly the named devices and leaves an owner's other device live",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: SERVICE,
    assert: `if public.prune_push_tokens(array['ExponentPushToken[dead]']) <> 1 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: expected exactly one row deleted';
    end if;
    if exists (select 1 from public.expo_push_tokens e where e.token = 'ExponentPushToken[dead]') then
      raise exception 'CASEFAIL prune-push-tokens-service-role: the dead token survived';
    end if;
    if (select count(*) from public.expo_push_tokens e
        where e.user_id = '99999999-0000-0000-0000-000000000001') <> 2 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: pruning one owner touched another owner''s devices';
    end if;
    -- One assertion per statement on purpose: an OR would let the planner evaluate the
    -- count before the volatile delete in the same expression.
    if public.prune_push_tokens(array['ExponentPushToken[phone]']) <> 1 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: expected the phone row deleted';
    end if;
    if (select count(*) from public.expo_push_tokens e
        where e.user_id = '99999999-0000-0000-0000-000000000001') <> 1 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: a two-device owner must keep the live device — deleting by user_id was the wrong shape';
    end if;
    if public.prune_push_tokens(array[]::text[]) <> 0 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: an empty list must delete nothing';
    end if;
    if public.prune_push_tokens(null) <> 0 then
      raise exception 'CASEFAIL prune-push-tokens-service-role: a null list must delete nothing';
    end if`,
  }),
  rpcCase({
    name: "prune-push-tokens-member-blocked",
    desc: "an authenticated workspace admin cannot prune push tokens",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: A,
    op: `perform public.prune_push_tokens(array['ExponentPushToken[dead]']);`,
    expect: "42501",
  }),
  rpcCase({
    name: "prune-push-tokens-anon-blocked",
    desc: "anon cannot prune push tokens",
    setup: [step(SUPER, SEED_PUSH_TOKENS)],
    actor: ANON,
    op: `perform public.prune_push_tokens(array['ExponentPushToken[dead]']);`,
    expect: "42501",
  }),

  // ── Pre-departure fuel-stop reminders (migration 154, GV-405) ──────────────
  // Two different authorisation shapes in one migration. set_tank_state is the
  // client's write path and is member-gated in-body; the claim/confirm pair is
  // service-role only with NO in-body gate, so — exactly like the push-target RPCs
  // above — the privilege system IS the whole contract and the denial cases below
  // are the only thing asserting it.
  rpcCase({
    name: "tank-state-member-writes",
    desc: "an active member records the car's tank state",
    actor: B,
    op: `perform public.set_tank_state('${WS1}', 32.5, now(), 5.4, 0.6, 55);`,
    expect: "ok",
    post: `if (select l.tank_state_liters from public.ledgers l where l.id = '${WS1}') <> 32.5
      then raise exception 'CASEFAIL tank-state-member-writes: the stamp did not land'; end if;`,
  }),
  rpcCase({
    name: "tank-state-foreign-member-denied",
    desc: "E (a member of the OTHER workspace) cannot stamp tank state on this car",
    actor: E,
    op: `perform public.set_tank_state('${WS1}', 5, now(), 5.4, 0.6, 55);`,
    expect: "42501",
  }),
  rpcCase({
    name: "tank-state-anon-denied",
    desc: "anon cannot stamp tank state",
    actor: ANON,
    op: `perform public.set_tank_state('${WS1}', 5, now(), 5.4, 0.6, 55);`,
    expect: "42501",
  }),
  rpcCase({
    name: "tank-state-stale-watermark-noop",
    desc: "a member writing an OLDER as_of watermark is refused without an exception, and the stored stamp survives",
    setup: [step(SUPER, `update public.ledgers set tank_state_liters = 40, tank_state_as_of = now(),
      tank_state_consumption = 5.4, tank_state_consumption_spread = 0.6, tank_state_capacity = 55
      where id = '${WS1}';`)],
    actor: B,
    // A losing race is normal, so the client must be able to ignore it quietly: this
    // returns applied=false rather than raising. A regression to an exception would
    // surface as a crash on an ordinary background write.
    op: `if (public.set_tank_state('${WS1}', 5, now() - interval '1 day', 5.4, 0.6, 55) ->> 'applied')::boolean
         then raise exception 'a stale watermark must not be applied'; end if;`,
    expect: "ok",
    post: `if (select l.tank_state_liters from public.ledgers l where l.id = '${WS1}') <> 40
      then raise exception 'CASEFAIL tank-state-stale-watermark-noop: a refused stamp overwrote the stored tank state'; end if;`,
  }),

  // ── The tank model revision (migration 156, GV-415) ────────────────────────
  // The seven-argument set_tank_state is a NEW overload, so it is a new door: the
  // grants and the in-body member gate have to be asserted for it in their own right,
  // not inherited from the six-argument signature above.
  rpcCase({
    name: "tank-state-revisioned-member-writes",
    desc: "an active member records the car's tank state on the revision-carrying signature",
    actor: B,
    op: `perform public.set_tank_state('${WS1}', 31.5, now(), 5.4, 0.6, 55,
           (select l.tank_model_revision from public.ledgers l where l.id = '${WS1}'));`,
    expect: "ok",
    post: `if (select l.tank_state_liters from public.ledgers l where l.id = '${WS1}') <> 31.5
      then raise exception 'CASEFAIL tank-state-revisioned-member-writes: the stamp did not land'; end if;`,
  }),
  rpcCase({
    name: "tank-state-revisioned-foreign-member-denied",
    desc: "E (a member of the OTHER workspace) cannot stamp tank state on the revision-carrying signature either",
    actor: E,
    op: `perform public.set_tank_state('${WS1}', 5, now(), 5.4, 0.6, 55, 0::bigint);`,
    expect: "42501",
  }),
  rpcCase({
    name: "tank-state-revisioned-anon-denied",
    desc: "anon cannot stamp tank state on the revision-carrying signature",
    actor: ANON,
    op: `perform public.set_tank_state('${WS1}', 5, now(), 5.4, 0.6, 55, 0::bigint);`,
    expect: "42501",
  }),
  rpcCase({
    name: "tank-model-revision-bumps-for-a-plain-member",
    desc: "an ordinary member's trip INSERT moves ledgers.tank_model_revision even though migration 125 revoked UPDATE on ledgers from authenticated",
    actor: B,
    // The privilege claim this case exists for. The bump is a trigger that UPDATEs
    // public.ledgers, and an authenticated member has neither an UPDATE grant on that
    // table (revoked in migration 125) nor an RLS policy allowing it. Without SECURITY
    // DEFINER on public.bump_tank_model_revision the update matches zero rows and
    // raises NOTHING — the counter would simply never move for the one write path that
    // matters most, every stamp would read as permanently fresh, and the whole of
    // GV-415 would be dead code with a green test suite. Nothing else in this file or
    // in the contract test would notice, because both run as superuser.
    op: `insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
         values ('${WS1}', '${P1}', '${ID.B}', current_date, 7000, 7100, '${ID.B}');`,
    expect: "ok",
    post: `if (select l.tank_model_revision from public.ledgers l where l.id = '${WS1}') = 0
      then raise exception 'CASEFAIL tank-model-revision-bumps-for-a-plain-member: the trigger''s UPDATE on public.ledgers was filtered away for an authenticated caller (missing SECURITY DEFINER), so the revision never moved'; end if;`,
  }),

  rpcCase({
    name: "booking-fuel-claim-member-blocked",
    desc: "an authenticated workspace admin cannot claim pre-departure fuel reminders",
    actor: A,
    op: `perform public.claim_due_booking_fuel_reminders(10);`,
    expect: "42501",
  }),
  rpcCase({
    name: "booking-fuel-claim-anon-blocked",
    desc: "anon cannot claim pre-departure fuel reminders",
    actor: ANON,
    op: `perform public.claim_due_booking_fuel_reminders(10);`,
    expect: "42501",
  }),
  rpcCase({
    name: "booking-fuel-confirm-member-blocked",
    desc: "an authenticated workspace admin cannot confirm pre-departure fuel reminders",
    actor: A,
    op: `perform public.confirm_booking_fuel_reminders('[]'::jsonb);`,
    expect: "42501",
  }),
  rpcCase({
    name: "booking-fuel-claim-service-role-allowed",
    desc: "the service role — the push engine's identity — may claim and confirm",
    actor: SERVICE,
    op: `perform public.claim_due_booking_fuel_reminders(10);
         perform public.confirm_booking_fuel_reminders('[]'::jsonb);`,
    expect: "ok",
  }),

  // ── Newsletter list (GV-366, migration 161) ────────────────────────────────
  //
  // A marketing list is the one table in this schema where "the server can read it"
  // buys nothing, so migration 161 revokes every grant INCLUDING service_role and puts
  // the whole flow behind three security-definer functions. That is an unusual posture
  // and the only thing standing behind it is these cases: the guard the design leans on
  // is not the revoke line, it is the proof that a real Postgres denies the read.
  rpcCase({
    name: "newsletter-table-anon-blocked",
    desc: "anon cannot read the newsletter address list",
    actor: ANON,
    op: `perform 1 from public.newsletter_subscribers;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-table-authenticated-blocked",
    desc: "a signed-in app user cannot read the newsletter address list",
    actor: A,
    op: `perform 1 from public.newsletter_subscribers;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-table-service-role-blocked",
    desc: "even the service role — the key the Pages Functions hold — cannot query the list",
    actor: SERVICE,
    op: `perform 1 from public.newsletter_subscribers;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-table-service-role-insert-blocked",
    desc: "the service role cannot write a subscriber row directly either — only the RPCs",
    actor: SERVICE,
    op: `insert into public.newsletter_subscribers (email, consent_text_version, confirm_token_hash)
         values ('direct@example.dk', '2026-08-01', repeat('a', 64));`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-request-anon-blocked",
    desc: "anon cannot call the subscribe RPC (the public form goes through the Pages Function)",
    actor: ANON,
    op: `perform public.newsletter_request_subscription('x@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-request-authenticated-blocked",
    desc: "a signed-in app user cannot call the subscribe RPC",
    actor: A,
    op: `perform public.newsletter_request_subscription('x@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-confirm-authenticated-blocked",
    desc: "a signed-in app user cannot confirm a subscription on someone else's behalf",
    actor: A,
    op: `perform public.newsletter_confirm_subscription(repeat('a', 64));`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-unsubscribe-anon-blocked",
    desc: "anon cannot call the unsubscribe RPC directly",
    actor: ANON,
    op: `perform public.newsletter_unsubscribe(repeat('b', 64));`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-double-opt-in-round-trip",
    desc: "the service role can request, confirm and unsubscribe — and the row is GONE afterwards",
    actor: SERVICE,
    op: `perform public.newsletter_request_subscription('signup@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));
         perform public.newsletter_confirm_subscription(repeat('a', 64));
         perform public.newsletter_unsubscribe(repeat('b', 64));`,
    expect: "ok",
    // Hard-delete, not a tombstone: article 17 is satisfied by the click itself, so
    // there must be nothing left carrying the address.
    post: `if exists (select 1 from public.newsletter_subscribers where email = 'signup@example.dk') then
             raise exception 'CASEFAIL newsletter-double-opt-in-round-trip: unsubscribing left a row behind';
           end if;`,
  }),
  rpcCase({
    name: "newsletter-confirm-is-single-use",
    desc: "a confirmation link works once; replaying it reports invalid rather than re-confirming",
    actor: SERVICE,
    op: `declare v_first jsonb; v_second jsonb;
         begin
           perform public.newsletter_request_subscription('once@example.dk', '2026-08-01', repeat('c', 64), repeat('d', 64));
           v_first := public.newsletter_confirm_subscription(repeat('c', 64));
           v_second := public.newsletter_confirm_subscription(repeat('c', 64));
           if v_first ->> 'status' <> 'confirmed' then
             raise exception 'CASEFAIL newsletter-confirm-is-single-use: first click did not confirm (%)', v_first;
           end if;
           if v_second ->> 'status' <> 'invalid' then
             raise exception 'CASEFAIL newsletter-confirm-is-single-use: replayed link was accepted again (%)', v_second;
           end if;
         end;`,
    expect: "ok",
  }),
  rpcCase({
    name: "newsletter-pending-expires-after-window",
    desc: "a pending signup older than the 7-day window can no longer be confirmed, and is purged by the next signup",
    actor: SERVICE,
    op: `declare v_result jsonb;
         begin
           perform public.newsletter_request_subscription('stale@example.dk', '2026-08-01', repeat('e', 64), repeat('f', 64));
           -- Age the request past the window. The Function never does this and cannot:
           -- service_role has no grant on the table, which is the point of the four deny
           -- cases above. So step out of the role for the one statement that only the
           -- passage of time would otherwise produce, then step back in.
           reset role;
           update public.newsletter_subscribers set requested_at = now() - interval '8 days'
             where email = 'stale@example.dk';
           set local role service_role;
           v_result := public.newsletter_confirm_subscription(repeat('e', 64));
           if v_result ->> 'status' <> 'invalid' then
             raise exception 'CASEFAIL newsletter-pending-expires-after-window: an expired token still confirmed (%)', v_result;
           end if;
           -- The next person's signup is what sweeps it: an abandoned address must not
           -- depend on that particular person coming back to be removed.
           perform public.newsletter_request_subscription('fresh@example.dk', '2026-08-01', repeat('1', 64), repeat('2', 64));
         end;`,
    expect: "ok",
    // The sweep's effect is asserted in `post`, which the template runs after `reset
    // role` — nothing inside the case body may read the table, because service_role has
    // no grant on it. That denial is the point of the four cases above, so working
    // around it here would be testing a schema this repo does not ship.
    post: `if exists (select 1 from public.newsletter_subscribers where email = 'stale@example.dk') then
             raise exception 'CASEFAIL newsletter-pending-expires-after-window: the expired pending row survived the next signup''s sweep';
           end if;
           if not exists (select 1 from public.newsletter_subscribers where email = 'fresh@example.dk') then
             raise exception 'CASEFAIL newsletter-pending-expires-after-window: the sweep took the live pending row with it';
           end if;`,
  }),
  rpcCase({
    name: "newsletter-resubmit-does-not-remail-a-confirmed-address",
    desc: "re-submitting an already-confirmed address returns send_mail false — the database, not the endpoint, decides",
    actor: SERVICE,
    op: `declare v_again jsonb;
         begin
           perform public.newsletter_request_subscription('member@example.dk', '2026-08-01', repeat('7', 64), repeat('8', 64));
           perform public.newsletter_confirm_subscription(repeat('7', 64));
           v_again := public.newsletter_request_subscription('member@example.dk', '2026-08-01', repeat('9', 64), repeat('0', 64));
           if v_again ->> 'status' <> 'already_confirmed' or (v_again ->> 'send_mail') <> 'false' then
             raise exception 'CASEFAIL newsletter-resubmit-does-not-remail-a-confirmed-address: %', v_again;
           end if;
         end;`,
    expect: "ok",
  }),

  // ── Newsletter send (GV-430/173) and its tokens (GV-441/175) ──────────────
  //
  // mint_newsletter_send_tokens is the ONE function that reads addresses out of the
  // list, so its containment is not the comment above it — it is these cases. Two
  // halves: nothing browser-facing can call it or read what it wrote, and what it
  // actually does to a real Postgres is hand out CONFIRMED rows only, with a
  // counts-only audit row.
  //
  // Migration 173 stored each fresh digest OVER the previous one, so only the newest
  // mail carried a working link — and because the web endpoint deliberately renders one
  // goodbye page for every outcome (telling a wrong token from an already-deleted row
  // would make the URL an oracle), a subscriber clicking an older newsletter's link was
  // told their address had been deleted while they stayed subscribed and kept getting
  // mail. Migration 175 accumulates the digests in public.newsletter_send_tokens instead.
  //
  // That fix is a claim about a REAL Postgres over two sends, which is exactly what the
  // static contract test cannot make: it can pin that the SQL says INSERT, not that an
  // August token still unsubscribes in September. So the cases below are the half of
  // GV-441 that only this file can carry — old links work, the newest one works, the
  // confirmation mail's own link survives a send, and the whole set dies with the
  // subscriber through the cascade rather than lingering as a tombstone.
  rpcCase({
    name: "newsletter-mint-anon-blocked",
    desc: "anon cannot mint a send — that would be the whole address list over a public endpoint",
    actor: ANON,
    op: `perform public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev');`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-mint-authenticated-blocked",
    desc: "a signed-in app user cannot mint a send either — this RPC is operator-only, through the server",
    actor: A,
    op: `perform public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev');`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-log-anon-blocked",
    desc: "anon cannot read the send log",
    actor: ANON,
    op: `perform 1 from public.newsletter_send_log;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-log-authenticated-blocked",
    desc: "a signed-in app user cannot read the send log",
    actor: A,
    op: `perform 1 from public.newsletter_send_log;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-log-service-role-blocked",
    desc: "even the service role cannot read or rewrite the audit trail of the programme it runs",
    actor: SERVICE,
    op: `perform 1 from public.newsletter_send_log;`,
    expect: "42501",
  }),
  // The token table inherits the list's posture exactly. A readable table of live
  // unsubscribe digests would be a table of working links to every subscriber's removal
  // — and, joined to nothing else, still a headcount of the list.
  rpcCase({
    name: "newsletter-send-tokens-anon-blocked",
    desc: "anon cannot read the unsubscribe-token table",
    actor: ANON,
    op: `perform 1 from public.newsletter_send_tokens;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-tokens-authenticated-blocked",
    desc: "a signed-in app user cannot read the unsubscribe-token table",
    actor: A,
    op: `perform 1 from public.newsletter_send_tokens;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-tokens-service-role-blocked",
    desc: "even the service role — the key the Pages Functions hold — cannot query live unsubscribe digests",
    actor: SERVICE,
    op: `perform 1 from public.newsletter_send_tokens;`,
    expect: "42501",
  }),
  // The batched-send job table (GV-442, migration 179) takes the same posture as the
  // three tables above. It carries the marketing copy and the keyset cursor into the
  // address list; readable, it would let the code that runs the send bypass the RPCs.
  rpcCase({
    name: "newsletter-send-jobs-anon-blocked",
    desc: "anon cannot read the send-job table",
    actor: ANON,
    op: `perform 1 from public.newsletter_send_jobs;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-jobs-authenticated-blocked",
    desc: "a signed-in app user cannot read the send-job table",
    actor: A,
    op: `perform 1 from public.newsletter_send_jobs;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-send-jobs-service-role-blocked",
    desc: "even the service role — the key the scheduler holds — reaches jobs only through the RPCs, never the table",
    actor: SERVICE,
    op: `perform 1 from public.newsletter_send_jobs;`,
    expect: "42501",
  }),
  rpcCase({
    name: "newsletter-mint-accumulates-confirmed-only",
    desc: "minting hands out confirmed addresses with FRESH tokens, ADDS them alongside the older ones, and skips pending rows",
    actor: SERVICE,
    op: `declare v_count integer; v_email text; v_token text;
         begin
           perform public.newsletter_request_subscription('sender@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));
           perform public.newsletter_confirm_subscription(repeat('a', 64));
           -- Never confirmed: an address somebody typed into the form and walked away
           -- from. The double opt-in exists so that this person is not mailed, and the
           -- send is the last place that promise can be broken.
           perform public.newsletter_request_subscription('waiting@example.dk', '2026-08-01', repeat('c', 64), repeat('d', 64));

           select count(*), min(ms.email), min(ms.unsubscribe_token)
           into v_count, v_email, v_token
           from public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev august') ms;

           if v_count <> 1 or v_email <> 'sender@example.dk' then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: minted % row(s), first %', v_count, v_email;
           end if;
           if v_token !~ '^[0-9a-f]{64}$' then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: the raw token is not 32 random bytes (%)', v_token;
           end if;
         end;`,
    expect: "ok",
    // Read back as postgres — service_role has no grant on any of the three tables,
    // which is the point of the deny cases above, so nothing inside the case body may
    // look.
    post: `if (select count(*) from public.newsletter_send_log) <> 1 then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: expected exactly one audit row, found %',
               (select count(*) from public.newsletter_send_log);
           end if;
           if not exists (select 1 from public.newsletter_send_log
                          where operator_email = 'cjo@govehlo.dk'
                            and headline = 'Nyhedsbrev august'
                            and recipient_count = 1) then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: the audit row does not describe the send';
           end if;
           -- THE GV-441 PROPERTY, read straight off the table: the confirmed subscriber
           -- now holds TWO digests — the one from their confirmation mail and the one
           -- this send just minted — where migration 173 would have left exactly one.
           -- Both are links somebody may still be holding, so both must exist.
           if (select count(*) from public.newsletter_send_tokens st
               join public.newsletter_subscribers ns on ns.id = st.subscriber_id
               where ns.email = 'sender@example.dk') <> 2 then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: the sender holds % token(s), expected 2 (the send rotated instead of accumulating)',
               (select count(*) from public.newsletter_send_tokens st
                join public.newsletter_subscribers ns on ns.id = st.subscriber_id
                where ns.email = 'sender@example.dk');
           end if;
           if not exists (select 1 from public.newsletter_send_tokens st
                          join public.newsletter_subscribers ns on ns.id = st.subscriber_id
                          where ns.email = 'sender@example.dk' and st.token_digest = repeat('b', 64)) then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: the pre-send token was destroyed by the send';
           end if;
           -- The pending row keeps the one token it was created with, untouched: a send
           -- covers confirmed rows and nothing else, so it can neither mail nor disturb
           -- somebody who never clicked the link.
           if (select count(*) from public.newsletter_send_tokens st
               join public.newsletter_subscribers ns on ns.id = st.subscriber_id
               where ns.email = 'waiting@example.dk' and st.token_digest = repeat('d', 64)) <> 1 then
             raise exception 'CASEFAIL newsletter-mint-accumulates-confirmed-only: the unconfirmed row was touched by the send';
           end if;`,
  }),
  rpcCase({
    name: "newsletter-every-past-send-can-unsubscribe",
    desc: "GV-441: an OLD newsletter's unsubscribe link still works after a later send, and so does the newest one",
    actor: SERVICE,
    op: `declare v_aug_lars text; v_aug_bo text; v_sep_lars text; v_sep_bo text; v_old jsonb; v_new jsonb;
         begin
           perform public.newsletter_request_subscription('lars@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));
           perform public.newsletter_confirm_subscription(repeat('a', 64));
           perform public.newsletter_request_subscription('bo@example.dk', '2026-08-01', repeat('c', 64), repeat('d', 64));
           perform public.newsletter_confirm_subscription(repeat('c', 64));

           select max(ms.unsubscribe_token) filter (where ms.email = 'lars@example.dk'),
                  max(ms.unsubscribe_token) filter (where ms.email = 'bo@example.dk')
           into v_aug_lars, v_aug_bo
           from public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev august') ms;

           select max(ms.unsubscribe_token) filter (where ms.email = 'lars@example.dk'),
                  max(ms.unsubscribe_token) filter (where ms.email = 'bo@example.dk')
           into v_sep_lars, v_sep_bo
           from public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev september') ms;

           if v_aug_lars is null or v_sep_lars is null or v_aug_lars = v_sep_lars then
             raise exception 'CASEFAIL newsletter-every-past-send-can-unsubscribe: the two sends did not mint distinct tokens (% / %)', v_aug_lars, v_sep_lars;
           end if;

           -- THE BUG THIS TICKET EXISTS FOR. Lars scrolls back to the AUGUST mail in
           -- October and clicks afmeld. Before migration 175 his August digest had been
           -- overwritten in September, this returned 'unknown', and the endpoint — which
           -- renders one goodbye page for every outcome, because distinguishing them
           -- would make the URL a token oracle — told him his address was deleted while
           -- he stayed on the list and kept receiving mail.
           v_old := public.newsletter_unsubscribe(encode(sha256(v_aug_lars::bytea), 'hex'));
           if v_old ->> 'status' <> 'unsubscribed' then
             raise exception 'CASEFAIL newsletter-every-past-send-can-unsubscribe: the AUGUST link no longer unsubscribes after the september send (%)', v_old;
           end if;

           -- ...and the newest send's link still works too, hashed the way migration 161
           -- stores it. sha256() is the built-in, so this asserts the digest scheme as
           -- well: a mint that hashed differently would hand out links the unsubscribe
           -- RPC cannot match.
           v_new := public.newsletter_unsubscribe(encode(sha256(v_sep_bo::bytea), 'hex'));
           if v_new ->> 'status' <> 'unsubscribed' then
             raise exception 'CASEFAIL newsletter-every-past-send-can-unsubscribe: the newest link does not unsubscribe (%)', v_new;
           end if;
         end;`,
    expect: "ok",
    post: `if exists (select 1 from public.newsletter_subscribers where email in ('lars@example.dk', 'bo@example.dk')) then
             raise exception 'CASEFAIL newsletter-every-past-send-can-unsubscribe: a subscriber survived their own unsubscribe';
           end if;
           -- The cascade, which is the whole retention argument for this table: both
           -- people held THREE digests each (confirmation mail, august, september) and
           -- every one of them has to go with the address. A token left behind would be
           -- both a working link to nothing and the tombstone migration 161 refused.
           if (select count(*) from public.newsletter_send_tokens) <> 0 then
             raise exception 'CASEFAIL newsletter-every-past-send-can-unsubscribe: % token row(s) outlived their subscribers — the ON DELETE CASCADE did not fire',
               (select count(*) from public.newsletter_send_tokens);
           end if;`,
  }),
  rpcCase({
    name: "newsletter-confirmation-link-survives-a-send",
    desc: "the unsubscribe link in the CONFIRMATION mail still works after a newsletter has gone out",
    actor: SERVICE,
    op: `declare v_result jsonb;
         begin
           perform public.newsletter_request_subscription('ny@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));
           perform public.newsletter_confirm_subscription(repeat('a', 64));
           perform public.mint_newsletter_send_tokens('cjo@govehlo.dk', 'Nyhedsbrev august');

           -- This is the link at the foot of the confirmation mail, and it is why the
           -- old column could not simply be left behind when the lookup moved: migration
           -- 161's signup path is what issues this token, so it has to land in the same
           -- table the unsubscribe RPC reads. A send must not kill it.
           v_result := public.newsletter_unsubscribe(repeat('b', 64));
           if v_result ->> 'status' <> 'unsubscribed' then
             raise exception 'CASEFAIL newsletter-confirmation-link-survives-a-send: the confirmation mail''s unsubscribe link is dead after one send (%)', v_result;
           end if;
         end;`,
    expect: "ok",
    post: `if exists (select 1 from public.newsletter_subscribers where email = 'ny@example.dk') then
             raise exception 'CASEFAIL newsletter-confirmation-link-survives-a-send: the row survived';
           end if;`,
  }),
  rpcCase({
    name: "newsletter-unknown-token-deletes-nothing",
    desc: "a digest that belongs to nobody removes nothing and still answers the silent 'unknown'",
    actor: SERVICE,
    op: `declare v_result jsonb;
         begin
           perform public.newsletter_request_subscription('bliver@example.dk', '2026-08-01', repeat('a', 64), repeat('b', 64));
           perform public.newsletter_confirm_subscription(repeat('a', 64));

           -- The answer has to stay 'unknown' rather than becoming an error or a
           -- distinguishable status: the endpoint renders ONE goodbye page for every
           -- outcome, and it can only do that while the RPC refuses to tell a wrong
           -- token from an already-deleted row. GV-441 fixed the false success by making
           -- old links WORK, not by making this louder.
           v_result := public.newsletter_unsubscribe(repeat('f', 64));
           if v_result ->> 'status' <> 'unknown' then
             raise exception 'CASEFAIL newsletter-unknown-token-deletes-nothing: an unknown digest answered % instead of unknown', v_result;
           end if;
         end;`,
    expect: "ok",
    post: `if not exists (select 1 from public.newsletter_subscribers where email = 'bliver@example.dk') then
             raise exception 'CASEFAIL newsletter-unknown-token-deletes-nothing: an unknown digest deleted a subscriber';
           end if;
           if (select count(*) from public.newsletter_send_tokens) <> 1 then
             raise exception 'CASEFAIL newsletter-unknown-token-deletes-nothing: an unknown digest changed the token table (% rows)',
               (select count(*) from public.newsletter_send_tokens);
           end if;`,
  }),
  rpcCase({
    name: "newsletter-mint-validates-its-audit-inputs",
    desc: "an empty operator or headline is refused (22023) — an audit row nobody can match to a mail is not an audit row",
    actor: SERVICE,
    op: `perform public.mint_newsletter_send_tokens('cjo@govehlo.dk', '   ');`,
    expect: "22023",
  }),
  rpcCase({
    name: "newsletter-mint-refuses-a-non-address-operator",
    desc: "the operator field must be an address — it is the accountability record of who sent marketing mail",
    actor: SERVICE,
    op: `perform public.mint_newsletter_send_tokens('operatoer', 'Nyhedsbrev');`,
    expect: "22023",
  }),

  // ── 15. Vehicle handover (migration 164: GVM-529) ─────────────────────────
  // The handover is the first table in the platform whose free text is
  // personal-adjacent LOCATION data — where a shared car is parked, where its keys
  // are kept. So the cross-workspace read case below is not a formality: it is the
  // one failure here that would be a data-protection incident rather than a bug.
  // Reads are for every member of the workspace (the NEXT driver is the audience);
  // writes are for the booking's member, the linked trip's driver, or an admin, and
  // go only through the RPC — the table has no write policy at all.
  rpcCase({
    name: "handover-booking-member-writes",
    desc: "B, whose booking it is, saves the handover for it",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: B,
    op: SAVE_HANDOVER_B,
    expect: "ok",
    post: `if not exists (select 1 from public.booking_handovers
        where booking_id = '${HANDOVER_BOOKING_B}' and ledger_id = '${WS1}'
          and author_member_id = '${ID.B}' and keys_confirmed = true
          and parking_location = 'P-kaelder niveau 2, plads 14')
      then raise exception 'CASEFAIL handover-booking-member-writes: row not created with author = caller'; end if;`,
  }),
  rpcCase({
    name: "handover-bystander-write-denied",
    desc: "bystander C, an active member who is neither the booking member, the trip driver nor an admin, cannot author it",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: C,
    op: `perform public.upsert_booking_handover('${WS1}', '${HANDOVER_BOOKING_B}'::uuid,
      null, null, 'Cilles gaet', null, null, null, null, false, null, null, null, null, null);`,
    expect: "42501",
    post: `if exists (select 1 from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}')
      then raise exception 'CASEFAIL handover-bystander-write-denied: a refused write left a row behind'; end if;`,
  }),
  rpcCase({
    name: "handover-admin-writes",
    desc: "workspace admin A can save the handover for another member booking (the GV-253 escape hatch)",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: A,
    op: `perform public.upsert_booking_handover('${WS1}', '${HANDOVER_BOOKING_B}'::uuid,
      null, null, 'Annas rettelse', null, null, null, null, false, null, null, null, null, null);`,
    expect: "ok",
    post: `if (select author_member_id from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}') <> '${A_ID}'
      then raise exception 'CASEFAIL handover-admin-writes: author is not the admin who wrote it'; end if;`,
  }),
  rpcCase({
    name: "handover-foreign-member-write-denied",
    desc: "member E of another workspace cannot save a handover into ws1",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: E,
    op: `perform public.upsert_booking_handover('${WS1}', '${HANDOVER_BOOKING_B}'::uuid,
      null, null, 'Eriks fusk', null, null, null, null, false, null, null, null, null, null);`,
    expect: "42501",
  }),
  rpcCase({
    name: "handover-inactive-member-write-denied",
    desc: "D, deactivated but still holding a booking, cannot save its handover",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: D,
    op: `perform public.upsert_booking_handover('${WS1}', '${HANDOVER_BOOKING_D}'::uuid,
      null, null, 'Dans forsoeg', null, null, null, null, false, null, null, null, null, null);`,
    expect: "42501",
  }),
  rpcCase({
    name: "handover-anon-write-denied",
    desc: "anon cannot save a handover",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: ANON,
    op: `perform public.upsert_booking_handover('${WS1}', '${HANDOVER_BOOKING_B}'::uuid,
      null, null, 'anon', null, null, null, null, false, null, null, null, null, null);`,
    expect: "42501",
  }),
  queryCase({
    name: "handover-member-can-read-workspace",
    desc: "bystander member C READS the handover — the next driver is exactly who it is for",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: C,
    assert: `if not exists (select 1 from public.booking_handovers
        where ledger_id = '${WS1}' and parking_location = 'P-kaelder niveau 2, plads 14') then
      raise exception 'CASEFAIL handover-member-can-read-workspace: a member of the group could not see where the car is';
    end if`,
  }),
  queryCase({
    name: "handover-outsider-isolated",
    desc: "E, a signed-in member of ANOTHER workspace, cannot read ws1 parking and key locations",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: E,
    assert: `if exists (select 1 from public.booking_handovers where ledger_id = '${WS1}') then
      raise exception 'CASEFAIL handover-outsider-isolated: a stranger with a valid JWT read another workspace parking location';
    end if`,
  }),
  rpcCase({
    name: "handover-anon-read-denied",
    desc: "anon has no grant on the table at all, so the denial comes from the privilege system before RLS",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: ANON,
    op: `perform 1 from public.booking_handovers;`,
    expect: "42501",
  }),
  rpcCase({
    name: "handover-direct-insert-denied",
    desc: "authenticated admin A cannot bypass the RPC with a direct table INSERT",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: A,
    op: `insert into public.booking_handovers (ledger_id, booking_id, author_member_id, parking_location)
         values ('${WS1}', '${HANDOVER_BOOKING_B}', '${A_ID}', 'Direkte');`,
    expect: "42501",
  }),
  rpcCase({
    name: "handover-direct-update-denied",
    desc: "authenticated B cannot bypass the RPC with a direct table UPDATE of her own handover",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: B,
    op: `update public.booking_handovers set parking_location = 'Direkte' where booking_id = '${HANDOVER_BOOKING_B}';`,
    expect: "42501",
  }),
  rpcCase({
    name: "handover-direct-delete-denied",
    desc: "authenticated admin A cannot bypass the RPC with a direct table DELETE",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: A,
    op: `delete from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}';`,
    expect: "42501",
  }),
  queryCase({
    name: "handover-second-save-edits-the-same-row",
    desc: "saving twice leaves ONE handover per booking, and writes exactly one feed event",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: B,
    assert: `begin
  ${SAVE_HANDOVER_B}
  perform public.upsert_booking_handover(
    target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
    parking_location_value => 'P-kaelder niveau 3, plads 7',
    event_title => 'Bo rettede parkeringen', event_body => 'Niveau 3, ikke 2');
  if (select count(*) from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}') <> 1 then
    raise exception 'CASEFAIL handover-second-save-edits-the-same-row: a second save stacked a duplicate handover';
  end if;
  if (select count(*) from public.ledger_events where ledger_id = '${WS1}' and event_type = 'handover_created') <> 1 then
    raise exception 'CASEFAIL handover-second-save-edits-the-same-row: an EDIT wrote a second feed event';
  end if;
end`,
  }),
  rpcCase({
    name: "handover-stale-token-refused",
    desc: "a stale expected_updated_at raises GV42O and writes nothing (GV-421 semantics, migration 160)",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: B,
    op: `perform public.upsert_booking_handover(
      target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
      parking_location_value => 'for sent',
      expected_updated_at => timestamptz '2020-01-01 00:00:00+00');`,
    expect: "GV42O",
    post: `if (select parking_location from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}')
             <> 'P-kaelder niveau 2, plads 14'
      then raise exception 'CASEFAIL handover-stale-token-refused: the refused write landed anyway'; end if;`,
  }),
  rpcCase({
    name: "handover-fresh-token-accepted",
    desc: "an edit carrying the row CURRENT updated_at is accepted and lands",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SAVE_HANDOVER_B)],
    actor: B,
    op: `perform public.upsert_booking_handover(
      target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
      parking_location_value => 'Flyttet til gaden',
      expected_updated_at => ${HANDOVER_TOKEN_B});`,
    expect: "ok",
    post: `if (select parking_location from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}') <> 'Flyttet til gaden'
      then raise exception 'CASEFAIL handover-fresh-token-accepted: the accepted edit did not land'; end if;`,
  }),
  queryCase({
    name: "handover-create-logs-a-feed-event",
    desc: "the CREATE writes one handover_created event with the caller as actor and both ids in metadata",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: B,
    assert: `begin
  ${SAVE_HANDOVER_B}
  if not exists (select 1 from public.ledger_events ev
    where ev.ledger_id = '${WS1}' and ev.event_type = 'handover_created'
      and ev.actor_member_id = '${ID.B}'
      and (ev.metadata->>'booking_id') = '${HANDOVER_BOOKING_B}'
      and (ev.metadata->>'handover_id') =
        (select bh.id::text from public.booking_handovers bh where bh.booking_id = '${HANDOVER_BOOKING_B}')) then
    raise exception 'CASEFAIL handover-create-logs-a-feed-event: no handover_created event with the caller as actor and both ids';
  end if;
end`,
  }),

  // ── 16. The car's current location (migration 167: GVM-520) ───────────────
  // ledgers.parking_location / key_location carry the same personal-adjacent free
  // text booking_handovers does, so the cross-workspace refusal below is the same
  // privacy boundary rather than a formality. Two properties here are DECISIONS
  // that a later "tightening" would quietly reverse, and they are pinned as such:
  //
  //   • ANY active member may write it, and a second member overwriting the first
  //     is CORRECT — the car moved again. Whoever moved it is the only person who
  //     knows where it is, and is usually not the admin.
  //   • the handover mirror is NULL-PRESERVING while set_vehicle_location is a full
  //     set. A handover that mentions no parking must not erase the car's known
  //     spot; a mutation to a plain assignment would look ordinary in a diff and
  //     would wipe the location on every partial handover.
  rpcCase({
    name: "vehicle-location-member-writes",
    desc: "B, an ordinary member, records where she just left the car and the keys",
    actor: B,
    op: SET_LOCATION_B,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL vehicle-location-member-writes: columns hold %', ${WS1_LOCATION}; end if;
      if ${WS1_LOCATION_AUTHOR} <> '${ID.B}'
      then raise exception 'CASEFAIL vehicle-location-member-writes: stamped author is %', ${WS1_LOCATION_AUTHOR}; end if;
      if (select l.location_updated_at from public.ledgers l where l.id = '${WS1}') is null
      then raise exception 'CASEFAIL vehicle-location-member-writes: location_updated_at was not stamped'; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-second-member-overwrites",
    desc: "C overwrites B's location — any-member is the decided policy, because the car moved again",
    setup: [step(B, SET_LOCATION_B)],
    actor: C,
    op: SET_LOCATION_C,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Gaden foran nr. 14 / Noegler i postkassen hos Cille'
      then raise exception 'CASEFAIL vehicle-location-second-member-overwrites: columns hold %', ${WS1_LOCATION}; end if;
      if ${WS1_LOCATION_AUTHOR} <> '${ID.C}'
      then raise exception 'CASEFAIL vehicle-location-second-member-overwrites: the stamp still names %', ${WS1_LOCATION_AUTHOR}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-foreign-member-denied",
    desc: "E, a signed-in member of ANOTHER workspace, cannot state where ws1's car is — pin and all",
    setup: [step(B, SET_LOCATION_B)],
    actor: E,
    // Deliberately the NEW seven-argument signature carrying a pin (GVM-536): the
    // workspace boundary must hold on the shape that stores coordinates, not only on
    // the one that stores text.
    op: `perform public.set_vehicle_location(
      target_ledger_id => '${WS1}',
      parking_location_value => 'Eriks fusk', key_location_value => 'Eriks noegler',
      parking_lat_value => ${PIN_LAT}, parking_lng_value => ${PIN_LNG},
      event_title => null, event_body => null);`,
    expect: "42501",
    post: `if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL vehicle-location-foreign-member-denied: a refused write landed anyway (%)', ${WS1_LOCATION}; end if;
      if ${WS1_PIN} <> 'NULL / NULL'
      then raise exception 'CASEFAIL vehicle-location-foreign-member-denied: a refused write left a coordinate behind (%)', ${WS1_PIN}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-inactive-member-denied",
    desc: "D, deactivated, is a member row but not an active membership",
    actor: D,
    op: `perform public.set_vehicle_location('${WS1}', 'Dans forsoeg', null, null, null);`,
    expect: "42501",
  }),
  rpcCase({
    name: "vehicle-location-anon-denied",
    desc: "anon cannot state where the car is",
    actor: ANON,
    op: `perform public.set_vehicle_location('${WS1}', 'anon', null, null, null);`,
    expect: "42501",
  }),
  rpcCase({
    name: "vehicle-location-too-long-refused",
    desc: "201 characters is refused with 22023 and nothing is written",
    setup: [step(B, SET_LOCATION_B)],
    actor: C,
    op: `perform public.set_vehicle_location('${WS1}', repeat('x', 201), null, null, null);`,
    expect: "22023",
    post: `if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL vehicle-location-too-long-refused: the refused write changed the row (%)', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-is-a-full-set-so-null-clears",
    desc: "an omitted field CLEARS the column — the client prefills both, so this is 'where it is now', not a patch",
    setup: [step(B, SET_LOCATION_B)],
    actor: C,
    op: `perform public.set_vehicle_location('${WS1}', 'Kun parkeringen er kendt', null, null, null);`,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Kun parkeringen er kendt / NULL'
      then raise exception 'CASEFAIL vehicle-location-is-a-full-set-so-null-clears: columns hold %', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-logs-one-feed-event-with-no-location-text",
    desc: "a title writes exactly one vehicle_location_updated event, and its metadata never carries the free text",
    actor: B,
    op: SET_LOCATION_B,
    expect: "ok",
    post: `if (select count(*) from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'vehicle_location_updated'
          and actor_member_id = '${ID.B}') <> 1
      then raise exception 'CASEFAIL vehicle-location-logs-one-feed-event-with-no-location-text: not exactly one event by the caller'; end if;
      if exists (select 1 from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'vehicle_location_updated'
          and metadata::text like '%Netto%')
      then raise exception 'CASEFAIL vehicle-location-logs-one-feed-event-with-no-location-text: the parking text leaked into event metadata'; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-without-a-title-is-silent",
    desc: "no event_title writes no feed event at all, but still moves the columns",
    actor: B,
    op: `perform public.set_vehicle_location('${WS1}', 'Stille flytning', null, null, null);`,
    expect: "ok",
    post: `if exists (select 1 from public.ledger_events where ledger_id = '${WS1}' and event_type = 'vehicle_location_updated')
      then raise exception 'CASEFAIL vehicle-location-without-a-title-is-silent: an event was written with no title'; end if;
      if ${WS1_LOCATION} <> 'Stille flytning / NULL'
      then raise exception 'CASEFAIL vehicle-location-without-a-title-is-silent: the write did not land (%)', ${WS1_LOCATION}; end if;`,
  }),

  // ── 16b. The parking pin (migration 168: GVM-536) ─────────────────────────
  // ONE optional coordinate pair, and the deliberate REVERSAL of the platform's
  // no-coordinates posture for exactly this field pair (owner decision 2026-08-04).
  // Three properties are decisions rather than mechanics, so they are pinned as such:
  //
  //   • a pin is FULL SET like the two text columns — null/null CLEARS it — and the
  //     consequence is that an OLD CLIENT, which posts only the five pre-168 named
  //     keys, clears the pin on every save. That is CORRECT: it is saving a parking
  //     text without a fresh pin, so the stored pin describes where the car used to
  //     be. The old-signature case below is what stops that being "fixed" into a
  //     coalesce.
  //   • half a pin is refused, not stored. A lone latitude renders as a marker on the
  //     prime meridian.
  //   • the coordinates never reach the feed. The metadata carries the boolean
  //     parking_pin_set and nothing else, and the case asserts on the fixture's own
  //     digits rather than on a field name, so a rename cannot smuggle them in.
  rpcCase({
    name: "vehicle-location-pin-lands-on-the-workspace",
    desc: "B drops a pin along with the text, and both coordinates land",
    actor: B,
    op: SET_LOCATION_B_WITH_PIN,
    expect: "ok",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL vehicle-location-pin-lands-on-the-workspace: the pin holds %', ${WS1_PIN}; end if;
      if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL vehicle-location-pin-lands-on-the-workspace: the text did not land (%)', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-pin-is-cleared-by-a-null-pair",
    desc: "an explicit null/null removes the pin — the same full-set rule the text columns follow",
    setup: [step(B, SET_LOCATION_B_WITH_PIN)],
    actor: C,
    op: SET_LOCATION_C,
    expect: "ok",
    post: `if ${WS1_PIN} <> 'NULL / NULL'
      then raise exception 'CASEFAIL vehicle-location-pin-is-cleared-by-a-null-pair: the pin survived (%)', ${WS1_PIN}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-lone-latitude-refused",
    desc: "half a pin is 22023 and nothing is written — a lone latitude is a marker on the prime meridian",
    setup: [step(B, SET_LOCATION_B_WITH_PIN)],
    actor: C,
    op: `perform public.set_vehicle_location(
      target_ledger_id => '${WS1}',
      parking_location_value => 'Kun en halv naal', key_location_value => null,
      parking_lat_value => ${PIN_LAT}, parking_lng_value => null,
      event_title => null, event_body => null);`,
    expect: "22023",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL vehicle-location-lone-latitude-refused: the refused write moved the pin (%)', ${WS1_PIN}; end if;
      if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL vehicle-location-lone-latitude-refused: the refused write moved the text (%)', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-pin-out-of-range-refused",
    desc: "a latitude of 91 is 22023 — the RPC answers before the check constraint has to",
    setup: [step(B, SET_LOCATION_B_WITH_PIN)],
    actor: C,
    op: `perform public.set_vehicle_location(
      target_ledger_id => '${WS1}',
      parking_location_value => 'Nordpolen og forbi', key_location_value => null,
      parking_lat_value => 91, parking_lng_value => 12.5,
      event_title => null, event_body => null);`,
    expect: "22023",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL vehicle-location-pin-out-of-range-refused: the refused write moved the pin (%)', ${WS1_PIN}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-old-client-call-clears-the-pin",
    desc: "a pre-168 client posts only its five named keys — the save succeeds and the stale pin goes",
    setup: [step(B, SET_LOCATION_B_WITH_PIN)],
    actor: C,
    // EXACTLY the body govehlo-mobile #561 sends: five named arguments, no mention of
    // the pin. PostgREST resolves it against the seven-argument signature through the
    // two defaults. The save must SUCCEED (an old client is not broken by this
    // migration) and the pin must be GONE (it belonged to the text this call replaced).
    op: `perform public.set_vehicle_location(
      target_ledger_id => '${WS1}',
      parking_location_value => 'Gammel klient flyttede bilen',
      key_location_value => 'Noegler hos Cille',
      event_title => 'Cille flyttede bilen', event_body => null);`,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Gammel klient flyttede bilen / Noegler hos Cille'
      then raise exception 'CASEFAIL vehicle-location-old-client-call-clears-the-pin: the old-signature save did not land (%)', ${WS1_LOCATION}; end if;
      if ${WS1_PIN} <> 'NULL / NULL'
      then raise exception 'CASEFAIL vehicle-location-old-client-call-clears-the-pin: a pin from the PREVIOUS spot survived a text-only save (%)', ${WS1_PIN}; end if;`,
  }),
  rpcCase({
    name: "vehicle-location-feed-says-a-pin-exists-and-never-where",
    desc: "the event metadata carries parking_pin_set and NOT one digit of the coordinates",
    actor: B,
    op: SET_LOCATION_B_WITH_PIN,
    expect: "ok",
    post: `if (select count(*) from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'vehicle_location_updated'
          and (metadata->>'parking_pin_set') = 'true') <> 1
      then raise exception 'CASEFAIL vehicle-location-feed-says-a-pin-exists-and-never-where: no event says a pin was set'; end if;
      if exists (select 1 from public.ledger_events
        where ledger_id = '${WS1}' and event_type = 'vehicle_location_updated'
          and (title || ' ' || coalesce(body, '') || ' ' || metadata::text) like any (array['%${PIN_LAT}%', '%${PIN_LNG}%']))
      then raise exception 'CASEFAIL vehicle-location-feed-says-a-pin-exists-and-never-where: a coordinate reached the feed'; end if;`,
  }),
  rpcCase({
    name: "handover-mirrors-its-locations-onto-the-workspace",
    desc: "saving a handover that carries parking and keys updates the car's CURRENT location too",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS)],
    actor: B,
    op: SAVE_HANDOVER_B,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'P-kaelder niveau 2, plads 14 / Noegler i postkassen'
      then raise exception 'CASEFAIL handover-mirrors-its-locations-onto-the-workspace: columns hold %', ${WS1_LOCATION}; end if;
      if ${WS1_LOCATION_AUTHOR} <> '${ID.B}'
      then raise exception 'CASEFAIL handover-mirrors-its-locations-onto-the-workspace: the mirror did not stamp its author (%)', ${WS1_LOCATION_AUTHOR}; end if;`,
  }),
  rpcCase({
    name: "handover-without-a-location-preserves-the-workspace-one",
    desc: "a handover that mentions neither parking nor keys leaves C's earlier location — and her stamp — untouched",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(C, SET_LOCATION_C)],
    actor: B,
    op: SAVE_HANDOVER_B_NO_LOCATION,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Gaden foran nr. 14 / Noegler i postkassen hos Cille'
      then raise exception 'CASEFAIL handover-without-a-location-preserves-the-workspace-one: a partial handover erased the car location (%)', ${WS1_LOCATION}; end if;
      if ${WS1_LOCATION_AUTHOR} <> '${ID.C}'
      then raise exception 'CASEFAIL handover-without-a-location-preserves-the-workspace-one: the stamp moved to % although nothing mirrored', ${WS1_LOCATION_AUTHOR}; end if;
      if not exists (select 1 from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}')
      then raise exception 'CASEFAIL handover-without-a-location-preserves-the-workspace-one: the handover itself was not saved'; end if;`,
  }),
  rpcCase({
    name: "handover-mirrors-only-the-field-it-carries",
    desc: "parking mirrors, the omitted key location keeps C's value — per field, not all-or-nothing",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(C, SET_LOCATION_C)],
    actor: B,
    op: `perform public.upsert_booking_handover(
      target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
      end_odometer_value => 82345, fuel_fraction_value => 0.5,
      parking_location_value => 'Flyttet til P-huset', key_location_value => null,
      condition_ok_value => true, keys_confirmed_value => true);`,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Flyttet til P-huset / Noegler i postkassen hos Cille'
      then raise exception 'CASEFAIL handover-mirrors-only-the-field-it-carries: columns hold %', ${WS1_LOCATION}; end if;
      if ${WS1_LOCATION_AUTHOR} <> '${ID.B}'
      then raise exception 'CASEFAIL handover-mirrors-only-the-field-it-carries: a mirror that wrote something must stamp its author (%)', ${WS1_LOCATION_AUTHOR}; end if;`,
  }),

  // ── 16c. The pin travels WITH the handover (migration 170: GVM-540) ────────
  // Migration 168 bound the pin to the parking TEXT and had the handover mirror CLEAR
  // it, for the reason 168 wrote down: "a handover form has no way to drop a pin".
  // GVM-540 gives it one, so the rule becomes symmetric — a fresh pin REPLACES, no pin
  // still CLEARS, no parking text still PRESERVES. Two of those three are migration
  // 168's behaviour unchanged, and they are re-pinned here against the NEW signature so
  // that adding the parameters cannot have quietly changed them.
  //
  // The case that matters most is the last one: an old client posts the thirteen named
  // keys that existed before 170 and must produce the IDENTICAL row it produces today,
  // pin cleared and all. That is what makes this migration safe to apply before the
  // mobile half ships.
  rpcCase({
    name: "handover-pin-lands-on-the-workspace",
    desc: "a handover carrying a fresh pin writes it — the driver at the car tapped 'brug min placering'",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B)],
    actor: B,
    op: SAVE_HANDOVER_B_WITH_PIN,
    expect: "ok",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL handover-pin-lands-on-the-workspace: the pin holds %', ${WS1_PIN}; end if;
      if ${WS1_LOCATION} <> 'P-kaelder niveau 2, plads 14 / Noegler i postkassen'
      then raise exception 'CASEFAIL handover-pin-lands-on-the-workspace: the text did not mirror (%)', ${WS1_LOCATION}; end if;
      if (select count(*) from public.booking_handovers bh
            where bh.booking_id = '${HANDOVER_BOOKING_B}') <> 1
      then raise exception 'CASEFAIL handover-pin-lands-on-the-workspace: the handover itself was not saved'; end if;`,
  }),
  rpcCase({
    name: "handover-with-a-new-text-and-no-pin-still-clears-it",
    desc: "migration 168's rule, re-pinned against the new signature: a text without a pin drops the stale one",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B_WITH_PIN)],
    actor: B,
    op: SAVE_HANDOVER_B,
    expect: "ok",
    post: `if ${WS1_PIN} <> 'NULL / NULL'
      then raise exception 'CASEFAIL handover-with-a-new-text-and-no-pin-still-clears-it: a pin from the PREVIOUS spot survived (%)', ${WS1_PIN}; end if;
      if ${WS1_LOCATION} <> 'P-kaelder niveau 2, plads 14 / Noegler i postkassen'
      then raise exception 'CASEFAIL handover-with-a-new-text-and-no-pin-still-clears-it: the text did not mirror (%)', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "handover-without-a-parking-text-preserves-the-pin",
    desc: "a handover that asserts nothing about the parking leaves both the text and the pin alone",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B_WITH_PIN)],
    actor: B,
    op: SAVE_HANDOVER_B_NO_LOCATION,
    expect: "ok",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL handover-without-a-parking-text-preserves-the-pin: the pin moved to %', ${WS1_PIN}; end if;
      if ${WS1_LOCATION} <> 'P-plads bag Netto, plads 12 / Noegler hos Bo, 2. sal'
      then raise exception 'CASEFAIL handover-without-a-parking-text-preserves-the-pin: the text moved to %', ${WS1_LOCATION}; end if;`,
  }),
  rpcCase({
    name: "handover-lone-latitude-refused",
    desc: "half a pin is 22023 and nothing is written — not the handover row, not the workspace",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B_WITH_PIN)],
    actor: B,
    op: `perform public.upsert_booking_handover(
      target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
      parking_location_value => 'Kun en halv naal',
      parking_lat_value => ${PIN_LAT}, parking_lng_value => null);`,
    expect: "22023",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL handover-lone-latitude-refused: the refused write moved the pin (%)', ${WS1_PIN}; end if;
      if exists (select 1 from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}')
      then raise exception 'CASEFAIL handover-lone-latitude-refused: a refused write left a handover behind'; end if;`,
  }),
  rpcCase({
    name: "handover-pin-out-of-range-refused",
    desc: "a latitude of 91 is 22023 — the RPC answers before the ledgers check constraint has to",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B_WITH_PIN)],
    actor: B,
    op: `perform public.upsert_booking_handover(
      target_ledger_id => '${WS1}', target_booking_id => '${HANDOVER_BOOKING_B}'::uuid,
      parking_location_value => 'Nordpolen og forbi',
      parking_lat_value => 91, parking_lng_value => 12.5);`,
    expect: "22023",
    post: `if ${WS1_PIN} <> '${PIN_LAT} / ${PIN_LNG}'
      then raise exception 'CASEFAIL handover-pin-out-of-range-refused: the refused write moved the pin (%)', ${WS1_PIN}; end if;
      if exists (select 1 from public.booking_handovers where booking_id = '${HANDOVER_BOOKING_B}')
      then raise exception 'CASEFAIL handover-pin-out-of-range-refused: a refused write left a handover behind'; end if;`,
  }),
  rpcCase({
    name: "handover-old-client-call-clears-the-pin",
    desc: "the pre-170 thirteen-key body still saves, and still clears the pin — byte-identical to today",
    setup: [step(SUPER, SEED_HANDOVER_BOOKINGS), step(B, SET_LOCATION_B_WITH_PIN)],
    actor: B,
    // The whole point of the two defaults. A client that predates migration 170 posts
    // the thirteen named keys it always has; PostgREST resolves that body against the
    // fifteen-argument signature, both coordinates arrive null, and the middle rule
    // applies. If this ever fails, an old build in the App Store has stopped saving
    // handovers — which is why it is a case and not a comment.
    op: SAVE_HANDOVER_B_OLD_SIGNATURE,
    expect: "ok",
    post: `if ${WS1_LOCATION} <> 'Gammel klient flyttede bilen / Noegler i postkassen'
      then raise exception 'CASEFAIL handover-old-client-call-clears-the-pin: the old-signature save did not land (%)', ${WS1_LOCATION}; end if;
      if ${WS1_PIN} <> 'NULL / NULL'
      then raise exception 'CASEFAIL handover-old-client-call-clears-the-pin: a pin from the PREVIOUS spot survived a text-only save (%)', ${WS1_PIN}; end if;`,
  }),

  // ── 17. Recomputing the odometer mirror (migration 195: GV-475) ────────────
  // recompute_handover_mirror is the ONE deliberate exception to migration 193's
  // monotone mirror: it assigns whatever the surviving handovers say, downward
  // included. That is a destructive privilege over a shared fact — the workspace's
  // odometer floor, which gates every Start-km prefill and service calculation — so
  // the only question this section asks is who may exercise it. Admin yes, ordinary
  // member no, another workspace's admin no, anon no. The RPC gates itself
  // (SECURITY DEFINER, is_ledger_admin, which is false for a non-member too, so the
  // admin check IS the workspace boundary); there is no policy behind it to fall back
  // on, which is exactly why the denials are cases and not a comment.
  //
  // Every case starts from the poisoned state the ticket is about: a reading saved too
  // high, then edited down, with the monotone mirror still holding the high value.
  rpcCase({
    name: "handover-mirror-recompute-admin",
    desc: "admin A recomputes the mirror down onto the surviving handover — the GV-475 correction",
    setup: POISONED_MIRROR,
    actor: A,
    op: `perform public.recompute_handover_mirror('${WS1}');`,
    expect: "ok",
    post: `if ${WS1_ODOMETER_MIRROR} <> '8234'
      then raise exception 'CASEFAIL handover-mirror-recompute-admin: the mirror holds % instead of the surviving 8234', ${WS1_ODOMETER_MIRROR}; end if;
      if not exists (select 1 from public.ledger_events le
        where le.ledger_id = '${WS1}' and le.event_type = 'handover_odometer_corrected'
          and le.actor_member_id = '${A_ID}')
      then raise exception 'CASEFAIL handover-mirror-recompute-admin: a correction nobody can see is the state GV-475 is about'; end if;`,
  }),
  rpcCase({
    name: "handover-mirror-recompute-member-denied",
    desc: "B, an ordinary active member and the author of the handover itself, cannot recompute the mirror",
    setup: POISONED_MIRROR,
    actor: B,
    op: `perform public.recompute_handover_mirror('${WS1}');`,
    expect: "42501",
    post: `if ${WS1_ODOMETER_MIRROR} <> '82345'
      then raise exception 'CASEFAIL handover-mirror-recompute-member-denied: a refused recompute moved the mirror to %', ${WS1_ODOMETER_MIRROR}; end if;
      if exists (select 1 from public.ledger_events le
        where le.ledger_id = '${WS1}' and le.event_type = 'handover_odometer_corrected')
      then raise exception 'CASEFAIL handover-mirror-recompute-member-denied: a refused recompute left an event behind'; end if;`,
  }),
  rpcCase({
    name: "handover-mirror-recompute-foreign-admin-denied",
    desc: "E, an ADMIN of the other workspace, cannot recompute ws1's mirror — is_ledger_admin is the boundary",
    setup: POISONED_MIRROR,
    actor: E,
    op: `perform public.recompute_handover_mirror('${WS1}');`,
    expect: "42501",
    post: `if ${WS1_ODOMETER_MIRROR} <> '82345'
      then raise exception 'CASEFAIL handover-mirror-recompute-foreign-admin-denied: another workspace moved ws1 mirror to %', ${WS1_ODOMETER_MIRROR}; end if;`,
  }),
  rpcCase({
    name: "handover-mirror-recompute-anon-denied",
    desc: "anon cannot recompute the mirror — execute is revoked from anon and the RPC would refuse anyway",
    setup: POISONED_MIRROR,
    actor: ANON,
    op: `perform public.recompute_handover_mirror('${WS1}');`,
    expect: "42501",
    post: `if ${WS1_ODOMETER_MIRROR} <> '82345'
      then raise exception 'CASEFAIL handover-mirror-recompute-anon-denied: an anonymous caller moved the mirror to %', ${WS1_ODOMETER_MIRROR}; end if;`,
  }),
];

// ── 7. Run ───────────────────────────────────────────────────────────────────
log(`\n▶ Running ${CASES.length} role-matrix cases…\n`);
let failures = 0;
for (const c of CASES) {
  const r = psql(c.sql);
  if (r.status === 0) {
    log(`  ok    ${c.name} — ${c.desc}`);
  } else {
    failures++;
    const errLine =
      (r.stderr || "").split("\n").find((l) => l.includes("CASEFAIL") || l.includes("ERROR")) ||
      (r.stderr || "").trim().split("\n").slice(-3).join(" | ");
    log(`  FAIL  ${c.name} — ${c.desc}`);
    log(`        ${errLine.trim()}`);
  }
}

// The close/write race needs two real sessions, so it cannot live in a normal
// per-case transaction. Session 1 holds the writer's FOR SHARE lock, waits, then
// commits a trip. Session 2 prepares a snapshot while that trip is invisible and
// calls close. Migration 117 must wait at its wrapper lock, then reject the stale
// fingerprint after the writer commits. The pre-117 implementation closed it.
{
  const writerSql = `begin;
select id from public.settlement_periods where id = '${P1}' for share;
select pg_sleep(1.5);
insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, note, created_by_member_id)
values ('${WS1}', '${P1}', '${ID.B}', current_date, 1100, 1110, 'Concurrent trip', '${ID.B}');
commit;`;
  const writer = spawn(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", DB],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const writerDone = new Promise((resolve) => writer.on("close", resolve));
  let writerStdout = "";
  let writerStderr = "";
  writer.stdout.on("data", (chunk) => { writerStdout += chunk; });
  writer.stderr.on("data", (chunk) => { writerStderr += chunk; });
  writer.stdin.end(writerSql);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const close = psql(`
select set_config('request.jwt.claims', '${A.claims}', false);
set role authenticated;
select public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});
reset role;`);
  const writerStatus = await writerDone;

  if (writerStatus !== 0) {
    failures++;
    log("  FAIL  close-serializes-concurrent-writer — writer session failed");
    log(`        ${(writerStderr || writerStdout).trim()}`);
  } else if (close.status === 0 || !close.stderr.includes("Entries changed since this close was prepared")) {
    failures++;
    log("  FAIL  close-serializes-concurrent-writer — stale snapshot was not rejected after writer commit");
    log(`        ${(close.stderr || close.stdout).trim()}`);
  } else {
    log("  ok    close-serializes-concurrent-writer — close waits for the writer and rejects its stale fingerprint");
  }
}

// GV-293 Finding 2 — the SAME serialization must hold when the writer does NOT take a
// manual FOR SHARE (unlike the block above). A plain authenticated PostgREST trip
// INSERT relies entirely on enforce_settlement_entry_lock's closed-period read, which
// now locks the period row FOR SHARE. The in-flight writer therefore makes the close
// wait on the trigger's lock, and the stale fingerprint is rejected once the trip
// commits. Before migration 120 that read was lock-free, so this close would commit and
// orphan the concurrent trip outside the archived snapshot. The writer inserts FIRST
// (the trigger takes FOR SHARE during the insert), then sleeps holding the lock.
{
  const writerSql = `begin;
select set_config('request.jwt.claims', '${B.claims}', false);
set role authenticated;
insert into public.trips (ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, note, created_by_member_id)
values ('${WS1}', '${P1}', '${ID.B}', current_date, 1200, 1210, 'GV-293 trigger-lock trip', '${ID.B}');
reset role;
select pg_sleep(1.5);
commit;`;
  const writer = spawn(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", DB],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const writerDone = new Promise((resolve) => writer.on("close", resolve));
  let writerStdout = "";
  let writerStderr = "";
  writer.stdout.on("data", (chunk) => { writerStdout += chunk; });
  writer.stderr.on("data", (chunk) => { writerStderr += chunk; });
  writer.stdin.end(writerSql);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const close = psql(`
select set_config('request.jwt.claims', '${A.claims}', false);
set role authenticated;
select public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});
reset role;`);
  const writerStatus = await writerDone;

  if (writerStatus !== 0) {
    failures++;
    log("  FAIL  close-serializes-triggerlocked-writer — writer session failed");
    log(`        ${(writerStderr || writerStdout).trim()}`);
  } else if (close.status === 0 || !close.stderr.includes("Entries changed since this close was prepared")) {
    failures++;
    log("  FAIL  close-serializes-triggerlocked-writer — stale snapshot was not rejected after the unlocked writer committed");
    log(`        ${(close.stderr || close.stdout).trim()}`);
  } else {
    log("  ok    close-serializes-triggerlocked-writer — the entry-lock trigger's FOR SHARE makes the close wait and reject the stale fingerprint");
  }
}

// Did the coverage check's client half actually run? Read by the final summary line so
// a half-run guard cannot report as a whole one (GV-391).
let coverageRan = false;

// ── Coverage check: is this guard certifying code production never runs? (GV-379) ──
//
// GV-277 put the entire recurring-suspension feature on set_ledger_member_active_admin,
// which no client calls — both clients deactivate through upsert_ledger_member_admin.
// It was dark from migration 114 until migration 145. CI stayed green the whole time
// because THIS guard is that function's only caller anywhere: it exercised the fixed
// function, so the feature looked tested while every real deactivation went through the
// unfixed one. A guard pointed at unreachable code is worse than no guard — it actively
// suppresses suspicion.
//
// So the guard now audits its own coverage. Three inputs:
//
//   1. What it exercises — read out of this file's own source (comments stripped), so
//      it covers the CASES array, the SEED fixture and the hand-rolled concurrency
//      blocks alike, and cannot drift from a refactor that moves cases between them.
//   2. What `authenticated` may execute — asked of the LIVE replayed database rather
//      than grepped out of the migrations. That distinction is load-bearing: the
//      migration text contains 85 `grant execute` statements naming 65 distinct
//      functions for `authenticated`, but the end state only lets `authenticated`
//      execute 66 of them, because migrations 083/130/131/143 and friends revoke as
//      well as grant. Grepping the grants would audit a schema that does not exist.
//   3. Who calls it — a scan of the two sibling client repos, discounting the vendored
//      generated type files, which declare every RPC and are never call sites.
//
// The overlap of all three is reported. It is NOT hard-failed on sight: the guard
// cannot know which overlaps are intended, and failing on day one would just produce a
// large rubber-stamp allow-list — the failure mode this project has rejected twice
// (GV-375, GV-374). Each overlap must instead carry a reviewed entry in
// tools/role-matrix-coverage-allowlist.mjs with a written reason and a review-by date,
// which warns loudly every run and fails once it goes stale or expires.
{
  log("");
  log("── Coverage: functions this guard exercises that no client calls (GV-379) ──");

  const guardSource = fs.readFileSync(path.join(REPO, "tools/test-rls-role-matrix.mjs"), "utf8");
  const exercised = exercisedFunctions(guardSource);

  // Production-faithful reachability, straight from the replayed catalog. The PRELUDE
  // above installs Supabase's default privileges, so this answers the real question —
  // "could a signed-in user call this?" — for both explicitly granted RPCs and any
  // function that merely inherited EXECUTE and was never revoked.
  const grantRes = psql(
    `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by 1;`,
    ["-A", "-t"],
  );
  if (grantRes.status !== 0) fail(`Coverage check could not read function privileges:\n${grantRes.stderr}`);
  const callableByAuthenticated = new Set(grantRes.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean));

  // Only functions this guard invokes directly AND a signed-in user could reach are in
  // scope. Trigger functions and service-role-only RPCs are exercised on purpose and
  // are not what GV-277 was about.
  const inScope = [...exercised].filter((fn) => callableByAuthenticated.has(fn)).sort();

  const SIBLINGS = [
    { label: "govehlo-mobile", dir: "../govehlo-mobile" },
    { label: "govehlo-web", dir: "../govehlo-web" },
  ];

  const callers = new Map(inScope.map((fn) => [fn, []]));
  const scanned = [];
  const missing = [];
  for (const { label, dir } of SIBLINGS) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) {
      missing.push(label);
      log(`⚠ Coverage: ${label} not found at ${dir} — client call sites NOT checked against it.`);
      continue;
    }
    scanned.push(label);
    for (const [fn, hits] of findClientCallers(abs, inScope)) {
      for (const hit of hits) callers.get(fn).push({ repo: label, ...hit });
    }
  }

  // With a sibling absent, "no client calls it" is unknowable, not true — claiming a
  // finding here would be a false accusation, and every entry would look stale. So the
  // client half is skipped entirely unless both repos were scanned.
  const clientHalfRan = missing.length === 0;
  let coverageFailed = false;
  const problems = [];

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const entries = [];
  for (const [i, entry] of coverageExceptions.entries()) {
    const where = `role-matrix-coverage-allowlist.mjs entry ${i + 1}`;
    if (typeof entry.fn !== "string" || !/^[a-z0-9_]+$/.test(entry.fn)) {
      problems.push(`${where}: "fn" must be an unqualified function name, got ${JSON.stringify(entry.fn)}`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
      problems.push(`${where} (${entry.fn}): "reason" must explain the exception to a reviewer with no context`);
      continue;
    }
    if (typeof entry.reviewBy !== "string" || !ISO_DATE.test(entry.reviewBy)) {
      problems.push(`${where} (${entry.fn}): "reviewBy" must be a YYYY-MM-DD date`);
      continue;
    }
    if (seen.has(entry.fn)) {
      problems.push(`${where} (${entry.fn}): duplicate entry`);
      continue;
    }
    seen.add(entry.fn);
    if (entry.reviewBy < today) {
      problems.push(
        `${where} (${entry.fn}): EXPIRED on ${entry.reviewBy} — re-make the judgement, then either ` +
        "retire the function / revoke its grant / give it a real caller, or write the reason afresh " +
        "with a new reviewBy.",
      );
      continue;
    }
    entries.push(entry);
  }

  const uncalled = inScope.filter((fn) => callers.get(fn).length === 0);
  const excused = new Set(entries.map((e) => e.fn));

  if (clientHalfRan) {
    const unlisted = uncalled.filter((fn) => !excused.has(fn));
    for (const fn of unlisted) {
      coverageFailed = true;
      log(`  FAIL  coverage — this guard exercises public.${fn}, which authenticated may execute, but NO client calls it.`);
    }

    // An entry whose condition no longer holds must go, or the list slowly becomes a
    // wishlist nobody can audit. Two ways that happens, and they mean opposite things:
    // the function stopped being exercised (this guard changed), or a client started
    // calling it (the good ending — the function is alive now).
    for (const entry of entries) {
      if (!exercised.has(entry.fn)) {
        problems.push(
          `role-matrix-coverage-allowlist.mjs (${entry.fn}): STALE — this guard no longer exercises it, ` +
          "so nothing is being excused. Delete the entry.",
        );
      } else if (!callableByAuthenticated.has(entry.fn)) {
        problems.push(
          `role-matrix-coverage-allowlist.mjs (${entry.fn}): STALE — authenticated can no longer execute it ` +
          "(its grant was revoked), so it is out of scope. Delete the entry.",
        );
      } else if (callers.get(entry.fn).length > 0) {
        const where = callers.get(entry.fn).map((h) => `${h.repo}/${h.file}:${h.line}`).join(", ");
        problems.push(
          `role-matrix-coverage-allowlist.mjs (${entry.fn}): STALE — a client calls it now (${where}). ` +
          "The function is reachable; delete the entry.",
        );
      }
    }

    for (const entry of entries) {
      if (!uncalled.includes(entry.fn)) continue;
      log(
        `⚠ Coverage: exercising public.${entry.fn}, which no client calls ` +
        `(reviewed, expires ${entry.reviewBy}) — ${entry.reason}`,
      );
    }

    if (!coverageFailed && problems.length === 0) {
      log(
        `  ok    coverage — ${inScope.length} authenticated-callable function(s) exercised; ` +
        `${inScope.length - uncalled.length} have client call sites, ${uncalled.length} reviewed exception(s).`,
      );
    }
  } else {
    log(
      `⚠ Coverage: client call sites NOT checked (missing: ${missing.join(", ")}) — ` +
      `${inScope.length} authenticated-callable function(s) exercised, reachability unverified.`,
    );
    if (STRICT) {
      coverageFailed = true;
      log("  FAIL  coverage — --strict requires every sibling repo to be checked out.");
    } else if (process.env.GITHUB_ACTIONS) {
      // GV-391: this ran in CI for weeks printing the warning above into a log body
      // nobody opens, under a green tick and a job named for the suite that DID pass.
      // An annotation surfaces on the run summary itself, so "this job did not do the
      // thing GV-379 built it to do" is visible without expanding a single step.
      log(
        "::warning title=Role-matrix coverage half did NOT run::" +
        `The GV-379 reachability check was SKIPPED: ${missing.join(" and ")} not checked out, so ` +
        `whether any client calls the ${inScope.length} authenticated-callable function(s) this guard ` +
        "exercises is UNVERIFIED by this job. Only the matrix half ran. The complete check runs in " +
        "the 'Umbrella cross-repo checks' workflow, which checks out all three repos and runs " +
        "tools/test-rls-role-matrix.mjs --strict.",
      );
    }
  }

  if (problems.length > 0) {
    coverageFailed = true;
    log("  FAIL  coverage — the reviewed-exception list needs attention:");
    for (const problem of problems) log(`        - ${problem}`);
  }

  if (coverageFailed) {
    failures++;
    log("");
    log("A guard pointed at unreachable code is worse than no guard: it certifies a path");
    log("production never takes (GV-277 / migration 114 vs 145). Either give the function a");
    log("real caller, retire it, revoke its authenticated grant, or add a reviewed entry to");
    log("tools/role-matrix-coverage-allowlist.mjs with a written reason and a review-by date.");
  }

  if (missing.length > 0 && !STRICT) {
    log(
      "⚠ Coverage: this run did NOT verify reachability — re-run with the sibling repo(s) " +
      "checked out alongside fuel_sharing for a complete check (or pass --strict to fail loudly).",
    );
  }

  coverageRan = clientHalfRan;
}

cleanup();

log("");
if (failures > 0) {
  process.stderr.write(`❌ Role matrix: ${failures} failure(s) across ${CASES.length} case(s) + the coverage check.\n`);
  process.exit(1);
}
// GV-391: an unqualified "all cases passed" is what let a half-run guard read as a
// full one for weeks. The success line now states which halves actually ran.
log(
  coverageRan
    ? `✅ Role matrix: all ${CASES.length} cases passed, coverage check clean.`
    : `✅ Role matrix: all ${CASES.length} cases passed — coverage half SKIPPED (sibling repos absent; ` +
      "client reachability UNVERIFIED, run with the siblings checked out or see umbrella.yml).",
);

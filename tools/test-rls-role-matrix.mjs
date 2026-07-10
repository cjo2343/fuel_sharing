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
//   1. One disposable Postgres 15 container (matches Supabase), repo mounted
//      read-only. All psql runs INSIDE the container; the host needs only
//      Docker. Reuses the exact mechanics of check-schema-equivalence.mjs.
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

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

const IMAGE = "postgres:15-alpine";
const CONTAINER = `govehlo-role-matrix-${process.pid}`;
const REPO = process.cwd();
const DB = "role_matrix";

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
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
grant usage on schema public to anon, authenticated, service_role;
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
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount, station_lat, station_lng, created_by_member_id)
values (
  '22222222-3333-4444-5555-666666666666', '${WS1}',
  (select id from public.settlement_periods where ledger_id = '${WS1}' and status = 'open' limit 1),
  (select id from public.ledger_members where ledger_id = '${WS1}' and email = '${EMAIL.A}'),
  current_date, 300.00, 56.1600000, 10.2100000,
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

const CASES = [
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
    name: "upsert-debtor-paidpending-stored",
    desc: "debtor B -> paid_pending carrying the stored amount",
    setup: [step(A, CREATE_REQ_300)],
    actor: B,
    op: upsert(WS1, P1, ID.B, A_ID, 300, "paid_pending"),
    expect: "ok",
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
    name: "upsert-recipient-rerequest-amount",
    desc: "recipient A re-requests a live request at a new amount",
    setup: [step(A, CREATE_REQ_300)],
    actor: A,
    op: upsert(WS1, P1, ID.B, A_ID, 275, "requested"),
    expect: "ok",
    post: `if (select amount from public.settlement_requests where period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}') <> 275
      then raise exception 'CASEFAIL upsert-recipient-rerequest-amount: amount not updated'; end if;`,
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
    setup: [step(A, upsert(WS1, P1, ID.B, A_ID, 0.01, "requested"))],
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

cleanup();

log("");
if (failures > 0) {
  process.stderr.write(`❌ Role matrix: ${failures}/${CASES.length} case(s) failed.\n`);
  process.exit(1);
}
log(`✅ Role matrix: all ${CASES.length} cases passed.`);

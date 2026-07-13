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

import { execFileSync, spawn, spawnSync } from "node:child_process";
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
    update public.ledgers set repairs_split_mode = mode where id = '${WS1}';
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
  update public.ledgers set repairs_split_mode = 'deles_ikke' where id = '${WS1}';
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
    name: "repairs-close-blocked-stale-request-gv260",
    desc: "close blocked when a repairs-inflated (350 kr) settlement only has an old 300 kr request (GV-260 interaction)",
    setup: [
      step(SUPER, `update public.ledger_members set is_active = false where id in ('${ID.C}', '${ID.G}');`),
      step(A, CREATE_REQ_300),
      step(A, `perform public.insert_repair('${WS1}', current_date, 'Ny bremseskive', 100.00);`),
    ],
    actor: A,
    op: `perform public.close_settlement_period('${WS1}', '${P1}', ${CLOSE_SNAPSHOT});`,
    expect: "42501",
    post: `if (select status from public.settlement_periods where id = '${P1}') <> 'open'
      then raise exception 'CASEFAIL repairs-close-blocked-stale-request-gv260: period should remain open'; end if;`,
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
  queryCase({
    name: "deactivation-suspends-payer-recurring",
    desc: "deactivating a member suspends every recurring template they pay for and writes a recurring_suspended event (GV-277)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('c1c1c1c1-0000-0000-0000-000000000001', '${WS1}', 'other', 'Cilles abonnement', 100.00, 'monthly', current_date, '${ID.C}', true, '${A_ID}');`),
    ],
    actor: A,
    assert: `declare still_active boolean; evt_count integer; evt_body text;
begin
  perform public.set_ledger_member_active_admin('${WS1}', '${ID.C}', false);
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

  // ── 10. Recurring generation vs entry lock (migration 116: GV-281) ───────────
  // A locked open period (an active settlement request) must NOT crash recurring
  // generation. The scheduler defers the locked ledger and counts it; a second,
  // unlocked ledger in the same sweep still generates; the deferred occurrence
  // catches up once the lock lifts; the client variant returns a zero-summary
  // instead of raising.
  queryCase({
    name: "recurring-sweep-skips-locked-ledger",
    desc: "generate_all_due_recurring_expenses defers a ledger whose open period is entry-locked: ledgers_skipped=1, no exception, no occurrence (GV-281)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d1d1d1d1-0000-0000-0000-000000000001', '${WS1}', 'other', 'Laast-periode skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: SERVICE,
    assert: `declare res jsonb; occ integer;
begin
  res := public.generate_all_due_recurring_expenses(200);
  if (res->>'ledgers_skipped')::int <> 1 then
    raise exception 'CASEFAIL recurring-sweep-skips-locked-ledger: ledgers_skipped=% (expected 1)', res->>'ledgers_skipped';
  end if;
  if res->>'first_error' is not null then
    raise exception 'CASEFAIL recurring-sweep-skips-locked-ledger: first_error=% (expected null — a lock skip is not an error)', res->>'first_error';
  end if;
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd1d1d1d1-0000-0000-0000-000000000001';
  if occ <> 0 then
    raise exception 'CASEFAIL recurring-sweep-skips-locked-ledger: generated % occurrence(s) into a locked period (expected 0)', occ;
  end if;
end`,
  }),
  queryCase({
    name: "recurring-sweep-generates-unlocked-alongside-locked",
    desc: "a second, unlocked ledger in the same sweep still generates while the locked one is deferred (GV-281 — no batch poisoning)",
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
  if (res->>'ledgers_skipped')::int <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: ledgers_skipped=% (expected 1 — only the locked ledger)', res->>'ledgers_skipped';
  end if;
  if (res->>'ledgers_touched')::int < 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: ledgers_touched=% (expected >=1 — the unlocked ledger generated)', res->>'ledgers_touched';
  end if;
  select count(*) into occ_locked from public.workspace_expenses where recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000001';
  select count(*) into occ_unlocked from public.workspace_expenses where recurring_expense_id = 'd2d2d2d2-0000-0000-0000-000000000002';
  if occ_locked <> 0 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: locked ledger generated % (expected 0)', occ_locked;
  end if;
  if occ_unlocked <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-unlocked-alongside-locked: unlocked ledger generated % (expected 1)', occ_unlocked;
  end if;
end`,
  }),
  queryCase({
    name: "recurring-sweep-generates-deferred-after-cancel",
    desc: "cancelling the request unlocks the period, so the next sweep generates the deferred occurrence (GV-281 catch-up)",
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
  if (res->>'ledgers_skipped')::int <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-deferred-after-cancel: first sweep ledgers_skipped=% (expected 1 while locked)', res->>'ledgers_skipped';
  end if;
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd3d3d3d3-0000-0000-0000-000000000001';
  if occ <> 0 then
    raise exception 'CASEFAIL recurring-sweep-generates-deferred-after-cancel: generated % while locked (expected 0)', occ;
  end if;
  -- Cancel the live request → the period is no longer entry-locked.
  update public.settlement_requests
    set status = 'cancelled'
    where ledger_id = '${WS1}' and period_id = '${P1}' and from_member_id = '${ID.B}' and to_member_id = '${A_ID}';
  res := public.generate_all_due_recurring_expenses(200);
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd3d3d3d3-0000-0000-0000-000000000001';
  if occ <> 1 then
    raise exception 'CASEFAIL recurring-sweep-generates-deferred-after-cancel: after cancel generated % (expected 1 — the deferred occurrence caught up)', occ;
  end if;
end`,
  }),
  queryCase({
    name: "recurring-client-zero-summary-when-locked",
    desc: "generate_due_recurring_expenses (client catch-up) returns {generated:0, reason:'locked'} instead of raising when the open period is locked (GV-281)",
    setup: [
      step(SUPER, `insert into public.recurring_expenses
        (id, ledger_id, category, description, amount_dkk, cadence, next_due_date, paid_by_member_id, is_active, created_by_member_id)
        values ('d4d4d4d4-0000-0000-0000-000000000001', '${WS1}', 'other', 'Klient laast skabelon', 100.00, 'monthly', current_date, '${A_ID}', true, '${A_ID}');`),
      step(A, CREATE_REQ_300),
    ],
    actor: A,
    assert: `declare res jsonb; occ integer;
begin
  res := public.generate_due_recurring_expenses('${WS1}');
  if (res->>'generated')::int <> 0 then
    raise exception 'CASEFAIL recurring-client-zero-summary-when-locked: generated=% (expected 0 — no raise, no insert)', res->>'generated';
  end if;
  if res->>'reason' is distinct from 'locked' then
    raise exception 'CASEFAIL recurring-client-zero-summary-when-locked: reason=% (expected locked)', res->>'reason';
  end if;
  select count(*) into occ from public.workspace_expenses where recurring_expense_id = 'd4d4d4d4-0000-0000-0000-000000000001';
  if occ <> 0 then
    raise exception 'CASEFAIL recurring-client-zero-summary-when-locked: generated % occurrence(s) (expected 0)', occ;
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

cleanup();

log("");
if (failures > 0) {
  process.stderr.write(`❌ Role matrix: ${failures}/${CASES.length} case(s) failed.\n`);
  process.exit(1);
}
log(`✅ Role matrix: all ${CASES.length} cases passed.`);

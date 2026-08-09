// Anti-drift contract for the zero-km fuel carry-forward (GV-472, migration 194).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 194 changes what a settlement MEANS in one specific state, and that state
// is the one nobody looks at: a period with no kilometres. Before 194,
// calculate_period_settlement credited the fuel payer in full and debited nobody, so
// the period summed to +totalPaid instead of 0 (GV-471-F1) and close_settlement_period
// archived it anyway. After 194 the fuel is excluded from `net`, reported as
// deferredFuel, and MOVED into the next period by the close.
//
// Three things about that are easy to break later and hard to notice:
//
//   1. The zero-km branch of `net` and the totalKm > 0 branch sit on adjacent lines of
//      the same CASE. A tidy-up that "unifies" them silently re-introduces the bug, or
//      silently changes every ordinary settlement in the app. Part 3 below pins the
//      totalKm > 0 answer BYTE-FOR-BYTE against a database replayed from migrations
//      001–193 — the pre-194 schema — so "nothing else changed" is measured, not
//      asserted.
//   2. The promotion in close_settlement_period_unlocked runs AFTER the flip to closed,
//      and that is not cosmetic: enforce_settlement_entry_lock's requested/paid rail
//      (migration 120) rejects a period_id change while the period is locked by a live
//      request, and settlement_entry_is_locked (migration 090) only counts requests
//      whose period is still OPEN. Move the promotion earlier and every period that
//      actually settles money fails to close with 42501. The fixture that proves this
//      therefore closes a LOCKED period — one with a real requested settlement — not a
//      quiet one.
//   3. The archived entryFingerprint is re-frozen over what REMAINS. That is what keeps
//      closed-period immutability coherent (recompute it later and it must still
//      match), and it is also the only reason a CHAINED carry can happen at all: a
//      fingerprint that kept the moved fuel's id would be reproduced verbatim by the
//      successor period and rejected by the duplicate-snapshot guard.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (static): the SHAPE of migration 194 and of its supabase-schema.sql mirror,
//   plus the GV-413 classification of the new event type. check-schema-equivalence
//   proves the two files replay identically; this proves the thing they both replay is
//   the thing GV-472 decided.
// Part 2 (Docker): the ARITHMETIC and the CLOSE, on a real Postgres.
// Part 3 (Docker): the pre-194 comparison — the same mixed fixture on both schemas.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-zero-km-fuel-carryforward-contract.mjs            # warn on Docker
//   node tools/test-zero-km-fuel-carryforward-contract.mjs --strict   # umbrella
//
// Without Docker the behavioural halves are skipped and warn, exactly as
// test-crossing-split-contract.mjs and test-fuel-stop-verdict-contract.mjs do, so
// `npm run validate` stays dependency-free. There is no cross-repo half here: the
// mobile mirror of this rule (settlement-calc.ts must stop crediting fuel at zero km)
// is enforced by the server itself — an old client's snapshot fails the close's
// per-member 0,02 kr gate — which is a louder alarm than a regex over a sibling repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FEED_VISIBLE_EVENT_TYPES } from "./ledger-event-visibility.mjs";
import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-zero-km-carryforward-${process.pid}`;
const DB = "carryforward";
const DB_PRE = "pre194";

const warnings = [];
function warn(title, message) {
  if (STRICT) {
    process.stderr.write(`\n::error title=${title}::${message} (--strict)\n`);
    process.exit(1);
  }
  warnings.push(message);
  process.stdout.write(`::warning title=${title}::${message}\n`);
}

let checked = 0;
function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: the SHAPE (needs nothing)
// ═══════════════════════════════════════════════════════════════════════════════
const MIGRATION = join(ROOT, "supabase", "migrations", "194_zero_km_fuel_carryforward.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of both functions, so a
// bare search proves nothing about which one WINS. Last definition wins on replay, so
// read only the tail from 194's own mirror header.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 194:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 194 mirror block");

const sqlSources = {
  "migration 194": readFileSync(MIGRATION, "utf8"),
  "supabase-schema.sql (194 tail)": consolidatedSql.slice(mirrorIdx),
};

process.stdout.write("\nSQL shape (migration 194 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sqlSources)) {
  const calc = sql.slice(
    sql.indexOf("create or replace function public.calculate_period_settlement("),
    sql.indexOf("create or replace function public.close_settlement_period_unlocked("),
  );
  const close = sql.slice(sql.indexOf("create or replace function public.close_settlement_period_unlocked("));
  assert.notEqual(calc.length, 0, `${name}: calculate_period_settlement not found`);
  assert.notEqual(close.length, 0, `${name}: close_settlement_period_unlocked not found`);

  pin(`${name}: the totalKm > 0 branch of net is migration 157 UNCHANGED`, () => {
    // The whole compatibility story rests on this line. If it moves, every ordinary
    // settlement in the app moves with it.
    assert.match(
      calc,
      /then round\(pm\.fuel_paid \+ pm\.expense_paid \+ pm\.repair_paid \+ pm\.crossing_paid - round\(pm\.km \* \(t\.total_paid \/ t\.total_km\), 2\) - pm\.expense_share - pm\.repair_share - pm\.crossing_share, 2\)/,
    );
  });

  pin(`${name}: the zero-km branch of net no longer credits fuel`, () => {
    assert.match(
      calc,
      /else round\(pm\.expense_paid \+ pm\.repair_paid \+ pm\.crossing_paid - pm\.expense_share - pm\.repair_share - pm\.crossing_share, 2\) end/,
      "at zero km the fuel credit must be gone — that credit with no matching debit IS GV-471-F1",
    );
    assert.doesNotMatch(
      calc,
      /else round\(pm\.fuel_paid \+ /,
      "the pre-194 zero-km branch must not survive anywhere in the live definition",
    );
  });

  pin(`${name}: fuelPaid and totalPaid stay RAW in both branches (old-client gate)`, () => {
    // The close guard compares a client snapshot's totalPaid and per-member fuelPaid
    // against these. Netting the deferral out of them would fail every close from every
    // client, new and old alike.
    assert.match(calc, /'totalPaid', t\.total_paid,/);
    assert.match(calc, /'fuelPaid', pm\.fuel_paid,/);
    assert.match(calc, /coalesce\(sum\(pm\.fuel_paid\), 0\) as total_paid,/);
  });

  pin(`${name}: deferredFuel is emitted ONLY at totalKm = 0 with fuel present`, () => {
    assert.match(
      calc,
      /\|\| case\s*\n\s*when t\.total_km = 0 and t\.total_paid > 0 then jsonb_build_object\(\s*\n\s*'deferredFuel',/,
      "deferredFuel must be concatenated conditionally — a totalKm > 0 caller must see the pre-194 key set",
    );
    assert.match(calc, /else '\{\}'::jsonb\s*\n\s*end/);
    assert.match(calc, /'total', t\.total_paid,/);
    assert.match(calc, /'fuelPaid', pm\.fuel_paid\s*\n\s*\) order by pm\.id::text collate "C"\)/);
  });

  pin(`${name}: the promotion targets migration 140's queued carry-over period`, () => {
    assert.match(
      close,
      /v_carry_period_id := public\.ensure_settlement_carryover_period\(target_ledger_id, target_period_id\);/,
      "the destination must be the same queued successor the 140 late-entry carry-over uses",
    );
  });

  pin(`${name}: the promotion runs AFTER the flip to closed, inside the scrub bypass`, () => {
    const flip = close.indexOf("raise exception 'Open settlement period was not found or was already closed' using errcode = '40001';");
    const move = close.indexOf("update public.fuel_payments fp\n    set period_id = v_carry_period_id");
    const reopen = close.indexOf("insert into public.settlement_periods (ledger_id, status, label, opened_at)");
    assert.notEqual(move, -1, "the fuel promotion UPDATE is missing");
    assert.ok(
      flip !== -1 && flip < move,
      "the promotion must run AFTER the period is closed — settlement_entry_is_locked only counts " +
        "requests on an OPEN period, so moving fuel out of a still-open locked period raises 42501",
    );
    assert.ok(move < reopen, "the promotion must run BEFORE the next open period is inserted, so 140's trigger promotes it");
    const guarded = close.slice(close.lastIndexOf("perform set_config('govehlo.pii_scrub', '1', true);", move), move);
    assert.notEqual(guarded.length, 0, "the promotion UPDATE must sit inside the transaction-local scrub bypass");
    assert.match(
      close.slice(move, reopen),
      /perform set_config\('govehlo\.pii_scrub', '', true\);/,
      "the scrub bypass must be closed again immediately after the promotion",
    );
  });

  pin(`${name}: the archived entryFingerprint is re-frozen over what remains`, () => {
    assert.match(
      close,
      /v_carry_fingerprint := public\.calculate_period_entry_fingerprint\(target_ledger_id, closed_period_id\);/,
    );
    assert.match(close, /jsonb_set\(sp\.snapshot_json, '\{entryFingerprint\}', to_jsonb\(v_carry_fingerprint\)\)/);
    assert.match(
      close,
      /when sp\.snapshot_json \? 'entryFingerprint'/,
      "a snapshot that carried no fingerprint must not gain one — an old client that cannot hash still closes",
    );
  });

  pin(`${name}: the duplicate-snapshot guard skips an entry-less period`, () => {
    assert.match(close, /if snapshot_fingerprint is not null and v_period_has_entries then/);
  });

  pin(`${name}: one Danish, server-authored fuel_carried_forward event`, () => {
    assert.match(close, /'fuel_carried_forward',/);
    assert.match(
      close,
      /'Brændstof på '\s*\n\s*\|\| translate\(to_char\(round\(v_carry_fuel_total, 2\), 'FM999,999,990\.00'\), '\.,', ',\.'\)\s*\n\s*\|\| ' kr flyttet til næste periode',/,
      "the amount must be formatted with the template's own literal separators (G/D follow lc_numeric) " +
        "and then transposed to Danish",
    );
  });
}

pin("fuel_carried_forward is classified FEED-VISIBLE (GV-413)", () => {
  assert.ok(
    FEED_VISIBLE_EVENT_TYPES.includes("fuel_carried_forward"),
    "money moving between periods is news for every member; the feed renders whatever the database writes",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Parts 2 + 3: behaviour, on a real Postgres
// ═══════════════════════════════════════════════════════════════════════════════
let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  warn(
    "Zero-km carry-forward behaviour not checked",
    "Docker is unavailable, so calculate_period_settlement and close_settlement_period were NOT executed. " +
      "The deferral arithmetic, the close-time promotion, the chained carry and the pre-194 comparison " +
      "were skipped on this run.",
  );
  report();
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ zero-km fuel carry-forward contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function seed(db, sql, label) {
    const res = psql(CONTAINER, db, ["-c", sql]);
    if (res.status !== 0) fail(`Seeding ${label} failed on ${db}:\n${res.stderr}`);
  }

  function exec(db, sql) {
    const res = psql(CONTAINER, db, ["-t", "-A", "-c", sql]);
    if (res.status !== 0) fail(`psql failed on ${db}:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }

  function run(sql) {
    return exec(DB, sql);
  }

  // Every `psql -c` is its own SESSION, so claims must travel WITH the statement that
  // needs them; anything else runs as the operator and the gate under test never fires.
  function asMember(email, sql) {
    const res = psql(CONTAINER, DB, [
      "-t", "-A", "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
    ]);
    if (res.status !== 0) fail(`psql (as ${email}) failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    // The set_config row comes first; the statement's own output is what follows.
    return res.stdout.trim().split("\n").slice(1).join("\n").trim();
  }

  try {
    startPostgres(CONTAINER, ROOT);
    createDbWithPrelude(CONTAINER, DB);
    createDbWithPrelude(CONTAINER, DB_PRE);
  } catch (error) {
    fail(error.message);
  }

  {
    const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
    if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);
  }

  // The pre-194 database: migrations 001–193 replayed in order. This is the ONLY way to
  // say "the totalKm > 0 answer did not change" as a measurement rather than a belief.
  {
    const files = readFileSync(join(ROOT, "tools", "test-migrations.mjs"), "utf8");
    void files;
    const list = execFileSync("ls", [join(ROOT, "supabase", "migrations")], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => Number(f.slice(0, 3)) <= 193);
    assert.equal(list.length, 193, "expected migrations 001–193 to replay the pre-194 schema");
    const args = list.flatMap((f) => ["-f", `/work/supabase/migrations/${f}`]);
    const applied = psql(CONTAINER, DB_PRE, args);
    if (applied.status !== 0) fail(`Pre-194 migration replay failed:\n${applied.stderr}`);
  }

  // Member ids are globally unique in ledger_members, so each fixture gets its own
  // prefix. Within a fixture they still ASCEND in text order (m1 < m2 < m3), which is
  // the largest-remainder tie-break the split chains use.
  const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
  const MX = (n) => `11000000-0000-0000-0000-00000000000${n}`;
  const MC = (n) => `12000000-0000-0000-0000-00000000000${n}`;
  const MN = (n) => `13000000-0000-0000-0000-00000000000${n}`;
  const P = (n) => `20000000-0000-0000-0000-00000000000${n}`;
  const F = (n) => `30000000-0000-0000-0000-00000000000${n}`;
  const X = (n) => `40000000-0000-0000-0000-00000000000${n}`;
  const T = (n) => `50000000-0000-0000-0000-00000000000${n}`;

  // ── Fixture 1: zero km, fuel only ──────────────────────────────────────────
  const zeroKm = `
insert into public.ledgers (id, name, slug) values ('zk', 'Zero km', 'zk');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${M(1)}', 'zk', 'Anna', 'anna@zk.dk', 'admin',  true),
  ('${M(2)}', 'zk', 'Bo',   'bo@zk.dk',   'member', true),
  ('${M(3)}', 'zk', 'Clara','clara@zk.dk','member', true);
insert into public.settlement_periods (id, ledger_id, status, label)
values ('${P(1)}', 'zk', 'open', 'Zero km');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount) values
  ('${F(1)}', 'zk', '${P(1)}', '${M(1)}', current_date, 300.00),
  ('${F(2)}', 'zk', '${P(1)}', '${M(2)}', current_date, 100.00);
`;
  seed(DB, zeroKm, "Seeding the zero-km fixture failed");
  seed(DB_PRE, zeroKm, "Seeding the zero-km fixture failed (pre-194)");

  const calcOn = (db, ledger, period) =>
    JSON.parse(exec(db, `select public.calculate_period_settlement('${ledger}', '${period}')::text;`));
  const calc = (ledger, period) => calcOn(DB, ledger, period);
  const person = (result, id) => result.people.find((p) => p.id === id);
  const netSum = (result) => result.people.reduce((sum, p) => sum + Number(p.net), 0);

  process.stdout.write("\nZero-km deferral (real Postgres, consolidated schema):\n");

  pin("the fixture DOES reproduce GV-471-F1 on the pre-194 schema", () => {
    // A fixture that does not reach the defect certifies nothing about the fix. On
    // migrations 001–193 the nets sum to +totalPaid, which is the bug's signature.
    const before = calcOn(DB_PRE, "zk", P(1));
    assert.equal(Number(before.totalKm), 0);
    assert.equal(Number(before.totalPaid), 400);
    assert.equal(
      Math.round(before.people.reduce((s, p) => s + Number(p.net), 0) * 100) / 100,
      400,
      "pre-194 the zero-km period must sum to +totalPaid — if it does not, this fixture is not the bug",
    );
  });

  pin("nets exclude the fuel and sum to EXACTLY zero", () => {
    const after = calc("zk", P(1));
    assert.equal(Number(after.totalKm), 0);
    assert.equal(Number(after.totalPaid), 400, "totalPaid stays the RAW figure");
    assert.equal(Number(after.fuelRate), 0);
    assert.equal(netSum(after), 0);
    for (const id of [M(1), M(2), M(3)]) assert.equal(Number(person(after, id).net), 0);
    assert.equal(Number(person(after, M(1)).fuelPaid), 300, "fuelPaid stays the RAW figure");
    assert.equal(Number(person(after, M(2)).fuelPaid), 100);
  });

  pin("deferredFuel reports the total and the per-member amounts", () => {
    const after = calc("zk", P(1));
    assert.ok(after.deferredFuel, "deferredFuel must be present at zero km with fuel");
    assert.equal(Number(after.deferredFuel.total), 400);
    assert.deepEqual(
      after.deferredFuel.people.map((p) => [p.id, Number(p.fuelPaid)]),
      [[M(1), 300], [M(2), 100]],
      "only members who actually paid, ordered by id, each with their raw amount",
    );
  });

  pin("a zero-km period with NO fuel reports no deferredFuel", () => {
    // The block is a statement that something was set aside. Nothing was.
    run(`update public.fuel_payments set deleted_at = now() where ledger_id = 'zk';`);
    const empty = calc("zk", P(1));
    assert.equal(Number(empty.totalPaid), 0);
    assert.equal(empty.deferredFuel, undefined);
    assert.equal(netSum(empty), 0);
    run(`update public.fuel_payments set deleted_at = null where ledger_id = 'zk';`);
  });

  // ── Fixture 2: a mixed period WITH kilometres — the unchanged path ─────────
  process.stdout.write("\nThe totalKm > 0 path is byte-for-byte pre-194:\n");

  const mixed = `
insert into public.ledgers (id, name, slug) values ('mix', 'Mixed', 'mix');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${MX(1)}', 'mix', 'Anna', 'anna@mix.dk', 'admin',  true),
  ('${MX(2)}', 'mix', 'Bo',   'bo@mix.dk',   'member', true),
  ('${MX(3)}', 'mix', 'Clara','clara@mix.dk','member', true);
insert into public.settlement_periods (id, ledger_id, status, label)
values ('${P(2)}', 'mix', 'open', 'Mixed');
insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km,
                          crossing_cost_dkk, crossing_paid_by_member_id)
values ('${T(1)}', 'mix', '${P(2)}', '${MX(1)}', current_date, 0, 100, 250.00, '${MX(1)}');
insert into public.trip_participants (trip_id, member_id) values
  ('${T(1)}', '${MX(1)}'), ('${T(1)}', '${MX(2)}');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount)
values ('${F(3)}', 'mix', '${P(2)}', '${MX(2)}', current_date, 500.00);
insert into public.workspace_expenses (id, ledger_id, period_id, category, amount_dkk, expense_date,
                                       split_rule, paid_by_member_id)
values ('${X(1)}', 'mix', '${P(2)}', 'other', 300.00, current_date, 'equal', '${MX(3)}');
`;
  seed(DB, mixed, "Seeding the mixed fixture failed");
  seed(DB_PRE, mixed, "Seeding the mixed fixture failed (pre-194)");

  pin("fuel + expense + crossing over 100 km: the JSON is IDENTICAL to pre-194", () => {
    const before = exec(DB_PRE, `select public.calculate_period_settlement('mix', '${P(2)}')::text;`);
    const after = exec(DB, `select public.calculate_period_settlement('mix', '${P(2)}')::text;`);
    assert.equal(after, before, "migration 194 must not move a single character of a period WITH kilometres");
  });

  pin("...and those numbers are the intended ones, not identically wrong", () => {
    const after = calc("mix", P(2));
    assert.equal(Number(after.totalKm), 100);
    assert.equal(Number(after.totalPaid), 500);
    assert.equal(Number(after.totalExpenses), 300);
    assert.equal(Number(after.totalCrossings), 250);
    assert.equal(Number(after.fuelRate), 5);
    assert.equal(after.deferredFuel, undefined, "a period with kilometres defers nothing");
    // 50 km each for the two people in the car; 300 kr expense equally over three;
    // 250 kr crossing equally over the two assignees; 500 kr fuel paid by Bo.
    assert.equal(Number(person(after, MX(1)).net), -225);
    assert.equal(Number(person(after, MX(2)).net), 25);
    assert.equal(Number(person(after, MX(3)).net), 200);
    assert.equal(netSum(after), 0);
  });

  // ── Fixture 3: closing a LOCKED zero-km period that also carries an expense ─
  process.stdout.write("\nClosing a zero-km period (locked, mixed with an expense):\n");

  const closeFixture = `
insert into public.ledgers (id, name, slug) values ('cls', 'Close', 'cls');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${MC(1)}', 'cls', 'Anna', 'anna@cls.dk', 'admin',  true),
  ('${MC(2)}', 'cls', 'Bo',   'bo@cls.dk',   'member', true);
insert into public.settlement_periods (id, ledger_id, status, label)
values ('${P(3)}', 'cls', 'open', 'Juni 2026');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount)
values ('${F(4)}', 'cls', '${P(3)}', '${MC(1)}', current_date, 400.00);
insert into public.workspace_expenses (id, ledger_id, period_id, category, amount_dkk, expense_date,
                                       split_rule, paid_by_member_id)
values ('${X(2)}', 'cls', '${P(3)}', 'other', 200.00, current_date, 'equal', '${MC(1)}');
`;
  seed(DB, closeFixture, "Seeding the close fixture failed");

  pin("only the fuel defers — the expense still splits in this period", () => {
    const before = calc("cls", P(3));
    assert.equal(Number(before.totalKm), 0);
    assert.equal(Number(before.totalPaid), 400);
    assert.equal(Number(before.totalExpenses), 200);
    assert.equal(Number(person(before, MC(1)).net), 100, "Anna paid the 200 kr expense and owes half of it");
    assert.equal(Number(person(before, MC(2)).net), -100);
    assert.equal(netSum(before), 0);
    assert.equal(Number(before.deferredFuel.total), 400);
  });

  // Lock the period the way production does: the creditor requests the outstanding
  // pair. This is the state migration 120's requested/paid rail guards, and the reason
  // the promotion cannot run before the flip to closed.
  asMember(
    "anna@cls.dk",
    `select public.upsert_settlement_request_status('cls', '${P(3)}', '${MC(2)}', '${MC(1)}', 100.00, 'DKK', 'requested');`,
  );

  pin("the period really is locked before the close (otherwise this proves nothing)", () => {
    assert.equal(run(`select public.settlement_entry_is_locked('cls', '${P(3)}');`), "t");
  });

  const preCloseFingerprint = run(`select public.calculate_period_entry_fingerprint('cls', '${P(3)}');`);
  assert.ok(preCloseFingerprint.includes(F(4)), "the pre-close fingerprint must contain the fuel row");

  const snapshot = (() => {
    const computed = calc("cls", P(3));
    return {
      label: "Juni 2026",
      totalKm: computed.totalKm,
      totalPaid: computed.totalPaid,
      entryFingerprint: preCloseFingerprint,
      people: computed.people.map((p) => ({ id: p.id, name: p.name, km: p.km, fuelPaid: p.fuelPaid, net: p.net })),
      settlements: [{ fromId: MC(2), toId: MC(1), amount: 100.0 }],
    };
  })();

  const closeResult = JSON.parse(
    asMember(
      "anna@cls.dk",
      `select public.close_settlement_period('cls', '${P(3)}', '${JSON.stringify(snapshot).replace(/'/g, "''")}'::jsonb)::text;`,
    ),
  );
  const newOpenPeriod = closeResult.open_period_id;

  pin("the close reports what it carried", () => {
    assert.equal(closeResult.closed_period_id, P(3));
    assert.equal(Number(closeResult.carried_forward_fuel_total), 400);
    assert.equal(Number(closeResult.carried_forward_fuel_count), 1);
  });

  pin("the fuel row now belongs to the NEW open period, the expense stayed behind", () => {
    assert.equal(run(`select period_id from public.fuel_payments where id = '${F(4)}';`), newOpenPeriod);
    assert.equal(run(`select period_id from public.workspace_expenses where id = '${X(2)}';`), P(3));
    assert.equal(
      run(`select count(*) from public.settlement_periods where ledger_id = 'cls' and status = 'queued';`),
      "0",
      "the queued carry-over period must be consumed and deleted by 140's promotion trigger",
    );
  });

  pin("the closed period's frozen snapshot covers only what remained", () => {
    const stored = run(`select snapshot_json ->> 'entryFingerprint' from public.settlement_periods where id = '${P(3)}';`);
    const recomputed = run(`select public.calculate_period_entry_fingerprint('cls', '${P(3)}');`);
    assert.equal(stored, recomputed, "closed-period immutability: stored must equal a fresh recompute");
    assert.ok(!stored.includes(F(4)), "the moved fuel must be gone from the archived fingerprint");
    assert.ok(stored.includes(X(2)), "the expense that settled here must still be in it");
    assert.notEqual(stored, preCloseFingerprint, "the pre-promotion fingerprint must not be what was archived");
    const deferred = JSON.parse(
      run(`select snapshot_json -> 'deferredFuel' from public.settlement_periods where id = '${P(3)}';`),
    );
    assert.equal(Number(deferred.total), 400);
    assert.equal(deferred.carriedToPeriodId, newOpenPeriod);
  });

  pin("the closed period now settles the expense alone; the successor holds the fuel", () => {
    const closed = calc("cls", P(3));
    assert.equal(Number(closed.totalPaid), 0);
    assert.equal(Number(person(closed, MC(1)).net), 100);
    assert.equal(Number(person(closed, MC(2)).net), -100);
    const next = calc("cls", newOpenPeriod);
    assert.equal(Number(next.totalPaid), 400);
    assert.equal(Number(next.deferredFuel.total), 400, "still zero km, so it defers again until someone drives");
    assert.equal(netSum(next), 0);
  });

  pin("one Danish fuel_carried_forward event, feed-visible by classification", () => {
    const rows = run(
      `select title || '|' || body || '|' || (metadata ->> 'fuel_total')
         from public.ledger_events
        where ledger_id = 'cls' and event_type = 'fuel_carried_forward';`,
    ).split("\n").filter(Boolean);
    assert.equal(rows.length, 1, "exactly one event per carry");
    const [title, body, total] = rows[0].split("|");
    assert.equal(title, "Brændstof på 400,00 kr flyttet til næste periode");
    assert.equal(body, "Der var ingen kørte kilometer i perioden, så brændstoffet deles i den nye periode.");
    assert.equal(Number(total), 400);
    assert.equal(
      run(`select metadata -> 'fuel_payment_ids' ->> 0 from public.ledger_events
             where ledger_id = 'cls' and event_type = 'fuel_carried_forward';`),
      F(4),
    );
  });

  pin("the fuel is split normally once the successor has kilometres", () => {
    // The point of carrying it forward: it is deferred, not written off.
    run(`insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km)
         values ('${T(2)}', 'cls', '${newOpenPeriod}', '${MC(2)}', current_date, 0, 200);
         insert into public.trip_participants (trip_id, member_id) values ('${T(2)}', '${MC(2)}');`);
    const driven = calc("cls", newOpenPeriod);
    assert.equal(Number(driven.totalKm), 200);
    assert.equal(driven.deferredFuel, undefined);
    assert.equal(Number(person(driven, MC(1)).net), 400, "Anna paid the fuel and drove nothing");
    assert.equal(Number(person(driven, MC(2)).net), -400, "Bo drove every kilometre it bought");
    assert.equal(netSum(driven), 0);
  });

  // ── Fixture 4: the chain, and the entry-less duplicate guard ───────────────
  process.stdout.write("\nChained carry, and the entry-less duplicate guard:\n");

  const chain = `
insert into public.ledgers (id, name, slug) values ('chn', 'Chain', 'chn');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${MN(1)}', 'chn', 'Anna', 'anna@chn.dk', 'admin',  true),
  ('${MN(2)}', 'chn', 'Bo',   'bo@chn.dk',   'member', true);
insert into public.settlement_periods (id, ledger_id, status, label)
values ('${P(4)}', 'chn', 'open', 'Periode A');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount)
values ('${F(5)}', 'chn', '${P(4)}', '${MN(1)}', current_date, 1234.50);
`;
  seed(DB, chain, "Seeding the chain fixture failed");

  function closeChain(periodId, label) {
    const computed = calc("chn", periodId);
    const fingerprint = run(`select public.calculate_period_entry_fingerprint('chn', '${periodId}');`);
    const snap = {
      label,
      totalKm: computed.totalKm,
      totalPaid: computed.totalPaid,
      entryFingerprint: fingerprint,
      people: computed.people.map((p) => ({ id: p.id, name: p.name, km: p.km, fuelPaid: p.fuelPaid, net: p.net })),
      settlements: [],
    };
    return JSON.parse(
      asMember(
        "anna@chn.dk",
        `select public.close_settlement_period('chn', '${periodId}', '${JSON.stringify(snap).replace(/'/g, "''")}'::jsonb)::text;`,
      ),
    );
  }

  const chainA = closeChain(P(4), "Periode A");
  const chainB = closeChain(chainA.open_period_id, "Periode B");

  pin("a second zero-km close carries the SAME fuel on again", () => {
    assert.equal(Number(chainB.carried_forward_fuel_total), 1234.5);
    assert.equal(run(`select period_id from public.fuel_payments where id = '${F(5)}';`), chainB.open_period_id);
  });

  pin("both closed periods archive a fingerprint that still recomputes", () => {
    for (const periodId of [P(4), chainA.open_period_id]) {
      const stored = run(`select snapshot_json ->> 'entryFingerprint' from public.settlement_periods where id = '${periodId}';`);
      const recomputed = run(`select public.calculate_period_entry_fingerprint('chn', '${periodId}');`);
      assert.equal(stored, recomputed, `closed period ${periodId} drifted from its archived fingerprint`);
      assert.ok(!stored.includes(F(5)), "the carried fuel must not remain in an archived fingerprint");
    }
  });

  pin("the Danish amount format survives a thousands separator", () => {
    assert.equal(
      run(`select title from public.ledger_events
             where ledger_id = 'chn' and event_type = 'fuel_carried_forward' limit 1;`),
      "Brændstof på 1.234,50 kr flyttet til næste periode",
    );
  });

  pin("a genuinely EMPTY period can still be closed after those two", () => {
    // Both closes above archived the entry-less fingerprint, because their only content
    // moved on. Without the `v_period_has_entries` condition on the duplicate guard, the
    // next empty month would match one of them and the workspace could never close
    // again — the regression this migration would otherwise have introduced.
    run(`update public.fuel_payments set deleted_at = now() where id = '${F(5)}';`);
    const empty = closeChain(chainB.open_period_id, "Periode C");
    assert.ok(empty.closed_period_id, "closing an empty period must not be refused as a duplicate snapshot");
    assert.equal(Number(empty.carried_forward_fuel_count), 0, "a tombstoned fuel row carries nothing forward");
    assert.equal(
      run(`select count(*) from public.settlement_periods where ledger_id = 'chn' and status = 'closed';`),
      "3",
    );
  });

  finished = true;
  removeContainer(CONTAINER);
  report();
}

function report() {
  process.stdout.write(`\n✅ zero-km fuel carry-forward contract: ${checked} pins held.\n`);
  if (warnings.length > 0) {
    process.stdout.write(`⚠️  ${warnings.length} half(s) could not be checked on this run.\n`);
  }
}

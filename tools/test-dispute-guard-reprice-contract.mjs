// Anti-drift contract for the settlement dispute guard's re-price branch (GV-485,
// migration 203).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// public.enforce_settlement_request_exact_amount sits between two rules that used to
// contradict each other, and the contradiction is easy to reintroduce because each side
// reads correct on its own:
//
//   • GV-259 (upsert_settlement_request_status) says the creditor or a ledger admin MAY
//     re-request a still-live request at a NEW amount when balances move.
//   • GV-293 (this trigger, migration 120, inheriting 117) said an UPDATE out of
//     'paid_pending' may change NONE of ledger, period, pair, amount or currency.
//
// A re-request is performed as an UPDATE, so every re-request of a paid_pending claim hit
// the second rule and raised. That is not a cosmetic clash: close_settlement_period's
// require-requests gate demands a live request AT THE CURRENT amount for every settlement
// in the snapshot, so a stale paid_pending row left the period unclosable by anyone —
// debtor, creditor and admin alike. Migration 203 makes the branch three-way.
//
// The reason this needs a test rather than a careful reading is that the fix is a
// FALL-THROUGH. Nothing in the branch validates the new amount; it simply stops returning
// early, and correctness depends entirely on the exact-amount validation ~50 lines below
// still being reached with the right state. A later edit that adds an early return above
// that validation, or reorders the period-open read, turns "re-request at the server's
// figure" into "re-request at any figure" with no syntax error and no failing regex — the
// guard would still exist, still be wired, and quietly accept invented money. Only
// executing it against a real Postgres can tell those two apart, which is why Part 2 runs
// the whole wedge end to end: a close that is refused, a re-request, and the same close
// succeeding.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-dispute-guard-reprice-contract.mjs            # warn on what it cannot check
//   node tools/test-dispute-guard-reprice-contract.mjs --strict   # umbrella: unchecked = failure
//
// Without Docker the SQL is not executed and Part 2 warns — the same contract
// test-fuel-stop-verdict-contract.mjs and test-crossing-split-contract.mjs use, so
// `npm run validate` stays dependency-free. Part 1 needs nothing and always runs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-dispute-reprice-${process.pid}`;
const DB = "dispute";

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
// Part 1 (needs nothing): the SHAPE of the branch, in BOTH copies
// ═══════════════════════════════════════════════════════════════════════════════
// check-schema-equivalence proves the migration and the consolidated schema replay to
// the same function; only this says the function they both replay is the one GV-485
// decided rather than identically wrong in both.
const MIGRATION = join(ROOT, "supabase", "migrations", "203_dispute_guard_reprice.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of this function (117 and
// 120 are both still in there), so a bare search proves nothing about which one WINS.
// Slice from the 203 mirror header: last definition wins on replay, so that tail is live.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 203:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 203 mirror block");

const sources = {
  "migration 203": readFileSync(MIGRATION, "utf8"),
  "supabase-schema.sql (203 tail)": consolidatedSql.slice(mirrorIdx),
};

process.stdout.write("\nSQL shape (migration 203 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sources)) {
  const fnStart = sql.indexOf("create or replace function public.enforce_settlement_request_exact_amount()");
  assert.notEqual(fnStart, -1, `${name}: the function is not declared`);
  const fn = sql.slice(fnStart);

  // The branch under test: from the paid_pending test to the reminder carve-out that
  // follows it. Reading the whole function would let an assertion pass on text that
  // lives somewhere else entirely.
  const branch = fn.slice(
    fn.indexOf("if old.status = 'paid_pending' then"),
    fn.indexOf("-- Reminder bookkeeping updates requested rows"),
  );
  assert.notEqual(branch.length, 0, `${name}: the paid_pending branch was not found`);

  pin(`${name}: the branch's raise lists the four IDENTITY columns and NOT amount or currency`, () => {
    // The whole fix, expressed as what is missing. If amount or currency reappears in
    // this condition the re-request is forbidden again and the close re-wedges.
    const condition = branch.slice(0, branch.indexOf("raise exception"));
    for (const column of ["ledger_id", "period_id", "from_member_id", "to_member_id"]) {
      assert.match(condition, new RegExp(`new\\.${column} is distinct from old\\.${column}`), `${column} must still raise`);
    }
    assert.doesNotMatch(
      condition,
      /new\.amount is distinct from old\.amount/,
      "a changed amount must NOT raise here — it must fall through to the exact-amount validation (GV-485)",
    );
    assert.doesNotMatch(
      condition,
      /new\.currency is distinct from old\.currency/,
      "a changed currency must NOT raise here — it falls through with the amount (GV-485)",
    );
  });

  pin(`${name}: the identity refusal keeps migration 117's sentence word for word`, () => {
    // Re-declaring is not licence to retranslate, and a client may be matching the
    // string. It names amount and currency even though the branch no longer refuses on
    // them alone — that is deliberate and documented in the migration header.
    assert.match(
      branch,
      /raise exception 'Disputing a payment claim must preserve its pair, amount, and currency'\n\s+using errcode = '23514';/,
    );
  });

  pin(`${name}: an UNCHANGED amount and currency still return immediately`, () => {
    // The path every genuine dispute takes — transition_settlement_request_status
    // re-sends the STORED amount — plus every reminder and confirm writer. If this fast
    // path is lost they all start paying for a calculate_period_settlement call and an
    // advisory lock they never needed.
    assert.match(
      branch,
      /if new\.amount is not distinct from old\.amount\n\s+and new\.currency is not distinct from old\.currency then\n\s+return new;\n\s+end if;/,
    );
  });

  pin(`${name}: the changed-amount case FALLS THROUGH — it does not validate inline`, () => {
    // The branch must end by setting the flag, not by returning and not by carrying its
    // own copy of the pairing arithmetic. A second implementation of the validation is
    // the failure this pin exists to catch: it would drift from the real one.
    assert.match(branch, /dispute_amount_change := true;\n\s+end if;/);
    assert.doesNotMatch(branch, /return new;\s*\n\s*end if;\s*\n\s*$/, "the branch must not return unconditionally");
    assert.doesNotMatch(
      branch,
      /calculate_period_settlement/,
      "the branch must fall through to the ONE exact-amount validation, never duplicate it",
    );
  });

  pin(`${name}: a re-price in a CLOSED period still raises (GV-293 immutability intact)`, () => {
    // The fall-through's one blind spot: the closed-period early return hands the row
    // back unvalidated, because a closed period's obligations are historical. Without
    // this the fix would silently accept a rewritten settled figure.
    assert.match(fn, /^ {2}dispute_amount_change boolean := false;$/m, "the flag must be declared");
    const closedReturn = fn.slice(fn.indexOf("if period_is_open is not true then"));
    assert.match(
      closedReturn.slice(0, closedReturn.indexOf("end if;")),
      /if dispute_amount_change then\n\s+raise exception 'Disputing a payment claim must preserve its pair, amount, and currency'/,
    );
  });

  pin(`${name}: the exact-amount validation below the branch is untouched`, () => {
    // What the fall-through falls through TO. Both refusals must survive verbatim, or
    // "admitted" quietly becomes "unchecked".
    assert.match(fn, /perform pg_advisory_xact_lock\(hashtext\(new\.ledger_id \|\| ':settlement:' \|\| new\.period_id::text\)\);/);
    assert.match(fn, /raise exception 'This settlement pair is no longer part of the current server calculation\./);
    assert.match(fn, /raise exception 'Settlement request amount does not match the current server calculation\./);
    assert.match(fn, /new\.amount := expected_pair_amount;/);
  });

  pin(`${name}: the trigger is re-wired BEFORE INSERT OR UPDATE and the ACLs restated`, () => {
    assert.match(sql, /drop trigger if exists enforce_settlement_request_exact_amount_trigger on public\.settlement_requests;/);
    assert.match(
      sql,
      /create trigger enforce_settlement_request_exact_amount_trigger\nbefore insert or update on public\.settlement_requests\nfor each row execute function public\.enforce_settlement_request_exact_amount\(\);/,
    );
    for (const role of ["public", "anon", "authenticated"]) {
      assert.match(sql, new RegExp(`revoke all on function public\\.enforce_settlement_request_exact_amount\\(\\) from ${role};`));
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2 (Docker): the branch EXECUTED against a real Postgres
// ═══════════════════════════════════════════════════════════════════════════════
let dockerAvailable = true;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  dockerAvailable = false;
}

if (!dockerAvailable) {
  warn(
    "Dispute re-price not executed",
    "Docker is unavailable, so the dispute guard was NOT run. The re-request, the invented amount, the " +
      "identity drift, the closed-period re-price and the end-to-end wedged close were all skipped.",
  );
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ dispute guard re-price contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function run(sql) {
    const res = psql(CONTAINER, DB, ["-t", "-A", "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }

  try {
    startPostgres(CONTAINER, ROOT);
    createDbWithPrelude(CONTAINER, DB);
  } catch (error) {
    fail(error.message);
  }

  const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
  if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

  // Every psql -c is its own SESSION, so the JWT claims have to travel WITH the
  // statement that needs them; anything else runs as the operator and the RPC's actor
  // resolution never fires. (The crossing contract learned this the same way.)
  const asMember = (email, sql) =>
    psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
    ]);

  // ── The fixture, and why it moves the balance the way it does ────────────────
  // A live request LOCKS the period against entry writes (settlement_entry_is_locked
  // covers requested / paid_pending / paid), so the amount cannot be moved by adding a
  // trip or a tankning after the claim — migration 140 sends late entries to a queued
  // period instead. What still moves underneath a locked period is MEMBERSHIP:
  // deactivating a member removes them from the trip's assignees, and the same fuel bill
  // is then carried by fewer people. That is the production shape of this bug, and it is
  // the only one the entry lock permits, so the fixture uses it rather than inventing an
  // entry write the schema would refuse.
  //
  //   300 km trip, three participants, one 300,00 kr tankning paid by Anna
  //     all three active → 100 km each → Bo owes Anna 100,00
  //     Clara deactivated → 150 km each → Bo owes Anna 150,00
  // Member ids are per-ledger (ledger_members.id is a global primary key), and they
  // ascend inside each workspace so any tie-break stays a statement rather than a
  // coincidence of whatever uuids got generated.
  const MEMBER = (slot, n) => `1000000${slot}-0000-0000-0000-00000000000${n}`;
  const M = (n) => MEMBER(0, n); // ledger 'dsp'
  const W = (n) => MEMBER(1, n); // ledger 'wdg'
  const P = (n) => `20000000-0000-0000-0000-00000000000${n}`;
  const T = (n) => `30000000-0000-0000-0000-00000000000${n}`;

  function seedLedger(id, name, periodId, tripId, member) {
    const sql = `
insert into public.ledgers (id, name, slug) values ('${id}', '${name}', '${id}');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${member(1)}', '${id}', 'Anna',  'anna@${id}.dk',  'admin',  true),
  ('${member(2)}', '${id}', 'Bo',    'bo@${id}.dk',    'member', true),
  ('${member(3)}', '${id}', 'Clara', 'clara@${id}.dk', 'member', true);

insert into public.settlement_periods (id, ledger_id, status, label)
values ('${periodId}', '${id}', 'open', 'Periode');

insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km)
values ('${tripId}', '${id}', '${periodId}', '${member(1)}', current_date, 0, 300);

insert into public.trip_participants (trip_id, member_id)
select '${tripId}', unnest(array['${member(1)}'::uuid, '${member(2)}'::uuid, '${member(3)}'::uuid]);

insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount)
values (gen_random_uuid(), '${id}', '${periodId}', '${member(1)}', current_date, 300.00);
`;
    if (psql(CONTAINER, DB, ["-c", sql]).status !== 0) fail(`Seeding ${id} failed`);
  }

  const calc = (ledger, period) =>
    JSON.parse(run(`select public.calculate_period_settlement('${ledger}', '${period}')::text;`));
  const netOf = (result, id) => Number(result.people.find((p) => p.id === id).net);

  // ═══════════════════════════════════════════════════════════════════════════
  // Ledger 'dsp' — the trigger, exercised by DIRECT UPDATEs
  // ═══════════════════════════════════════════════════════════════════════════
  // Direct table writes, not RPC calls, because the trigger is what is under test: an
  // RPC could pass or fail for reasons of its own (GV-259's actor rule) and hide what the
  // guard actually did. The RPC path gets its own ledger below.
  seedLedger("dsp", "Dispute guard", P(1), T(1), M);

  process.stdout.write("\nThe dispute branch, executed (real Postgres, consolidated schema):\n");

  pin("fixture: Bo owes Anna 100,00 with all three on the trip", () => {
    const s = calc("dsp", P(1));
    assert.equal(netOf(s, M(1)), 200);
    assert.equal(netOf(s, M(2)), -100);
    assert.equal(netOf(s, M(3)), -100);
  });

  // Anna requests, Bo claims he has paid. This is the state the whole ticket is about.
  if (
    asMember(
      "anna@dsp.dk",
      `select public.upsert_settlement_request_status('dsp', '${P(1)}', '${M(2)}', '${M(1)}', 100.00, 'DKK', 'requested');`,
    ).status !== 0
  ) {
    fail("Anna could not request the settlement");
  }
  if (
    asMember(
      "bo@dsp.dk",
      `select public.upsert_settlement_request_status('dsp', '${P(1)}', '${M(2)}', '${M(1)}', 100.00, 'DKK', 'paid_pending');`,
    ).status !== 0
  ) {
    fail("Bo could not claim the payment");
  }

  const REQUEST = () => run(`select id from public.settlement_requests where ledger_id = 'dsp';`);
  const requestId = REQUEST();
  const requestRow = () =>
    run(
      `select status, amount::text, to_member_id::text from public.settlement_requests where id = '${requestId}';`,
    ).split("|");

  const updateRequest = (setClause) =>
    psql(CONTAINER, DB, ["-c", `update public.settlement_requests set ${setClause} where id = '${requestId}';`]);

  pin("(a) a dispute at the UNCHANGED amount still passes, exactly as before", () => {
    // The genuine dispute. transition_settlement_request_status re-sends the stored
    // amount, so this is the only shape a real dispute has — and migration 203 must not
    // have moved it a millimetre.
    assert.equal(requestRow()[0], "paid_pending", "precondition: the claim is pending");
    const res = updateRequest(`status = 'requested'`);
    assert.equal(res.status, 0, `an unchanged-amount dispute must pass:\n${res.stderr}`);
    assert.deepEqual(requestRow().slice(0, 2), ["requested", "100.00"]);
    // Put the claim back so the cases below start from paid_pending again.
    assert.equal(updateRequest(`status = 'paid_pending'`).status, 0);
  });

  // Clara leaves the workspace. The tankning does not move, but Bo's share of it does.
  if (psql(CONTAINER, DB, ["-c", `update public.ledger_members set is_active = false where id = '${M(3)}';`]).status !== 0) {
    fail("Could not deactivate Clara");
  }

  pin("the balance moved underneath the claim: Bo now owes 150,00, the row still says 100,00", () => {
    const s = calc("dsp", P(1));
    assert.equal(netOf(s, M(2)), -150);
    assert.equal(s.people.find((p) => p.id === M(3)), undefined, "an inactive member who paid nothing leaves the split");
    assert.deepEqual(requestRow().slice(0, 2), ["paid_pending", "100.00"]);
  });

  pin("(c) an INVENTED amount is still rejected — by the server's arithmetic", () => {
    // The fix admits a re-price; it does not admit a number. 77,77 is neither the stored
    // amount nor the computed one, so the exact-amount validation must refuse it.
    const res = updateRequest(`status = 'requested', amount = 77.77`);
    assert.notEqual(res.status, 0, "an invented amount must not be accepted");
    assert.match(
      res.stderr,
      /Settlement request amount does not match the current server calculation/,
      "and it must be refused by the exact-amount validation, not by the branch",
    );
    assert.deepEqual(requestRow().slice(0, 2), ["paid_pending", "100.00"], "the row must be untouched");
  });

  pin("(d) IDENTITY drift is still rejected", () => {
    // A dispute may re-price a claim; it may never re-address it. Note which guard
    // answers: migration 121's assert_settlement_request_period_identity fires first
    // because BEFORE triggers run in name order and 'assert_' sorts before 'enforce_'.
    // The branch's own refusal stays as the belt behind that brace and is pinned
    // statically in Part 1 — asserting it here would assert the trigger ORDER instead.
    const res = updateRequest(`status = 'requested', amount = 150.00, to_member_id = '${M(3)}'`);
    assert.notEqual(res.status, 0, "re-addressing a claim must be rejected");
    assert.match(res.stderr, /Settlement request ledger, period, and parties are immutable/);
    assert.deepEqual(requestRow(), ["paid_pending", "100.00", M(1)], "the row must be untouched");
  });

  pin("(b) THE FIX: a re-price to the CURRENT computed amount now passes", () => {
    const res = updateRequest(`status = 'requested', amount = 150.00`);
    assert.equal(res.status, 0, `the re-request must be admitted:\n${res.stderr}`);
    assert.deepEqual(requestRow().slice(0, 2), ["requested", "150.00"]);
  });

  pin("(e) the same re-price in a CLOSED period is still refused", () => {
    // The one case the exact-amount validation can never see, because it is only reached
    // while the period is open. A settled historical obligation stays settled.
    assert.equal(updateRequest(`status = 'paid_pending'`).status, 0, "precondition: claim it again at 150,00");
    if (
      psql(CONTAINER, DB, [
        "-c",
        `update public.settlement_periods set status = 'closed', closed_at = now() where id = '${P(1)}';`,
      ]).status !== 0
    ) {
      fail("Could not close the period directly");
    }
    const res = updateRequest(`status = 'requested', amount = 175.00`);
    assert.notEqual(res.status, 0, "a closed period must not accept a re-priced claim");
    assert.match(res.stderr, /Disputing a payment claim must preserve its pair, amount, and currency/);
    // ...while a status-only dispute in a closed period keeps working.
    assert.equal(updateRequest(`status = 'requested'`).status, 0, "a closed-period dispute at the stored amount still passes");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Ledger 'wdg' — the wedge itself, end to end, through the real RPCs
  // ═══════════════════════════════════════════════════════════════════════════
  // Part 1 and the cases above prove the branch. This proves the TICKET: that the
  // contradiction closed a period's only exit, and that migration 203 opens it.
  seedLedger("wdg", "Wedged close", P(2), T(2), W);

  process.stdout.write("\nThe wedged close, end to end:\n");

  for (const [email, status] of [
    ["anna@wdg.dk", "requested"],
    ["bo@wdg.dk", "paid_pending"],
  ]) {
    if (
      asMember(
        email,
        `select public.upsert_settlement_request_status('wdg', '${P(2)}', '${W(2)}', '${W(1)}', 100.00, 'DKK', '${status}');`,
      ).status !== 0
    ) {
      fail(`Could not drive the request to ${status}`);
    }
  }
  if (psql(CONTAINER, DB, ["-c", `update public.ledger_members set is_active = false where id = '${W(3)}';`]).status !== 0) {
    fail("Could not deactivate Clara in wdg");
  }

  // The snapshot a current client would send: built from the server's own numbers, so
  // the close's fingerprint and per-person guards all pass and the ONLY thing that can
  // refuse it is the require-requests gate.
  function snapshotFor(ledger, period) {
    const computed = calc(ledger, period);
    return {
      label: "Periode",
      totalKm: computed.totalKm,
      totalPaid: computed.totalPaid,
      entryFingerprint: run(`select public.calculate_period_entry_fingerprint('${ledger}', '${period}');`),
      people: computed.people.map((p) => ({ id: p.id, name: p.name, km: p.km, fuelPaid: p.fuelPaid, net: p.net })),
      settlements: [{ fromId: W(2), toId: W(1), amount: 150.0 }],
    };
  }

  const closeAsAnna = () =>
    asMember(
      "anna@wdg.dk",
      `select public.close_settlement_period('wdg', '${P(2)}', '${JSON.stringify(snapshotFor("wdg", P(2))).replace(/'/g, "''")}'::jsonb)::text;`,
    );

  pin("the period is WEDGED: the close is refused while the claim sits at the stale amount", () => {
    const res = closeAsAnna();
    assert.notEqual(res.status, 0, "a stale paid_pending claim must block the close");
    assert.match(res.stderr, /All settlements must be requested at their current amounts before this period can be closed/);
  });

  pin("the remedy the guard used to forbid: the CREDITOR re-requests at the current amount", () => {
    // Before migration 203 this RPC raised 'Disputing a payment claim must preserve its
    // pair, amount, and currency' — GV-259 permitted the write and GV-293's trigger
    // refused it, and there was no third actor to try.
    const res = asMember(
      "anna@wdg.dk",
      `select public.upsert_settlement_request_status('wdg', '${P(2)}', '${W(2)}', '${W(1)}', 150.00, 'DKK', 'requested');`,
    );
    assert.equal(res.status, 0, `the creditor's re-request must be admitted:\n${res.stderr}`);
    assert.equal(
      run(`select amount::text from public.settlement_requests where ledger_id = 'wdg';`),
      "150.00",
    );
  });

  pin("and the period closes", () => {
    const res = closeAsAnna();
    assert.equal(res.status, 0, `the close must now succeed:\n${res.stderr}`);
    assert.equal(run(`select status from public.settlement_periods where id = '${P(2)}';`), "closed");
  });

  finished = true;
  removeContainer(CONTAINER);
}

process.stdout.write(`\n✅ dispute guard re-price contract: ${checked} checks passed.\n`);
if (warnings.length > 0) {
  process.stdout.write(`⚠ ${warnings.length} check(s) could not run — see the warnings above.\n`);
}

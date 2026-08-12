// Anti-drift contract for "a re-request is not a dispute" (GV-487, migration 204).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// paid_pending -> requested is TWO actions wearing one status transition:
//
//   • a DISPUTE — the creditor rejects a payment claim (mobile's "Afvis", with a
//     required reason), and
//   • a RE-REQUEST — the creditor or a ledger admin asks again, at the same amount or
//     a new one, because the balances moved underneath the claim (GV-259, unblocked
//     for the changed-amount half by migration 203, given a button by GVM-589).
//
// Both used to be announced as payment_disputed / "Betaling afvist", so asking again
// told the other member their payment had been rejected.
//
// What makes this worth executing rather than reading is that the two actions are
// INDISTINGUISHABLE FROM THE ROW — same pair, same status edge, same actor (the
// creditor drives both), and the same amount whenever the re-request is at an
// unchanged figure. The only thing separating them is which command was invoked, so
// the fix is carried by a transaction-local flag that public
// .transition_settlement_request_status sets around its delegate call. That is a
// three-function handshake, and every way it can break is silent: clear the flag one
// line too early and every genuine dispute starts announcing itself as a request;
// forget to clear it and the next re-request in the same transaction inherits a
// dispute; re-declare any one of the three functions off an older copy and the two
// halves disagree with no syntax error and no failing regex. Only running the real
// RPCs against a real Postgres and reading the rows they wrote can tell those apart.
//
// It also pins the thing the fix must NOT do: write zero events, or two. The event
// insert IS the cross-client live sync (migration 087), so a branch that stops
// writing one is a silent loss of realtime for the other member.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-rerequest-event-contract.mjs            # warn on what it cannot check
//   node tools/test-rerequest-event-contract.mjs --strict   # umbrella: unchecked = failure
//
// Without Docker the SQL is not executed and Part 2 warns, so `npm run validate` stays
// dependency-free. Part 1 needs nothing and always runs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";
import { FEED_VISIBLE_EVENT_TYPES } from "./ledger-event-visibility.mjs";
import { EVENT_TYPE_EXCLUDE } from "./load-rehearsal/lib/hotpaths.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-rerequest-event-${process.pid}`;
const DB = "rerequest";

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
// Part 1 (needs nothing): the SHAPE of the handshake, in BOTH copies
// ═══════════════════════════════════════════════════════════════════════════════
// check-schema-equivalence proves the migration and the consolidated schema replay to
// the same functions; only this says the functions they both replay are the ones
// GV-487 decided rather than identically wrong in both.
const MIGRATION = join(ROOT, "supabase", "migrations", "204_rerequest_is_not_a_dispute.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of these three functions,
// so a bare search proves nothing about which one WINS. Slice from the 204 mirror
// header: last definition wins on replay, so that tail is what is live.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 204:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 204 mirror block");

const sources = {
  "migration 204": readFileSync(MIGRATION, "utf8"),
  "supabase-schema.sql (204 tail)": consolidatedSql.slice(mirrorIdx),
};

const FLAG = "govehlo.settlement_lifecycle_command";

process.stdout.write("\nSQL shape (migration 204 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sources)) {
  const upsertStart = sql.indexOf("create or replace function public.upsert_settlement_request_status(");
  assert.notEqual(upsertStart, -1, `${name}: upsert_settlement_request_status is not declared`);
  const upsert = sql.slice(upsertStart, sql.indexOf("create or replace function public.transition_settlement_request_status("));
  assert.notEqual(upsert.length, 0, `${name}: could not isolate upsert_settlement_request_status`);

  pin(`${name}: the feed writer reads the intent flag, missing_ok, defaulting to NOT a dispute`, () => {
    // current_setting's second argument is what keeps an ordinary direct call — where
    // nothing ever set the flag — from raising 42704 instead of returning a request.
    assert.match(
      upsert,
      new RegExp(`dispute_command boolean := coalesce\\(current_setting\\('${FLAG.replace(".", "\\.")}', true\\), ''\\) = '1';`),
      "dispute_command must read the flag with missing_ok = true and coalesce to a false answer",
    );
  });

  pin(`${name}: payment_disputed and "Betaling afvist" are gated on the flag`, () => {
    // The whole fix. Both the type and the title have to move together, or the feed
    // shows one action's type under the other action's words.
    assert.match(
      upsert,
      /when normalized_status = 'requested' and prev_status_value = 'paid_pending' and dispute_command then 'payment_disputed'/,
      "the payment_disputed branch must require the dispute command",
    );
    assert.match(
      upsert,
      /when normalized_status = 'requested' and prev_status_value = 'paid_pending' and dispute_command then 'Betaling afvist'/,
      "the \"Betaling afvist\" title must require the dispute command",
    );
  });

  pin(`${name}: a re-request falls through to the EXISTING payment_requested branch`, () => {
    // No new event type: the branch below the gated one is what a re-request now
    // reaches, and it is the same one a re-request from 'requested' or 'open' has
    // always reached.
    assert.match(upsert, /when normalized_status = 'requested' then 'payment_requested'/);
    assert.match(upsert, /when normalized_status = 'requested' then 'Betaling anmodet'/);
    assert.doesNotMatch(sql, /payment_rerequested/, "GV-487 deliberately introduces no new event type");
  });

  pin(`${name}: exactly ONE ledger_events insert, unconditional (migration 087)`, () => {
    // The event insert IS the live sync. A branch that stops writing one, or writes a
    // second, breaks the other member's client rather than just the wording.
    const inserts = upsert.match(/insert into public\.ledger_events \(/g) ?? [];
    assert.equal(inserts.length, 1, "the feed writer must insert exactly one ledger_events row");
  });

  const transitionStart = sql.indexOf("create or replace function public.transition_settlement_request_status(");
  assert.notEqual(transitionStart, -1, `${name}: transition_settlement_request_status is not declared`);
  const transition = sql.slice(transitionStart, sql.indexOf("create or replace function public.record_settlement_request_event()"));
  assert.notEqual(transition.length, 0, `${name}: could not isolate transition_settlement_request_status`);

  pin(`${name}: the by-id command sets the flag immediately before, and clears it immediately after`, () => {
    // Order is the contract, not decoration: set after the delegate call and no dispute
    // is ever labelled; leave it set and the next write in the same transaction
    // inherits an intent that was not its own.
    const set = transition.indexOf(`perform set_config('${FLAG}', '1', true);`);
    const call = transition.indexOf("transition_result := public.upsert_settlement_request_status(");
    const clear = transition.indexOf(`perform set_config('${FLAG}', '', true);`);
    assert.notEqual(set, -1, "the flag must be set");
    assert.notEqual(clear, -1, "the flag must be cleared");
    assert.ok(set < call, "the flag must be set BEFORE the delegate call");
    assert.ok(clear > call, "the flag must be cleared AFTER the delegate call");
    assert.match(
      transition,
      new RegExp(`set_config\\('${FLAG.replace(".", "\\.")}', '1', true\\)`),
      "the flag must be transaction-LOCAL (is_local = true), the govehlo.pii_scrub convention",
    );
  });

  const historyStart = sql.indexOf("create or replace function public.record_settlement_request_event()");
  assert.notEqual(historyStart, -1, `${name}: record_settlement_request_event is not declared`);
  const history = sql.slice(historyStart);

  pin(`${name}: the per-request history uses the SAME discriminator`, () => {
    // mobile renders settlement_request_events as the "Betalingsforløb", where
    // 'disputed' reads "Betaling afvist" — so the two accounts of one transition have
    // to agree, or the feed says one thing and the payment's own timeline the other.
    assert.match(
      history,
      new RegExp(`dispute_command boolean := coalesce\\(current_setting\\('${FLAG.replace(".", "\\.")}', true\\), ''\\) = '1';`),
    );
    assert.match(
      history,
      /if old\.status = 'paid_pending' and new\.status = 'requested' and dispute_command then/,
      "the 'disputed' history row must require the dispute command",
    );
  });
}

pin("both types stay classified, and neither list has to move (GV-413)", () => {
  // The reuse decision, stated as a test: payment_requested is already the accepted
  // feed-visible answer, so a re-request lands on a classified type and no
  // EVENT_TYPE_EXCLUDE / mobile-gateway append is owed by this ticket.
  assert.ok(FEED_VISIBLE_EVENT_TYPES.includes("payment_requested"), "payment_requested must stay feed-visible");
  assert.ok(FEED_VISIBLE_EVENT_TYPES.includes("payment_disputed"), "payment_disputed must stay feed-visible");
  assert.ok(!EVENT_TYPE_EXCLUDE.includes("payment_requested"), "payment_requested must not be filtered out of the feed");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2 (Docker): the handshake EXECUTED against a real Postgres
// ═══════════════════════════════════════════════════════════════════════════════
let dockerAvailable = true;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  dockerAvailable = false;
}

if (!dockerAvailable) {
  warn(
    "Re-request event semantics not executed",
    "Docker is unavailable, so the event writers were NOT run. The dispute, the same-amount re-request, the " +
      "changed-amount re-request, the one-row-per-call rule and the flag-leak case were all skipped.",
  );
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ re-request event contract: ${message}\n`);
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

  // Every psql -c is its own SESSION, so the JWT claims travel WITH the statement that
  // needs them; anything else runs as the operator and the RPC's actor resolution never
  // fires. A multi-statement -c is also one TRANSACTION, which is what the leak case
  // below depends on.
  const asMember = (email, sql) =>
    psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
    ]);

  // Same fixture shape as the migration-203 contract, and for the same reason: a live
  // request LOCKS the period against entry writes, so the only thing that can still move
  // the balance underneath a claim is MEMBERSHIP.
  //
  //   300 km trip, three participants, one 300,00 kr tankning paid by Anna
  //     all three active → 100 km each → Bo owes Anna 100,00
  //     Clara deactivated → 150 km each → Bo owes Anna 150,00
  const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
  const PERIOD = "20000000-0000-0000-0000-000000000001";
  const TRIP = "30000000-0000-0000-0000-000000000001";
  const LEDGER = "rrq";

  const seed = `
insert into public.ledgers (id, name, slug) values ('${LEDGER}', 'Re-request events', '${LEDGER}');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${M(1)}', '${LEDGER}', 'Anna',  'anna@${LEDGER}.dk',  'admin',  true),
  ('${M(2)}', '${LEDGER}', 'Bo',    'bo@${LEDGER}.dk',    'member', true),
  ('${M(3)}', '${LEDGER}', 'Clara', 'clara@${LEDGER}.dk', 'member', true);

insert into public.settlement_periods (id, ledger_id, status, label)
values ('${PERIOD}', '${LEDGER}', 'open', 'Periode');

insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km)
values ('${TRIP}', '${LEDGER}', '${PERIOD}', '${M(1)}', current_date, 0, 300);

insert into public.trip_participants (trip_id, member_id)
select '${TRIP}', unnest(array['${M(1)}'::uuid, '${M(2)}'::uuid, '${M(3)}'::uuid]);

insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount)
values (gen_random_uuid(), '${LEDGER}', '${PERIOD}', '${M(1)}', current_date, 300.00);
`;
  if (psql(CONTAINER, DB, ["-c", seed]).status !== 0) fail("Seeding failed");

  // Anna is the CREDITOR (Bo owes her) and a ledger admin; Bo is the debtor. Anna
  // therefore drives both actions under test, which is the entire difficulty.
  const upsert = (email, status, amount) =>
    asMember(
      email,
      `select public.upsert_settlement_request_status('${LEDGER}', '${PERIOD}', '${M(2)}', '${M(1)}', ${amount}, 'DKK', '${status}');`,
    );

  const transition = (email, status, note) =>
    asMember(
      email,
      `select public.transition_settlement_request_status('${requestId()}', '${status}'${note ? `, '${note}'` : ""});`,
    );

  const requestId = () => run(`select id from public.settlement_requests where ledger_id = '${LEDGER}';`);

  // Read the event stream as an ordered list of "type|title" so a case can assert what
  // was written AND that nothing else was.
  const rows = (sql) => run(sql).split("\n").filter((line) => line.length > 0);
  const feedEvents = () =>
    rows(
      `select event_type || '|' || title from public.ledger_events where ledger_id = '${LEDGER}' order by created_at, id;`,
    );
  const historyEvents = () =>
    rows(
      `select event_type || '|' || coalesce(from_status, '-') from public.settlement_request_events` +
        ` where ledger_id = '${LEDGER}' order by occurred_at, id;`,
    );

  let feedSeen = 0;
  let historySeen = 0;
  function newFeed() {
    const all = feedEvents();
    const fresh = all.slice(feedSeen);
    feedSeen = all.length;
    return fresh;
  }
  function newHistory() {
    const all = historyEvents();
    const fresh = all.slice(historySeen);
    historySeen = all.length;
    return fresh;
  }

  process.stdout.write("\nEvent semantics, executed (real Postgres, consolidated schema):\n");

  if (upsert("anna@rrq.dk", "requested", "100.00").status !== 0) fail("Anna could not request the settlement");
  if (upsert("bo@rrq.dk", "paid_pending", "100.00").status !== 0) fail("Bo could not claim the payment");

  pin("the setup writes what it always wrote: payment_requested, then payment_claimed", () => {
    assert.deepEqual(newFeed(), ["payment_requested|Betaling anmodet", "payment_claimed|Afventer bekræftelse"]);
    // Sorted: the INSERT branch writes 'calculated' at created_at and 'requested' at
    // requested_at, which are the same instant inside one transaction, so their relative
    // order is a coin flip on the id tie-break rather than anything worth pinning.
    assert.deepEqual(newHistory().sort(), ["calculated|-", "marked_paid|requested", "requested|open"]);
  });

  pin("(a) A GENUINE DISPUTE is unchanged: payment_disputed / \"Betaling afvist\"", () => {
    // Through the by-id lifecycle command, which is what mobile's "Afvis" calls and the
    // only path that carries a rejection reason. Nothing about this may move.
    const res = transition("anna@rrq.dk", "requested", "Jeg har ikke modtaget pengene");
    assert.equal(res.status, 0, `the creditor's dispute must succeed:\n${res.stderr}`);
    assert.deepEqual(newFeed(), ["payment_disputed|Betaling afvist"], "exactly one row, and it is the dispute");
    assert.deepEqual(newHistory(), ["disputed|paid_pending"], "and the timeline still records a dispute");
  });

  pin("the dispute still carries its reason into metadata 'note' (GV-279)", () => {
    assert.equal(
      run(
        `select metadata->>'note' from public.ledger_events where ledger_id = '${LEDGER}'` +
          ` and event_type = 'payment_disputed' order by created_at desc limit 1;`,
      ),
      "Jeg har ikke modtaget pengene",
    );
  });

  if (upsert("bo@rrq.dk", "paid_pending", "100.00").status !== 0) fail("Bo could not re-claim the payment");
  newFeed();
  newHistory();

  pin("(b) THE FIX: a SAME-AMOUNT re-request is a request, not a rejection", () => {
    // The pair-keyed RPC, called by the creditor at the unchanged figure — byte for byte
    // the state a dispute leaves behind, which is why nothing but the command can tell
    // them apart. Before migration 204 this pushed "Betaling afvist" at Bo.
    const res = upsert("anna@rrq.dk", "requested", "100.00");
    assert.equal(res.status, 0, `the creditor's re-request must succeed:\n${res.stderr}`);
    const fresh = newFeed();
    assert.deepEqual(fresh, ["payment_requested|Betaling anmodet"]);
    assert.ok(!fresh.some((row) => row.includes("payment_disputed")), "and it must NOT be a dispute");
    assert.deepEqual(newHistory(), ["requested|paid_pending"], "the timeline records a request FROM the claim");
  });

  // Clara leaves the workspace: the tankning does not move, but Bo's share of it does.
  if (psql(CONTAINER, DB, ["-c", `update public.ledger_members set is_active = false where id = '${M(3)}';`]).status !== 0) {
    fail("Could not deactivate Clara");
  }
  if (upsert("bo@rrq.dk", "paid_pending", "100.00").status !== 0) fail("Bo could not claim the stale amount");
  newFeed();
  newHistory();

  pin("(c) a CHANGED-AMOUNT re-request is a request too — the case migration 203 made legal", () => {
    const res = upsert("anna@rrq.dk", "requested", "150.00");
    assert.equal(res.status, 0, `the re-priced re-request must succeed:\n${res.stderr}`);
    assert.deepEqual(newFeed(), ["payment_requested|Betaling anmodet"]);
    assert.deepEqual(newHistory(), ["requested|paid_pending"]);
    assert.equal(run(`select amount::text from public.settlement_requests where ledger_id = '${LEDGER}';`), "150.00");
  });

  pin("(d) the intent flag does not LEAK: dispute then re-request, in ONE transaction", () => {
    // A multi-statement psql -c is a single transaction, and the flag is transaction-
    // local — so this is the shape that catches a clear that never happens. Assert the
    // multiset rather than the order: only the first call can be a dispute and only the
    // last can be a request, so a leak shows up as two payment_disputed and no
    // payment_requested.
    const res = asMember(
      "anna@rrq.dk",
      `select public.upsert_settlement_request_status('${LEDGER}', '${PERIOD}', '${M(2)}', '${M(1)}', 150.00, 'DKK', 'paid_pending');
select public.transition_settlement_request_status('${requestId()}', 'requested', 'Ikke modtaget');
select public.upsert_settlement_request_status('${LEDGER}', '${PERIOD}', '${M(2)}', '${M(1)}', 150.00, 'DKK', 'paid_pending');
select public.upsert_settlement_request_status('${LEDGER}', '${PERIOD}', '${M(2)}', '${M(1)}', 150.00, 'DKK', 'requested');`,
    );
    assert.equal(res.status, 0, `the mixed transaction must succeed:\n${res.stderr}`);
    const fresh = newFeed().map((row) => row.split("|")[0]).sort();
    assert.deepEqual(
      fresh,
      ["payment_claimed", "payment_claimed", "payment_disputed", "payment_requested"],
      "one dispute and one request — a leaked flag would make the last call a dispute too",
    );
  });

  pin("every call wrote EXACTLY ONE ledger_events row — never zero (migration 087)", () => {
    // Eleven RPC calls have run against this ledger: request, claim, dispute, claim,
    // re-request, claim, re-price, and the four inside the leak transaction.
    assert.equal(Number(run(`select count(*) from public.ledger_events where ledger_id = '${LEDGER}';`)), 11);
  });

  finished = true;
  removeContainer(CONTAINER);
}

process.stdout.write(`\n✅ re-request event contract: ${checked} checks passed.\n`);
if (warnings.length > 0) {
  process.stdout.write(`⚠ ${warnings.length} check(s) could not run — see the warnings above.\n`);
}

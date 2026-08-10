// Anti-drift contract for the handover odometer plausibility guard and the audited
// admin recompute (GV-475, migration 195).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 193 made ledgers.max_handover_odometer MONOTONE on purpose — a deleted or
// edited-down handover must not retract a counter reading that was made — and migration
// 195 keeps that rule while adding the two things it was missing: a ceiling that stops a
// mistyped digit becoming the reading in the first place, and exactly one gated way to
// take a wrong one back. Four properties hold that together, and every one of them is
// the kind a later tidy-up breaks without looking wrong in a diff:
//
//   1. THE ANCHOR IS BOTH LEDGER ODOMETER COLUMNS.
//      greatest(max_handover_odometer, tank_baseline_odometer), and greatest() ignoring
//      nulls is load-bearing twice over: a workspace with NEITHER gets no relative
//      ceiling at all (a new group's first reading of 350000 on a used car must be
//      accepted), and a workspace whose only anchor is a 300.000 km tank baseline must
//      not be capped at 50.000. Narrow the anchor to the 193 mirror alone and both cases
//      turn into a member who cannot enter the true kilometres of their own car.
//   2. THE RELATIVE CEILING IS THE LAST CHECK BEFORE THE WRITE. It reads the workspace
//      row, so it cannot move up with the payload validations without letting a
//      non-member bisect a workspace's mileage; and it sits after the GV-421 precondition
//      so a stale caller hears about the conflict rather than about a payload that is
//      going to be discarded. Both orderings are asserted, statically and by execution.
//   3. THE MONOTONE RULE STILL STANDS EVERYWHERE ELSE. An edit-down through the RPC must
//      still leave the mirror where it was; only recompute_handover_mirror may lower it.
//      A "simplification" that makes the edit lower the mirror would pass every other
//      test in this repo and would silently delete 193's whole reason for existing.
//   4. THE CORRECTION IS ADMIN-ONLY AND AUDITED. Dropping monotonicity is the authority a
//      plain member does not have, and a correction nobody can see is the state GV-475
//      exists to end — so the event row is written even when the numbers do not move.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (static): the SHAPE of migration 195 and of its supabase-schema.sql mirror —
//   the anchor expression, both guard placements, the single errcode and sentence, the
//   unchanged signature, the recompute's gate and its non-monotone assignment — plus the
//   GV-413 classification of the new event type. check-schema-equivalence proves the two
//   files replay identically; this proves the thing they both replay is the thing GV-475
//   decided.
// Part 2 (Docker): the BEHAVIOUR on a real Postgres — both ceilings and their exact
//   boundaries, the first-reading carve-out, the tank-baseline anchor, the ordering
//   against GV42O, the admin gate from three sides, the recompute itself, and the
//   documented way out of the low-anchor lockout, end to end.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-handover-odometer-guard-contract.mjs            # warn on Docker
//   node tools/test-handover-odometer-guard-contract.mjs --strict   # umbrella / CI
//
// Without Docker the behavioural half is skipped and warns, exactly as
// test-zero-km-fuel-carryforward-contract.mjs and test-booking-caps-contract.mjs do, so
// `npm run validate` stays dependency-free.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FEED_VISIBLE_EVENT_TYPES } from "./ledger-event-visibility.mjs";
import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-odometer-guard-${process.pid}`;
const DB = "odoguard";

const ERRCODE = "GV475";
const SENTENCE = "Kilometerstanden ser for høj ud — tjek om du har tastet et ciffer for meget.";
const EVENT_TYPE = "handover_odometer_corrected";
const EVENT_TITLE = "Kilometertæller-aflæsning korrigeret";
const EVENT_BODY = "Den højeste kilometerstand er genberegnet ud fra de overdragelser, der findes nu.";

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
const MIGRATION = join(ROOT, "supabase", "migrations", "195_handover_odometer_guard.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of upsert_booking_handover
// (eight of them), so a bare search proves nothing about which one WINS. Last definition
// wins on replay, so read only the tail from 195's own mirror header.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 195:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 195 mirror block");

const sqlSources = {
  "migration 195": readFileSync(MIGRATION, "utf8"),
  "supabase-schema.sql (195 tail)": consolidatedSql.slice(mirrorIdx),
};

process.stdout.write("\nSQL shape (migration 195 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sqlSources)) {
  const handoverAt = sql.indexOf("create or replace function public.upsert_booking_handover(");
  const recomputeAt = sql.indexOf("create or replace function public.recompute_handover_mirror(");
  assert.notEqual(handoverAt, -1, `${name}: upsert_booking_handover not found`);
  assert.notEqual(recomputeAt, -1, `${name}: recompute_handover_mirror not found`);
  const handover = sql.slice(handoverAt, recomputeAt);
  // BOUNDED at the last of recompute_handover_mirror's own ACL lines rather than run to
  // the end of the file. This slice used to be `sql.slice(recomputeAt)`, which on the
  // consolidated schema meant "migration 195 and everything appended after it" — so the
  // first later migration to contain, say, `if … event_title is not null then` anywhere
  // in an unrelated function failed this suite with a message about the handover
  // recompute. Migration 202 was that migration. The assertions below are all about ONE
  // function; the slice now says so.
  const recomputeAclEnd = sql.indexOf(
    "grant execute on function public.recompute_handover_mirror(text, text, text) to authenticated;",
    recomputeAt,
  );
  assert.notEqual(recomputeAclEnd, -1, `${name}: recompute_handover_mirror's authenticated grant not found`);
  const recompute = sql.slice(recomputeAt, recomputeAclEnd + 200);

  pin(`${name}: the signature is migration 191's, unchanged, and nothing is DROPPED`, () => {
    // Two candidate signatures with defaulted parameters is PGRST203 — PostgREST resolves
    // neither and every handover call in the app fails. The guard adds no parameter, so
    // create-or-replace is the whole change and a DROP would open that window for nothing.
    assert.match(
      handover,
      /parking_lng_value numeric default null,\s*location_seen_at timestamptz default null,\s*event_title text default null,\s*event_body text default null,\s*expected_updated_at timestamptz default null\s*\)/,
    );
    assert.doesNotMatch(sql, /^drop function.*upsert_booking_handover/im);
  });

  pin(`${name}: the ABSOLUTE cap sits with the payload validations, before every gate`, () => {
    const cap = handover.indexOf("end_odometer_value > 2000000");
    const negative = handover.indexOf("end_odometer_value < 0");
    const memberGate = handover.indexOf("if not public.is_ledger_member(target_ledger_id) then");
    assert.notEqual(cap, -1, "the absolute cap is missing");
    assert.ok(negative !== -1 && negative < cap, "it extends the negative check and belongs beside it");
    assert.ok(
      cap < memberGate,
      "a payload-only judgement needs no lookup and leaks nothing (162's precedent), so it must not " +
        "drift down among the gates",
    );
  });

  pin(`${name}: the anchor is BOTH ledger odometer columns, null-tolerant`, () => {
    assert.match(
      handover,
      /select greatest\(l\.max_handover_odometer, l\.tank_baseline_odometer\)\s*\n\s*into v_odometer_anchor\s*\n\s*from public\.ledgers l\s*\n\s*where l\.id = target_ledger_id;/,
      "greatest() over BOTH anchors, and Postgres' greatest() ignoring nulls is the whole " +
        "first-reading carve-out: narrow this to max_handover_odometer and a workspace whose only " +
        "anchor is a 300.000 km tank baseline is capped at 50.000 km",
    );
    assert.match(
      handover,
      /if v_odometer_anchor is not null and end_odometer_value > v_odometer_anchor \+ 50000 then/,
      "the relative ceiling applies ONLY where an anchor exists — a null anchor means no history, " +
        "and a new workspace's first reading is bounded by the absolute cap alone",
    );
  });

  pin(`${name}: the RELATIVE ceiling is the LAST check before the write`, () => {
    const memberGate = handover.indexOf("if not public.is_ledger_member(target_ledger_id) then");
    const precondition = handover.indexOf("using errcode = 'GV42O';");
    const ceiling = handover.indexOf("if v_odometer_anchor is not null");
    const write = handover.indexOf("v_created := v_existing.id is null;");
    assert.ok(
      memberGate !== -1 && memberGate < ceiling,
      "it reads the workspace row, so a non-member must be turned away first — otherwise the " +
        "rejection boundary itself reports the workspace's mileage to anyone who bisects it",
    );
    assert.ok(
      precondition !== -1 && precondition < ceiling,
      "a caller whose view is stale must hear about the conflict, not about a payload that is " +
        "going to be discarded anyway",
    );
    assert.ok(ceiling < write, "and it must still be BEFORE the insert/update it is guarding");
  });

  pin(`${name}: both guards raise the ONE Danish sentence under the ONE distinct errcode`, () => {
    const raises = [...handover.matchAll(/raise exception '([^']*)'\s*\n?\s*using errcode = 'GV475';/g)];
    assert.equal(raises.length, 2, "exactly two GV475 raises: the absolute cap and the relative ceiling");
    for (const match of raises) {
      assert.equal(
        match[1],
        SENTENCE,
        "one sentence, because the member's remedy is identical in both cases — count the digits",
      );
    }
  });

  pin(`${name}: recompute_handover_mirror is admin-gated, definer, search_path pinned`, () => {
    assert.match(
      recompute,
      /if not public\.is_ledger_admin\(target_ledger_id\) then\s*\n\s*raise exception '[^']*' using errcode = '42501';/,
      "dropping 193's monotonicity is the authority a plain member does not have; is_ledger_admin is " +
        "false for a non-member too, so this is the workspace boundary as well",
    );
    assert.match(recompute, /security definer\s*\nset search_path = public/);
    for (const acl of [
      "revoke all on function public.recompute_handover_mirror(text, text, text) from public;",
      "revoke all on function public.recompute_handover_mirror(text, text, text) from anon;",
      "grant execute on function public.recompute_handover_mirror(text, text, text) to authenticated;",
    ]) {
      assert.ok(recompute.includes(acl), `148's ACL convention: ${acl}`);
    }
  });

  pin(`${name}: the recompute ASSIGNS all three mirror columns — no greatest() survives`, () => {
    const update = recompute.slice(
      recompute.indexOf("update public.ledgers l"),
      recompute.indexOf("insert into public.ledger_events"),
    );
    assert.match(
      update,
      /set max_handover_odometer = v_max_odometer,\s*\n\s*latest_handover_fraction = v_fraction,\s*\n\s*latest_handover_observed_at = v_observed_at\s*\n\s*where l\.id = target_ledger_id;/,
      "this is the ONE place the monotone rule is dropped; a greatest() here would make the whole " +
        "RPC a no-op against the only defect it exists to repair",
    );
    assert.doesNotMatch(update, /greatest\(/);
    assert.match(
      recompute,
      /select l\.max_handover_odometer, l\.latest_handover_fraction\s*\n\s*into v_previous_max, v_previous_fraction\s*\n\s*from public\.ledgers l\s*\n\s*where l\.id = target_ledger_id\s*\n\s*for update;/,
      "the row 193's trigger writes is taken FOR UPDATE before the recompute reads the table — a " +
        "concurrent handover either lands first or waits and re-applies its own whole-ledger recompute",
    );
  });

  pin(`${name}: ONE event row, server-authored Danish, written unconditionally`, () => {
    const insert = recompute.slice(recompute.indexOf("insert into public.ledger_events"));
    assert.match(insert, new RegExp(`'${EVENT_TYPE}',`));
    assert.match(
      insert,
      new RegExp(`coalesce\\(nullif\\(btrim\\(event_title\\), ''\\), '${EVENT_TITLE}'\\)`),
      "the 051/052 event pair is accepted, but silence is not an option the caller has: a correction " +
        "nobody can see is the state GV-475 is about",
    );
    assert.doesNotMatch(
      insert,
      /if .*event_title.* is not null then/,
      "no conditional may wrap the insert — that is how a correction becomes invisible again",
    );
    assert.match(insert, /'previous_max_handover_odometer', v_previous_max,\s*\n\s*'max_handover_odometer', v_max_odometer/);
    assert.doesNotMatch(insert, /parking|key_location|note_to_next/, "no free text may reach the widest audience a workspace has");
  });
}

pin(`${EVENT_TYPE} is classified FEED-VISIBLE (GV-413)`, () => {
  assert.ok(
    FEED_VISIBLE_EVENT_TYPES.includes(EVENT_TYPE),
    "the workspace's kilometre reading is a shared fact other members' reminders and prefills follow; " +
      "a silent downward correction is how a group learns about a typo by noticing a number moved",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: behaviour, on a real Postgres
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
    "Handover odometer guard behaviour not checked",
    "Docker is unavailable, so upsert_booking_handover and recompute_handover_mirror were NOT executed. " +
      "Both ceilings and their boundaries, the first-reading carve-out, the admin gate and the recompute " +
      "itself were skipped on this run.",
  );
  report();
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ handover odometer guard contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function raw(sql, args = []) {
    const res = psql(CONTAINER, DB, [...args, "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }
  const scalar = (sql) => raw(sql, ["-t", "-A"]);

  /** Run `sql` as `email`; returns the SQLSTATE it raised, or 'OK'. */
  function sqlstateOf(email, sql) {
    const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVSTATE:OK';
exception when others then
  raise notice 'GVSTATE:%', sqlstate;
end $$;`;
    const res = psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${wrapped}`,
    ]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
    const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:(\S+)/);
    if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
    return match[1];
  }

  /** Run `sql` as `email`; returns the raised MESSAGE, or 'OK'. */
  function messageOf(email, sql) {
    const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVMSG:OK';
exception when others then
  raise notice 'GVMSG:%', sqlerrm;
end $$;`;
    const res = psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${wrapped}`,
    ]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
    const match = `${res.stdout}\n${res.stderr}`.match(/GVMSG:(.*)/);
    if (!match) fail(`Could not read a message back from:\n${wrapped}`);
    return match[1].trim();
  }

  /** Read a scalar back from a statement executed AS a signed-in member. */
  function scalarAs(email, sql) {
    const res = psql(CONTAINER, DB, [
      "-t", "-A", "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
    ]);
    if (res.status !== 0) fail(`psql (as ${email}) failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim().split("\n").slice(1).join("\n").trim();
  }

  try {
    startPostgres(CONTAINER, ROOT);
    createDbWithPrelude(CONTAINER, DB);
  } catch (error) {
    fail(error.message);
  }

  {
    const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
    if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────────
  // Four workspaces, one per state the ceiling has to tell apart:
  //   'odo'      an ordinary group with a history — the poisoning and the correction
  //   'odo-new'  never observed, no anchor at all — the first-reading carve-out
  //   'odo-tank' a tank baseline of 300.000 km and a tiny handover reading — the anchor
  //   'odo-low'  a first reading typed far too LOW — the lockout and its way out
  // Bookings are inserted directly (this suite is not about the booking caps) on their
  // own PAST days, anchored to 09:00Z rather than now()+N so an evening run cannot cross
  // Copenhagen midnight (PR #224's lesson).
  const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
  const ANNA = M(1);
  const BO = M(2);
  const ERIK = M(3);
  const B = (n) => `30000000-0000-0000-0000-00000000000${n}`;
  // One booking-id prefix per workspace: the ids are globally unique, so a shared
  // template across four fixtures would collide on the primary key.
  const PREFIX = { "odo-new": "32", "odo-tank": "33", "odo-low": "34" };

  const seed = `
insert into public.ledgers (id, name, slug) values
  ('odo', 'Odometer', 'odo'),
  ('odo-new', 'Brand new', 'odo-new'),
  ('odo-tank', 'Tank baseline', 'odo-tank'),
  ('odo-low', 'Typed too low', 'odo-low');

-- Anna is an admin in three of the four workspaces, so one signed-in identity can drive
-- most of the fixture; Bo is a plain member of 'odo' (the recompute's negative case) and
-- Erik is a real, active admin of 'odo-new' and nothing at all in 'odo' (the
-- cross-workspace negative case). One ledger_members row per membership, as always.
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${ANNA}', 'odo', 'Anna', 'anna@odo.dk', 'admin',  true),
  ('${BO}',   'odo', 'Bo',   'bo@odo.dk',   'member', true),
  ('${ERIK}', 'odo-new', 'Erik', 'erik@odo.dk', 'admin', true),
  ('${M(4)}', 'odo-tank', 'Anna', 'anna@odo.dk', 'admin', true),
  ('${M(5)}', 'odo-low',  'Anna', 'anna@odo.dk', 'admin', true);

insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
select
  ('30000000-0000-0000-0000-00000000000' || n)::uuid,
  'odo', '${BO}',
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '9 hour',
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '13 hour',
  '${BO}'
from generate_series(1, 6) as n;

insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
select
  (w.prefix || '000000-0000-0000-0000-00000000000' || n)::uuid,
  w.id, m.id,
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '9 hour',
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '13 hour',
  m.id
from generate_series(1, 3) as n
cross join (values ('odo-new', '${PREFIX["odo-new"]}'), ('odo-tank', '${PREFIX["odo-tank"]}'),
                   ('odo-low', '${PREFIX["odo-low"]}')) as w(id, prefix)
join public.ledger_members m on m.ledger_id = w.id;
`;
  {
    const res = psql(CONTAINER, DB, ["-c", seed]);
    if (res.status !== 0) fail(`Seeding ledgers/members/bookings failed:\n${res.stderr}`);
  }

  const bookingIn = (ledger, n) => `${PREFIX[ledger]}000000-0000-0000-0000-00000000000${n}`;

  function save({ ledger = "odo", booking, odometer = null, fuel = null, token = "null", actor = "bo@odo.dk" }) {
    return sqlstateOf(
      actor,
      `perform public.upsert_booking_handover(
         '${ledger}', '${booking}'::uuid,
         ${odometer === null ? "null" : odometer},
         ${fuel === null ? "null" : fuel},
         null, null, null, null, null, false, null, null, null, null, null, ${token});`,
    );
  }
  function saveMessage({ ledger = "odo", booking, odometer, actor = "bo@odo.dk" }) {
    return messageOf(
      actor,
      `perform public.upsert_booking_handover(
         '${ledger}', '${booking}'::uuid, ${odometer}, null,
         null, null, null, null, null, false, null, null, null, null, null, null);`,
    );
  }

  const mirror = (ledger) =>
    scalar(`select coalesce(max_handover_odometer::text, 'NULL') from public.ledgers where id = '${ledger}';`);
  const mirrorFraction = (ledger) =>
    scalar(`select coalesce(latest_handover_fraction::text, 'NULL') from public.ledgers where id = '${ledger}';`);
  const mirrorObservedAt = (ledger) =>
    scalar(`select coalesce(latest_handover_observed_at::text, 'NULL') from public.ledgers where id = '${ledger}';`);

  const recompute = (email, ledger) =>
    sqlstateOf(email, `perform public.recompute_handover_mirror('${ledger}');`);
  const recomputeResult = (email, ledger, args = "") =>
    JSON.parse(scalarAs(email, `select public.recompute_handover_mirror('${ledger}'${args})::text;`));

  // ── 1. The first reading, and the absolute cap ──────────────────────────────
  process.stdout.write("\nA workspace with no odometer history (real Postgres):\n");

  const newBooking = (n) => bookingIn("odo-new", n);

  pin("a never-observed workspace has NO anchor, so a first reading of 350000 is accepted", () => {
    assert.equal(mirror("odo-new"), "NULL", "the fixture must actually start with no history");
    assert.equal(save({ ledger: "odo-new", booking: newBooking(1), odometer: 350000, actor: "erik@odo.dk" }), "OK");
    assert.equal(mirror("odo-new"), "350000", "a used car bought at 350.000 km is an ordinary first handover");
  });

  pin("the ABSOLUTE cap refuses more than 2.000.000 km whatever the history says", () => {
    // Against 350000 the relative ceiling would already refuse this; the point is that a
    // workspace with NO history is refused too, which only the absolute cap can do.
    raw(`update public.ledgers set max_handover_odometer = null where id = 'odo-new';`);
    assert.equal(save({ ledger: "odo-new", booking: newBooking(2), odometer: 2000001, actor: "erik@odo.dk" }), ERRCODE);
    assert.equal(save({ ledger: "odo-new", booking: newBooking(2), odometer: 2000000, actor: "erik@odo.dk" }), "OK");
    raw(`delete from public.booking_handovers where ledger_id = 'odo-new';
         update public.ledgers set max_handover_odometer = 350000 where id = 'odo-new';`);
  });

  pin("the refusal is the Danish sentence a member can act on", () => {
    assert.equal(
      saveMessage({ ledger: "odo-new", booking: newBooking(2), odometer: 9000000, actor: "erik@odo.dk" }),
      SENTENCE,
    );
  });

  // ── 2. The relative ceiling and its exact boundary ──────────────────────────
  process.stdout.write("\nThe relative ceiling, at the boundary:\n");

  pin("a first reading sets the anchor; anchor + 49.999 is accepted", () => {
    assert.equal(save({ booking: B(1), odometer: 118166, fuel: 0.5 }), "OK");
    assert.equal(mirror("odo"), "118166");
    assert.equal(save({ booking: B(2), odometer: 118166 + 49999 }), "OK");
    // Put the anchor back where the rest of this section expects it.
    raw(`delete from public.booking_handovers where booking_id = '${B(2)}';
         update public.ledgers set max_handover_odometer = 118166 where id = 'odo';`);
  });

  pin("anchor + 50.001 is refused — and THE fat-finger case is exactly this", () => {
    assert.equal(save({ booking: B(2), odometer: 118166 + 50001 }), ERRCODE);
    // The GV-475 report itself: one extra digit on 118166.
    assert.equal(save({ booking: B(2), odometer: 1181660 }), ERRCODE);
    assert.equal(mirror("odo"), "118166", "a refused write must leave the mirror alone");
    assert.equal(
      scalar(`select count(*) from public.booking_handovers where booking_id = '${B(2)}';`),
      "0",
      "and must write no handover row at all",
    );
  });

  pin("a reading typed too LOW is never blocked — that is the way out of a bad anchor", () => {
    assert.equal(save({ booking: B(2), odometer: 5 }), "OK");
    raw(`delete from public.booking_handovers where booking_id = '${B(2)}';`);
  });

  pin("a stale GV-421 token is answered BEFORE the ceiling, not after", () => {
    // Ordering, executed rather than read: the caller is editing a version that no longer
    // exists, so the conflict is the honest answer — pointing at the kilometres would send
    // them to fix a payload that is going to be discarded.
    assert.equal(save({ booking: B(3), odometer: 118200 }), "OK");
    const stale = scalar(`select updated_at from public.booking_handovers where booking_id = '${B(3)}';`);
    assert.equal(save({ booking: B(3), odometer: 118300, actor: "anna@odo.dk" }), "OK");
    assert.equal(
      save({ booking: B(3), odometer: 999999, token: `timestamptz '${stale}'` }),
      "GV42O",
      "GV42O, not GV475 — and 999999 is chosen so the relative ceiling WOULD have caught it",
    );
  });

  pin("a non-member is refused before the ceiling can report anything about the workspace", () => {
    // 42501 rather than GV475: the rejection boundary must not double as a mileage oracle.
    // 999999 is over this workspace's ceiling and under the absolute cap, so a GV475 here
    // would mean the ceiling had read the ledgers row for somebody outside the workspace.
    assert.equal(save({ booking: B(4), odometer: 999999, actor: "erik@odo.dk" }), "42501");
    // The ABSOLUTE cap does outrank the gates, and that is deliberate: it judges only the
    // payload, so answering it early tells a stranger nothing they did not already send.
    assert.equal(save({ booking: B(4), odometer: 9999999, actor: "erik@odo.dk" }), ERRCODE);
  });

  // ── 3. The tank baseline is part of the anchor ──────────────────────────────
  process.stdout.write("\nThe tank baseline (migration 092) as an odometer anchor:\n");

  const tankBooking = (n) => bookingIn("odo-tank", n);

  pin("a tiny handover reading does NOT cap a workspace whose baseline is 300.000 km", () => {
    raw(`update public.ledgers set tank_baseline_odometer = 300000, tank_baseline_fraction = 0.5
          where id = 'odo-tank';`);
    assert.equal(save({ ledger: "odo-tank", booking: tankBooking(1), odometer: 1000, actor: "anna@odo.dk" }), "OK");
    assert.equal(mirror("odo-tank"), "1000", "the mirror anchor alone would now cap this workspace at 51.000 km");
    assert.equal(save({ ledger: "odo-tank", booking: tankBooking(2), odometer: 340000, actor: "anna@odo.dk" }), "OK");
  });

  pin("...and the ceiling still applies, measured from the baseline", () => {
    raw(`delete from public.booking_handovers where ledger_id = 'odo-tank' and end_odometer = 340000;
         update public.ledgers set max_handover_odometer = 1000 where id = 'odo-tank';`);
    assert.equal(save({ ledger: "odo-tank", booking: tankBooking(3), odometer: 350001, actor: "anna@odo.dk" }), ERRCODE);
  });

  // ── 4. The correction: 193's monotone rule, and the one way past it ─────────
  process.stdout.write("\nThe poisoned workspace, and the audited recompute:\n");

  pin("a pre-195 poisoning survives an edit-down: 193's monotone rule is untouched", () => {
    // How the damage got in before this migration — the guard did not exist, so the write
    // path is bypassed here on purpose. The mirror TRIGGER is what runs, exactly as it did.
    raw(`insert into public.booking_handovers (ledger_id, booking_id, author_member_id, end_odometer, fuel_fraction)
         values ('odo', '${B(5)}', '${BO}', 1181660, 0.9);`);
    assert.equal(mirror("odo"), "1181660", "the fixture must actually be poisoned");

    // The correction the member makes through the existing sheet. It is a DOWNWARD edit,
    // so the new ceiling never blocks it — and the mirror still does not follow.
    assert.equal(save({ booking: B(5), odometer: 118500, fuel: 0.6 }), "OK");
    assert.equal(
      mirror("odo"),
      "1181660",
      "193 is deliberate: an edited-down handover does not retract a reading that was made. Only the " +
        "recompute may lower it, and that is the whole reason the recompute exists",
    );
  });

  pin("a plain member, and an admin of ANOTHER workspace, are both refused 42501", () => {
    assert.equal(recompute("bo@odo.dk", "odo"), "42501", "dropping monotonicity is not a member's call");
    assert.equal(recompute("erik@odo.dk", "odo"), "42501", "and is_ledger_admin is the workspace boundary too");
    assert.equal(mirror("odo"), "1181660", "a refused recompute changes nothing");
  });

  let result;
  pin("the admin recompute lowers the max to the surviving truth and re-derives the pair", () => {
    result = recomputeResult("anna@odo.dk", "odo");
    assert.equal(Number(result.previous_max_handover_odometer), 1181660);
    assert.equal(Number(result.max_handover_odometer), 118500, "the greatest SURVIVING reading, not the greatest ever");
    assert.equal(result.lowered, true);
    assert.equal(mirror("odo"), "118500");
    assert.equal(
      Number(mirrorFraction("odo")),
      0.6,
      "the fraction pair is re-derived alongside it, so the two halves of the mirror cannot disagree",
    );
    assert.notEqual(mirrorObservedAt("odo"), "NULL");
  });

  pin("exactly one feed event, server-authored Danish, carrying the old and new maximum", () => {
    const rows = scalar(
      `select title || '|' || body || '|' || (metadata ->> 'previous_max_handover_odometer')
              || '|' || (metadata ->> 'max_handover_odometer')
         from public.ledger_events where ledger_id = 'odo' and event_type = '${EVENT_TYPE}';`,
    ).split("\n").filter(Boolean);
    assert.equal(rows.length, 1, "one recompute, one event");
    const [title, body, previous, next] = rows[0].split("|");
    assert.equal(title, EVENT_TITLE);
    assert.equal(body, EVENT_BODY);
    assert.equal(Number(previous), 1181660);
    assert.equal(Number(next), 118500);
    assert.equal(
      scalar(`select actor_member_id from public.ledger_events
                where ledger_id = 'odo' and event_type = '${EVENT_TYPE}';`),
      ANNA,
      "the correction is attributable — that is what makes it an audited exception rather than a hole",
    );
  });

  pin("a recompute that changes nothing STILL writes its event", () => {
    const again = recomputeResult("anna@odo.dk", "odo");
    assert.equal(again.lowered, false);
    assert.equal(Number(again.max_handover_odometer), 118500);
    assert.equal(
      scalar(`select count(*) from public.ledger_events where ledger_id = 'odo' and event_type = '${EVENT_TYPE}';`),
      "2",
      "'an admin recomputed and nothing changed' is itself the answer somebody was looking for",
    );
  });

  pin("a caller may supply its own wording through the 051/052 event pair", () => {
    recomputeResult("anna@odo.dk", "odo", ", 'Anna rettede kilometerstanden', 'Tallet var tastet forkert'");
    assert.equal(
      scalar(`select title from public.ledger_events where ledger_id = 'odo' and event_type = '${EVENT_TYPE}'
                order by created_at desc, id desc limit 1;`),
      "Anna rettede kilometerstanden",
    );
  });

  // ── 5. The low-anchor lockout, end to end ───────────────────────────────────
  process.stdout.write("\nThe one lockout the ceiling creates, and its documented way out:\n");

  const lowBooking = (n) => bookingIn("odo-low", n);

  pin("a first reading typed far too LOW is accepted and becomes the anchor", () => {
    assert.equal(save({ ledger: "odo-low", booking: lowBooking(1), odometer: 118, actor: "anna@odo.dk" }), "OK");
    assert.equal(mirror("odo-low"), "118");
  });

  pin("...which then puts the TRUE reading out of reach — this is the lockout", () => {
    assert.equal(save({ ledger: "odo-low", booking: lowBooking(2), odometer: 118166, actor: "anna@odo.dk" }), ERRCODE);
  });

  pin("delete the bad row, recompute, and the mirror goes back to NULL — never to 0", () => {
    raw(`delete from public.booking_handovers where ledger_id = 'odo-low';`);
    assert.equal(mirror("odo-low"), "118", "the monotone mirror does not retract on delete either");
    const cleared = recomputeResult("anna@odo.dk", "odo-low");
    assert.equal(cleared.max_handover_odometer, null, "no surviving reading means 193's never-observed NULL");
    assert.equal(mirror("odo-low"), "NULL");
    assert.equal(mirrorFraction("odo-low"), "NULL");
  });

  pin("...and now the true reading is accepted, with no raw SQL anywhere in the flow", () => {
    assert.equal(save({ ledger: "odo-low", booking: lowBooking(2), odometer: 118166, actor: "anna@odo.dk" }), "OK");
    assert.equal(mirror("odo-low"), "118166");
  });

  finished = true;
  removeContainer(CONTAINER);
  report();
}

function report() {
  process.stdout.write(`\n✅ handover odometer guard contract: ${checked} pins held.\n`);
  if (warnings.length > 0) {
    process.stdout.write(`⚠️  ${warnings.length} half(s) could not be checked on this run.\n`);
  }
}

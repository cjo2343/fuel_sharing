// Anti-drift contract for the double booking-completion guard (GV-479, migration 197).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 123 made "one booking, one live trip" a database invariant with a partial
// unique index, and migration 197 gives that invariant a Danish voice — plus the thing
// the index never covered, because two phones completing the same booking do not usually
// reach it: upsert_booking_trip_with_participants locks the booking row, finds the trip
// already linked and REUSES it, quietly adopting the second caller's kilometres over the
// first caller's. Four properties hold the fix together, and every one of them is the
// kind a later tidy-up breaks without looking wrong in a diff:
//
//   1. THE SAME-KEY RETRY MUST STAY SILENT. The offline outbox replays a completion with
//      the SAME idempotency key, and the simulator's duplicate catalogue asserts that a
//      re-sent completion cannot produce a second trip. Widen the guard from "a different
//      key" to "any existing trip" and every queued retry in the field turns into an
//      error shown to a member who did nothing wrong.
//   2. THE CHECK RUNS UNDER THE BOOKING LOCK. The booking row is the idempotency boundary
//      the inner RPC already serialises on; taking it here, one step earlier, is what
//      makes the refusal deterministic instead of a race between two pre-checks. Move the
//      check above the lock and two contenders both see nothing and both write.
//   3. THE HANDLER IS NARROW. It matches ONE constraint name and re-raises everything
//      else. A handler that swallowed every unique_violation in this function would
//      report a duplicate trip idempotency key — or a fuel key collision — as "this
//      booking is already completed", which is a lie a member cannot act on.
//   4. THE GATES AHEAD OF IT STILL SPEAK FIRST. A non-member hears 42501 and a caller who
//      sent no idempotency key hears 'Missing legacy trip id'; neither may be told about
//      a booking's completion state by a guard that drifted above them.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (static): the SHAPE of migration 197 and of its supabase-schema.sql mirror — the
//   errcode, the one Danish sentence in both files, the provenance chain in the header,
//   the unchanged signature, the pre-check's three narrowing conditions and its position
//   inside the lock, and the handler's exact narrow form. Plus the two simulator wirings
//   this migration is verified by. check-schema-equivalence proves the two SQL files
//   replay identically; this proves the thing they both replay is the thing GV-479
//   decided.
// Part 2 (Docker): the BEHAVIOUR on a real Postgres — the retry, the refusal, the fact
//   that the refused completion wrote NOTHING, the two gates that still speak first, and
//   both halves of the handler (the index translated, another constraint re-raised)
//   executed against a real unique violation.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-double-completion-guard-contract.mjs            # warn on Docker
//   node tools/test-double-completion-guard-contract.mjs --strict   # umbrella / CI
//
// Without Docker the behavioural half is skipped and warns, exactly as
// test-handover-odometer-guard-contract.mjs does, so `npm run validate` stays
// dependency-free.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRejection } from "./simulator/lib/actions.mjs";
import { SCENARIOS } from "./simulator/lib/interleave.mjs";
import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-double-completion-${process.pid}`;
const DB = "dblguard";

const ERRCODE = "GV479";
const SENTENCE = "Bookingen er allerede afsluttet med en tur — opdater og se den nye tur.";
const INDEX = "trips_one_active_per_booking_idx";

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
const MIGRATION = join(ROOT, "supabase", "migrations", "197_double_completion_guard.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");
const migrationSql = readFileSync(MIGRATION, "utf8");
const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

// The consolidated schema carries every historical definition of this function (six of
// them), so a bare search proves nothing about which one WINS. Last definition wins on
// replay, so read only the tail from 197's own mirror header.
const mirrorIdx = consolidatedSql.lastIndexOf("-- ── Migration 197:");
assert.notEqual(mirrorIdx, -1, "supabase-schema.sql is missing the migration 197 mirror block");

const sqlSources = {
  "migration 197": migrationSql,
  "supabase-schema.sql (197 tail)": consolidatedSql.slice(mirrorIdx),
};

process.stdout.write("\nSQL shape (migration 197 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(sqlSources)) {
  const startAt = sql.indexOf("create or replace function public.complete_booking_trip_with_fuel(");
  assert.notEqual(startAt, -1, `${name}: complete_booking_trip_with_fuel not found`);
  // Bounded at 197's own tracker insert, which is the last statement of its block in BOTH
  // sources. Slicing to end-of-file instead was correct only while 197 was the newest
  // migration: migration 198 appended after it in supabase-schema.sql, and its
  // `when unique_violation then` (a different function's, in a different migration)
  // immediately failed this file's "exactly one handler" count (GV-470).
  const endAt = sql.indexOf("insert into public.fuel_ledger_schema_migrations", startAt);
  assert.notEqual(endAt, -1, `${name}: migration 197's tracker insert is missing`);
  const fn = sql.slice(startAt, endAt);

  pin(`${name}: the signature is migration 188's, unchanged, and nothing is DROPPED`, () => {
    // Two candidate signatures with defaulted parameters is PGRST203 — PostgREST resolves
    // neither and every completion in the app fails. This guard adds no parameter, so
    // create-or-replace is the whole change and a DROP would open that window for nothing.
    assert.match(
      fn,
      /fuel_event_title text default null,\s*\n\s*fuel_event_body text default null,\s*\n\s*crossing_provided boolean default false\s*\n\)/,
    );
    assert.doesNotMatch(sql, /^drop function.*complete_booking_trip_with_fuel/im);
    for (const acl of [
      "revoke all on function public.complete_booking_trip_with_fuel(",
      "grant execute on function public.complete_booking_trip_with_fuel(",
    ]) {
      assert.ok(fn.includes(acl), `148's ACL convention: ${acl}`);
    }
  });

  pin(`${name}: ONE Danish sentence under the ONE distinct errcode, raised exactly twice`, () => {
    const raises = [...fn.matchAll(/raise exception '([^']*)'\s*\n?\s*using errcode = 'GV479';/g)];
    assert.equal(
      raises.length,
      2,
      "exactly two GV479 raises: the pre-check members actually hit, and the race backstop",
    );
    for (const match of raises) {
      assert.equal(
        match[1],
        SENTENCE,
        "one sentence, because the member's remedy is identical either way — refresh and look at " +
          "the trip somebody else already saved",
      );
    }
  });

  pin(`${name}: the pre-check is taken INSIDE the booking-row lock, before the delegation`, () => {
    const memberGate = fn.indexOf("and public.is_ledger_member(target_ledger_id) then");
    const lock = fn.indexOf("for update of cb;");
    const lookup = fn.indexOf("where t.booking_id = target_booking_id");
    const raise = fn.indexOf(`using errcode = '${ERRCODE}';`);
    const delegation = fn.indexOf("trip_result := public.upsert_booking_trip_with_participants(");
    assert.ok(memberGate !== -1 && lock !== -1, "the membership gate and the booking lock must both be here");
    assert.ok(
      memberGate < lock,
      "a stranger must not be able to take a lock on somebody else's booking row, and must still " +
        "hear the inner RPC's 42501 rather than a guard about a workspace they are not in",
    );
    assert.ok(
      lock < lookup && lookup < raise,
      "the lookup and the raise sit UNDER the lock — that is what makes the refusal deterministic " +
        "rather than a race between two pre-checks that both saw nothing",
    );
    assert.ok(raise < delegation, "and the whole check is ahead of the write it guards");
  });

  pin(`${name}: the pre-check fires ONLY on a DIFFERENT idempotency key`, () => {
    assert.match(
      fn,
      /if target_booking_id is not null\s*\n\s*and nullif\(legacy_trip_id, ''\) is not null\s*\n\s*and public\.is_ledger_member\(target_ledger_id\) then/,
      "a blank key must still get the inner RPC's 'Missing legacy trip id' (22023)",
    );
    assert.match(
      fn,
      /if existing_completion_legacy_id is not null\s*\n\s*and existing_completion_legacy_id is distinct from legacy_trip_id then/,
      "SAME key = the retry the offline outbox and the duplicate catalogue depend on, and it must " +
        "stay silent and idempotent; a keyless existing trip still falls through to the inner RPC's " +
        "own 23514",
    );
    assert.match(
      fn,
      /select nullif\(t\.legacy_id, ''\)\s*\n\s*into existing_completion_legacy_id\s*\n\s*from public\.trips t\s*\n\s*where t\.booking_id = target_booking_id\s*\n\s*and t\.deleted_at is null;/,
      "a soft-deleted trip no longer completes the booking (123's own rule, and the index's own " +
        "predicate) — the lookup must carry the same `deleted_at is null` the index does",
    );
  });

  pin(`${name}: the backstop wraps ONLY the delegation and matches ONE constraint`, () => {
    const guarded = fn.slice(
      fn.indexOf("  begin\n    trip_result := public.upsert_booking_trip_with_participants("),
      fn.indexOf("saved_trip_id := nullif(trip_result"),
    );
    assert.ok(guarded.length > 0, "the delegation must sit in its own begin/exception block");
    assert.match(
      guarded,
      /exception\s*\n\s*when unique_violation then\s*\n\s*get stacked diagnostics guard_constraint = constraint_name;\s*\n\s*if guard_constraint = 'trips_one_active_per_booking_idx' then/,
      "narrow by CONSTRAINT_NAME — Postgres reports the index name for a partial unique INDEX " +
        "exactly as for a unique CONSTRAINT, so this needs no substring hunt through sqlerrm",
    );
    assert.match(
      guarded,
      /end if;\s*\n\s*raise;\s*\n\s*end;/,
      "everything that is not that one index is RE-RAISED unchanged: a duplicate trip idempotency " +
        "key reported as 'this booking is already completed' is a lie a member cannot act on",
    );
    assert.doesNotMatch(fn, /when others then/, "no catch-all may appear in this function");
    assert.equal(
      (fn.match(/when unique_violation then/g) ?? []).length,
      1,
      "one handler, around the one statement that can insert or re-link a trip",
    );
  });

  pin(`${name}: the fuel half of migration 188 is carried through verbatim`, () => {
    assert.match(
      fn,
      /booking_id_value => target_booking_id\s*\n\s*\);/,
      "188's GVM-556 threading is part of the definition this migration re-declares; losing it " +
        "would silently unlink every fuel row born during a completion",
    );
    assert.match(fn, /'reused_existing_fuel', existing_fuel_legacy_id is not null/);
  });
}

pin("the migration header states the full provenance chain and names its base", () => {
  // GV-202's lesson: a re-declaration based on an INTERMEDIATE definition silently drops
  // whatever the newer ones added, and check-schema-equivalence cannot see it because both
  // files carry the same wrong body.
  assert.match(migrationSql.split("\n")[0], /^-- Migration 197: /);
  for (const step of ["136", "151", "157", "158", "188"]) {
    assert.ok(
      new RegExp(`\\b${step}\\b`).test(migrationSql.slice(0, 4000)),
      `the header must name migration ${step} in the chain`,
    );
  }
  assert.match(
    migrationSql,
    /188 \(fuel_payment_booking_link[^)]*\)[\s\S]{0,120}THIS MIGRATION'S BASE/,
    "188 is the NEWEST prior definition and the header must say so in as many words",
  );
});

pin(`${ERRCODE} is unique to this rule in the whole consolidated schema`, () => {
  const uses = [...consolidatedSql.matchAll(/errcode = '(GV[0-9A-Z]{3})'/g)].map((m) => m[1]);
  assert.equal(
    uses.filter((code) => code === ERRCODE).length,
    2,
    "the two raises in the live definition and nothing else — a second rule sharing the code would " +
      "make every client that matches on it wrong about one of them",
  );
  assert.ok(
    new Set(uses).size >= 8,
    "sanity: the GV-lettered errcode family is still there to be collided with",
  );
});

// ── The two places GV-479 is verified from, wired ────────────────────────────
pin("the simulator classifies the refusal as its own guard kind, by MESSAGE", () => {
  assert.equal(
    classifyRejection(ERRCODE, SENTENCE),
    "double_completion",
    "an unclassified rejection is a simulator FINDING, so a run that meets this guard would report " +
      "the feature as a bug; the catalogue matches on the message, per its own rule, because a " +
      "SQLSTATE-only entry would silently absorb the next rule that reuses the code",
  );
  assert.equal(
    classifyRejection("23505", `duplicate key value violates unique constraint "${INDEX}"`),
    "validation",
    "the raw index message must NOT be classified as this guard — if it ever surfaces again the " +
      "simulator should say 'duplicate key', which is what it means",
  );
});

pin("the simulator has a lockstep scenario for two members completing one booking", () => {
  const scenario = SCENARIOS.find((s) => s.id === "double_completion");
  assert.ok(scenario, "lib/interleave.mjs must carry the double_completion scenario");
  assert.match(scenario.lock, /car_bookings|booking/i, "it must name the lock the schema takes");
  assert.equal(typeof scenario.build, "function");
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
    "Double-completion guard behaviour not checked",
    "Docker is unavailable, so complete_booking_trip_with_fuel was NOT executed. The retry, the " +
      "refusal, the write-nothing promise, the gates ahead of the guard and both halves of the " +
      "unique_violation handler were skipped on this run.",
  );
  report();
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ double-completion guard contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function raw(sql, args = []) {
    const res = psql(CONTAINER, DB, [...args, "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }
  const scalar = (sql) => raw(sql, ["-t", "-A"]);

  /** Run `sql` as `email`; returns { sqlstate, message } — 'OK' for both when it passed. */
  function attempt(email, sql) {
    const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVSTATE:OK|OK';
exception when others then
  raise notice 'GVSTATE:%|%', sqlstate, sqlerrm;
end $$;`;
    const res = psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${wrapped}`,
    ]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
    const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:([^|]*)\|(.*)/);
    if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
    return { sqlstate: match[1].trim(), message: match[2].trim() };
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
  // One workspace with an admin (Anna) and the member who books the car (Bo), plus a
  // second workspace whose admin (Erik) is a complete stranger to the first — the
  // non-member case has to be a real signed-in member of somewhere else, or it would
  // prove only that an unauthenticated caller is refused. Bookings sit on their own PAST
  // days anchored to 09:00Z, so an evening run cannot cross Copenhagen midnight (PR
  // #224's lesson), and the period is opened well before them.
  const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
  const ANNA = M(1);
  const BO = M(2);
  const ERIK = M(3);
  const PERIOD = "20000000-0000-0000-0000-000000000001";
  const B = (n) => `30000000-0000-0000-0000-00000000000${n}`;

  const seed = `
insert into public.ledgers (id, name, slug) values
  ('dbl', 'Double completion', 'dbl'),
  ('dbl-other', 'Somewhere else', 'dbl-other');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${ANNA}', 'dbl', 'Anna', 'anna@dbl.dk', 'admin',  true),
  ('${BO}',   'dbl', 'Bo',   'bo@dbl.dk',   'member', true),
  ('${ERIK}', 'dbl-other', 'Erik', 'erik@dbl.dk', 'admin', true);

insert into public.settlement_periods (id, ledger_id, status, label, opened_at)
values ('${PERIOD}', 'dbl', 'open', 'Open', now() - interval '60 days');

insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
select
  ('30000000-0000-0000-0000-00000000000' || n)::uuid,
  'dbl', '${BO}',
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '9 hour',
  date_trunc('day', now()) - ((10 - n) || ' day')::interval + interval '13 hour',
  '${BO}'
from generate_series(1, 6) as n;
`;
  {
    const res = psql(CONTAINER, DB, ["-c", seed]);
    if (res.status !== 0) fail(`Seeding ledgers/members/period/bookings failed:\n${res.stderr}`);
  }

  const bookingDate = (n) => `(date_trunc('day', now()) - ((10 - ${n}) || ' day')::interval)::date`;

  /** One real completion, positional through the first eleven arguments (the rest default). */
  function complete({ booking, key, actor = "bo@dbl.dk", driver = BO, startKm = 100, endKm = 150 }) {
    return attempt(
      actor,
      `perform public.complete_booking_trip_with_fuel(
         'dbl', '${PERIOD}'::uuid, '${B(booking)}'::uuid, ${key === null ? "null" : `'${key}'`},
         '${driver}'::uuid, ${bookingDate(booking)}, ${startKm}, ${endKm},
         'Tur', array['${driver}']::uuid[], 'not_needed');`,
    );
  }

  const tripsFor = (booking) =>
    scalar(`select count(*) from public.trips
              where booking_id = '${B(booking)}'::uuid and deleted_at is null;`);
  const tripFact = (booking, column) =>
    scalar(`select coalesce(${column}::text, 'NULL') from public.trips
              where booking_id = '${B(booking)}'::uuid and deleted_at is null;`);

  // ── 1. The retry that must stay silent ──────────────────────────────────────
  process.stdout.write("\nThe same key twice — the retry the offline outbox depends on:\n");

  pin("Bo completes his booking, and the trip is linked", () => {
    assert.deepEqual(complete({ booking: 1, key: "t-1" }), { sqlstate: "OK", message: "OK" });
    assert.equal(tripsFor(1), "1");
    assert.equal(tripFact(1, "legacy_id"), "t-1");
  });

  pin("the SAME completion re-sent is accepted and creates nothing — idempotent, unchanged", () => {
    assert.deepEqual(complete({ booking: 1, key: "t-1", endKm: 160 }), { sqlstate: "OK", message: "OK" });
    assert.equal(tripsFor(1), "1", "a replayed outbox entry must never stack a second trip");
    assert.equal(tripFact(1, "end_km"), "160.0", "and it must still RECONCILE — a retry is an update, not a no-op");
  });

  // ── 2. The second completion, which is a different thing entirely ───────────
  process.stdout.write("\nA DIFFERENT key on a booking that is already completed:\n");

  pin("the admin's second completion is refused with the Danish sentence under GV479", () => {
    const refused = complete({ booking: 1, key: "t-2", actor: "anna@dbl.dk", endKm: 999 });
    assert.equal(refused.sqlstate, ERRCODE);
    assert.equal(refused.message, SENTENCE);
  });

  pin("...and it wrote NOTHING: no second trip, no adopted kilometres, no event", () => {
    assert.equal(tripsFor(1), "1");
    assert.equal(tripFact(1, "legacy_id"), "t-1", "Bo's trip is still Bo's trip");
    assert.equal(
      tripFact(1, "end_km"),
      "160.0",
      "this is the silent half of the bug: before 197 the second completion RECONCILED, and 999 km " +
        "would have replaced 160 with nobody told",
    );
    assert.equal(
      scalar(`select count(*) from public.trips where ledger_id = 'dbl' and legacy_id = 't-2';`),
      "0",
      "a refused completion is a write that did not happen",
    );
  });

  pin("the booked member is refused on their own booking too — this is not a permission rule", () => {
    const refused = complete({ booking: 1, key: "t-3" });
    assert.equal(refused.sqlstate, ERRCODE);
  });

  pin("a fresh booking still completes normally", () => {
    assert.deepEqual(complete({ booking: 2, key: "t-4", startKm: 160, endKm: 205 }), { sqlstate: "OK", message: "OK" });
    assert.equal(tripsFor(2), "1");
  });

  pin("a soft-deleted trip releases the booking — 123's rule, and the guard follows it", () => {
    raw(`update public.trips set deleted_at = now() where ledger_id = 'dbl' and legacy_id = 't-4';`);
    assert.deepEqual(complete({ booking: 2, key: "t-5", startKm: 160, endKm: 210 }), { sqlstate: "OK", message: "OK" });
    assert.equal(tripsFor(2), "1");
    assert.equal(tripFact(2, "legacy_id"), "t-5");
  });

  // ── 3. The gates that still speak first ─────────────────────────────────────
  process.stdout.write("\nThe gates ahead of the guard, on the same already-completed booking:\n");

  pin("a member of another workspace hears 42501, never the guard", () => {
    const refused = complete({ booking: 1, key: "t-6", actor: "erik@dbl.dk" });
    assert.equal(refused.sqlstate, "42501");
    assert.match(refused.message, /^Only ledger members can complete bookings/);
  });

  pin("a caller who sent no idempotency key hears about THAT, never the guard", () => {
    const refused = complete({ booking: 1, key: null });
    assert.equal(refused.sqlstate, "22023");
    assert.match(refused.message, /^Missing legacy trip id/);
  });

  pin("a booking that does not exist still reports itself as missing", () => {
    const refused = attempt(
      "bo@dbl.dk",
      `perform public.complete_booking_trip_with_fuel(
         'dbl', '${PERIOD}'::uuid, '30000000-0000-0000-0000-0000000000ff'::uuid, 't-7',
         '${BO}'::uuid, current_date, 100, 150, 'Tur', array['${BO}']::uuid[], 'not_needed');`,
    );
    assert.equal(refused.sqlstate, "42501");
    assert.match(
      refused.message,
      /Booking was not found or is unavailable/,
      "the pre-check must skip a booking it could not lock and let the inner RPC answer",
    );
  });

  // ── 4. The race backstop, executed ──────────────────────────────────────────
  //
  // The pre-check holds the booking lock, so no caller of THIS function can reach the
  // index through it — which is the point, and also why the handler needs an injected
  // writer to be executed at all. The trigger below is that writer: it stands in for
  // exactly what the doc comment says the backstop covers — a row that links this booking
  // without ever taking the booking lock (a direct table write under RLS, or a future
  // caller of upsert_booking_trip_with_participants that skips this wrapper). It fires
  // once, from inside the delegation, after the pre-check has already looked and seen
  // nothing, which is the interleaving a real concurrent writer would produce.
  process.stdout.write("\nThe narrow unique_violation handler, against a real violation:\n");

  raw(`
create function public.gv479_probe() returns trigger
language plpgsql as $probe$
declare
  mode text := coalesce(current_setting('gv479.mode', true), 'off');
begin
  -- One shot: the injected insert fires this same trigger, and a writer that keeps
  -- writing is a recursion, not a race.
  perform set_config('gv479.mode', 'off', true);
  if mode = 'link' then
    -- Another writer links the SAME booking while this completion is in flight.
    insert into public.trips (ledger_id, legacy_id, period_id, driver_member_id, trip_date, start_km, end_km, booking_id)
    values ('dbl', 'rogue-link', '${PERIOD}', '${BO}', ${bookingDate(3)}, 10, 20, '${B(3)}');
  elsif mode = 'dup' then
    -- A DIFFERENT unique constraint entirely: the (ledger_id, legacy_id) key.
    insert into public.trips (ledger_id, legacy_id, period_id, driver_member_id, trip_date, start_km, end_km)
    values ('dbl', 't-1', '${PERIOD}', '${BO}', ${bookingDate(3)}, 10, 20);
  end if;
  return new;
end;
$probe$;
create trigger gv479_probe_trg after insert on public.trips
  for each row execute function public.gv479_probe();`);

  pin(`a violation of ${INDEX} becomes the SAME Danish sentence under ${ERRCODE}`, () => {
    const refused = attempt(
      "bo@dbl.dk",
      `perform set_config('gv479.mode', 'link', true);
       perform public.complete_booking_trip_with_fuel(
         'dbl', '${PERIOD}'::uuid, '${B(3)}'::uuid, 't-8', '${BO}'::uuid,
         ${bookingDate(3)}, 210, 260, 'Tur', array['${BO}']::uuid[], 'not_needed');`,
    );
    assert.equal(refused.sqlstate, ERRCODE, "the raw index message must never reach a member");
    assert.equal(refused.message, SENTENCE);
  });

  pin("...and a violation of ANY OTHER constraint is re-raised exactly as it was", () => {
    const refused = attempt(
      "bo@dbl.dk",
      `perform set_config('gv479.mode', 'dup', true);
       perform public.complete_booking_trip_with_fuel(
         'dbl', '${PERIOD}'::uuid, '${B(4)}'::uuid, 't-9', '${BO}'::uuid,
         ${bookingDate(4)}, 210, 260, 'Tur', array['${BO}']::uuid[], 'not_needed');`,
    );
    assert.equal(refused.sqlstate, "23505", "a duplicate idempotency key is not a completed booking");
    assert.match(refused.message, /duplicate key value violates unique constraint/);
    assert.doesNotMatch(refused.message, /Bookingen er allerede afsluttet/);
  });

  pin("the injected writer left the workspace exactly as it found it", () => {
    raw(`drop trigger gv479_probe_trg on public.trips;
         drop function public.gv479_probe();`);
    assert.equal(
      scalar(`select count(*) from public.trips where ledger_id = 'dbl' and legacy_id in ('rogue-link', 't-8', 't-9');`),
      "0",
      "both attempts aborted whole — the rogue row went down with the statement that injected it",
    );
    assert.deepEqual(
      complete({ booking: 3, key: "t-10", startKm: 210, endKm: 260 }),
      { sqlstate: "OK", message: "OK" },
      "and the booking is still completable once the outside writer is gone",
    );
  });

  finished = true;
  removeContainer(CONTAINER);
  report();
}

function report() {
  process.stdout.write(`\n✅ double-completion guard contract: ${checked} pins held.\n`);
  if (warnings.length > 0) {
    process.stdout.write(`⚠️  ${warnings.length} half(s) could not be checked on this run.\n`);
  }
}

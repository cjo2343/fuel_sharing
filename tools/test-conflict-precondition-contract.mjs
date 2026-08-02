// Anti-drift contract for the optimistic-concurrency preconditions (GV-421).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 160 is the first thing in this schema that refuses a write because of
// WHEN the caller last read the row. Everything it promises is invisible in the SQL
// text and only observable by asking a real Postgres to refuse a real edit:
//
//   • the promise that protects live data — a NULL token is byte-identical to the
//     last-write-wins behaviour every shipped client depends on. Pinned as an
//     EQUALITY (the edit lands, the row carries the new value) rather than as an
//     absence of errors, because a precondition that silently swallowed the write
//     would also raise nothing;
//   • that a STALE token refuses AND writes nothing — a check that raised after the
//     upsert would look identical in a diff and would have already overwritten the
//     row it was meant to protect;
//   • that a FRESH token gets out of the way completely;
//   • that a token on a CREATE is ignored rather than treated as an error, so a
//     client bug cannot lose the only copy of a trip;
//   • and the comparison rule itself: MILLISECOND truncation, so a token that lost
//     its microseconds to a JavaScript Date is still accepted, while a real
//     millisecond of movement is refused. Both boundaries, or the rule is one
//     "tidy-up" away from refusing every edit forever.
//
// The three errcode LITERALS are asserted as strings here and nowhere else on this
// side of the wire (the GVM-463 audit lesson: a test that derives its fixtures from
// the same constant it asserts proves only that the constant equals itself).
//
// ── Docker ──────────────────────────────────────────────────────────────────────
// Real refusal needs a real Postgres, so this replays supabase-schema.sql into a
// disposable container. Docker-free machines get a loud warning and a pass — the same
// contract test-booking-caps-contract.mjs uses — so `npm run validate` stays
// dependency-free. CI runs it with --strict, where a skip is a failure.
//
//   node tools/test-conflict-precondition-contract.mjs            # warn without Docker
//   node tools/test-conflict-precondition-contract.mjs --strict   # CI: unchecked = failure

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const CONTAINER = `govehlo-conflict-precondition-${process.pid}`;
const DB = "conflictprecond";

// THE WIRE CONTRACT, written out as literals exactly once. The client mirrors these
// three strings; nothing here derives them from anything.
const TRIP_CONFLICT = "GV42T";
const FUEL_CONFLICT = "GV42F";
const BOOKING_CONFLICT = "GV42B";

let checked = 0;

function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  const message =
    "conflict precondition contract: Docker is unavailable, so the SQL was NOT executed. " +
    "The expected_updated_at preconditions in migration 160 are unverified on this run.";
  if (strict) {
    process.stderr.write(`\n❌ ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n⚠️  ${message}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`\n❌ conflict precondition contract: ${message}\n`);
  removeContainer(CONTAINER);
  process.exit(1);
}

try {
  startPostgres(CONTAINER, ROOT);
  createDbWithPrelude(CONTAINER, DB);
} catch (error) {
  fail(error.message);
}

const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

// ── Fixtures ───────────────────────────────────────────────────────────────────
// One workspace, one open period, an admin (Anna) and a second member (Bo). Anna is
// admin so she can edit anything — the point here is never permission, it is WHEN
// the caller last read the row.
const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
const PERIOD = "20000000-0000-0000-0000-000000000001";
const L = "conflict";

const seed = `
insert into public.ledgers (id, name, slug) values ('${L}', 'Conflict test', '${L}');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${M(1)}', '${L}', 'Anna', 'anna@test.dk', 'admin',  true),
  ('${M(2)}', '${L}', 'Bo',   'bo@test.dk',   'member', true);

insert into public.settlement_periods (id, ledger_id, status, label, opened_at)
values ('${PERIOD}', '${L}', 'open', 'Open', now() - interval '60 days');
`;
if (psql(CONTAINER, DB, ["-c", seed]).status !== 0) fail("Seeding ledger/members/period failed");

function raw(sql, args = []) {
  const res = psql(CONTAINER, DB, [...args, "-c", sql]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
  return res.stdout.trim();
}

const scalar = (sql) => raw(sql, ["-t", "-A"]);

/** Run `sql` as `email` and return the SQLSTATE it raises, or 'OK' when it succeeds. */
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

// ── The three write paths, each parameterised by its precondition token ─────────
// `token` is a SQL EXPRESSION, so a case can pass `null`, a literal timestamp, or a
// sub-select against the row itself.

const tripState = ({ legacy, note = "", endKm = 100, token = "null", actor = "anna@test.dk" }) =>
  sqlstateOf(
    actor,
    `perform public.upsert_trip_with_participants(
       '${L}', '${PERIOD}', '${legacy}', '${M(1)}', current_date, 0, ${endKm},
       '${note}', array['${M(1)}']::uuid[],
       null, null, null, null, null, false, ${token});`,
  );

const fuelState = ({ legacy, amount = 100, station = "", token = "null", actor = "anna@test.dk" }) =>
  sqlstateOf(
    actor,
    `perform public.upsert_fuel_payment(
       '${L}', '${PERIOD}', '${legacy}', '${M(1)}', current_date, ${amount}, 'DKK',
       null, null, null, ${station === "" ? "null" : `'${station}'`}, null, false,
       null, null, ${token});`,
  );

// `from`/`to` are whole days from now. Every booking case below gets its OWN
// window: car_bookings carries an overlap exclusion constraint, so two fixtures
// sharing a day would fail with 23P01 and say nothing about preconditions.
const bookingState = ({ legacy, purpose = "", from = 1, to = from, token = "null", actor = "anna@test.dk" }) =>
  sqlstateOf(
    actor,
    `perform public.upsert_car_booking(
       '${L}', '${legacy}', '${M(1)}',
       now() + interval '${from} day', now() + interval '${to} day' + interval '4 hour',
       ${purpose === "" ? "null" : `'${purpose}'`}, null, null, null, ${token});`,
  );

/** The row's live updated_at, as a SQL expression usable as a token. */
const liveToken = (table, legacy) =>
  `(select ${table}.updated_at from public.${table} where ledger_id = '${L}' and legacy_id = '${legacy}')`;

const readColumn = (table, legacy, column) =>
  scalar(
    `select coalesce(${column}::text, 'NULL') from public.${table} where ledger_id = '${L}' and legacy_id = '${legacy}';`,
  );

/** The WHOLE row as jsonb text — the only honest way to assert "nothing changed". */
const rowSnapshot = (table, legacy) =>
  scalar(`select to_jsonb(t)::text from public.${table} t where ledger_id = '${L}' and legacy_id = '${legacy}';`);

const rowCount = (table, legacy) =>
  Number(scalar(`select count(*) from public.${table} where ledger_id = '${L}' and legacy_id = '${legacy}';`));

/** Freeze a row's updated_at at an exact microsecond value, for the truncation cases. */
const setUpdatedAt = (table, legacy, literal) =>
  raw(
    `update public.${table} set updated_at = timestamptz '${literal}' where ledger_id = '${L}' and legacy_id = '${legacy}';`,
  );

process.stdout.write("\nConflict preconditions (real Postgres, consolidated schema):\n");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. NULL TOKEN — the promise that makes this migration safe to apply
// ═══════════════════════════════════════════════════════════════════════════════
// Every client build that has ever shipped omits the argument, which PostgreSQL
// fills with null. That path must still be last-write-wins, and it is asserted as
// an equality on the row's VALUE, not as "no exception was raised".

pin("trip: a null token still overwrites a row that moved underneath — last-write-wins is intact", () => {
  assert.equal(tripState({ legacy: "t-null", note: "first" }), "OK");
  const stale = scalar(`select ${liveToken("trips", "t-null")}::text;`);
  // Somebody else edits it in between.
  assert.equal(tripState({ legacy: "t-null", note: "somebody else" }), "OK");
  assert.notEqual(scalar(`select ${liveToken("trips", "t-null")}::text;`), stale, "the row must really have moved");
  // The pre-160 client saves its stale form with NO token at all.
  assert.equal(tripState({ legacy: "t-null", note: "stale client" }), "OK");
  assert.equal(readColumn("trips", "t-null", "note"), "stale client", "null means no precondition, so it wins");
});

pin("fuel: a null token still overwrites a row that moved underneath", () => {
  assert.equal(fuelState({ legacy: "f-null", amount: 100 }), "OK");
  assert.equal(fuelState({ legacy: "f-null", amount: 200 }), "OK");
  assert.equal(fuelState({ legacy: "f-null", amount: 300 }), "OK");
  assert.equal(readColumn("fuel_payments", "f-null", "amount"), "300.00");
});

pin("booking: a null token still overwrites a row that moved underneath", () => {
  assert.equal(bookingState({ legacy: "b-null", purpose: "first", from: 1 }), "OK");
  assert.equal(bookingState({ legacy: "b-null", purpose: "somebody else", from: 1 }), "OK");
  assert.equal(bookingState({ legacy: "b-null", purpose: "stale client", from: 1 }), "OK");
  assert.equal(readColumn("car_bookings", "b-null", "purpose"), "stale client");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. A TOKEN ON A CREATE IS IGNORED
// ═══════════════════════════════════════════════════════════════════════════════
// No row, nothing to conflict with. Refusing here would lose the only copy of the
// entry over a client bug, which is a far worse failure than the one being fixed.

pin("trip: a token on a CREATE is ignored and the insert proceeds", () => {
  assert.equal(
    tripState({ legacy: "t-create", note: "created", token: "timestamptz '2020-01-01 00:00:00+00'" }),
    "OK",
  );
  assert.equal(rowCount("trips", "t-create"), 1, "the trip must actually exist");
});

pin("fuel: a token on a CREATE is ignored and the insert proceeds", () => {
  assert.equal(fuelState({ legacy: "f-create", token: "timestamptz '2020-01-01 00:00:00+00'" }), "OK");
  assert.equal(rowCount("fuel_payments", "f-create"), 1);
});

pin("booking: a token on a CREATE is ignored and the insert proceeds", () => {
  assert.equal(
    bookingState({ legacy: "b-create", from: 3, token: "timestamptz '2020-01-01 00:00:00+00'" }),
    "OK",
  );
  assert.equal(rowCount("car_bookings", "b-create"), 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. A FRESH TOKEN GETS OUT OF THE WAY
// ═══════════════════════════════════════════════════════════════════════════════

pin("trip: an edit carrying the row's CURRENT updated_at is accepted and lands", () => {
  assert.equal(tripState({ legacy: "t-fresh", note: "before" }), "OK");
  assert.equal(tripState({ legacy: "t-fresh", note: "after", token: liveToken("trips", "t-fresh") }), "OK");
  assert.equal(readColumn("trips", "t-fresh", "note"), "after");
});

pin("fuel: an edit carrying the row's CURRENT updated_at is accepted and lands", () => {
  assert.equal(fuelState({ legacy: "f-fresh", amount: 100 }), "OK");
  assert.equal(
    fuelState({ legacy: "f-fresh", amount: 250, token: liveToken("fuel_payments", "f-fresh") }),
    "OK",
  );
  assert.equal(readColumn("fuel_payments", "f-fresh", "amount"), "250.00");
});

pin("booking: an edit carrying the row's CURRENT updated_at is accepted and lands", () => {
  assert.equal(bookingState({ legacy: "b-fresh", purpose: "before", from: 5 }), "OK");
  assert.equal(
    bookingState({ legacy: "b-fresh", purpose: "after", from: 5, token: liveToken("car_bookings", "b-fresh") }),
    "OK",
  );
  assert.equal(readColumn("car_bookings", "b-fresh", "purpose"), "after");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. A STALE TOKEN — the errcode, AND the row is untouched
// ═══════════════════════════════════════════════════════════════════════════════
// The row-unchanged half is the one a code reading alone cannot certify: a check
// placed after the upsert raises the same code having already done the damage.

function staleCase({ label, table, legacy, write, code, edit }) {
  pin(label, () => {
    assert.equal(write({ legacy, ...edit.first }), "OK");
    const stale = scalar(`select ${liveToken(table, legacy)}::text;`);
    // Another member saves. This is what makes the first caller's token stale.
    assert.equal(write({ legacy, ...edit.other }), "OK");
    const before = rowSnapshot(table, legacy);
    // The first caller finally taps Gem, against the version they loaded.
    assert.equal(
      write({ legacy, ...edit.late, token: `timestamptz '${stale}'` }),
      code,
      "a stale token must raise this entity's conflict code",
    );
    assert.equal(rowSnapshot(table, legacy), before, "and NOTHING may be written — not one column");
  });
}

staleCase({
  label: `trip: a stale token raises ${TRIP_CONFLICT} and leaves the row byte-identical`,
  table: "trips",
  legacy: "t-stale",
  write: tripState,
  code: TRIP_CONFLICT,
  edit: { first: { note: "mine" }, other: { note: "theirs" }, late: { note: "overwrite", endKm: 999 } },
});

staleCase({
  label: `fuel: a stale token raises ${FUEL_CONFLICT} and leaves the row byte-identical`,
  table: "fuel_payments",
  legacy: "f-stale",
  write: fuelState,
  code: FUEL_CONFLICT,
  edit: { first: { amount: 100 }, other: { amount: 200 }, late: { amount: 999, station: "Q8" } },
});

staleCase({
  label: `booking: a stale token raises ${BOOKING_CONFLICT} and leaves the row byte-identical`,
  table: "car_bookings",
  legacy: "b-stale",
  write: bookingState,
  code: BOOKING_CONFLICT,
  edit: {
    first: { purpose: "mine", from: 7 },
    other: { purpose: "theirs", from: 7 },
    late: { purpose: "overwrite", from: 7, to: 9 },
  },
});

pin("the three codes are DISTINCT — the client has to be able to name what moved", () => {
  const codes = new Set([TRIP_CONFLICT, FUEL_CONFLICT, BOOKING_CONFLICT]);
  assert.equal(codes.size, 3, "one code per ticket could not say which entity conflicted");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE COMPARISON RULE — millisecond truncation, both boundaries
// ═══════════════════════════════════════════════════════════════════════════════
// The reachable false positive: a token that has been through a JavaScript Date has
// lost its microseconds. If the comparison were exact, EVERY edit from such a client
// would be refused forever, blaming a member who did nothing. The reachable true
// positive: a real second write moves updated_at by far more than a millisecond.

const MICRO = "2026-08-01 09:12:33.123456+00";
const MILLIS_ONLY = "2026-08-01 09:12:33.123+00"; // what new Date(...).toISOString() yields
const ONE_MS_LATER = "2026-08-01 09:12:33.124456+00";

pin("trip: a token that lost its MICROseconds is still accepted (the JS Date round trip)", () => {
  assert.equal(tripState({ legacy: "t-us", note: "seed" }), "OK");
  setUpdatedAt("trips", "t-us", MICRO);
  assert.equal(
    tripState({ legacy: "t-us", note: "edited", token: `timestamptz '${MILLIS_ONLY}'` }),
    "OK",
    ".123456 and .123 are the same millisecond, so this is not a conflict",
  );
  assert.equal(readColumn("trips", "t-us", "note"), "edited");
});

pin("trip: a token one MILLIsecond off is refused — the tolerance is not a free-for-all", () => {
  assert.equal(tripState({ legacy: "t-ms", note: "seed" }), "OK");
  setUpdatedAt("trips", "t-ms", MICRO);
  assert.equal(
    tripState({ legacy: "t-ms", note: "edited", token: `timestamptz '${ONE_MS_LATER}'` }),
    TRIP_CONFLICT,
  );
  assert.equal(readColumn("trips", "t-ms", "note"), "seed", "and the row is untouched");
});

pin("fuel: the same millisecond rule, both sides", () => {
  assert.equal(fuelState({ legacy: "f-us", amount: 100 }), "OK");
  setUpdatedAt("fuel_payments", "f-us", MICRO);
  assert.equal(fuelState({ legacy: "f-us", amount: 150, token: `timestamptz '${MILLIS_ONLY}'` }), "OK");
  setUpdatedAt("fuel_payments", "f-us", MICRO);
  assert.equal(
    fuelState({ legacy: "f-us", amount: 999, token: `timestamptz '${ONE_MS_LATER}'` }),
    FUEL_CONFLICT,
  );
  assert.equal(readColumn("fuel_payments", "f-us", "amount"), "150.00");
});

pin("booking: the same millisecond rule, both sides", () => {
  assert.equal(bookingState({ legacy: "b-us", purpose: "seed", from: 11 }), "OK");
  setUpdatedAt("car_bookings", "b-us", MICRO);
  assert.equal(
    bookingState({ legacy: "b-us", purpose: "edited", from: 11, token: `timestamptz '${MILLIS_ONLY}'` }),
    "OK",
  );
  setUpdatedAt("car_bookings", "b-us", MICRO);
  assert.equal(
    bookingState({ legacy: "b-us", purpose: "overwrite", from: 11, token: `timestamptz '${ONE_MS_LATER}'` }),
    BOOKING_CONFLICT,
  );
  assert.equal(readColumn("car_bookings", "b-us", "purpose"), "edited");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. THE CONFLICT IS SILENT IN THE FEED, AND ORDERED BEFORE THE BOOKING CAPS
// ═══════════════════════════════════════════════════════════════════════════════

pin("a refused write logs NO ledger_event — a conflict is a write that did not happen", () => {
  assert.equal(bookingState({ legacy: "b-quiet", purpose: "seed", from: 13 }), "OK");
  const stale = scalar(`select ${liveToken("car_bookings", "b-quiet")}::text;`);
  assert.equal(bookingState({ legacy: "b-quiet", purpose: "moved", from: 13 }), "OK");
  raw("delete from public.ledger_events;");
  assert.equal(
    bookingState({ legacy: "b-quiet", purpose: "late", from: 13, token: `timestamptz '${stale}'` }),
    BOOKING_CONFLICT,
  );
  assert.equal(Number(scalar("select count(*) from public.ledger_events;")), 0);
});

pin("a conflicting booking reports the CONFLICT, not the day cap it would also break", () => {
  // Both would fire. The precondition must win: "loftet er nået" is the wrong
  // sentence for a row that simply moved, and the count itself was taken against a
  // window this caller has never seen.
  // Start from an empty sheet: with a cap of 1 the fixtures above would trip GV46D
  // on the SEED write and the ordering this case exists to prove would never be
  // reached.
  raw("delete from public.car_bookings;");
  raw(`update public.ledgers set booking_max_days_per_member = 1 where id = '${L}';`);
  assert.equal(bookingState({ legacy: "b-order", purpose: "seed", from: 40 }), "OK");
  const stale = scalar(`select ${liveToken("car_bookings", "b-order")}::text;`);
  assert.equal(bookingState({ legacy: "b-order", purpose: "moved", from: 40 }), "OK");
  // Five days against a cap of one: GV46D is waiting behind the precondition.
  assert.equal(
    bookingState({ legacy: "b-order", purpose: "late", from: 41, to: 45, token: `timestamptz '${stale}'` }),
    BOOKING_CONFLICT,
    "the precondition sits ahead of migration 159's caps",
  );
  // And with a FRESH token the very same write is refused by the cap — which is what
  // makes the assertion above about ORDER rather than about the cap being off.
  assert.equal(
    bookingState({ legacy: "b-order", purpose: "late", from: 41, to: 45, token: liveToken("car_bookings", "b-order") }),
    "GV46D",
  );
  raw(`update public.ledgers set booking_max_days_per_member = null where id = '${L}';`);
});

// ── Part 7: the static half ────────────────────────────────────────────────────
// The equivalence checker proves the migration and supabase-schema.sql replay
// identically; this proves the shape is the INTENDED one rather than identically
// wrong in both, which is the failure a replay diff cannot see.

const migration = readFileSync(path.join(ROOT, "supabase/migrations/160_conflict_preconditions.sql"), "utf8");

// The migration's own prose quotes the parameter declaration and the truncation call,
// and so does the tracker-row description. Count against CODE only, or every counted
// assertion below is really an assertion about how the header is worded.
const code = migration
  .split("-- ── Register migration")[0]
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

pin("the parameter is OPTIONAL on all three RPCs — a default is what keeps old clients alive", () => {
  const declarations = code.match(/^ {2}expected_updated_at timestamptz default null$/gm) ?? [];
  assert.equal(declarations.length, 3, "one defaulted declaration per RPC, no more and no fewer");
  assert.doesNotMatch(
    code,
    /^ {2}expected_updated_at timestamptz(?!\s+default null)/m,
    "a non-defaulted token would break every shipped client on the day this is applied",
  );
});

pin("each entity raises its OWN documented errcode literal", () => {
  assert.ok(migration.includes(`errcode = '${TRIP_CONFLICT}'`), "the trip RPC must raise the trip code");
  assert.ok(migration.includes(`errcode = '${FUEL_CONFLICT}'`), "the fuel RPC must raise the fuel code");
  assert.ok(migration.includes(`errcode = '${BOOKING_CONFLICT}'`), "the booking RPC must raise the booking code");
});

pin("each message says the changes were NOT saved, in Danish", () => {
  const messages = code.match(/raise exception 'En anden har ændret [^']*'/g) ?? [];
  assert.equal(messages.length, 3, "one conflict sentence per RPC");
  for (const message of messages) {
    assert.match(message, /Dine ændringer er ikke gemt/, "silence about what did NOT happen is the original bug");
  }
});

pin("the comparison truncates BOTH sides to milliseconds", () => {
  const comparisons = code.match(/date_trunc\('milliseconds', /g) ?? [];
  assert.equal(comparisons.length, 6, "two truncations per RPC — truncating one side only is worse than neither");
  assert.doesNotMatch(
    code,
    /existing_(trip|fuel|booking)\.updated_at\s*(<>|=|is distinct from)\s*expected_updated_at/,
    "an untruncated comparison would refuse every edit from a client that uses Date",
  );
});

pin("all three signatures are DROPped before being recreated (the 158 overload lesson)", () => {
  for (const fn of ["upsert_trip_with_participants", "upsert_fuel_payment", "upsert_car_booking"]) {
    assert.match(
      code,
      new RegExp(`drop function if exists public\\.${fn}\\(`),
      `${fn} gains a parameter, so create-or-replace would leave a second overload live`,
    );
  }
});

pin("every recreated function restates its ACL with anon named explicitly (148)", () => {
  for (const fn of ["upsert_trip_with_participants", "upsert_fuel_payment", "upsert_car_booking"]) {
    assert.match(code, new RegExp(`revoke all on function public\\.${fn}\\([^)]*timestamptz\\) from anon;`));
    assert.match(code, new RegExp(`grant execute on function public\\.${fn}\\([^)]*timestamptz\\) to authenticated;`));
  }
});

removeContainer(CONTAINER);

process.stdout.write(
  `\nok - conflict precondition contract: ${checked} checks. A NULL expected_updated_at is byte-identical ` +
    `last-write-wins; a token on a create is ignored; a fresh token gets out of the way; a stale token raises ` +
    `${TRIP_CONFLICT}/${FUEL_CONFLICT}/${BOOKING_CONFLICT} and leaves the row untouched and the feed silent; ` +
    `the comparison truncates to milliseconds, so a JS-Date round trip is accepted and one real millisecond is not.\n`,
);

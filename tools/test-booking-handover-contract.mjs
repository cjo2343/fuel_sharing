// Anti-drift contract for the vehicle handover (GVM-529, migration 164).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 164 is the first table in the platform whose free text is
// personal-adjacent LOCATION data — where a shared car is parked and where its keys
// are kept. That makes its RLS posture a privacy boundary rather than a tidiness
// one, and it is the property a regex over the SQL certifies least well: the
// migration would look exactly right with the SELECT policy misspelled, with a
// stray write grant left on the table, or with the unique constraint quietly gone.
//
// The mutations this file exists to kill, each of which leaves the migration
// looking correct:
//
//   • a member of ANOTHER workspace reading a parking location across the RLS
//     boundary — the one failure that is a data-protection incident rather than a
//     bug;
//   • the UNIQUE on booking_id disappearing, so a retried save stacks a second
//     handover on the same booking and the next driver gets whichever half the
//     query happens to order first;
//   • the write gate widening to "any member", which is not a read restriction but
//     an authorship one: the handover is the account of the person who had the car;
//   • the GV-421 precondition being checked AFTER the write (identical-looking
//     diff, damage already done), or raising the wrong code;
//   • the feed event firing on every EDIT, turning three corrections to a parking
//     spot into three notifications for the whole group;
//   • the GVM-520 mirror onto ledgers losing its coalesce (migration 167), so a
//     handover that mentions no parking ERASES the car's known parking spot. That
//     mutation reads as a simplification in a diff, passes every other check in this
//     file, and destroys the group's only record of where their car is.
//
// Shape is asserted against the CATALOG of a replayed database rather than against
// the SQL text: `select relrowsecurity`, `pg_policies`, `pg_constraint`,
// `has_table_privilege`. A regex can be satisfied by a line that does not run; a
// catalog query cannot.
//
// ── Docker ──────────────────────────────────────────────────────────────────────
// Real enforcement needs a real Postgres, so this replays supabase-schema.sql into a
// disposable container. Docker-free machines get a loud warning and a pass — the
// same contract test-booking-caps-contract.mjs uses — so `npm run validate` stays
// dependency-free. CI runs it with --strict, where a skip is a failure.
//
//   node tools/test-booking-handover-contract.mjs            # warn when Docker is absent
//   node tools/test-booking-handover-contract.mjs --strict   # CI: unchecked = failure

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const CONTAINER = `govehlo-handover-${process.pid}`;
const DB = "handover";
const CONFLICT = "GV42O";

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
    "booking handover contract: Docker is unavailable, so the SQL was NOT executed. " +
    "Migration 164's RLS boundary, write gate and GV42O semantics are unverified on this run.";
  if (strict) {
    process.stderr.write(`\n❌ ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n⚠️  ${message}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`\n❌ booking handover contract: ${message}\n`);
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
// Two workspaces, because the headline privacy property is a CROSS-workspace one and
// a single-workspace fixture cannot express it.
//
//   ws  'hand'      Anna (admin), Bo (member, holds the bookings), Cille (bystander)
//   ws  'hand-two'  Erik — a real, active, signed-in member of a DIFFERENT group
//
// Bookings are inserted directly rather than through upsert_car_booking: this suite
// is about the handover, and routing the fixture through the booking RPC would drag
// in migration 159/162's caps and give a failure there a misleading name.
//
// Every timestamp is anchored to 09:00Z on a whole day rather than to `now() + N
// hours`. PR #224's lesson: `now() + interval '4 hour'` crossed Copenhagen midnight
// whenever the suite ran between 20:00 and 24:00 local and turned every evening run
// red. 09:00Z is 10:00 or 11:00 in Copenhagen year-round.
const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
const ANNA = M(1);
const BO = M(2);
const CILLE = M(3);
const ERIK = M(4);
const L = "hand";
const L2 = "hand-two";
const PERIOD = "20000000-0000-0000-0000-000000000001";

const BOOKING = (n) => `30000000-0000-0000-0000-00000000000${n}`;

const seed = `
insert into public.ledgers (id, name, slug) values
  ('${L}', 'Handover test', '${L}'),
  ('${L2}', 'Other group', '${L2}');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${ANNA}',  '${L}',  'Anna',  'anna@test.dk',  'admin',  true),
  ('${BO}',    '${L}',  'Bo',    'bo@test.dk',    'member', true),
  ('${CILLE}', '${L}',  'Cille', 'cille@test.dk', 'member', true),
  ('${ERIK}',  '${L2}', 'Erik',  'erik@test.dk',  'admin',  true);

insert into public.settlement_periods (id, ledger_id, status, label, opened_at)
values ('${PERIOD}', '${L}', 'open', 'Open', now() - interval '60 days');

-- Nine bookings for Bo, one per behavioural case, each on its own day so nothing in
-- the fixture depends on booking-window rules. Day N at 09:00Z–13:00Z. (The last two
-- belong to the GVM-520 mirroring section; the id template is single-digit, so a
-- tenth needs a wider one rather than another row here.)
insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
select
  ('30000000-0000-0000-0000-00000000000' || n)::uuid,
  '${L}', '${BO}',
  date_trunc('day', now()) + (n || ' day')::interval + interval '9 hour',
  date_trunc('day', now()) + (n || ' day')::interval + interval '13 hour',
  '${BO}'
from generate_series(1, 9) as n;

-- One booking in the OTHER workspace, so "the booking belongs to this ledger" can be
-- tested with a real id rather than a random uuid.
insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, created_by_member_id)
values ('40000000-0000-0000-0000-000000000001', '${L2}', '${ERIK}',
  date_trunc('day', now()) + interval '1 day' + interval '9 hour',
  date_trunc('day', now()) + interval '1 day' + interval '13 hour', '${ERIK}');
`;
if (psql(CONTAINER, DB, ["-c", seed]).status !== 0) fail("Seeding ledgers/members/bookings failed");

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

/** Run `sql` as `email` and return the raised MESSAGE, or 'OK'. */
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

const sqlLit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);

/**
 * Call upsert_booking_handover. `token` is a SQL EXPRESSION so a case can pass null,
 * a literal timestamp, or a sub-select against the row itself.
 */
function saveHandover({
  ledger = L,
  booking,
  odometer = null,
  fuel = null,
  parking = null,
  keyLocation = null,
  conditionOk = null,
  conditionNote = null,
  noteToNext = null,
  keysConfirmed = false,
  eventTitle = null,
  eventBody = null,
  token = "null",
  actor = "bo@test.dk",
} = {}) {
  return sqlstateOf(
    actor,
    `perform public.upsert_booking_handover(
       ${sqlLit(ledger)}, ${sqlLit(booking)}::uuid,
       ${odometer === null ? "null" : odometer},
       ${fuel === null ? "null" : fuel},
       ${sqlLit(parking)}, ${sqlLit(keyLocation)},
       ${conditionOk === null ? "null" : conditionOk},
       ${sqlLit(conditionNote)}, ${sqlLit(noteToNext)},
       ${keysConfirmed},
       ${sqlLit(eventTitle)}, ${sqlLit(eventBody)},
       ${token});`,
  );
}

function saveMessage(opts) {
  const actor = opts.actor ?? "bo@test.dk";
  return messageOf(
    actor,
    `perform public.upsert_booking_handover(
       ${sqlLit(opts.ledger ?? L)}, ${sqlLit(opts.booking)}::uuid,
       ${opts.odometer === undefined || opts.odometer === null ? "null" : opts.odometer},
       ${opts.fuel === undefined || opts.fuel === null ? "null" : opts.fuel},
       ${sqlLit(opts.parking ?? null)}, ${sqlLit(opts.keyLocation ?? null)},
       null, ${sqlLit(opts.conditionNote ?? null)}, ${sqlLit(opts.noteToNext ?? null)},
       false, null, null, ${opts.token ?? "null"});`,
  );
}

const handoverCount = (booking) =>
  Number(scalar(`select count(*) from public.booking_handovers where booking_id = '${booking}';`));

const readColumn = (booking, column) =>
  scalar(
    `select coalesce(${column}::text, 'NULL') from public.booking_handovers where booking_id = '${booking}';`,
  );

/** The row's live updated_at, as a SQL expression usable as a token. */
const liveToken = (booking) =>
  `(select bh.updated_at from public.booking_handovers bh where bh.booking_id = '${booking}')`;

/** The WHOLE row as jsonb text — the only honest way to assert "nothing changed". */
const rowSnapshot = (booking) =>
  scalar(`select to_jsonb(t)::text from public.booking_handovers t where booking_id = '${booking}';`);

const eventCount = (type = "handover_created") =>
  Number(scalar(`select count(*) from public.ledger_events where ledger_id = '${L}' and event_type = '${type}';`));

process.stdout.write("\nVehicle handover (real Postgres, consolidated schema):\n");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SHAPE — asserted against the catalog, not the SQL text
// ═══════════════════════════════════════════════════════════════════════════════

pin("RLS is ENABLED on booking_handovers", () => {
  assert.equal(
    scalar("select relrowsecurity from pg_class where oid = 'public.booking_handovers'::regclass;"),
    "t",
    "without RLS every authenticated user reads every workspace's parking locations",
  );
});

pin("the ONLY policy is a SELECT policy — no client write policy exists", () => {
  const rows = scalar(
    `select string_agg(cmd || ':' || policyname, '|' order by policyname)
       from pg_policies where schemaname = 'public' and tablename = 'booking_handovers';`,
  );
  assert.equal(
    rows,
    "SELECT:Ledger members can read booking handovers",
    "a write policy would route around upsert_booking_handover and its identity gate entirely",
  );
});

pin("the SELECT policy is gated on is_ledger_member, not on `true`", () => {
  const qual = scalar(
    `select qual from pg_policies where tablename = 'booking_handovers'
       and policyname = 'Ledger members can read booking handovers';`,
  );
  assert.match(qual, /is_ledger_member\(ledger_id\)/, "the workspace boundary must be in the policy itself");
});

pin("authenticated may SELECT but may NOT insert, update or delete the table", () => {
  const grants = ["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) =>
    scalar(`select has_table_privilege('authenticated', 'public.booking_handovers', '${p}');`),
  );
  assert.deepEqual(grants, ["t", "f", "f", "f"], "reads for members, writes only through the RPC");
});

pin("anon has no privilege on the table at all", () => {
  const grants = ["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) =>
    scalar(`select has_table_privilege('anon', 'public.booking_handovers', '${p}');`),
  );
  assert.deepEqual(grants, ["f", "f", "f", "f"]);
});

pin("booking_id carries a UNIQUE constraint — one handover per booking", () => {
  const uniq = scalar(
    `select count(*) from pg_constraint c
       where c.conrelid = 'public.booking_handovers'::regclass
         and c.contype = 'u'
         and (select array_agg(a.attname::text order by a.attname)
                from unnest(c.conkey) k join pg_attribute a
                  on a.attrelid = c.conrelid and a.attnum = k) = array['booking_id'];`,
  );
  assert.equal(uniq, "1", "without it a retried save stacks a second, contradictory handover");
});

pin("both workspace-scoped FKs cascade, so a workspace purge takes the handovers with it", () => {
  const fks = scalar(
    `select string_agg(a.attname::text || ':' || c.confdeltype::text, ',' order by a.attname)
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid = 'public.booking_handovers'::regclass and c.contype = 'f';`,
  );
  assert.equal(
    fks,
    "author_member_id:c,booking_id:c,ledger_id:c",
    "retention is the workspace's lifetime and the cascade is what enforces it (GDPR)",
  );
});

pin("the four text fields and the two numeric ones carry their check constraints", () => {
  const checks = scalar(
    `select string_agg(pg_get_constraintdef(oid), ' || ' order by conname)
       from pg_constraint where conrelid = 'public.booking_handovers'::regclass and contype = 'c';`,
  );
  for (const fragment of [
    "end_odometer >= 0",
    "fuel_fraction >= (0)",
    "fuel_fraction <= (1)",
    "char_length(parking_location) <= 200",
    "char_length(key_location) <= 200",
    "char_length(condition_note) <= 500",
    "char_length(note_to_next) <= 500",
  ]) {
    assert.ok(
      checks.includes(fragment),
      `the table itself must still enforce "${fragment}" — the RPC's Danish sentence is the ` +
        "polite half, the constraint is the half a direct write cannot talk its way past",
    );
  }
});

pin("keys_confirmed is NOT NULL and defaults to false", () => {
  const row = scalar(
    `select attnotnull::text || '/' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'NONE')
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.booking_handovers'::regclass and a.attname = 'keys_confirmed';`,
  );
  assert.equal(row, "true/false", '"not confirmed" and "explicitly not returned" are the same thing');
});

pin("there is NO coordinate column — parking is free text by design (GDPR)", () => {
  const cols = scalar(
    `select string_agg(attname, ',' order by attname) from pg_attribute
      where attrelid = 'public.booking_handovers'::regclass and attnum > 0 and not attisdropped;`,
  );
  for (const banned of ["lat", "lng", "longitude", "latitude", "geo", "coord", "point"]) {
    assert.doesNotMatch(
      cols,
      new RegExp(`(^|,)[a-z_]*${banned}[a-z_]*(,|$)`),
      `data minimisation: a shared car's parking spot is free text, never geodata (migrations 151, 062/071 ` +
        `dropped coordinates twice; adding "${banned}" back needs its own decision)`,
    );
  }
});

pin("the RPC is security definer with a pinned search_path", () => {
  const row = scalar(
    `select p.prosecdef::text || '/' || coalesce(array_to_string(p.proconfig, ','), 'NONE')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'upsert_booking_handover';`,
  );
  assert.equal(row, "true/search_path=public");
});

pin("expected_updated_at is the LAST parameter, after the event params", () => {
  const args = scalar(
    `select pg_get_function_arguments(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'upsert_booking_handover';`,
  );
  assert.match(
    args,
    /event_title text DEFAULT NULL::text, event_body text DEFAULT NULL::text, expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone$/,
    "migration 160's placement: every positional caller stays unshifted",
  );
});

pin("exactly ONE overload of the RPC exists", () => {
  assert.equal(
    scalar(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'upsert_booking_handover';`,
    ),
    "1",
    "two candidate signatures with defaulted params is PGRST203 — PostgREST cannot resolve between them",
  );
});

pin("authenticated may EXECUTE the RPC; anon may not (migration 148 convention)", () => {
  const fn =
    "public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, text, text, timestamptz)";
  assert.equal(scalar(`select has_function_privilege('authenticated', '${fn}', 'EXECUTE');`), "t");
  assert.equal(scalar(`select has_function_privilege('anon', '${fn}', 'EXECUTE');`), "f");
});

pin("the GDPR comments on the table and on parking_location are present", () => {
  const table = scalar("select obj_description('public.booking_handovers'::regclass, 'pg_class');");
  assert.match(table, /GDPR/, "the register-level honesty lives in the catalog, not only in the migration file");
  assert.match(table, /FREE TEXT/);
  const col = scalar(
    `select col_description('public.booking_handovers'::regclass,
       (select attnum from pg_attribute where attrelid = 'public.booking_handovers'::regclass
          and attname = 'parking_location'));`,
  );
  assert.match(col, /personal-adjacent/);
  assert.match(col, /never coordinates/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. WHO MAY WRITE
// ═══════════════════════════════════════════════════════════════════════════════

pin("the booking's own member creates the handover, and it is theirs", () => {
  assert.equal(
    saveHandover({
      booking: BOOKING(1),
      odometer: 82345,
      fuel: 0.75,
      parking: "P-kælder niveau 2, plads 14",
      keyLocation: "Nøgler i postkassen hos Lars",
      conditionOk: true,
      noteToNext: "Ruden på højre side dugger",
      keysConfirmed: true,
      actor: "bo@test.dk",
    }),
    "OK",
  );
  assert.equal(handoverCount(BOOKING(1)), 1);
  assert.equal(readColumn(BOOKING(1), "author_member_id"), BO);
  assert.equal(readColumn(BOOKING(1), "parking_location"), "P-kælder niveau 2, plads 14");
  assert.equal(readColumn(BOOKING(1), "keys_confirmed"), "true");
});

pin("a member who is neither the booking's member, the trip's driver nor an admin is refused", () => {
  // Cille is a perfectly ordinary, active member of the same workspace. She may READ
  // this handover; she may not author it.
  assert.equal(saveHandover({ booking: BOOKING(2), parking: "Cilles gæt", actor: "cille@test.dk" }), "42501");
  assert.equal(handoverCount(BOOKING(2)), 0, "a refused write must leave no row behind");
});

pin("a workspace admin may write a handover for somebody else's booking", () => {
  assert.equal(saveHandover({ booking: BOOKING(2), parking: "Annas rettelse", actor: "anna@test.dk" }), "OK");
  assert.equal(readColumn(BOOKING(2), "author_member_id"), ANNA);
});

pin("a member of ANOTHER workspace cannot write into this one", () => {
  assert.equal(saveHandover({ booking: BOOKING(3), parking: "Eriks fusk", actor: "erik@test.dk" }), "42501");
  assert.equal(handoverCount(BOOKING(3)), 0);
});

pin("an unknown caller (no matching member row) cannot write", () => {
  assert.equal(saveHandover({ booking: BOOKING(3), parking: "ukendt", actor: "nobody@test.dk" }), "42501");
  assert.equal(handoverCount(BOOKING(3)), 0);
});

pin("a booking from another workspace cannot be handed over through this ledger id", () => {
  // Anna is an admin here, so the ONLY thing that can refuse this is the
  // booking-belongs-to-the-ledger check.
  assert.equal(
    saveHandover({ booking: "40000000-0000-0000-0000-000000000001", parking: "x", actor: "anna@test.dk" }),
    "22023",
  );
  assert.equal(handoverCount("40000000-0000-0000-0000-000000000001"), 0);
});

pin("the trip-driver branch: after the booking is REASSIGNED, the person who drove can still write", () => {
  // This is the only sequence in which the branch is reachable, and asserting it any
  // other way would be asserting nothing: migration 123's enforce_trip_booking_scope
  // trigger forces a linked trip's driver to EQUAL the booking's member, so a
  // freshly-linked trip's driver is already covered by the first branch. Nothing
  // re-validates that equality when car_bookings.member_id is later reassigned
  // (GV-253 allows it), and this is the person who actually parked the car.
  raw(`insert into public.trips (id, ledger_id, period_id, booking_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id)
       values ('50000000-0000-0000-0000-000000000001', '${L}', '${PERIOD}', '${BOOKING(4)}', '${BO}',
               current_date, 1000, 1100, '${BO}');`);
  // Now the booking is reassigned to Cille. Bo drove it; Cille owns the booking.
  // Done as the schema owner rather than through upsert_car_booking, because the point
  // is the resulting STATE, not the reassignment RPC's own GV-253 gate.
  raw(`update public.car_bookings set member_id = '${CILLE}' where id = '${BOOKING(4)}';`);
  assert.equal(
    scalar(`select member_id::text from public.car_bookings where id = '${BOOKING(4)}';`),
    CILLE,
    "the reassignment must really have happened, or this case proves nothing",
  );
  assert.equal(
    saveHandover({ booking: BOOKING(4), parking: "Bo parkerede den på Nørre Allé", actor: "bo@test.dk" }),
    "OK",
    "the driver of the linked trip must keep the right to say where they left the car",
  );
  assert.equal(readColumn(BOOKING(4), "author_member_id"), BO);
  // And it is the LINK that grants it, not membership: Cille is still refused on a
  // different booking she has no relationship to.
  assert.equal(saveHandover({ booking: BOOKING(5), parking: "nej", actor: "cille@test.dk" }), "42501");
});

pin("a SOFT-DELETED linked trip grants nothing", () => {
  raw(`insert into public.trips (id, ledger_id, period_id, booking_id, driver_member_id, trip_date, start_km, end_km, created_by_member_id, deleted_at)
       values ('50000000-0000-0000-0000-000000000002', '${L}', '${PERIOD}', '${BOOKING(6)}', '${CILLE}',
               current_date, 1000, 1100, '${CILLE}', now());`);
  assert.equal(
    saveHandover({ booking: BOOKING(6), parking: "slettet tur", actor: "cille@test.dk" }),
    "42501",
    "the query matches migration 123's partial unique index: deleted_at is null",
  );
  assert.equal(handoverCount(BOOKING(6)), 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ONE HANDOVER PER BOOKING — a second save EDITS
// ═══════════════════════════════════════════════════════════════════════════════

pin("a second save UPDATES the same row rather than inserting a duplicate", () => {
  const id = readColumn(BOOKING(1), "id");
  assert.equal(
    saveHandover({ booking: BOOKING(1), parking: "P-kælder niveau 3, plads 7", actor: "bo@test.dk" }),
    "OK",
  );
  assert.equal(handoverCount(BOOKING(1)), 1, "the unique key is what makes a correction a correction");
  assert.equal(readColumn(BOOKING(1), "id"), id, "and it must be the SAME row, not a replacement");
  assert.equal(readColumn(BOOKING(1), "parking_location"), "P-kælder niveau 3, plads 7");
});

pin("an update REPLACES omitted fields rather than coalescing them", () => {
  // The client posts the whole sheet. A coalescing update could never CLEAR a wrong
  // parking spot or an obsolete note, which is the correction people actually make.
  assert.equal(readColumn(BOOKING(1), "note_to_next"), "NULL", "the second save above sent no note");
  assert.equal(readColumn(BOOKING(1), "end_odometer"), "NULL");
  assert.equal(readColumn(BOOKING(1), "keys_confirmed"), "false");
});

pin("created_at survives an edit; updated_at moves", () => {
  const before = scalar(
    `select created_at::text || '|' || updated_at::text from public.booking_handovers where booking_id = '${BOOKING(1)}';`,
  );
  const [createdBefore, updatedBefore] = before.split("|");
  assert.equal(saveHandover({ booking: BOOKING(1), parking: "igen", actor: "bo@test.dk" }), "OK");
  const after = scalar(
    `select created_at::text || '|' || updated_at::text from public.booking_handovers where booking_id = '${BOOKING(1)}';`,
  );
  const [createdAfter, updatedAfter] = after.split("|");
  assert.equal(createdAfter, createdBefore, "created_at is when the car was handed over");
  assert.notEqual(updatedAfter, updatedBefore, "updated_at is the GV-421 token and MUST move on every write");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. VALIDATION — the Danish sentences, and the bounds
// ═══════════════════════════════════════════════════════════════════════════════

pin("fuel_fraction is accepted at exactly 0 and exactly 1", () => {
  assert.equal(saveHandover({ booking: BOOKING(7), fuel: 0, actor: "anna@test.dk" }), "OK");
  assert.equal(readColumn(BOOKING(7), "fuel_fraction"), "0");
  assert.equal(saveHandover({ booking: BOOKING(7), fuel: 1, actor: "anna@test.dk" }), "OK");
  assert.equal(readColumn(BOOKING(7), "fuel_fraction"), "1");
});

pin("fuel_fraction is refused just outside both bounds, with the Danish sentence", () => {
  for (const bad of ["-0.01", "1.01", "75"]) {
    assert.equal(
      saveHandover({ booking: BOOKING(8), fuel: bad, actor: "anna@test.dk" }),
      "22023",
      `${bad} is not a fraction — 75 is the percentage mistake this exists to catch`,
    );
  }
  assert.equal(
    saveMessage({ booking: BOOKING(8), fuel: "1.5", actor: "anna@test.dk" }),
    "Brændstofniveauet skal være mellem 0 og 1.",
  );
  assert.equal(handoverCount(BOOKING(8)), 0);
});

pin("a negative odometer is refused with the Danish sentence; 0 is allowed", () => {
  assert.equal(saveHandover({ booking: BOOKING(8), odometer: -1, actor: "anna@test.dk" }), "22023");
  assert.equal(
    saveMessage({ booking: BOOKING(8), odometer: -1, actor: "anna@test.dk" }),
    "Kilometerstanden kan ikke være negativ.",
  );
  assert.equal(saveHandover({ booking: BOOKING(8), odometer: 0, actor: "anna@test.dk" }), "OK");
  raw(`delete from public.booking_handovers where booking_id = '${BOOKING(8)}';`);
});

pin("the two location fields accept 200 chars and refuse 201, each with its own sentence", () => {
  const at = (n) => "x".repeat(n);
  assert.equal(saveHandover({ booking: BOOKING(8), parking: at(200), actor: "anna@test.dk" }), "OK");
  assert.equal(saveHandover({ booking: BOOKING(8), parking: at(201), actor: "anna@test.dk" }), "22023");
  assert.equal(
    saveMessage({ booking: BOOKING(8), parking: at(201), actor: "anna@test.dk" }),
    "Parkeringsstedet må højst være 200 tegn.",
  );
  assert.equal(saveHandover({ booking: BOOKING(8), keyLocation: at(200), actor: "anna@test.dk" }), "OK");
  assert.equal(saveHandover({ booking: BOOKING(8), keyLocation: at(201), actor: "anna@test.dk" }), "22023");
  assert.equal(
    saveMessage({ booking: BOOKING(8), keyLocation: at(201), actor: "anna@test.dk" }),
    "Nøglernes placering må højst være 200 tegn.",
  );
});

pin("the two note fields accept 500 chars and refuse 501, each with its own sentence", () => {
  const at = (n) => "y".repeat(n);
  assert.equal(saveHandover({ booking: BOOKING(8), conditionNote: at(500), actor: "anna@test.dk" }), "OK");
  assert.equal(saveHandover({ booking: BOOKING(8), conditionNote: at(501), actor: "anna@test.dk" }), "22023");
  assert.equal(
    saveMessage({ booking: BOOKING(8), conditionNote: at(501), actor: "anna@test.dk" }),
    "Bemærkningen om bilens stand må højst være 500 tegn.",
  );
  assert.equal(saveHandover({ booking: BOOKING(8), noteToNext: at(500), actor: "anna@test.dk" }), "OK");
  assert.equal(saveHandover({ booking: BOOKING(8), noteToNext: at(501), actor: "anna@test.dk" }), "22023");
  assert.equal(
    saveMessage({ booking: BOOKING(8), noteToNext: at(501), actor: "anna@test.dk" }),
    "Beskeden til den næste fører må højst være 500 tegn.",
  );
  raw(`delete from public.booking_handovers where booking_id = '${BOOKING(8)}';`);
});

pin("whitespace-only text becomes NULL rather than a blank string", () => {
  assert.equal(saveHandover({ booking: BOOKING(8), parking: "   ", noteToNext: "  ", actor: "anna@test.dk" }), "OK");
  assert.equal(readColumn(BOOKING(8), "parking_location"), "NULL");
  assert.equal(readColumn(BOOKING(8), "note_to_next"), "NULL");
  raw(`delete from public.booking_handovers where booking_id = '${BOOKING(8)}';`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. GV42O — the optimistic-concurrency precondition (GV-421 semantics)
// ═══════════════════════════════════════════════════════════════════════════════

pin("a null token is still last-write-wins — byte for byte the pre-token behaviour", () => {
  assert.equal(saveHandover({ booking: BOOKING(5), parking: "først", actor: "bo@test.dk" }), "OK");
  const stale = scalar(`select ${liveToken(BOOKING(5))}::text;`);
  assert.equal(saveHandover({ booking: BOOKING(5), parking: "en anden", actor: "anna@test.dk" }), "OK");
  assert.notEqual(scalar(`select ${liveToken(BOOKING(5))}::text;`), stale, "the row must really have moved");
  assert.equal(saveHandover({ booking: BOOKING(5), parking: "gammel klient", actor: "bo@test.dk" }), "OK");
  assert.equal(readColumn(BOOKING(5), "parking_location"), "gammel klient", "null means no precondition");
});

pin("a token on a CREATE is IGNORED and the insert proceeds", () => {
  assert.equal(
    saveHandover({
      booking: BOOKING(3),
      parking: "oprettet",
      actor: "bo@test.dk",
      token: "timestamptz '2020-01-01 00:00:00+00'",
    }),
    "OK",
    "a create cannot conflict; refusing here would lose the only copy over a client bug",
  );
  assert.equal(handoverCount(BOOKING(3)), 1);
});

pin("a FRESH token gets out of the way and the edit lands", () => {
  assert.equal(
    saveHandover({ booking: BOOKING(3), parking: "opdateret", actor: "bo@test.dk", token: liveToken(BOOKING(3)) }),
    "OK",
  );
  assert.equal(readColumn(BOOKING(3), "parking_location"), "opdateret");
});

pin(`a STALE token raises ${CONFLICT} and leaves the row byte-identical`, () => {
  const stale = scalar(`select ${liveToken(BOOKING(3))}::text;`);
  // Somebody else saves. That is what makes the first caller's token stale.
  assert.equal(saveHandover({ booking: BOOKING(3), parking: "en andens", actor: "anna@test.dk" }), "OK");
  const before = rowSnapshot(BOOKING(3));
  const eventsBefore = eventCount();
  assert.equal(
    saveHandover({
      booking: BOOKING(3),
      parking: "min overskrivning",
      keyLocation: "og nøglerne",
      odometer: 999999,
      actor: "bo@test.dk",
      token: `timestamptz '${stale}'`,
    }),
    CONFLICT,
  );
  assert.equal(rowSnapshot(BOOKING(3)), before, "NOTHING may be written — not one column");
  assert.equal(eventCount(), eventsBefore, "a conflict is a write that did NOT happen; the feed hears nothing");
});

pin("the conflict message is the Danish sentence that says the changes were NOT saved", () => {
  const stale = scalar(`select ${liveToken(BOOKING(3))}::text;`);
  assert.equal(saveHandover({ booking: BOOKING(3), parking: "flytter igen", actor: "anna@test.dk" }), "OK");
  assert.equal(
    saveMessage({ booking: BOOKING(3), parking: "for sent", actor: "bo@test.dk", token: `timestamptz '${stale}'` }),
    "En anden har ændret overdragelsen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.",
  );
});

pin("the guard sits AFTER the permission gates — an outsider learns 42501, never GV42O", () => {
  // If the precondition were checked first, a stranger holding any timestamp could
  // probe whether a row exists and when it last moved. Cille is refused on identity,
  // with a stale token in hand.
  assert.equal(
    saveHandover({
      booking: BOOKING(3),
      parking: "cille prøver",
      actor: "cille@test.dk",
      token: "timestamptz '2020-01-01 00:00:00+00'",
    }),
    "42501",
  );
});

pin("microsecond-only differences are ACCEPTED; a whole millisecond is REFUSED", () => {
  // Migration 160's rule, restated for this entity: a token that has passed through a
  // JavaScript Date has lost its microseconds, and a microsecond-exact comparison
  // would refuse every edit forever while blaming a member who did nothing.
  raw(
    `update public.booking_handovers set updated_at = timestamptz '2026-08-01 09:00:00.123456+00'
      where booking_id = '${BOOKING(3)}';`,
  );
  assert.equal(
    saveHandover({
      booking: BOOKING(3),
      parking: "mikrosekund",
      actor: "bo@test.dk",
      token: "timestamptz '2026-08-01 09:00:00.123999+00'",
    }),
    "OK",
    "same millisecond → the same version",
  );
  raw(
    `update public.booking_handovers set updated_at = timestamptz '2026-08-01 09:00:00.123456+00'
      where booking_id = '${BOOKING(3)}';`,
  );
  assert.equal(
    saveHandover({
      booking: BOOKING(3),
      parking: "millisekund",
      actor: "bo@test.dk",
      token: "timestamptz '2026-08-01 09:00:00.124456+00'",
    }),
    CONFLICT,
    "one millisecond apart is a different version",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. THE FEED EVENT — once, on create, never on an edit
// ═══════════════════════════════════════════════════════════════════════════════

pin("handover_created is written ONCE on create, with the booking and handover ids", () => {
  raw(`delete from public.ledger_events where ledger_id = '${L}';`);
  raw(`delete from public.booking_handovers where booking_id = '${BOOKING(7)}';`);
  assert.equal(
    saveHandover({
      booking: BOOKING(7),
      parking: "Nørre Allé 12",
      actor: "bo@test.dk",
      eventTitle: "Bo har afleveret bilen",
      eventBody: "Parkeret på Nørre Allé",
    }),
    "OK",
  );
  assert.equal(eventCount(), 1);
  const meta = scalar(
    `select metadata::text from public.ledger_events where ledger_id = '${L}' and event_type = 'handover_created';`,
  );
  const handoverId = readColumn(BOOKING(7), "id");
  assert.match(meta, new RegExp(BOOKING(7)));
  assert.match(meta, new RegExp(handoverId));
  assert.equal(
    scalar(
      `select actor_member_id::text from public.ledger_events where ledger_id = '${L}' and event_type = 'handover_created';`,
    ),
    BO,
    "the actor is resolved from the caller, never trusted from a param",
  );
  assert.equal(
    scalar(
      `select actor_email from public.ledger_events where ledger_id = '${L}' and event_type = 'handover_created';`,
    ),
    "bo@test.dk",
  );
});

pin("an EDIT writes NO second event, even with an event_title", () => {
  assert.equal(
    saveHandover({
      booking: BOOKING(7),
      parking: "Nørre Allé 14",
      actor: "bo@test.dk",
      eventTitle: "Bo rettede parkeringen",
      eventBody: "Nummer 14, ikke 12",
    }),
    "OK",
  );
  assert.equal(
    eventCount(),
    1,
    "three corrections to a parking spot must not become three notifications for the whole group",
  );
});

pin("no event_type other than handover_created is written by this RPC", () => {
  const types = scalar(
    `select coalesce(string_agg(distinct event_type, ','), 'NONE') from public.ledger_events where ledger_id = '${L}';`,
  );
  assert.equal(types, "handover_created");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. THE RETURN VALUE — the client needs the new token back
// ═══════════════════════════════════════════════════════════════════════════════

pin("the RPC returns handover_id, created and the row's new updated_at", () => {
  raw(`delete from public.booking_handovers where booking_id = '${BOOKING(6)}';`);
  raw(`update public.car_bookings set member_id = '${BO}' where id = '${BOOKING(6)}';`);
  const created = scalar(
    `select set_config('request.jwt.claims', '{"email":"bo@test.dk","role":"authenticated"}', false);
     select public.upsert_booking_handover('${L}', '${BOOKING(6)}'::uuid, null, null, 'et sted',
       null, null, null, null, false, null, null, null)::text;`,
  )
    .split("\n")
    .pop()
    .trim();
  assert.match(created, /"created": true/);
  assert.match(created, new RegExp(`"booking_id": "${BOOKING(6)}"`));
  const updatedAt = JSON.parse(created).updated_at;
  assert.equal(
    scalar(`select (updated_at = timestamptz '${updatedAt}')::text from public.booking_handovers where booking_id = '${BOOKING(6)}';`),
    "true",
    "the returned updated_at IS the row's — the client holds it as its next GV42O token",
  );
  const edited = scalar(
    `select set_config('request.jwt.claims', '{"email":"bo@test.dk","role":"authenticated"}', false);
     select public.upsert_booking_handover('${L}', '${BOOKING(6)}'::uuid, null, null, 'et andet sted',
       null, null, null, null, false, null, null, timestamptz '${updatedAt}')::text;`,
  )
    .split("\n")
    .pop()
    .trim();
  assert.match(edited, /"created": false/, "the second call must report itself as an update");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. THE MIRROR ONTO THE WORKSPACE ROW (GVM-520, migration 167)
// ═══════════════════════════════════════════════════════════════════════════════
// Migration 167 put the car's CURRENT parking and key placement on ledgers, and made
// this RPC mirror into it. The mirror is NULL-PRESERVING per field, which is the one
// property in this file a mutation could break while looking completely ordinary in a
// diff: `set parking_location = v_parking` instead of `coalesce(v_parking,
// l.parking_location)` reads as a simplification, passes every other test here, and
// wipes the group's only record of where their car is on every partial handover — the
// precise failure the handover was built to prevent.

/** The workspace's current location columns, as one string. */
const ledgerLocation = () =>
  scalar(
    `select coalesce(parking_location, 'NULL') || ' / ' || coalesce(key_location, 'NULL')
       from public.ledgers where id = '${L}';`,
  );
const ledgerLocationAuthor = () =>
  scalar(`select coalesce(location_updated_by_member_id::text, 'NULL') from public.ledgers where id = '${L}';`);
const ledgerLocationStamp = () =>
  scalar(`select coalesce(location_updated_at::text, 'NULL') from public.ledgers where id = '${L}';`);

pin("the workspace's location columns are free text with a 200-char check and NO coordinate column", () => {
  const columns = scalar(
    `select string_agg(column_name || ':' || data_type, '|' order by column_name)
       from information_schema.columns
      where table_schema = 'public' and table_name = 'ledgers'
        and column_name in ('parking_location', 'key_location', 'location_updated_by_member_id', 'location_updated_at');`,
  );
  assert.equal(
    columns,
    "key_location:text|location_updated_at:timestamp with time zone|location_updated_by_member_id:uuid|parking_location:text",
    "all four GVM-520 columns must exist, and the two locations must be TEXT",
  );
  const geo = scalar(
    `select coalesce(string_agg(column_name, ','), 'none')
       from information_schema.columns
      where table_schema = 'public' and table_name = 'ledgers'
        and (column_name like '%latitude%' or column_name like '%longitude%'
             or column_name like '%_lat' or column_name like '%_lng'
             or column_name like 'location_coord%');`,
  );
  assert.equal(geo, "none", "a coordinate column would reverse the GDPR posture 151 and 062/071 established");
  const checks = scalar(
    `select string_agg(conname, '|' order by conname)
       from pg_constraint
      where conrelid = 'public.ledgers'::regclass and contype = 'c'
        and conname in ('ledgers_parking_location_check', 'ledgers_key_location_check');`,
  );
  assert.equal(
    checks,
    "ledgers_key_location_check|ledgers_parking_location_check",
    "the 200-char cap must live in the table as well as in the two RPCs",
  );
  assert.equal(
    scalar(
      `select conname || ':' || confdeltype::text from pg_constraint
        where conrelid = 'public.ledgers'::regclass and contype = 'f'
          and conname = 'ledgers_location_updated_by_member_id_fkey';`,
    ),
    "ledgers_location_updated_by_member_id_fkey:n",
    "on delete SET NULL — losing an attribution must never take the car's location with it",
  );
});

pin("a handover carrying both locations mirrors them onto the workspace, with its author and a stamp", () => {
  raw(
    `update public.ledgers set parking_location = null, key_location = null,
        location_updated_by_member_id = null, location_updated_at = null where id = '${L}';`,
  );
  assert.equal(
    saveHandover({
      booking: BOOKING(8),
      parking: "P-kælder niveau 2, plads 14",
      keyLocation: "Nøgler i postkassen hos Lars",
      actor: "bo@test.dk",
    }),
    "OK",
  );
  assert.equal(ledgerLocation(), "P-kælder niveau 2, plads 14 / Nøgler i postkassen hos Lars");
  assert.equal(ledgerLocationAuthor(), BO, "the mirror stamps whoever authored the handover");
  assert.notEqual(ledgerLocationStamp(), "NULL", "a mirrored location without a time is not believable");
});

pin("a handover that mentions NEITHER location leaves the workspace's location AND its stamp alone", () => {
  raw(
    `update public.ledgers set parking_location = 'Gaden foran nr. 14',
        key_location = 'Nøgler hos Anna', location_updated_by_member_id = '${ANNA}',
        location_updated_at = now() - interval '2 days' where id = '${L}';`,
  );
  const stampBefore = ledgerLocationStamp();

  assert.equal(
    saveHandover({ booking: BOOKING(9), odometer: 82345, keysConfirmed: true, actor: "bo@test.dk" }),
    "OK",
  );
  assert.equal(handoverCount(BOOKING(9)), 1, "the handover itself must still be saved");
  assert.equal(readColumn(BOOKING(9), "parking_location"), "NULL", "and its OWN column is null, as it always was");

  assert.equal(
    ledgerLocation(),
    "Gaden foran nr. 14 / Nøgler hos Anna",
    "a skipped field on somebody's handover is not evidence that nobody knows where the car is",
  );
  assert.equal(ledgerLocationAuthor(), ANNA, "nothing mirrored, so the attribution must not move either");
  assert.equal(ledgerLocationStamp(), stampBefore, "and a two-day-old spot must not look freshly confirmed");
});

pin("the mirror is PER FIELD: parking follows, the omitted key location stays", () => {
  assert.equal(
    saveHandover({ booking: BOOKING(9), parking: "Flyttet til P-huset", actor: "bo@test.dk" }),
    "OK",
    "this is an EDIT of the handover written above — the mirror runs on edits too, unlike the feed event",
  );
  assert.equal(
    ledgerLocation(),
    "Flyttet til P-huset / Nøgler hos Anna",
    "one field mirroring must not drag the other one along, in either direction",
  );
  assert.equal(ledgerLocationAuthor(), BO, "a mirror that DID write something re-stamps its author");
});

pin("clearing a parking spot on the handover does not clear the workspace's", () => {
  assert.equal(
    saveHandover({ booking: BOOKING(9), keyLocation: "Nøgler hos Bo", actor: "bo@test.dk" }),
    "OK",
  );
  assert.equal(readColumn(BOOKING(9), "parking_location"), "NULL", "the handover row IS a full replace");
  assert.equal(
    ledgerLocation(),
    "Flyttet til P-huset / Nøgler hos Bo",
    "but the workspace keeps the last spot anybody actually named — clearing it is set_vehicle_location's job",
  );
});

removeContainer(CONTAINER);

process.stdout.write(
  `\nok - booking handover contract: ${checked} checks. RLS is on with a members-only SELECT policy and NO ` +
    `client write policy; booking_id is UNIQUE so a second save EDITS the one handover; the writer must be the ` +
    `booking's member, the driver of the trip migration 123 linked to it (reachable only after the booking is ` +
    `reassigned), or an admin — everyone else is 42501 and nothing is written; the table has no coordinate ` +
    `column and both workspace FKs cascade; lengths and the 0..1 fuel fraction are enforced in the table AND ` +
    `answered in Danish by the RPC; a stale token raises ${CONFLICT} after the permission gates, leaving the row ` +
    `byte-identical and the feed silent, while microsecond-only drift is accepted; handover_created is written ` +
    `once on create and never on an edit; and the GVM-520 mirror onto ledgers is NULL-PRESERVING per field, so a ` +
    `handover that mentions no parking leaves the car's known spot, its author and its stamp exactly as they were.\n`,
);

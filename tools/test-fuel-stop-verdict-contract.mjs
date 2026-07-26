// Anti-drift contract test for the pre-departure fuel-stop verdict (GV-405).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 154 deliberately does NOT port govehlo-mobile's tank model to PL/pgSQL —
// the client stamps its output and the server does the last ~20 lines of arithmetic.
// But those 20 lines now exist TWICE: once in
// govehlo-mobile/src/lib/fuel-stop-revalidation.ts (+ refuel-plan.ts) and once in
// public.fuel_stop_revalidation_verdict. Two copies of a safety decision with nothing
// holding them together is how they silently diverge, and the divergence is invisible:
// both sides keep returning a plausible verdict, just a different one, and the only
// symptom is a push that fires when it shouldn't or stays quiet when it should.
//
// So this replays the EXACT scenarios of
// govehlo-mobile/src/lib/__tests__/fuel-stop-revalidation.test.ts against the SQL and
// asserts identical outcomes — verdict, reserveKm and storedStopKm, not just the
// verdict. The expectations below are transcribed from that vitest file; when it
// changes, this must change with it, and vice versa. It also covers the two things the
// vitest suite cannot: the tur/retur invariant (a `returnTrip` flag must change
// NOTHING, because distanceKm is already the doubled effective distance) and the
// end-to-end due-ness contract of claim_due_booking_fuel_reminders, including the
// fail-closed stale-stamp gate.
//
// ── Docker ──────────────────────────────────────────────────────────────────────
// Real arithmetic needs a real Postgres — a regex over the SQL would pass a mutation
// that changes the answer. Docker-free machines get a loud warning and a pass, the same
// contract check-hotpath-mirror.mjs uses for an absent sibling repo, so `npm run
// validate` stays dependency-free. CI runs it with --strict (see the functional-smoke
// job in .github/workflows/validate.yml), where a skip is a failure.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const strict = process.argv.includes("--strict");
const CONTAINER = `govehlo-fuel-stop-verdict-${process.pid}`;
const DB = "verdict";

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  const message =
    "fuel-stop verdict contract: Docker is unavailable, so the SQL could not be executed. " +
    "The mobile TypeScript and the SQL in migration 154 were NOT compared on this run.";
  if (strict) {
    console.error(`❌ ${message} (--strict)`);
    process.exit(1);
  }
  console.warn(`⚠️  ${message} CI runs this with --strict.`);
  process.exit(0);
}

// ── Scenarios, transcribed from the mobile vitest suite ─────────────────────────
// Fixed car geometry, copied from the vitest header so the numbers stay legible:
//   consumption 5 L/100km, tank 150 L → reserve = 10% × 150 / 5 × 100 = 300 km.
//   currentRange = litersNow / 5 × 100; crossing = currentRange − 300.
//   With litersNow 20 (currentRange 400) → crossing = 100 km into the trip.
const CAR = { consumption: 5, spread: 0, capacity: 150 };

const storedStop = (over = {}) => ({
  needsFuel: true,
  kmUntilRefuel: 200,
  distanceKm: 400,
  station: { brand: "Circle K", lat: 55.5, lng: 11.0, kmIn: 200, pricePerLiter: 13.5 },
  ...over,
});

const scenarios = [
  // ── verdicts ──────────────────────────────────────────────────────────────────
  {
    name: "moves the stop earlier when the reserve is now crossed well before it",
    fuelStop: storedStop(),
    litersNow: 20,
    expect: { verdict: "move-earlier", reserveKm: 100, storedStopKm: 200 },
  },
  {
    name: "holds when the drift is inside the deadband",
    fuelStop: storedStop({
      station: { brand: "X", lat: 55.5, lng: 11, kmIn: 105, pricePerLiter: 13 },
      kmUntilRefuel: 105,
    }),
    litersNow: 20,
    expect: { verdict: "holds" },
  },
  {
    name: "respects a caller-supplied deadband (40 km gap flagged at 10)",
    fuelStop: storedStop({
      station: { brand: "X", lat: 55.5, lng: 11, kmIn: 140, pricePerLiter: 13 },
      kmUntilRefuel: 140,
    }),
    litersNow: 20,
    expect: { verdict: "move-earlier" },
  },
  {
    name: "respects a caller-supplied deadband (same gap held at 50)",
    fuelStop: storedStop({
      station: { brand: "X", lat: 55.5, lng: 11, kmIn: 140, pricePerLiter: 13 },
      kmUntilRefuel: 140,
    }),
    litersNow: 20,
    deadbandKm: 50,
    expect: { verdict: "holds" },
  },
  {
    name: "holds when the tank is now fuller than planned (reserve crossed later)",
    fuelStop: storedStop(),
    litersNow: 28,
    expect: { verdict: "holds" },
  },
  {
    name: "flags a trip that now needs a stop it did not before",
    fuelStop: storedStop({ needsFuel: false, station: null, kmUntilRefuel: null }),
    litersNow: 20,
    expect: { verdict: "now-needs-stop", reserveKm: 100, storedStopKm: null },
  },
  {
    name: 'holds a "no stop" plan when the new crossing is only marginally before arrival',
    fuelStop: storedStop({ needsFuel: false, station: null, kmUntilRefuel: null }),
    // currentRange 695 → crossing = 695 − 300 = 395 > 400 − 10.
    litersNow: 34.75,
    expect: { verdict: "holds" },
  },

  // ── fail closed ───────────────────────────────────────────────────────────────
  {
    name: "never nudges on a missing fuel stop",
    fuelStop: null,
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    name: "never nudges on a non-object fuel stop",
    fuelStop: 42,
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    name: "never nudges without a tracked tank level",
    fuelStop: storedStop(),
    litersNow: null,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    name: "never nudges without a valid route distance (null)",
    fuelStop: storedStop({ distanceKm: null }),
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    name: "never nudges without a valid route distance (zero)",
    fuelStop: storedStop({ distanceKm: 0 }),
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    name: "fails closed on a stored stop it cannot locate (legacy / malformed)",
    fuelStop: { needsFuel: true, distanceKm: 400, station: null, kmUntilRefuel: null },
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },
  {
    // `fs.station != null` in the TypeScript is true for ANY present, non-null value —
    // it is not narrowed to a well-formed object. A corrupt station therefore still
    // means "the plan claimed a stop", and with no locatable kmIn the whole thing fails
    // closed. Reading it as "no stop planned" instead would route this down the
    // now-needs-stop branch and nag on data we cannot trust.
    name: "a corrupt (non-object) station still counts as a planned stop, and fails closed",
    fuelStop: { needsFuel: false, distanceKm: 400, station: 5, kmUntilRefuel: null },
    litersNow: 20,
    expect: { verdict: "holds", reserveKm: null, storedStopKm: null },
  },

  // ── the tur/retur invariant (GV-405 review; not in the vitest suite) ───────────
  // fuel_stop.distanceKm is the EFFECTIVE distance, already doubled for a round trip
  // (EstimateView passes `effDist`, useTripEstimate computes `returnTrip ? d * 2 : d`).
  // `returnTrip` is presentational metadata for the detail screen's return-leg date.
  // Applying it as a multiplier here would model a 400 km round trip as 800 km and push
  // people whose tank is fine, so the flag must change NOTHING.
  {
    name: "a returnTrip flag does not change the verdict (distanceKm is already effective)",
    fuelStop: storedStop({ returnTrip: true }),
    litersNow: 20,
    expect: { verdict: "move-earlier", reserveKm: 100, storedStopKm: 200 },
  },
  {
    name: "a returnTrip flag does not change a holding verdict either",
    fuelStop: storedStop({ returnTrip: true }),
    litersNow: 28,
    expect: { verdict: "holds", reserveKm: 260, storedStopKm: 200 },
  },

  // ── the conservative burn (GVM-385): safeConsumption must include the spread ────
  // Ported verbatim from refuel-plan.ts: consumption + (spread > 0 ? spread : 0).
  // litersNow 24, consumption 5, spread 1 → consSafe 6, range 400, reserve 250,
  // crossing 150; the stored stop at 200 is then 50 km too late. On the MEAN alone
  // (consSafe 5) the crossing would be 180 and the gap 20 — still move-earlier, so the
  // pair below is chosen so that dropping the spread flips the answer outright.
  {
    name: "the spread tightens the reserve decision (mean-only would hold)",
    // consSafe 6 → range 41.4/6×100 = 690, reserve 250, crossing 440 → stop at 500 is
    // 60 km too late. On the mean (5): range 828, reserve 300, crossing 528 → the stored
    // stop at 500 is EARLIER than the crossing, so a mean-only implementation holds.
    fuelStop: storedStop({
      distanceKm: 700,
      kmUntilRefuel: 500,
      station: { brand: "X", lat: 55.5, lng: 11, kmIn: 500, pricePerLiter: 13 },
    }),
    litersNow: 41.4,
    consumption: 5,
    spread: 1,
    expect: { verdict: "move-earlier", reserveKm: 440, storedStopKm: 500 },
  },
  {
    name: "a non-positive spread collapses to the mean (safeConsumption's tolerance)",
    fuelStop: storedStop(),
    litersNow: 20,
    spread: -3,
    expect: { verdict: "move-earlier", reserveKm: 100, storedStopKm: 200 },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────────
const sqlLiteral = (value) => (value === null || value === undefined ? "null" : `'${String(value)}'`);
const jsonArg = (value) =>
  value === null || value === undefined ? "null::jsonb" : `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

function fail(message) {
  console.error(`\n❌ ${message}`);
  removeContainer(CONTAINER);
  process.exit(1);
}

// A failing assertion throws, and the whole point of this file is to fail sometimes, so
// the disposable container must be reaped on the way out or a red run leaves one behind
// on every retry. `process.on('exit')` covers both the assertion path and a crash;
// removeContainer is synchronous, which is what makes it legal in an exit handler.
let finished = false;
process.on("exit", () => {
  if (!finished) removeContainer(CONTAINER);
});

function run(sql) {
  const res = psql(CONTAINER, DB, ["-t", "-A", "-F", "|", "-c", sql]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
  return res.stdout.trim();
}

try {
  startPostgres(CONTAINER, process.cwd());
  createDbWithPrelude(CONTAINER, DB);
} catch (error) {
  fail(error.message);
}

const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

let checked = 0;

// ── Part 1: the verdict, scenario by scenario ───────────────────────────────────
for (const scenario of scenarios) {
  const sql = `select public.fuel_stop_revalidation_verdict(
    ${jsonArg(scenario.fuelStop)},
    ${sqlLiteral(scenario.litersNow)}::numeric,
    ${sqlLiteral(scenario.consumption ?? CAR.consumption)}::numeric,
    ${sqlLiteral(scenario.spread ?? CAR.spread)}::numeric,
    ${sqlLiteral(scenario.capacity ?? CAR.capacity)}::numeric,
    ${sqlLiteral(scenario.deadbandKm ?? 10)}::numeric
  )::text;`;
  const result = JSON.parse(run(sql));

  assert.equal(
    result.verdict,
    scenario.expect.verdict,
    `verdict drift — "${scenario.name}": SQL said ${JSON.stringify(result.verdict)}, ` +
      `govehlo-mobile/src/lib/fuel-stop-revalidation.ts says ${JSON.stringify(scenario.expect.verdict)}. ` +
      `Full SQL result: ${JSON.stringify(result)}`,
  );

  for (const field of ["reserveKm", "storedStopKm"]) {
    if (!(field in scenario.expect)) continue;
    const expected = scenario.expect[field];
    const actual = result[field] === null ? null : Number(result[field]);
    assert.equal(
      actual,
      expected,
      `${field} drift — "${scenario.name}": SQL said ${JSON.stringify(actual)}, the mobile ` +
        `module says ${JSON.stringify(expected)}. Full SQL result: ${JSON.stringify(result)}`,
    );
  }
  checked += 1;
}

// ── Part 2: due-ness end to end ─────────────────────────────────────────────────
// The verdict is only half the contract; the claim decides WHICH bookings it is even
// asked about. Each case below seeds one booking that differs from the due one in
// exactly one respect, so a regression names its own cause.
const seed = `
  insert into public.ledgers (id, name, slug, tank_state_liters, tank_state_as_of,
                              tank_state_consumption, tank_state_consumption_spread,
                              tank_state_capacity)
  values ('fuelstop-test', 'Fuel stop test', 'fuelstop-test', 20, now() - interval '1 hour', 5, 0, 150),
         ('fuelstop-nostate', 'No tank state', 'fuelstop-nostate', null, null, null, null, null),
         ('fuelstop-stale-trip', 'Stale by trip', 'fuelstop-stale-trip', 20, now() - interval '1 hour', 5, 0, 150),
         ('fuelstop-stale-fuel', 'Stale by fuel', 'fuelstop-stale-fuel', 20, now() - interval '1 hour', 5, 0, 150);

  insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
    ('10000000-0000-0000-0000-000000000001', 'fuelstop-test', 'Driver', 'driver@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000002', 'fuelstop-test', 'No mail', null, 'member', true),
    -- Deactivated AFTER its booking exists: enforce_identity_reassignment refuses to
    -- attach a booking to an inactive member, which is exactly how this happens in life.
    ('10000000-0000-0000-0000-000000000003', 'fuelstop-test', 'Inactive', 'inactive@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000004', 'fuelstop-nostate', 'Driver', 'driver2@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000005', 'fuelstop-stale-trip', 'Driver', 'driver3@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000006', 'fuelstop-stale-fuel', 'Driver', 'driver4@test.dk', 'member', true);

  -- Trips and fuel payments need an open period to land in (migration 121's boundary
  -- trigger), which every real workspace has.
  insert into public.settlement_periods (ledger_id, status, label)
  select l.id, 'open', 'Open' from public.ledgers l where l.id like 'fuelstop-%';

  -- A trip and a fuel payment OLDER than the stamp must not make it look stale.
  insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id, created_at, updated_at)
  values ('fuelstop-test', current_date, 100, 200, '10000000-0000-0000-0000-000000000001',
          now() - interval '5 hours', now() - interval '5 hours');
  insert into public.fuel_payments (ledger_id, payment_date, amount, payer_member_id, created_at, updated_at)
  values ('fuelstop-test', current_date, 400, '10000000-0000-0000-0000-000000000001',
          now() - interval '5 hours', now() - interval '5 hours');

  -- Newer than the stamp → the stamp cannot be trusted.
  insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id, created_at, updated_at)
  values ('fuelstop-stale-trip', current_date, 100, 200, '10000000-0000-0000-0000-000000000005',
          now() - interval '2 hours', now() - interval '10 minutes');
  insert into public.fuel_payments (ledger_id, payment_date, amount, payer_member_id, created_at, updated_at)
  values ('fuelstop-stale-fuel', current_date, 400, '10000000-0000-0000-0000-000000000006',
          now() - interval '10 minutes', now() - interval '10 minutes');
`;
const seeded = psql(CONTAINER, DB, ["-c", seed]);
if (seeded.status !== 0) fail(`Seeding the due-ness fixtures failed:\n${seeded.stderr}`);

const NEEDS_STOP = JSON.stringify({ needsFuel: false, station: null, kmUntilRefuel: null, distanceKm: 400 });
const HOLDS = JSON.stringify(storedStop({ station: { brand: "X", lat: 55.5, lng: 11, kmIn: 105, pricePerLiter: 13 }, kmUntilRefuel: 105 }));

// One car cannot be double-booked (prevent_overlapping_car_bookings), so every fixture
// on the same workspace gets its own 5-minute slot, spaced 10 minutes apart inside the
// 3-hour window. Each row differs from `due` in exactly ONE respect, so when the
// expected set below stops matching, the diff names the predicate that broke.
//
//   legacy_id, ledger, member, start offset (minutes), fuel_stop, soft-deleted, due?
const bookings = [
  ["due", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 60, NEEDS_STOP, false, true],
  ["too-far-out", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 300, NEEDS_STOP, false, false],
  ["already-started", "fuelstop-test", "10000000-0000-0000-0000-000000000001", -30, NEEDS_STOP, false, false],
  ["cancelled", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 70, NEEDS_STOP, true, false],
  ["no-mail", "fuelstop-test", "10000000-0000-0000-0000-000000000002", 80, NEEDS_STOP, false, false],
  ["inactive", "fuelstop-test", "10000000-0000-0000-0000-000000000003", 90, NEEDS_STOP, false, false],
  ["verdict-holds", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 100, HOLDS, false, false],
  ["no-fuel-stop", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 110, null, false, false],
  ["no-distance", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 120, JSON.stringify({ needsFuel: false, distanceKm: null }), false, false],
  ["malformed-stop", "fuelstop-test", "10000000-0000-0000-0000-000000000001", 130, JSON.stringify({ needsFuel: true, distanceKm: 400, station: null, kmUntilRefuel: null }), false, false],
  ["no-tank-state", "fuelstop-nostate", "10000000-0000-0000-0000-000000000004", 60, NEEDS_STOP, false, false],
  ["stale-by-trip", "fuelstop-stale-trip", "10000000-0000-0000-0000-000000000005", 60, NEEDS_STOP, false, false],
  ["stale-by-fuel", "fuelstop-stale-fuel", "10000000-0000-0000-0000-000000000006", 60, NEEDS_STOP, false, false],
];

const bookingRows = bookings
  .map(([legacyId, ledger, member, offsetMinutes, fuelStop, deleted]) => {
    const stop = fuelStop === null ? "null" : `'${fuelStop.replace(/'/g, "''")}'::jsonb`;
    return `('${legacyId}', '${ledger}', '${member}', now() + interval '${offsetMinutes} minutes', ` +
      `now() + interval '${offsetMinutes + 5} minutes', ${stop}, ` +
      `${deleted ? "now()" : "null"})`;
  })
  .join(",\n    ");

const insertBookings = `
  insert into public.car_bookings (legacy_id, ledger_id, member_id, start_at, end_at, fuel_stop, deleted_at)
  values
    ${bookingRows};
`;
const bookingsSeeded = psql(CONTAINER, DB, [
  "-c",
  `${insertBookings}
   update public.ledger_members lm set is_active = false
   where lm.id = '10000000-0000-0000-0000-000000000003';`,
]);
if (bookingsSeeded.status !== 0) fail(`Seeding the bookings failed:\n${bookingsSeeded.stderr}`);

const claimed = run(
  `select cb.legacy_id, c.verdict, c.reserve_km, c.claim_token is not null
   from public.claim_due_booking_fuel_reminders(200) c
   join public.car_bookings cb on cb.id = c.booking_id
   order by cb.legacy_id;`,
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("|"));

const claimedIds = claimed.map((row) => row[0]).sort();
const expectedIds = bookings.filter(([, , , , , , due]) => due).map(([legacyId]) => legacyId).sort();
assert.deepEqual(
  claimedIds,
  expectedIds,
  "due-ness drift in claim_due_booking_fuel_reminders. Each fixture differs from the due " +
    "booking in exactly one respect, so the diff names the broken predicate.",
);
assert.equal(claimed[0][1], "now-needs-stop", "the claim must return the verdict for the endpoint to compose copy");
assert.equal(Number(claimed[0][2]), 100, "the claim must return the reserve crossing");
assert.equal(claimed[0][3], "t", "the claim must hand out a lease token");
checked += 1;

// A second claim inside the lease window returns nothing — no double-send.
assert.equal(
  run("select count(*) from public.claim_due_booking_fuel_reminders(200);"),
  "0",
  "a live lease must suppress a second claim (the 15-minute lease from migration 124)",
);
checked += 1;

// A wrong token confirms nothing; the right one marks it reminded exactly once.
const token = run(
  "select cb.fuel_reminder_claim_token from public.car_bookings cb where cb.legacy_id = 'due';",
);
const bookingId = run("select cb.id from public.car_bookings cb where cb.legacy_id = 'due';");
assert.equal(
  run(
    `select public.confirm_booking_fuel_reminders(jsonb_build_array(jsonb_build_object(
       'id', '${bookingId}', 'token', gen_random_uuid()::text, 'outcome', 'delivered')));`,
  ),
  "0",
  "a confirmation carrying the wrong claim token must change nothing",
);
assert.equal(
  run(
    `select public.confirm_booking_fuel_reminders(jsonb_build_array(jsonb_build_object(
       'id', '${bookingId}', 'token', '${token}', 'outcome', 'delivered')));`,
  ),
  "1",
  "the matching claim token must confirm exactly one booking",
);
assert.equal(
  run(
    `select public.confirm_booking_fuel_reminders(jsonb_build_array(jsonb_build_object(
       'id', '${bookingId}', 'token', '${token}', 'outcome', 'delivered')));`,
  ),
  "0",
  "a replayed confirmation must be a no-op (one-shot token)",
);
assert.equal(
  run(
    "select count(*) from public.ledger_events le where le.event_type = 'booking_fuel_reminder_sent';",
  ),
  "1",
  "a confirmed reminder logs exactly one ledger_events row",
);
checked += 1;

// Expiring the lease must NOT resurrect an already-reminded booking.
if (
  psql(CONTAINER, DB, [
    "-c",
    "update public.car_bookings set fuel_reminder_claimed_at = now() - interval '1 hour' where legacy_id = 'due';",
  ]).status !== 0
) {
  fail("Could not expire the lease.");
}
assert.equal(
  run("select count(*) from public.claim_due_booking_fuel_reminders(200);"),
  "0",
  "fuel_reminded_at must keep a confirmed booking out of the pool for good",
);
checked += 1;

// ── Part 3: set_tank_state monotonicity ─────────────────────────────────────────
// set_tank_state is member-gated, so it needs a signed-in identity. Each run() opens
// its own session, so the claim is pinned at database level rather than per session.
if (
  psql(CONTAINER, DB, [
    "-c",
    `alter database ${DB} set "request.jwt.claims" = '{"email":"driver@test.dk"}';`,
  ]).status !== 0
) {
  fail("Could not pin a JWT identity for the set_tank_state cases.");
}

// The member gate itself: a caller with no workspace membership is refused outright.
const outsider = psql(CONTAINER, DB, [
  "-c",
  `select set_config('request.jwt.claims', '{"email":"stranger@test.dk"}', false);
   select public.set_tank_state('fuelstop-test', 11, now(), 5, 0, 150);`,
]);
assert.notEqual(outsider.status, 0, "set_tank_state must refuse a non-member");
assert.match(
  outsider.stderr,
  /Only an active workspace member can record tank state/,
  "set_tank_state's member gate must be the reason a non-member is refused",
);
checked += 1;

const monotonic = run(`
  select public.set_tank_state('fuelstop-test', 11, now() - interval '90 minutes', 5, 0, 150) ->> 'applied';
`);
assert.equal(
  monotonic,
  "false",
  "set_tank_state must refuse a stamp whose as_of watermark predates the stored one, " +
    "and refuse it as a quiet no-op rather than an exception",
);
assert.equal(
  run("select l.tank_state_liters from public.ledgers l where l.id = 'fuelstop-test';"),
  "20",
  "a refused stamp must leave the stored tank state untouched",
);
assert.equal(
  run("select public.set_tank_state('fuelstop-test', 11, now(), 5, 0, 150) ->> 'applied';"),
  "true",
  "a stamp with a newer watermark must apply",
);
checked += 1;

removeContainer(CONTAINER);
finished = true;
console.log(
  `ok - fuel-stop verdict contract: ${checked} checks. The SQL in migration 154 returns the ` +
    "same verdicts as govehlo-mobile/src/lib/fuel-stop-revalidation.ts for every scenario in " +
    "its vitest suite, the claim's due-ness and lease/token contract holds, and set_tank_state " +
    "is monotonic on its as_of watermark.",
);

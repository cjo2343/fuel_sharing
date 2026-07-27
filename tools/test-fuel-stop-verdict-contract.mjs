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
// Migration 155 (GV-411) added three more things worth pinning, all at the end of the
// file: that a SOFT-DELETED trip or fuel row does not silence the claim (the active
// fixtures right beside them still must), that set_tank_state refuses absurd litres /
// capacity / consumption, and that it stays monotonic when two stamps genuinely
// OVERLAP — the last one via two dblink sessions, because two sequential calls pass
// under the buggy implementation as happily as the fixed one and prove nothing.
//
// Migration 156 (GV-415) replaced the client-chosen `as_of` watermark with a
// SERVER-derived counter, ledgers.tank_model_revision, and the parts below grew with it:
// the due-ness fixtures now separate the two freshness gates so each one has a fixture
// only IT can exclude (an active-but-newer trip for the as_of half, a deletion and a
// settings change for the revision half), Part 3d pins the seven-argument signature's
// stale_revision / value_conflict / identical-resend contract, Part 3e runs the
// interleaving probe against the revision as well as the watermark, and Part 4 tests the
// counter itself statement by statement — including the two changes that must NOT bump it.
//
// GVM-486 added one more: the planner now persists a whole stop SEQUENCE (`stations`)
// beside the singular `station` this SQL reads, and the push only keeps working while
// `station` keeps carrying stop one. The mobile suite asserts that identity; this asserts
// what the SERVER does with the pairing, which is the half that decides whether anyone
// gets a notification.
//
// GVM-485 added the same thing one level deeper: a tur/retur can now carry a whole second
// LEG in an additive `returnRoute` object, with its own `station`, its own `stations` and
// its own km figures measured from the start of THAT leg. The server neither knows nor
// needs to — but "the server ignores it cleanly" is a claim about `->` and `->>` over a
// shape this SQL has never met, which no amount of TypeScript can check. So there is one
// fixture carrying the block, asserted as an EQUALITY against the same plan without it,
// plus a due-ness row proving a two-leg booking is still claimed and still reports the
// OUTBOUND stop's position.
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

// ── A multi-stop plan, transcribed from the mobile suite (GVM-486) ──────────────
// The three-stop plan in govehlo-mobile/src/lib/__tests__/booking-fuel-stop.test.ts —
// same trip, same numbers, so both suites pin the same persisted object rather than two
// plausible-looking ones.
//
// The planner now emits a SEQUENCE for trips one fill cannot bridge, published as
// `stations` BESIDE the singular `station`, never in place of it: `stations[0]` is the
// same object as `station` (the mobile builder constructs it once and the mobile suite
// asserts the identity). That invariant exists because of this SQL — migration 154 reads
// `fuel_stop -> 'station'` and `station -> 'kmIn'` to decide whether a booking still
// needs a push. If a future change moved the sequence into `stations` and stopped
// writing `station`, the server would find no locatable stop, fall back to `holds`, and
// the pre-departure push would disappear with no error anywhere.
//
// Two things are only checkable here, not in the mobile suite: that the SQL — which
// reads `station` positionally and has never seen a sibling array in this jsonb —
// ignores the unknown key cleanly, and that `stored_needs_fuel`'s "ANY non-null station
// counts" rule still behaves when a populated `station` sits next to that array.
//
// `station.kmIn` (34) is deliberately NOT `kmUntilRefuel` (37): the corridor pick can
// sit earlier than the reserve crossing (GVM-384), and if the two were equal, nulling
// `station` would fall back to `kmUntilRefuel` and land on the same answer — the
// regression this case exists to catch would pass unnoticed.
const MULTI_STOP_PLAN = {
  from: { label: "Aarhus", lat: 56.16, lng: 10.2 },
  to: { label: "Skagen", lat: 57.72, lng: 10.58 },
  distanceKm: 1044,
  driveMinutes: 720,
  returnTrip: true,
  needsFuel: true,
  kmUntilRefuel: 37,
  station: { brand: "Shell", lat: 56.4, lng: 10.1, kmIn: 34, pricePerLiter: 13.79 },
  stations: [
    { brand: "Shell", lat: 56.4, lng: 10.1, kmIn: 34, pricePerLiter: 13.79 },
    { brand: "Circle K", lat: 57.0, lng: 10.4, kmIn: 420, pricePerLiter: 13.29 },
    { brand: "OK", lat: 56.3, lng: 10.0, kmIn: 810, pricePerLiter: 13.49 },
  ],
};

// ── The same plan with a way home of its own (GVM-485) ──────────────────────────
// The planner can now plan the RETURN leg on a different road — you drive out over
// Storebælt and come home by ferry, or the other way round when the ferry is sold out.
// That second leg is persisted as an ADDITIVE `returnRoute` object beside everything
// above, and this SQL has never seen it and never will: it is a key the server keeps
// ignoring, exactly as it ignores `stations`.
//
// This is the DARK SHAPE this file exists for. The mobile suite can assert what the
// client writes; only a real Postgres can say what `->` and `->>` do when an object they
// have never met turns up as a sibling. Three things have to hold and all three are
// invisible from TypeScript:
//
//   1. the claim still reads the OUTBOUND `station.kmIn` — not the way home's, which sits
//      in `returnRoute.station.kmIn` at a DIFFERENT number in a DIFFERENT frame (km into
//      that leg, not km into the trip);
//   2. the extra nesting changes no answer at all, asserted as an equality against
//      MULTI_STOP_PLAN rather than as a second transcribed guess;
//   3. the booking is still CLAIMED, because a two-leg plan going quiet is exactly how
//      the pre-departure push would disappear for the trips that need it most.
//
// The numbers are deliberately chosen so a mix-up cannot pass. The outbound first stop is
// 34 km in; the way home's is 120 km into that leg. Reading the wrong one moves
// storedStopKm from 34 to 120 and flips the verdict's arithmetic outright.
const RETURN_ROUTE_PLAN = {
  ...MULTI_STOP_PLAN,
  returnRoute: {
    from: { label: "Skagen", lat: 57.72, lng: 10.58 },
    to: { label: "Aarhus", lat: 56.16, lng: 10.2 },
    distanceKm: 512,
    driveMinutes: 350,
    needsFuel: true,
    kmUntilRefuel: null,
    station: { brand: "Q8", lat: 56.8, lng: 9.9, kmIn: 120, pricePerLiter: 13.19 },
    stations: [
      { brand: "Q8", lat: 56.8, lng: 9.9, kmIn: 120, pricePerLiter: 13.19 },
      { brand: "Uno-X", lat: 56.4, lng: 9.7, kmIn: 400, pricePerLiter: 12.99 },
    ],
    crossings: [
      { kind: "ferry", fromPoint: { lat: 56.0, lng: 10.8 }, toPoint: { lat: 55.97, lng: 11.36 }, km: 34 },
    ],
    estimated: false,
  },
};

// The same plan as a single-stop booking would have persisted it: `stations` omitted
// entirely, which is what the builder does when there is only one stop (and what every
// pre-GVM-486 booking looks like). Every other byte is identical, so any difference in
// the SQL's answer can only have come from the array.
const SINGLE_STOP_CONTROL = { ...MULTI_STOP_PLAN };
delete SINGLE_STOP_CONTROL.stations;

// litersNow 16 → range 320, reserve 300, crossing 20 km in. The stored first stop at 34
// is then 14 km past the new crossing, over the 10 km deadband → move-earlier.
const MULTI_STOP_LITERS = 16;

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

  // ── the multi-stop plan (GVM-486; see MULTI_STOP_PLAN above) ──────────────────
  // storedStopKm must be the FIRST stop's own position (station.kmIn = 34), not the
  // reserve km (kmUntilRefuel = 37) and not any later stop in the array.
  {
    name: "a three-stop plan reads exactly like a one-stop plan (the stations array is ignored)",
    fuelStop: MULTI_STOP_PLAN,
    litersNow: MULTI_STOP_LITERS,
    expect: { verdict: "move-earlier", reserveKm: 20, storedStopKm: 34 },
  },
  {
    name: "the same plan without the stations key answers identically",
    fuelStop: SINGLE_STOP_CONTROL,
    litersNow: MULTI_STOP_LITERS,
    expect: { verdict: "move-earlier", reserveKm: 20, storedStopKm: 34 },
  },

  // ── the two-leg plan (GVM-485; see RETURN_ROUTE_PLAN above) ───────────────────
  // storedStopKm must still be the OUTBOUND first stop's own position (station.kmIn =
  // 34). The way home's first stop is 120 — a number this row would report if the SQL
  // ever started descending into `returnRoute`, and a number that is in a different
  // frame besides (km into that leg, not km into the trip).
  {
    name: "a plan with a separate way home still reads the OUTBOUND station",
    fuelStop: RETURN_ROUTE_PLAN,
    litersNow: MULTI_STOP_LITERS,
    expect: { verdict: "move-earlier", reserveKm: 20, storedStopKm: 34 },
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

// The two scenarios above assert the same expectations, but expectations transcribed
// twice can be wrong twice. This compares the SQL's two answers to each other, so the
// claim being made — "the sibling `stations` array changes NOTHING" — is checked as an
// equality rather than as two independent guesses.
const withStations = run(
  `select public.fuel_stop_revalidation_verdict(${jsonArg(MULTI_STOP_PLAN)}, ${MULTI_STOP_LITERS}::numeric,
     ${CAR.consumption}::numeric, ${CAR.spread}::numeric, ${CAR.capacity}::numeric, 10::numeric)::text;`,
);
const withoutStations = run(
  `select public.fuel_stop_revalidation_verdict(${jsonArg(SINGLE_STOP_CONTROL)}, ${MULTI_STOP_LITERS}::numeric,
     ${CAR.consumption}::numeric, ${CAR.spread}::numeric, ${CAR.capacity}::numeric, 10::numeric)::text;`,
);
assert.deepEqual(
  JSON.parse(withStations),
  JSON.parse(withoutStations),
  "a plan carrying the GVM-486 `stations` sequence must read exactly like the same plan without it. " +
    "The SQL reads `station` positionally and has never seen a sibling array in this jsonb; an " +
    "unknown key must be ignored cleanly, not change the verdict and not trip anything.",
);
checked += 1;

// The same equality one level deeper (GVM-485): `returnRoute` is a nested OBJECT carrying
// its own `station`, its own `stations` array and its own `kmUntilRefuel`, all in a
// different frame from the ones this SQL reads. Asserted against MULTI_STOP_PLAN rather
// than against transcribed expectations, so the claim being made — "a whole second leg
// changes NOTHING" — is checked as an equality instead of two guesses that could be wrong
// in the same direction.
//
// Mutation check for whoever edits this next: point RETURN_ROUTE_PLAN's OUTBOUND
// `station` somewhere else (say kmIn 120, the way home's figure) and this fails naming
// storedStopKm, because the two sides stop agreeing.
const withReturnRoute = run(
  `select public.fuel_stop_revalidation_verdict(${jsonArg(RETURN_ROUTE_PLAN)}, ${MULTI_STOP_LITERS}::numeric,
     ${CAR.consumption}::numeric, ${CAR.spread}::numeric, ${CAR.capacity}::numeric, 10::numeric)::text;`,
);
assert.deepEqual(
  JSON.parse(withReturnRoute),
  JSON.parse(withStations),
  "a plan carrying the GVM-485 `returnRoute` block must read exactly like the same plan without it. " +
    "The way home is an additive key the server never descends into: its own `station.kmIn` (120) is " +
    "km into THAT LEG, while everything this SQL compares — the reserve crossing and the stored stop — " +
    "is km into the whole trip. A verdict that moved here means the server started reading the second " +
    "leg, and every two-leg booking's pre-departure push is now timed off the wrong number.",
);
checked += 1;

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
         ('fuelstop-stale-fuel', 'Stale by fuel', 'fuelstop-stale-fuel', 20, now() - interval '1 hour', 5, 0, 150),
         ('fuelstop-gone-trip', 'Deleted trip', 'fuelstop-gone-trip', 20, now() - interval '1 hour', 5, 0, 150),
         ('fuelstop-gone-fuel', 'Deleted fuel', 'fuelstop-gone-fuel', 20, now() - interval '1 hour', 5, 0, 150),
         -- GV-415: the two fixtures the as_of watermark provably CANNOT catch. Both are
         -- stamped, both have only OLD active rows, so migration 155's not-exists gate
         -- passes for each of them and only the model revision can exclude them.
         ('fuelstop-deleted-after', 'Deleted after the stamp', 'fuelstop-deleted-after', 20, now() - interval '1 hour', 5, 0, 150),
         ('fuelstop-settings-changed', 'Settings changed', 'fuelstop-settings-changed', 20, now() - interval '1 hour', 5, 0, 150),
         -- No stamp and no bookings: this one exists only for Part 4, which measures the
         -- counter itself rather than what the claim does with it.
         ('fuelstop-counter', 'Revision counter', 'fuelstop-counter', null, null, null, null, null),
         -- Its own workspace purely for the tank level: MULTI_STOP_PLAN's first stop
         -- sits 34 km in, so the reserve crossing has to land before that for the plan
         -- to be re-validated as move-earlier. 16 litres puts it at 20 km.
         ('fuelstop-multistop', 'Multi stop', 'fuelstop-multistop', 16, now() - interval '1 hour', 5, 0, 150),
         -- GVM-485: its own workspace for the same reason as the one above — the two-leg
         -- plan's OUTBOUND first stop sits 34 km in, so 16 litres puts the reserve
         -- crossing at 20 km and the plan re-validates as move-earlier.
         ('fuelstop-returnroute', 'Return route', 'fuelstop-returnroute', 16, now() - interval '1 hour', 5, 0, 150);

  insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
    ('10000000-0000-0000-0000-000000000001', 'fuelstop-test', 'Driver', 'driver@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000002', 'fuelstop-test', 'No mail', null, 'member', true),
    -- Deactivated AFTER its booking exists: enforce_identity_reassignment refuses to
    -- attach a booking to an inactive member, which is exactly how this happens in life.
    ('10000000-0000-0000-0000-000000000003', 'fuelstop-test', 'Inactive', 'inactive@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000004', 'fuelstop-nostate', 'Driver', 'driver2@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000005', 'fuelstop-stale-trip', 'Driver', 'driver3@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000006', 'fuelstop-stale-fuel', 'Driver', 'driver4@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000007', 'fuelstop-gone-trip', 'Driver', 'driver5@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000008', 'fuelstop-gone-fuel', 'Driver', 'driver6@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000009', 'fuelstop-multistop', 'Driver', 'driver7@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000010', 'fuelstop-deleted-after', 'Driver', 'driver8@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000011', 'fuelstop-settings-changed', 'Driver', 'driver9@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000012', 'fuelstop-counter', 'Driver', 'driver10@test.dk', 'member', true),
    ('10000000-0000-0000-0000-000000000013', 'fuelstop-returnroute', 'Driver', 'driver11@test.dk', 'member', true);

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

  -- GV-411: the same two rows again, but SOFT-DELETED. Byte for byte the stale fixtures
  -- above apart from deleted_at, which is the whole point — the pair differs in exactly
  -- the respect the fix is about, so re-including tombstones in the gate turns the two
  -- 'tombstone-*' bookings below from due into silent, and the diff names the cause.
  --
  -- A tombstone is not a row the client can ever account for: ledger-data-gateway.ts
  -- loads trips and fuel payments with .is('deleted_at', null) and derives the stamp's
  -- watermark from the rows it LOADED, so a deletion's bumped updated_at is permanently
  -- newer than any watermark it can send. Counting it made the gate permanently true and
  -- killed pre-departure reminders for the workspace, with no error anywhere.
  insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id, created_at, updated_at, deleted_at)
  values ('fuelstop-gone-trip', current_date, 100, 200, '10000000-0000-0000-0000-000000000007',
          now() - interval '2 hours', now() - interval '10 minutes', now() - interval '10 minutes');
  insert into public.fuel_payments (ledger_id, payment_date, amount, payer_member_id, created_at, updated_at, deleted_at)
  values ('fuelstop-gone-fuel', current_date, 400, '10000000-0000-0000-0000-000000000008',
          now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes');

  -- GV-415: one OLD, ACTIVE trip on the workspace whose row gets soft-deleted after the
  -- stamp is synced below. Old, so migration 155's as_of gate passes while it is alive;
  -- soft-deleted, so that gate excludes it afterwards and cannot be what makes the
  -- booking undue. Only the revision bump can.
  insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id, created_at, updated_at)
  values ('fuelstop-deleted-after', current_date, 100, 200, '10000000-0000-0000-0000-000000000010',
          now() - interval '5 hours', now() - interval '5 hours');
`;
const seeded = psql(CONTAINER, DB, ["-c", seed]);
if (seeded.status !== 0) fail(`Seeding the due-ness fixtures failed:\n${seeded.stderr}`);

// ── GV-415: put every fixture's stamp on the CURRENT model revision ─────────────
// The rows above were inserted directly, so the bump triggers have already moved
// tank_model_revision past the tank_state_revision the ledger INSERTs left behind. Syncing
// them here is what a client re-stamping after each of those writes would have done, and
// it is what makes the rest of this file test one thing at a time: with every fixture's
// revision current, the ONLY reason `stale-by-trip` and `stale-by-fuel` are excluded is
// migration 155's as_of comparison, and the only reason the two fixtures below are
// excluded is the revision. Neither gate can stand in for the other, so removing either
// one names itself in the diff.
//
// It also preserves what migration 155's tombstone fixtures were for: `tombstone-trip` and
// `tombstone-fuel` are stamped at the post-deletion revision, i.e. the client has accounted
// for the deletion, and they must still be DUE. A tombstone marking a stamp stale is
// correct (GV-415 finding 4); a tombstone silencing a workspace whose stamp already covers
// it is the permanent-blindness bug 155 fixed, and it must stay fixed.
const syncRevisions = psql(CONTAINER, DB, [
  "-c",
  `update public.ledgers l set tank_state_revision = l.tank_model_revision
   where l.id like 'fuelstop-%';`,
]);
if (syncRevisions.status !== 0) fail(`Could not sync the fixture revisions:\n${syncRevisions.stderr}`);

// Now the two model changes that happen AFTER the stamp. Both are invisible to the as_of
// watermark by construction: a soft-deleted trip is filtered out of that gate entirely,
// and the car's consumption setting is not in it at all.
const invalidated = psql(CONTAINER, DB, [
  "-c",
  `update public.trips t set deleted_at = now()
   where t.ledger_id = 'fuelstop-deleted-after';
   update public.ledgers l set estimated_consumption_l_per_100km = 7.5
   where l.id = 'fuelstop-settings-changed';`,
]);
if (invalidated.status !== 0) fail(`Could not invalidate the two GV-415 fixtures:\n${invalidated.stderr}`);

for (const [ledgerId, why] of [
  ["fuelstop-deleted-after", "a soft-deleted trip"],
  ["fuelstop-settings-changed", "a consumption change"],
]) {
  const [modelRevision, stateRevision] = run(
    `select l.tank_model_revision, l.tank_state_revision from public.ledgers l where l.id = '${ledgerId}';`,
  ).split("|");
  assert.notEqual(
    modelRevision,
    stateRevision,
    `${why} must move ledgers.tank_model_revision past the stamp's tank_state_revision. ` +
      `Equal here means the bump never happened, and every assertion about ${ledgerId} below ` +
      "would then be passing for the wrong reason.",
  );
  checked += 1;
}

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
  // GV-411: identical to the two rows above except that the newer trip / fuel row is
  // soft-deleted. A tombstone must NOT make the stamp look stale — the client cannot
  // see it, so it can never produce a watermark that clears it, and counting it silences
  // this workspace's reminders for good.
  ["tombstone-trip", "fuelstop-gone-trip", "10000000-0000-0000-0000-000000000007", 60, NEEDS_STOP, false, true],
  ["tombstone-fuel", "fuelstop-gone-fuel", "10000000-0000-0000-0000-000000000008", 60, NEEDS_STOP, false, true],
  // GV-415 findings 3 and 4, one fixture each. Both workspaces are stamped, both hold
  // only OLD active rows, so migration 155's as_of gate passes for both and CANNOT be
  // what excludes them — the model revision is. Removing the delete-path bump makes the
  // first one due; removing the settings-path bump makes the second one due.
  ["deleted-after-stamp", "fuelstop-deleted-after", "10000000-0000-0000-0000-000000000010", 60, NEEDS_STOP, false, false],
  ["settings-changed", "fuelstop-settings-changed", "10000000-0000-0000-0000-000000000011", 60, NEEDS_STOP, false, false],
  // GVM-486: a booking whose persisted plan carries the whole stop SEQUENCE. Due, and
  // for the same reason a one-stop plan would be. If `station` ever stops being written
  // because the sequence moved into `stations`, this row leaves the claimed set entirely
  // — which is exactly how the pre-departure push would go dark in production.
  ["multi-stop", "fuelstop-multistop", "10000000-0000-0000-0000-000000000009", 60, JSON.stringify(MULTI_STOP_PLAN), false, true],
  // GVM-485: a booking whose plan carries a whole second LEG. Due, and for the same
  // reason a one-leg plan would be — the way home is an additive key, not a new shape.
  // If the claim ever started descending into it, this row is where that shows up.
  ["return-route", "fuelstop-returnroute", "10000000-0000-0000-0000-000000000013", 60, JSON.stringify(RETURN_ROUTE_PLAN), false, true],
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
  `select cb.legacy_id, c.verdict, c.reserve_km, c.stored_stop_km, c.claim_token is not null
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
const dueRow = claimed.find((row) => row[0] === "due");
assert.ok(dueRow, "the plainly due booking must be claimed");
assert.equal(dueRow[1], "now-needs-stop", "the claim must return the verdict for the endpoint to compose copy");
assert.equal(Number(dueRow[2]), 100, "the claim must return the reserve crossing");
assert.equal(dueRow[4], "t", "the claim must hand out a lease token");
checked += 1;

// GVM-486 end to end: the claim must locate the FIRST stop of a persisted sequence and
// hand the endpoint the same numbers a one-stop plan would produce.
const multiStopRow = claimed.find((row) => row[0] === "multi-stop");
assert.ok(
  multiStopRow,
  "a booking whose plan carries the GVM-486 `stations` sequence must still be claimed. Missing " +
    "here is the production symptom: `station` no longer written, no locatable stop, verdict " +
    "falls back to `holds`, and the pre-departure push vanishes silently.",
);
assert.equal(multiStopRow[1], "move-earlier", "the multi-stop plan's verdict must survive the round trip through the claim");
assert.equal(
  Number(multiStopRow[3]),
  34,
  "the claim must report the FIRST stop's own position (station.kmIn = 34) — not the reserve km " +
    "(kmUntilRefuel = 37, which is what a nulled `station` would fall back to) and not a later " +
    "entry in the stations array",
);
checked += 1;

// GVM-485 end to end: a plan with a way home of its own must be claimed, and the claim
// must hand the endpoint the OUTBOUND stop's position — the one the driver reaches first
// and the only one measured in trip km.
const returnRouteRow = claimed.find((row) => row[0] === "return-route");
assert.ok(
  returnRouteRow,
  "a booking whose plan carries the GVM-485 `returnRoute` block must still be claimed. Missing " +
    "here is the production symptom for two-leg trips: the additive key made the claim's jsonb " +
    "reads stop matching, no locatable stop, verdict falls back to `holds`, and the pre-departure " +
    "push vanishes for exactly the long trips that need it.",
);
assert.equal(
  returnRouteRow[1],
  "move-earlier",
  "the two-leg plan's verdict must survive the round trip through the claim",
);
assert.equal(
  Number(returnRouteRow[3]),
  34,
  "the claim must report the OUTBOUND first stop's own position (station.kmIn = 34) — not the " +
    "way home's first stop (returnRoute.station.kmIn = 120, which is km into THAT LEG rather " +
    "than km into the trip) and not the reserve km (kmUntilRefuel = 37)",
);
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
// An EQUAL watermark stays accepted and idempotent — the conditional update in
// migration 155 uses `<=`, and a `<` there would silently break re-sending the same
// stamp (which the client does after any retry).
const equalAsOf = run("select l.tank_state_as_of from public.ledgers l where l.id = 'fuelstop-test';");
assert.equal(
  run(`select public.set_tank_state('fuelstop-test', 11, '${equalAsOf}'::timestamptz, 5, 0, 150) ->> 'applied';`),
  "true",
  "an equal watermark must still be accepted: same data in, same numbers out, so the write is idempotent",
);
checked += 1;

// GV-415 finding 1, on the LEGACY six-argument signature — the one govehlo-mobile still
// calls, so this is the half that protects production today. Migration 155's `<=` kept an
// equal watermark accepted so a re-sent offline write stays idempotent, but `<=` also
// accepted an equal watermark carrying DIFFERENT numbers, and the last writer won. Two app
// versions, a stale device or a hand-rolled client could therefore each publish its own
// plausible tank level under the same freshness proof.
const conflicting = JSON.parse(
  run(`select public.set_tank_state('fuelstop-test', 7, '${equalAsOf}'::timestamptz, 5, 0, 150)::text;`),
);
assert.equal(
  conflicting.applied,
  false,
  "an equal watermark carrying DIFFERENT numbers must be refused. `tank_state_as_of <= as_of_value` " +
    "accepted it and let the last writer win (GV-415 finding 1); the equality branch must now " +
    "require the stored numbers to match.",
);
assert.equal(
  conflicting.reason,
  "value_conflict",
  "a same-watermark disagreement is not a stale watermark and must not be reported as one — the " +
    "two have different causes and different fixes",
);
assert.equal(
  run("select l.tank_state_liters from public.ledgers l where l.id = 'fuelstop-test';"),
  "11",
  "a refused same-watermark write must leave the stored tank state untouched",
);
checked += 1;

// ── Part 3b: the bounds on the client's numbers (GV-411) ────────────────────────
// The five numbers come straight from the client's model and that is by design
// (GV-405), but the absurd is still refused — and refused by RAISING, like every other
// validation in the RPC. A silent clamp would store numbers the client never computed
// and then nudge the whole workspace on them. The envelope is migration 125's
// update_ledger_fuel_settings range on the settings columns these values derive from,
// upper half only, so nothing an honest client produces is rejected.
const rejects = [
  {
    name: "litres above the tank capacity",
    call: "public.set_tank_state('fuelstop-test', 200, now(), 5, 0, 150)",
    message: /litres cannot exceed the tank capacity/,
  },
  {
    name: "a tank bigger than 500 litres",
    call: "public.set_tank_state('fuelstop-test', 20, now(), 5, 0, 900)",
    message: /capacity must be 500 litres or less/,
  },
  {
    name: "a burn above 100 L/100 km",
    call: "public.set_tank_state('fuelstop-test', 20, now(), 400, 0, 150)",
    message: /consumption must be 100 per 100 km or less/,
  },
  {
    name: "a spread that pushes safeConsumption above the same ceiling",
    call: "public.set_tank_state('fuelstop-test', 20, now(), 90, 40, 150)",
    message: /consumption plus spread must be 100 per 100 km or less/,
  },
];
for (const rejected of rejects) {
  const attempt = psql(CONTAINER, DB, ["-c", `select ${rejected.call};`]);
  assert.notEqual(attempt.status, 0, `set_tank_state must refuse ${rejected.name}`);
  assert.match(
    attempt.stderr,
    rejected.message,
    `set_tank_state must refuse ${rejected.name} with its own message, not something incidental`,
  );
  checked += 1;
}
// The honest edge stays accepted: litres exactly at capacity, and consumption + spread
// exactly at the ceiling. A bound that rejects its own boundary would refuse a full
// tank, which is the single most common stamp there is.
assert.equal(
  run("select public.set_tank_state('fuelstop-test', 150, now(), 60, 40, 150) ->> 'applied';"),
  "true",
  "a full tank (litres == capacity) and a safe burn exactly at the ceiling must still be accepted",
);
checked += 1;

// ── Part 3d: the revision-carrying signature (GV-415) ───────────────────────────
// The seven-argument overload is the real fix; the six-argument one above is the
// compatibility surface govehlo-mobile still calls. Here the client tells the server which
// model revision it computed FROM, so the server no longer has to take a client-chosen
// freshness proof on trust — and the two failures the watermark could not express become
// two distinct, named refusals.
const modelRevision = () =>
  Number(run("select l.tank_model_revision from public.ledgers l where l.id = 'fuelstop-test';"));
const stampAtRevision = (liters, revision, asOf = "now()") =>
  JSON.parse(
    run(
      `select public.set_tank_state('fuelstop-test', ${liters}, ${asOf}, 5, 0, 150, ${revision}::bigint)::text;`,
    ),
  );

// The member gate is in-body and must hold on the new signature too — a new overload is a
// new door, and 148's revoke convention only closes it for anon.
const outsiderRevisioned = psql(CONTAINER, DB, [
  "-c",
  `select set_config('request.jwt.claims', '{"email":"stranger@test.dk"}', false);
   select public.set_tank_state('fuelstop-test', 11, now(), 5, 0, 150, 0::bigint);`,
]);
assert.notEqual(outsiderRevisioned.status, 0, "the revision-carrying set_tank_state must refuse a non-member");
assert.match(
  outsiderRevisioned.stderr,
  /Only an active workspace member can record tank state/,
  "the member gate must be the reason, on both overloads",
);
checked += 1;

// Part 3b's legacy writes already stamped the workspace's current revision, so move the
// model on before the first-writer-wins cases below — otherwise they would be measuring
// the conflict rule against a stamp left behind by the bounds tests.
if (
  psql(CONTAINER, DB, [
    "-c",
    `insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id)
     values ('fuelstop-test', current_date, 200, 300, '10000000-0000-0000-0000-000000000001');`,
  ]).status !== 0
) {
  fail("Could not move the tank model on before the revision cases.");
}

const currentRevision = modelRevision();
const firstAtRevision = stampAtRevision(12, currentRevision);
assert.equal(firstAtRevision.applied, true, "a stamp carrying the workspace's current model revision must apply");
assert.equal(
  Number(firstAtRevision.tank_state_revision),
  currentRevision,
  "the applied stamp must record the revision it was computed from, not the one it landed on",
);
checked += 1;

// Idempotence, the rule migration 155's `<=` existed to protect, now expressed on the
// revision instead: the offline outbox re-sends writes, and an identical re-send has to
// stay a quiet success or every retry would report a conflict the user cannot act on.
assert.equal(
  stampAtRevision(12, currentRevision).applied,
  true,
  "an IDENTICAL re-send at the same revision must still apply quietly — the offline outbox " +
    "re-sends writes, and first-writer-wins must not turn a retry into a conflict",
);
checked += 1;

// GV-415 finding 1 on the new signature. Within one revision the model inputs are
// identical, so two different answers cannot both be right and nothing in the data chooses
// between them. First writer wins; the second is refused rather than allowed to overwrite.
const sameRevisionOtherNumbers = stampAtRevision(13, currentRevision);
assert.equal(
  sameRevisionOtherNumbers.applied,
  false,
  "the same model revision carrying DIFFERENT numbers must be REFUSED, not applied. This is the " +
    "defect the watermark could not express: identical freshness proof, two different tank levels, " +
    "last writer wins (GV-415 finding 1).",
);
assert.equal(
  sameRevisionOtherNumbers.reason,
  "value_conflict",
  "a disagreement inside one revision must be named as a conflict, not as staleness — the client " +
    "cannot fix staleness by recomputing here, because nothing has changed to recompute from",
);
assert.equal(
  run("select l.tank_state_liters from public.ledgers l where l.id = 'fuelstop-test';"),
  "12",
  "a refused conflicting stamp must leave the first writer's numbers in place",
);
checked += 1;

// Move the model on. The insert goes through the ordinary table, not an RPC, which is the
// whole point of putting the bump on a trigger.
if (
  psql(CONTAINER, DB, [
    "-c",
    `insert into public.trips (ledger_id, trip_date, start_km, end_km, driver_member_id)
     values ('fuelstop-test', current_date, 300, 400, '10000000-0000-0000-0000-000000000001');`,
  ]).status !== 0
) {
  fail("Could not move the tank model on for the stale-revision case.");
}
const movedRevision = modelRevision();
assert.equal(
  movedRevision,
  currentRevision + 1,
  "an ordinary trip INSERT must move ledgers.tank_model_revision — that is the whole mechanism",
);
checked += 1;

const staleRevision = stampAtRevision(14, currentRevision);
assert.equal(
  staleRevision.applied,
  false,
  "a stamp computed from a revision the workspace has moved past must be refused",
);
assert.equal(staleRevision.reason, "stale_revision", "a superseded revision must say so");
assert.equal(
  Number(staleRevision.tank_model_revision),
  movedRevision,
  "the refusal must hand back the CURRENT revision, so the client knows what to recompute against",
);
checked += 1;

// A revision AHEAD of the workspace cannot be honest — the counter only ever increases, so
// no client can hold one the server has not reached. It raises rather than no-ops, exactly
// like the future-watermark check, because it is a bug or a fabrication, not a lost race.
const aheadRevision = psql(CONTAINER, DB, [
  "-c",
  `select public.set_tank_state('fuelstop-test', 14, now(), 5, 0, 150, ${movedRevision + 99}::bigint);`,
]);
assert.notEqual(aheadRevision.status, 0, "a revision ahead of the workspace must raise");
assert.match(
  aheadRevision.stderr,
  /model revision is ahead of the workspace/,
  "a revision from the future must be refused by its own check, not by something incidental",
);
checked += 1;

const missingRevision = psql(CONTAINER, DB, [
  "-c",
  "select public.set_tank_state('fuelstop-test', 14, now(), 5, 0, 150, null::bigint);",
]);
assert.notEqual(missingRevision.status, 0, "the revision-carrying signature must refuse a null revision");
assert.match(
  missingRevision.stderr,
  /needs the model revision it was computed from/,
  "a null revision must be refused as a missing revision, not silently treated as revision zero",
);
checked += 1;

// After a DELETION the client's watermark can legitimately move BACKWARDS: the newest row
// it could see is gone, so the newest greatest(created_at, updated_at) across what remains
// is older than the one it sent last time. Migration 155's monotonic `as_of` rule would
// refuse that stamp forever and freeze the tank state at the deleted row's timestamp. The
// revision orders these writes now, so an older watermark at a NEWER revision must apply.
const olderWatermarkNewerRevision = stampAtRevision(15, movedRevision, "now() - interval '2 hours'");
assert.equal(
  olderWatermarkNewerRevision.applied,
  true,
  "a NEWER revision carrying an OLDER watermark must apply. After a deletion the client's " +
    "watermark legitimately regresses, and refusing it would freeze the stamp at a row that no " +
    "longer exists.",
);
checked += 1;

// ── Part 3e: set_tank_state under a REAL interleaving (GV-411, extended by GV-415) ──
// This is the only check that can tell migration 155's set_tank_state from 154's, and now
// also the only one that can tell 156's conflict rule from a version that just lets the
// second writer win. Calling the RPC twice in a ROW passes under every implementation —
// the second call reads a committed row and refuses on that basis. The defect only exists
// while two calls OVERLAP, so the test has to produce that overlap rather than
// approximate it.
//
// dblink gives two extra sessions from inside one psql call, and dblink_send_query is
// asynchronous, which is what makes the interleaving deterministic rather than a race
// the test itself has to win:
//
//   A: begin; set_tank_state(the write that should win)  → holds the row lock, uncommitted
//   B: begin; set_tank_state(the write that should lose) → sent async, blocks on A's lock
//   (assert B really is blocked — otherwise the two never overlapped)
//   A: commit                                            → B unblocks
//   B: read the answer, commit
//
// Under 154: B's select ran BEFORE A committed, so it saw the pre-A state, passed the
// comparison, and its update — queued behind A's lock — lands LAST. B answers
// applied=true and the stored tank state is B's calculation. The guarantee is gone.
// Under 155/156: there is no separate select. B's conditional update re-evaluates its
// WHERE against the row version A committed (READ COMMITTED), matches nothing, and
// answers applied=false. A's numbers stay.
if (psql(CONTAINER, DB, ["-c", "create extension if not exists dblink;"]).status !== 0) {
  fail("Could not set up the interleaving probe (dblink unavailable?).");
}

// The probe runs entirely on the two dblink sessions; nothing it reports comes from the
// calling transaction's snapshot, which was taken before either of them committed. Both
// calls are passed in whole (GV-415) so the same machinery can drive the legacy watermark
// race and the revision race without two copies of it.
const probe = `
create or replace function public.gv415_race_probe(
  winner_call text,
  loser_call text
)
returns jsonb
language plpgsql
as $probe$
declare
  winner_result text;
  loser_result text;
  blocked integer := 0;
  attempts integer := 0;
begin
  perform dblink_connect('gv415_winner', 'dbname=' || current_database());
  perform dblink_connect('gv415_loser', 'dbname=' || current_database());
  perform dblink_exec('gv415_winner', 'begin');
  perform dblink_exec('gv415_loser', 'begin');

  -- A writes and keeps the row lock by staying open.
  select r into winner_result
  from dblink('gv415_winner', winner_call) as w(r text);

  -- B writes too. Asynchronous, so it can sit on A's lock while we watch.
  perform dblink_send_query('gv415_loser', loser_call);

  -- Wait until B is demonstrably blocked. pg_stat_activity is snapshotted per
  -- transaction, so the snapshot has to be cleared on every pass or this loop reads the
  -- same stale row 100 times.
  while attempts < 100 and blocked = 0 loop
    perform pg_sleep(0.1);
    perform pg_stat_clear_snapshot();
    select count(*) into blocked
    from pg_stat_activity a
    where a.datname = current_database()
      and a.pid <> pg_backend_pid()
      and a.wait_event_type = 'Lock'
      and a.query like '%set_tank_state%';
    attempts := attempts + 1;
  end loop;

  perform dblink_exec('gv415_winner', 'commit');

  select r into loser_result from dblink_get_result('gv415_loser') as l(r text);
  -- libpq hands back one result per send; the empty trailing one has to be drained or
  -- the next command on that connection errors with "another command is already in
  -- progress".
  perform * from dblink_get_result('gv415_loser') as l(r text);
  perform dblink_exec('gv415_loser', 'commit');
  perform dblink_disconnect('gv415_winner');
  perform dblink_disconnect('gv415_loser');

  return jsonb_build_object(
    'winner', winner_result::jsonb,
    'loser', loser_result::jsonb,
    'loser_blocked_on_winner', blocked > 0
  );
end;
$probe$;`;
if (psql(CONTAINER, DB, ["-c", probe]).status !== 0) {
  fail("Could not create the interleaving probe.");
}

const runRace = (winnerCall, loserCall) =>
  JSON.parse(
    run(
      `select public.gv415_race_probe(${sqlLiteral(winnerCall.replace(/'/g, "''"))},
                                      ${sqlLiteral(loserCall.replace(/'/g, "''"))})::text;`,
    ),
  );

// ── Race 1: the legacy watermark (migration 155's case, unchanged) ─────────────
if (
  psql(CONTAINER, DB, [
    "-c",
    `update public.ledgers l
        set tank_state_as_of = now() - interval '30 minutes',
            tank_state_liters = 20,
            tank_state_consumption = 5,
            tank_state_consumption_spread = 0,
            tank_state_capacity = 150,
            tank_state_revision = l.tank_model_revision
      where l.id = 'fuelstop-test';`,
  ]).status !== 0
) {
  fail("Could not reset the tank state for the watermark race.");
}

const watermarkRace = runRace(
  `select public.set_tank_state('fuelstop-test', 11, now() - interval '2 minutes', 5, 0, 150)::text`,
  `select public.set_tank_state('fuelstop-test', 42, now() - interval '10 minutes', 5, 0, 150)::text`,
);

assert.equal(
  watermarkRace.loser_blocked_on_winner,
  true,
  "the two stamps never overlapped — the loser was not waiting on the winner's row lock, so this " +
    "run proves nothing about concurrency. Sequential calls pass under the buggy implementation too.",
);
assert.equal(
  watermarkRace.winner.applied,
  true,
  "the stamp with the newer watermark must be the one that applies",
);
assert.equal(
  watermarkRace.loser.applied,
  false,
  "the concurrent stamp carrying the OLDER watermark must be refused. It passed a pre-lock read " +
    "of the watermark, so only a condition ON the update can catch it (migration 155); with the " +
    "read-compare-update of migration 154 it lands last and moves the tank level backwards.",
);
assert.equal(watermarkRace.loser.reason, "stale_as_of", "a lost race must keep its documented reason code");
assert.equal(
  run("select l.tank_state_liters from public.ledgers l where l.id = 'fuelstop-test';"),
  "11",
  "the winner's numbers must be what is stored. 42 here means the older calculation committed " +
    "last and overwrote the newer one — the exact backwards write the watermark exists to prevent.",
);
checked += 1;

// ── Race 2: two stamps at the SAME revision, overlapping (GV-415 finding 1) ────
// The whole point of the conflict rule is that the two calls are indistinguishable on
// freshness — same revision, same watermark, different numbers — so only the ORDER in
// which they land can decide, and the loser must be refused rather than allowed to
// overwrite. Sequential calls prove nothing here either: the second one would read a
// committed row and refuse under any implementation that checks at all. It has to be
// two calls holding the same row at the same time.
if (
  psql(CONTAINER, DB, [
    "-c",
    `update public.ledgers l
        set tank_state_as_of = now() - interval '30 minutes',
            tank_state_liters = 20,
            tank_state_consumption = 5,
            tank_state_consumption_spread = 0,
            tank_state_capacity = 150,
            tank_state_revision = l.tank_model_revision - 1
      where l.id = 'fuelstop-test';`,
  ]).status !== 0
) {
  fail("Could not reset the tank state for the revision race.");
}
const raceRevision = modelRevision();

const revisionRace = runRace(
  `select public.set_tank_state('fuelstop-test', 11, now(), 5, 0, 150, ${raceRevision}::bigint)::text`,
  `select public.set_tank_state('fuelstop-test', 42, now(), 5, 0, 150, ${raceRevision}::bigint)::text`,
);

assert.equal(
  revisionRace.loser_blocked_on_winner,
  true,
  "the two stamps never overlapped, so this run says nothing about the conflict rule under " +
    "concurrency — which is the only condition under which it can fail",
);
assert.equal(revisionRace.winner.applied, true, "the first stamp at a revision must apply");
assert.equal(
  revisionRace.loser.applied,
  false,
  "a CONCURRENT stamp at the same revision carrying different numbers must be refused. It read " +
    "the pre-winner row and saw an older tank_state_revision, so only a condition ON the update " +
    "catches it once the winner commits.",
);
assert.equal(
  revisionRace.loser.reason,
  "value_conflict",
  "the loser of a same-revision race must be told it disagreed, not that it was stale — nothing " +
    "moved on, so recomputing would produce the same refusal",
);
assert.equal(
  run("select l.tank_state_liters from public.ledgers l where l.id = 'fuelstop-test';"),
  "11",
  "the first writer's numbers must survive. 42 here means the conflict rule is not on the update " +
    "and the second writer overwrote the first — GV-415 finding 1, exactly as migration 155 left it.",
);
checked += 1;

// ── Part 4: the revision counter itself (GV-415) ────────────────────────────────
// Everything above tests what the two RPCs DO with ledgers.tank_model_revision. This tests
// the counter, which is a different claim and the one with more ways to be quietly wrong:
// the bump lives in triggers precisely so it also fires for writes that never reach an RPC
// (govehlo-web's admin console PATCHes deleted_at straight onto trips and fuel_payments),
// so every statement below is a plain table write with no RPC anywhere near it.
//
// The must-NOT-bump cases matter as much as the must-bump ones. Over-invalidation is not
// harmless here: the mobile service dedupes on the stamp payload, so a bump the client
// cannot see in its own numbers produces no re-stamp, and the workspace's reminders simply
// stop. period_id in particular is re-pointed across a whole queued period on every period
// open (promote_settlement_carryover_on_open, migration 140).
const counterRevision = () =>
  Number(run("select l.tank_model_revision from public.ledgers l where l.id = 'fuelstop-counter';"));

function bumpsBy(label, sql, expectedDelta) {
  const before = counterRevision();
  const result = psql(CONTAINER, DB, ["-c", sql]);
  if (result.status !== 0) fail(`Part 4 setup failed for "${label}":\n${result.stderr}\n--- SQL ---\n${sql}`);
  const after = counterRevision();
  assert.equal(
    after - before,
    expectedDelta,
    expectedDelta === 0
      ? `${label} must NOT move ledgers.tank_model_revision — it changes nothing the tank model ` +
          `reads, and a spurious bump silently switches this workspace's reminders off (the mobile ` +
          `service dedupes on the payload, so it will not re-stamp for a change it cannot see). ` +
          `Went from ${before} to ${after}.`
      : `${label} must move ledgers.tank_model_revision by ${expectedDelta}. Went from ${before} to ` +
          `${after}. A missing bump leaves a stamp reading as fresh over inputs that changed, which ` +
          `is what GV-415 findings 3 and 4 are.`,
  );
  checked += 1;
}

bumpsBy(
  "a trip INSERT",
  `insert into public.trips (legacy_id, ledger_id, trip_date, start_km, end_km, driver_member_id)
   values ('counter-1', 'fuelstop-counter', current_date, 100, 200, '10000000-0000-0000-0000-000000000012');`,
  1,
);
bumpsBy(
  "editing a trip's odometer",
  `update public.trips t set start_km = 150 where t.legacy_id = 'counter-1';`,
  1,
);
bumpsBy(
  "re-pointing a trip's period_id (migration 140's carryover promotion)",
  `update public.trips t set period_id = t.period_id where t.legacy_id = 'counter-1';`,
  0,
);
bumpsBy(
  "touching a trip's updated_at and nothing else",
  `update public.trips t set updated_at = now() where t.legacy_id = 'counter-1';`,
  0,
);
bumpsBy(
  "SOFT-deleting a trip (the admin console's PATCH, GV-415 finding 4)",
  `update public.trips t set deleted_at = now() where t.legacy_id = 'counter-1';`,
  1,
);
bumpsBy(
  "hard-deleting a trip",
  `delete from public.trips t where t.legacy_id = 'counter-1';`,
  1,
);
bumpsBy(
  "a fuel payment INSERT",
  `insert into public.fuel_payments (legacy_id, ledger_id, payment_date, amount, payer_member_id)
   values ('counter-fuel', 'fuelstop-counter', current_date, 400, '10000000-0000-0000-0000-000000000012');`,
  1,
);
bumpsBy(
  "SOFT-deleting a fuel payment",
  `update public.fuel_payments fp set deleted_at = now() where fp.legacy_id = 'counter-fuel';`,
  1,
);

// Statement-level, not row-level: the admin console's set-based soft delete stamps
// deleted_at on EVERY row of a workspace in ONE PATCH, and one bump is the right answer
// for one statement. A row-level trigger would rewrite the ledger row once per trip.
bumpsBy(
  "inserting three trips in one statement",
  `insert into public.trips (legacy_id, ledger_id, trip_date, start_km, end_km, driver_member_id)
   values ('counter-a', 'fuelstop-counter', current_date, 100, 200, '10000000-0000-0000-0000-000000000012'),
          ('counter-b', 'fuelstop-counter', current_date, 200, 300, '10000000-0000-0000-0000-000000000012'),
          ('counter-c', 'fuelstop-counter', current_date, 300, 400, '10000000-0000-0000-0000-000000000012');`,
  1,
);
bumpsBy(
  "soft-deleting all three in one statement",
  `update public.trips t set deleted_at = now()
   where t.ledger_id = 'fuelstop-counter' and t.deleted_at is null;`,
  1,
);

// GV-415 finding 3's other half: the car's own settings and baseline are model inputs the
// watermark never covered at all, because the client derives it only from trip and fuel
// rows.
bumpsBy(
  "changing the car's consumption setting",
  `update public.ledgers l set estimated_consumption_l_per_100km = 8 where l.id = 'fuelstop-counter';`,
  1,
);
bumpsBy(
  "writing the SAME consumption setting again",
  `update public.ledgers l set estimated_consumption_l_per_100km = 8 where l.id = 'fuelstop-counter';`,
  0,
);
bumpsBy(
  "changing the tank capacity",
  `update public.ledgers l set fuel_tank_capacity_l = 60 where l.id = 'fuelstop-counter';`,
  1,
);
bumpsBy(
  "changing the tank baseline (migration 092's anchor)",
  `update public.ledgers l set tank_baseline_odometer = 1000, tank_baseline_fraction = 0.5
   where l.id = 'fuelstop-counter';`,
  1,
);
bumpsBy(
  "re-recording an IDENTICAL tank baseline",
  `update public.ledgers l set tank_baseline_odometer = 1000, tank_baseline_fraction = 0.5,
                               tank_baseline_recorded_at = now()
   where l.id = 'fuelstop-counter';`,
  0,
);
bumpsBy(
  "renaming the workspace",
  `update public.ledgers l set name = 'Renamed' where l.id = 'fuelstop-counter';`,
  0,
);

removeContainer(CONTAINER);
finished = true;
console.log(
  `ok - fuel-stop verdict contract: ${checked} checks. The SQL in migrations 154/155/156 returns ` +
    "the same verdicts as govehlo-mobile/src/lib/fuel-stop-revalidation.ts for every scenario in " +
    "its vitest suite, a GVM-486 multi-stop plan reads exactly like a one-stop plan, a GVM-485 " +
    "plan carrying a separate way home reads exactly like one without it and still reports the " +
    "OUTBOUND stop, the claim's " +
    "due-ness and lease/token contract holds on BOTH freshness gates (a tombstone the stamp " +
    "already covers does not silence it; a deletion or a settings change after the stamp does), " +
    "set_tank_state is monotonic on its as_of watermark, bounded on its inputs, refuses a second " +
    "set of numbers under the same watermark or the same revision while staying idempotent on an " +
    "identical re-send, and holds both of those under a real interleaving of two overlapping " +
    "stamps — and ledgers.tank_model_revision moves for every trip, fuel, settings and baseline " +
    "change including soft deletes, and for nothing else.",
);

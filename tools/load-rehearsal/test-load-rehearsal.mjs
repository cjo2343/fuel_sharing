// Dependency-free unit tests for the load-rehearsal PURE logic (GV-317).
//
//   node tools/load-rehearsal/test-load-rehearsal.mjs
//   (also: npm run test:load-rehearsal)
//
// No Docker, no network — covers env parsing, the production-ref guard, arg
// parsing, deterministic fixture generation, the settlement-close snapshot math,
// and the INTERNAL SHAPE of lib/hotpaths.mjs (labels, limits, encoding).
//
// GV-493 adds the realtime/ETA phase: the Phoenix frame vocabulary, the refusal
// buckets, deterministic sharer selection, the fake-position rounding and the stats
// aggregation — plus a socket exercised against an in-memory fake, so the pending-ref
// plumbing is covered without a network.
//
// It does NOT verify that hotpaths.mjs matches govehlo-mobile — it cannot; the
// sibling repo is not checked out here. It used to claim it did, while asserting
// hotpaths.mjs against its own hardcoded copies of the same constants, which is a
// tautology that stays green exactly when the mirror is wrong. Two live drifts hid
// behind that wording for months (GV-393). The real cross-repo comparison is
// tools/check-hotpath-mirror.mjs, which reads ledger-data-gateway.ts itself and runs
// strict in .github/workflows/umbrella.yml. Do not re-add "mirrors the gateway"
// claims to the assertions below.
//
// This file IS wired into `npm run validate` (see tools/run-validations.mjs) — it is
// dependency-free and sub-second. The load TOOLING itself is not: it needs a live
// throwaway project, or Docker for the aged harness, and never runs in CI.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import {
  parseEnvFile,
  assertNotProd,
  loadEnv,
  parseArgs,
  mulberry32,
  makeRng,
  percentile,
  userEmail,
  userPassword,
  PROD_PROJECT_REF,
} from "./lib/common.mjs";
import {
  buildFixturePlan,
  buildAgedWorkspacePlan,
  computeSettlementsFromNets,
  buildCloseSnapshot,
  buildCloseProgram,
  settlementRequestArgs,
  AGED_DEFAULTS,
  SETTLEMENT_REQUEST_RPC,
  CLOSE_PERIOD_RPC,
} from "./lib/fixtures.mjs";
import {
  ledgerReadRequests,
  tripParticipantsRequest,
  EVENT_TYPE_EXCLUDE,
  SETTLE_ROW_CAP,
  SETTLEMENT_REQUEST_ROW_CAP,
  BOOKING_ROW_CAP,
  REPAIR_ROW_CAP,
  EXPENSE_ROW_CAP,
  RECURRING_ROW_CAP,
} from "./lib/hotpaths.mjs";
import { postgrestToSql, withLimit } from "./lib/hotpaths-sql.mjs";
import {
  WRITE_RPCS,
  ON_MY_WAY_RPCS,
  BOOKING_WRITE_RPC,
  VEHICLE_DOCUMENT_WORKSPACE_CAP,
  VEHICLE_DOCUMENTS_PER_VU,
} from "./lib/hotpaths.mjs";
import {
  vehicleDocumentArgs,
  vehicleDocumentPhotoArgs,
  onMyWaySetArgs,
  onMyWayClearArgs,
  sharerBookingWindow,
} from "./lib/fixtures.mjs";
import {
  presenceTopic,
  ledgerChangesTopic,
  realtimeSocketUrl,
  presenceJoinFrame,
  ledgerChangesJoinFrame,
  presenceTrackFrame,
  broadcastFrame,
  heartbeatFrame,
  encodeFrame,
  decodeFrame,
  interpretFrame,
  classifyJoinFailure,
  selectSharers,
  fakePosition,
  RealtimeStats,
  REALTIME_VSN,
  CHANNEL_PRESENCE,
  CHANNEL_LEDGER_CHANGES,
  ON_MY_WAY_POSITION_EVENT,
  LIVE_POSITION_INTERVAL_MS,
  LIVE_POSITION_DECIMALS,
  JOIN_FAILURE_REASONS,
  RealtimeSocket,
} from "./lib/realtime.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

// ── Env parsing ──────────────────────────────────────────────────────────────
test("parseEnvFile parses KEY=VALUE, ignores comments/blanks, strips quotes", () => {
  const env = parseEnvFile(
    ["# a comment", "", "SUPABASE_URL=https://throwaway.supabase.co", 'SUPABASE_ANON_KEY="quoted-key"', "export DBURL='postgresql://x'", "BAD LINE NO EQUALS"].join("\n"),
  );
  assert.equal(env.SUPABASE_URL, "https://throwaway.supabase.co");
  assert.equal(env.SUPABASE_ANON_KEY, "quoted-key");
  assert.equal(env.DBURL, "postgresql://x");
  assert.equal(env.BAD, undefined);
});

// ── Production guard (hard rule) ─────────────────────────────────────────────
test("assertNotProd throws when SUPABASE_URL carries the prod ref", () => {
  assert.throws(
    () => assertNotProd({ SUPABASE_URL: `https://${PROD_PROJECT_REF}.supabase.co` }),
    /production project ref/i,
  );
});
test("assertNotProd throws when DBURL carries the prod ref", () => {
  assert.throws(
    () => assertNotProd({ DBURL: `postgresql://postgres.${PROD_PROJECT_REF}:pw@aws.pooler.supabase.com:5432/postgres` }),
    /production project ref/i,
  );
});
test("assertNotProd passes for a throwaway project", () => {
  assert.doesNotThrow(() => assertNotProd({ SUPABASE_URL: "https://throwaway123.supabase.co", DBURL: "postgresql://postgres.throwaway123:pw@aws.pooler.supabase.com:5432/postgres" }));
});
test("loadEnv reports missing required keys and still runs the prod guard", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gv317-"));
  try {
    const good = path.join(dir, "ok.env");
    writeFileSync(good, "SUPABASE_URL=https://throwaway.supabase.co\n");
    assert.throws(() => loadEnv(good, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]), /missing required key/i);

    const prod = path.join(dir, "prod.env");
    writeFileSync(prod, `SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co\nSUPABASE_ANON_KEY=x\n`);
    assert.throws(() => loadEnv(prod, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]), /production project ref/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Arg parsing ──────────────────────────────────────────────────────────────
test("parseArgs handles flags, --key value and --key=value", () => {
  const a = parseArgs(["--env", "/tmp/x.env", "--vus", "50", "--mix=read", "--dry-run"], { flags: ["dry-run"] });
  assert.equal(a.env, "/tmp/x.env");
  assert.equal(a.vus, "50");
  assert.equal(a.mix, "read");
  assert.equal(a["dry-run"], true);
});

// ── PRNG determinism ─────────────────────────────────────────────────────────
test("mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});
test("makeRng.int and sample are bounded / distinct", () => {
  const r = makeRng(7);
  for (let i = 0; i < 200; i++) {
    const n = r.int(2, 8);
    assert.ok(n >= 2 && n <= 8);
  }
  const s = makeRng(7).sample([0, 1, 2, 3, 4], 3);
  assert.equal(s.length, 3);
  assert.equal(new Set(s).size, 3);
});

// ── Percentiles ──────────────────────────────────────────────────────────────
test("percentile nearest-rank", () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 100);
  assert.equal(percentile(xs, 99), 100);
  assert.equal(percentile([5], 95), 5);
});

// ── Deterministic identities ─────────────────────────────────────────────────
test("userEmail/userPassword are deterministic and well-formed", () => {
  assert.equal(userEmail(3, "rehearsal.vehloshare.test"), "load-u003@rehearsal.vehloshare.test");
  assert.equal(userPassword(3, 42), userPassword(3, 42));
  assert.notEqual(userPassword(3, 42), userPassword(3, 43));
  assert.match(userPassword(3, 42), /[A-Z]/);
  assert.match(userPassword(3, 42), /[0-9]/);
  assert.match(userPassword(3, 42), /[^A-Za-z0-9]/);
});

// ── Fixture determinism + invariants ─────────────────────────────────────────
test("buildFixturePlan is deterministic for a given seed", () => {
  const a = buildFixturePlan({ seed: 42, workspaces: 20 });
  const b = buildFixturePlan({ seed: 42, workspaces: 20 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = buildFixturePlan({ seed: 43, workspaces: 20 });
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});
test("buildFixturePlan sizes are 2..8, users == sum(sizes), owner is slot 0", () => {
  const plan = buildFixturePlan({ seed: 42, workspaces: 20 });
  assert.equal(plan.workspaces.length, 20);
  let sum = 0;
  for (const ws of plan.workspaces) {
    assert.ok(ws.memberCount >= 2 && ws.memberCount <= 8, `size ${ws.memberCount} out of range`);
    assert.equal(ws.members.length, ws.memberCount);
    assert.equal(ws.members[0].slot, 0);
    sum += ws.memberCount;
  }
  assert.equal(plan.totalUsers, sum);
  assert.equal(plan.users.length, sum);
});
test("buildFixturePlan targets ~100 users with 20 workspaces", () => {
  const plan = buildFixturePlan({ seed: 42, workspaces: 20 });
  assert.ok(plan.totalUsers >= 70 && plan.totalUsers <= 130, `unexpected user count ${plan.totalUsers}`);
});
test("trip odometer chains are monotonic within a period (end_km === next start_km)", () => {
  const plan = buildFixturePlan({ seed: 42, workspaces: 20 });
  for (const ws of plan.workspaces) {
    for (const period of ws.periods) {
      for (let i = 0; i < period.trips.length; i++) {
        const t = period.trips[i];
        assert.ok(t.endKm > t.startKm, "end_km must exceed start_km");
        if (i > 0) assert.equal(period.trips[i - 1].endKm, t.startKm, "chain must be contiguous");
      }
    }
  }
});
test("at least one workspace has a closed period (settlement history)", () => {
  const plan = buildFixturePlan({ seed: 42, workspaces: 20 });
  const closed = plan.workspaces.filter((ws) => ws.periods.some((p) => p.closeAfter)).length;
  assert.ok(closed >= 1, "expected at least one closed period");
});

// ── Settlement close math ────────────────────────────────────────────────────
test("computeSettlementsFromNets zeroes each member's flow to -net", () => {
  const people = [
    { id: "a", net: 300 },
    { id: "b", net: -120 },
    { id: "c", net: -180 },
  ];
  const settlements = computeSettlementsFromNets(people);
  for (const p of people) {
    const outflow = settlements.filter((s) => s.fromId === p.id).reduce((n, s) => n + s.amount, 0);
    const inflow = settlements.filter((s) => s.toId === p.id).reduce((n, s) => n + s.amount, 0);
    assert.ok(Math.abs(outflow - inflow + p.net) < 0.02, `flow mismatch for ${p.id}`);
  }
  assert.ok(settlements.every((s) => s.currency === "DKK"));
});
test("buildCloseSnapshot copies server figures and satisfies the close gate tolerances", () => {
  const computed = {
    totalKm: 420,
    totalPaid: 900.5,
    people: [
      { id: "aaaa", name: "F", km: 300, fuelPaid: 900.5, expenseShare: 0, net: 257.5 },
      { id: "bbbb", name: "E", km: 120, fuelPaid: 0, expenseShare: 0, net: -257.5 },
    ],
  };
  const snap = buildCloseSnapshot(computed);
  assert.equal(snap.totalKm, 420);
  assert.equal(snap.totalPaid, 900.5);
  assert.equal(snap.people.length, 2);
  // Per-member km/fuelPaid/net copied verbatim (gate tolerance 0.02).
  for (const cp of computed.people) {
    const sp = snap.people.find((p) => p.id === cp.id);
    assert.equal(sp.km, cp.km);
    assert.equal(sp.fuelPaid, cp.fuelPaid);
    assert.equal(sp.net, cp.net);
  }
  // Settlement flow matches nets (gate (c)).
  const flow = snap.settlements.filter((s) => s.fromId === "bbbb").reduce((n, s) => n + s.amount, 0);
  assert.ok(Math.abs(flow - 257.5) < 0.02);
  // entryFingerprint deliberately omitted so the RPC null-skips that gate.
  assert.equal("entryFingerprint" in snap, false);
});

// ── Close sequence: request every settlement, THEN close (GV-438) ────────────
// The GVM-533 rehearsal closed ZERO periods: close_settlement_period raises 42501
// ("All settlements must be requested at their current amounts before this period
// can be closed") unless every pair that moves money already has a
// settlement_requests row for the period at exactly that amount. These pin the
// sequence the seeder must follow, which is the whole fix.
const CLOSE_COMPUTED = {
  totalKm: 900,
  totalPaid: 1800,
  people: [
    { id: "aaaa", name: "F", km: 200, fuelPaid: 1800, net: 1200 },
    { id: "bbbb", name: "E", km: 400, fuelPaid: 0, net: -800 },
    { id: "cccc", name: "I", km: 300, fuelPaid: 0, net: -400 },
  ],
};

test("buildCloseProgram requests EVERY money-moving pair before the close", () => {
  const program = buildCloseProgram(CLOSE_COMPUTED, { ledgerId: "delebil-x", periodId: "period-1" });
  const paying = program.snapshot.settlements.filter((s) => s.amount > 0);
  assert.ok(paying.length >= 2, "expected at least two outstanding pairs in this fixture");
  assert.equal(program.requests.length, paying.length);
  for (const settlement of paying) {
    const match = program.requests.find(
      (r) => r.args.payer_member_id === settlement.fromId && r.args.recipient_member_id === settlement.toId,
    );
    assert.ok(match, `no request built for ${settlement.fromId}->${settlement.toId}`);
    // The amount must be the CURRENT one, to the cent: the close gate compares
    // settlement_requests.amount = round(snapshot amount, 2), and migration 117's
    // trigger independently recomputes it server-side.
    assert.equal(match.args.amount_value, settlement.amount);
    assert.equal(match.args.next_status, "requested");
    assert.equal(match.args.currency_value, "DKK");
    assert.equal(match.rpc, SETTLEMENT_REQUEST_RPC);
  }
  assert.equal(program.close.rpc, CLOSE_PERIOD_RPC);
  assert.equal(program.close.args.target_period_id, "period-1");
  assert.deepEqual(program.close.args.period_snapshot, program.snapshot);
});

test("buildCloseProgram carries the SAME snapshot it requested against (no re-derivation)", () => {
  const program = buildCloseProgram(CLOSE_COMPUTED, { ledgerId: "l", periodId: "p" });
  const requested = new Map(program.requests.map((r) => [`${r.args.payer_member_id}->${r.args.recipient_member_id}`, r.args.amount_value]));
  for (const s of program.close.args.period_snapshot.settlements) {
    if (s.amount <= 0) continue;
    assert.equal(requested.get(`${s.fromId}->${s.toId}`), s.amount, "a snapshot pair was closed without being requested at that amount");
  }
});

test("buildCloseProgram emits no request for a settled workspace (nothing to request, close proceeds)", () => {
  const program = buildCloseProgram(
    { totalKm: 100, totalPaid: 100, people: [{ id: "a", net: 0 }, { id: "b", net: 0 }] },
    { ledgerId: "l", periodId: "p" },
  );
  assert.equal(program.requests.length, 0);
  assert.equal(program.close.args.period_snapshot.settlements.length, 0);
});

test("settlementRequestArgs sends the 9-arg RPC shape the client sends", () => {
  const args = settlementRequestArgs({
    ledgerId: "l",
    periodId: "p",
    settlement: { fromId: "debtor", toId: "creditor", amount: 52, currency: "DKK" },
  });
  assert.deepEqual(Object.keys(args).sort(), [
    "amount_value", "currency_value", "current_pair_keys", "next_status", "p_note",
    "payer_member_id", "recipient_member_id", "target_ledger_id", "target_open_period_id",
  ]);
  assert.deepEqual(args.current_pair_keys, []);
  assert.equal(args.p_note, null);
});

// Both drivers must WALK that program rather than reinvent the sequence. This is a
// source scan on purpose: the bug it guards against is not wrong arithmetic, it is
// a close call that reaches the database with no requests in front of it — which is
// exactly what shipped in GVM-533 and read as perfectly reasonable code.
test("seed.mjs closes a period only after looping the program's requests", () => {
  const src = readFileSync(path.join(HERE, "seed.mjs"), "utf8");
  assert.ok(src.includes("buildCloseProgram"), "seed.mjs must build the close program");
  const body = src.slice(src.indexOf("async function closePeriod"));
  const requestLoop = body.indexOf("for (const request of program.requests)");
  const closeCall = body.indexOf("program.close.rpc");
  assert.ok(requestLoop > -1, "seed.mjs must send every settlement request");
  assert.ok(closeCall > -1, "seed.mjs must call the close RPC from the program");
  assert.ok(requestLoop < closeCall, "the requests must be sent BEFORE the close");
  assert.ok(
    /return \{\s*ok: false/.test(body.slice(requestLoop, closeCall)),
    "a failed settlement request must abort the close, not fall through to it",
  );
});

test("aged-local.mjs closes a period only after looping the program's requests", () => {
  const src = readFileSync(path.join(HERE, "aged-local.mjs"), "utf8");
  assert.ok(src.includes("buildCloseProgram"), "aged-local.mjs must build the close program");
  const sqlBody = src.slice(src.indexOf("function closeSql"));
  const requestCall = sqlBody.indexOf(SETTLEMENT_REQUEST_RPC);
  const closeCall = sqlBody.indexOf(CLOSE_PERIOD_RPC);
  assert.ok(requestCall > -1 && closeCall > -1);
  assert.ok(requestCall < closeCall, "the requests must run BEFORE the close in the SQL program");
});

// ── Aged workspace profile (GV-438) ──────────────────────────────────────────
test("aged profile appends ONE aged workspace and leaves the small ones byte-identical", () => {
  const plain = buildFixturePlan({ seed: 42, workspaces: 5 });
  const withAged = buildFixturePlan({ seed: 42, workspaces: 5, aged: true });
  assert.equal(withAged.workspaces.length, 6);
  assert.equal(JSON.stringify(withAged.workspaces.slice(0, 5)), JSON.stringify(plain.workspaces));
  assert.equal(JSON.stringify(withAged.users.slice(0, plain.users.length)), JSON.stringify(plain.users));
  assert.equal(withAged.workspaces[5].aged, true);
  assert.equal(withAged.totalUsers, plain.totalUsers + AGED_DEFAULTS.members);
});

test("aged profile is deterministic and produces thousands of trips/messages and SEVERAL closed periods", () => {
  const a = buildFixturePlan({ seed: 42, workspaces: 2, aged: true });
  const b = buildFixturePlan({ seed: 42, workspaces: 2, aged: true });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const aged = a.workspaces.find((w) => w.aged);
  const trips = aged.periods.reduce((n, p) => n + p.trips.length, 0);
  const messages = aged.periods.reduce((n, p) => n + p.messages.length, 0);
  const closed = aged.periods.filter((p) => p.closeAfter).length;
  assert.ok(trips >= 2000, `expected thousands of trips, got ${trips}`);
  assert.ok(messages >= 1000, `expected thousands of messages, got ${messages}`);
  assert.ok(closed >= 5, `expected several closed periods, got ${closed}`);
  assert.equal(aged.periods[aged.periods.length - 1].closeAfter, false, "the newest period must stay open");
});

test("aged odometer chain is monotonic ACROSS periods (a single logbook, not a reset per month)", () => {
  const aged = buildAgedWorkspacePlan({ seed: 42, periods: 4, tripsPerPeriod: 10 }).workspace;
  let last = null;
  for (const period of aged.periods) {
    for (const trip of period.trips) {
      assert.ok(trip.endKm > trip.startKm);
      if (last !== null) assert.equal(trip.startKm, last, "odometer chain broke between trips/periods");
      last = trip.endKm;
    }
  }
});

test("booking days within a workspace are distinct (prevent_overlapping_car_bookings)", () => {
  for (const seedValue of [42, 43, 7]) {
    const plan = buildFixturePlan({ seed: seedValue, workspaces: 8, aged: true });
    for (const ws of plan.workspaces) {
      const days = ws.bookings.map((b) => b.startAt.slice(0, 10));
      assert.equal(new Set(days).size, days.length, `${ws.name} books the same day twice`);
    }
  }
});

// ── PostgREST → SQL (the local leg measures the mirror, not a copy) ──────────
test("postgrestToSql translates each hot-path read faithfully", () => {
  const reads = ledgerReadRequests("delebil-aarhus-01");
  const sql = Object.fromEntries(reads.map((r) => [r.label, postgrestToSql(r)]));
  assert.equal(sql["read:ledger"], "select * from public.ledgers where id = 'delebil-aarhus-01' limit 1");
  assert.ok(sql["read:trips"].includes("deleted_at is null"));
  assert.ok(sql["read:trips"].endsWith(`order by trip_date DESC, id DESC limit ${SETTLE_ROW_CAP + 1}`));
  assert.ok(sql["read:members"].includes("is_active = true"));
  // The feed's exclusion list must survive the translation, in order.
  assert.ok(
    sql["read:events"].includes(`event_type not in (${EVENT_TYPE_EXCLUDE.map((t) => `'${t}'`).join(", ")})`),
    sql["read:events"],
  );
  assert.ok(sql["read:events"].endsWith("order by created_at DESC, id DESC limit 50"));
  assert.equal(
    postgrestToSql(tripParticipantsRequest(["t1", "t2"])),
    "select * from public.trip_participants where trip_id in ('t1', 't2')",
  );
});

test("postgrestToSql refuses a filter shape it does not understand (fails loud, never measures the wrong query)", () => {
  assert.throws(() => postgrestToSql({ table: "trips", query: "amount=gte.5" }), /Unsupported PostgREST operator/);
  assert.throws(() => postgrestToSql({ table: "trips", query: "select=*&offset=10" }), /Unsupported PostgREST offset/);
});

test("withLimit replaces the limit and labels the variant, leaving the mirror untouched", () => {
  const events = ledgerReadRequests("x").find((r) => r.label === "read:events");
  const capped = withLimit(events, 30);
  assert.equal(capped.label, "read:events@30");
  assert.ok(postgrestToSql(capped).endsWith("limit 30"));
  assert.ok(postgrestToSql(events).endsWith("limit 50"), "the original request must not be mutated");
});

// ── Hot-path SHAPE (internal consistency only) ───────────────────────────────
// These assert hotpaths.mjs's own structure. Whether it agrees with the real
// gateway is check-hotpath-mirror.mjs's job — see this file's header.
test("ledgerReadRequests mirrors the 12-query fan-out", () => {
  const reqs = ledgerReadRequests("delebil-aarhus-01");
  assert.equal(reqs.length, 12);
  const labels = reqs.map((r) => r.label);
  assert.deepEqual(
    [...labels].sort(),
    [
      "read:bookings", "read:events", "read:expenses", "read:fuel", "read:ledger",
      "read:members", "read:messages", "read:periods", "read:recurring",
      "read:repairs", "read:settlements", "read:trips",
    ],
  );
});

// ── Ordering and limit, EVERY read (GV-484) ──────────────────────────────────
// This used to pin trips, fuel and events and nothing else, which is how GVM-572's
// five new caps could be mirrored wrong without a red test. Each row here is the
// exact PostgREST ordering and the exact `cap + 1` sentinel the mobile fan-out sends;
// `null` means the gateway asks for no limit and neither may this.
//
// The orderings are not cosmetic. Each one is what makes its cap SAFE: newest-first
// keeps live-period money rows above the cut, `start_at` desc keeps active and future
// bookings at the head, and recurring is ASCENDING because what matters there is which
// templates are due. An `id` tiebreak turns each into a total order, which is what
// Historik's and the feed's keyset paging resume from. Replaying a different order
// under the same cap measures a different tail falling off — a rehearsal of a query
// the app does not send.
//
// Whether these still agree with govehlo-mobile is check-hotpath-mirror.mjs's job (it
// now compares ordering and limit too); these pin the mirror's own shape so a local
// edit to hotpaths.mjs cannot pass unnoticed where the sibling repo is absent.
const READ_SHAPES = [
  ["read:ledger", null, 1],
  ["read:members", "name.asc", null],
  ["read:periods", "opened_at.desc", null],
  ["read:trips", "trip_date.desc,id.desc", SETTLE_ROW_CAP + 1],
  ["read:fuel", "payment_date.desc,id.desc", SETTLE_ROW_CAP + 1],
  ["read:settlements", "created_at.desc,id.desc", SETTLEMENT_REQUEST_ROW_CAP + 1],
  ["read:bookings", "start_at.desc,id.desc", BOOKING_ROW_CAP + 1],
  ["read:events", "created_at.desc,id.desc", 50],
  ["read:repairs", "repair_date.desc,id.desc", REPAIR_ROW_CAP + 1],
  ["read:messages", "created_at.desc,id.desc", 50],
  ["read:expenses", "expense_date.desc,id.desc", EXPENSE_ROW_CAP + 1],
  ["read:recurring", "next_due_date.asc,id.asc", RECURRING_ROW_CAP + 1],
];

test("every read carries its exact ordering and limit", () => {
  const reqs = ledgerReadRequests("x");
  assert.equal(READ_SHAPES.length, reqs.length, "READ_SHAPES must cover every read in the fan-out");
  for (const [label, order, limit] of READ_SHAPES) {
    const entry = reqs.find((r) => r.label === label);
    assert.ok(entry, `no read labelled ${label}`);
    const params = new URLSearchParams(entry.query);
    assert.equal(params.get("order"), order, `${label} ordering`);
    assert.equal(params.get("limit"), limit == null ? null : String(limit), `${label} limit`);
  }
});

test("the capped reads use the +1 sentinel, not the cap itself (truncation must be provable)", () => {
  const reqs = ledgerReadRequests("x");
  const CAPS = [
    ["read:trips", SETTLE_ROW_CAP],
    ["read:fuel", SETTLE_ROW_CAP],
    ["read:settlements", SETTLEMENT_REQUEST_ROW_CAP],
    ["read:bookings", BOOKING_ROW_CAP],
    ["read:repairs", REPAIR_ROW_CAP],
    ["read:expenses", EXPENSE_ROW_CAP],
    ["read:recurring", RECURRING_ROW_CAP],
  ];
  for (const [label, cap] of CAPS) {
    const query = reqs.find((r) => r.label === label).query;
    assert.ok(query.includes(`limit=${cap + 1}`), `${label} must fetch cap + 1 rows`);
  }
});

test("every ordering ends on an id tiebreak, so each capped read is a total order", () => {
  for (const [label, order] of READ_SHAPES) {
    if (order == null || !order.includes(",")) continue;
    assert.match(order, /,id\.(asc|desc)$/, `${label} must break ties on id`);
    const [first, tiebreak] = order.split(",");
    assert.equal(
      first.split(".")[1],
      tiebreak.split(".")[1],
      `${label}: the tiebreak must run the same direction as the sort key`,
    );
  }
});

test("soft-delete filters: applied everywhere the gateway applies them, and NOT on bookings", () => {
  const reqs = ledgerReadRequests("x");
  const FILTERED = ["read:trips", "read:fuel", "read:repairs", "read:messages", "read:expenses", "read:recurring"];
  for (const label of FILTERED) {
    assert.ok(
      reqs.find((r) => r.label === label).query.includes("deleted_at=is.null"),
      `${label} must filter soft-deleted rows`,
    );
  }
  // GVM-388: cancelled bookings are soft-deletes the Historik tab lists, so the real
  // read returns them and this one must too.
  assert.ok(!reqs.find((r) => r.label === "read:bookings").query.includes("deleted_at"));
});

test("events read excludes every audit-only event type", () => {
  // The list, IN ORDER — check-hotpath-mirror.mjs compares it against the mobile
  // gateway's with join(","), so the order is the cross-repo contract and this
  // literal is where a careless re-sort is caught. The last two are migration 202's
  // "Jeg er på vej" refresh/stop rows (GVM-238 P0): a share re-computes its ETA every
  // ~5 minutes and each write must reach the other clients without reaching the feed.
  assert.deepEqual(EVENT_TYPE_EXCLUDE, [
    "payment_reminder_sent",
    "close_reminder_sent",
    "booking_completion_reminder_sent",
    "weekly_digest_sent",
    "booking_fuel_reminder_sent",
    "confirm_reminder_sent",
    "on_my_way_updated",
    "on_my_way_stopped",
  ]);
  const events = ledgerReadRequests("x").find((r) => r.label === "read:events");
  assert.ok(events.query.includes(`event_type=not.in.(${EVENT_TYPE_EXCLUDE.join(",")})`));
  assert.ok(events.query.includes("limit=50"));
});
test("ledger id is URL-encoded in read queries", () => {
  const reqs = ledgerReadRequests("a b/c");
  assert.ok(reqs[0].query.includes("id=eq.a%20b%2Fc"));
});
test("tripParticipantsRequest builds an in.() filter over trip ids", () => {
  const p = tripParticipantsRequest(["t1", "t2"]);
  assert.equal(p.table, "trip_participants");
  assert.equal(p.query, "select=*&trip_id=in.(t1,t2)");
});


// ═════════════════════════════════════════════════════════════════════════════
// GV-493 — the realtime / ETA phase
// ═════════════════════════════════════════════════════════════════════════════
//
// Same posture as the block above: these assert lib/realtime.mjs's OWN shape and its
// pure logic. They do NOT and cannot prove that the join config still matches
// govehlo-mobile's use-ledger-realtime.ts — the sibling repo is not checked out here —
// so do not add "mirrors the hook" wording to them. What they do catch is the class of
// edit that silently turns the rehearsal into a rehearsal of something else: a join that
// lost `private: true` (and so is authorised by nobody, which is the hole GVM-575
// closed), a presence key that stopped being the member id, a postgres_changes binding
// that lost its table (GVM-137: a filter with no table delivers NOTHING, silently), and
// a refusal bucket that stopped recognising the platform's own words.

// ── Phoenix frames ───────────────────────────────────────────────────────────
test("topics carry Phoenix's realtime: namespace and the client's own channel names", () => {
  assert.equal(presenceTopic("delebil-aarhus-01"), "realtime:presence-delebil-aarhus-01");
  assert.equal(ledgerChangesTopic("delebil-aarhus-01"), "realtime:ledger-changes-delebil-aarhus-01");
});

test("realtimeSocketUrl upgrades http→ws, keeps the vsn and encodes the key", () => {
  const url = realtimeSocketUrl("https://throwaway.supabase.co/", "a key/with+chars");
  assert.equal(
    url,
    `wss://throwaway.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent("a key/with+chars")}&vsn=${REALTIME_VSN}`,
  );
  assert.equal(REALTIME_VSN, "1.0.0");
});

test("the presence join is PRIVATE and keyed on the member id", () => {
  const frame = presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: 7 });
  assert.equal(frame.event, "phx_join");
  assert.equal(frame.topic, "realtime:presence-l1");
  assert.equal(frame.ref, "7");
  assert.equal(frame.join_ref, "7");
  // Policies bind PRIVATE channels only. Without this flag the join is authorised by
  // nobody and the rehearsal measures the pre-GVM-575 world.
  assert.equal(frame.payload.config.private, true);
  assert.equal(frame.payload.config.presence.key, "m1");
  assert.deepEqual(frame.payload.config.postgres_changes, []);
  assert.equal(frame.payload.access_token, "jwt");
});

test("the ledger-changes join is PRIVATE and binds ledger_events + messages, each WITH a table", () => {
  const frame = ledgerChangesJoinFrame({ ledgerId: "l1", accessToken: "jwt", ref: 2 });
  assert.equal(frame.topic, "realtime:ledger-changes-l1");
  assert.equal(frame.payload.config.private, true);
  const bindings = frame.payload.config.postgres_changes;
  assert.equal(bindings.length, 2, "one binding per published table — a wildcard binding cannot carry a filter");
  assert.deepEqual(bindings.map((b) => b.table), ["ledger_events", "messages"]);
  for (const b of bindings) {
    assert.equal(b.event, "*");
    assert.equal(b.schema, "public");
    // GVM-137: a filter without a table is invalid and Supabase silently delivers
    // nothing, which is exactly the failure a load run would not notice.
    assert.equal(b.filter, "ledger_id=eq.l1");
  }
});

test("presence track and broadcast ride the presence topic with the join's own join_ref", () => {
  const track = presenceTrackFrame({ ledgerId: "l1", ref: 9, joinRef: 1, onlineAt: "2026-08-18T10:00:00Z" });
  assert.equal(track.topic, "realtime:presence-l1");
  assert.equal(track.event, "presence");
  assert.equal(track.join_ref, "1");
  assert.deepEqual(track.payload, { type: "presence", event: "track", payload: { online_at: "2026-08-18T10:00:00Z" } });

  const bcast = broadcastFrame({ ledgerId: "l1", ref: 10, joinRef: 1, event: ON_MY_WAY_POSITION_EVENT, payload: { a: 1 } });
  assert.equal(bcast.topic, "realtime:presence-l1", "GVM-587 rides the PRESENCE topic, not a second channel");
  assert.equal(bcast.event, "broadcast");
  assert.deepEqual(bcast.payload, { type: "broadcast", event: "omw-position", payload: { a: 1 } });

  assert.deepEqual(heartbeatFrame(4), { topic: "phoenix", event: "heartbeat", ref: "4", payload: {} });
});

test("encodeFrame/decodeFrame round-trip, and decodeFrame never throws", () => {
  const frame = presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: 1 });
  assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
  assert.equal(decodeFrame("not json"), null);
  assert.equal(decodeFrame("[1,2,3]"), null, "an array is not a frame");
  assert.equal(decodeFrame("null"), null);
  assert.equal(decodeFrame(""), null);
});

// ── Reading the wire back ────────────────────────────────────────────────────
test("interpretFrame separates the reply from the refusal, the sync and the payload", () => {
  assert.deepEqual(
    interpretFrame({ topic: "t", event: "phx_reply", ref: "1", payload: { status: "ok", response: {} } }),
    { kind: "reply", topic: "t", ref: "1", status: "ok", reason: "{}" },
  );
  const refused = interpretFrame({
    topic: "t",
    event: "phx_reply",
    ref: "2",
    payload: { status: "error", response: { reason: "Unauthorized" } },
  });
  assert.equal(refused.status, "error");
  assert.equal(refused.reason, "Unauthorized");

  assert.equal(interpretFrame({ topic: "t", event: "phx_error", payload: { reason: "boom" } }).kind, "error");
  assert.equal(interpretFrame({ topic: "t", event: "phx_close", payload: {} }).kind, "error");
  assert.equal(interpretFrame({ topic: "t", event: "presence_state", payload: {} }).kind, "presence_sync");
  assert.equal(interpretFrame({ topic: "t", event: "presence_diff", payload: {} }).kind, "presence_sync");
  assert.equal(interpretFrame({ topic: "t", event: "postgres_changes", payload: {} }).kind, "postgres_changes");
  const bcast = interpretFrame({ topic: "t", event: "broadcast", payload: { event: "omw-position", payload: {} } });
  assert.equal(bcast.kind, "broadcast");
  assert.equal(bcast.broadcastEvent, "omw-position");
  assert.equal(interpretFrame({ topic: "t", event: "system", payload: { status: "error", message: "nope" } }).kind, "error");
  assert.equal(interpretFrame({ topic: "t", event: "system", payload: { status: "ok", message: "Subscribed" } }).kind, "system");
  assert.equal(interpretFrame(null).kind, "ignore");
  assert.equal(interpretFrame({ topic: "t", event: "phx_leave" }).kind, "ignore");
});

test("classifyJoinFailure recognises the platform's own words, and buckets the rest as `other`", () => {
  // The exact strings tools/probe-realtime-public-access.mjs matches on — the two tools
  // must name the same refusal the same way or the evidence cannot be read together.
  assert.equal(classifyJoinFailure("phx_reply status=error: PrivateOnly"), "PrivateOnly");
  assert.equal(classifyJoinFailure("privateonly"), "PrivateOnly");
  assert.equal(classifyJoinFailure("Unauthorized"), "Unauthorized");
  assert.equal(classifyJoinFailure('{"reason":"unauthorized"}'), "Unauthorized");
  assert.equal(classifyJoinFailure("timeout: no reply within 15000 ms"), "timeout");
  assert.equal(classifyJoinFailure("something nobody has seen"), "other");
  assert.equal(classifyJoinFailure(undefined), "other", "a missing reason is still a failure, never a pass");
  assert.deepEqual(JOIN_FAILURE_REASONS, ["Unauthorized", "PrivateOnly", "timeout", "other"]);
});

// ── Sharer selection ─────────────────────────────────────────────────────────
test("selectSharers is deterministic from the seed and picks the requested fraction", () => {
  const indices = Array.from({ length: 28 }, (_, i) => i);
  const a = selectSharers(indices, 0.2, 42);
  const b = selectSharers(indices, 0.2, 42);
  assert.deepEqual(a, b, "the same seed must put the ETA load on the same VUs");
  assert.notDeepEqual(a, selectSharers(indices, 0.2, 43));
  assert.equal(a.length, Math.round(28 * 0.2));
  assert.equal(new Set(a).size, a.length, "no VU may be selected twice");
  for (const i of a) assert.ok(indices.includes(i));
  assert.deepEqual(a, [...a].sort((x, y) => x - y), "returned in index order so the log reads sensibly");
});

test("selectSharers: 0 means none, 1 means all, and any positive fraction means at least one", () => {
  const indices = Array.from({ length: 8 }, (_, i) => i);
  assert.deepEqual(selectSharers(indices, 0, 42), []);
  assert.deepEqual(selectSharers(indices, 1, 42), indices);
  assert.deepEqual(selectSharers([], 0.5, 42), []);
  // A fraction that rounds to zero must NOT silently disable the phase.
  assert.equal(selectSharers(indices, 0.01, 42).length, 1);
  // Out-of-range values are clamped rather than producing a nonsense slice.
  assert.deepEqual(selectSharers(indices, 5, 42), indices);
  assert.deepEqual(selectSharers(indices, -1, 42), []);
  assert.deepEqual(selectSharers(indices, Number.NaN, 42), []);
});

// ── Positions ────────────────────────────────────────────────────────────────
test("fakePosition rounds to five decimals at the source and carries exactly the five wire fields", () => {
  const p = fakePosition({ bookingId: "b1", memberId: "m1", index: 3, tick: 7, now: 1234 });
  assert.deepEqual(Object.keys(p).sort(), ["bookingId", "lat", "lng", "memberId", "ts"]);
  assert.equal(p.bookingId, "b1");
  assert.equal(p.memberId, "m1");
  assert.equal(p.ts, 1234);
  for (const value of [p.lat, p.lng]) {
    assert.ok(Number.isFinite(value));
    // The client's own minimisation: round when the payload is BUILT, so nothing
    // downstream can widen it (GVM-587 / GVM-536).
    assert.equal(value, Math.round(value * 10 ** LIVE_POSITION_DECIMALS) / 10 ** LIVE_POSITION_DECIMALS);
  }
  assert.ok(p.lat >= -90 && p.lat <= 90);
  assert.ok(p.lng >= -180 && p.lng <= 180);
  // Deterministic for a given (index, tick) so two runs broadcast the same track.
  assert.deepEqual(fakePosition({ bookingId: "b1", memberId: "m1", index: 3, tick: 7, now: 1234 }), p);
});

test("fakePosition stays inside real coordinate bounds for every VU index and a long run", () => {
  for (const index of [0, 7, 19, 27, 99]) {
    for (const tick of [0, 1, 239, 240, 5000]) {
      const p = fakePosition({ bookingId: "b", memberId: "m", index, tick, now: 0 });
      assert.ok(p.lat >= -90 && p.lat <= 90, `lat out of range at ${index}/${tick}`);
      assert.ok(p.lng >= -180 && p.lng <= 180, `lng out of range at ${index}/${tick}`);
    }
  }
});

// ── Stats aggregation ────────────────────────────────────────────────────────
test("RealtimeStats aggregates join latency per channel with nearest-rank percentiles", () => {
  const stats = new RealtimeStats();
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) stats.recordJoin(CHANNEL_PRESENCE, ms);
  stats.recordJoin(CHANNEL_LEDGER_CHANGES, 5);
  const rows = stats.joinRows();
  assert.deepEqual(rows.map((r) => r.channel), [CHANNEL_LEDGER_CHANGES, CHANNEL_PRESENCE]);
  const presence = rows.find((r) => r.channel === CHANNEL_PRESENCE);
  assert.equal(presence.count, 10);
  assert.equal(presence.p50, 50);
  assert.equal(presence.p95, 100);
  assert.equal(presence.p99, 100);
  assert.equal(presence.max, 100);
});

test("RealtimeStats buckets failures by channel AND reason, and keeps a sample of the raw text", () => {
  const stats = new RealtimeStats();
  stats.recordJoinFailure(CHANNEL_PRESENCE, "phx_reply status=error: Unauthorized");
  stats.recordJoinFailure(CHANNEL_PRESENCE, "Unauthorized");
  stats.recordJoinFailure(CHANNEL_LEDGER_CHANGES, "timeout: no reply within 15000 ms");
  assert.deepEqual(stats.failureRows(), [
    { channel: CHANNEL_LEDGER_CHANGES, reason: "timeout", count: 1 },
    { channel: CHANNEL_PRESENCE, reason: "Unauthorized", count: 2 },
  ]);
  assert.equal(stats.totalJoinFailures(), 3);
  assert.equal(stats.failureSamples.length, 3);
  assert.match(stats.failureSamples[0].detail, /Unauthorized/);
});

test("RealtimeStats.hasFailures is the run's exit gate — clean is clean, every failure kind is loud", () => {
  const clean = new RealtimeStats();
  clean.recordJoin(CHANNEL_PRESENCE, 12);
  clean.presenceSyncs = 4;
  clean.broadcastsSent = 8;
  assert.equal(clean.hasFailures(), false);
  assert.deepEqual(clean.failureRows(), []);

  const refused = new RealtimeStats();
  refused.recordJoinFailure(CHANNEL_PRESENCE, "Unauthorized");
  assert.equal(refused.hasFailures(), true);

  const deadSocket = new RealtimeStats();
  deadSocket.socketsFailed = 1;
  assert.equal(deadSocket.hasFailures(), true);

  // A selected sharer that never got to share is a finding too: the ETA half of the
  // phase measured nothing, and a run that reported clean would be lying about it.
  const noSharer = new RealtimeStats();
  noSharer.sharerFailures = 1;
  assert.equal(noSharer.hasFailures(), true);
});

// ── The new HTTP write paths (migrations 201 / 202) ──────────────────────────
test("vehicleDocumentArgs / vehicleDocumentPhotoArgs send the RPCs' own argument names", () => {
  assert.deepEqual(vehicleDocumentArgs({ ledgerId: "l1", title: "Forsikring", expiryDate: "2027-06-30" }), {
    target_ledger_id: "l1",
    document_title: "Forsikring",
    document_expiry: "2027-06-30",
  });
  assert.equal(vehicleDocumentArgs({ ledgerId: "l1", title: "T" }).document_expiry, null);

  const photo = vehicleDocumentPhotoArgs({ ledgerId: "l1", documentId: "d1", token: "tok" });
  assert.deepEqual(Object.keys(photo).sort(), ["p_document_id", "p_storage_path"]);
  // Migration 201 compares the prefix with left(), not LIKE — the path must start with
  // the literal <ledger_id>/<document_id>/ or the RPC refuses it.
  assert.ok(photo.p_storage_path.startsWith("l1/d1/"), photo.p_storage_path);
});

test("the document mix cannot reach migration 201's per-workspace cap", () => {
  assert.equal(VEHICLE_DOCUMENT_WORKSPACE_CAP, 50);
  // Fixture workspaces hold 2–8 members, so the worst case is 8 VUs × the per-VU budget.
  assert.ok(
    VEHICLE_DOCUMENTS_PER_VU * 8 < VEHICLE_DOCUMENT_WORKSPACE_CAP,
    `${VEHICLE_DOCUMENTS_PER_VU} per VU × 8 members would reach the ${VEHICLE_DOCUMENT_WORKSPACE_CAP}-document cap and 23514 the run`,
  );
  assert.equal(WRITE_RPCS.document, "create_vehicle_document");
  assert.equal(WRITE_RPCS.documentPhoto, "add_vehicle_document_photo");
});

test("onMyWaySetArgs carries event copy on the FIRST call only (one drive home, one feed entry)", () => {
  const first = onMyWaySetArgs({ ledgerId: "l1", legacyBookingId: "b1", etaMinutes: 12, first: true });
  assert.deepEqual(Object.keys(first).sort(), [
    "eta_minutes", "event_body", "event_title", "legacy_booking_id", "target_ledger_id",
  ]);
  assert.equal(first.eta_minutes, 12);
  assert.ok(first.event_title, "the first share writes the feed-visible on_my_way_started");

  const refresh = onMyWaySetArgs({ ledgerId: "l1", legacyBookingId: "b1", etaMinutes: 12, first: false });
  // Without a title the RPC writes the audit-only on_my_way_updated. A title on every
  // ~5-minute refresh is what turns one drive home into eight feed entries.
  assert.equal(refresh.event_title, null);
  assert.equal(refresh.event_body, null);

  assert.deepEqual(onMyWayClearArgs({ ledgerId: "l1", legacyBookingId: "b1" }), {
    target_ledger_id: "l1",
    legacy_booking_id: "b1",
  });
  assert.equal(ON_MY_WAY_RPCS.set, "set_on_my_way");
  assert.equal(ON_MY_WAY_RPCS.clear, "clear_on_my_way");
  assert.equal(BOOKING_WRITE_RPC, "upsert_car_booking");
});

test("sharerBookingWindow is in the FUTURE and gives each VU its own day", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");
  const a = sharerBookingWindow({ index: 0, now });
  const b = sharerBookingWindow({ index: 1, now });
  // Migration 202 refuses a share on a booking that has ended, and the fixture's own
  // bookings are anchored at 2026-07-01 — all of them are over by any real run date.
  assert.ok(Date.parse(a.endAt) > now);
  assert.ok(Date.parse(a.startAt) > now);
  assert.ok(Date.parse(a.endAt) > Date.parse(a.startAt));
  // prevent_overlapping_car_bookings refuses a second booking on a taken day, so two
  // sharers in one workspace must never draw the same one.
  assert.notEqual(a.startAt.slice(0, 10), b.startAt.slice(0, 10));
  const days = new Set(Array.from({ length: 40 }, (_, i) => sharerBookingWindow({ index: i, now }).startAt.slice(0, 10)));
  assert.equal(days.size, 40);
});

// ── The driver must FAIL LOUD (source scan, like the close-program ones above) ──
// The bug this guards against is not wrong arithmetic: it is a realtime phase whose
// joins were all refused reporting a clean run, which reads as perfectly reasonable code
// and would turn "we rehearsed private channels at 100 users" into a sentence with no
// evidence under it.
test("load.mjs exits non-zero when the realtime phase produced failures", () => {
  const src = readFileSync(path.join(HERE, "load.mjs"), "utf8");
  assert.ok(src.includes("hasFailures()"), "load.mjs must consult RealtimeStats.hasFailures()");
  assert.match(src, /rt\?\.hasFailures\(\)[\s\S]{0,200}process\.exit\(1\)/, "a failed realtime phase must exit 1");
  // --realtime without a global WebSocket must refuse to run rather than skip silently.
  assert.ok(src.includes('typeof WebSocket !== "function"'), "load.mjs must refuse --realtime without a global WebSocket");
  // Both channels, opened PRIVATE, on ONE socket per VU.
  assert.ok(src.includes("presenceJoinFrame") && src.includes("ledgerChangesJoinFrame"));
  assert.ok(src.includes("clear_on_my_way") || src.includes("ON_MY_WAY_RPCS.clear"), "every share must be cleared at teardown");
});

test("the write mix keeps every write RPC reachable (a slot nothing routes to is dead code)", () => {
  const src = readFileSync(path.join(HERE, "load.mjs"), "utf8");
  for (const rpc of Object.keys(WRITE_RPCS)) {
    assert.ok(src.includes(`WRITE_RPCS.${rpc}`), `nothing in load.mjs calls WRITE_RPCS.${rpc}`);
  }
  assert.equal(LIVE_POSITION_INTERVAL_MS, 15_000, "GVM-587 decision 4: the sharer broadcasts every 15 s");
  assert.equal(ON_MY_WAY_POSITION_EVENT, "omw-position");
});



// ── The socket itself, against an in-memory fake ─────────────────────────────
// No network and no Docker: a hand-rolled WebSocket stand-in that replays whatever
// frames the test hands it. What this covers is the plumbing that only shows up in a
// live run and would otherwise be discovered there — the pending-ref map (a reply must
// resolve the join that asked for it and nothing else), the topic-level error path (a
// phx_error must be filed as the refusal it is, not as the timeout it would become), and
// the guarantee that a refusal is RECORDED rather than swallowed.

function fakeSocketClass(script) {
  return class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      this.closed = false;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(text) {
      this.sent.push(text);
      const reply = script(decodeFrame(text), this);
      if (reply) queueMicrotask(() => this.emit("message", { data: encodeFrame(reply) }));
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  };
}

const asyncTests = [];
function asyncTest(name, fn) {
  asyncTests.push([name, fn]);
}

asyncTest("RealtimeSocket: an accepted join is recorded with its latency, a refusal with its reason", async () => {
  const stats = new RealtimeStats();
  const WebSocketImpl = fakeSocketClass((frame) => {
    if (frame?.event !== "phx_join") return null;
    const ok = frame.topic.startsWith("realtime:presence-");
    return {
      topic: frame.topic,
      event: "phx_reply",
      ref: frame.ref,
      payload: ok ? { status: "ok", response: {} } : { status: "error", response: { reason: "Unauthorized" } },
    };
  });
  const socket = new RealtimeSocket({ url: "wss://x", stats, timeoutMs: 500, WebSocketImpl });
  const opened = await socket.connect();
  assert.equal(opened.ok, true);

  const presence = await socket.join(
    CHANNEL_PRESENCE,
    presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: socket.nextRef() }),
  );
  assert.equal(presence.ok, true);
  assert.equal(stats.joinRows().find((r) => r.channel === CHANNEL_PRESENCE).count, 1);
  assert.equal(socket.joinRefFor(CHANNEL_PRESENCE), "1");

  const changes = await socket.join(
    CHANNEL_LEDGER_CHANGES,
    ledgerChangesJoinFrame({ ledgerId: "l1", accessToken: "jwt", ref: socket.nextRef() }),
  );
  assert.equal(changes.ok, false);
  assert.match(changes.reason, /Unauthorized/);
  assert.deepEqual(stats.failureRows(), [{ channel: CHANNEL_LEDGER_CHANGES, reason: "Unauthorized", count: 1 }]);
  assert.equal(stats.hasFailures(), true, "a refused join must make the run exit non-zero");
  socket.close();
});

asyncTest("RealtimeSocket: a topic-level phx_error resolves the outstanding join as that refusal, not as a timeout", async () => {
  const stats = new RealtimeStats();
  const WebSocketImpl = fakeSocketClass((frame) => {
    if (frame?.event !== "phx_join") return null;
    return { topic: frame.topic, event: "phx_error", payload: { reason: "PrivateOnly" } };
  });
  const socket = new RealtimeSocket({ url: "wss://x", stats, timeoutMs: 500, WebSocketImpl });
  await socket.connect();
  const result = await socket.join(
    CHANNEL_PRESENCE,
    presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: socket.nextRef() }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(stats.failureRows(), [{ channel: CHANNEL_PRESENCE, reason: "PrivateOnly", count: 1 }]);
  socket.close();
});

asyncTest("RealtimeSocket: silence is a timeout, and it is a FAILURE rather than a skip", async () => {
  const stats = new RealtimeStats();
  const WebSocketImpl = fakeSocketClass(() => null); // never answers
  const socket = new RealtimeSocket({ url: "wss://x", stats, timeoutMs: 40, WebSocketImpl });
  await socket.connect();
  const result = await socket.join(
    CHANNEL_PRESENCE,
    presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: socket.nextRef() }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(stats.failureRows(), [{ channel: CHANNEL_PRESENCE, reason: "timeout", count: 1 }]);
  assert.equal(stats.joinRows().length, 0);
  socket.close();
});

asyncTest("RealtimeSocket: presence syncs, postgres_changes and broadcasts are counted", async () => {
  const stats = new RealtimeStats();
  const WebSocketImpl = fakeSocketClass((frame) =>
    frame?.event === "phx_join"
      ? { topic: frame.topic, event: "phx_reply", ref: frame.ref, payload: { status: "ok", response: {} } }
      : null);
  const socket = new RealtimeSocket({ url: "wss://x", stats, timeoutMs: 500, WebSocketImpl });
  await socket.connect();
  await socket.join(
    CHANNEL_PRESENCE,
    presenceJoinFrame({ ledgerId: "l1", memberId: "m1", accessToken: "jwt", ref: socket.nextRef() }),
  );
  const topic = presenceTopic("l1");
  socket.onMessage({ data: encodeFrame({ topic, event: "presence_state", payload: {} }) });
  socket.onMessage({ data: encodeFrame({ topic, event: "presence_diff", payload: {} }) });
  socket.onMessage({ data: encodeFrame({ topic, event: "postgres_changes", payload: {} }) });
  socket.onMessage({ data: encodeFrame({ topic, event: "broadcast", payload: { event: ON_MY_WAY_POSITION_EVENT, payload: {} } }) });
  socket.onMessage({ data: "not json at all" });
  assert.equal(stats.presenceSyncs, 2);
  assert.equal(stats.postgresChanges, 1);
  assert.equal(stats.broadcastsReceived, 1);
  assert.equal(stats.hasFailures(), false);
  socket.close();
});

asyncTest("RealtimeSocket: sendRaw refuses to send on a closed socket and reports it", async () => {
  const stats = new RealtimeStats();
  const WebSocketImpl = fakeSocketClass(() => null);
  const socket = new RealtimeSocket({ url: "wss://x", stats, timeoutMs: 100, WebSocketImpl });
  await socket.connect();
  assert.equal(socket.sendRaw(heartbeatFrame(1)), true);
  socket.close();
  assert.equal(socket.sendRaw(heartbeatFrame(2)), false, "a broadcast on a dead socket must not be counted as sent");
});

for (const [name, fn] of asyncTests) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

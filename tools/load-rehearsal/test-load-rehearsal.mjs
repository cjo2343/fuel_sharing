// Dependency-free unit tests for the load-rehearsal PURE logic (GV-317).
//
//   node tools/load-rehearsal/test-load-rehearsal.mjs
//   (also: npm run test:load-rehearsal)
//
// No Docker, no network — covers env parsing, the production-ref guard, arg
// parsing, deterministic fixture generation, the settlement-close snapshot math,
// and the INTERNAL SHAPE of lib/hotpaths.mjs (labels, limits, encoding).
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
// This is
// intentionally a STANDALONE script (not wired into `npm run validate`) so it
// doesn't change the behaviour of the existing validation tools; the load
// tooling itself needs a live throwaway project and is never run in CI.

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
} from "./lib/hotpaths.mjs";
import { postgrestToSql, withLimit } from "./lib/hotpaths-sql.mjs";

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
  assert.ok(sql["read:trips"].endsWith(`order by trip_date DESC limit ${SETTLE_ROW_CAP + 1}`));
  assert.ok(sql["read:members"].includes("is_active = true"));
  // The feed's exclusion list must survive the translation, in order.
  assert.ok(
    sql["read:events"].includes(`event_type not in (${EVENT_TYPE_EXCLUDE.map((t) => `'${t}'`).join(", ")})`),
    sql["read:events"],
  );
  assert.ok(sql["read:events"].endsWith("order by created_at DESC limit 100"));
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
  assert.ok(postgrestToSql(events).endsWith("limit 100"), "the original request must not be mutated");
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
test("trips and fuel reads carry the +1 truncation sentinel and soft-delete filter", () => {
  const reqs = ledgerReadRequests("x");
  const trips = reqs.find((r) => r.label === "read:trips");
  const fuel = reqs.find((r) => r.label === "read:fuel");
  assert.ok(trips.query.includes(`limit=${SETTLE_ROW_CAP + 1}`));
  assert.ok(trips.query.includes("deleted_at=is.null"));
  assert.ok(trips.query.includes("order=trip_date.desc"));
  assert.ok(fuel.query.includes(`limit=${SETTLE_ROW_CAP + 1}`));
  assert.ok(fuel.query.includes("order=payment_date.desc"));
});
test("events read excludes every reminder-audit event type", () => {
  assert.deepEqual(EVENT_TYPE_EXCLUDE, [
    "payment_reminder_sent",
    "close_reminder_sent",
    "booking_completion_reminder_sent",
    "weekly_digest_sent",
    "booking_fuel_reminder_sent",
    "confirm_reminder_sent",
  ]);
  const events = ledgerReadRequests("x").find((r) => r.label === "read:events");
  assert.ok(events.query.includes(`event_type=not.in.(${EVENT_TYPE_EXCLUDE.join(",")})`));
  assert.ok(events.query.includes("limit=100"));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

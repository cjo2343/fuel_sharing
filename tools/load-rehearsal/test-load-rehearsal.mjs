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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  computeSettlementsFromNets,
  buildCloseSnapshot,
} from "./lib/fixtures.mjs";
import {
  ledgerReadRequests,
  tripParticipantsRequest,
  EVENT_TYPE_EXCLUDE,
  SETTLE_ROW_CAP,
} from "./lib/hotpaths.mjs";

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

// GV-317 load rehearsal — step 3: the load driver.
//
//   npm run load:run -- --env /path/to/rehearsal.env [--vus 20] [--duration 30]
//                       [--mix read|mixed] [--seed 42] [--rls-probe] [--dry-run]
//
// Pure Node (no k6). Concurrent virtual users (VUs) sign in with the same
// deterministic identities seed.mjs created (password grant), then hammer the
// exact authenticated hot paths the mobile app runs — mirrored from
// govehlo-mobile in lib/hotpaths.mjs:
//
//   • list_my_ledgers                 (resolveActiveLedgerId — the workspace list)
//   • the 12-query LedgerContext read fan-out + the dependent trip_participants read
//   • calculate_period_settlement     (the settlement-balance computation path)
//   • a write mix (mixed only): upsert_trip_with_participants, upsert_fuel_payment,
//     post_message (the feed write)
//
// It collects per-endpoint latency (p50/p95/p99/max), error counts by status, and
// prints a single evidence block at the end.
//
// --rls-probe runs the tenant-isolation probe instead of the load: N members
// concurrently try to READ rows OUTSIDE their own workspaces. RLS must return
// zero rows / permission errors; ANY leaked row fails the run loudly (exit 1).
//
// --dry-run prints the exact request set (URLs, RPC args, write payloads) WITHOUT
// any network, so the hot-path coverage can be reviewed before a live run.

import {
  loadEnv,
  parseArgs,
  makeSupabase,
  signInWithPassword,
  rpcCall,
  restGet,
  runPool,
  userEmail,
  userPassword,
  Metrics,
  DEFAULT_EMAIL_DOMAIN,
  sleep,
} from "./lib/common.mjs";
import {
  ledgerReadRequests,
  tripParticipantsRequest,
  WORKSPACE_LIST_RPC,
  SETTLEMENT_CALC_RPC,
  WRITE_RPCS,
} from "./lib/hotpaths.mjs";
import { tripArgs, fuelArgs, messageArgs } from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), { flags: ["dry-run", "rls-probe"] });
const vus = Number(args.vus ?? 20);
const durationSec = Number(String(args.duration ?? "30").replace(/s$/, ""));
const mix = args.mix === "read" ? "read" : "mixed";
const seed = Number(args.seed ?? 42);
const emailDomain = args["email-domain"] ?? DEFAULT_EMAIL_DOMAIN;
const dryRun = Boolean(args["dry-run"]);
const rlsProbe = Boolean(args["rls-probe"]);

if (dryRun) {
  runDryRun();
  process.exit(0);
}

let env;
try {
  env = loadEnv(args.env, ["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const supa = makeSupabase(env);

await main().catch((err) => {
  console.error(`❌ Load run failed: ${err.stack || err.message}`);
  process.exit(1);
});

async function main() {
  console.log(`⏳ Signing in ${vus} virtual users…`);
  const sessions = await signInVus();
  const ready = sessions.filter((s) => s && s.ledgerId);
  console.log(`   ${ready.length}/${vus} VUs ready (signed in + workspace resolved).`);
  if (ready.length === 0) {
    console.error("❌ No VUs could sign in — did you run load:seed against this project with the same --seed?");
    process.exit(1);
  }

  if (rlsProbe) {
    await runRlsProbe(ready);
    return;
  }

  await runLoad(ready);
}

// Sign in users 0..vus-1 and resolve each one's workspace + open period, exactly
// as the app does on launch.
async function signInVus() {
  const indices = Array.from({ length: vus }, (_, i) => i);
  return runPool(indices, Math.min(8, vus), async (i) => {
    const email = userEmail(i, emailDomain);
    const password = userPassword(i, seed);
    const auth = await signInWithPassword(supa, { email, password });
    if (!auth.ok || !auth.json?.access_token) return null;
    const token = auth.json.access_token;
    const list = await rpcCall(supa, token, WORKSPACE_LIST_RPC, {});
    const row = Array.isArray(list.json) && list.json[0] ? list.json[0] : null;
    if (!row) return { token, ledgerId: null };
    const openPeriodId = await fetchOpenPeriodId(token, row.ledger_id);
    return { index: i, token, ledgerId: row.ledger_id, memberId: row.member_id, openPeriodId };
  });
}

async function fetchOpenPeriodId(token, ledgerId) {
  const res = await restGet(supa, token, "settlement_periods",
    `select=id&ledger_id=eq.${encodeURIComponent(ledgerId)}&status=eq.open&limit=1`);
  if (res.ok && Array.isArray(res.json) && res.json[0]) return res.json[0].id;
  return null;
}

async function timed(metrics, label, fn) {
  const start = performance.now();
  let res;
  try {
    res = await fn();
  } catch (err) {
    const ms = performance.now() - start;
    metrics.record(label, ms, 0);
    metrics.recordError(label, 0, err.message);
    return { ok: false, status: 0, json: null };
  }
  const ms = performance.now() - start;
  metrics.record(label, ms, res.status);
  if (!res.ok) metrics.recordError(label, res.status, (res.text || "").slice(0, 120));
  return res;
}

// One VU's iteration: workspace list → read fan-out → settlement calc → (mixed) a write.
async function vuIteration(metrics, s, iter) {
  await timed(metrics, `rpc:${WORKSPACE_LIST_RPC}`, () => rpcCall(supa, s.token, WORKSPACE_LIST_RPC, {}));

  const reads = ledgerReadRequests(s.ledgerId);
  const results = await Promise.all(
    reads.map((r) => timed(metrics, r.label, () => restGet(supa, s.token, r.table, r.query))),
  );
  // Dependent trip_participants read, mirroring the gateway.
  const tripsRes = results[reads.findIndex((r) => r.label === "read:trips")];
  const tripIds = Array.isArray(tripsRes?.json) ? tripsRes.json.map((t) => t.id).filter(Boolean).slice(0, 200) : [];
  if (tripIds.length > 0) {
    const p = tripParticipantsRequest(tripIds);
    await timed(metrics, p.label, () => restGet(supa, s.token, p.table, p.query));
  }

  // Settlement-balance computation path.
  if (s.openPeriodId) {
    await timed(metrics, `rpc:${SETTLEMENT_CALC_RPC}`, () =>
      rpcCall(supa, s.token, SETTLEMENT_CALC_RPC, {
        target_ledger_id: s.ledgerId,
        target_period_id: s.openPeriodId,
      }));
  }

  // Write mix: ~1 in 5 iterations does a write (mixed mode only).
  if (mix === "mixed" && s.openPeriodId && s.memberId && iter % 5 === 0) {
    const choice = iter % 15;
    if (choice === 0) {
      const startKm = 100000 + iter;
      await timed(metrics, `rpc:${WRITE_RPCS.trip}`, () =>
        rpcCall(supa, s.token, WRITE_RPCS.trip,
          tripArgs({
            ledgerId: s.ledgerId,
            openPeriodId: s.openPeriodId,
            legacyId: `load-${s.index}-${iter}-t`,
            driverMemberId: s.memberId,
            participantMemberIds: [s.memberId],
            trip: { startKm, endKm: startKm + 25, tripDate: "2026-07-01", note: "load" },
          })));
    } else if (choice === 5) {
      await timed(metrics, `rpc:${WRITE_RPCS.fuel}`, () =>
        rpcCall(supa, s.token, WRITE_RPCS.fuel,
          fuelArgs({
            ledgerId: s.ledgerId,
            openPeriodId: s.openPeriodId,
            legacyId: `load-${s.index}-${iter}-f`,
            payerMemberId: s.memberId,
            fuel: { amount: 500, liters: 35, pricePerLiter: 14.2, odometer: null, stationBrand: "OK", fullTank: true, paymentDate: "2026-07-01" },
          })));
    } else {
      await timed(metrics, `rpc:${WRITE_RPCS.message}`, () =>
        rpcCall(supa, s.token, WRITE_RPCS.message, messageArgs({ ledgerId: s.ledgerId, message: { body: "load rehearsal" } })));
    }
  }
}

async function runLoad(sessions) {
  const metrics = new Metrics();
  const deadline = Date.now() + durationSec * 1000;
  console.log(`⏳ Running ${mix} load: ${sessions.length} VUs for ${durationSec}s…`);

  const startedAt = Date.now();
  await Promise.all(
    sessions.map(async (s) => {
      let iter = 0;
      while (Date.now() < deadline) {
        await vuIteration(metrics, s, iter++);
      }
    }),
  );
  const elapsedSec = (Date.now() - startedAt) / 1000;

  printEvidence(metrics, { elapsedSec, vus: sessions.length });
}

// ── RLS probe: tenant isolation ──────────────────────────────────────────────
async function runRlsProbe(sessions) {
  const ledgerIds = [...new Set(sessions.map((s) => s.ledgerId))];
  if (ledgerIds.length < 2) {
    console.error(`❌ RLS probe needs VUs spanning ≥2 workspaces (found ${ledgerIds.length}). Increase --vus or reseed.`);
    process.exit(1);
  }
  console.log(`⏳ RLS probe: ${sessions.length} members reading OUTSIDE their workspaces (across ${ledgerIds.length} ledgers)…`);

  const PROBE_TABLES = ["trips", "fuel_payments", "ledger_members", "ledger_events", "messages"];
  const leaks = [];
  let checks = 0;

  await runPool(sessions, Math.min(8, sessions.length), async (s) => {
    const foreign = ledgerIds.find((id) => id !== s.ledgerId);
    if (!foreign) return;
    for (const table of PROBE_TABLES) {
      checks++;
      const res = await restGet(supa, s.token, table, `select=id&ledger_id=eq.${encodeURIComponent(foreign)}&limit=5`);
      const rows = Array.isArray(res.json) ? res.json.length : 0;
      if (rows > 0) {
        leaks.push(`member ${s.index} read ${rows} ${table} row(s) from foreign ledger ${foreign}`);
      }
    }
    // The settlement RPC must reject a non-member before touching any data.
    checks++;
    const calc = await rpcCall(supa, s.token, SETTLEMENT_CALC_RPC, {
      target_ledger_id: foreign,
      target_period_id: "00000000-0000-0000-0000-000000000000",
    });
    // A leak here means it returned computed data for a foreign ledger.
    if (calc.ok && calc.json && Array.isArray(calc.json.people) && calc.json.people.length > 0) {
      leaks.push(`member ${s.index} computed a settlement for foreign ledger ${foreign}`);
    }
  });

  console.log("");
  console.log("── RLS probe evidence ──────────────────────────────────────");
  console.log(`  members probing:   ${sessions.length}`);
  console.log(`  foreign checks:    ${checks}`);
  console.log(`  leaked rows:       ${leaks.length}`);
  console.log("────────────────────────────────────────────────────────────");
  if (leaks.length > 0) {
    console.error("❌ RLS LEAK DETECTED — tenant isolation FAILED:");
    for (const l of leaks.slice(0, 30)) console.error(`   ✗ ${l}`);
    process.exit(1);
  }
  console.log("✅ RLS probe PASSED — no cross-workspace rows were readable.");
}

// ── Evidence block ───────────────────────────────────────────────────────────
function printEvidence(metrics, { elapsedSec, vus: vuCount }) {
  const rows = metrics.perEndpoint();
  const total = metrics.totalRequests();
  const errors = metrics.errorsByStatus();

  console.log("");
  console.log("── Load rehearsal evidence (GV-317) ────────────────────────");
  console.log(`  config:      vus=${vuCount}  duration=${durationSec}s (ran ${elapsedSec.toFixed(1)}s)  mix=${mix}  seed=${seed}`);
  console.log(`  requests:    ${total} total  (${(total / Math.max(elapsedSec, 0.001)).toFixed(1)} req/s)`);
  console.log("");
  console.log("  endpoint                          count      p50      p95      p99      max   (ms)");
  console.log("  ----------------------------------------------------------------------------------");
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(32)} ${String(r.count).padStart(6)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.max).padStart(8)}`,
    );
  }
  console.log("");
  if (errors.size === 0) {
    console.log("  errors:      none (all responses < 400)");
  } else {
    const parts = [...errors.entries()].sort((a, b) => a[0] - b[0]).map(([st, n]) => `${st === 0 ? "network" : st}=${n}`);
    console.log(`  errors:      ${parts.join(", ")}`);
    for (const e of metrics.errorSamples.slice(0, 10)) {
      console.log(`     · [${e.label}] ${e.status === 0 ? "network" : e.status}: ${e.detail}`);
    }
  }
  console.log("────────────────────────────────────────────────────────────");
}

// ── Dry run ──────────────────────────────────────────────────────────────────
function runDryRun() {
  console.log("── load --dry-run (no network) ─────────────────────────────");
  console.log(`  config:  vus=${vus}  duration=${durationSec}s  mix=${mix}  seed=${seed}  rls-probe=${rlsProbe}`);
  console.log(`  VUs sign in as: ${userEmail(0, emailDomain)} … ${userEmail(vus - 1, emailDomain)} (password grant)`);
  console.log("");
  console.log("  Per-VU iteration hot-path request set (mirrored from govehlo-mobile):");
  console.log(`   • rpc  ${WORKSPACE_LIST_RPC}                 POST /rest/v1/rpc/${WORKSPACE_LIST_RPC}`);
  const reads = ledgerReadRequests("<slug>");
  for (const r of reads) {
    console.log(`   • GET  ${r.label.padEnd(18)} /rest/v1/${r.table}?${r.query}`);
  }
  const p = tripParticipantsRequest(["<trip-uuid-1>", "<trip-uuid-2>"]);
  console.log(`   • GET  ${p.label.padEnd(18)} /rest/v1/${p.table}?${p.query}   (only when trips exist)`);
  console.log(`   • rpc  ${SETTLEMENT_CALC_RPC}     POST /rest/v1/rpc/${SETTLEMENT_CALC_RPC}  ${JSON.stringify({ target_ledger_id: "<slug>", target_period_id: "<period-uuid>" })}`);
  console.log("");
  console.log("  Write mix (mixed mode, ~1 in 5 iterations):");
  console.log(`   • rpc  ${WRITE_RPCS.trip}`);
  console.log("        ", JSON.stringify(tripArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "load-0-0-t", driverMemberId: "<member-uuid>", participantMemberIds: ["<member-uuid>"], trip: { startKm: 100000, endKm: 100025, tripDate: "2026-07-01", note: "load" } })));
  console.log(`   • rpc  ${WRITE_RPCS.fuel}`);
  console.log("        ", JSON.stringify(fuelArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "load-0-0-f", payerMemberId: "<member-uuid>", fuel: { amount: 500, liters: 35, pricePerLiter: 14.2, odometer: null, stationBrand: "OK", fullTank: true, paymentDate: "2026-07-01" } })));
  console.log(`   • rpc  ${WRITE_RPCS.message}                        ${JSON.stringify(messageArgs({ ledgerId: "<slug>", message: { body: "load rehearsal" } }))}`);
  console.log("");
  console.log("  RLS probe (--rls-probe) per member, against a FOREIGN ledger (expect 0 rows / errors):");
  console.log("   • GET  /rest/v1/trips?select=id&ledger_id=eq.<foreign>&limit=5");
  console.log("   • GET  /rest/v1/fuel_payments?…   ledger_members?…   ledger_events?…   messages?…");
  console.log(`   • rpc  ${SETTLEMENT_CALC_RPC}  { target_ledger_id: "<foreign>", … }  → expect 42501`);
  console.log("────────────────────────────────────────────────────────────");
  console.log("Dry run only — no requests were sent.");
}

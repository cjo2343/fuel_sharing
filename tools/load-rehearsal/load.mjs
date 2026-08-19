// GV-317 load rehearsal — step 3: the load driver.
//
//   npm run load:run -- --env /path/to/rehearsal.env [--vus 20] [--duration 30]
//                       [--mix read|mixed] [--seed 42] [--realtime] [--sharers 0.2]
//                       [--rls-probe] [--dry-run]
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
//     post_message (the feed write), create_vehicle_document + add_vehicle_document_photo
//     (migration 201's archive — GV-493)
//
// It collects per-endpoint latency (p50/p95/p99/max), error counts by status, and
// prints a single evidence block at the end.
//
// ── --realtime (GV-493) ─────────────────────────────────────────────────────
// Exercises 1 and 2 predate migrations 202–208, so they rehearsed an app that no longer
// exists: since GVM-575 every client holds an authenticated WEBSOCKET open for as long as
// a workspace is on screen, joins TWO private channels on it, and — while somebody is on
// their way — broadcasts a position every 15 seconds. `--realtime` adds that half:
//
//   • one websocket per VU (as the client has), joining `presence-<ledgerId>` and
//     `ledger-changes-<ledgerId>` as PRIVATE channels with the VU's own access token,
//     presence keyed on its member id and the same two postgres_changes bindings
//     use-ledger-realtime.ts opens;
//   • presence track + Phoenix heartbeats for the life of the run;
//   • `--sharers 0.2` of the VUs additionally run "Jeg er på vej": set_on_my_way once on
//     a booking they own, an `omw-position` broadcast every 15 s, an ETA refresh every
//     5 minutes (as the client does — only reached by runs longer than that), and
//     clear_on_my_way at the end.
//
// It reports join latency per channel, join failures BY REASON (Unauthorized /
// PrivateOnly / MissingPartition / timeout / other), presence syncs, postgres_changes deliveries and
// broadcast counts; the two RPCs land in the ordinary per-endpoint table because that is
// what they are. Nothing in the phase is allowed to fail quietly: any refused join, dead
// socket or failed sharer setup prints a REALTIME FAILURES section and exits 1.
//
// --rls-probe runs the tenant-isolation probe instead of the load: N members
// concurrently try to READ rows OUTSIDE their own workspaces. RLS must return
// zero rows / permission errors; ANY leaked row fails the run loudly (exit 1).
//
// --dry-run prints the exact request set (URLs, RPC args, write payloads, and the
// realtime join frames) WITHOUT any network, so the coverage can be reviewed before a
// live run.

import { randomUUID } from "node:crypto";

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
} from "./lib/common.mjs";
import {
  ledgerReadRequests,
  tripParticipantsRequest,
  WORKSPACE_LIST_RPC,
  SETTLEMENT_CALC_RPC,
  WRITE_RPCS,
  ON_MY_WAY_RPCS,
  BOOKING_WRITE_RPC,
  VEHICLE_DOCUMENT_WORKSPACE_CAP,
  VEHICLE_DOCUMENTS_PER_VU,
} from "./lib/hotpaths.mjs";
import {
  tripArgs,
  fuelArgs,
  messageArgs,
  bookingArgs,
  vehicleDocumentArgs,
  vehicleDocumentPhotoArgs,
  onMyWaySetArgs,
  onMyWayClearArgs,
  sharerBookingWindow,
} from "./lib/fixtures.mjs";
import {
  RealtimeSocket,
  RealtimeStats,
  presenceJoinFrame,
  ledgerChangesJoinFrame,
  presenceTrackFrame,
  broadcastFrame,
  realtimeSocketUrl,
  selectSharers,
  fakePosition,
  CHANNEL_PRESENCE,
  CHANNEL_LEDGER_CHANGES,
  ON_MY_WAY_POSITION_EVENT,
  LIVE_POSITION_INTERVAL_MS,
} from "./lib/realtime.mjs";

const args = parseArgs(process.argv.slice(2), { flags: ["dry-run", "rls-probe", "realtime"] });
const vus = Number(args.vus ?? 20);
const durationSec = Number(String(args.duration ?? "30").replace(/s$/, ""));
const mix = args.mix === "read" ? "read" : "mixed";
const seed = Number(args.seed ?? 42);
const emailDomain = args["email-domain"] ?? DEFAULT_EMAIL_DOMAIN;
const dryRun = Boolean(args["dry-run"]);
const rlsProbe = Boolean(args["rls-probe"]);
const realtime = Boolean(args.realtime);
const sharerFraction = Number(args.sharers ?? 0.2);

// The ETA refresh cadence the client uses (GVM-238 P0). Only runs longer than this reach
// it; it is here so a long soak rehearses the refresh rather than a single write.
const ETA_REFRESH_MS = 5 * 60_000;

if (dryRun) {
  runDryRun();
  process.exit(0);
}

if (realtime && typeof WebSocket !== "function") {
  // Fail here, not later: a realtime phase that quietly did nothing is worse than no
  // phase at all, because the evidence block would still look like a complete run.
  console.error("❌ --realtime needs the global WebSocket (Node >= 22), the same floor tools/probe-realtime-public-access.mjs states.");
  process.exit(1);
}
if (realtime && !(sharerFraction >= 0 && sharerFraction <= 1)) {
  console.error(`❌ --sharers must be a fraction between 0 and 1 (got ${args.sharers}).`);
  process.exit(1);
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

  // Write mix: ~1 in 5 iterations does a write (mixed mode only). The cycle is 20 rather
  // than 15 since GV-493 — a fourth slot for the document archive — so the split is
  // trip / fuel / message / document rather than trip / fuel / message.
  if (mix === "mixed" && s.openPeriodId && s.memberId && iter % 5 === 0) {
    const choice = iter % 20;
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
    } else if (choice === 15 && s.documentBudget > 0) {
      // Migration 201, GV-493. The per-VU budget is what keeps a workspace under the
      // RPC's own cap of 50 by construction; without it a long `--duration` would start
      // answering 23514 and the run would report a broken harness as a finding.
      s.documentBudget -= 1;
      const created = await timed(metrics, `rpc:${WRITE_RPCS.document}`, () =>
        rpcCall(supa, s.token, WRITE_RPCS.document,
          vehicleDocumentArgs({
            ledgerId: s.ledgerId,
            title: `Load rehearsal ${s.index}-${iter}`,
            expiryDate: "2027-06-30",
          })));
      // The client always files the row and then registers its pages, so the rehearsal
      // does too — one page, since the shape of the call is what is being measured.
      const documentId = created.ok ? created.json?.document_id ?? created.json?.id ?? null : null;
      if (documentId) {
        await timed(metrics, `rpc:${WRITE_RPCS.documentPhoto}`, () =>
          rpcCall(supa, s.token, WRITE_RPCS.documentPhoto,
            vehicleDocumentPhotoArgs({ ledgerId: s.ledgerId, documentId, token: randomUUID() })));
      }
    } else {
      await timed(metrics, `rpc:${WRITE_RPCS.message}`, () =>
        rpcCall(supa, s.token, WRITE_RPCS.message, messageArgs({ ledgerId: s.ledgerId, message: { body: "load rehearsal" } })));
    }
  }
}

async function runLoad(sessions) {
  const metrics = new Metrics();
  for (const s of sessions) s.documentBudget = VEHICLE_DOCUMENTS_PER_VU;

  const rt = realtime ? new RealtimeStats() : null;
  let teardown = async () => {};
  if (realtime) {
    teardown = await startRealtimePhase(sessions, metrics, rt);
  }

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

  await teardown();

  printEvidence(metrics, { elapsedSec, vus: sessions.length, rt });

  if (rt?.hasFailures()) {
    // Loud on purpose: a realtime phase whose joins were refused has measured the
    // failure mode, not the feature, and must never read as a clean run.
    process.exit(1);
  }
}

// ── Realtime phase (GV-493) ──────────────────────────────────────────────────
//
// Opens every VU's socket and joins both channels BEFORE the HTTP load starts, so the
// join latency reported is the connection cost itself rather than a number contaminated
// by whatever the read fan-out was doing at that instant. The sockets then stay up for
// the whole run, which is the state the platform actually has to hold.
//
// Returns the teardown: stop the timers, clear every share, close every socket.
async function startRealtimePhase(sessions, metrics, rt) {
  const url = realtimeSocketUrl(supa.base, supa.anonKey);
  console.log(`⏳ Realtime: opening ${sessions.length} websockets, joining presence-<id> + ledger-changes-<id> as PRIVATE channels…`);

  await runPool(sessions, Math.min(8, sessions.length), async (s) => {
    const socket = new RealtimeSocket({ url, stats: rt });
    const opened = await socket.connect();
    if (!opened.ok) {
      rt.socketsFailed += 1;
      rt.failureSamples.push({ channel: "socket", reason: "socket", detail: opened.reason });
      return;
    }
    rt.socketsOpened += 1;
    s.socket = socket;

    const presence = await socket.join(
      CHANNEL_PRESENCE,
      presenceJoinFrame({ ledgerId: s.ledgerId, memberId: s.memberId, accessToken: s.token, ref: socket.nextRef() }),
    );
    if (presence.ok) {
      // channel.track({ online_at }) — what puts this member's dot on the others' screens.
      socket.sendRaw(presenceTrackFrame({
        ledgerId: s.ledgerId,
        ref: socket.nextRef(),
        joinRef: socket.joinRefFor(CHANNEL_PRESENCE),
        onlineAt: new Date().toISOString(),
      }));
    }

    await socket.join(
      CHANNEL_LEDGER_CHANGES,
      ledgerChangesJoinFrame({ ledgerId: s.ledgerId, accessToken: s.token, ref: socket.nextRef() }),
    );
  });

  console.log(`   sockets: ${rt.socketsOpened} open, ${rt.socketsFailed} failed; joins: ${rt.joinLatencies.get(CHANNEL_PRESENCE)?.length ?? 0} presence, ${rt.joinLatencies.get(CHANNEL_LEDGER_CHANGES)?.length ?? 0} ledger-changes, ${rt.totalJoinFailures()} refused.`);

  // ── "Jeg er på vej" ────────────────────────────────────────────────────────
  const eligible = sessions.filter((s) => s.socket && s.memberId);
  const sharerIndices = new Set(selectSharers(eligible.map((s) => s.index), sharerFraction, seed));
  const sharers = eligible.filter((s) => sharerIndices.has(s.index));
  rt.sharers = sharers.length;
  const timers = [];

  if (sharers.length > 0) {
    console.log(`⏳ Realtime: starting "Jeg er på vej" on ${sharers.length}/${sessions.length} VUs (--sharers ${sharerFraction})…`);
  }

  await runPool(sharers, Math.min(4, Math.max(1, sharers.length)), async (s) => {
    const booking = await resolveSharerBooking(metrics, s);
    if (!booking) {
      rt.failureSamples.push({ channel: "sharer", reason: "booking", detail: `VU ${s.index}: no bookable future booking and upsert_car_booking failed` });
      rt.sharerFailures += 1; // counts toward hasFailures() — see the header
      return;
    }
    s.sharedBookingLegacyId = booking.legacyId;
    s.etaMinutes = 12 + (s.index % 20);

    const set = await timed(metrics, `rpc:${ON_MY_WAY_RPCS.set}`, () =>
      rpcCall(supa, s.token, ON_MY_WAY_RPCS.set,
        onMyWaySetArgs({ ledgerId: s.ledgerId, legacyBookingId: booking.legacyId, etaMinutes: s.etaMinutes, first: true })));
    if (!set.ok) {
      s.sharedBookingLegacyId = null;
      rt.failureSamples.push({ channel: "sharer", reason: "set_on_my_way", detail: `VU ${s.index}: ${(set.text || "").slice(0, 140)}` });
      rt.sharerFailures += 1;
      return;
    }
    s.bookingId = set.json?.booking_id ?? booking.legacyId;

    // The 15-second position broadcast (GVM-587). Rounded to five decimals at the
    // source, exactly as buildLivePosition does, and never stored anywhere.
    let tick = 0;
    timers.push(setInterval(() => {
      const joinRef = s.socket.joinRefFor(CHANNEL_PRESENCE);
      if (!joinRef) return;
      const sent = s.socket.sendRaw(broadcastFrame({
        ledgerId: s.ledgerId,
        ref: s.socket.nextRef(),
        joinRef,
        event: ON_MY_WAY_POSITION_EVENT,
        payload: fakePosition({ bookingId: s.bookingId, memberId: s.memberId, index: s.index, tick: tick++, now: Date.now() }),
      }));
      if (sent) rt.broadcastsSent += 1;
    }, LIVE_POSITION_INTERVAL_MS));

    // The ~5-minute ETA refresh. `first: false` so it writes the audit-only
    // on_my_way_updated row rather than an eighth feed entry for one drive home.
    timers.push(setInterval(() => {
      void timed(metrics, `rpc:${ON_MY_WAY_RPCS.set}`, () =>
        rpcCall(supa, s.token, ON_MY_WAY_RPCS.set,
          onMyWaySetArgs({ ledgerId: s.ledgerId, legacyBookingId: s.sharedBookingLegacyId, etaMinutes: s.etaMinutes, first: false })));
    }, ETA_REFRESH_MS));
  });

  return async function teardownRealtime() {
    for (const t of timers) clearInterval(t);
    for (const s of sessions) {
      if (!s.sharedBookingLegacyId) continue;
      await timed(metrics, `rpc:${ON_MY_WAY_RPCS.clear}`, () =>
        rpcCall(supa, s.token, ON_MY_WAY_RPCS.clear,
          onMyWayClearArgs({ ledgerId: s.ledgerId, legacyBookingId: s.sharedBookingLegacyId })));
    }
    for (const s of sessions) s.socket?.close();
  };
}

// A booking this VU may share on: migration 202 admits the booking's MEMBER or its
// CREATOR (never an admin) and refuses one that has ended. The fixture's bookings are
// anchored at 2026-07-01 and are all in the past by now, so prefer a live one and
// otherwise create one through the app's own upsert_car_booking.
async function resolveSharerBooking(metrics, s) {
  const nowIso = new Date().toISOString();
  const query =
    `select=id,legacy_id,end_at&ledger_id=eq.${encodeURIComponent(s.ledgerId)}` +
    `&deleted_at=is.null&end_at=gt.${encodeURIComponent(nowIso)}` +
    `&or=(member_id.eq.${s.memberId},created_by_member_id.eq.${s.memberId})` +
    `&order=start_at.asc&limit=1`;
  const existing = await restGet(supa, s.token, "car_bookings", query);
  if (existing.ok && Array.isArray(existing.json) && existing.json[0]?.legacy_id) {
    return { legacyId: existing.json[0].legacy_id, created: false };
  }

  const legacyId = `load-omw-${s.index}`;
  const created = await timed(metrics, `rpc:${BOOKING_WRITE_RPC}`, () =>
    rpcCall(supa, s.token, BOOKING_WRITE_RPC,
      bookingArgs({
        ledgerId: s.ledgerId,
        legacyId,
        bookingMemberId: s.memberId,
        booking: sharerBookingWindow({ index: s.index }),
      })));
  return created.ok ? { legacyId, created: true } : null;
}

// ── RLS probe: tenant isolation ──────────────────────────────────────────────
async function runRlsProbe(sessions) {
  const ledgerIds = [...new Set(sessions.map((s) => s.ledgerId))];
  if (ledgerIds.length < 2) {
    console.error(`❌ RLS probe needs VUs spanning ≥2 workspaces (found ${ledgerIds.length}). Increase --vus or reseed.`);
    process.exit(1);
  }
  console.log(`⏳ RLS probe: ${sessions.length} members reading OUTSIDE their workspaces (across ${ledgerIds.length} ledgers)…`);

  const PROBE_TABLES = ["trips", "fuel_payments", "ledger_members", "ledger_events", "messages", "vehicle_documents"];
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
  console.log("ℹ️  The REALTIME half of tenant isolation is a different tool: a non-member's");
  console.log("   private join is refused by migrations 202/205/206's policies, and a PUBLIC");
  console.log("   join by the project switch — `npm run probe:realtime-public-access` (GV-490).");
}

// ── Evidence block ───────────────────────────────────────────────────────────
function printEvidence(metrics, { elapsedSec, vus: vuCount, rt }) {
  const rows = metrics.perEndpoint();
  const total = metrics.totalRequests();
  const errors = metrics.errorsByStatus();

  console.log("");
  console.log("── Load rehearsal evidence (GV-317 / GV-493) ───────────────");
  console.log(`  config:      vus=${vuCount}  duration=${durationSec}s (ran ${elapsedSec.toFixed(1)}s)  mix=${mix}  seed=${seed}  realtime=${realtime ? `on (--sharers ${sharerFraction})` : "off"}`);
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

  if (rt) printRealtimeEvidence(rt);
  console.log("────────────────────────────────────────────────────────────");
}

function printRealtimeEvidence(rt) {
  console.log("");
  console.log("  ── Realtime (GV-493) ────────────────────────────────────");
  console.log(`  sockets:     ${rt.socketsOpened} opened, ${rt.socketsFailed} failed  ·  sharers: ${rt.sharers}`);
  console.log("");
  console.log("  channel (private join)            count      p50      p95      p99      max   (ms)");
  console.log("  ----------------------------------------------------------------------------------");
  for (const r of rt.joinRows()) {
    console.log(
      `  ${r.channel.padEnd(32)} ${String(r.count).padStart(6)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.max).padStart(8)}`,
    );
  }
  console.log("");
  console.log(`  presence syncs:      ${rt.presenceSyncs}`);
  console.log(`  postgres_changes:    ${rt.postgresChanges}`);
  console.log(`  omw-position sent:   ${rt.broadcastsSent}   received: ${rt.broadcastsReceived}`);
  console.log("");
  const failures = rt.failureRows();
  if (failures.length === 0 && rt.socketsFailed === 0 && rt.sharerFailures === 0) {
    console.log("  join failures:       none — every private join reached SUBSCRIBED");
    return;
  }
  console.log("  ❌ REALTIME FAILURES — this run exits 1:");
  for (const f of failures) {
    console.log(`     · ${f.channel}: ${f.reason} × ${f.count}`);
  }
  if (rt.socketsFailed > 0) console.log(`     · sockets that never opened: ${rt.socketsFailed}`);
  if (rt.sharerFailures > 0) console.log(`     · sharers that could not start a share: ${rt.sharerFailures}`);
  for (const sample of rt.failureSamples.slice(0, 10)) {
    console.log(`       [${sample.channel}/${sample.reason}] ${sample.detail}`);
  }
  console.log("");
  console.log("     Unauthorized  → migrations 202/205/206's policies refused a MEMBER's private");
  console.log("                     join. Presence and live sync are down for real users.");
  console.log("     PrivateOnly   → a join frame lost `private: true`. Every join here sets it,");
  console.log('                     so this means the harness drifted, not the project.');
  console.log("     MissingPartition → Realtime's day-partition of realtime.messages did not exist");
  console.log("                     yet — on a FRESH project the first joins race the tenant janitor");
  console.log("                     that creates them; re-run once the tenant is warm. On production");
  console.log("                     this same string would mean a partition gap on a day roll-over;");
  console.log("                     presence is cosmetic in the app but report it.");
  console.log("     timeout       → no reply at all. Check the project is awake and reachable.");
}

// ── Dry run ──────────────────────────────────────────────────────────────────
function runDryRun() {
  console.log("── load --dry-run (no network) ─────────────────────────────");
  console.log(`  config:  vus=${vus}  duration=${durationSec}s  mix=${mix}  seed=${seed}  rls-probe=${rlsProbe}  realtime=${realtime}  sharers=${sharerFraction}`);
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
  console.log("  Write mix (mixed mode, ~1 in 5 iterations, cycle of 20 → trip / fuel / message / document):");
  console.log(`   • rpc  ${WRITE_RPCS.trip}`);
  console.log("        ", JSON.stringify(tripArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "load-0-0-t", driverMemberId: "<member-uuid>", participantMemberIds: ["<member-uuid>"], trip: { startKm: 100000, endKm: 100025, tripDate: "2026-07-01", note: "load" } })));
  console.log(`   • rpc  ${WRITE_RPCS.fuel}`);
  console.log("        ", JSON.stringify(fuelArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "load-0-0-f", payerMemberId: "<member-uuid>", fuel: { amount: 500, liters: 35, pricePerLiter: 14.2, odometer: null, stationBrand: "OK", fullTank: true, paymentDate: "2026-07-01" } })));
  console.log(`   • rpc  ${WRITE_RPCS.message}                        ${JSON.stringify(messageArgs({ ledgerId: "<slug>", message: { body: "load rehearsal" } }))}`);
  console.log(`   • rpc  ${WRITE_RPCS.document}              ${JSON.stringify(vehicleDocumentArgs({ ledgerId: "<slug>", title: "Load rehearsal 0-15", expiryDate: "2027-06-30" }))}`);
  console.log(`   • rpc  ${WRITE_RPCS.documentPhoto}         ${JSON.stringify(vehicleDocumentPhotoArgs({ ledgerId: "<slug>", documentId: "<document-uuid>", token: "<token>" }))}`);
  console.log(`     (max ${VEHICLE_DOCUMENTS_PER_VU} documents per VU — migration 201 caps a workspace at ${VEHICLE_DOCUMENT_WORKSPACE_CAP})`);
  console.log("");
  console.log("  Realtime phase (--realtime), per VU — ONE websocket, TWO private channels:");
  console.log(`   • WS   ${realtimeSocketUrl("https://<ref>.supabase.co", "<anon key>").replace(/apikey=[^&]+/, "apikey=REDACTED")}`);
  console.log("   • join", JSON.stringify(redactToken(presenceJoinFrame({ ledgerId: "<slug>", memberId: "<member-uuid>", accessToken: "<vu jwt>", ref: 1 }))));
  console.log("   • join", JSON.stringify(redactToken(ledgerChangesJoinFrame({ ledgerId: "<slug>", accessToken: "<vu jwt>", ref: 2 }))));
  console.log("   • track", JSON.stringify(presenceTrackFrame({ ledgerId: "<slug>", ref: 3, joinRef: 1, onlineAt: "<iso>" })));
  console.log("");
  console.log(`  "Jeg er på vej" on --sharers ${sharerFraction} of the VUs (deterministic from --seed):`);
  console.log(`   • selected VU indices for ${vus} VUs: [${selectSharers(Array.from({ length: vus }, (_, i) => i), sharerFraction, seed).join(", ")}]`);
  console.log(`   • rpc  ${BOOKING_WRITE_RPC}   (only when no live fixture booking is left — the fixture's are anchored at 2026-07-01)`);
  console.log(`   • rpc  ${ON_MY_WAY_RPCS.set}          ${JSON.stringify(onMyWaySetArgs({ ledgerId: "<slug>", legacyBookingId: "load-omw-0", etaMinutes: 12, first: true }))}`);
  console.log(`   • bcast every ${LIVE_POSITION_INTERVAL_MS / 1000}s`, JSON.stringify(broadcastFrame({ ledgerId: "<slug>", ref: 4, joinRef: 1, event: ON_MY_WAY_POSITION_EVENT, payload: fakePosition({ bookingId: "<booking-uuid>", memberId: "<member-uuid>", index: 0, tick: 0, now: 0 }) })));
  console.log(`   • rpc  ${ON_MY_WAY_RPCS.set}          ${JSON.stringify(onMyWaySetArgs({ ledgerId: "<slug>", legacyBookingId: "load-omw-0", etaMinutes: 12, first: false }))}   (refresh, every ${ETA_REFRESH_MS / 60000} min)`);
  console.log(`   • rpc  ${ON_MY_WAY_RPCS.clear}        ${JSON.stringify(onMyWayClearArgs({ ledgerId: "<slug>", legacyBookingId: "load-omw-0" }))}   (at teardown)`);
  console.log("");
  console.log("  RLS probe (--rls-probe) per member, against a FOREIGN ledger (expect 0 rows / errors):");
  console.log("   • GET  /rest/v1/trips?select=id&ledger_id=eq.<foreign>&limit=5");
  console.log("   • GET  /rest/v1/fuel_payments?…   ledger_members?…   ledger_events?…   messages?…   vehicle_documents?…");
  console.log(`   • rpc  ${SETTLEMENT_CALC_RPC}  { target_ledger_id: "<foreign>", … }  → expect 42501`);
  console.log("────────────────────────────────────────────────────────────");
  console.log("Dry run only — no requests were sent.");
}

// Never print a token, even a placeholder one, in a shape somebody could copy into a
// real command (GDPR + hygiene — the same rule redactUrl follows in lib/common.mjs).
function redactToken(frame) {
  return { ...frame, payload: { ...frame.payload, access_token: "REDACTED" } };
}

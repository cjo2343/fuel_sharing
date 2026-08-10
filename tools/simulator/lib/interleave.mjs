// Parallel sessions and deterministic lockstep contention (GV-478 Phase B, feature 4).
//
// THE GAP THIS CLOSES. Phase A held one psql session, so every write the fuzzer made was
// serialised by construction. Every bug that exists only because two people pressed a
// button inside the same second — one member logging a fill while the admin closes the
// period, two phones saving the same handover — was structurally unreachable, no matter
// how many ticks the run had.
//
// WHY NOT JUST RUN THEM CONCURRENTLY. Because a real race is scheduled by the operating
// system, and a finding that cannot be replayed is a rumour. Determinism is this tool's
// product: every violation prints one command that reproduces it. So the collisions here
// are LOCKSTEP — one statement at a time, in an order the seeded PRNG chose:
//
//   1. the HOLDER opens a transaction on a secondary session and runs one real RPC. Its
//      locks (a pg_advisory_xact_lock, a `for update`, a `for share`) are held, because
//      the transaction is deliberately left open.
//   2. the CONTENDER runs a conflicting real RPC on the PRIMARY session, under
//      `SET LOCAL lock_timeout`.
//   3. the holder commits or rolls back — PRNG-drawn — and the contender's outcome is
//      read against the scenario's expectation.
//
// Same collision as a race, same code paths, reproducible ordering.
//
// THE LOCK TIMEOUT IS THE WHOLE DESIGN, NOT A DETAIL. Step 2 blocks: that is the point.
// A single-threaded driver that waits for it has deadlocked itself, because only the
// driver can send the holder's commit. `lock_timeout` turns the block into an ANSWER —
// SQLSTATE 55P03, caught by sim_exec like any other exception and returned as data —
// within a few hundred milliseconds. 55P03 then gets its own outcome class,
// `contention`, because it is neither a guard (nothing refused on the merits) nor an
// error (nothing is wrong): it is the database proving it serialises the two writers.
// 400 ms is chosen so a genuinely slow-but-not-blocked statement on a loaded CI machine
// still finishes — the RPCs here run in single-digit milliseconds — while thirty
// scenarios cost about twelve seconds of a run.
//
// WHAT MAKES A SCENARIO A FINDING. Each template below states the lock the SCHEMA takes
// and therefore the outcome the schema promises. The judgement is narrow on purpose:
//
//   holder failed                → judge nothing. No lock was held (a failed statement
//                                  inside sim_exec rolls back to its subtransaction and
//                                  releases what it took), so the contender met no
//                                  contention and its outcome says nothing.
//   contender `contention`       → expected. The lock did its job.
//   contender `guard`            → expected. It was refused on the merits before it ever
//                                  reached the lock (permission, a closed period, a
//                                  stale token) — all of those gates sit ahead of the
//                                  lock in these functions.
//   contender `ok`               → INTERLEAVE HAZARD. Two writers got through the same
//                                  named lock at the same time, which is precisely what
//                                  the lock is in the schema to prevent.
//   contender `error`            → already a violation by the ordinary path.

import { lit, uuidLit, jsonLit, actionSql, claimsFor } from "./db.mjs";
import { bookingCompletionWrite, classifyRejection, isLockTimeout, tripWrite, fuelWrite } from "./actions.mjs";

/** How long the contender waits before its block is converted into 55P03. */
export const LOCK_TIMEOUT_MS = 400;

/** The holder gets one too, an order of magnitude looser. It should never fire — nothing
 *  else holds a lock when a scenario starts — and it exists only so that a harness bug
 *  can never turn into a run that hangs until CI's timeout kills it. */
const HOLDER_LOCK_TIMEOUT_MS = 4000;

const active = (ws) => ws.members.filter((m) => m.active);
const liveTrips = (ws) => ws.trips.filter((t) => !t.deleted && t.id);
const liveBookings = (ws) => ws.bookings.filter((b) => !b.cancelled && b.id);

/** The shared verdict: the schema names a lock, so two writers must not both get through
 *  it. `reason` says which lock, in the words of the migration that added it. */
function expectSerialised(lockName) {
  return ({ holder, contender }) => {
    if (holder.outcome !== "ok") return null;
    if (contender.outcome === "ok") {
      return `the contender's write SUCCEEDED while the holder's transaction was still open, so ${lockName} did not serialise the two writers`;
    }
    return null;
  };
}

/** A ctx clone that acts as a different member. Everything else — the same PRNG stream,
 *  the same simulated clock, the same workspace — is shared, so a scenario's draws stay
 *  part of the one deterministic sequence. */
function asMember(ctx, slot) {
  return { ...ctx, actorSlot: slot, offline: false };
}

// ── The templates ────────────────────────────────────────────────────────────
//
// Five, each mapping to a collision a real group produces. Every one is built out of the
// SAME RPC calls the tick loop uses (tripWrite / fuelWrite / bookingCompletionWrite / the
// handover and settlement statements), never a hand-written copy: a copy would stop
// testing the real call the moment either drifted.

export const SCENARIOS = [
  {
    id: "same_trip_edit",
    danish: "To medlemmer redigerer samme tur",
    lock: "upsert_trip_with_participants' pg_advisory_xact_lock(ledger || ':trip:' || legacy_id)",
    async build(ctx) {
      const trip = ctx.rng.pick(liveTrips(ctx.ws));
      if (!trip) return null;
      const driver = ctx.ws.members.find((m) => m.slot === trip.driverSlot && m.active);
      const admin = ctx.ws.members[0];
      if (!driver || !admin || driver.slot === admin.slot) return null;
      const holder = await tripWrite(asMember(ctx, driver.slot), { existing: trip });
      const contender = await tripWrite(asMember(ctx, admin.slot), { existing: trip });
      if (!holder || !contender) return null;
      return {
        holder: { slot: driver.slot, inner: holder.inner, apply: holder.apply, label: "rediger tur" },
        contender: { slot: admin.slot, inner: contender.inner, apply: contender.apply, label: "rediger samme tur" },
        detail: { legacyId: trip.legacyId },
      };
    },
  },

  {
    id: "fuel_during_close",
    danish: "Tankning mens perioden lukkes",
    lock: "close_settlement_period's `select … for update of sp` against the writers' `for share of sp`",
    // The roles are this way round on purpose. The close takes the EXCLUSIVE lock, so it
    // has to be the contender: a close held open as the holder would usually have failed
    // its own precondition first, released everything at the subtransaction abort, and
    // left the scenario testing nothing. A fuel write almost always succeeds, so as the
    // holder it reliably parks a `for share` on the period row — and then the close is
    // blocked at the very first thing it does, before any of its own validation, which
    // is exactly what migration 141's wrapper promises ("writers already take FOR SHARE
    // on this row; writers that start later block here until the close commits").
    async build(ctx) {
      if (!ctx.ws.openPeriodId) return null;
      const member = ctx.rng.pick(active(ctx.ws).filter((m) => m.slot !== 0));
      const admin = ctx.ws.members[0];
      if (!member || !admin) return null;
      const holder = await fuelWrite(asMember(ctx, member.slot), {});
      if (!holder) return null;
      // The REAL close, snapshot and all. A stub close would be refused on its own
      // malformed snapshot in the hazard case, and a hazard that reports as `guard` is a
      // hazard nobody sees.
      const closeProgram = await ctx.buildCloseProgram(ctx.ws);
      if (!closeProgram) return null;
      const statements = closeProgram.requests.map((args) => `select public.upsert_settlement_request_status(
                  target_ledger_id => ${lit(args.target_ledger_id)},
                  target_open_period_id => ${uuidLit(args.target_open_period_id)},
                  payer_member_id => ${uuidLit(args.payer_member_id)},
                  recipient_member_id => ${uuidLit(args.recipient_member_id)},
                  amount_value => ${args.amount_value},
                  currency_value => ${lit(args.currency_value)},
                  next_status => ${lit(args.next_status)},
                  current_pair_keys => array[]::text[],
                  p_note => null)`);
      statements.push(`select public.close_settlement_period(
                  ${lit(ctx.ws.ledgerId)},
                  ${uuidLit(ctx.ws.openPeriodId)},
                  ${jsonLit(closeProgram.snapshot)})`);
      const periodId = ctx.ws.openPeriodId;
      return {
        holder: { slot: member.slot, inner: holder.inner, apply: holder.apply, label: "log tankning" },
        contender: {
          slot: admin.slot,
          inner: statements,
          label: "luk periode",
          apply: async () => {
            ctx.ws.closedPeriodIds.push(periodId);
            ctx.ws.requests = [];
            await ctx.refreshOpenPeriod(ctx.ws);
          },
        },
        detail: { periodId, requests: closeProgram.requests.length },
      };
    },
  },

  {
    id: "settlement_pair_race",
    danish: "Admin genanmoder mens betaleren markerer betalt",
    lock: "upsert_settlement_request_status' pg_advisory_xact_lock(ledger || ':settlement:' || period_id)",
    async build(ctx) {
      const request = ctx.rng.pick(ctx.ws.requests.filter((r) => r.status === "requested"));
      if (!request || !ctx.ws.openPeriodId) return null;
      const admin = ctx.ws.members[0];
      const payer = ctx.ws.members.find((m) => m.memberId === request.fromId && m.active);
      if (!payer || payer.slot === admin.slot) return null;
      const call = (status, note) => `select public.upsert_settlement_request_status(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
                  payer_member_id => ${uuidLit(request.fromId)},
                  recipient_member_id => ${uuidLit(request.toId)},
                  amount_value => ${request.amount},
                  currency_value => ${lit("DKK")},
                  next_status => ${lit(status)},
                  current_pair_keys => array[]::text[],
                  p_note => ${note ? lit(note) : "null"})`;
      return {
        holder: { slot: admin.slot, inner: call("requested", null), label: "genanmod betaling" },
        contender: {
          slot: payer.slot,
          inner: call("paid_pending", "Betalt via MobilePay"),
          label: "markér betalt",
          apply: () => { request.status = "paid_pending"; },
        },
        detail: { amount: request.amount },
      };
    },
  },

  {
    id: "handover_race",
    danish: "To medlemmer gemmer overdragelse for samme booking",
    lock: "upsert_booking_handover's pg_advisory_xact_lock(ledger || ':handover:' || booking_id)",
    // The contender is the admin because the write gate on this RPC is narrow (the
    // booking's member, the linked trip's driver, or an admin). A third member would be
    // refused at the gate every time, which is a `guard` — accepted by the judgement,
    // and therefore a scenario that never actually reaches the lock.
    async build(ctx) {
      const booking = ctx.rng.pick(liveBookings(ctx.ws));
      if (!booking) return null;
      const member = ctx.ws.members.find((m) => m.slot === booking.memberSlot && m.active);
      const admin = ctx.ws.members[0];
      if (!member || !admin || member.slot === admin.slot) return null;
      const call = (odo, fraction) => `select public.upsert_booking_handover(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_booking_id => ${uuidLit(booking.id)},
                  end_odometer_value => ${odo},
                  fuel_fraction_value => ${fraction},
                  parking_location_value => ${lit("P-plads ved nr. " + ctx.rng.int(1, 40))},
                  key_location_value => ${lit("Noeglebox")},
                  condition_ok_value => true,
                  condition_note_value => null,
                  note_to_next_value => null,
                  keys_confirmed_value => true,
                  parking_lat_value => null,
                  parking_lng_value => null,
                  location_seen_at => null,
                  event_title => ${lit("Bilen er afleveret")},
                  event_body => ${lit("Overdragelse registreret")},
                  expected_updated_at => null)`;
      const odo = Math.round(ctx.ws.odometer) + ctx.rng.int(0, 30);
      return {
        holder: { slot: member.slot, inner: call(odo, 0.5), label: "gem overdragelse" },
        contender: {
          slot: admin.slot,
          inner: call(odo + ctx.rng.int(1, 12), 0.4),
          label: "gem samme overdragelse",
          apply: (result) => { booking.handover = true; booking.handoverUpdatedAt = result?.updated_at ?? null; },
        },
        detail: { legacyId: booking.legacyId, odometer: odo },
      };
    },
  },

  {
    id: "double_completion",
    danish: "To medlemmer afslutter samme booking",
    lock: "upsert_booking_trip_with_participants' `select … for update of cb` on the car_bookings row, taken one step earlier by complete_booking_trip_with_fuel's GV-479 pre-check",
    // The collision the Phase B README listed as the one deliberately NOT covered,
    // because its expectation was unsettled: nothing in the schema said what SHOULD
    // happen when two members complete the same booking under two different idempotency
    // keys. Migration 197 (GV-479) settles it, so the scenario can exist.
    //
    // TWO OUTCOMES ARE EXPECTED, and the shared judgement accepts both:
    //   · the ordinary case — the booking has no trip yet, the holder's completion takes
    //     the booking row and keeps it, and the contender BLOCKS there and comes back
    //     55P03 (`contention`). That is the booking lock doing the job migration 123 gave
    //     it: it is the idempotency boundary, and both completions queue on it.
    //   · the booking already carries a live trip from an earlier tick — then the GV-479
    //     pre-check refuses BOTH sessions with the same Danish sentence (`guard`), the
    //     holder's statement fails, and the judgement correctly abstains because no lock
    //     was ever held. Also worth having: that path is the one a member actually meets.
    // `ok` is the hazard, exactly as everywhere else — a second completion that SUCCEEDS
    // while the first is still in flight is the silent overwrite GV-479 exists to end.
    //
    // The contender is the admin, because the completion gate is the booked member or a
    // ledger admin; a third member would be refused at the gate every time and never
    // reach the lock. Each bookingCompletionWrite call draws its own idempotency key, so
    // these two are a second COMPLETION rather than a retry — a retry under the SAME key
    // is idempotent by design and is the duplicate catalogue's job, not this one's.
    async build(ctx) {
      if (!ctx.ws.openPeriodId) return null;
      const booking = ctx.rng.pick(liveBookings(ctx.ws));
      if (!booking) return null;
      const member = ctx.ws.members.find((m) => m.slot === booking.memberSlot && m.active);
      const admin = ctx.ws.members[0];
      if (!member || !admin || member.slot === admin.slot) return null;
      const holder = bookingCompletionWrite(asMember(ctx, member.slot), { booking });
      const contender = bookingCompletionWrite(asMember(ctx, admin.slot), { booking });
      if (!holder || !contender) return null;
      return {
        holder: { slot: member.slot, inner: holder.inner, apply: holder.apply, label: "afslut booking" },
        contender: {
          slot: admin.slot,
          inner: contender.inner,
          apply: contender.apply,
          label: "afslut samme booking",
        },
        detail: {
          bookingLegacyId: booking.legacyId,
          holderTripLegacyId: holder.detail.legacyId,
          contenderTripLegacyId: contender.detail.legacyId,
          alreadyCompleted: Boolean(booking.completed),
        },
      };
    },
  },
];

/**
 * Draw a scenario and build it, or return null when none of them has its preconditions.
 *
 * The draw is one weighted pick followed by up to `SCENARIOS.length` attempts, mirroring
 * the tick loop's own re-weighting: a scenario whose workspace has no live trip is
 * discarded rather than retried.
 */
export async function buildScenario(ctx) {
  const pool = SCENARIOS.map((scenario) => [scenario, 1]);
  for (let attempt = 0; attempt < SCENARIOS.length && pool.length > 0; attempt += 1) {
    const scenario = ctx.rng.weighted(pool);
    pool.splice(pool.findIndex(([candidate]) => candidate === scenario), 1);
    // eslint-disable-next-line no-await-in-loop -- the scenario builders are serial by design
    const built = await scenario.build(ctx);
    if (built) {
      return {
        id: scenario.id,
        danish: scenario.danish,
        lock: scenario.lock,
        judge: expectSerialised(scenario.lock),
        ...built,
      };
    }
  }
  return null;
}

/** Send one statement as a member and classify the reply the way the tick loop does. */
async function step(session, member, inner, { lockTimeoutMs, leaveOpen }) {
  const sql = actionSql(claimsFor(member), inner, { lockTimeoutMs, leaveOpen });
  const res = await session.send(sql);
  if (res.stderr) {
    return { outcome: "error", message: res.stderr.slice(0, 1200), ms: res.ms, sqlstate: null, guardKind: null, payload: null };
  }
  let payload = null;
  try {
    payload = JSON.parse(res.lines[0]);
  } catch {
    return { outcome: "error", message: `unparseable reply: ${(res.lines[0] ?? "").slice(0, 400)}`, ms: res.ms, sqlstate: null, guardKind: null, payload: null };
  }
  if (payload.ok) return { outcome: "ok", ms: res.ms, sqlstate: null, guardKind: null, message: null, payload };
  if (isLockTimeout(payload.sqlstate, payload.message)) {
    return { outcome: "contention", ms: res.ms, sqlstate: payload.sqlstate, guardKind: null, message: payload.message, payload };
  }
  const guardKind = classifyRejection(payload.sqlstate, payload.message);
  return {
    outcome: guardKind ? "guard" : "error",
    guardKind,
    sqlstate: payload.sqlstate,
    message: payload.message,
    ms: res.ms,
    payload,
  };
}

/**
 * Run one built scenario in lockstep and hand every sub-step back through `onStep`.
 *
 * Returns { steps, hazard } — `hazard` is a sentence when the scenario's expectation was
 * broken, and null otherwise. Nothing here writes to the journal or records violations;
 * run.mjs owns both, so the digest sees the sub-steps in the order they happened.
 */
export async function runScenario({ scenario, ws, sessions, rng, holderSessionIndex = 1, onStep }) {
  const holderMember = ws.members.find((m) => m.slot === scenario.holder.slot);
  const contenderMember = ws.members.find((m) => m.slot === scenario.contender.slot);
  const holderSession = sessions.at(holderSessionIndex);
  const primary = sessions.primary;

  // 1. The holder takes its locks and STAYS in its transaction.
  const holder = await step(holderSession, holderMember, scenario.holder.inner, {
    lockTimeoutMs: HOLDER_LOCK_TIMEOUT_MS,
    leaveOpen: true,
  });
  await onStep("holder", holderSession.index, scenario.holder.slot, holder, scenario.holder.label);

  // 2. The contender walks into them, on the primary session, under lock_timeout.
  const contender = await step(primary, contenderMember, scenario.contender.inner, {
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    leaveOpen: false,
  });
  await onStep("contender", primary.index, scenario.contender.slot, contender, scenario.contender.label);

  // 3. The holder resolves — PRNG-drawn, because "the other transaction rolled back"
  //    and "the other transaction committed" leave the workspace in different states
  //    and a fuzzer should visit both.
  const resolution = rng.bool(0.6) ? "commit" : "rollback";
  const resolved = await holderSession.send(`${resolution};`);
  await onStep(
    resolution === "commit" ? "holder_commit" : "holder_rollback",
    holderSession.index,
    scenario.holder.slot,
    { outcome: resolved.stderr ? "error" : "ok", message: resolved.stderr || null, ms: resolved.ms, sqlstate: null, guardKind: null },
    resolution,
  );

  // The harness's own bookkeeping follows the DATABASE, not the intention: the holder's
  // apply runs only if its statement succeeded AND its transaction was committed.
  if (holder.outcome === "ok" && resolution === "commit" && !resolved.stderr) {
    await scenario.holder.apply?.(holder.payload?.result ?? null);
  }
  if (contender.outcome === "ok") {
    await scenario.contender.apply?.(contender.payload?.result ?? null);
  }

  return {
    steps: { holder, contender, resolution },
    hazard: scenario.judge({ holder, contender }),
  };
}

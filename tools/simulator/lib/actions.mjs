// The action catalogue and the expected-rejection catalogue (GV-471).
//
// Each action turns "this persona, in this workspace, at this simulated minute" into
// ONE statement against the REAL RPC surface, and each rejection is classified into
// one of three buckets:
//
//   ok     — the RPC succeeded.
//   guard  — the database refused, and refusing was the RIGHT answer. A closed period
//            rejecting an edit, an overlapping booking, a stale precondition token, a
//            member who may not touch someone else's entry. These are FEATURES and the
//            simulator counts them: a run with no guards is a run whose fuzz never
//            reached an edge.
//   error  — the database refused and nothing in the catalogue below says it should
//            have. Treated exactly like an oracle violation, because an unclassified
//            rejection is either a bug in the schema or a hole in this catalogue, and
//            both are worth a person's attention.
//
// The catalogue is built from the actual `raise exception` texts in
// supabase-schema.sql. Matching on the MESSAGE and not only on the SQLSTATE is
// deliberate: 22023 and 42501 each cover a dozen unrelated rules, so a SQLSTATE-only
// catalogue would launder a genuine bug into "expected".
//
// DETERMINISM: every argument below is drawn from the seeded PRNG and the simulated
// clock. Nothing here calls Date.now(), Math.random(), or now() in SQL.

import { lit, uuidLit, uuidArrayLit, jsonLit } from "./db.mjs";

// ── Expected rejections ──────────────────────────────────────────────────────
//
// Ordered: the first entry whose test matches wins, so the specific rules sit above
// the broad ones. `kind` is what the dashboard groups by.
const GUARDS = [
  {
    kind: "closed_period",
    test: (m) => /settlement period is closed/i.test(m)
      || /This settlement period snapshot has already been closed/i.test(m),
  },
  {
    kind: "period_locked",
    test: (m) => /period is locked because a payment has been requested/i.test(m),
  },
  {
    kind: "repair_locked",
    test: (m) => /repair belongs to a closed settlement period/i.test(m),
  },
  {
    kind: "booking_overlap",
    test: (m) => /allerede booket for that time|er allerede booket/i.test(m)
      || /The car is already booked/i.test(m),
  },
  {
    kind: "booking_cap",
    test: (m) => /Bookingen ville give|Du kan højst booke|Bookingen varer|Booking cap|Booking day cap|Booking horizon/i.test(m),
  },
  {
    kind: "booking_window",
    test: (m) => /Booking end time must be after start time|Trip date must fall inside the booking window|Trip driver must match the booked member|Trip and booking must belong to the same ledger|Trip booking must reference an active booking|Trip idempotency key belongs to another booking/i.test(m),
  },
  {
    kind: "handover_state",
    test: (m) => /Bookingen er annulleret|Bookingen er ikke startet|Bookingen findes ikke/i.test(m),
  },
  {
    kind: "stale_precondition",
    test: (m) => /En anden har ændret/i.test(m),
  },
  {
    kind: "close_precondition",
    test: (m) => /All settlements must be requested|Entries changed since this close was prepared|^Snapshot |Another settlement close is already in progress|Period snapshot must be a JSON object/i.test(m),
  },
  {
    kind: "settlement_state",
    test: (m) => /settlement request|Settlement request|No active payment request|Request the payment before marking it paid|This settlement pair is no longer part of the current server calculation|Requested amount|Settlement requests must|Only the payer can mark this payment paid|Only the payment recipient can|Invalid settlement request status/i.test(m),
  },
  {
    kind: "identity_reassignment",
    test: (m) => /can reassign who this entry belongs to/i.test(m),
  },
  {
    kind: "rate_limit",
    test: (m) => /Too many onboarding attempts|Upload-grænsen/i.test(m),
  },
  {
    kind: "not_found",
    test: (m) => /was not found|were not found|findes ikke|is unavailable|no longer available|has been deleted|does not exist|disappeared during transition|Recurring expense was not found|Trip does not have a deferred fuel entry/i.test(m),
  },
  {
    kind: "permission",
    sqlstates: new Set(["42501"]),
    test: (m) => /^Only |^Kun |^Current user is not|^Caller is not|Could not match the current user|^Admins cannot|At least one active admin/i.test(m),
  },
  {
    kind: "rls_refused",
    // A direct table write (our soft deletes) that RLS or a grant refused. 42501 with
    // no domain sentence behind it is the privilege system talking, not a rule.
    sqlstates: new Set(["42501"]),
    test: (m) => /permission denied|violates row-level security/i.test(m),
  },
  {
    kind: "validation",
    sqlstates: new Set(["22023", "23514", "23505", "23503"]),
    test: (m) => /must be|must not|cannot be|is required|out of range|højst|skal være|kan ikke være|Missing |Invalid |already in use|already uses that display name|duplicate key value/i.test(m),
  },
];

/** guardKind for an expected rejection, or null when the rejection is a finding. */
export function classifyRejection(sqlstate, message) {
  const text = String(message ?? "");
  for (const guard of GUARDS) {
    if (guard.sqlstates && !guard.sqlstates.has(String(sqlstate))) continue;
    if (guard.test(text)) return guard.kind;
  }
  return null;
}

export const GUARD_KINDS = [...new Set(GUARDS.map((g) => g.kind))];

// ── Fixture vocabulary (Danish, synthetic, no real people or places) ─────────
const STATIONS = ["Circle K", "Shell", "OK", "Q8", "Ingo", "Uno-X"];
const TRIP_NOTES = ["Indkoeb", "Til stranden", "Paa arbejde", "Weekendtur", "Hente boern", "Genbrugsplads"];
const EXPENSE_CATEGORIES = ["insurance", "tax", "parking", "cleaning", "other"];
const SPLIT_RULES = ["equal", "usage"];
const REPAIR_NOTES = ["Nye vinterdaek", "Bremseklodser", "Olieskift", "Sprinklervaeske og pærer"];
const MESSAGES = ["Bilen er tanket op", "Husk at logge turen", "Jeg tager den paa fredag", "Nogen der har set noeglerne"];
const PURPOSES = ["Weekend", "Arbejde", "Indkoeb", "Ferie", "Laegebesoeg"];

// ── Small helpers ────────────────────────────────────────────────────────────

const active = (ws) => ws.members.filter((m) => m.active);
const liveTrips = (ws) => ws.trips.filter((t) => !t.deleted);
const liveFuel = (ws) => ws.fuel.filter((f) => !f.deleted);
const liveBookings = (ws) => ws.bookings.filter((b) => !b.cancelled);
const liveExpenses = (ws) => ws.expenses.filter((e) => !e.deleted);

function memberOf(ws, slot) {
  return ws.members.find((m) => m.slot === slot) ?? null;
}

/** A void-returning RPC still has to hand sim_exec one jsonb row. */
function selectVoid(call) {
  return `select jsonb_build_object('ok', true) from (select ${call}) sim_void`;
}

/** A set-returning RPC's first row as jsonb. */
function selectRow(call) {
  return `select to_jsonb(sim_row) from ${call} sim_row limit 1`;
}

// ── The catalogue ────────────────────────────────────────────────────────────
//
// build(ctx) returns null when the action's preconditions are not met (no live trip
// to edit, no closed period to poke at), and the tick loop re-weights over what is
// left. Anything it DOES return is sent to the database, including the deliberately
// hostile ones — an action returning a `guard` outcome is a success for this tool.

export const ACTIONS = {
  // ── Trips ──────────────────────────────────────────────────────────────────
  log_trip: {
    build: (ctx) => tripWrite(ctx, { backdateDays: 0 }),
  },
  log_trip_backdated: {
    // The forgetful logger's signature move: a trip dated days ago, landing in
    // whatever period is open NOW. This is what walks entries into the carry-over
    // path once a period has been prepared for close (migration 140).
    build: (ctx) => tripWrite(ctx, { backdateDays: ctx.rng.int(2, 9) }),
  },
  log_trip_with_crossing: {
    build: (ctx) => tripWrite(ctx, { backdateDays: 0, crossing: true }),
  },

  edit_trip: {
    build: (ctx) => {
      const trip = ctx.rng.pick(liveTrips(ctx.ws));
      if (!trip) return null;
      return tripWrite(ctx, { existing: trip, stale: ctx.rng.bool(0.2) });
    },
  },

  edit_trip_in_closed_period: {
    // Deliberately hostile: an edit aimed at an entry the close froze. The expected
    // answer is a closed_period guard; anything else is a finding.
    build: (ctx) => {
      const frozen = liveTrips(ctx.ws).filter((t) => ctx.ws.closedPeriodIds.includes(t.periodId));
      const trip = ctx.rng.pick(frozen);
      if (!trip) return null;
      return tripWrite(ctx, { existing: trip });
    },
  },

  delete_trip: {
    build: (ctx) => {
      const trip = ctx.rng.pick(liveTrips(ctx.ws));
      if (!trip || !trip.id) return null;
      return {
        detail: { legacyId: trip.legacyId },
        inner: `with sim_del as (
                  update public.trips
                     set deleted_at = ${lit(ctx.sim.iso())}::timestamptz,
                         updated_at = ${lit(ctx.sim.iso())}::timestamptz
                   where id = ${uuidLit(trip.id)}
                     and deleted_at is null
                  returning id
                )
                select jsonb_build_object('deleted', count(*)) from sim_del`,
        apply: (result) => { if (Number(result?.deleted ?? 0) > 0) trip.deleted = true; },
      };
    },
  },

  // ── Fuel ───────────────────────────────────────────────────────────────────
  log_fuel: { build: (ctx) => fuelWrite(ctx, { backdateDays: 0 }) },
  log_fuel_backdated: { build: (ctx) => fuelWrite(ctx, { backdateDays: ctx.rng.int(2, 9) }) },
  edit_fuel: {
    build: (ctx) => {
      const fuel = ctx.rng.pick(liveFuel(ctx.ws));
      if (!fuel) return null;
      return fuelWrite(ctx, { existing: fuel, stale: ctx.rng.bool(0.2) });
    },
  },
  delete_fuel: {
    // Hostile on purpose when a settlement has already been requested: the entry lock
    // must refuse, and the refusal must be the LOCK's, not a stray 42501.
    build: (ctx) => {
      const fuel = ctx.rng.pick(liveFuel(ctx.ws));
      if (!fuel || !fuel.id) return null;
      return {
        detail: { legacyId: fuel.legacyId },
        inner: `with sim_del as (
                  update public.fuel_payments
                     set deleted_at = ${lit(ctx.sim.iso())}::timestamptz,
                         updated_at = ${lit(ctx.sim.iso())}::timestamptz
                   where id = ${uuidLit(fuel.id)}
                     and deleted_at is null
                  returning id
                )
                select jsonb_build_object('deleted', count(*)) from sim_del`,
        apply: (result) => { if (Number(result?.deleted ?? 0) > 0) fuel.deleted = true; },
      };
    },
  },

  // ── Bookings ───────────────────────────────────────────────────────────────
  create_booking: { build: (ctx) => bookingWrite(ctx, {}) },

  create_overlapping_booking: {
    // Aim straight at prevent_overlapping_car_bookings.
    build: (ctx) => {
      const target = ctx.rng.pick(liveBookings(ctx.ws));
      if (!target) return null;
      return bookingWrite(ctx, { overlapWith: target });
    },
  },

  edit_booking_window: {
    // Moving a booking's end after a handover exists is what fires migration 189's
    // restamp trigger, which re-derives observed_at and therefore the 193 mirror.
    build: (ctx) => {
      const booking = ctx.rng.pick(liveBookings(ctx.ws));
      if (!booking) return null;
      return bookingWrite(ctx, { existing: booking, stale: ctx.rng.bool(0.15) });
    },
  },

  cancel_booking: {
    build: (ctx) => {
      const booking = ctx.rng.pick(liveBookings(ctx.ws));
      if (!booking) return null;
      return {
        detail: { legacyId: booking.legacyId },
        inner: `select public.soft_delete_car_booking(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  legacy_booking_id => ${lit(booking.legacyId)})`,
        apply: () => { booking.cancelled = true; },
      };
    },
  },

  save_handover: {
    build: (ctx) => {
      const booking = ctx.rng.pick(liveBookings(ctx.ws).filter((b) => b.id));
      if (!booking) return null;
      const odo = ctx.ws.odometer + ctx.rng.int(0, 40);
      const fraction = Math.round(ctx.rng.float() * 100) / 100;
      return {
        detail: { legacyId: booking.legacyId, odometer: odo, fraction },
        inner: `select public.upsert_booking_handover(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_booking_id => ${uuidLit(booking.id)},
                  end_odometer_value => ${odo},
                  fuel_fraction_value => ${fraction},
                  parking_location_value => ${lit("P-plads ved nr. " + ctx.rng.int(1, 40))},
                  key_location_value => ${lit("Noeglebox")},
                  condition_ok_value => ${ctx.rng.bool(0.85)},
                  condition_note_value => null,
                  note_to_next_value => null,
                  keys_confirmed_value => true,
                  parking_lat_value => null,
                  parking_lng_value => null,
                  location_seen_at => null,
                  event_title => ${lit("Bilen er afleveret")},
                  event_body => ${lit("Overdragelse registreret")},
                  expected_updated_at => ${booking.handoverUpdatedAt && !ctx.rng.bool(0.1)
                    ? `${lit(booking.handoverUpdatedAt)}::timestamptz`
                    : "null"})`,
        apply: (result) => {
          booking.handover = true;
          booking.handoverUpdatedAt = result?.updated_at ?? null;
          ctx.ws.odometer = Math.max(ctx.ws.odometer, odo);
        },
      };
    },
  },

  complete_booking: {
    build: (ctx) => {
      const booking = ctx.rng.pick(liveBookings(ctx.ws).filter((b) => b.id && !b.completed));
      if (!booking) return null;
      const driver = memberOf(ctx.ws, booking.memberSlot);
      if (!driver || !driver.active) return null;
      const participants = ctx.rng.subset(active(ctx.ws), 1, Math.min(3, active(ctx.ws).length));
      const ids = [...new Set([driver.memberId, ...participants.map((m) => m.memberId)])];
      const startKm = ctx.ws.odometer;
      const endKm = startKm + ctx.rng.int(5, 180);
      const resolution = ctx.rng.weighted([["logged", 4], ["not_refuelled", 3], ["deferred", 2], ["not_needed", 1]]);
      const legacyId = nextId(ctx.ws, "trip");
      const fuelLegacyId = `${legacyId}-f`;
      const amount = ctx.rng.money(180, 720);
      const liters = Math.round((amount / 13.4) * 100) / 100;
      const logged = resolution === "logged";
      return {
        actorOverride: driver.slot,
        detail: { legacyId, resolution, endKm },
        inner: `select public.complete_booking_trip_with_fuel(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
                  target_booking_id => ${uuidLit(booking.id)},
                  legacy_trip_id => ${lit(legacyId)},
                  booking_driver_member_id => ${uuidLit(driver.memberId)},
                  trip_date_value => ${lit(booking.startDate)}::date,
                  start_km_value => ${startKm},
                  end_km_value => ${endKm},
                  note_value => ${lit(ctx.rng.pick(TRIP_NOTES))},
                  participant_member_ids => ${uuidArrayLit(ids)},
                  fuel_resolution_value => ${lit(resolution)},
                  fuel_legacy_id => ${logged ? lit(fuelLegacyId) : "null"},
                  fuel_payer_member_id => ${logged ? uuidLit(driver.memberId) : "null"},
                  fuel_payment_date_value => ${logged ? `${lit(booking.startDate)}::date` : "null"},
                  fuel_amount_value => ${logged ? amount : "null"},
                  fuel_currency_value => ${lit("DKK")},
                  fuel_liters_value => ${logged ? liters : "null"},
                  fuel_price_per_liter_value => ${logged ? 13.4 : "null"},
                  fuel_odometer_value => ${logged ? endKm : "null"},
                  fuel_station_name_value => ${logged ? lit(ctx.rng.pick(STATIONS)) : "null"},
                  fuel_station_brand_value => ${logged ? lit(ctx.rng.pick(STATIONS)) : "null"},
                  fuel_full_tank_value => ${logged ? ctx.rng.bool(0.5) : "false"},
                  crossing_cost_value => null,
                  crossing_note_value => null,
                  crossing_paid_by => null,
                  trip_event_title => ${lit("Booking afsluttet")},
                  trip_event_body => ${lit(`${endKm - startKm} km`)},
                  fuel_event_title => ${logged ? lit("Optankning registreret") : "null"},
                  fuel_event_body => ${logged ? lit(`${amount} kr`) : "null"},
                  crossing_provided => false)`,
        apply: (result) => {
          booking.completed = true;
          ctx.ws.odometer = endKm;
          ctx.ws.trips.push({
            legacyId,
            id: result?.trip_id ?? null,
            periodId: ctx.ws.openPeriodId,
            driverSlot: driver.slot,
            participantIds: ids,
            startKm,
            endKm,
            date: booking.startDate,
            deleted: false,
          });
          if (result?.fuel_id) {
            ctx.ws.fuel.push({
              legacyId: fuelLegacyId,
              id: result.fuel_id,
              periodId: ctx.ws.openPeriodId,
              payerSlot: driver.slot,
              amount,
              date: booking.startDate,
              deleted: false,
            });
          }
        },
      };
    },
  },

  // ── Workspace expenses, recurring templates, repairs ──────────────────────
  add_expense: { build: (ctx) => expenseWrite(ctx, {}) },
  edit_expense: {
    build: (ctx) => {
      const expense = ctx.rng.pick(liveExpenses(ctx.ws));
      if (!expense) return null;
      return expenseWrite(ctx, { existing: expense });
    },
  },
  delete_expense: {
    build: (ctx) => {
      const expense = ctx.rng.pick(liveExpenses(ctx.ws));
      if (!expense) return null;
      return {
        detail: { expenseId: expense.id },
        inner: `select public.soft_delete_workspace_expense(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  expense_id_value => ${uuidLit(expense.id)})`,
        apply: () => { expense.deleted = true; },
      };
    },
  },

  upsert_recurring: {
    build: (ctx) => {
      const existing = ctx.rng.bool(0.4) ? ctx.rng.pick(ctx.ws.recurring) : null;
      const payer = ctx.rng.pick(active(ctx.ws));
      if (!payer) return null;
      const amount = ctx.rng.money(120, 900);
      // Inside [today-90d, today+5y] as the RPC demands, and inside the simulated
      // present so a later generate_due actually has something to materialise.
      const nextDue = ctx.sim.date(ctx.rng.int(-20, 25) * 24 * 60);
      return {
        detail: { recurringId: existing?.id ?? null, amount },
        inner: `select public.upsert_recurring_expense(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  recurring_id_value => ${uuidLit(existing?.id ?? null)},
                  category_value => ${lit(ctx.rng.pick(EXPENSE_CATEGORIES))},
                  description_value => ${lit("Fast udgift " + ctx.rng.int(1, 99))},
                  amount_value => ${amount},
                  cadence_value => ${lit(ctx.rng.pick(["monthly", "quarterly", "yearly"]))},
                  next_due_date_value => ${lit(nextDue)}::date,
                  split_rule_value => ${lit(ctx.rng.pick(SPLIT_RULES))},
                  split_config_value => null,
                  paid_by_value => ${uuidLit(payer.memberId)},
                  is_active_value => ${ctx.rng.bool(0.85)},
                  event_title => ${lit("Fast udgift opdateret")},
                  event_body => ${lit(`${amount} kr`)})`,
        apply: (result) => {
          if (!result?.id) return;
          if (!ctx.ws.recurring.some((r) => r.id === result.id)) ctx.ws.recurring.push({ id: result.id });
        },
      };
    },
  },

  generate_recurring: {
    build: (ctx) => {
      if (ctx.ws.recurring.length === 0) return null;
      return {
        detail: {},
        inner: `select public.generate_due_recurring_expenses(target_ledger_id => ${lit(ctx.ws.ledgerId)})`,
        apply: () => {},
      };
    },
  },

  log_repair: {
    build: (ctx) => {
      const payer = ctx.rng.pick(active(ctx.ws));
      if (!payer) return null;
      const cost = ctx.rng.money(250, 4200);
      return {
        detail: { cost },
        inner: `select public.insert_repair(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  repair_date_value => ${lit(ctx.sim.date())}::date,
                  description_value => ${lit(ctx.rng.pick(REPAIR_NOTES))},
                  cost_dkk_value => ${cost},
                  odo_km_value => ${Math.round(ctx.ws.odometer)},
                  workshop => ${lit("Vaerksted " + ctx.rng.int(1, 9))},
                  paid_by_member_id_value => ${uuidLit(payer.memberId)})`,
        apply: (result) => { if (result?.id) ctx.ws.repairs.push({ id: result.id }); },
      };
    },
  },

  // ── Settings and members ───────────────────────────────────────────────────
  update_settings: {
    build: (ctx) => {
      const mode = ctx.rng.pick(["ligeligt", "efter_koersel", "deles_ikke"]);
      const defaults = {};
      for (const category of EXPENSE_CATEGORIES) defaults[category] = ctx.rng.pick(SPLIT_RULES);
      return {
        detail: { repairsSplitMode: mode },
        inner: selectVoid(`public.update_ledger_settings(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  settlement_mode_value => null,
                  expense_split_defaults_value => ${jsonLit(defaults)},
                  vehicle_info_value => null,
                  repairs_split_mode_value => ${lit(mode)})`),
        apply: () => {},
      };
    },
  },

  set_tank_baseline: {
    build: (ctx) => {
      const fraction = Math.round(ctx.rng.float() * 100) / 100;
      return {
        detail: { fraction },
        inner: `select public.set_tank_baseline(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  odometer_value => ${Math.round(ctx.ws.odometer)},
                  fraction_value => ${fraction},
                  event_title => ${lit("Tankniveau nulstillet")},
                  event_body => ${lit(`${Math.round(fraction * 100)} %`)})`,
        apply: () => {},
      };
    },
  },

  rename_member: {
    build: (ctx) => {
      const target = ctx.rng.pick(active(ctx.ws));
      if (!target) return null;
      const name = `${target.baseName} ${ctx.rng.int(2, 99)}`;
      return {
        detail: { slot: target.slot, name },
        inner: selectRow(`public.set_member_name(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_member_id => ${uuidLit(target.memberId)},
                  new_name => ${lit(name)},
                  event_title => ${lit("Navn opdateret")},
                  event_body => ${lit(name)})`),
        apply: () => { target.name = name; },
      };
    },
  },

  post_message: {
    build: (ctx) => ({
      detail: {},
      inner: `select public.post_message(
                target_ledger_id => ${lit(ctx.ws.ledgerId)},
                body_value => ${lit(ctx.rng.pick(MESSAGES))})`,
      apply: () => {},
    }),
  },

  // ── Settlement lifecycle ───────────────────────────────────────────────────
  //
  // These three read the SERVER's own calculation before deciding, which is a
  // database read in the decision path — deterministic, because the database state
  // at that tick is itself a function of the seed.
  request_settlement: {
    async build(ctx) {
      const pairs = await ctx.settlementPairs(ctx.ws, ctx.ws.openPeriodId);
      const outstanding = pairs.filter((p) => !ctx.ws.requests.some(
        (r) => r.fromId === p.fromId && r.toId === p.toId && r.status !== "open" && r.status !== "cancelled",
      ));
      const pair = ctx.rng.pick(outstanding.length > 0 ? outstanding : pairs);
      if (!pair) return null;
      return {
        detail: { amount: pair.amount },
        inner: `select public.upsert_settlement_request_status(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
                  payer_member_id => ${uuidLit(pair.fromId)},
                  recipient_member_id => ${uuidLit(pair.toId)},
                  amount_value => ${pair.amount},
                  currency_value => ${lit("DKK")},
                  next_status => ${lit("requested")},
                  current_pair_keys => array[]::text[],
                  p_note => null)`,
        apply: (result) => {
          const existing = ctx.ws.requests.find((r) => r.fromId === pair.fromId && r.toId === pair.toId);
          if (existing) { existing.status = "requested"; existing.amount = pair.amount; return; }
          ctx.ws.requests.push({
            id: result?.settlement_request_id ?? null,
            fromId: pair.fromId,
            toId: pair.toId,
            amount: pair.amount,
            status: "requested",
          });
        },
      };
    },
  },

  mark_settlement_paid: {
    build: (ctx) => {
      const actorMember = memberOf(ctx.ws, ctx.actorSlot);
      const mine = ctx.ws.requests.filter((r) => r.status === "requested" && r.fromId === actorMember?.memberId);
      const request = ctx.rng.pick(mine);
      if (!request) return null;
      return {
        detail: { amount: request.amount },
        inner: `select public.upsert_settlement_request_status(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
                  payer_member_id => ${uuidLit(request.fromId)},
                  recipient_member_id => ${uuidLit(request.toId)},
                  amount_value => ${request.amount},
                  currency_value => ${lit("DKK")},
                  next_status => ${lit("paid_pending")},
                  current_pair_keys => array[]::text[],
                  p_note => ${lit("Betalt via MobilePay")})`,
        apply: () => { request.status = "paid_pending"; },
      };
    },
  },

  confirm_settlement: {
    build: (ctx) => {
      const actorMember = memberOf(ctx.ws, ctx.actorSlot);
      const mine = ctx.ws.requests.filter((r) => r.status === "paid_pending" && r.toId === actorMember?.memberId);
      const request = ctx.rng.pick(mine);
      if (!request) return null;
      return {
        detail: { amount: request.amount },
        inner: `select public.upsert_settlement_request_status(
                  target_ledger_id => ${lit(ctx.ws.ledgerId)},
                  target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
                  payer_member_id => ${uuidLit(request.fromId)},
                  recipient_member_id => ${uuidLit(request.toId)},
                  amount_value => ${request.amount},
                  currency_value => ${lit("DKK")},
                  next_status => ${lit("paid")},
                  current_pair_keys => array[]::text[],
                  p_note => null)`,
        apply: () => { request.status = "paid"; },
      };
    },
  },

  close_period: {
    // The full production choreography, exactly as tools/load-rehearsal drives it:
    // ask the server for the settlement, request every outstanding pair at its
    // CURRENT amount, then close against a snapshot. The one addition here is that
    // the snapshot carries the server's own entryFingerprint, so the close STORES it
    // and oracle invariant 2 has something to recompute against later.
    async build(ctx) {
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
      return {
        detail: { requests: closeProgram.requests.length, periodId: ctx.ws.openPeriodId },
        inner: statements,
        apply: async () => {
          ctx.ws.closedPeriodIds.push(ctx.ws.openPeriodId);
          ctx.ws.requests = [];
          await ctx.refreshOpenPeriod(ctx.ws);
        },
      };
    },
  },
};

// ── Shared builders ──────────────────────────────────────────────────────────

function nextId(ws, kind) {
  ws.counters[kind] = (ws.counters[kind] ?? 0) + 1;
  return `w${ws.index}-${kind}-${ws.counters[kind]}`;
}

function tripWrite(ctx, { existing = null, backdateDays = 0, crossing = false, stale = false }) {
  const members = active(ctx.ws);
  if (members.length === 0) return null;
  // On an edit the driver usually stays put; one edit in four REASSIGNS it, which is
  // the only thing that can fire enforce_identity_reassignment (GV-253) — the rule
  // that only the creator or an admin may move an entry to someone else.
  const reassign = Boolean(existing) && ctx.rng.bool(0.25);
  const driver = existing && !reassign ? memberOf(ctx.ws, existing.driverSlot) : ctx.rng.pick(members);
  if (!driver) return null;
  const participants = ctx.rng.subset(members, 1, Math.min(3, members.length));
  const ids = [...new Set([driver.memberId, ...participants.map((m) => m.memberId)])];
  const startKm = existing ? existing.startKm : ctx.ws.odometer;
  const endKm = startKm + ctx.rng.int(4, 220);
  const legacyId = existing ? existing.legacyId : nextId(ctx.ws, "trip");
  const tripDate = existing ? existing.date : ctx.sim.date(-backdateDays * 24 * 60);
  const crossingCost = crossing ? ctx.rng.money(35, 260) : null;
  const crossingPayer = crossing ? ctx.rng.pick(participants) ?? driver : null;

  return {
    detail: { legacyId, endKm, edit: Boolean(existing), stale, crossing, reassign },
    inner: `select public.upsert_trip_with_participants(
              target_ledger_id => ${lit(ctx.ws.ledgerId)},
              target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
              legacy_trip_id => ${lit(legacyId)},
              driver_member_id => ${uuidLit(driver.memberId)},
              trip_date_value => ${lit(tripDate)}::date,
              start_km_value => ${startKm},
              end_km_value => ${endKm},
              note_value => ${lit(ctx.rng.pick(TRIP_NOTES))},
              participant_member_ids => ${uuidArrayLit(ids)},
              crossing_cost_value => ${crossingCost ?? "null"},
              crossing_note_value => ${crossing ? lit("Storebaeltsbroen") : "null"},
              crossing_paid_by => ${crossing ? uuidLit(crossingPayer.memberId) : "null"},
              event_title => ${lit("Ny tur logget")},
              event_body => ${lit(`${endKm - startKm} km`)},
              crossing_provided => ${crossing},
              expected_updated_at => ${stale ? `${lit(ctx.sim.epochIso)}::timestamptz` : "null"})`,
    apply: (result) => {
      ctx.ws.odometer = Math.max(ctx.ws.odometer, endKm);
      if (existing) {
        existing.endKm = endKm;
        existing.driverSlot = driver.slot;
        return;
      }
      ctx.ws.trips.push({
        legacyId,
        id: result?.trip_id ?? null,
        periodId: ctx.ws.openPeriodId,
        driverSlot: driver.slot,
        participantIds: ids,
        startKm,
        endKm,
        date: tripDate,
        deleted: false,
      });
    },
  };
}

function fuelWrite(ctx, { existing = null, backdateDays = 0, stale = false }) {
  const payer = existing ? memberOf(ctx.ws, existing.payerSlot) : ctx.rng.pick(active(ctx.ws));
  if (!payer) return null;
  const legacyId = existing ? existing.legacyId : nextId(ctx.ws, "fuel");
  const amount = ctx.rng.money(150, 780);
  const pricePerLiter = ctx.rng.money(11.5, 15.5);
  const liters = Math.round((amount / pricePerLiter) * 100) / 100;
  const date = existing ? existing.date : ctx.sim.date(-backdateDays * 24 * 60);
  const station = ctx.rng.pick(STATIONS);
  return {
    detail: { legacyId, amount, edit: Boolean(existing), stale },
    inner: `select public.upsert_fuel_payment(
              target_ledger_id => ${lit(ctx.ws.ledgerId)},
              target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
              legacy_fuel_id => ${lit(legacyId)},
              payer_member_id => ${uuidLit(payer.memberId)},
              payment_date_value => ${lit(date)}::date,
              amount_value => ${amount},
              currency_value => ${lit("DKK")},
              liters_value => ${liters},
              price_per_liter_value => ${pricePerLiter},
              odometer_value => ${Math.round(ctx.ws.odometer)},
              station_name_value => ${lit(station)},
              station_brand_value => ${lit(station)},
              full_tank_value => ${ctx.rng.bool(0.45)},
              event_title => ${lit("Optankning registreret")},
              event_body => ${lit(`${amount} kr`)},
              expected_updated_at => ${stale ? `${lit(ctx.sim.epochIso)}::timestamptz` : "null"},
              booking_id_value => null)`,
    apply: (result) => {
      if (existing) { existing.amount = amount; return; }
      ctx.ws.fuel.push({
        legacyId,
        id: result?.fuel_id ?? null,
        periodId: ctx.ws.openPeriodId,
        payerSlot: payer.slot,
        amount,
        date,
        deleted: false,
      });
    },
  };
}

function bookingWrite(ctx, { existing = null, overlapWith = null, stale = false }) {
  const member = existing ? memberOf(ctx.ws, existing.memberSlot) : ctx.rng.pick(active(ctx.ws));
  if (!member) return null;
  const legacyId = existing ? existing.legacyId : nextId(ctx.ws, "booking");

  // Booking windows are stored as ABSOLUTE minutes since the simulated epoch, not as
  // an offset from "now": an edit or an overlap probe happens ticks later, and a
  // relative offset would silently slide the window forward each time — the overlap
  // would stop overlapping and the edit would stop being an edit.
  //
  // The lead time is capped at 40 hours on purpose. The simulated clock runs entirely
  // in the past (see lib/prng.mjs), and the epoch is chosen with three days of margin,
  // so a booking created on the last tick still STARTS before the real present — which
  // is what migration 189 requires before a handover may be saved.
  let startAbs;
  let lengthMinutes;
  if (overlapWith) {
    // Land INSIDE an existing window on purpose.
    startAbs = overlapWith.startAbs + 60;
    lengthMinutes = Math.max(120, overlapWith.lengthMinutes - 60);
  } else if (existing) {
    startAbs = existing.startAbs;
    lengthMinutes = existing.lengthMinutes + ctx.rng.int(-180, 300);
    if (lengthMinutes < 60) lengthMinutes = 60;
  } else {
    startAbs = ctx.sim.offsetMinutes() + ctx.rng.int(2, 40) * 60;
    lengthMinutes = ctx.rng.int(2, 26) * 60;
  }

  const startAt = ctx.sim.isoAt(startAbs);
  const endAt = ctx.sim.isoAt(startAbs + lengthMinutes);
  const startDate = ctx.sim.dateAt(startAbs);

  return {
    actorOverride: member.slot,
    detail: { legacyId, edit: Boolean(existing), overlap: Boolean(overlapWith) },
    inner: `select public.upsert_car_booking(
              target_ledger_id => ${lit(ctx.ws.ledgerId)},
              legacy_booking_id => ${lit(legacyId)},
              booking_member_id => ${uuidLit(member.memberId)},
              start_at_value => ${lit(startAt)}::timestamptz,
              end_at_value => ${lit(endAt)}::timestamptz,
              purpose_value => ${lit(ctx.rng.pick(PURPOSES))},
              event_title => ${lit("Booking oprettet")},
              event_body => ${lit("Reserveret")},
              fuel_stop_value => null,
              expected_updated_at => ${stale ? `${lit(ctx.sim.epochIso)}::timestamptz` : "null"})`,
    apply: (result) => {
      if (existing) {
        existing.lengthMinutes = lengthMinutes;
        existing.startDate = startDate;
        return;
      }
      ctx.ws.bookings.push({
        legacyId,
        id: result?.booking_id ?? null,
        memberSlot: member.slot,
        startAbs,
        lengthMinutes,
        startDate,
        cancelled: false,
        completed: false,
        handover: false,
        handoverUpdatedAt: null,
      });
    },
  };
}

function expenseWrite(ctx, { existing = null }) {
  const payer = ctx.rng.pick(active(ctx.ws));
  if (!payer) return null;
  const amount = ctx.rng.money(90, 2400);
  const category = ctx.rng.pick(EXPENSE_CATEGORIES);
  return {
    detail: { expenseId: existing?.id ?? null, amount, category },
    inner: `select public.upsert_workspace_expense(
              target_ledger_id => ${lit(ctx.ws.ledgerId)},
              target_open_period_id => ${uuidLit(ctx.ws.openPeriodId)},
              expense_id_value => ${uuidLit(existing?.id ?? null)},
              category_value => ${lit(category)},
              description_value => ${lit(`Udgift ${ctx.rng.int(1, 999)}`)},
              amount_value => ${amount},
              expense_date_value => ${lit(ctx.sim.date())}::date,
              split_rule_value => ${lit(ctx.rng.pick(SPLIT_RULES))},
              split_config_value => null,
              paid_by_value => ${uuidLit(payer.memberId)},
              event_title => ${lit("Udgift tilfoejet")},
              event_body => ${lit(`${amount} kr`)})`,
    apply: (result) => {
      if (existing || !result?.id) return;
      ctx.ws.expenses.push({ id: result.id, deleted: false });
    },
  };
}

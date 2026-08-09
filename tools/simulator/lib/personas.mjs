// Who is in the car, and what they tend to do (GV-471).
//
// A uniform random walk over the action catalogue produces a workspace nobody
// recognises: everybody edits as often as they log, nobody ever closes a period, and
// the sequences that actually break things — a late fuel log landing after the close
// was prepared, a booking's end time moved after its handover was written — come up
// only by accident. Personas are the fix: each member gets a behavioural profile at
// seed time and keeps it for the whole run, so the run produces the SHAPES real
// workspaces produce, at the rates real workspaces produce them.
//
// The weights below are relative, not probabilities; the tick loop discards actions
// whose preconditions are not met and re-weights over what is left. An action name
// absent from a persona's map is never chosen by that persona.

export const PERSONAS = {
  // The one who set the workspace up. The only persona that closes periods, changes
  // settings, or drives settlement requests — mirroring the admin gates in the SQL.
  admin: {
    label: "Administrator",
    danish: "Administrator",
    weights: {
      log_trip: 6,
      log_fuel: 4,
      create_booking: 3,
      add_expense: 4,
      upsert_recurring: 2,
      generate_recurring: 2,
      log_repair: 2,
      request_settlement: 5,
      close_period: 4,
      update_settings: 2,
      set_tank_baseline: 1,
      rename_member: 1,
      post_message: 3,
      edit_trip: 2,
      edit_fuel: 2,
      delete_expense: 1,
    },
  },

  // Puts most of the kilometres on the car. Trips and fills, rarely anything else.
  heavy_driver: {
    label: "Heavy driver",
    danish: "Storforbruger",
    weights: {
      log_trip: 14,
      log_fuel: 8,
      log_trip_with_crossing: 3,
      create_booking: 3,
      complete_booking: 3,
      save_handover: 2,
      post_message: 2,
      mark_settlement_paid: 2,
      edit_trip: 1,
    },
  },

  // Logs days late, and keeps logging after the period has been prepared or closed.
  // This persona is the reason the carry-over path (migration 140) and the
  // closed-period lock get exercised without anyone scripting them.
  forgetful_logger: {
    label: "Forgetful logger",
    danish: "Glemsom logger",
    weights: {
      log_trip_backdated: 10,
      log_fuel_backdated: 8,
      log_trip: 3,
      log_fuel: 3,
      edit_trip_in_closed_period: 4,
      delete_fuel: 2,
      post_message: 2,
      mark_settlement_paid: 1,
    },
  },

  // Never satisfied with what they typed. Edits and deletes recent entries, and edits
  // booking windows — which is what fires migration 189's handover restamp.
  serial_editor: {
    label: "Serial editor",
    danish: "Serieredigerer",
    weights: {
      edit_trip: 8,
      edit_fuel: 6,
      edit_booking_window: 6,
      delete_trip: 3,
      save_handover_fat_finger: 1,
      delete_fuel: 3,
      cancel_booking: 2,
      edit_expense: 3,
      log_trip: 3,
      log_fuel: 2,
      save_handover: 2,
      post_message: 1,
    },
  },

  // Lives in the calendar. Books, hands the car over with an odometer and a fuel
  // eyeball, and completes bookings into trips.
  booker: {
    label: "Booker",
    danish: "Bookinggal",
    weights: {
      create_booking: 10,
      create_overlapping_booking: 3,
      // Migration 195 (GV-475) made the ten-times odometer a guard, so it belongs in
      // the default mix like every other hostile action. Until then it was flag-gated
      // out, because the write succeeded and a default run must not be red for a bug
      // nobody has fixed. See ACTIONS.save_handover_fat_finger.
      save_handover_fat_finger: 3,
      complete_booking: 6,
      save_handover: 6,
      edit_booking_window: 3,
      cancel_booking: 2,
      log_trip: 2,
      log_fuel: 2,
      post_message: 2,
    },
  },

  // ── GV-478 Phase B: the sixth persona ──────────────────────────────────────
  //
  // Drives the same commute every day and spends part of it underground, in a car
  // park, or somewhere with one bar of signal. The app keeps working — that is the
  // point of an offline-first client — so they keep logging, and the writes sit in a
  // local queue until the phone reconnects and sends the lot.
  //
  // WHY THIS IS A PERSONA AND NOT A FLAG. Everything about a queued write is normal
  // except WHEN it arrives: it carries the timestamp of the moment it was decided, it
  // arrives after every write the rest of the workspace made in between, and it may
  // carry a precondition token for a version of the row that no longer exists. Those
  // three properties together are the bug generator — a late edit landing on a period
  // that was closed while the phone was in a tunnel — and no scripted test writes
  // them, because writing them means modelling a queue.
  //
  // The mechanics (drawing the offline stretch, holding the queue, flushing it in one
  // burst, and reading the decision-time `expected_updated_at`) live in run.mjs and
  // lib/actions.mjs; this object only says WHO does it and HOW OFTEN.
  offline_commuter: {
    label: "Offline commuter",
    danish: "Offline-pendleren",
    offline: {
      // Drawn once per tick this persona is picked and not already offline. At ~1 in 5
      // with a 3–9 tick stretch, an offline member spends roughly half a long run
      // queueing, which is aggressive for one member and about right for a workspace:
      // it guarantees several bursts per run without turning the whole run into one.
      chance: 0.22,
      minTicks: 3,
      maxTicks: 9,
      // A real queue is bounded by the user's patience, not by disk. Eight is enough
      // to land a burst across a period close and short enough that one member cannot
      // monopolise a run's writes.
      maxQueued: 8,
    },
    weights: {
      log_trip: 9,
      log_fuel: 5,
      log_trip_backdated: 3,
      edit_trip: 3,
      edit_fuel: 2,
      complete_booking: 2,
      create_booking: 2,
      save_handover: 1,
      post_message: 2,
      mark_settlement_paid: 1,
    },
  },
};

export const PERSONA_NAMES = Object.keys(PERSONAS);

/** Non-admin personas, in a fixed order so a seed picks the same one every replay. */
export const JOINER_PERSONAS = ["heavy_driver", "forgetful_logger", "serial_editor", "booker"];

/** GV-478: the same list plus the offline commuter, which is the default. `--no-offline`
 *  falls back to JOINER_PERSONAS, which is also what reproduces a Phase A action stream:
 *  a sixth name in the pool moves every persona draw after it. */
export const JOINER_PERSONAS_WITH_OFFLINE = [...JOINER_PERSONAS, "offline_commuter"];

/**
 * Assign personas to a workspace's slots. Slot 0 is always the admin (they created
 * the workspace); the rest are drawn from `pool`, round-robin-shuffled so a
 * four-member workspace gets four different ones.
 *
 * With more personas in the pool than joiner slots, some personas simply do not appear
 * in a small workspace — the offline commuter included. That is the same rule the other
 * five have always lived under, and it is why a two-member run is not a coverage claim.
 */
export function assignPersonas(memberCount, rng, { pool: source = JOINER_PERSONAS } = {}) {
  const out = ["admin"];
  const pool = [];
  while (pool.length < memberCount - 1) pool.push(...source);
  for (let slot = 1; slot < memberCount; slot += 1) {
    const index = rng.int(0, Math.min(source.length, pool.length) - 1);
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

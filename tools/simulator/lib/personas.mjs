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
      complete_booking: 6,
      save_handover: 6,
      edit_booking_window: 3,
      cancel_booking: 2,
      log_trip: 2,
      log_fuel: 2,
      post_message: 2,
    },
  },
};

export const PERSONA_NAMES = Object.keys(PERSONAS);

/** Non-admin personas, in a fixed order so a seed picks the same one every replay. */
export const JOINER_PERSONAS = ["heavy_driver", "forgetful_logger", "serial_editor", "booker"];

/**
 * Assign personas to a workspace's slots. Slot 0 is always the admin (they created
 * the workspace); the rest are drawn from JOINER_PERSONAS, round-robin-shuffled so a
 * four-member workspace gets four different ones.
 */
export function assignPersonas(memberCount, rng) {
  const out = ["admin"];
  const pool = [];
  while (pool.length < memberCount - 1) pool.push(...JOINER_PERSONAS);
  for (let slot = 1; slot < memberCount; slot += 1) {
    const index = rng.int(0, Math.min(JOINER_PERSONAS.length, pool.length) - 1);
    out.push(pool.splice(index, 1)[0]);
  }
  return out;
}

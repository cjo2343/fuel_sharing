// Day and week rhythm (GV-478 Phase B, feature 1).
//
// WHAT WAS WRONG WITH THE OLD CLOCK. Phase A advanced the simulated clock by a uniform
// 1–6 hours per tick. That is a perfectly good way to move time forward and a very poor
// model of a shared car: it puts as many trips at 03:00 as at 08:00, it makes Tuesday
// indistinguishable from Sunday, and it spreads the settlement work evenly across the
// month instead of bunching it where a group actually does it. The sequences that break
// things are the ones a rhythm produces — three people logging within the same
// afternoon peak, a weekend of catch-up entries landing on a period somebody closed on
// the 31st — and a uniform walk reaches them only by accident.
//
// TWO HALVES, BOTH PRNG-DRIVEN AND BOTH INSPECTABLE:
//
//   1. WHEN the next tick happens. `RhythmClock` advances by rejection sampling against
//      an hour-of-week intensity curve: draw a small step, and keep stepping while the
//      hour it lands in is quiet. Nights are crossed in a few large strides (the curve
//      is ~0,02 there, so almost every draw rejects), peaks are entered and lingered in
//      (the curve is ~0,95, so the first draw almost always accepts). The occasional
//      2 a.m. action survives, because it should: somebody does log yesterday's trip
//      from bed.
//
//   2. WHAT the actor is likely to do at that moment. `modulateWeights` multiplies a
//      persona's action weights by a small, explicit rule table — commute trips at
//      peak, bookings in the evening, fuel after a long stretch without one, the
//      admin's settlement work at the month boundary, the forgetful logger catching up
//      at the weekend. Rules are data, not code, so the model can be read.
//
// DETERMINISM. Everything here is a pure function of the simulated instant, the run's
// configuration and the seeded PRNG. Nothing reads the wall clock.
//
// ONE HONEST CONSEQUENCE, AND IT IS LOAD-BEARING. Both halves key off the simulated
// WEEKDAY and hour, which are derived from the epoch — so unlike Phase A, the action
// stream now depends on the epoch. Every repro command the tool prints already pins
// `--epoch`; with the rhythm on, that field stopped being cosmetic. A repro without it
// is not a repro.

import { SimClock } from "./prng.mjs";

// ── The intensity curve ──────────────────────────────────────────────────────
//
// Relative probability that a tick's activity happens in this hour, 0..1. These are
// shapes, not measurements: nobody has a per-hour dataset of Danish car sharing, and
// pretending otherwise by quoting decimals to three places would be false precision.
// What they encode is the shape everybody recognises — two weekday commute humps, a
// broad weekend midday plateau, and a near-dead 00–05.
export const WEEKDAY_INTENSITY = [
  //  00    01    02    03    04    05
  0.02, 0.02, 0.01, 0.01, 0.02, 0.06,
  //  06    07    08    09     — morning commute
  0.45, 0.95, 0.85, 0.40,
  //  10    11    12    13    14
  0.22, 0.22, 0.30, 0.22, 0.28,
  //  15    16    17    18     — afternoon commute, the bigger of the two
  0.70, 0.95, 0.90, 0.60,
  //  19    20    21    22    23
  0.45, 0.40, 0.32, 0.18, 0.08,
];

export const WEEKEND_INTENSITY = [
  0.06, 0.05, 0.03, 0.02, 0.02, 0.03,
  0.08, 0.14, 0.25, 0.45,
  0.70, 0.80, 0.75, 0.70, 0.72,
  0.70, 0.65, 0.60, 0.55,
  0.50, 0.45, 0.40, 0.28, 0.15,
];

/** Monday-based weekday index, 0 = Monday … 6 = Sunday. UTC, like every other date here. */
export function weekdayIndex(date) {
  return (date.getUTCDay() + 6) % 7;
}

export const WEEKDAY_LABELS_DA = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];

export const PHASE_LABELS_DA = {
  night: "nat",
  morning_peak: "morgenmyldretid",
  midday: "dagtimer",
  afternoon_peak: "eftermiddagsmyldretid",
  evening: "aften",
};

export function intensityAt(date) {
  const table = weekdayIndex(date) >= 5 ? WEEKEND_INTENSITY : WEEKDAY_INTENSITY;
  return table[date.getUTCHours()];
}

/**
 * Everything the weight rules and the journal need to know about one simulated moment.
 *
 * `extra` carries workspace-level signals that are not a property of the clock — today
 * only `kmSinceFuel`, which is what makes "fuel gets logged after a long stretch of
 * driving" a rule rather than a coincidence.
 */
export function rhythmContextAt(date, extra = {}) {
  const hour = date.getUTCHours();
  const weekday = weekdayIndex(date);
  const isWeekend = weekday >= 5;
  const dayOfMonth = date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const morningPeak = !isWeekend && hour >= 6 && hour <= 9;
  const afternoonPeak = !isWeekend && hour >= 15 && hour <= 18;
  const night = hour <= 5;
  const phase = night
    ? "night"
    : morningPeak
      ? "morning_peak"
      : afternoonPeak
        ? "afternoon_peak"
        : hour >= 19
          ? "evening"
          : "midday";
  return {
    hour,
    weekday,
    weekdayLabel: WEEKDAY_LABELS_DA[weekday],
    isWeekend,
    dayOfMonth,
    daysInMonth,
    // The last three and the first three days of the SIMULATED month. This is when a
    // group settles up, and it is the only reason close_period and the settlement
    // choreography cluster rather than dribbling out at a constant rate.
    monthEdge: dayOfMonth <= 3 || dayOfMonth > daysInMonth - 3,
    morningPeak,
    afternoonPeak,
    commutePeak: morningPeak || afternoonPeak,
    evening: hour >= 18 && hour <= 22,
    night,
    endOfDay: hour >= 19 && hour <= 23,
    phase,
    phaseLabel: PHASE_LABELS_DA[phase],
    kmSinceFuel: 0,
    ...extra,
  };
}

/** "man 07:20" — the rhythm, in the two characters a reader actually scans for. */
export function clockLabel(date) {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAY_LABELS_DA[weekdayIndex(date)]} ${hh}:${mm}`;
}

// ── The clock ────────────────────────────────────────────────────────────────

/** Mean simulated hours per tick under the curve and the step sizes above, measured
 *  over 60 000 ticks across three seeds. Deliberately tuned to sit next to Phase A's
 *  uniform 3,5 h, so a rhythm run covers about the same number of calendar days as the
 *  flat run it replaces — the clustering comes from the REJECTION, not from the step
 *  size (34 % of actions land in the four peak hours against 17 % uniform, and 1 % in
 *  01–04 against 17 %). It is used for exactly one thing: sizing the epoch and the span
 *  budget, so the run still finishes in the past (see prng.mjs on why the whole run has
 *  to). Re-measure it if the curve or the steps change.
 */
export const MEAN_HOURS_PER_TICK = 3.7;

/**
 * How far the simulated clock is allowed to travel over a whole run.
 *
 * 15 % of headroom over the mean plus one day, because the mean is a mean: a lucky
 * seed drifts. The clock CLAMPS at this budget rather than running past it, which is
 * a safety net and not a modelling decision — if it ever bites, the tail of the run
 * happens at a standstill, which is odd but harmless, whereas crossing the real
 * present would make every now()-relative production rule answer differently.
 */
export function rhythmBudgetMinutes(ticks) {
  return Math.ceil(ticks * MEAN_HOURS_PER_TICK * 60 * 1.15) + 1440;
}

/**
 * The epoch for a rhythm run: far enough back that epoch + budget + the 40-hour
 * booking lead time still lands before the real present.
 */
export function rhythmEpoch(ticks, today = new Date()) {
  const days = Math.max(5, Math.ceil(rhythmBudgetMinutes(ticks) / 1440) + 3);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(midnight - days * 24 * 60 * 60 * 1000);
}

/** How many stepping rounds one advance may take before it gives up and accepts. 40
 *  rounds of up to two hours is more than three days — far more than enough to cross
 *  00–05 even on a seed that keeps rejecting, and bounded so a tick can never loop. */
const MAX_STEPS = 40;

export class RhythmClock extends SimClock {
  /**
   * @param {Date} epoch
   * @param {import("./prng.mjs").Prng} rng
   * @param {{budgetMinutes?: number}} options
   */
  constructor(epoch, rng, { budgetMinutes = Infinity } = {}) {
    super(epoch, rng);
    this.budgetMinutes = budgetMinutes;
    this.rhythm = true;
    this.steps = 0;
  }

  advance() {
    // The base step is what a tick costs when the hour is already busy; the loop below
    // is what it costs to get OUT of a quiet one. Two members logging inside the same
    // afternoon peak is the clustering the whole feature is about, and it survives a
    // base step of this size because the accept probability at 16:00 is 0,95 and at
    // 03:00 is 0,01 — the rejection does the shaping, not the step length.
    let minutes = this.rng.int(20, 150);
    let steps = 0;
    for (; steps < MAX_STEPS; steps += 1) {
      const candidate = new Date(this.epoch.getTime() + (this.minutes + minutes) * 60000);
      if (this.rng.float() < intensityAt(candidate)) break;
      minutes += this.rng.int(30, 120);
    }
    this.steps = steps;
    this.minutes = Math.min(this.minutes + minutes, this.budgetMinutes);
    return this.now();
  }

  /** The rhythm context at the current simulated instant. */
  context(extra = {}) {
    return rhythmContextAt(this.now(), extra);
  }
}

// ── The weight rules ─────────────────────────────────────────────────────────
//
// Read top to bottom: every rule whose `when` holds multiplies the named actions'
// weights. Multipliers compose, so a Saturday evening at the end of the month applies
// three rules. An action nobody names keeps its persona weight, and a UNIFORM
// multiplier would do nothing at all — `weighted()` normalises — so "quiet hours" are
// modelled by the clock skipping them, never by scaling every weight down here.

export const WEIGHT_RULES = [
  {
    id: "commute",
    why: "At 07 and 16 on a weekday the car is being DRIVEN, not administered: trips and the handovers and completions around them crowd out settings, closes and catch-up logging.",
    when: (c) => c.commutePeak,
    mult: {
      log_trip: 2.4,
      complete_booking: 1.5,
      save_handover: 1.4,
      log_trip_with_crossing: 1.4,
      create_booking: 0.6,
      log_trip_backdated: 0.5,
      log_fuel_backdated: 0.5,
      close_period: 0.3,
      update_settings: 0.3,
      rename_member: 0.4,
    },
  },
  {
    id: "evening",
    why: "The planning hour. Bookings for tomorrow get made on the sofa, and so does most of the editing of what went in badly during the day.",
    when: (c) => c.evening,
    mult: {
      create_booking: 2.2,
      create_overlapping_booking: 1.6,
      edit_booking_window: 1.4,
      edit_trip: 1.3,
      edit_fuel: 1.3,
      post_message: 1.6,
      log_trip: 0.8,
    },
  },
  {
    id: "end_of_day",
    why: "A fill is logged when the day is over and the receipt is in a pocket, not at the pump at 07:15.",
    when: (c) => c.endOfDay,
    mult: { log_fuel: 1.7, log_fuel_backdated: 1.3 },
  },
  {
    id: "night",
    why: "The rare 02:00 action is almost always somebody entering yesterday from bed, or writing in the chat. It is not a trip.",
    when: (c) => c.night,
    mult: {
      log_trip_backdated: 2.5,
      log_fuel_backdated: 2.2,
      post_message: 2.0,
      log_trip: 0.3,
      complete_booking: 0.3,
      save_handover: 0.3,
    },
  },
  {
    id: "weekend",
    why: "Leisure driving, and the catch-up session: the entries nobody made on Wednesday get made on Sunday, which is exactly how an entry lands in a period that has moved on.",
    when: (c) => c.isWeekend,
    mult: {
      log_trip_backdated: 2.2,
      log_fuel_backdated: 2.0,
      edit_trip_in_closed_period: 1.6,
      log_trip: 1.2,
      log_trip_with_crossing: 1.5,
      close_period: 0.5,
      update_settings: 0.6,
    },
  },
  {
    id: "month_edge",
    why: "Settling up is a calendar habit. The last three and first three days of the month are when the admin requests, chases and closes.",
    when: (c) => c.monthEdge,
    mult: {
      request_settlement: 3.0,
      close_period: 3.5,
      mark_settlement_paid: 2.2,
      confirm_settlement: 2.2,
    },
  },
  {
    id: "mid_month",
    why: "The mirror image of the rule above, and the half that makes it mean something: without damping the middle of the month, a boosted month edge is just a louder constant.",
    when: (c) => !c.monthEdge,
    mult: { close_period: 0.35, request_settlement: 0.6 },
  },
  {
    id: "thirsty",
    why: "Kilometres since the last fill are the real trigger for logging one. 250 km on a shared car is about a week, which is when somebody stops at a station.",
    when: (c) => c.kmSinceFuel >= 250,
    mult: { log_fuel: 2.2, log_fuel_backdated: 1.6 },
  },
];

/**
 * Apply the rules to a persona's weight entries.
 *
 * @param {[string, number][]} entries  [[action, weight], …]
 * @param {object} context              rhythmContextAt(...)
 * @returns {[string, number][]}        a NEW array; the persona's own map is never touched
 */
export function modulateWeights(entries, context) {
  const factors = new Map();
  for (const rule of WEIGHT_RULES) {
    if (!rule.when(context)) continue;
    for (const [action, multiplier] of Object.entries(rule.mult)) {
      factors.set(action, (factors.get(action) ?? 1) * multiplier);
    }
  }
  if (factors.size === 0) return entries;
  return entries.map(([action, weight]) => {
    const factor = factors.get(action);
    if (factor === undefined) return [action, weight];
    // Never round a modulated weight to zero: a rule is a bias, not a ban, and an
    // action that can never be drawn at 03:00 is an action whose 03:00 bugs are
    // unreachable. `weighted()` drops entries at exactly 0.
    return [action, Math.max(weight * factor, 0.05)];
  });
}

/** Which rules fired, for the journal. A model nobody can see is a model nobody trusts. */
export function firedRules(context) {
  return WEIGHT_RULES.filter((rule) => rule.when(context)).map((rule) => rule.id);
}

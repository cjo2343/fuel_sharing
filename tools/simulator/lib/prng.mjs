// Deterministic randomness and the simulated clock (GV-471).
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: nothing in the simulator's decision path
// may read the wall clock or Math.random(). A seed plus the run's configuration must
// reproduce the same sequence of actions, against the same actors, with the same
// domain timestamps — otherwise a violation the fuzzer finds cannot be handed back as
// a one-line repro, which is the only thing that makes an unscripted fuzzer worth
// running at all.
//
// Wall-clock time is allowed in exactly two places, both OUTSIDE the decision path and
// both labelled where they are used: measuring how long an RPC took (journal `ms`) and
// stamping journal lines for the live dashboard. Neither is fed back into a decision,
// and both are excluded from the determinism digest.

/** mulberry32 — 32-bit, seedable, no dependencies, good enough for fuzz weighting. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string → 32-bit seed, so named streams (per workspace) can be derived. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Prng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Derive an independent stream, deterministically, from a label. */
  fork(label) {
    return new Prng((this.seed ^ hashSeed(label)) >>> 0);
  }

  float() {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(list) {
    if (!list || list.length === 0) return null;
    return list[Math.floor(this.next() * list.length)];
  }

  /** A distinct subset of `list`, size in [min, max]. Order follows `list`. */
  subset(list, min, max) {
    const want = Math.min(list.length, this.int(min, Math.min(max, list.length)));
    const pool = [...list];
    const out = [];
    for (let i = 0; i < want; i += 1) out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    return list.filter((item) => out.includes(item));
  }

  /** Weighted pick over [[value, weight], …]. Zero-weight entries never win. */
  weighted(entries) {
    const usable = entries.filter(([, w]) => w > 0);
    if (usable.length === 0) return null;
    const total = usable.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of usable) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return usable[usable.length - 1][0];
  }

  /** A number with 2 decimals in [min, max] — money and litres. */
  money(min, max) {
    return Math.round((min + this.next() * (max - min)) * 100) / 100;
  }
}

// ── The simulated clock ──────────────────────────────────────────────────────
//
// Every domain timestamp the simulator writes (trip_date, booking windows, expense
// dates, recurring due dates) comes from here, so a replay writes the same dates.
//
// The epoch is anchored in the PAST relative to the real clock, and that is a
// deliberate trade, documented in the README:
//
//   Several production rules read now() — a handover may not be written before its
//   booking has STARTED (migration 189), a recurring template's next due date must
//   fall within [today-90d, today+5y], a repair date may not be more than a year
//   ahead. If the simulated clock straddled the real one, those rules would answer
//   differently depending on the hour the run happened, and the run would stop being
//   reproducible. Anchoring the whole run in the past makes every now()-relative rule
//   answer the same way on every replay.
//
//   The cost: guards keyed to "is this booking active RIGHT NOW" can never fire, so
//   the wall-clock half of the booking-log policy is out of this tool's reach. That
//   is a known blind spot, not an oversight.
export class SimClock {
  /**
   * @param {Date} epoch      first tick's instant (UTC)
   * @param {Prng} rng        stream used to draw each tick's advance
   * @param {number} minHours minimum simulated hours per tick
   * @param {number} maxHours maximum simulated hours per tick
   */
  constructor(epoch, rng, { minHours = 1, maxHours = 6 } = {}) {
    this.epoch = epoch;
    this.rng = rng;
    this.minHours = minHours;
    this.maxHours = maxHours;
    this.minutes = 0;
  }

  /** Advance one tick and return the new instant. */
  advance() {
    this.minutes += this.rng.int(this.minHours * 60, this.maxHours * 60);
    return this.now();
  }

  now() {
    return new Date(this.epoch.getTime() + this.minutes * 60000);
  }

  /** Offset in minutes since the epoch — the epoch-independent half of the clock. */
  offsetMinutes() {
    return this.minutes;
  }

  /** An instant `minutes` from the current simulated moment (may be negative). */
  at(minutes) {
    return new Date(this.now().getTime() + minutes * 60000);
  }

  /** ISO instant for SQL (timestamptz), relative to the current simulated moment. */
  iso(minutes = 0) {
    return this.at(minutes).toISOString();
  }

  /** Calendar date (UTC) for SQL, relative to the current simulated moment. */
  date(minutes = 0) {
    return this.at(minutes).toISOString().slice(0, 10);
  }

  /** ISO instant at an ABSOLUTE offset from the epoch — booking windows use these,
   *  so an edit ticks later addresses the same window rather than a shifted one. */
  isoAt(absoluteMinutes) {
    return new Date(this.epoch.getTime() + absoluteMinutes * 60000).toISOString();
  }

  /** Calendar date at an ABSOLUTE offset from the epoch. */
  dateAt(absoluteMinutes) {
    return this.isoAt(absoluteMinutes).slice(0, 10);
  }

  /** The epoch as an ISO instant — the deliberately stale precondition token. */
  get epochIso() {
    return this.epoch.toISOString();
  }
}

/**
 * Default epoch: UTC midnight, far enough in the past that the whole run finishes
 * before the real present. `ticks` × the mean advance is the run's simulated span.
 */
export function defaultEpoch(ticks, meanHoursPerTick = 3.5, today = new Date()) {
  // +3 days of margin so the LAST tick's bookings (lead time capped at 40 h in
  // lib/actions.mjs) still start before the real present.
  const days = Math.max(5, Math.ceil((ticks * meanHoursPerTick) / 24) + 3);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(midnight - days * 24 * 60 * 60 * 1000);
}

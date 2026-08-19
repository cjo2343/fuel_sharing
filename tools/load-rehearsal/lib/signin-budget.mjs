// GV-494 — the sign-in budget for the load-rehearsal seeder.
//
// Supabase Auth allows ~30 password grants per 5 minutes per IP, and that limit
// CANNOT be raised from the dashboard: exercise 1 set it to 300, saved it (the
// helper text updated) and restarted the project, and the observed limit stayed at
// ~30/5 min (finding T4 — an operational fact, not a bug of ours).
//
// The seeder used to fire sign-ins as fast as `--concurrency` allowed, burn the
// whole window inside the first two workspaces, and then 429 its way through the
// remaining eighteen (finding T1). This module makes it spend the budget instead of
// discovering it: every sign-in takes a slot from a sliding window of `budget`
// grants per `windowMs`, and when the window is full the seeder PAUSES — with a
// visible countdown — rather than issuing a call that is going to be refused.
//
// Pure and clock-injectable on purpose (`now` / `sleep`), so the timing math is
// unit-tested without a network and without waiting five real minutes.
//
// Dependency-free (node built-ins only), like the rest of the toolkit. Nothing here
// imports lib/common.mjs — common.mjs imports parseRetryAfterMs from HERE, and one
// direction is easier to reason about than two.

export const DEFAULT_SIGNIN_BUDGET = 30; // grants per window (the observed Auth limit)
export const DEFAULT_SIGNIN_WINDOW_S = 300; // 5 minutes
const DEFAULT_TICK_MS = 15_000; // how often the countdown line refreshes

// ── Retry-After ──────────────────────────────────────────────────────────────
// RFC 9110 allows either delta-seconds or an HTTP-date. Returns milliseconds, or
// null when the header is absent/unparseable (the caller then falls back to a full
// window, which is the honest assumption for a per-IP limiter that does not say).
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = String(headerValue).trim();
  if (raw === "") return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

// ── Estimation ───────────────────────────────────────────────────────────────
// How long `count` sign-ins take under a `budget`-per-`windowMs` sliding window:
// the first `budget` go immediately, each further batch waits a full window. So the
// last one happens at floor((count-1)/budget) windows. Printing this up front is
// the point — an operator who is told "≈ 19 min" waits; one who is told nothing
// kills the run at minute six and reports a plateau.
export function estimateSignInMs({ count, budget = DEFAULT_SIGNIN_BUDGET, windowMs = DEFAULT_SIGNIN_WINDOW_S * 1000 }) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!(budget > 0)) return 0;
  return Math.floor((count - 1) / budget) * windowMs;
}

export function signInWindows({ count, budget = DEFAULT_SIGNIN_BUDGET }) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.ceil(count / budget);
}

export function formatDuration(ms) {
  // Round UP, so a countdown that still has 400 ms to go never prints "0s".
  const total = ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60} min`;
}

// "~110 sign-ins at 30/300 s ≈ 15 min (4 windows)"
export function formatSignInEstimate({ count, budget = DEFAULT_SIGNIN_BUDGET, windowMs = DEFAULT_SIGNIN_WINDOW_S * 1000 }) {
  const ms = estimateSignInMs({ count, budget, windowMs });
  const windows = signInWindows({ count, budget });
  return `~${count} sign-ins at ${budget}/${Math.round(windowMs / 1000)} s ≈ ${formatDuration(ms)} (${windows} window${windows === 1 ? "" : "s"})`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── The budget itself ────────────────────────────────────────────────────────
// A sliding-window log: one timestamp per grant, `budget` of them per `windowMs`.
// (A leaky bucket would smear the same rate out evenly; the log matches how the
// platform actually counts, so the first `budget` sign-ins still go at full speed.)
export class SignInBudget {
  constructor({
    budget = DEFAULT_SIGNIN_BUDGET,
    windowMs = DEFAULT_SIGNIN_WINDOW_S * 1000,
    now = () => Date.now(),
    sleep = defaultSleep,
    onWait = null,
    tickMs = DEFAULT_TICK_MS,
  } = {}) {
    if (!Number.isFinite(budget) || budget <= 0) throw new Error("sign-in budget must be a positive number");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("sign-in window must be a positive number of ms");
    this.budget = budget;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep;
    this.onWait = onWait;
    this.tickMs = tickMs;
    this.stamps = []; // ascending grant timestamps inside the current window
    this.blockedUntil = 0; // set by a real 429 (Retry-After, else a full window)
    this.spent = 0;
    this.waitedMs = 0;
    this.rateLimited = 0;
  }

  // Drop timestamps that have aged out of the window.
  prune(t = this.now()) {
    const cutoff = t - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0] <= cutoff) this.stamps.shift();
    return this.stamps.length;
  }

  // How long a grant asked for at `t` must wait. Pure given the current state —
  // this is the piece the tests pin with a fake clock.
  waitMsAt(t = this.now()) {
    const cutoff = t - this.windowMs;
    const live = this.stamps.filter((s) => s > cutoff);
    let wait = 0;
    if (live.length >= this.budget) {
      // The grant that has to expire before a slot frees up.
      const oldestBlocking = live[live.length - this.budget];
      wait = oldestBlocking + this.windowMs - t;
    }
    return Math.max(0, wait, this.blockedUntil - t);
  }

  remaining(t = this.now()) {
    const cutoff = t - this.windowMs;
    return Math.max(0, this.budget - this.stamps.filter((s) => s > cutoff).length);
  }

  // Take a slot, pausing (with a countdown) until one exists.
  async acquire(label = null) {
    for (;;) {
      const t = this.now();
      this.prune(t);
      const wait = this.waitMsAt(t);
      if (wait <= 0) break;
      const step = Math.min(wait, this.tickMs);
      if (this.onWait) this.onWait({ remainingMs: wait, spent: this.spent, label });
      this.waitedMs += step;
      await this.sleep(step);
    }
    const t = this.now();
    this.stamps.push(t);
    this.spent++;
    return t;
  }

  // A real 429 came back: hold every sign-in until Retry-After (or, when the
  // platform did not say, a full window — the limiter's own period). Returns the
  // pause in ms so the caller can print it.
  noteRateLimited({ retryAfterMs = null } = {}) {
    const t = this.now();
    const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : this.windowMs;
    this.rateLimited++;
    this.blockedUntil = Math.max(this.blockedUntil, t + waitMs);
    return this.blockedUntil - t;
  }

  summary() {
    return {
      spent: this.spent,
      waitedMs: this.waitedMs,
      rateLimited: this.rateLimited,
      budget: this.budget,
      windowMs: this.windowMs,
    };
  }
}

// ── Session reuse ────────────────────────────────────────────────────────────
// One sign-in per member per pass, never two. The fixture gives every member
// exactly one workspace, so this is a belt-and-braces guarantee rather than a
// saving today — but a member who appears twice would otherwise silently cost two
// slots out of thirty. Concurrent callers share the in-flight promise, so the pool
// cannot mint the same token twice in parallel.
export class SessionCache {
  constructor() {
    this.pending = new Map(); // email -> Promise<token>
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.pending.size;
  }

  async get(key, mint) {
    if (this.pending.has(key)) {
      this.hits++;
      return this.pending.get(key);
    }
    this.misses++;
    const promise = (async () => mint())();
    this.pending.set(key, promise);
    try {
      return await promise;
    } catch (err) {
      // A failed sign-in must not be cached as a session — the next attempt
      // should be allowed to try again.
      this.pending.delete(key);
      throw err;
    }
  }
}

// Shared, dependency-free helpers for the GV-317 load-rehearsal toolkit.
//
// Pure Node only: node:* built-ins plus the global `fetch`. NO npm packages —
// the platform repo has no runtime dependencies and this toolkit keeps it that
// way. Everything here is used by schema-apply.mjs, seed.mjs and load.mjs, and
// the pure functions are unit-tested by ../test-load-rehearsal.mjs.

import { readFileSync } from "node:fs";
import { parseRetryAfterMs } from "./signin-budget.mjs";

// ── Production guard (hard rule) ─────────────────────────────────────────────
// The one production Supabase project ref (mirrors govehlo-mobile's
// src/lib/supabase.ts SUPABASE_URL). The rehearsal targets a DEDICATED THROWAWAY
// project and must NEVER point at production; every entrypoint runs assertNotProd
// before it does anything.
export const PROD_PROJECT_REF = "kdudfqzglhydmzntqosb";

// ── Env file parsing ─────────────────────────────────────────────────────────
// The scripts read a local KEY=VALUE env file passed as `--env <file>`, kept
// OUTSIDE the repo (chmod 600). Never read secrets from the repo or process env.

// Parse KEY=VALUE lines. Ignores blank lines and #-comments, tolerates a leading
// `export`, and strips one layer of matching single/double quotes from values.
export function parseEnvFile(text) {
  const env = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// Refuse to run against the production project. Checks every value that could
// carry the project ref — the REST URL and the pooler connection string.
export function assertNotProd(env) {
  const haystack = [env.SUPABASE_URL, env.DBURL, env.SUPABASE_ANON_KEY, env.SUPABASE_SERVICE_ROLE_KEY]
    .filter(Boolean)
    .join(" ");
  if (haystack.includes(PROD_PROJECT_REF)) {
    throw new Error(
      `Refusing to run: the env references the PRODUCTION project ref (${PROD_PROJECT_REF}). ` +
        `The load rehearsal must only ever target a dedicated throwaway Supabase project.`,
    );
  }
}

// Read + parse an env file and assert every required key is present, then run the
// production guard. Throws a human-readable Error on any problem.
export function loadEnv(filePath, requiredKeys = []) {
  if (!filePath) throw new Error("Missing --env <file> (a local KEY=VALUE file kept OUTSIDE the repo, chmod 600).");
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Could not read env file ${filePath}: ${err.message}`);
  }
  const env = parseEnvFile(text);
  const missing = requiredKeys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Env file ${filePath} is missing required key(s): ${missing.join(", ")}`);
  }
  assertNotProd(env);
  return env;
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────
// Minimal, dependency-free. Supports `--flag`, `--key value` and `--key=value`.
export function parseArgs(argv, { flags = [] } = {}) {
  const out = { _: [] };
  const flagSet = new Set(flags);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        if (flagSet.has(key)) {
          out[key] = true;
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            out[key] = next;
            i++;
          } else {
            out[key] = true;
          }
        }
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
// Small, fast, seedable — makes fixture generation reproducible via `--seed N`.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A bundle of deterministic helpers off a single PRNG stream.
export function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    rand,
    // Inclusive integer in [lo, hi].
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    // A distinct sample of `count` items from arr (count clamped to arr.length).
    sample: (arr, count) => {
      const copy = [...arr];
      const n = Math.min(count, copy.length);
      const picked = [];
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(rand() * copy.length);
        picked.push(copy.splice(idx, 1)[0]);
      }
      return picked;
    },
  };
}

// ── Percentiles ──────────────────────────────────────────────────────────────
// Nearest-rank percentile over a numeric array (unsorted OK). Returns 0 for [].
export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * xs.length);
  const idx = Math.min(xs.length - 1, Math.max(0, rank - 1));
  return xs[idx];
}

// ── Deterministic rehearsal identities ───────────────────────────────────────
// Both seed.mjs (creates users) and load.mjs (signs them in) derive the same
// email/password from the user index (+ seed for the password), so a fixture is
// reproducible and the load driver needs no handoff file. Emails use a synthetic
// throwaway domain — no real personal data (GDPR).
export const DEFAULT_EMAIL_DOMAIN = "rehearsal.vehloshare.test";

export function userEmail(index, domain = DEFAULT_EMAIL_DOMAIN) {
  return `load-u${String(index).padStart(3, "0")}@${domain}`;
}

export function userPassword(index, seed) {
  // Meets typical complexity (upper/lower/digit/symbol); deterministic per (seed,index).
  return `Rh!${seed}x${String(index).padStart(3, "0")}Vehlo`;
}

// ── HTTP with backoff ────────────────────────────────────────────────────────
// A single JSON-aware fetch wrapper that retries on 429 and 5xx with exponential
// backoff + jitter (honouring Retry-After), so seeding/load stay under free-tier
// rate limits. Returns a normalised result — it never throws on HTTP status,
// only on network/timeout after exhausting retries.
export async function httpJson(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    retries = 5,
    backoffMs = 500,
    timeoutMs = 30000,
  } = opts;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(backoffWithJitter(backoffMs, attempt));
        attempt++;
        continue;
      }
      throw new Error(`${method} ${redactUrl(url)} failed after ${attempt + 1} attempt(s): ${err.message}`);
    }
    clearTimeout(timer);

    // Retry-After may be delta-seconds OR an HTTP-date (RFC 9110); parseRetryAfterMs
    // handles both and returns null when the platform did not say.
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : backoffWithJitter(backoffMs, attempt);
      await sleep(wait);
      attempt++;
      continue;
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    // `retryAfterMs` is surfaced so a caller that owns its own rate budget (the
    // seeder's SignInBudget, GV-494) can honour the platform's own number rather
    // than guess; it is null when the response carried no usable header.
    return { status: res.status, ok: res.ok, json, text, retryAfterMs };
  }
}

export function backoffWithJitter(baseMs, attempt) {
  const capped = Math.min(baseMs * 2 ** attempt, 15000);
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep secrets out of any surfaced URL (the anon/service key would otherwise ride
// in a query string in an error message). GDPR + hygiene.
function redactUrl(url) {
  return String(url).replace(/(apikey|access_token)=[^&]+/gi, "$1=REDACTED");
}

// ── Supabase REST/Auth clients ───────────────────────────────────────────────
// Thin wrappers over the Supabase Auth admin API, GoTrue password grant, and
// PostgREST — exactly the surfaces the mobile app hits. No @supabase/supabase-js.

export function makeSupabase(env) {
  const base = String(env.SUPABASE_URL).replace(/\/$/, "");
  return { base, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

function authedHeaders(supa, accessToken) {
  return {
    apikey: supa.anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Create an auth user via the admin API (service role). email_confirm skips the
// confirmation email — no mail is sent, so synthetic domains are fine.
export async function createAuthUser(supa, { email, password }, httpOpts = {}) {
  return httpJson(`${supa.base}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: supa.serviceKey,
      Authorization: `Bearer ${supa.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
    ...httpOpts,
  });
}

// GoTrue password grant — mirrors the mobile app's sign-in.
export async function signInWithPassword(supa, { email, password }, httpOpts = {}) {
  return httpJson(`${supa.base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: supa.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    ...httpOpts,
  });
}

// Call a PostgREST RPC as an authenticated member (Bearer JWT), exactly like the
// mobile helpers do (supabase.rpc under the hood posts to /rest/v1/rpc/<fn>).
export async function rpcCall(supa, accessToken, fn, args = {}, httpOpts = {}) {
  return httpJson(`${supa.base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: authedHeaders(supa, accessToken),
    body: JSON.stringify(args),
    ...httpOpts,
  });
}

// GET a table via PostgREST with a raw query string (built by lib/hotpaths.mjs so
// it byte-mirrors the mobile data gateway).
export async function restGet(supa, accessToken, table, query, httpOpts = {}) {
  return httpJson(`${supa.base}/rest/v1/${table}?${query}`, {
    method: "GET",
    headers: authedHeaders(supa, accessToken),
    ...httpOpts,
  });
}

// ── Bounded concurrency ──────────────────────────────────────────────────────
// Run `worker(item, i)` over items with at most `limit` in flight. Keeps seeding
// gentle on free-tier rate limits.
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function drain() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) {
    runners.push(drain());
  }
  await Promise.all(runners);
  return results;
}

// ── Latency + error metrics ──────────────────────────────────────────────────
export class Metrics {
  constructor() {
    this.latencies = new Map(); // label -> number[] (ms)
    this.statusCounts = new Map(); // "label <status>" -> count
    this.errorSamples = []; // { label, status, detail }
  }

  record(label, ms, status) {
    if (!this.latencies.has(label)) this.latencies.set(label, []);
    this.latencies.get(label).push(ms);
    const key = `${label} ${status}`;
    this.statusCounts.set(key, (this.statusCounts.get(key) || 0) + 1);
  }

  recordError(label, status, detail) {
    this.errorSamples.push({ label, status, detail });
  }

  perEndpoint() {
    const rows = [];
    for (const [label, xs] of [...this.latencies.entries()].sort()) {
      rows.push({
        label,
        count: xs.length,
        p50: Math.round(percentile(xs, 50)),
        p95: Math.round(percentile(xs, 95)),
        p99: Math.round(percentile(xs, 99)),
        max: Math.round(Math.max(...xs)),
      });
    }
    return rows;
  }

  errorsByStatus() {
    const out = new Map(); // status -> count
    for (const [key, n] of this.statusCounts.entries()) {
      const status = Number(key.slice(key.lastIndexOf(" ") + 1));
      if (status >= 400 || status === 0) {
        out.set(status, (out.get(status) || 0) + n);
      }
    }
    return out;
  }

  totalRequests() {
    let total = 0;
    for (const xs of this.latencies.values()) total += xs.length;
    return total;
  }
}

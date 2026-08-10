// Cross-repo guard: tools/load-rehearsal/lib/hotpaths.mjs really does mirror
// govehlo-mobile's ledger-data-gateway.ts (GV-393).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — the guard it replaces asserted nothing
// ---------------------------------------------------------------------------
// test-load-rehearsal.mjs said it covered "that lib/hotpaths.mjs still mirrors the
// mobile data gateway". It contained zero references to govehlo-mobile. What it
// actually did was compare hotpaths.mjs against its OWN hardcoded copies of the same
// values — `assert.deepEqual(EVENT_TYPE_EXCLUDE, [ ...the very same strings... ])`.
// That is a tautology: the mirror and the expectation drift together, so the check
// stays green precisely when the mirror is wrong.
//
// (No count is named there on purpose. It used to read "the same three strings" and
// was silently wrong from the moment the list grew — first to four with the weekly
// digest, then to five with the booking fuel-stop reminder. A comment that counts a
// list it does not own goes stale without anything failing.)
//
// It was wrong. GV-393 found two live drifts it had not noticed:
//   • SETTLEMENT_REQUEST_COLUMNS had 12 columns; the gateway had grown to 17
//     (created_at, paid_claimed_at, last_reminder_at, reminder_count,
//     last_confirm_reminder_at). The rehearsal under-measured the settlements
//     payload on every single VU iteration.
//   • read:bookings carried `&deleted_at=is.null`, which the gateway DELIBERATELY
//     omits (GVM-388 — cancelled bookings are soft-deletes and the Historik
//     Bookinger tab lists them). The rehearsal under-measured the bookings row count.
//
// A load rehearsal that under-measures the payload is worse than none: it certifies
// headroom the real client does not have.
//
// So this reads the ACTUAL gateway source in the sibling repo. It can only run where
// that repo exists, which is why it follows the same tolerate-missing convention as
// check-token-drift.mjs (GV-256) and test-rls-role-matrix.mjs (GV-379): a missing
// sibling is a ::warning:: and exit 0 locally / in fuel_sharing's own CI, and
// --strict turns it into a hard failure for .github/workflows/umbrella.yml, the one
// workflow that checks out all three repos side by side.
//
//   node tools/check-hotpath-mirror.mjs            # warn when mobile is absent
//   node tools/check-hotpath-mirror.mjs --strict   # umbrella: absent = failure
//
// GV-484 widened it again. Until this ticket the comparison covered projections, the
// event-type exclusion and the soft-delete filters — and NOTHING about `.order()` or
// `.limit()`. GVM-572 gave five more reads a `cap + 1` sentinel and a deliberate
// ordering; the mirror was updated by hand and the checker stayed green either way,
// which is the same blind spot in a new place: a rehearsal reading 501 rows where the
// client reads 1.001, or reading them in a different order, measures a query the app
// never sends. Ordering and limit are now first-class parts of the comparison, with
// the gateway's cap identifiers resolved from src/lib/settlement-data-guard.ts and
// src/lib/feed-pagination.ts so `SETTLE_ROW_CAP + 1` is compared as the number 501.
//
// Parsing note: this scrapes TypeScript with regexes rather than parsing it, because
// the repo is deliberately dependency-free. Every extractor below therefore FAILS
// LOUDLY when its pattern does not match, instead of returning null and silently
// certifying nothing — a scraper that shrugs is how the last guard died. Its own
// behaviour is unit-tested in tools/test-hotpath-mirror-scan.mjs, including that a
// gateway it cannot parse is an error rather than a pass.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = join(ROOT, "..", "govehlo-mobile");
const GATEWAY = join(MOBILE, "src", "store", "ledger-data-gateway.ts");
// Where the gateway's `.limit(...)` identifiers are defined. Both are read so a cap
// expressed as `SETTLE_ROW_CAP + 1` can be compared as a number against the mirror's
// `limit=501`, rather than as a string nobody can diff.
const LIMIT_CONSTANT_SOURCES = [
  join(MOBILE, "src", "lib", "settlement-data-guard.ts"),
  join(MOBILE, "src", "lib", "feed-pagination.ts"),
];

export class MirrorScanError extends Error {}

// ── Extractors (exported for tools/test-hotpath-mirror-scan.mjs) ─────────────

// `export const SETTLEMENT_REQUEST_COLUMNS =\n  'id,ledger_id,…';`
export function extractProjection(source, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = source.match(re);
  if (!m) throw new MirrorScanError(`could not find projection ${name} in the gateway`);
  return m[1].trim();
}

// The `.not('event_type', 'in', '(a,b,c)')` filter on the events read.
export function extractEventExclusions(source) {
  const m = source.match(/\.not\(\s*['"]event_type['"]\s*,\s*['"]in['"]\s*,\s*['"]\(([^)]*)\)['"]\s*\)/);
  if (!m) throw new MirrorScanError("could not find the event_type not-in filter in the gateway");
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

// Pull the chained call block for `.from('<table>')` up to the end of that timed()
// entry, so we can ask what filters the real read applies.
export function extractRead(source, table) {
  const start = source.indexOf(`.from('${table}')`);
  if (start === -1) throw new MirrorScanError(`could not find .from('${table}') in the gateway`);
  // A read block ends at the closing of its timed(...) wrapper; the next `timed(`
  // or the end of the Promise.all array is a safe bound.
  const next = source.indexOf("timed(", start);
  return source.slice(start, next === -1 ? Math.min(start + 600, source.length) : next);
}

export function readAppliesSoftDeleteFilter(source, table) {
  return /\.is\(\s*['"]deleted_at['"]\s*,\s*null\s*\)/.test(extractRead(source, table));
}

// ── Ordering and limit (GV-484) ─────────────────────────────────────────────
//
// `extractRead` above bounds a read at the next `timed(` — fine for asking "does this
// chain contain .is('deleted_at', null)", too loose for "what is the LAST .order() on
// this chain", because the final entry of the fan-out would run on into the function
// below it. So the order/limit extraction works off a tighter slice: the fan-out block
// itself, cut at each `client.from('…')`, which is exactly one read per slice.

/**
 * The single `fanOut` builder the gateway load AND the targeted refresh share. Cut at
 * `const load = async (`, the next declaration after it. When the marker is absent
 * (an older shape, or the miniature fixture the unit test uses) the whole source is
 * the section — a wider slice, never a skipped check.
 */
export function extractFanoutSection(source) {
  const start = source.indexOf("const fanOut = async (");
  if (start === -1) return source;
  const end = source.indexOf("const load = async (", start);
  return source.slice(start, end === -1 ? source.length : end);
}

/** One read's builder chain: `.from('<table>')` up to the next `.from('` or the end. */
export function extractReadChain(source, table) {
  const section = extractFanoutSection(source);
  const start = section.indexOf(`.from('${table}')`);
  if (start === -1) throw new MirrorScanError(`could not find .from('${table}') in the gateway fan-out`);
  const next = section.indexOf(".from('", start + 7);
  return section.slice(start, next === -1 ? section.length : next);
}

/** `export const NAME = 500;` → Map { NAME → 500 }. Used to resolve `.limit()` idents. */
export function extractNumericConstants(source) {
  const out = new Map();
  const re = /export const ([A-Za-z_$][\w$]*)\s*(?::\s*number)?\s*=\s*(-?\d+)\s*;/g;
  let m;
  while ((m = re.exec(source)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

/**
 * The ordering a read asks for, as PostgREST would spell it: `['trip_date.desc',
 * 'id.desc']`. `.order('name')` with no options is ascending, which is what
 * supabase-js defaults to and what `order=name.asc` means on the mirror side.
 */
export function extractOrdering(source, table) {
  const chain = extractReadChain(source, table);
  const re = /\.order\(\s*['"]([\w]+)['"]\s*(?:,\s*\{[^}]*?ascending\s*:\s*(true|false)[^}]*\}\s*)?\)/g;
  const columns = [];
  let m;
  while ((m = re.exec(chain)) !== null) {
    columns.push(`${m[1]}.${m[2] === "false" ? "desc" : "asc"}`);
  }
  return columns;
}

/**
 * The row limit a read asks for, as a NUMBER, or null when it asks for none.
 *
 * `.single()` counts as 1: it is how the gateway reads the ledger row, and the mirror
 * spells the same read `limit=1`. An identifier the constants map does not know is a
 * MirrorScanError — resolving it to NaN and comparing that against the mirror would
 * be the silent pass this whole file exists to prevent.
 */
export function extractLimit(source, table, constants = new Map()) {
  const chain = extractReadChain(source, table);
  const m = chain.match(/\.limit\(\s*([^)]+?)\s*\)/);
  if (!m) return /\.single\(\s*\)/.test(chain) ? 1 : null;
  let total = 0;
  for (const rawTerm of m[1].split("+")) {
    const term = rawTerm.trim();
    if (/^\d+$/.test(term)) {
      total += Number(term);
      continue;
    }
    if (!constants.has(term)) {
      throw new MirrorScanError(
        `the gateway limits ${table} with \`${m[1]}\`, and \`${term}\` is not defined in ` +
          `src/lib/settlement-data-guard.ts or src/lib/feed-pagination.ts — teach ` +
          `LIMIT_CONSTANT_SOURCES in tools/check-hotpath-mirror.mjs where it lives`,
      );
    }
    total += constants.get(term);
  }
  return total;
}

/**
 * True when the read carries a DYNAMIC row filter — either chained directly (`.or(…)`)
 * or through the gateway's `scoped(query, filter)` wrapper, which is how the GVM-559
 * settlement window is applied. The wrapper sits OUTSIDE the builder chain (it wraps
 * `client.from(...)`), so it is found by pairing each `scoped(` with the read that
 * follows it rather than by scanning the chain slice.
 */
export function readAppliesDynamicFilter(source, table) {
  const chain = extractReadChain(source, table);
  if (/\.or\(/.test(chain)) return true;
  const section = extractFanoutSection(source);
  const target = section.indexOf(`.from('${table}')`);
  const re = /scoped\(/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const wrapped = section.indexOf(".from('", m.index);
    if (wrapped === target) return true;
  }
  return false;
}

/** The mirror side: `select=…&order=a.desc,b.desc&limit=501` → { order, limit }. */
export function parseMirrorQuery(query) {
  const params = new URLSearchParams(query);
  const order = params.get("order");
  const limit = params.get("limit");
  return {
    order: order ? order.split(",").map((s) => s.trim()).filter(Boolean) : [],
    limit: limit == null ? null : Number(limit),
    hasOrFilter: params.has("or"),
  };
}

// ── The comparison ──────────────────────────────────────────────────────────

/**
 * Every read in the fan-out: the mirror's label, the table, and whether the GVM-559
 * dynamic window is EXPECTED on it.
 *
 * The exemption is the one documented in hotpaths.mjs's header: the real client scopes
 * trips and fuel with `or=(<date>.gte.<since>,period_id.in.(<live period ids>))`, a
 * filter derived from per-workspace state (live period start, tank baseline, the
 * twelve-month floor) that the harness would have to re-derive to replay. The
 * rehearsal deliberately reads UNBOUNDED there, which keeps it an upper bound on what
 * any client state can cost — so the mirror not carrying an `or=` on these two is the
 * intended state, and carrying one would be the drift.
 *
 * The exemption covers the WINDOW FILTER ONLY. Ordering and limit are compared on
 * these two reads exactly as on every other, which is what GVM-572's caps needed and
 * did not have.
 */
export const FANOUT_READS = [
  { label: "read:ledger", table: "ledgers", windowExempt: false },
  { label: "read:members", table: "ledger_members", windowExempt: false },
  { label: "read:periods", table: "settlement_periods", windowExempt: false },
  { label: "read:trips", table: "trips", windowExempt: true },
  { label: "read:fuel", table: "fuel_payments", windowExempt: true },
  { label: "read:settlements", table: "settlement_requests", windowExempt: false },
  { label: "read:bookings", table: "car_bookings", windowExempt: false },
  { label: "read:events", table: "ledger_events", windowExempt: false },
  { label: "read:repairs", table: "vehicle_repairs", windowExempt: false },
  { label: "read:messages", table: "messages", windowExempt: false },
  { label: "read:expenses", table: "workspace_expenses", windowExempt: false },
  { label: "read:recurring", table: "recurring_expenses", windowExempt: false },
];

/** How a limit reads in a message: `501` or `none` rather than a bare `null`. */
function showLimit(limit) {
  return limit == null ? "none" : String(limit);
}

function showOrder(order) {
  return order.length ? order.join(",") : "(no ordering)";
}

export function compareMirror(gatewaySource, hotpaths, limitConstants = new Map()) {
  const problems = [];

  for (const name of ["SETTLEMENT_REQUEST_COLUMNS", "SETTLEMENT_PERIOD_COLUMNS"]) {
    const theirs = extractProjection(gatewaySource, name);
    const ours = hotpaths[name];
    if (ours !== theirs) {
      const theirCols = theirs.split(",");
      const ourCols = String(ours || "").split(",");
      const missing = theirCols.filter((c) => !ourCols.includes(c));
      const extra = ourCols.filter((c) => c && !theirCols.includes(c));
      problems.push(
        `${name} drifted from the gateway.\n` +
          `      gateway  (${theirCols.length} cols): ${theirs}\n` +
          `      hotpaths (${ourCols.length} cols): ${ours}` +
          (missing.length ? `\n      MISSING from hotpaths: ${missing.join(", ")}` : "") +
          (extra.length ? `\n      EXTRA in hotpaths: ${extra.join(", ")}` : ""),
      );
    }
  }

  const theirExcl = extractEventExclusions(gatewaySource);
  const ourExcl = hotpaths.EVENT_TYPE_EXCLUDE || [];
  if (theirExcl.join(",") !== [...ourExcl].join(",")) {
    problems.push(
      `EVENT_TYPE_EXCLUDE drifted.\n      gateway:  ${theirExcl.join(",")}\n      hotpaths: ${[...ourExcl].join(",")}`,
    );
  }

  // Soft-delete filters, per table. car_bookings is the one that bit us: the
  // gateway deliberately omits it (GVM-388), so "hotpaths must not filter" is the
  // assertion, and it is derived from the gateway rather than hardcoded here.
  const reads = hotpaths.ledgerReadRequests("LID");
  const TABLES = [
    ["trips", "read:trips"],
    ["fuel_payments", "read:fuel"],
    ["car_bookings", "read:bookings"],
    ["vehicle_repairs", "read:repairs"],
  ];
  const missingLabels = new Set();
  for (const [table, label] of TABLES) {
    const gatewayFilters = readAppliesSoftDeleteFilter(gatewaySource, table);
    const entry = reads.find((r) => r.label === label);
    if (!entry) {
      problems.push(`hotpaths has no read labelled ${label}, but the gateway reads ${table}`);
      missingLabels.add(label);
      continue;
    }
    const oursFilters = entry.query.includes("deleted_at=is.null");
    if (gatewayFilters !== oursFilters) {
      problems.push(
        `${label} soft-delete filter drifted: the gateway ${gatewayFilters ? "APPLIES" : "does NOT apply"} ` +
          `.is('deleted_at', null) on ${table}, hotpaths ${oursFilters ? "APPLIES" : "does NOT apply"} it. ` +
          (gatewayFilters
            ? "Add &deleted_at=is.null to the hotpaths query."
            : "Remove &deleted_at=is.null from the hotpaths query — filtering rows the real client fetches makes the rehearsal under-measure."),
      );
    }
  }

  // ── Ordering, limits and the window exemption, per read (GV-484) ───────────
  //
  // A limit is not a detail of a load rehearsal, it IS the payload: the rehearsal
  // that certified headroom for GVM-572's caps replayed uncapped reads on five of
  // these tables. And an ordering is what makes a cap safe rather than merely
  // large — recurring is ascending ON PURPOSE — so replaying the same cap under a
  // different order measures a different tail falling off.
  for (const { label, table, windowExempt } of FANOUT_READS) {
    if (missingLabels.has(label)) continue;
    const entry = reads.find((r) => r.label === label);
    if (!entry) {
      problems.push(`hotpaths has no read labelled ${label}, but the gateway reads ${table}`);
      continue;
    }
    const mirror = parseMirrorQuery(entry.query);
    const theirOrder = extractOrdering(gatewaySource, table);
    const theirLimit = extractLimit(gatewaySource, table, limitConstants);

    if (theirOrder.join(",") !== mirror.order.join(",")) {
      problems.push(
        `${label} ORDERING drifted from the gateway.\n` +
          `      gateway:  ${showOrder(theirOrder)}\n` +
          `      hotpaths: ${showOrder(mirror.order)}\n` +
          `      The ordering is what decides which rows a cap drops (GVM-572), and Historik's\n` +
          `      keyset paging depends on the id tiebreak — replaying a different one measures a\n` +
          `      query the app never sends.`,
      );
    }

    if (theirLimit !== mirror.limit) {
      const direction =
        theirLimit != null && mirror.limit != null && mirror.limit < theirLimit
          ? "\n      hotpaths reads FEWER rows than the client: the rehearsal under-measures the payload."
          : theirLimit == null && mirror.limit != null
            ? "\n      The gateway asks for no limit at all; capping it here under-measures the payload."
            : "";
      problems.push(
        `${label} LIMIT drifted from the gateway.\n` +
          `      gateway:  ${showLimit(theirLimit)}\n` +
          `      hotpaths: ${showLimit(mirror.limit)}` +
          direction +
          `\n      Mirror the gateway's .limit() (cap + 1 sentinel) in the hotpaths query.`,
      );
    }

    // The GVM-559 window: expected on trips/fuel, expected NOWHERE else, and never
    // mirrored. A new dynamic filter on another read means the rehearsal now replays
    // a different row set than the client — decide it deliberately rather than let it
    // land unnoticed, which is the whole GV-393/GV-484 lesson.
    const theirDynamic = readAppliesDynamicFilter(gatewaySource, table);
    if (theirDynamic && !windowExempt) {
      problems.push(
        `${label}: the gateway now applies a DYNAMIC filter (.or(...) / scoped(...)) to ${table}, ` +
          `and hotpaths does not mirror it. Either mirror it, or add ${label} to FANOUT_READS with ` +
          `windowExempt: true and record WHY in tools/load-rehearsal/lib/hotpaths.mjs's header — ` +
          `the way the GVM-559 trips/fuel window is exempted.`,
      );
    }
    if (windowExempt && mirror.hasOrFilter) {
      problems.push(
        `${label}: hotpaths carries an \`or=\` filter, but the GVM-559 window is deliberately NOT ` +
          `mirrored — the rehearsal reads unbounded so it stays an upper bound on what any client ` +
          `state can cost. Remove it, or change the documented decision in hotpaths.mjs's header.`,
      );
    }
  }

  // The caps themselves, by name. The limit comparison above already catches a drift
  // in what is SENT; this names the constant that drifted, which is the thing a reader
  // then has to go and fix.
  for (const [name, ours] of Object.entries(hotpaths)) {
    if (!/_ROW_CAP$/.test(name) || typeof ours !== "number") continue;
    if (!limitConstants.has(name)) continue;
    const theirs = limitConstants.get(name);
    if (ours !== theirs) {
      problems.push(
        `${name} drifted: govehlo-mobile/src/lib/settlement-data-guard.ts says ${theirs}, ` +
          `hotpaths.mjs says ${ours}.`,
      );
    }
  }

  return problems;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(GATEWAY)) {
    const msg =
      `govehlo-mobile not found at ${GATEWAY} — the hot-path mirror was NOT checked. ` +
      `Check out the sibling repo next to fuel_sharing to run it.`;
    if (STRICT) {
      process.stderr.write(`\n::error title=Hot-path mirror not checked::${msg}\n`);
      process.exit(1);
    }
    process.stdout.write(`::warning title=Hot-path mirror skipped::${msg}\n`);
    process.exit(0);
  }

  const gatewaySource = readFileSync(GATEWAY, "utf8");
  const hotpaths = await import("./load-rehearsal/lib/hotpaths.mjs");

  // Resolve the identifiers the gateway's `.limit(...)` calls are written in. A source
  // that has moved is a hard failure: an unresolvable cap is an unverified limit.
  const limitConstants = new Map();
  for (const file of LIMIT_CONSTANT_SOURCES) {
    if (!existsSync(file)) {
      process.stderr.write(
        `\n::error title=Hot-path mirror unreadable::${file} is missing — the gateway's ` +
          `.limit() constants cannot be resolved, so the mirror's limits are unverified. ` +
          `Update LIMIT_CONSTANT_SOURCES in tools/check-hotpath-mirror.mjs.\n`,
      );
      process.exit(1);
    }
    for (const [name, value] of extractNumericConstants(readFileSync(file, "utf8"))) {
      limitConstants.set(name, value);
    }
  }

  let problems;
  try {
    problems = compareMirror(gatewaySource, hotpaths, limitConstants);
  } catch (e) {
    if (e instanceof MirrorScanError) {
      // The gateway changed shape enough that the scraper can't read it. That is a
      // failure, never a pass: an unreadable gateway means the mirror is unverified.
      process.stderr.write(
        `\n::error title=Hot-path mirror unreadable::${e.message}. ` +
          `ledger-data-gateway.ts has changed shape — update the extractors in ` +
          `tools/check-hotpath-mirror.mjs so the mirror is verified again rather than assumed.\n`,
      );
      process.exit(1);
    }
    throw e;
  }

  if (problems.length) {
    process.stderr.write(
      `\n❌ tools/load-rehearsal/lib/hotpaths.mjs has drifted from govehlo-mobile's ledger-data-gateway.ts:\n\n`,
    );
    problems.forEach((p) => process.stderr.write(`  • ${p}\n`));
    process.stderr.write(
      `\nThe load rehearsal replays these exact queries. When they under-measure the real\n` +
        `client's payload, the rehearsal certifies headroom production does not have.\n`,
    );
    process.exit(1);
  }

  process.stdout.write("ok - hotpaths.mjs mirrors govehlo-mobile's ledger-data-gateway.ts\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

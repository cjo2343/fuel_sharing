// Cross-repo guard: tools/load-rehearsal/lib/hotpaths.mjs really does mirror
// govehlo-mobile's ledger-data-gateway.ts (GV-393).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — the guard it replaces asserted nothing
// ---------------------------------------------------------------------------
// test-load-rehearsal.mjs said it covered "that lib/hotpaths.mjs still mirrors the
// mobile data gateway". It contained zero references to govehlo-mobile. What it
// actually did was compare hotpaths.mjs against its OWN hardcoded copies of the same
// values — `assert.deepEqual(EVENT_TYPE_EXCLUDE, [ ...the same three strings... ])`.
// That is a tautology: the mirror and the expectation drift together, so the check
// stays green precisely when the mirror is wrong.
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
const GATEWAY = join(ROOT, "..", "govehlo-mobile", "src", "store", "ledger-data-gateway.ts");

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

// ── The comparison ──────────────────────────────────────────────────────────

export function compareMirror(gatewaySource, hotpaths) {
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
  for (const [table, label] of TABLES) {
    const gatewayFilters = readAppliesSoftDeleteFilter(gatewaySource, table);
    const entry = reads.find((r) => r.label === label);
    if (!entry) {
      problems.push(`hotpaths has no read labelled ${label}, but the gateway reads ${table}`);
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

  let problems;
  try {
    problems = compareMirror(gatewaySource, hotpaths);
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

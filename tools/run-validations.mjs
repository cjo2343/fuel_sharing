import { execSync } from 'child_process';

// Slim validation suite for the platform repo (GV-266).
//
// The legacy PWA runtime was archived at the `legacy-runtime-final` tag; the
// only thing this repo still guards is the shared Supabase schema and the
// canonical design tokens. This is the fast, dependency-free gate that runs on
// every commit and in CI. The `scripts` array below is the authoritative list —
// it has grown well past the "three checks" this header claimed until GV-393, so
// read the array, not a prose summary, and keep new entries commented in place.
//
// The three load-bearing ones, for orientation:
//   • test-migrations.mjs        — migration files present, ordered, mirrored
//                                   into supabase-schema.sql, tracker ids inserted.
//   • test-sql-ambiguity-guard   — blocks high-risk PL/pgSQL variable/column
//                                   name collisions in the SQL.
//   • check-token-drift.mjs      — canonical design tokens vs the derived copies
//                                   in the sibling repos, AND the hex colours the
//                                   web repo's markup actually paints (GV-371;
//                                   warns, never fails, when the siblings are
//                                   absent — e.g. fuel_sharing CI).
// The rest are per-feature SQL contract tests and unit tests for the scanners the
// heavier guards depend on.
//
// The heavier Docker-backed checks (schema equivalence, delete-account functional
// smoke) run as their own npm scripts / CI jobs, not here.

const scripts = [
  "node tools/test-migrations.mjs",
  "node tools/test-sql-ambiguity-guard.mjs",
  "node tools/test-booking-trip-contract.mjs",
  "node tools/test-booking-fuel-completion-contract.mjs",
  "node tools/test-booking-reminder-contract.mjs",
  "node tools/test-settlement-event-history-contract.mjs",
  "node tools/test-incident-photo-storage-contract.mjs",
  "node tools/test-late-entry-carryover-contract.mjs",
  "node tools/test-deferred-fuel-close-contract.mjs",
  "node tools/test-restore-drill-logic.mjs",
  // Pure unit tests for the load-rehearsal tooling (GV-317): env/prod-guard/arg
  // parsing, deterministic fixtures, settlement-close math, and the lib/hotpaths
  // mirror of the mobile data gateway. Docker-free and sub-second (GV-329).
  "node tools/load-rehearsal/test-load-rehearsal.mjs",
  // Unit test for check-token-drift's markup scanner (GV-371). Runs first so a broken
  // scanner reports as a broken scanner, not as a repo full of bad colours — and so it
  // is covered even in CI, where the sibling repo it scans is not checked out.
  "node tools/test-markup-hex-scan.mjs",
  // Unit test for the scanners behind the role-matrix coverage check (GV-379), plus the
  // Docker-free half of its reviewed-exception list. Lives here for the same reason as
  // the line above: the check itself only runs in the heavy role-matrix job, so without
  // this its logic would go unexercised on most commits.
  "node tools/test-role-matrix-coverage.mjs",
  // Unit test for the scanner behind test-migrations.mjs's mirror check (GV-392). Runs
  // BEFORE nothing in particular — test-migrations.mjs above already depends on it — but
  // it earns its place for the reason the two lines above do: if the scanner breaks, the
  // failure must read as "the scanner is broken", not as "every migration is unmirrored".
  "node tools/test-tracker-insert-scan.mjs",
  // Unit test for the cross-repo hot-path mirror scanner (GV-393). Same reason as the
  // three lines above: check-hotpath-mirror.mjs only does real work where
  // govehlo-mobile is checked out (the umbrella workflow, or a dev machine), so
  // without this its logic would go unexercised on nearly every commit.
  "node tools/test-hotpath-mirror-scan.mjs",
  "node tools/check-token-drift.mjs",
  // Cross-repo: does the load rehearsal still replay what the mobile client actually
  // sends? Warns and exits 0 when govehlo-mobile is absent (fuel_sharing CI); the
  // umbrella runs it --strict (GV-393).
  "node tools/check-hotpath-mirror.mjs",
];

console.log('🚀 Starting validation suite...');

let failed = false;

for (const script of scripts) {
  try {
    console.log(`\n⏳ Running: ${script}`);
    execSync(script, { stdio: 'inherit' });
  } catch (error) {
    console.error(`\n❌ Validation failed on: ${script}`);
    failed = true;
    break;
  }
}

if (failed) {
  console.error('\n⚠️ Validation suite aborted due to errors.');
  process.exit(1);
} else {
  console.log('\n✅ All validations passed successfully!');
}

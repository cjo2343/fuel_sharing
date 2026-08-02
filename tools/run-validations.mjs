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
  // Anti-drift contract for the pre-departure fuel-stop verdict (GV-405). The one guard
  // here that needs a real Postgres: migration 154 duplicates ~20 lines of arithmetic
  // that also live in govehlo-mobile/src/lib/fuel-stop-revalidation.ts, and a regex over
  // the SQL would happily pass a mutation that changes the answer. Replays that module's
  // vitest scenarios against the SQL. Warns and exits 0 without Docker — the same
  // contract check-hotpath-mirror.mjs uses for an absent sibling — so `npm run validate`
  // stays dependency-free; CI runs it --strict in the functional-smoke job.
  "node tools/test-fuel-stop-verdict-contract.mjs",
  // Anti-drift contract for the bro/færge crossing split (GVM-415). Same two reasons as
  // the line above and one more: the crossing is the only split in the settlement engine
  // that follows NEITHER of the rules already in the file — its universe is the trip's
  // own assignees rather than the workspace's active members, and its weights are always
  // equal — so "implemented like repairs" produces a plausible number on one side and a
  // wrong one on the other. Runs the 250,00 kr / 3 øre-exact case against a real
  // Postgres. Warns and exits 0 without Docker, and warns while govehlo-mobile's twin
  // has not landed; a PARTIAL mobile mirror fails hard. The umbrella runs it --strict.
  "node tools/test-crossing-split-contract.mjs",
  // Anti-drift contract for the booking caps — booked days + horizon (GVM-463). Docker
  // for the same reason as the two above, plus the one that is specific to this pair:
  // migration 159 is the first booking setting that REJECTS a write rather than letting
  // the client decide (152 only stores its number), so the guarantee under test is that
  // a stale client cannot over-book — and nothing but a real Postgres refusing a real
  // booking can certify that. Pins both boundaries (exactly ON the day cap is accepted,
  // one past it is GV46D; horizon day N at any hour is accepted, day N+1 is GV46H), that
  // a day is an inclusive calendar day so a booking spanning midnight counts 2, and —
  // the one that protects live data — that both caps NULL is byte-identical behaviour,
  // since every existing workspace has them null. Warns and exits 0 without Docker; the
  // umbrella runs it --strict.
  "node tools/test-booking-caps-contract.mjs",
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
  // Unit test for the ledger_events classification scanner (GV-413). Runs before the
  // guard itself for the reason the four lines above give: a broken scanner must read
  // as a broken scanner, not as a schema full of unclassified event types.
  "node tools/test-ledger-event-classification-scan.mjs",
  // Every event_type an INSERT can write into public.ledger_events must be classified
  // as feed-visible or audit-only (GV-413). The mobile Activity feed has no allow-list
  // — a new type is visible to every member the moment a migration writes it, with no
  // client change and nothing failing, which is how three reminder-audit types leaked
  // in one evening. This reads fuel_sharing's own migrations, so it belongs in the
  // fast gate and fails on the PR that adds the migration; only the govehlo-web half
  // of the scan tolerates a missing sibling (the umbrella runs it --strict).
  "node tools/check-ledger-event-classification.mjs",
  // Unit + fixture tests for the release gates (GV-422). The GATE SCRIPT ITSELF —
  // `node tools/check-release-gates.mjs` — is deliberately NOT in this array, and
  // adding it would be a mistake, not a fix:
  //
  //   Every other entry here judges the COMMIT. The release gates judge the
  //   PRODUCT — a paid Supabase plan (GV-313), a restore drill someone has to run
  //   by hand against a fresh prod dump, a CVR that unblocks the privacy page
  //   (GV-177), an attestation a human signs. Those are red today, on purpose, and
  //   no author of an unrelated commit can turn any of them green. Wiring them
  //   into the per-commit gate (and therefore the pre-push hook) would make every
  //   commit in the repo red for reasons its author cannot act on, which is the
  //   fastest known way to teach everyone that red means nothing — the same
  //   argument the umbrella workflow's header makes about its own token probe.
  //   It runs pre-release and in the umbrella instead (`npm run check:release-gates`).
  //
  // THIS line is the unit test, which is a different thing: fixtures only, no
  // product state, sub-second, and green. It is here for the reason the five
  // scanner tests above are — the gate script is EXPECTED to be red, so its
  // greenness is never observed in practice, and a logic bug that made it pass
  // everything would look exactly like progress.
  "node tools/test-release-gates.mjs",
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

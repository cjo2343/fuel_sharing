import { execSync } from 'child_process';

// Slim validation suite for the platform repo (GV-266).
//
// The legacy PWA runtime was archived at the `legacy-runtime-final` tag; the
// only thing this repo still guards is the shared Supabase schema and the
// canonical design tokens. These three checks are the fast, dependency-free
// gate that runs on every commit and in CI:
//
//   1. test-migrations.mjs        — migration files present, ordered, mirrored
//                                    into supabase-schema.sql, tracker ids inserted.
//   2. test-sql-ambiguity-guard   — blocks high-risk PL/pgSQL variable/column
//                                    name collisions in the SQL.
//   3. check-token-drift.mjs      — canonical design tokens vs the derived copies
//                                    in the sibling repos (warns, never fails, when
//                                    the siblings are absent — e.g. fuel_sharing CI).
//
// The heavier Docker-backed checks (schema equivalence, delete-account functional
// smoke) run as their own npm scripts / CI jobs, not here.

const scripts = [
  "node tools/test-migrations.mjs",
  "node tools/test-sql-ambiguity-guard.mjs",
  "node tools/test-booking-trip-contract.mjs",
  "node tools/check-token-drift.mjs",
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

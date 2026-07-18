// GDPR restore drill (GV-310, hardened in GV-325).
//
// Restores an operator-downloaded Supabase backup dump into a disposable local
// Postgres container and asserts the result is a usable database — proving the
// backup can actually be restored instead of assuming it. Produces an evidence
// summary to paste into docs/gdpr/backup-restore.md's drill log.
//
//   npm run drill:restore -- /path/to/backup.sql        (plain SQL dump)
//   npm run drill:restore -- /path/to/backup.sql.gz     (gzipped SQL dump)
//   npm run drill:restore -- /path/to/backup.dump       (pg_dump custom format)
//
// The dump comes from the Supabase dashboard (Database → Backups) or
// `supabase db dump`. It contains production personal data: keep it OUTSIDE the
// repo, never commit it, and delete it after the drill. The container is
// removed when the drill ends (pass --keep to retain it for inspection).
//
// What "restored and usable" means here (GV-325 hardened the first three):
//   1. Restore errors are CLASSIFIED, not blanket-tolerated. Known Supabase
//      cluster/infra noise (missing supabase_admin/pgbouncer roles, pg_net,
//      event triggers, ALTER … OWNER, publication grants) is tolerated and
//      counted; any error naming a public object, any failed COPY, disk
//      exhaustion, or any UNRECOGNISED error fails the drill.
//   2. For plain-SQL dumps, every `COPY public.<table>` block's row count is
//      read offline from the dump and compared exactly against the restored
//      table. Any mismatch fails. (Custom-format dumps degrade explicitly —
//      row verification is reported as unavailable, not silently skipped.)
//   3. The migration tracker must be current with the repo's newest expected
//      migration (derived from tools/test-migrations.mjs). A dump that predates
//      it fails with "take a fresh dump".
//   4. Every core domain table exists and still has row-level security enabled.
//   5. Key RPCs survived, and a representative one (owner_workspace_overview_page)
//      actually executes against the restored data.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startPostgres,
  createDbWithPrelude,
  removeContainer,
  psql,
} from "./lib/replay-container.mjs";
import {
  classifyRestoreErrors,
  countCopyRowsFromDump,
  readExpectedMigrations,
  migrationNumber,
} from "./lib/restore-drill-lib.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = "vehloshare-restore-drill";
const DB = "restore_drill";

const CORE_TABLES = [
  "ledgers",
  "ledger_members",
  "trips",
  "trip_participants",
  "fuel_payments",
  "workspace_expenses",
  "vehicle_repairs",
  "recurring_expenses",
  "settlement_periods",
  "settlement_requests",
  "car_bookings",
  "ledger_events",
  "messages",
  "expo_push_tokens",
];

const KEY_RPCS = [
  "delete_my_account",
  "calculate_period_settlement",
  "current_ledger_member_id",
  "owner_workspace_overview_page",
];

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const dumpPath = args.find((a) => !a.startsWith("--"));

if (!dumpPath) {
  console.error("Usage: npm run drill:restore -- /path/to/backup.sql[.gz|.dump] [--keep]");
  process.exit(1);
}
let dumpStat;
try {
  dumpStat = statSync(dumpPath);
} catch {
  console.error(`❌ Dump file not found: ${dumpPath}`);
  process.exit(1);
}

const log = (msg) => console.log(msg);
const warnings = [];
const failures = [];

function fail(msg) {
  console.error(`❌ ${msg}`);
  if (!keep) removeContainer(CONTAINER);
  process.exit(1);
}

// One SELECT via the shared ON_ERROR_STOP psql helper; failures are fatal.
function q(sql) {
  const res = psql(CONTAINER, DB, ["-tA", "-c", sql]);
  if (res.status !== 0) fail(`Query failed: ${sql}\n${res.stderr}`);
  return res.stdout.trim();
}

// A SELECT that tolerates failure (e.g. a table the dump claimed but did not
// restore) — returns null instead of aborting, so row-count verification can
// report a precise mismatch rather than a generic query error.
function softQuery(sql) {
  const res = psql(CONTAINER, DB, ["-tA", "-c", sql]);
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

// The single source of truth for the newest migration: the `expected` array in
// tools/test-migrations.mjs (parsed, not duplicated).
const expectedMigration = readExpectedMigrations(REPO);

// ── 1. Container + prelude ───────────────────────────────────────────────────
removeContainer(CONTAINER);
log(`⏳ Starting disposable Postgres (${CONTAINER})…`);
try {
  startPostgres(CONTAINER, REPO);
  createDbWithPrelude(CONTAINER, DB);
} catch (err) {
  fail(err.message);
}
log("✅ Container ready, Supabase-stub prelude applied.");

// ── 2. Copy dump in and restore ──────────────────────────────────────────────
const sha256 = createHash("sha256").update(readFileSync(dumpPath)).digest("hex");
const magic = readFileSync(dumpPath).subarray(0, 5);
const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
const isCustom = magic.toString("latin1") === "PGDMP";

execFileSync("docker", ["cp", dumpPath, `${CONTAINER}:/tmp/dump.bin`]);

log(`⏳ Restoring ${path.basename(dumpPath)} (${(dumpStat.size / 1024 / 1024).toFixed(1)} MB, ${isCustom ? "custom format" : isGzip ? "gzipped SQL" : "plain SQL"})…`);

// Restore WITHOUT ON_ERROR_STOP: every error is captured and then CLASSIFIED.
const restoreCmd = isCustom
  ? `pg_restore --no-owner -U postgres -d ${DB} /tmp/dump.bin`
  : isGzip
    ? `gunzip -c /tmp/dump.bin | psql -q -U postgres -d ${DB} -f -`
    : `psql -q -U postgres -d ${DB} -f /tmp/dump.bin`;
const restore = spawnSync("docker", ["exec", CONTAINER, "sh", "-c", restoreCmd], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});

// Classify restore stderr: tolerated Supabase-infra noise vs would-be-fatal.
const classified = classifyRestoreErrors(restore.stderr || "");
if (classified.toleratedCount > 0) {
  const cats = Object.entries(classified.byCategory)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}=${n}`)
    .join(", ");
  log(`⚠️  Restore reported ${classified.toleratedCount} tolerated infra error(s) [${cats}] — sample:`);
  for (const e of classified.distinctTolerated.slice(0, 10)) log(`   · ${e.slice(0, 180)}`);
  if (classified.distinctTolerated.length > 10) {
    log(`   · … and ${classified.distinctTolerated.length - 10} more distinct`);
  }
  warnings.push(`${classified.toleratedCount} tolerated infra error(s)`);
} else if (classified.fatalCount === 0) {
  log("✅ Restore completed with no errors.");
}
if (classified.fatalCount > 0) {
  log(`❌ Restore reported ${classified.fatalCount} FATAL error(s) — printed verbatim below:`);
  for (const e of classified.fatal) {
    console.error(`   ✗ [${e.category}] ${e.raw.trim()}`);
    for (const d of e.detail) console.error(`       ${d}`);
  }
  failures.push(`${classified.fatalCount} fatal restore error(s) (see verbatim lines above)`);
}

// Offline source-of-truth row counts from the dump's COPY blocks (plain SQL
// only). Streamed line-by-line — never buffers the whole dump.
const rowCheckAvailable = !isCustom;
let expectedRowCounts = new Map();
if (rowCheckAvailable) {
  try {
    expectedRowCounts = await countCopyRowsFromDump(dumpPath, { gzip: isGzip });
  } catch (err) {
    fail(`Failed to parse COPY blocks from the dump for row verification: ${err.message}`);
  }
}

// ── 3. Assertions ────────────────────────────────────────────────────────────

// 3a. Migration tracker present and current with the repo's newest migration.
const trackerExists = q(
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'fuel_ledger_schema_migrations'",
);
if (trackerExists !== "1") fail("Migration tracker table is missing — the dump did not restore the public schema.");
const trackedCount = Number(q("select count(*) from public.fuel_ledger_schema_migrations"));
if (trackedCount === 0) fail("Migration tracker restored but empty — dump is not a usable database backup.");

const newestApplied = q(
  "select migration_id from public.fuel_ledger_schema_migrations order by migration_id desc limit 1",
);
const restoredMaxNumber = migrationNumber(newestApplied);
let trackerCurrent;
if (Number.isFinite(restoredMaxNumber) && restoredMaxNumber >= expectedMigration.latestNumber) {
  trackerCurrent = true;
  const suffix = restoredMaxNumber > expectedMigration.latestNumber ? " (dump is ahead of repo)" : "";
  log(`✅ Migration tracker: ${trackedCount} entries, current with repo (${newestApplied})${suffix}.`);
} else {
  trackerCurrent = false;
  failures.push(
    `dump predates migration ${expectedMigration.latestId} — take a fresh dump ` +
      `(dump's newest is ${newestApplied || "unknown"}, repo expects ${expectedMigration.latestId})`,
  );
  log(`❌ Migration tracker: dump's newest is ${newestApplied}, repo expects ${expectedMigration.latestId} — dump predates the schema.`);
}

// 3b. Core tables exist with RLS enabled; row counts as evidence.
const counts = [];
for (const table of CORE_TABLES) {
  const rls = q(
    `select coalesce((select c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = '${table}'), 'missing')`,
  );
  if (rls === "missing") {
    failures.push(`core table public.${table} is missing after restore`);
    continue;
  }
  if (rls !== "true") failures.push(`row-level security is DISABLED on public.${table} after restore`);
  const n = q(`select count(*) from public.${table}`);
  counts.push(`${table}=${n}`);
  if (n === "0") warnings.push(`table ${table} restored empty`);
}
log(`ℹ️  Row counts: ${counts.join(", ")}`);

// 3c. Row-count verification: every public COPY block in the dump must match the
// restored table exactly (plain SQL only; custom format degrades explicitly).
let rowVerified = 0;
const rowMismatches = [];
if (!rowCheckAvailable) {
  log("ℹ️  Row-count verification unavailable for custom-format (PGDMP) dumps — COPY blocks are binary, not text-parseable.");
  warnings.push("row-count verification unavailable (custom-format dump)");
} else if (expectedRowCounts.size === 0) {
  log("ℹ️  Row-count verification: dump contains no COPY blocks (schema-only dump?) — nothing to verify.");
} else {
  for (const [table, expected] of expectedRowCounts) {
    const actual = softQuery(`select count(*) from public."${table}"`);
    if (actual === null) {
      rowMismatches.push(`${table}: table missing after restore (dump has ${expected} row(s))`);
      continue;
    }
    rowVerified += 1;
    if (Number(actual) !== expected) {
      rowMismatches.push(`${table}: expected ${expected}, restored ${actual}`);
    }
  }
  if (rowMismatches.length > 0) {
    log(`❌ Row-count verification: ${rowMismatches.length} mismatch(es) across ${expectedRowCounts.size} public COPY block(s):`);
    for (const m of rowMismatches) {
      console.error(`   ✗ ${m}`);
      failures.push(`row-count mismatch — ${m}`);
    }
  } else {
    log(`✅ Row-count verification: ${expectedRowCounts.size} public table(s) match the dump exactly.`);
  }
}

// 3d. Key RPCs survived.
for (const fn of KEY_RPCS) {
  const present = q(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${fn}'`,
  );
  if (present === "0") failures.push(`key RPC public.${fn} is missing after restore`);
}

// 3e. A representative read RPC executes against the restored data.
// owner_workspace_overview_page is STABLE, reads five domain tables, and does
// not depend on auth.jwt() — ideal for proving the restored schema+data works.
let totalWorkspaces = "?";
const overview = softQuery("select public.owner_workspace_overview_page(1, 0)::text");
if (overview === null) {
  failures.push("owner_workspace_overview_page failed to execute against the restored data");
} else {
  try {
    totalWorkspaces = String(JSON.parse(overview).totalWorkspaces);
  } catch {
    failures.push("owner_workspace_overview_page returned unparseable output");
  }
}

// ── 4. Verdict + evidence block ──────────────────────────────────────────────
if (!keep) removeContainer(CONTAINER);
else log(`ℹ️  Container kept for inspection: docker exec -it ${CONTAINER} psql -U postgres -d ${DB}`);

const passed = failures.length === 0;
const rowCell = !rowCheckAvailable
  ? "rækker: n/a (custom-format)"
  : `rækker: ${rowVerified}/${expectedRowCounts.size} tabeller verificeret (${rowMismatches.length} afvig)`;
const errCell = `fejl: ${classified.toleratedCount} tolereret / ${classified.fatalCount} fatale`;
const trackerCell = trackerCurrent ? "tracker: aktuel" : `tracker: bagud (< ${expectedMigration.latestId})`;

log("");
log("── Drill evidence (paste into docs/gdpr/backup-restore.md) ─────────────");
log(
  `| ${new Date().toISOString().slice(0, 10)} | ${path.basename(dumpPath)} | sha256:${sha256.slice(0, 12)}… | ` +
    `${(dumpStat.size / 1024 / 1024).toFixed(1)} MB | ${trackedCount} migrationer (${newestApplied}) | ` +
    `${totalWorkspaces} workspaces | ${errCell} | ${rowCell} | ${trackerCell} | ` +
    `${passed ? "BESTÅET" : "FEJLET"} |`,
);
if (warnings.length > 0) log(`Advarsler: ${warnings.join("; ")}`);
log("─────────────────────────────────────────────────────────────────────────");
log("");

if (!passed) {
  for (const f of failures) console.error(`❌ ${f}`);
  console.error("❌ RESTORE DRILL FAILED");
  process.exit(1);
}
log("✅ RESTORE DRILL PASSED");
log("Husk: slet dump-filen efter drillen — den indeholder produktions-persondata.");

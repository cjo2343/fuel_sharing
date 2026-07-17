// GDPR restore drill (GV-310).
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
// What "restored and usable" means here:
//   1. The migration tracker exists and matches the repo's newest migration
//      (older dump → warning, not failure — that is itself drill evidence).
//   2. Every core domain table exists and still has row-level security enabled.
//   3. Key RPCs survived the restore, and a representative one
//      (owner_workspace_overview_page) actually executes against the data.
//   4. Row counts are reported as evidence (empty tables warn, not fail).
//
// Restore errors are expected in small numbers: a Supabase dump references
// cluster-level objects a vanilla Postgres lacks (supabase_admin ownership,
// vault/graphql extensions, event triggers). The drill tolerates and counts
// them, reports the distinct messages, and lets the public-schema assertions
// decide the verdict.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startPostgres,
  createDbWithPrelude,
  removeContainer,
  psql,
} from "./lib/replay-container.mjs";

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

// Restore WITHOUT ON_ERROR_STOP: tolerated errors are counted and reported.
const restoreCmd = isCustom
  ? `pg_restore --no-owner -U postgres -d ${DB} /tmp/dump.bin`
  : isGzip
    ? `gunzip -c /tmp/dump.bin | psql -q -U postgres -d ${DB} -f -`
    : `psql -q -U postgres -d ${DB} -f /tmp/dump.bin`;
const restore = spawnSync("docker", ["exec", CONTAINER, "sh", "-c", restoreCmd], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});

const errorLines = (restore.stderr || "")
  .split("\n")
  .filter((l) => /error/i.test(l) && !/errors ignored on restore/i.test(l));
const distinctErrors = [...new Set(errorLines.map((l) => l.replace(/^pg_restore: /, "").trim()))];
if (distinctErrors.length > 0) {
  log(`⚠️  Restore reported ${errorLines.length} error line(s), ${distinctErrors.length} distinct — review below:`);
  for (const e of distinctErrors.slice(0, 12)) log(`   · ${e.slice(0, 200)}`);
  if (distinctErrors.length > 12) log(`   · … and ${distinctErrors.length - 12} more`);
  warnings.push(`${errorLines.length} tolerated restore error(s) (${distinctErrors.length} distinct)`);
} else {
  log("✅ Restore completed with no errors.");
}

// ── 3. Assertions ────────────────────────────────────────────────────────────

// 3a. Migration tracker present and (ideally) current.
const trackerExists = q(
  "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'fuel_ledger_schema_migrations'",
);
if (trackerExists !== "1") fail("Migration tracker table is missing — the dump did not restore the public schema.");
const trackedCount = Number(q("select count(*) from public.fuel_ledger_schema_migrations"));
if (trackedCount === 0) fail("Migration tracker restored but empty — dump is not a usable database backup.");

const newestRepoMigration = readdirSync(path.join(REPO, "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .at(-1)
  .replace(/\.sql$/, "");
const newestApplied = q(
  "select migration_id from public.fuel_ledger_schema_migrations order by migration_id desc limit 1",
);
if (newestApplied === newestRepoMigration) {
  log(`✅ Migration tracker: ${trackedCount} entries, current with repo (${newestApplied}).`);
} else {
  log(`⚠️  Migration tracker: ${trackedCount} entries; dump's newest is ${newestApplied}, repo's is ${newestRepoMigration} (older dump?).`);
  warnings.push(`dump at ${newestApplied}, repo at ${newestRepoMigration}`);
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

// 3c. Key RPCs survived.
for (const fn of KEY_RPCS) {
  const present = q(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${fn}'`,
  );
  if (present === "0") failures.push(`key RPC public.${fn} is missing after restore`);
}

// 3d. A representative read RPC executes against the restored data.
// owner_workspace_overview_page is STABLE, reads five domain tables, and does
// not depend on auth.jwt() — ideal for proving the restored schema+data works.
const overview = q("select public.owner_workspace_overview_page(1, 0)::text");
let totalWorkspaces = "?";
try {
  totalWorkspaces = String(JSON.parse(overview).totalWorkspaces);
} catch {
  failures.push("owner_workspace_overview_page returned unparseable output");
}

// ── 4. Verdict + evidence block ──────────────────────────────────────────────
if (!keep) removeContainer(CONTAINER);
else log(`ℹ️  Container kept for inspection: docker exec -it ${CONTAINER} psql -U postgres -d ${DB}`);

log("");
log("── Drill evidence (paste into docs/gdpr/backup-restore.md) ─────────────");
log(`| ${new Date().toISOString().slice(0, 10)} | ${path.basename(dumpPath)} | sha256:${sha256.slice(0, 12)}… | ` +
  `${(dumpStat.size / 1024 / 1024).toFixed(1)} MB | ${trackedCount} migrationer (${newestApplied}) | ` +
  `${totalWorkspaces} workspaces | ${failures.length === 0 ? "BESTÅET" : "FEJLET"} |`);
if (warnings.length > 0) log(`Advarsler: ${warnings.join("; ")}`);
log("─────────────────────────────────────────────────────────────────────────");
log("");

if (failures.length > 0) {
  for (const f of failures) console.error(`❌ ${f}`);
  console.error("❌ RESTORE DRILL FAILED");
  process.exit(1);
}
log("✅ RESTORE DRILL PASSED");
log("Husk: slet dump-filen efter drillen — den indeholder produktions-persondata.");

// Dependency-free unit tests for the restore-drill pure logic (GV-325).
//
//   node tools/test-restore-drill-logic.mjs
//
// Covers the three hardenings' pure functions: the restore-error classifier,
// the COPY-block row counter (string + plain-file + gz stream), and the
// expected-migration derivation. No Docker, no network — fast enough to run in
// `npm run validate`. The end-to-end Docker smoke lives in
// tools/test-restore-drill-smoke.mjs.

import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  classifyRestoreErrors,
  classifyErrorRecord,
  parseStderrToErrorRecords,
  countCopyRowsFromString,
  countCopyRowsFromDump,
  parseExpectedMigrations,
  readExpectedMigrations,
  migrationNumber,
} from "./lib/restore-drill-lib.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function classifyOne(stderr) {
  const [rec] = parseStderrToErrorRecords(stderr);
  assert.ok(rec, `expected an error record from:\n${stderr}`);
  return classifyErrorRecord(rec);
}

// ── 1. Error classification ──────────────────────────────────────────────────

// Realistic tolerated (Supabase infra) lines — all must be tolerated.
const TOLERATED_SAMPLES = [
  ['psql:/tmp/dump.bin:42: ERROR:  role "supabase_admin" does not exist', "role"],
  ['psql:/tmp/dump.bin:43: ERROR:  role "authenticator" does not exist', "role"],
  ['psql:/tmp/dump.bin:44: ERROR:  role "pgbouncer" does not exist', "role"],
  ['psql:/tmp/dump.bin:45: ERROR:  role "dashboard_user" does not exist', "role"],
  ['psql:/tmp/dump.bin:46: ERROR:  permission denied to set role "supabase_admin"', "role-privilege"],
  ['psql:/tmp/dump.bin:47: ERROR:  must be owner of table objects', "ownership"],
  ['psql:/tmp/dump.bin:48: ERROR:  extension "pg_net" is not available', "pg_net"],
  ['psql:/tmp/dump.bin:49: ERROR:  schema "net" does not exist', "pg_net"],
  ['psql:/tmp/dump.bin:50: ERROR:  event trigger "pgrst_ddl_watch" already exists', "event-trigger"],
  ['psql:/tmp/dump.bin:51: ERROR:  publication "supabase_realtime" already exists', "publication"],
  ['psql:/tmp/dump.bin:52: ERROR:  permission denied for schema storage', "infra-schema"],
  ['psql:/tmp/dump.bin:53: ERROR:  relation "storage.objects" does not exist', "infra-object"],
  ['psql:/tmp/dump.bin:54: ERROR:  function graphql.get_schema_version() does not exist', "infra-object"],
  ['psql:/tmp/dump.bin:55: ERROR:  schema "vault" does not exist', "infra-schema"],
  // Seen in the first real PG17 drill (2026-07-18): Supabase-bundled vault
  // extension absent from the stock image, and the dump colliding with the
  // drill's own auth.jwt()/auth.uid() prelude stubs.
  ['psql:<stdin>:158: ERROR:  extension "supabase_vault" is not available', "infra-schema"],
  ['psql:<stdin>:165: ERROR:  extension "supabase_vault" does not exist', "infra-schema"],
  ['psql:<stdin>:428: ERROR:  function "jwt" already exists with same argument types', "bootstrap-stub"],
  ['psql:<stdin>:469: ERROR:  function "uid" already exists with same argument types', "bootstrap-stub"],
];

for (const [line, expectedCat] of TOLERATED_SAMPLES) {
  const c = classifyOne(line);
  assert.equal(c.tolerated, true, `should be TOLERATED: ${line} (got ${c.category})`);
  assert.equal(c.category, expectedCat, `category for: ${line}`);
}

// The critical false-positive guard: an ALTER … OWNER TO whose Command line
// names a public table but whose *reason* is a missing infra role. The public.
// mention in the Command must NOT make it fatal.
{
  const stderr = [
    'pg_restore: error: could not execute query: ERROR:  role "supabase_admin" does not exist',
    "Command was: ALTER TABLE public.trips OWNER TO supabase_admin;",
  ].join("\n");
  const c = classifyOne(stderr);
  assert.equal(c.tolerated, true, "ALTER OWNER TO with public table in Command must stay tolerated");
  assert.equal(c.category, "role");
}

// Realistic fatal lines — all must be fatal (not tolerated).
const FATAL_SAMPLES = [
  // Failed COPY on a public table (reason names the syntax error; CONTEXT names COPY).
  [
    "psql:/tmp/dump.bin:600: ERROR:  invalid input syntax for type integer: \"notanumber\"\npsql:/tmp/dump.bin:600: CONTEXT:  COPY trips, line 3, column odometer: \"notanumber\"",
    "copy-data",
  ],
  // pg_restore surfacing a COPY failure.
  ['pg_restore: error: COPY failed for table "trips": ERROR:  invalid input syntax for type integer: "x"', "copy-data"],
  // Missing object in the public schema.
  ['psql:/tmp/dump.bin:700: ERROR:  relation "public.trips" does not exist', "public-object"],
  ['psql:/tmp/dump.bin:701: ERROR:  function public.upsert_fuel_payment(uuid) does not exist', "public-object"],
  // Constraint violations.
  ['psql:/tmp/dump.bin:800: ERROR:  duplicate key value violates unique constraint "trips_pkey"', "constraint"],
  ['psql:/tmp/dump.bin:801: ERROR:  null value in column "amount" violates not-null constraint', "constraint"],
  // Syntax error mid-restore.
  ['psql:/tmp/dump.bin:900: ERROR:  syntax error at or near "SELCT"', "syntax"],
  // Out of disk.
  ['psql:/tmp/dump.bin:1000: PANIC:  could not write to file "pg_wal/xlogtemp.123": No space left on device', "disk"],
  // Truncated dump (pg_restore lowercase error, no uppercase ERROR:).
  ["pg_restore: error: could not read from input file: end of file", "unknown"],
  // Anything the allowlist does not recognise ⇒ fatal.
  ["psql:/tmp/dump.bin:1100: ERROR:  something completely unexpected happened", "unknown"],
  // Version-mismatch tripwires (PG17 dump into an older server) must STAY
  // fatal — the fix is matching the drill image to prod's major, never the
  // allowlist. Seen live 2026-07-18 before the drill moved to postgres:17.
  ['psql:<stdin>:24876: ERROR:  unrecognized privilege type "maintain"', "unknown"],
  ['psql:<stdin>:13: ERROR:  unrecognized configuration parameter "transaction_timeout"', "unknown"],
];

for (const [line, expectedCat] of FATAL_SAMPLES) {
  const c = classifyOne(line);
  assert.equal(c.tolerated, false, `should be FATAL: ${line} (got tolerated, cat=${c.category})`);
  assert.equal(c.category, expectedCat, `category for: ${line}`);
}

// Aggregate: a mixed stderr yields the right tolerated/fatal split and keeps
// the raw line for verbatim printing.
{
  const stderr = [
    'psql:/tmp/dump.bin:42: ERROR:  role "supabase_admin" does not exist',
    'psql:/tmp/dump.bin:52: ERROR:  publication "supabase_realtime" already exists',
    'psql:/tmp/dump.bin:700: ERROR:  relation "public.trips" does not exist',
    'psql:/tmp/dump.bin:600: ERROR:  invalid input syntax for type integer: "x"',
    "pg_restore: warning: errors ignored on restore: 350",
  ].join("\n");
  const res = classifyRestoreErrors(stderr);
  assert.equal(res.toleratedCount, 2, "two tolerated");
  assert.equal(res.fatalCount, 2, "two fatal");
  assert.equal(res.errors.length, 4, "summary line is not an error");
  assert.ok(res.fatal.every((e) => e.raw), "fatal errors keep their raw line for verbatim printing");
}

console.log("ok - error classifier: allowlisted infra tolerated, public/COPY/disk/unknown fatal");

// ── 2. COPY row counting ─────────────────────────────────────────────────────

const COPY_SQL = [
  "SET session_replication_role = replica;",
  "COPY public.ledgers (id, name) FROM stdin;",
  "1\tAlpha",
  "2\tBeta with a \\t tab escape",
  "3\tnull \\N here",
  "\\.",
  "COPY public.empty_table (id) FROM stdin;", // empty table → 0 rows
  "\\.",
  "COPY storage.objects (id, bucket) FROM stdin;", // non-public → skipped
  "skip-1",
  "skip-2",
  "\\.",
  "COPY public.with_backslash (id, data) FROM stdin;",
  "1\ta\\\\b", // embedded double-backslash in data
  "2\tc\\.d", // backslash-dot mid-line is data, NOT a terminator
  "\\.",
  "COPY unqualified_public (id) FROM stdin;", // no schema ⇒ public
  "1",
  "\\.",
].join("\n");

{
  const counts = countCopyRowsFromString(COPY_SQL);
  assert.equal(counts.get("ledgers"), 3, "ledgers has 3 rows");
  assert.equal(counts.get("empty_table"), 0, "empty table counts 0, not missing");
  assert.equal(counts.get("with_backslash"), 2, "embedded backslashes are data, counted");
  assert.equal(counts.get("unqualified_public"), 1, "unqualified COPY treated as public");
  assert.equal(counts.has("objects"), false, "non-public COPY block is skipped");
  assert.equal(counts.size, 4, "exactly the four public tables");
}

console.log("ok - COPY counter: embedded backslashes, empty tables, non-public skip, unqualified public");

// Plain-file + gz stream parsing must yield identical counts to the string path.
{
  const dir = mkdtempSync(path.join(tmpdir(), "drill-copy-"));
  try {
    const plainPath = path.join(dir, "dump.sql");
    const gzPath = path.join(dir, "dump.sql.gz");
    writeFileSync(plainPath, COPY_SQL);
    writeFileSync(gzPath, gzipSync(Buffer.from(COPY_SQL)));

    const plainCounts = await countCopyRowsFromDump(plainPath);
    const gzCounts = await countCopyRowsFromDump(gzPath); // auto-detects gzip magic

    for (const table of ["ledgers", "empty_table", "with_backslash", "unqualified_public"]) {
      assert.equal(plainCounts.get(table), countCopyRowsFromString(COPY_SQL).get(table), `plain ${table}`);
      assert.equal(gzCounts.get(table), plainCounts.get(table), `gz ${table} matches plain`);
    }
    assert.equal(gzCounts.get("ledgers"), 3, "gz stream parsed ledgers=3");
    assert.equal(gzCounts.has("objects"), false, "gz stream skipped non-public block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("ok - COPY counter: plain-file and gzip-stream parsing match the string path");

// ── 3. Expected-migration derivation ─────────────────────────────────────────

{
  // Synthetic source, deliberately out of numeric order to prove max-based pick.
  const src = [
    "const expected = [",
    '  "001_initial_schema.sql",',
    '  "131_gdpr_retention_policy.sql",',
    '  "050_settlement_mode.sql",',
    "];",
    'const other = ["999_not_this.sql"];',
  ].join("\n");
  const parsed = parseExpectedMigrations(src);
  assert.equal(parsed.latestNumber, 131, "picks the numeric max");
  assert.equal(parsed.latestId, "131_gdpr_retention_policy", "latestId strips .sql");
  assert.equal(parsed.files.length, 3, "only the expected array, not the other array");
}

assert.equal(migrationNumber("131_gdpr_retention_policy.sql"), 131);
assert.equal(migrationNumber("007_security_health_rpc"), 7);

{
  // Against the real test-migrations.mjs: the derived latest must match the
  // newest file actually on disk in supabase/migrations.
  const parsed = readExpectedMigrations(REPO);
  const newestOnDisk = readdirSync(path.join(REPO, "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .at(-1);
  assert.equal(
    parsed.latest,
    newestOnDisk,
    `derived latest (${parsed.latest}) must match newest migration file (${newestOnDisk})`,
  );
  assert.equal(parsed.latestNumber, migrationNumber(newestOnDisk));
}

console.log("ok - expected-migration derivation: synthetic + real test-migrations.mjs agree with disk");

console.log("\n✅ restore-drill logic tests passed");

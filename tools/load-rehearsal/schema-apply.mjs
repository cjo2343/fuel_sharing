// GV-317 load rehearsal — step 1: apply the consolidated schema.
//
//   npm run load:schema -- --env /path/to/rehearsal.env
//
// Pipes supabase-schema.sql (the consolidated fresh-install schema — the single
// source of truth this repo guards) into the THROWAWAY project through a
// dockerized `postgres:17-alpine psql` against the project's SESSION-POOLER
// connection string (env DBURL). Because it applies the whole fresh-install
// schema to an empty Supabase project, this run doubles as a fresh-install
// validation: with ON_ERROR_STOP set, any block that doesn't apply cleanly fails
// the run and prints psql's stderr verbatim.
//
// Run this ONCE per fresh throwaway project — it is NOT idempotent (a second run
// hits "already exists"). To re-run, delete + recreate the project.
//
// GV-494 (exercise-3 finding T5) — the deadlock: the first apply against a
// brand-new project died on SQLSTATE 40P01 (`create trigger … on
// booking_handovers` deadlocking against a Supabase-side AccessShareLock —
// PostgREST re-introspects the schema after every DDL, so its introspection query
// and our DDL take each other's locks in opposite orders). It is a RACE, not a
// schema error: the same file applies cleanly on a settled project. The apply is
// not one transaction, so it leaves the project half-built.
//
// This script now NAMES that failure instead of reporting it as a schema error —
// see the deadlock branch below. Automatic recovery (resetting `public` and
// retrying once) is described in the README as an operator step rather than
// performed here; the toolkit does not issue destructive DDL on its own.
//
// psql 17 matches production (prod runs Postgres 17.x); the schema targets a real
// Supabase project, which already provides the auth/extensions schemas, the
// anon/authenticated/service_role roles and the supabase_realtime publication, so
// no local prelude is needed (unlike the disposable-container replay tools).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, parseArgs } from "./lib/common.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_PATH = path.join(REPO, "supabase-schema.sql");
const IMAGE = "postgres:17-alpine";

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
let env;
try {
  // DBURL is the session-pooler connection string; the prod guard also inspects it.
  env = loadEnv(args.env, ["DBURL"]);
} catch (err) {
  fail(err.message);
}

try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  fail("Docker is not available (daemon not running?). schema-apply needs Docker to host psql.");
}

let sql;
try {
  sql = readFileSync(SCHEMA_PATH);
} catch (err) {
  fail(`Could not read ${SCHEMA_PATH}: ${err.message}`);
}

console.log(`⏳ Applying supabase-schema.sql (${(sql.length / 1024 / 1024).toFixed(1)} MB) to the throwaway project via ${IMAGE}…`);
console.log("   This runs ONCE per fresh project and doubles as a fresh-install validation.");

// --rm: disposable container. -i: read the schema from stdin. ON_ERROR_STOP so a
// bad block aborts instead of silently continuing. The DBURL is passed as the psql
// connection argument (never logged).
const res = spawnSync(
  "docker",
  ["run", "--rm", "-i", IMAGE, "psql", "-v", "ON_ERROR_STOP=1", "-q", env.DBURL, "-f", "-"],
  {
    input: sql,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "inherit", "pipe"],
  },
);

if (res.error) fail(`Failed to launch psql container: ${res.error.message}`);
if (res.status !== 0) {
  console.error("── psql stderr ─────────────────────────────────────────────");
  console.error((res.stderr || "").trim());
  console.error("────────────────────────────────────────────────────────────");
  // GV-494 / T5: a deadlock is a RACE with PostgREST's schema re-introspection, not
  // a broken schema. Saying so is the whole point — reported as a generic failure it
  // reads as "supabase-schema.sql does not apply to a fresh project", which is wrong
  // and is what cost exercise 3 a project recreation.
  if (isDeadlock(res.stderr)) {
    console.error("ℹ️  SQLSTATE 40P01 — this is the PostgREST re-introspection race (finding T5),");
    console.error("   not a schema error: the same file applies cleanly on a settled project.");
    console.error("   The apply is not one transaction, so `public` is now half-built. Recover by");
    console.error("   resetting `public` to stock Supabase (see README step 2, 'If the apply");
    console.error("   deadlocks') or by recreating the project, then run this again.");
  }
  fail(`Schema apply FAILED (psql exit ${res.status}). Fix the error above; the project may be partially applied — recreate it before retrying.`);
}

// Postgres reports a deadlock as SQLSTATE 40P01 / "deadlock detected"; psql prints it
// on stderr. Anything else is a real schema error and means what it says.
function isDeadlock(stderr) {
  return /deadlock detected|40P01/i.test(String(stderr || ""));
}

if (res.stderr && res.stderr.trim()) {
  // psql notices (e.g. NOTICE lines) are informational; surface them but don't fail.
  console.log("ℹ️  psql notices:");
  console.log(res.stderr.trim());
}

console.log("✅ Schema applied cleanly — fresh install validated. Next: npm run load:seed -- --env <file>");

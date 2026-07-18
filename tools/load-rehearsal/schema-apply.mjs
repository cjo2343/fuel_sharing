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
  fail(`Schema apply FAILED (psql exit ${res.status}). Fix the error above; the project may be partially applied — recreate it before retrying.`);
}

if (res.stderr && res.stderr.trim()) {
  // psql notices (e.g. NOTICE lines) are informational; surface them but don't fail.
  console.log("ℹ️  psql notices:");
  console.log(res.stderr.trim());
}

console.log("✅ Schema applied cleanly — fresh install validated. Next: npm run load:seed -- --env <file>");

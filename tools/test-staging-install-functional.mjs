import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDbWithPrelude, removeContainer, startPostgres } from "./lib/replay-container.mjs";
import { buildStagingInstall, STAGING_URL } from "./native-e2e/staging-target.mjs";

// Real Postgres rollback/empty-target tests. No hosted database or credentials.
const repo = fileURLToPath(new URL("../", import.meta.url));
const container = `vehlo-staging-install-${process.pid}`;
function query(db, sql) {
  return spawnSync("docker", [
    "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-f", "-",
  ], { input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function ok(db, sql) {
  const result = query(db, sql);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function emptyDb(db) {
  createDbWithPrelude(container, db);
  ok(db, "create table auth.users(id uuid primary key);");
}
const syntheticSchema = `create table public.fuel_ledger_schema_migrations(migration_id text primary key);
insert into public.fuel_ledger_schema_migrations values ('synthetic');`;

try {
  startPostgres(container, repo);
  emptyDb("guard_tests");
  const broken = query("guard_tests", buildStagingInstall(`${syntheticSchema}\nselect 1/0;`, STAGING_URL));
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /division by zero/);
  assert.equal(ok("guard_tests", "select count(*) from pg_tables where schemaname='public';"), "0", "Failed install must roll back DDL");

  ok("guard_tests", "insert into auth.users values ('10000000-0000-0000-0000-000000000001');");
  const existingUser = query("guard_tests", buildStagingInstall(syntheticSchema, STAGING_URL));
  assert.notEqual(existingUser.status, 0);
  assert.match(existingUser.stderr, /must be an empty staging database/);
  assert.equal(ok("guard_tests", "select count(*) from auth.users;"), "1");

  emptyDb("installed");
  const result = JSON.parse(ok("installed", buildStagingInstall(syntheticSchema, STAGING_URL)));
  assert.equal(result.latest_migration, "synthetic");
  const second = query("installed", buildStagingInstall(syntheticSchema, STAGING_URL));
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /must be an empty staging database/);
  assert.equal(ok("installed", "select count(*) from public.fuel_ledger_schema_migrations;"), "1");

  emptyDb("canonical");
  const source = readFileSync(new URL("../supabase-schema.sql", import.meta.url), "utf8");
  const canonical = JSON.parse(ok("canonical", buildStagingInstall(source, STAGING_URL)).split("\n").at(-1));
  assert.ok(canonical.public_tables > 0);
  assert.ok(canonical.migration_count > 0);
  assert.equal(canonical.auth_users, 0);
  console.log("Guard refusal, rollback, repeat-install refusal and canonical transactional replay passed.");
  console.log(JSON.stringify(canonical));
} finally {
  removeContainer(container);
}

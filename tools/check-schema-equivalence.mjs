#!/usr/bin/env node
// Schema-equivalence verifier (GV-175).
//
// The migration guard (test-migrations.mjs) can only grep: it proves each
// migration's id string APPEARS in supabase-schema.sql, not that the
// consolidated schema actually produces the same database as replaying the
// migrations. Migration 054 shipped a tracker insert against a nonexistent
// column and every grep stayed green — this tool exists so that class of drift
// fails in CI instead of in the Supabase SQL Editor.
//
// What it does:
//   1. Starts a disposable Postgres 15 container (matches Supabase), repo
//      mounted read-only. All psql/pg_dump run INSIDE the container, so the
//      host needs only Docker.
//   2. Applies a Supabase-stub prelude to two fresh databases: roles
//      anon/authenticated/service_role, auth.jwt(), the extensions schema with
//      pgcrypto (Supabase preinstalls it there, which is why migration 001's
//      bare `create extension if not exists pgcrypto` is a no-op in prod), and
//      the supabase_realtime publication.
//   3. Replays supabase/migrations/*.sql in order into one database and
//      supabase-schema.sql into the other, each statement batch under
//      ON_ERROR_STOP.
//   4. pg_dumps both (schema-only, no owners), splits the dumps into
//      per-object blocks on pg_dump's "-- Name: …; Type: …" headers, sorts the
//      blocks (creation order legitimately differs between the two paths), and
//      diffs the sets. Any missing/extra/differing object fails.
//
// Data is intentionally out of scope: schema-only dumps ignore seed rows and
// the migration-tracker rows, so both sides compare purely on structure,
// functions, triggers, policies, grants, and publications.
//
// Usage: node tools/check-schema-equivalence.mjs   (also wired into CI)

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const IMAGE = "postgres:15-alpine";
const CONTAINER = `govehlo-schema-eq-${process.pid}`;
const REPO = process.cwd();
const MIGRATIONS_DIR = "supabase/migrations";
const DB_MIGRATIONS = "migrations_replay";
const DB_SCHEMA = "schema_replay";

const PRELUDE = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
`;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  cleanup();
  process.exit(1);
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function cleanup() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}

function psql(db, extraArgs) {
  const res = spawnSync(
    "docker",
    ["exec", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", db, ...extraArgs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return res;
}

// ── 1. Container ──────────────────────────────────────────────────────────────
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  fail("Docker is not available (daemon not running?). This check needs Docker to host disposable Postgres.");
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

log(`⏳ Starting ${IMAGE} as ${CONTAINER}…`);
docker([
  "run", "-d", "--name", CONTAINER,
  "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
  "-v", `${REPO}:/work:ro`,
  IMAGE,
]);

let ready = false;
for (let i = 0; i < 60; i++) {
  const res = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
  if (res.status === 0) { ready = true; break; }
  execFileSync("sleep", ["1"]);
}
if (!ready) fail("Postgres did not become ready within 60s.");
// pg_isready can flip true between the bootstrap restart; settle briefly.
execFileSync("sleep", ["2"]);

// ── 2. Databases + prelude ───────────────────────────────────────────────────
for (const db of [DB_MIGRATIONS, DB_SCHEMA]) {
  const created = spawnSync("docker", ["exec", CONTAINER, "createdb", "-U", "postgres", db], { encoding: "utf8" });
  if (created.status !== 0) fail(`createdb ${db} failed:\n${created.stderr}`);
  const res = psql(db, ["-c", PRELUDE]);
  if (res.status !== 0) fail(`Prelude failed on ${db}:\n${res.stderr}`);
}
log("✅ Prelude applied (roles, auth.jwt(), extensions.pgcrypto, supabase_realtime).");

// ── 3. Replays ───────────────────────────────────────────────────────────────
const migrations = readdirSync(path.join(REPO, MIGRATIONS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (migrations.length === 0) fail("No migration files found.");

for (const file of migrations) {
  const res = psql(DB_MIGRATIONS, ["-f", `/work/${MIGRATIONS_DIR}/${file}`]);
  if (res.status !== 0) fail(`Migration replay failed at ${file}:\n${res.stderr}`);
}
log(`✅ Replayed ${migrations.length} migrations into ${DB_MIGRATIONS}.`);

{
  const res = psql(DB_SCHEMA, ["-f", "/work/supabase-schema.sql"]);
  if (res.status !== 0) fail(`Consolidated schema replay failed:\n${res.stderr}`);
}
log(`✅ Replayed supabase-schema.sql into ${DB_SCHEMA}.`);

// ── 4. Dump, block-split, normalize, diff ────────────────────────────────────
function dump(db) {
  const res = spawnSync(
    "docker",
    ["exec", CONTAINER, "pg_dump", "-U", "postgres", "--schema-only", "--no-owner", db],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) fail(`pg_dump ${db} failed:\n${res.stderr}`);
  return res.stdout;
}

// Split a pg_dump into { "<Name; Type; Schema>": "<normalized SQL>" } blocks.
// Every dumped object is preceded by a "-- Name: …; Type: …; Schema: …" header,
// which doubles as a stable, order-independent key.
function blocks(dumpText) {
  const map = new Map();
  const parts = dumpText.split(/^-- Name: /m).slice(1);
  for (const part of parts) {
    const headerEnd = part.indexOf("\n");
    const key = part.slice(0, headerEnd).replace(/; Owner: .*$/, "").trim();
    let bodyLines = part
      .slice(headerEnd + 1)
      .split("\n")
      // Comment lines are dump metadata; \restrict/\unrestrict are psql guard
      // tokens (randomized per dump since the Aug 2025 security releases).
      .filter((line) => !line.startsWith("--") && !line.startsWith("\\restrict") && !line.startsWith("\\unrestrict"));
    // Column ORDER inside a table legitimately differs between the two paths:
    // migrations add columns via ALTER (appended attnums) while the consolidated
    // schema declares them inline. Compare tables as sorted line sets — the
    // column DEFINITIONS still must match exactly.
    if (key.includes("; Type: TABLE;")) bodyLines = [...bodyLines].sort();
    const body = bodyLines.join("\n").replace(/\n{2,}/g, "\n").trim();
    // Repeated keys (e.g. an object plus its ACL share a name) — concatenate.
    map.set(key, map.has(key) ? `${map.get(key)}\n${body}` : body);
  }
  return map;
}

const a = blocks(dump(DB_MIGRATIONS));
const b = blocks(dump(DB_SCHEMA));

// The migration-replay side legitimately contains objects the consolidated
// schema must NOT reproduce (none known today — keep the allowlist explicit
// and empty so additions are conscious decisions).
const IGNORE_KEYS = new Set([]);

const problems = [];
for (const [key, bodyA] of a) {
  if (IGNORE_KEYS.has(key)) continue;
  if (!b.has(key)) {
    problems.push(`Only in migrations replay: ${key}`);
  } else if (b.get(key) !== bodyA) {
    problems.push(
      `DIFFERS: ${key}\n  ── migrations replay ──\n${indent(bodyA)}\n  ── consolidated schema ──\n${indent(b.get(key))}`,
    );
  }
}
for (const key of b.keys()) {
  if (!a.has(key) && !IGNORE_KEYS.has(key)) problems.push(`Only in consolidated schema: ${key}`);
}

function indent(s) {
  return s.split("\n").map((l) => `  ${l}`).join("\n");
}

cleanup();

if (problems.length > 0) {
  process.stderr.write(`\n❌ Schema equivalence check failed — ${problems.length} difference(s):\n\n`);
  for (const p of problems) process.stderr.write(`${p}\n\n`);
  process.stderr.write(
    "The consolidated supabase-schema.sql does not reproduce the migrations' end state.\n" +
    "Fix the mirror (usually: append the missing create-or-replace block or align a base definition).\n",
  );
  process.exit(1);
}

log(`\n✅ Schema equivalence verified: ${a.size} objects identical across both replay paths.`);

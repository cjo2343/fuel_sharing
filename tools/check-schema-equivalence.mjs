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
//   1. Starts a disposable Postgres 17 container (matches prod Supabase, which
//      runs 17.x), repo mounted read-only. All psql/pg_dump run INSIDE the
//      container, so the host needs only Docker.
//      (Container + prelude bootstrap is shared with generate-db-types.mjs —
//      see tools/lib/replay-container.mjs.)
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

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { IMAGE, startPostgres, createDbWithPrelude, psql as psqlIn, removeContainer } from "./lib/replay-container.mjs";

const CONTAINER = `govehlo-schema-eq-${process.pid}`;
const REPO = process.cwd();
const MIGRATIONS_DIR = "supabase/migrations";
const DB_MIGRATIONS = "migrations_replay";
const DB_SCHEMA = "schema_replay";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`\n❌ ${msg}\n`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  removeContainer(CONTAINER);
}

function psql(db, extraArgs) {
  return psqlIn(CONTAINER, db, extraArgs);
}

// ── 1. Container ──────────────────────────────────────────────────────────────
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

log(`⏳ Starting ${IMAGE} as ${CONTAINER}…`);
try {
  startPostgres(CONTAINER, REPO);
} catch (err) {
  fail(err.message);
}

// ── 2. Databases + prelude ───────────────────────────────────────────────────
for (const db of [DB_MIGRATIONS, DB_SCHEMA]) {
  try {
    createDbWithPrelude(CONTAINER, db);
  } catch (err) {
    fail(err.message);
  }
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
    // Comment lines are dump metadata; \restrict/\unrestrict are psql guard
    // tokens (randomized per dump since the Aug 2025 security releases).
    //
    // GV-393: this used to drop EVERY line starting with `--`, which would also
    // have eaten an in-body SQL comment sitting in column 0 inside a function body.
    // In-body comments are exactly what this check is supposed to compare — a
    // migration and its supabase-schema.sql mirror must be byte-identical down to
    // the comments (GV-175), and npm run validate does not look at function bodies
    // at all, so this is the only guard that would notice. Latent, not live (no
    // column-0 in-body comment exists today), which is precisely how it would have
    // gone unnoticed the day someone wrote one.
    //
    // So the filter now only applies OUTSIDE a dollar-quoted body. Tracking the
    // dollar tag is more robust than enumerating pg_dump's comment vocabulary: any
    // metadata comment pg_dump invents in a future version is still outside the
    // body, and any comment inside a function body is still compared.
    let dollarTag = null;
    let bodyLines = [];
    for (const line of part.slice(headerEnd + 1).split("\n")) {
      const insideBodyAtLineStart = dollarTag !== null;
      // Toggle on each $tag$ delimiter this line opens or closes.
      for (const m of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g)) {
        if (dollarTag === null) dollarTag = m[0];
        else if (dollarTag === m[0]) dollarTag = null;
      }
      if (
        !insideBodyAtLineStart &&
        (line.startsWith("--") || line.startsWith("\\restrict") || line.startsWith("\\unrestrict"))
      ) {
        continue;
      }
      bodyLines.push(line);
    }
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

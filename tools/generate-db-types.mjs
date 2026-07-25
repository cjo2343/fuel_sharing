#!/usr/bin/env node
// Shared DB/RPC type generator (GV-223, phase 1).
//
// fuel_sharing owns the shared Supabase schema; govehlo-mobile and govehlo-web
// each hand-maintain TypeScript shapes for the same tables and RPC payloads,
// and those shapes drift. This tool generates the canonical types ONCE, here,
// from the schema source of truth — mirroring the design-token contract
// (canonical file in this repo + byte-compare drift guards). The client repos
// vendor types/database.ts byte-identically (phase 2); the umbrella workflow
// compares the copies.
//
// What it does:
//   1. Starts a disposable Postgres 17 container and applies the Supabase-stub
//      prelude (shared bootstrap: tools/lib/replay-container.mjs — the same
//      mechanics check-schema-equivalence.mjs uses). The container's 5432 is
//      published on an ephemeral localhost port so the host-side supabase CLI
//      can reach it.
//   2. Replays supabase-schema.sql (the consolidated schema; CI's
//      schema-equivalence check proves it matches the migrations' end state).
//   3. Runs the EXACT-pinned supabase CLI (devDependency — an unpinned bump
//      would churn the byte-compared artifact):
//        supabase gen types typescript --db-url … --schema public
//   4. Normalizes the output (LF endings, single trailing newline), prepends a
//      provenance header, and writes types/database.ts. Output is
//      deterministic: two consecutive runs are byte-identical.
//
// Usage:
//   npm run gen:db-types     # (re)write types/database.ts
//   npm run check:db-types   # regenerate to a temp path, diff vs committed —
//                            # fails when the committed artifact is stale
//
// Docker-dependent — intentionally NOT part of the dependency-free
// `npm run validate`; CI runs check:db-types in the Docker-backed job family.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { IMAGE, startPostgres, createDbWithPrelude, psql, hostPort, removeContainer } from "./lib/replay-container.mjs";

const CONTAINER = `govehlo-db-types-${process.pid}`;
const REPO = process.cwd();
const DB = "types_replay";
const OUT_FILE = path.join(REPO, "types", "database.ts");
const CHECK_MODE = process.argv.includes("--check");

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

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// ── Provenance inputs (deterministic for a given repo state) ─────────────────
const migrationIds = readdirSync(path.join(REPO, "supabase", "migrations"))
  .filter((f) => /^\d{3}.*\.sql$/.test(f))
  .map((f) => f.slice(0, 3))
  .sort();
if (migrationIds.length === 0) fail("No migration files found in supabase/migrations/.");
const latestMigration = migrationIds[migrationIds.length - 1];

const cliPkgPath = path.join(REPO, "node_modules", "supabase", "package.json");
if (!existsSync(cliPkgPath)) {
  fail("supabase CLI not installed — run `npm ci` first (it is an exact-pinned devDependency).");
}
const cliVersion = JSON.parse(readFileSync(cliPkgPath, "utf8")).version;

const HEADER = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Canonical shared DB/RPC payload types for the GoVehlo Supabase schema (GV-223).
// Regenerate with: npm run gen:db-types   (drift guard: npm run check:db-types)
// Source: supabase-schema.sql @ migration ${latestMigration} · supabase CLI v${cliVersion} (exact-pinned)
// Vendored byte-identically by govehlo-mobile (src/types/database.generated.ts) and
// govehlo-web (types/database.ts); the umbrella workflow compares the copies.
`;

// ── 1. Container + prelude + consolidated-schema replay ─────────────────────
log(`⏳ Starting ${IMAGE} as ${CONTAINER}…`);
try {
  startPostgres(CONTAINER, REPO, { publishPort: true });
  createDbWithPrelude(CONTAINER, DB);
} catch (err) {
  fail(err.message);
}
log("✅ Prelude applied (roles, auth.jwt(), extensions.pgcrypto, supabase_realtime).");

{
  const res = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
  if (res.status !== 0) fail(`Consolidated schema replay failed:\n${res.stderr}`);
}
log(`✅ Replayed supabase-schema.sql into ${DB}.`);

// ── 2. supabase gen types (exact-pinned local CLI) ──────────────────────────
let port;
try {
  port = hostPort(CONTAINER);
} catch (err) {
  fail(err.message);
}

const gen = spawnSync(
  process.execPath,
  [
    path.join(REPO, "node_modules", "supabase", "dist", "supabase.js"),
    "gen", "types", "typescript",
    "--db-url", `postgresql://postgres:postgres@127.0.0.1:${port}/${DB}`,
    "--schema", "public",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (gen.status !== 0) fail(`supabase gen types failed:\n${gen.stderr}`);

cleanup();

// ── 3. Normalize + header ────────────────────────────────────────────────────
// The CLI's output is ordered by catalog name and carries no timestamps; the
// only normalization needed for byte-determinism is line endings and exactly
// one trailing newline.
const body = gen.stdout.replace(/\r\n/g, "\n").trimEnd() + "\n";
const content = `${HEADER}\n${body}`;

// ── 4. Write or check ────────────────────────────────────────────────────────
if (!CHECK_MODE) {
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, content);
  log(`\n✅ Wrote ${path.relative(REPO, OUT_FILE)} (schema @ migration ${latestMigration}, supabase CLI v${cliVersion}).`);
  process.exit(0);
}

const tmpFile = path.join(mkdtempSync(path.join(os.tmpdir(), "govehlo-db-types-")), "database.ts");
writeFileSync(tmpFile, content);

if (!existsSync(OUT_FILE)) {
  process.stderr.write(`\n❌ ${path.relative(REPO, OUT_FILE)} does not exist. Run \`npm run gen:db-types\` and commit it.\n`);
  process.exit(1);
}

const committed = readFileSync(OUT_FILE, "utf8");
if (committed !== content) {
  const diff = spawnSync("diff", ["-u", OUT_FILE, tmpFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const excerpt = (diff.stdout || "").split("\n").slice(0, 60).join("\n");
  process.stderr.write(
    `\n❌ types/database.ts is STALE — it no longer matches the types generated from supabase-schema.sql.\n` +
    `Run \`npm run gen:db-types\` and commit the result.\n\n` +
    `Diff (committed vs freshly generated, first 60 lines):\n${excerpt}\n` +
    `\nFreshly generated copy left at: ${tmpFile}\n`,
  );
  process.exit(1);
}

log(`\n✅ types/database.ts is up to date (schema @ migration ${latestMigration}, supabase CLI v${cliVersion}).`);

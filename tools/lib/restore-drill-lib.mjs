// Pure, testable logic for the GDPR restore drill (GV-325).
//
// restore-drill.mjs orchestrates Docker + psql; the classification, COPY
// row-counting, and expected-migration derivation live here so they can be
// unit-tested without a container (tools/test-restore-drill-logic.mjs).
//
// Three concerns:
//   1. classifyRestoreErrors() — turn restore stderr into classified errors.
//      An explicit allowlist tolerates known Supabase-infra noise; EVERYTHING
//      else (data/COPY failures, missing public objects, disk, and any
//      unrecognised error) is fatal. The allowlist is explicit, not a
//      "looks infra-ish" heuristic — unknown ⇒ fail.
//   2. countCopyRowsFromDump() — stream a plain-SQL dump and count the data
//      rows in each `COPY public.<table> … FROM stdin;` block (the offline,
//      source-of-truth row count). Streams line-by-line so a multi-GB dump is
//      never buffered whole.
//   3. parseExpectedMigrations() — derive the newest expected migration from
//      the hardcoded `expected` array in tools/test-migrations.mjs, the single
//      source of truth (no duplicated constant here).

import { createReadStream, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import path from "node:path";

// ── 1. Error classification ──────────────────────────────────────────────────

// FATAL classes — data / resource failures that are never "infra noise".
// Checked BEFORE the allowlist so a corrupt COPY or constraint violation can
// never be tolerated even if the surrounding SQL touches an infra object.
const FATAL_PATTERNS = [
  ["disk", /no space left on device|could not extend (file|relation)|disk full|out of memory|could not write to (file|block|relation)|could not fsync/i],
  ["copy-data", /invalid input syntax|missing data for column|extra data after last expected column|value too long for type|unterminated csv|out of range for type|invalid byte sequence|character with byte sequence|incorrect binary data|copy failed|copy \w+, line \d+/i],
  ["constraint", /violates (unique|foreign key|check|not-null|exclusion) constraint|null value in column .* violates not-null|duplicate key value/i],
  ["syntax", /syntax error at|unterminated quoted string|unterminated dollar-quoted/i],
];

// ALLOWLIST — Supabase cluster/infra objects a vanilla Postgres lacks. These
// are tolerated (counted + sampled). Each entry is anchored to an explicit
// infra token so it can never match a `public.` object failure.
const ALLOWLIST_PATTERNS = [
  // Cluster roles we do not (and should not) recreate.
  ["role", /\brole\s+"[^"]*"\s+(does not exist|already exists|cannot be dropped|is reserved|is not permitted)/i],
  ["role-privilege", /permission denied to (set|grant|create|drop) role|must be able to set role|must be a member of role|must have (createrole|admin option)/i],
  // ALTER … OWNER TO <infra role>, COMMENT/ALTER requiring ownership.
  ["ownership", /must be (superuser|owner of)|owner to\b/i],
  // pg_net (async HTTP) — schema `net` / extension `pg_net`.
  ["pg_net", /\bpg_net\b|schema "net"|"net"\.|\bnet\.http/i],
  // Event triggers (Supabase installs cluster-level ones).
  ["event-trigger", /event trigger/i],
  // Logical-replication / publication plumbing (publication itself, FOR ALL
  // TABLES, replication slots). A COPY into a published table is already
  // caught above as copy-data, so this only tolerates the plumbing.
  ["publication", /\bpublication\b|for all tables|logical replication|replication slot|wal_level/i],
  // Schemas / extensions Supabase preinstalls that we deliberately do not
  // recreate in the disposable container.
  ["infra-schema", /\b(schema|extension)\s+"?(graphql|graphql_public|pg_graphql|vault|pgsodium|storage|realtime|auth|extensions|supabase_functions|supabase_migrations|cron|pg_cron|net|wrappers|timescaledb|postgis|tiger|topology|pgjwt|http|hypopg|index_advisor|pg_stat_statements|pgaudit|pgtap|pgmq|pg_tle|supautils|pg_net|uuid-ossp|pgcrypto|pgcrypto)"?/i],
  // Errors that name an infra-schema object directly (e.g. relation
  // "storage.objects" does not exist, function extensions.uuid_generate_v4).
  ["infra-object", /\b(graphql|pg_graphql|pgsodium|vault|supabase_functions|supabase_migrations)\b|(?:^|[^.\w])(auth|storage|realtime|extensions|net|cron|vault)\.\w+/i],
  // Privilege errors scoped to an infra target.
  ["infra-privilege", /permission denied\b[^\n]*\b(auth|storage|realtime|graphql|graphql_public|vault|pgsodium|extensions|net|cron|supabase_functions|event trigger|large object)\b/i],
];

// Split restore stderr into logical error records. Each record is the ERROR /
// FATAL / PANIC "reason" line plus any following CONTEXT/DETAIL/Command lines
// (kept for verbatim printing and for spotting COPY-block failures whose reason
// alone is generic).
export function parseStderrToErrorRecords(stderr) {
  const lines = String(stderr || "").split("\n");
  const records = [];
  let cur = null;
  for (const raw of lines) {
    const head = matchErrorHead(raw);
    if (head) {
      cur = { severity: head.severity, reason: head.reason, raw, detail: [] };
      records.push(cur);
      continue;
    }
    if (cur && /^\s*(CONTEXT|DETAIL|HINT|STATEMENT|Command was|LINE \d+|Position):/i.test(raw)) {
      cur.detail.push(raw.trim());
      continue;
    }
    if (cur && /^\s*COPY\s+/i.test(raw)) {
      cur.detail.push(raw.trim());
      cur = null;
      continue;
    }
    cur = null;
  }
  return records;
}

function matchErrorHead(line) {
  if (/errors ignored on restore/i.test(line)) return null; // pg_restore summary, not an error
  const up = line.match(/\b(ERROR|FATAL|PANIC):\s+(.*)$/);
  if (up) return { severity: up[1], reason: up[2].trim() };
  // pg_restore surfaces some failures with a lowercase prefix and no uppercase
  // ERROR: (e.g. "pg_restore: error: could not read from input file: end of
  // file") — those are real and must not be silently dropped.
  const low = line.match(/pg_restore:\s*(?:error|fatal):\s*(.*)$/i);
  if (low) return { severity: "ERROR", reason: low[1].trim() };
  return null;
}

// Classify one error record. Order matters: fatal data/disk/syntax first, then
// the explicit infra allowlist, then a `public.` object failure, then unknown
// (which fails — the allowlist is exhaustive by design).
export function classifyErrorRecord(record) {
  const reason = record.reason || "";
  const detail = (record.detail || []).join("\n");

  for (const [category, re] of FATAL_PATTERNS) {
    if (re.test(reason)) return { category, tolerated: false };
  }
  // A COPY-block failure whose reason line is generic but whose context names
  // the COPY (pg_restore: "COPY failed for table …", or a trailing COPY line).
  if (/^\s*COPY\s+/im.test(detail) || /\bcopy\b/i.test(reason)) {
    return { category: "copy-data", tolerated: false };
  }

  for (const [category, re] of ALLOWLIST_PATTERNS) {
    if (re.test(reason)) return { category, tolerated: true };
  }

  if (/\bpublic\.\w+/i.test(reason)) return { category: "public-object", tolerated: false };

  return { category: "unknown", tolerated: false };
}

export function classifyRestoreErrors(stderr) {
  const records = parseStderrToErrorRecords(stderr);
  const errors = records.map((r) => ({ ...r, ...classifyErrorRecord(r) }));
  const tolerated = errors.filter((e) => e.tolerated);
  const fatal = errors.filter((e) => !e.tolerated);
  const byCategory = {};
  for (const e of errors) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  // Distinct tolerated reasons, for a compact sample in the drill output.
  const distinctTolerated = [...new Set(tolerated.map((e) => e.reason))];
  return {
    errors,
    tolerated,
    fatal,
    toleratedCount: tolerated.length,
    fatalCount: fatal.length,
    byCategory,
    distinctTolerated,
  };
}

// ── 2. COPY row counting (offline, streamed) ─────────────────────────────────

// Stateful line processor shared by the string and stream front-ends. Counts
// data rows in `COPY public.<table> … FROM stdin;` blocks up to the terminating
// `\.`. Non-public COPY blocks are skipped (their rows are not counted). A data
// line equal to `\.` is the only terminator — embedded backslash escapes inside
// data (\t, \N, \\) are ordinary data and never end the block.
function makeCopyCounter() {
  const counts = new Map();
  let table = null; // public table currently being counted
  let skipping = false; // inside a non-public COPY block

  function feed(rawLine) {
    const line = rawLine.replace(/\r$/, "");
    if (table !== null || skipping) {
      if (line === "\\.") {
        table = null;
        skipping = false;
        return;
      }
      if (table !== null) counts.set(table, counts.get(table) + 1);
      return;
    }
    const m = line.match(
      /^COPY\s+(?:("?)([\w$]+)\1\.)?("?)([\w$]+)\3\s*(?:\([^)]*\))?\s+FROM\s+stdin/i,
    );
    if (!m) return;
    const schema = (m[2] || "public").toLowerCase();
    const name = m[4];
    if (schema === "public") {
      table = name;
      if (!counts.has(name)) counts.set(name, 0);
    } else {
      skipping = true;
    }
  }

  return { feed, counts };
}

// Count COPY rows from an in-memory SQL string (convenient for tests).
export function countCopyRowsFromString(sql) {
  const counter = makeCopyCounter();
  for (const line of String(sql).split("\n")) counter.feed(line);
  return counter.counts;
}

// Count COPY rows from a Readable stream of decompressed SQL text. Streamed
// line-by-line via readline — never buffers the whole dump.
export async function countCopyRowsFromStream(readable) {
  const counter = makeCopyCounter();
  const rl = createInterface({ input: readable, crlfDelay: Infinity });
  for await (const line of rl) counter.feed(line);
  return counter.counts;
}

function fileLooksGzipped(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, 0);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

// Count COPY rows from a plain-SQL dump file, transparently gunzipping .sql.gz.
// `gzip` overrides magic-byte auto-detection when the caller already knows.
export async function countCopyRowsFromDump(filePath, { gzip } = {}) {
  const isGz = gzip === undefined ? fileLooksGzipped(filePath) : gzip;
  let input = createReadStream(filePath);
  if (isGz) input = input.pipe(createGunzip());
  return countCopyRowsFromStream(input);
}

// ── 3. Expected-migration derivation ─────────────────────────────────────────

// Parse the hardcoded `expected = [ … ]` array out of tools/test-migrations.mjs
// source text. That array is the single source of truth for the migration set;
// we read it rather than duplicate a "latest migration" constant.
export function parseExpectedMigrations(sourceText) {
  const src = String(sourceText);
  const start = src.indexOf("const expected = [");
  if (start === -1) throw new Error("could not find `const expected = [` in test-migrations.mjs");
  const end = src.indexOf("];", start);
  if (end === -1) throw new Error("unterminated `expected` array in test-migrations.mjs");
  const block = src.slice(start, end);
  const files = [...block.matchAll(/["'`](\d{3}_[^"'`]+\.sql)["'`]/g)].map((m) => m[1]);
  if (files.length === 0) throw new Error("no migration filenames found in the `expected` array");

  // The array is ordered, but derive the max numerically to be defensive.
  let latest = files[0];
  let latestNumber = migrationNumber(files[0]);
  for (const f of files) {
    const n = migrationNumber(f);
    if (n > latestNumber) {
      latestNumber = n;
      latest = f;
    }
  }
  return {
    files,
    latest,
    latestId: latest.replace(/\.sql$/, ""),
    latestNumber,
  };
}

export function migrationNumber(fileOrId) {
  const m = String(fileOrId).match(/^(\d+)/);
  return m ? Number(m[1]) : NaN;
}

// Read + parse tools/test-migrations.mjs from a repo root.
export function readExpectedMigrations(repoRoot) {
  const src = readFileSync(path.join(repoRoot, "tools", "test-migrations.mjs"), "utf8");
  return parseExpectedMigrations(src);
}

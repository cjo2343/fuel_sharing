// A heuristic lint for the concurrency/idempotency class of bug that migrations
// 169→171, 172→174 and 179→181 each shipped and then had to harden (GV-454).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — three shipped-then-hardened cycles the structural guards missed
// ---------------------------------------------------------------------------
// The ~28 guards in this repo are all STRUCTURAL — schema equivalence, the role
// matrix, the ambiguity scan, event classification. None of them can see a race or a
// non-idempotent write, because the SQL is individually well-formed; the defect is in
// what happens when two transactions, or one retried scheduler tick, run it at once.
// Three times the hole reached prod and was caught only by a LATER human review:
//
//   • 169→171  attach/detach_fuel_payment_receipt did read-decide-write with no lock;
//              two concurrent first-attaches orphan a storage object. Fixed by taking
//              `for update` on the lock-root row FIRST (migration 171).
//   • 172→174  the handover location mirror was select (no lock) → compare → separate
//              update; a stale offline write overwrote a newer location and stamped it
//              "confirmed now". Fixed by folding the staleness test into ONE conditional
//              UPDATE whose where-clause the row re-evaluates under lock (migration 174).
//   • 179→181  the newsletter send-job had an additive, non-idempotent `advance_` (an
//              at-least-once retry double-counts) and a check-then-insert single-active
//              guard with NO backing unique constraint (the whole list could be mailed
//              twice). Fixed by a partial unique index + a unique_violation handler, and
//              by guarding the additive UPDATE on a strictly-advancing cursor + status
//              (migration 181).
//
// A full concurrency analysis is beyond a static scan. This guard deliberately flags
// only the clearest, highest-signal shapes from that history — the ones a regex can
// recognise with few false positives — and is calibrated so the current tree is CLEAN.
//
//   • 177/178  the fuel-receipts / incident-photos upload quotas were enforced as a
//              `(select count(*) …) < <limit>` sub-select inside the Storage INSERT RLS
//              policy's WITH CHECK — a check-then-insert TOCTOU in a POLICY rather than a
//              function body, so the original scan (which only ever read function bodies)
//              never saw it. Fixed by a BEFORE INSERT trigger that serialises the racing
//              inserts on an advisory lock and re-counts under it (migration 184, GV-458).
//
// ---------------------------------------------------------------------------
// THE PATTERNS
// ---------------------------------------------------------------------------
// PATTERN A — check-then-insert without a backing unique key. A function body with
//   `if exists (select ... from T where ...) then ... raise|return ... end if;`
//   FOLLOWED by `insert into T ...` on the same table T, where the migration set does
//   NOT create a unique index / unique constraint / natural primary key on T that would
//   make the race safe. This is 179's create_newsletter_send_job. A plain surrogate
//   primary key on an auto-generated id (`id uuid ... default gen_random_uuid()`) does
//   NOT count — each insert gets a fresh id and never collides, so it guards nothing
//   about the semantic invariant the exists-check tests. What makes it safe is a PARTIAL
//   unique index on the condition (181's `... ((true)) where status in (...)`) or a
//   unique key on a SUPPLIED column. So with 181 present, newsletter_send_jobs passes.
//
// PATTERN B — additive counter UPDATE with no guard. `update T set c = c + <expr>`
//   (or `c = T.c + ...`) whose WHERE keys ONLY on a bare `id = <param>` — no status,
//   cursor, version or is-null predicate, and no `case when` guard on the SET. That is
//   179's pre-181 `advance_`: additive and unguarded, so an at-least-once retry
//   double-counts. 181 guards it (status in (...) in the WHERE, and a strictly-advancing
//   cursor test as a `case when` on the SET), so it passes. Claim-lease reminders,
//   `*_sent_at is null` one-shots and cursor guards all carry an extra WHERE predicate,
//   so they pass too.
//
// PATTERN C — check-then-insert quota inside an RLS policy. A `create policy … with
//   check (…)` (or `using (…)`) whose predicate contains a `(select count(*) … ) <
//   <limit>` sub-select. That is a per-row cap enforced by counting sibling rows at
//   INSERT time, and it has the SAME race as Pattern A: N concurrent inserts each
//   evaluate the count against the same pre-insert state, all read a value below the
//   limit, and all pass, so the cap is bypassable. This is 177/178's storage upload
//   quota. Patterns A and B scan FUNCTION bodies; a policy predicate is neither, which is
//   exactly why the original guard missed this class (GV-458). What makes it safe is
//   serialising the racing inserts and re-counting under a lock — 184's BEFORE INSERT
//   trigger on storage.objects (advisory lock + re-count) — after which the policy's own
//   count(*) is retained only as best-effort defence-in-depth and goes in
//   REVIEWED_EXCEPTIONS with the trigger as justification.
//
// ---------------------------------------------------------------------------
// SCANNING NOTES — deliberate limits, biased toward FEW false positives
// ---------------------------------------------------------------------------
//   • Only the LATEST definition of each function is scanned (keyed by name + arity,
//     last migration wins). "Last definition wins" is exactly how the schema replays, so
//     a function that was buggy in 179 and fixed in 181 is judged by 181's body — which
//     is why the tree is clean. It also gives the guard the right lifecycle: a new buggy
//     migration is flagged on the PR that adds it, and clears when a later migration
//     re-declares the function safely.
//   • This scans supabase/migrations/*.sql only (the source of truth). The consolidated
//     schema mirror is enforced separately by check:schema-equivalence.
//   • Like the other hand-written SQL scanners here (GV-393/GV-413), this scrapes SQL
//     rather than parsing it. When in doubt it does NOT flag — a noisy guard gets
//     disabled, and it is better to catch the two proven shapes reliably than to reach.
//   • A legitimate case a structural scan cannot distinguish goes in REVIEWED_EXCEPTIONS
//     with a justification, NOT by weakening a pattern. It holds redeem_ledger_invite
//     (Pattern B, a genuine per-join increment under a row lock) and the two 177/178
//     upload-quota policies (Pattern C, made race-free by migration 184's trigger).
//
// The scan is dependency-free and needs no Docker, so it runs in `npm run validate`. It
// embeds its own self-test (synthetic fixtures + the real 181 functions + the 177/178
// policies) which runs first; a broken scanner reports as a broken scanner, not as a
// clean tree.
//
//   node tools/check-concurrency-hazards.mjs              # self-test, then scan the tree
//   node tools/check-concurrency-hazards.mjs --self-test  # self-test only

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

// Legitimate check-then-insert or additive-update shapes that a static scan cannot tell
// apart from the hazardous ones. Each entry is { fn, table, pattern, why }. A structural
// scanner cannot see a `for update` lock taken in an EARLIER statement, nor a bounding
// predicate on the row being incremented, so a genuinely-safe additive update whose safety
// rests on those is allow-listed here rather than by weakening Pattern B.
export const REVIEWED_EXCEPTIONS = [
  {
    fn: "redeem_ledger_invite",
    table: "ledger_invites",
    pattern: "B",
    why:
      "The invite row is SELECT … FOR UPDATE'd with a `uses_count < max_uses` predicate several " +
      "statements before the `uses_count = uses_count + 1` increment, so concurrent redemptions " +
      "serialise on that row lock and cannot over-consume a one-time invite. Each +1 is a distinct " +
      "member joining, not an at-least-once retry of one logical write — the 179 hazard does not apply.",
  },
  {
    policy: "Fuel receipts are writable by workspace members",
    table: "storage.objects",
    pattern: "C",
    why:
      "The `(select count(*) …) < 3` quota in this INSERT policy (migration 177) is no longer the " +
      "authoritative cap: migration 184 adds a BEFORE INSERT trigger on storage.objects " +
      "(enforce_storage_upload_quota) that takes pg_advisory_xact_lock on the (bucket, <ledger>/" +
      "<entity>) prefix and re-counts under it, so racing uploads serialise and the cap is race-free. " +
      "The policy's count(*) is kept only as best-effort defence-in-depth (a cheap early rejection); " +
      "the trigger is what makes it a hard limit.",
  },
  {
    policy: "Incident photos are writable by workspace members",
    table: "storage.objects",
    pattern: "C",
    why:
      "The `(select count(*) …) < 10` quota in this INSERT policy (migration 178) is no longer the " +
      "authoritative cap: migration 184's BEFORE INSERT trigger on storage.objects " +
      "(enforce_storage_upload_quota) serialises racing uploads for the same (bucket, <ledger>/" +
      "<entity>) prefix on an advisory lock and re-counts under it, closing the check-then-insert " +
      "window. The policy's count(*) is retained only as best-effort defence-in-depth.",
  },
];

export class HazardScanError extends Error {}

// ── SQL text helpers ─────────────────────────────────────────────────────────

// Drop `-- …` and `/* … */` comments outside string literals. The migration headers are
// full of the words this scanner keys on ("check-then-insert", "insert into", "update"),
// so comments must go first. Newlines are preserved so offsets stay meaningful.
export function stripSqlComments(sql) {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

// Index of the `)` that closes the `(` at `open`, string-aware.
export function matchParen(text, open) {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split on commas that are not inside parens or string literals.
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      current += c;
      if (c === "'") {
        if (text[i + 1] === "'") current += text[++i];
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      current += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current.trim());
  return parts;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const bareTable = (raw) => raw.replace(/^public\./i, "").toLowerCase();

// ── Function extraction ──────────────────────────────────────────────────────

// Every `create [or replace] function` in a (comment-stripped) SQL string, with its
// dollar-quoted body. Fails loudly if a function's body cannot be located rather than
// silently certifying nothing.
export function extractFunctions(cleanSql, label = "<sql>") {
  const out = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][\w]*)\s*\(/gi;
  let m;
  while ((m = re.exec(cleanSql))) {
    const name = m[1].toLowerCase();
    const argOpen = m.index + m[0].length - 1; // the '(' itself
    const argClose = matchParen(cleanSql, argOpen);
    if (argClose === -1) throw new HazardScanError(`${label}: unterminated argument list for function ${name}`);
    const argText = cleanSql.slice(argOpen + 1, argClose).trim();
    const argCount = argText === "" ? 0 : splitTopLevel(argText).length;

    // The body opens at the first dollar-quote after `as`; find the matching close tag.
    const after = cleanSql.slice(argClose + 1);
    const asMatch = after.match(/\bas\s*(\$[A-Za-z0-9_]*\$)/i);
    if (!asMatch) {
      // Not a plpgsql/sql body we can read (e.g. `language c`); skip — nothing to scan.
      continue;
    }
    const tag = asMatch[1];
    const bodyStart = argClose + 1 + asMatch.index + asMatch[0].length;
    const bodyEnd = cleanSql.indexOf(tag, bodyStart);
    if (bodyEnd === -1) throw new HazardScanError(`${label}: unterminated body (${tag}) for function ${name}`);
    out.push({ name, argCount, body: cleanSql.slice(bodyStart, bodyEnd), label, index: m.index });
  }
  return out;
}

// Every `drop function [if exists] name(argtypes)` in a SQL string, with its position.
// A parenless `drop function name` drops every overload of that name.
export function extractDrops(cleanSql) {
  const out = [];
  const re = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][\w]*)\s*(\(([^)]*)\))?/gi;
  let m;
  while ((m = re.exec(cleanSql))) {
    const name = m[1].toLowerCase();
    if (m[2] === undefined) {
      out.push({ name, argCount: null, index: m.index }); // all arities
    } else {
      const argText = m[3].trim();
      out.push({ name, argCount: argText === "" ? 0 : splitTopLevel(argText).length, index: m.index });
    }
  }
  return out;
}

// Keep only the LATEST live definition of each function (name + arity). Creates and drops
// are applied in positional order across the sorted migration stream, so a function a
// later migration DROPs and does not re-create is not scanned — its old body is dead code
// (e.g. redeem_ledger_invite's 1-arg overload, dropped by migration 132).
export function latestFunctions(sources) {
  const byKey = new Map();
  for (const { label, cleanSql } of sources) {
    const events = [];
    for (const fn of extractFunctions(cleanSql, label)) events.push({ kind: "create", fn, index: fn.index });
    for (const d of extractDrops(cleanSql)) events.push({ kind: "drop", drop: d, index: d.index });
    events.sort((a, b) => a.index - b.index);
    for (const ev of events) {
      if (ev.kind === "create") {
        byKey.set(`${ev.fn.name}#${ev.fn.argCount}`, ev.fn);
      } else if (ev.drop.argCount === null) {
        for (const k of [...byKey.keys()]) if (k.startsWith(`${ev.drop.name}#`)) byKey.delete(k);
      } else {
        byKey.delete(`${ev.drop.name}#${ev.drop.argCount}`);
      }
    }
  }
  return [...byKey.values()];
}

// ── Unique-key harvesting (global, across the whole migration set) ────────────

// Returns a Map<table, { hasSafe: boolean }>. `hasSafe` is true when the table has a
// unique key that would make a check-then-insert race safe: a PARTIAL unique index, or a
// unique/primary key whose column list includes at least one SUPPLIED (non-auto) column.
// A lone surrogate PK on an auto-generated id is NOT safe.
export function harvestProtectedTables(cleanSqls) {
  const autoCols = new Map(); // table -> Set(colName)
  const uniqueKeys = []; // { table, partial, cols: [colName] }

  const addAuto = (table, col) => {
    if (!autoCols.has(table)) autoCols.set(table, new Set());
    autoCols.get(table).add(col.toLowerCase());
  };
  const isAutoDefault = (line) =>
    /\bdefault\b[^,]*\b(?:gen_random_uuid|uuid_generate_v\d|nextval)\b/i.test(line) ||
    /\bgenerated\b[^,]*\bidentity\b/i.test(line) ||
    /\b(?:big)?serial\b/i.test(line);

  for (const sql of cleanSqls) {
    // create table … ( … )
    const tableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][\w]*)\s*\(/gi;
    let tm;
    while ((tm = tableRe.exec(sql))) {
      const table = tm[1].toLowerCase();
      const open = tm.index + tm[0].length - 1;
      const close = matchParen(sql, open);
      if (close === -1) continue;
      const parts = splitTopLevel(sql.slice(open + 1, close));
      for (const partRaw of parts) {
        const part = partRaw.trim();
        const low = part.toLowerCase();
        // table-level constraints
        const pk = low.match(/^(?:constraint\s+[\w]+\s+)?primary\s+key\s*\(([^)]*)\)/i);
        const uq = low.match(/^(?:constraint\s+[\w]+\s+)?unique\s*\(([^)]*)\)/i);
        if (pk) {
          uniqueKeys.push({ table, partial: false, cols: pk[1].split(",").map((c) => c.trim().toLowerCase()) });
          continue;
        }
        if (uq) {
          uniqueKeys.push({ table, partial: false, cols: uq[1].split(",").map((c) => c.trim().toLowerCase()) });
          continue;
        }
        if (/^(?:constraint|check|foreign\s+key|like|exclude)\b/i.test(low)) continue;
        // column definition
        const colName = part.match(/^([a-z_][\w]*)/i);
        if (!colName) continue;
        const col = colName[1].toLowerCase();
        if (isAutoDefault(part)) addAuto(table, col);
        if (/\bprimary\s+key\b/i.test(low)) uniqueKeys.push({ table, partial: false, cols: [col] });
        else if (/(?:^|\s)unique(?:\s|$)/i.test(low)) uniqueKeys.push({ table, partial: false, cols: [col] });
      }
    }

    // create unique index … on T ( … ) [where …]
    const idxRe = /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?[\w]+\s+on\s+(?:public\.)?([a-z_][\w]*)\s*\(/gi;
    let im;
    while ((im = idxRe.exec(sql))) {
      const table = im[1].toLowerCase();
      const open = im.index + im[0].length - 1;
      const close = matchParen(sql, open);
      if (close === -1) continue;
      const cols = splitTopLevel(sql.slice(open + 1, close)).map((c) => c.trim().toLowerCase());
      const tail = sql.slice(close + 1, close + 200);
      const partial = /^\s*where\b/i.test(tail);
      uniqueKeys.push({ table, partial, cols });
    }

    // alter table T add [constraint …] (unique|primary key) ( … )
    const alterRe =
      /alter\s+table\s+(?:only\s+)?(?:public\.)?([a-z_][\w]*)\s+add\s+(?:constraint\s+[\w]+\s+)?(unique|primary\s+key)\s*\(([^)]*)\)/gi;
    let am;
    while ((am = alterRe.exec(sql))) {
      uniqueKeys.push({
        table: am[1].toLowerCase(),
        partial: false,
        cols: am[3].split(",").map((c) => c.trim().toLowerCase()),
      });
    }
  }

  const protectedTables = new Map();
  const mark = (t, safe) => {
    const cur = protectedTables.get(t);
    protectedTables.set(t, { hasSafe: (cur?.hasSafe ?? false) || safe });
  };
  for (const key of uniqueKeys) {
    const auto = autoCols.get(key.table) ?? new Set();
    const safe = key.partial || key.cols.some((c) => c && !auto.has(c) && !/^\(/.test(c));
    mark(key.table, safe);
  }
  return protectedTables;
}

// ── Pattern A: check-then-insert without a backing unique key ─────────────────

export function findPatternA(fn, protectedTables) {
  const body = fn.body;
  const hits = [];
  const re = /\bif\s+exists\s*\(/gi;
  let m;
  while ((m = re.exec(body))) {
    const open = m.index + m[0].length - 1; // the '(' after exists
    const close = matchParen(body, open);
    if (close === -1) continue;
    const sub = body.slice(open + 1, close);
    const from = sub.match(/\bfrom\s+(?:public\.)?([a-z_][\w]*)/i);
    if (!from) continue;
    const table = from[1].toLowerCase();

    // then-branch must short-circuit (raise or return) — that is the guard shape.
    const afterClose = body.slice(close + 1);
    const thenM = afterClose.match(/^\s*then\b/i);
    if (!thenM) continue;
    const endIf = afterClose.search(/\bend\s+if\b/i);
    const thenBranch = endIf === -1 ? afterClose : afterClose.slice(0, endIf);
    if (!/\braise\b|\breturn\b/i.test(thenBranch)) continue;

    // followed by insert into the SAME table.
    const rest = body.slice(close + 1);
    const insertRe = new RegExp(`\\binsert\\s+into\\s+(?:public\\.)?${table}\\b`, "i");
    if (!insertRe.test(rest)) continue;

    const safe = protectedTables.get(table)?.hasSafe ?? false;
    if (safe) continue;
    if (REVIEWED_EXCEPTIONS.some((e) => e.fn === fn.name && e.table === table && e.pattern === "A")) continue;

    hits.push({ table });
  }
  return hits;
}

// ── Pattern B: additive counter UPDATE with no guard ──────────────────────────

// Isolate each `update <T> [alias] set … [where …] [returning …];` in a body.
export function extractUpdates(body) {
  const updates = [];
  const re = /\bupdate\s+(?:only\s+)?(?:public\.)?([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?\s+set\b/gi;
  let m;
  while ((m = re.exec(body))) {
    const table = m[1].toLowerCase();
    const alias = m[2] ? m[2].toLowerCase() : null;
    // The keyword after SET that ends the statement is `;` at top level.
    let depth = 0;
    let inString = false;
    let end = body.length;
    for (let i = m.index + m[0].length; i < body.length; i++) {
      const c = body[i];
      if (inString) {
        if (c === "'") {
          if (body[i + 1] === "'") i++;
          else inString = false;
        }
        continue;
      }
      if (c === "'") {
        inString = true;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    const stmt = body.slice(m.index + m[0].length, end);
    // Split off WHERE and RETURNING at top level.
    const whereIdx = topLevelKeyword(stmt, "where");
    const retIdx = topLevelKeyword(stmt, "returning");
    let setEnd = stmt.length;
    if (whereIdx !== -1) setEnd = whereIdx;
    else if (retIdx !== -1) setEnd = retIdx;
    const setClause = stmt.slice(0, setEnd);
    let whereClause = "";
    if (whereIdx !== -1) {
      const wEnd = retIdx !== -1 && retIdx > whereIdx ? retIdx : stmt.length;
      whereClause = stmt.slice(whereIdx + "where".length, wEnd);
    }
    updates.push({ table, alias, setClause, whereClause });
  }
  return updates;
}

// Index of a top-level (paren depth 0, outside strings) keyword occurrence, or -1.
function topLevelKeyword(text, keyword) {
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  let depth = 0;
  let inString = false;
  const opens = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    opens[i] = depth;
  }
  let m;
  while ((m = re.exec(text))) {
    if ((opens[m.index] ?? 0) === 0) return m.index;
  }
  return -1;
}

// A WHERE that keys ONLY on a bare id equality — `id = x` or `alias.id = x`, nothing
// else. Any extra predicate (status, cursor, is null, another AND) makes it guarded.
export function whereIsOnlyIdEquality(whereClause) {
  const w = norm(whereClause).replace(/^\(+|\)+$/g, "").trim();
  if (!w) return false;
  if (/\b(and|or)\b/i.test(w)) return false;
  if (/\bis\s+(?:not\s+)?null\b/i.test(w)) return false;
  return /^(?:[a-z_][\w]*\.)?id\s*=\s*\S+$/i.test(w);
}

export function findPatternB(fn) {
  const hits = [];
  for (const upd of extractUpdates(fn.body)) {
    const assignments = splitTopLevel(upd.setClause);
    for (const a of assignments) {
      const eq = a.indexOf("=");
      if (eq === -1) continue;
      const lhs = a.slice(0, eq).trim().toLowerCase();
      const rhs = a.slice(eq + 1);
      // additive: <col> = [alias.]<col> + …
      const add = new RegExp(`^${lhs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?:[a-z_][\\w]*\\.)?${lhs.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      )}\\s*\\+`, "i");
      if (!add.test(norm(a))) continue;
      // guarded by a case-when on the SET → safe (181's shape).
      if (/\bcase\s+when\b/i.test(rhs)) continue;
      // guarded by an extra WHERE predicate (status / cursor / is null / version) → safe.
      if (!whereIsOnlyIdEquality(upd.whereClause)) continue;
      if (REVIEWED_EXCEPTIONS.some((e) => e.fn === fn.name && e.table === upd.table && e.pattern === "B")) continue;
      hits.push({ table: upd.table, column: lhs });
    }
  }
  return hits;
}

// ── Pattern C: check-then-insert quota inside an RLS policy ────────────────────

// Every `create policy "<name>" on <table> …;` in a (comment-stripped) SQL string, with
// the full statement text up to its terminating top-level `;`. Patterns A/B read function
// bodies; a policy predicate lives in neither, so it needs its own extractor (GV-458).
export function extractPolicies(cleanSql, label = "<sql>") {
  const out = [];
  const re = /create\s+policy\s+"([^"]+)"\s+on\s+(?:public\.)?([a-z_][\w.]*)/gi;
  let m;
  while ((m = re.exec(cleanSql))) {
    const name = m[1];
    const table = m[2].toLowerCase();
    // The statement runs to the next top-level `;` (paren- and string-aware).
    let depth = 0;
    let inString = false;
    let end = cleanSql.length;
    for (let i = m.index + m[0].length; i < cleanSql.length; i++) {
      const c = cleanSql[i];
      if (inString) {
        if (c === "'") {
          if (cleanSql[i + 1] === "'") i++;
          else inString = false;
        }
        continue;
      }
      if (c === "'") {
        inString = true;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    out.push({ name, table, stmt: cleanSql.slice(m.index, end), label, index: m.index });
  }
  return out;
}

// A policy whose predicate counts sibling rows and compares to a numeric limit —
// `(select count(*) … ) < <int>` (or `<=`) — inside a WITH CHECK / USING expression.
// That is the storage upload quota's TOCTOU: every racing insert reads the same
// pre-insert count and passes. Kept deliberately narrow (count(*) AND a `) < <int>`
// comparison AND a policy predicate keyword) so an ordinary policy never trips it.
export function findPatternC(policies) {
  const hits = [];
  for (const p of policies) {
    const s = norm(p.stmt);
    if (!/\bcount\s*\(\s*\*\s*\)/i.test(s)) continue;
    if (!/\)\s*<\s*=?\s*\d+/.test(s)) continue;
    if (!/\b(?:with\s+check|using)\b/i.test(s)) continue;
    hits.push({ policy: p.name, table: p.table, label: p.label });
  }
  return hits;
}

// ── Scan a whole tree ─────────────────────────────────────────────────────────

export function scanSources(sources) {
  const cleanSources = sources.map(({ label, sql }) => ({ label, cleanSql: stripSqlComments(sql) }));
  const protectedTables = harvestProtectedTables(cleanSources.map((s) => s.cleanSql));
  const fns = latestFunctions(cleanSources);
  const policies = cleanSources.flatMap((s) => extractPolicies(s.cleanSql, s.label));

  const findings = [];
  for (const fn of fns) {
    for (const a of findPatternA(fn, protectedTables)) {
      findings.push({ pattern: "A", fn: fn.name, label: fn.label, table: a.table });
    }
    for (const b of findPatternB(fn)) {
      findings.push({ pattern: "B", fn: fn.name, label: fn.label, table: b.table, column: b.column });
    }
  }
  for (const c of findPatternC(policies)) {
    if (REVIEWED_EXCEPTIONS.some((e) => e.pattern === "C" && e.policy === c.policy && e.table === c.table)) continue;
    findings.push({ pattern: "C", policy: c.policy, label: c.label, table: c.table });
  }
  return findings;
}

function migrationSources() {
  if (!existsSync(MIGRATIONS_DIR)) throw new HazardScanError(`no migrations directory at ${MIGRATIONS_DIR}`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (!files.length) throw new HazardScanError(`no migrations found in ${MIGRATIONS_DIR} — the scan would certify nothing`);
  return files.map((f) => ({ label: relative(ROOT, join(MIGRATIONS_DIR, f)), sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
}

function describe(f) {
  if (f.pattern === "A") {
    return (
      `PATTERN A (check-then-insert, no backing unique key) in ${f.fn}() [${f.label}]:\n` +
      `      an \`if exists (select … from ${f.table} …) then raise|return\` guard is followed by an\n` +
      `      \`insert into ${f.table}\`, but no unique index/constraint on ${f.table} makes that race safe.\n` +
      `      Two concurrent calls both pass the check and both insert. FIX (see migration 181,\n` +
      `      create_newsletter_send_job): add a unique index enforcing the invariant — a PARTIAL\n` +
      `      unique index on the tested condition, e.g. \`create unique index … on ${f.table} ((true))\n` +
      `      where <the exists condition>\` — and wrap the INSERT to catch unique_violation and\n` +
      `      re-raise the same error the check does.`
    );
  }
  if (f.pattern === "C") {
    return (
      `PATTERN C (check-then-insert quota inside an RLS policy) in policy "${f.policy}" on ${f.table} [${f.label}]:\n` +
      `      the policy predicate caps rows with a \`(select count(*) … ) < <limit>\` sub-select, so N\n` +
      `      concurrent inserts each read the same pre-insert count and all pass — the quota is\n` +
      `      bypassable. A policy is neither a function body nor lock-serialisable, so the count cannot\n` +
      `      be made atomic in the policy itself. FIX (see migration 184, enforce_storage_upload_quota):\n` +
      `      add a BEFORE INSERT trigger that takes pg_advisory_xact_lock on the counted prefix and\n` +
      `      re-counts under it, then register this policy in REVIEWED_EXCEPTIONS (pattern "C") with the\n` +
      `      trigger as justification — keeping the policy count only as best-effort defence-in-depth.`
    );
  }
  return (
    `PATTERN B (unguarded additive UPDATE) in ${f.fn}() [${f.label}]:\n` +
    `      \`update ${f.table} set ${f.column} = ${f.column} + …\` keyed only on \`id = …\`, with no\n` +
    `      status/cursor/version/is-null guard in the WHERE and no \`case when\` guard on the SET.\n` +
    `      An at-least-once retry (a re-driven scheduler tick, a re-claimed lease) double-counts.\n` +
    `      FIX (see migration 181, advance_newsletter_send_job): make the add conditional on the\n` +
    `      batch being NEW — a strictly-advancing cursor test as a \`case when … then <delta> else 0\n` +
    `      end\` on the SET — and/or add a status predicate (\`and status in (…)\`) to the WHERE, so a\n` +
    `      replayed write adds nothing.`
  );
}

// ── Self-test ─────────────────────────────────────────────────────────────────

export function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-test failed: ${msg}`);
  };

  // Fixture 1: raw check-then-insert on a table with only an auto surrogate PK → FLAG.
  const rawCheckInsert = {
    label: "fixture:raw-check-insert",
    sql: `
      create table public.jobs (
        id uuid primary key default gen_random_uuid(),
        status text not null
      );
      create or replace function public.start_job() returns uuid language plpgsql as $$
      begin
        if exists (select 1 from public.jobs j where j.status in ('pending','sending')) then
          raise exception 'already running';
        end if;
        insert into public.jobs (status) values ('pending') returning id;
      end;
      $$;`,
  };
  // Fixture 2: same, but a PARTIAL unique index backs the invariant → PASS.
  const backedCheckInsert = {
    label: "fixture:backed-check-insert",
    sql: `
      create table public.jobs (
        id uuid primary key default gen_random_uuid(),
        status text not null
      );
      create unique index jobs_single_active on public.jobs ((true)) where status in ('pending','sending');
      create or replace function public.start_job() returns uuid language plpgsql as $$
      begin
        if exists (select 1 from public.jobs j where j.status in ('pending','sending')) then
          raise exception 'already running';
        end if;
        insert into public.jobs (status) values ('pending') returning id;
      end;
      $$;`,
  };
  // Fixture 3: unguarded additive update keyed only on id → FLAG.
  const rawAdditive = {
    label: "fixture:raw-additive",
    sql: `
      create or replace function public.bump(p_id uuid, p_n integer) returns void language plpgsql as $$
      begin
        update public.jobs j set sent_count = j.sent_count + coalesce(p_n, 0), updated_at = now()
        where j.id = p_id;
      end;
      $$;`,
  };
  // Fixture 4a: additive guarded by a status predicate in WHERE → PASS.
  const guardedByWhere = {
    label: "fixture:guarded-where",
    sql: `
      create or replace function public.bump(p_id uuid, p_n integer) returns void language plpgsql as $$
      begin
        update public.jobs j set sent_count = j.sent_count + coalesce(p_n, 0), updated_at = now()
        where j.id = p_id and j.status in ('pending','sending');
      end;
      $$;`,
  };
  // Fixture 4b: additive guarded by a case-when on the SET → PASS.
  const guardedByCase = {
    label: "fixture:guarded-case",
    sql: `
      create or replace function public.bump(p_id uuid, p_n integer) returns void language plpgsql as $$
      begin
        update public.jobs j
        set sent_count = j.sent_count + case when true then coalesce(p_n, 0) else 0 end
        where j.id = p_id;
      end;
      $$;`,
  };
  // Fixture 5: a one-shot reminder guarded by `is null` → PASS (not additive anyway, and
  // the WHERE carries a guard).
  const oneShotReminder = {
    label: "fixture:one-shot",
    sql: `
      create or replace function public.mark_sent(p_id uuid) returns void language plpgsql as $$
      begin
        update public.reminders r set reminded_at = now()
        where r.id = p_id and r.reminded_at is null;
      end;
      $$;`,
  };

  const a1 = scanSources([rawCheckInsert]);
  assert(a1.some((f) => f.pattern === "A" && f.fn === "start_job"), "fixture 1 should flag Pattern A");

  const a2 = scanSources([backedCheckInsert]);
  assert(!a2.some((f) => f.pattern === "A"), "fixture 2 (partial unique index) should NOT flag Pattern A");

  const b1 = scanSources([rawAdditive]);
  assert(b1.some((f) => f.pattern === "B" && f.fn === "bump"), "fixture 3 should flag Pattern B");

  const b2 = scanSources([guardedByWhere]);
  assert(!b2.some((f) => f.pattern === "B"), "fixture 4a (status in WHERE) should NOT flag Pattern B");

  const b3 = scanSources([guardedByCase]);
  assert(!b3.some((f) => f.pattern === "B"), "fixture 4b (case-when on SET) should NOT flag Pattern B");

  const b4 = scanSources([oneShotReminder]);
  assert(!b4.some((f) => f.pattern === "B"), "fixture 5 (is null one-shot) should NOT flag");

  // The real 179 → 181 functions: with 181 present (latest def + partial index), the
  // newsletter send-job functions must be CLEAN. This is the anti-regression anchor.
  const m179 = join(MIGRATIONS_DIR, "179_batched_newsletter_send.sql");
  const m181 = join(MIGRATIONS_DIR, "181_harden_newsletter_send_job.sql");
  if (existsSync(m179) && existsSync(m181)) {
    const real = scanSources([
      { label: "179", sql: readFileSync(m179, "utf8") },
      { label: "181", sql: readFileSync(m181, "utf8") },
    ]);
    assert(
      !real.some((f) => f.fn === "create_newsletter_send_job"),
      "181's create_newsletter_send_job must NOT flag (partial unique index backs it)",
    );
    assert(
      !real.some((f) => f.fn === "advance_newsletter_send_job"),
      "181's advance_newsletter_send_job must NOT flag (cursor + status guarded)",
    );

    // And prove the guard has teeth: 179 ALONE (pre-181, no partial index, additive
    // advance_) must flag BOTH patterns.
    const only179 = scanSources([{ label: "179", sql: readFileSync(m179, "utf8") }]);
    assert(
      only179.some((f) => f.pattern === "A" && f.fn === "create_newsletter_send_job"),
      "179 alone should flag Pattern A on create_newsletter_send_job",
    );
    assert(
      only179.some((f) => f.pattern === "B" && f.fn === "advance_newsletter_send_job"),
      "179 alone should flag Pattern B on advance_newsletter_send_job",
    );
  }

  // Pattern C: a check-then-insert quota inside an RLS policy. A synthetic policy whose
  // predicate counts sibling rows and compares to a limit must FLAG (it is not in the
  // exceptions), while an ordinary policy with no count(*) cap must NOT.
  const policyQuota = {
    label: "fixture:policy-quota",
    sql: `
      create policy "widgets are capped" on public.widgets for insert to authenticated
      with check (
        bucket_id = 'x'
        and (
          select count(*) from public.widgets w2 where w2.bucket_id = 'x'
        ) < 5
      );`,
  };
  const c1 = scanSources([policyQuota]);
  assert(
    c1.some((f) => f.pattern === "C" && f.policy === "widgets are capped"),
    "fixture C (count(*) quota in a policy) should flag Pattern C",
  );

  const plainPolicy = {
    label: "fixture:plain-policy",
    sql: `
      create policy "widgets are readable" on public.widgets for select to authenticated
      using (public.is_member(ledger_id));`,
  };
  assert(!scanSources([plainPolicy]).some((f) => f.pattern === "C"), "a policy with no count(*) cap should NOT flag Pattern C");

  // The real 177/178 upload-quota policies: the raw Pattern C shape IS present (findPatternC
  // sees it, proving the guard would have caught the pre-184 pattern), and migration 184's
  // REVIEWED_EXCEPTIONS entries clear it, so the tree scan does NOT flag them (proving the
  // exception mechanism, not a weakened pattern, is what makes the tree clean).
  const m177 = join(MIGRATIONS_DIR, "177_receipt_upload_quota.sql");
  const m178 = join(MIGRATIONS_DIR, "178_incident_photo_upload_quota.sql");
  if (existsSync(m177)) {
    const raw177 = findPatternC(extractPolicies(stripSqlComments(readFileSync(m177, "utf8")), "177"));
    assert(
      raw177.some((h) => h.policy === "Fuel receipts are writable by workspace members"),
      "177's quota policy must match the raw Pattern C shape (the pre-184 pattern the guard now catches)",
    );
    assert(
      !scanSources([{ label: "177", sql: readFileSync(m177, "utf8") }]).some((f) => f.pattern === "C"),
      "177's quota policy must be CLEARED by migration 184's REVIEWED_EXCEPTIONS entry",
    );
  }
  if (existsSync(m178)) {
    const raw178 = findPatternC(extractPolicies(stripSqlComments(readFileSync(m178, "utf8")), "178"));
    assert(
      raw178.some((h) => h.policy === "Incident photos are writable by workspace members"),
      "178's quota policy must match the raw Pattern C shape (the pre-184 pattern the guard now catches)",
    );
    assert(
      !scanSources([{ label: "178", sql: readFileSync(m178, "utf8") }]).some((f) => f.pattern === "C"),
      "178's quota policy must be CLEARED by migration 184's REVIEWED_EXCEPTIONS entry",
    );
  }

  return true;
}

// ── Runner ────────────────────────────────────────────────────────────────────

function main() {
  const selfTestOnly = process.argv.includes("--self-test");
  try {
    selfTest();
  } catch (e) {
    process.stderr.write(`\n::error title=concurrency-hazard scanner self-test failed::${e.message}\n`);
    process.exit(1);
  }
  if (selfTestOnly) {
    process.stdout.write("ok - concurrency-hazard scanner self-test passed\n");
    return;
  }

  let findings;
  try {
    findings = scanSources(migrationSources());
  } catch (e) {
    if (e instanceof HazardScanError) {
      process.stderr.write(
        `\n::error title=concurrency-hazard scan unreadable::${e.message}. ` +
          `Update the extractors in tools/check-concurrency-hazards.mjs so the SQL is scanned again.\n`,
      );
      process.exit(1);
    }
    throw e;
  }

  if (findings.length) {
    process.stderr.write(`\n❌ concurrency / idempotency hazards found (GV-454):\n\n`);
    for (const f of findings) process.stderr.write(`  • ${describe(f)}\n\n`);
    process.stderr.write(
      `These are the shapes migrations 171 / 174 / 181 each had to harden AFTER shipping. The\n` +
        `structural guards cannot see a race, so this heuristic exists to catch the two clearest.\n` +
        `If a flag is a genuine false positive that no structural change can distinguish, add it to\n` +
        `REVIEWED_EXCEPTIONS in tools/check-concurrency-hazards.mjs with a justification — do NOT\n` +
        `weaken the pattern.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`ok - no unguarded check-then-insert or additive-counter concurrency hazards in supabase/migrations\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

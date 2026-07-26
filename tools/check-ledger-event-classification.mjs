// Every event_type written into public.ledger_events must be classified: does it
// belong in the member feed, or is it an internal audit row? (GV-413)
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS — three times in one evening, caught by a human every time
// ---------------------------------------------------------------------------
// govehlo-mobile's ActivityScreen renders the feed from ledger_events with a
// prefix-matched icon lookup that ends in a catch-all, and draws the row's title
// straight from the database. There is no allow-list of known event types anywhere
// in the client. The catch-all is CORRECT for a feed — showing new events is the
// whole point — but it means an internal reminder-audit row is one migration INSERT
// away from being user-visible, with no client change and nothing failing.
//
// That has now happened three times: weekly_digest_sent, then booking_fuel_reminder_sent
// (GVM-488), then confirm_reminder_sent (GVM-490, live since migration 118). Each was
// found by a person reading a feed, never by a test. The single filter that keeps audit
// rows out is the `.not('event_type', 'in', (…))` list in the mobile data gateway,
// mirrored here as EVENT_TYPE_EXCLUDE in tools/load-rehearsal/lib/hotpaths.mjs — and
// nothing forces a new event type to be considered against it.
//
// So this guard forces a CHOICE, not a decision. Every event type the SQL can write
// must appear in exactly one of two lists:
//
//   • EVENT_TYPE_EXCLUDE (tools/load-rehearsal/lib/hotpaths.mjs) — audit rows the
//     client filters out. Mirrored from the gateway; check-hotpath-mirror.mjs keeps
//     the two sides byte-identical.
//   • FEED_VISIBLE_EVENT_TYPES (tools/ledger-event-visibility.mjs) — types we have
//     looked at and accept as member-visible.
//
// A type in neither fails the build, naming the type, the migration it came from, and
// the two ways to resolve it. Either answer is accepted; only silence is not.
//
// ---------------------------------------------------------------------------
// SCANNING NOTES — where the ticket's hypothesis did not survive contact
// ---------------------------------------------------------------------------
// GV-413 assumed the event types could be read off as literals in the INSERT. About
// a tenth of the INSERT sites do not work that way:
//
//   • 20 sites pass a PL/pgSQL variable (`normalized_event_type`, `event_type_value`)
//     in the event_type position. Those are resolved by reading the assignments to
//     that variable inside the same function body, including CASE expressions.
//   • Two of those assignments end in `else 'settlement_' || normalized_status` — an
//     event type COMPUTED at runtime by concatenation, which no static scan can
//     reduce. Those are declared, with the concrete types they can produce, in
//     COMPUTED_EVENT_TYPE_EXPRESSIONS. An undeclared unresolvable expression is a
//     hard failure, never a pass.
//   • One live event type (operator_data_removed) is written by govehlo-web, not by
//     any migration, so a migrations-only scan is blind to it. It is classified in
//     the register like any other, and verified against the sibling repo when that
//     repo is checked out (see the tolerate-missing convention below).
//
// Following check-hotpath-mirror.mjs (GV-393): this scrapes SQL with a small
// hand-written parser rather than parsing it properly, because the repo is
// deliberately dependency-free — so every extractor FAILS LOUDLY when it cannot read
// what it expects, instead of returning nothing and silently certifying nothing. Its
// own behaviour is unit-tested in tools/test-ledger-event-classification-scan.mjs,
// including that SQL it cannot read is an error rather than a pass.
//
//   node tools/check-ledger-event-classification.mjs            # warn when web is absent
//   node tools/check-ledger-event-classification.mjs --strict   # umbrella: absent = failure
//
// The migrations half needs no sibling repo, so this runs in `npm run validate` and
// fails on the PR that adds the migration. Only the govehlo-web half tolerates a
// missing sibling, exactly as check-token-drift.mjs and check-hotpath-mirror.mjs do.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const CONSOLIDATED_SCHEMA = join(ROOT, "supabase-schema.sql");
const WEB_FUNCTIONS = join(ROOT, "..", "govehlo-web", "functions");

export class EventScanError extends Error {}

// ── Small SQL helpers ───────────────────────────────────────────────────────

// Drop `-- …` and `/* … */` comments that sit outside string literals. Comments are
// full of the words this scanner looks for ("insert into public.ledger_events" appears
// in prose in several migration headers), so they have to go before anything else.
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

// Split on commas that are not inside parentheses or string literals.
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

// Index of the `)` closing the `(` at `open`.
function matchParen(text, open) {
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

export function normaliseExpression(expr) {
  return expr.replace(/\s+/g, " ").trim();
}

// ── Literal resolution ──────────────────────────────────────────────────────

// Reduce an expression in the event_type position to the set of string literals it
// can evaluate to. Returns { literals, unresolved } — `unresolved` holds the
// normalised text of anything that is not a bare literal, which the caller must find
// declared in COMPUTED_EVENT_TYPE_EXPRESSIONS or fail on.
export function extractLiteralAlternatives(expr) {
  const text = normaliseExpression(expr);
  const literal = text.match(/^'((?:[^']|'')*)'(?:\s*::\s*text)?$/i);
  if (literal) return { literals: [literal[1].replace(/''/g, "'")], unresolved: [] };

  if (/^case\b/i.test(text) && /\bend$/i.test(text)) {
    const body = text.replace(/^case\b/i, "").replace(/\bend$/i, "");
    const branches = [];
    // `then <operand>` up to the next when/else/end, and the trailing `else <operand>`.
    const branchRe = /\b(?:then|else)\b([\s\S]*?)(?=\bwhen\b|\belse\b|$)/gi;
    let m;
    while ((m = branchRe.exec(body))) branches.push(m[1].trim());
    if (!branches.length) {
      throw new EventScanError(`could not read any branch out of the CASE expression \`${text}\``);
    }
    const literals = [];
    const unresolved = [];
    for (const branch of branches) {
      const inner = extractLiteralAlternatives(branch);
      literals.push(...inner.literals);
      unresolved.push(...inner.unresolved);
    }
    return { literals, unresolved };
  }

  return { literals: [], unresolved: [text] };
}

// The dollar-quoted function body containing `offset`, so a variable is resolved
// against the function that actually writes the event and not against a same-named
// variable in another function further up the file.
export function enclosingBody(sql, offset) {
  const re = /\$([A-Za-z_]\w*)?\$/g;
  const marks = [];
  let m;
  while ((m = re.exec(sql))) marks.push({ tag: m[1] || "", index: m.index, end: m.index + m[0].length });
  for (let i = 0; i < marks.length - 1; i++) {
    const open = marks[i];
    const close = marks.slice(i + 1).find((x) => x.tag === open.tag);
    if (!close) continue;
    if (offset > open.end && offset < close.index) return sql.slice(open.end, close.index);
    if (close.index < offset) i = marks.indexOf(close);
  }
  return sql;
}

// Every expression assigned to `name` inside `body`: plain `x := …;` assignments,
// DECLARE initialisers (`x text := …;`) and parameter defaults (`x text default …`).
export function assignedExpressions(body, name) {
  const found = [];
  const ident = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b${ident}\\s*:=`, "g"),
    new RegExp(`\\b${ident}\\s+[A-Za-z_][\\w\\[\\]]*\\s*(?:\\([^)]*\\))?\\s*:=`, "g"),
    new RegExp(`\\b${ident}\\s+[A-Za-z_][\\w\\[\\]]*\\s*(?:\\([^)]*\\))?\\s+default\\s`, "gi"),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let inString = false;
      let end = body.length;
      for (let i = start; i < body.length; i++) {
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
        else if (c === ")") {
          if (depth === 0) {
            end = i;
            break;
          }
          depth--;
        } else if (depth === 0 && (c === ";" || c === ",")) {
          end = i;
          break;
        }
      }
      const expr = body.slice(start, end).trim();
      if (expr) found.push(expr);
    }
  }
  return found;
}

// ── The scan ────────────────────────────────────────────────────────────────

// Pull every `insert into public.ledger_events (…) values (…) | select …` out of one
// SQL file and resolve the expression sitting in the event_type column.
export function scanSqlSource(sql, label = "<sql>") {
  const clean = stripSqlComments(sql);
  const sites = [];
  const re = /insert\s+into\s+public\.ledger_events\s*/gi;
  let m;
  while ((m = re.exec(clean))) {
    const colsOpen = m.index + m[0].length;
    if (clean[colsOpen] !== "(") {
      throw new EventScanError(
        `${label}: an INSERT into public.ledger_events has no explicit column list — ` +
          `the event_type position cannot be located`,
      );
    }
    const colsClose = matchParen(clean, colsOpen);
    if (colsClose === -1) throw new EventScanError(`${label}: unterminated column list on an INSERT into public.ledger_events`);
    const columns = splitTopLevel(clean.slice(colsOpen + 1, colsClose)).map((c) => c.toLowerCase());
    const index = columns.indexOf("event_type");
    if (index === -1) {
      throw new EventScanError(
        `${label}: an INSERT into public.ledger_events does not name event_type — ` +
          `it would take the table default, which no list classifies`,
      );
    }

    const rest = clean.slice(colsClose + 1);
    const kind = rest.match(/^\s*(values|select)\s*/i);
    if (!kind) {
      throw new EventScanError(
        `${label}: an INSERT into public.ledger_events is followed by neither VALUES nor SELECT ` +
          `(saw ${JSON.stringify(rest.slice(0, 40).trim())})`,
      );
    }

    let items;
    if (kind[1].toLowerCase() === "values") {
      const valuesOpen = colsClose + 1 + kind[0].length;
      if (clean[valuesOpen] !== "(") throw new EventScanError(`${label}: VALUES is not followed by a row constructor`);
      const valuesClose = matchParen(clean, valuesOpen);
      if (valuesClose === -1) throw new EventScanError(`${label}: unterminated VALUES row on an INSERT into public.ledger_events`);
      items = splitTopLevel(clean.slice(valuesOpen + 1, valuesClose));
    } else {
      const body = rest.slice(kind[0].length);
      let depth = 0;
      let inString = false;
      let end = body.length;
      for (let i = 0; i < body.length; i++) {
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
        else if (c === ")") {
          if (depth === 0) {
            end = i;
            break;
          }
          depth--;
        } else if (depth === 0 && c === ";") {
          end = i;
          break;
        } else if (depth === 0 && /\s/.test(c) && /^from\s/i.test(body.slice(i + 1))) {
          end = i;
          break;
        }
      }
      items = splitTopLevel(body.slice(0, end));
    }

    if (index >= items.length) {
      throw new EventScanError(
        `${label}: the INSERT into public.ledger_events names ${items.length} value(s) but ` +
          `event_type is column ${index + 1} — the scanner cannot line them up`,
      );
    }

    let resolved = extractLiteralAlternatives(items[index]);
    // A bare identifier is a PL/pgSQL variable: resolve it against the enclosing
    // function body rather than giving up.
    if (!resolved.literals.length && resolved.unresolved.length === 1 && /^[A-Za-z_]\w*$/.test(resolved.unresolved[0])) {
      const name = resolved.unresolved[0];
      const body = enclosingBody(clean, m.index);
      const assignments = assignedExpressions(body, name);
      if (!assignments.length) {
        throw new EventScanError(
          `${label}: the INSERT into public.ledger_events writes the variable \`${name}\`, but no ` +
            `assignment to it was found in the enclosing function body`,
        );
      }
      const literals = [];
      const unresolved = [];
      for (const expr of assignments) {
        const inner = extractLiteralAlternatives(expr);
        literals.push(...inner.literals);
        unresolved.push(...inner.unresolved);
      }
      resolved = { literals, unresolved, via: name };
    }

    sites.push({ label, expression: normaliseExpression(items[index]), ...resolved });
  }
  return sites;
}

// govehlo-web writes one event type directly (operator_data_removed) rather than
// through an RPC, so the migrations are blind to it. Same shape of scan.
export function scanWebSource(source, label = "<js>") {
  const sites = [];
  const re = /sbInsert\(\s*env\s*,\s*['"]ledger_events['"]\s*,/g;
  let m;
  while ((m = re.exec(source))) {
    const window = source.slice(m.index, m.index + 800);
    const type = window.match(/event_type\s*:\s*['"]([^'"]+)['"]/);
    if (!type) {
      throw new EventScanError(
        `${label}: an sbInsert into ledger_events has no literal event_type within reach — ` +
          `update the extractor in tools/check-ledger-event-classification.mjs`,
      );
    }
    sites.push({ label, expression: `event_type: '${type[1]}'`, literals: [type[1]], unresolved: [] });
  }
  return sites;
}

// ── The comparison ──────────────────────────────────────────────────────────

// Turn scanned sites into { type -> sources } plus the undeclared computed expressions.
export function collectEventTypes(sites, computedExpressions) {
  const types = new Map();
  const undeclaredExpressions = [];
  const usedExpressions = new Set();
  for (const site of sites) {
    const record = (type) => {
      if (!types.has(type)) types.set(type, new Set());
      types.get(type).add(site.label);
    };
    site.literals.forEach(record);
    for (const expr of site.unresolved) {
      const declared = computedExpressions[expr];
      if (!declared) {
        undeclaredExpressions.push({ label: site.label, expression: expr, via: site.via });
        continue;
      }
      usedExpressions.add(expr);
      declared.forEach(record);
    }
  }
  const staleExpressions = Object.keys(computedExpressions).filter((e) => !usedExpressions.has(e));
  return { types, undeclaredExpressions, staleExpressions };
}

// "the migration it came from" is the OLDEST one that writes the type: later
// migrations re-declare the same function over and over (expense_recurring_added
// appears in eleven files), and the first one is the one that made the decision.
export function orderSources(sources) {
  const migrations = [];
  const others = [];
  for (const s of sources) (s.includes("supabase/migrations/") ? migrations : others).push(s);
  migrations.sort();
  others.sort();
  return [...migrations, ...others];
}

function describeSources(sources) {
  const ordered = orderSources(sources);
  const [first, ...rest] = ordered;
  return rest.length ? `${first} (and ${rest.length} later file${rest.length === 1 ? "" : "s"})` : first;
}

// `staleExempt` holds types whose writer was not scanned on this run — the govehlo-web
// ones when that sibling is absent. Without it the stale check turns "we could not look"
// into "nothing writes this", i.e. it fails the register for being right.
export function classify(types, { excluded, visible, staleExempt = [] }) {
  const unclassified = [];
  const both = [];
  for (const [type, sources] of types) {
    const inExcluded = excluded.includes(type);
    const inVisible = visible.includes(type);
    if (inExcluded && inVisible) both.push(type);
    else if (!inExcluded && !inVisible) unclassified.push({ type, sources: [...sources].sort() });
  }
  const known = new Set(types.keys());
  const staleVisible = visible.filter((t) => !known.has(t) && !staleExempt.includes(t));
  return { unclassified: unclassified.sort((a, b) => a.type.localeCompare(b.type)), both, staleVisible };
}

// ── Runner ──────────────────────────────────────────────────────────────────

function sqlSources() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
  if (!files.length) {
    throw new EventScanError(`no migrations found in ${MIGRATIONS_DIR} — the scan would certify nothing`);
  }
  if (existsSync(CONSOLIDATED_SCHEMA)) files.push(CONSOLIDATED_SCHEMA);
  return files;
}

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

async function main() {
  const { FEED_VISIBLE_EVENT_TYPES, COMPUTED_EVENT_TYPE_EXPRESSIONS, WEB_WRITTEN_EVENT_TYPES } = await import(
    "./ledger-event-visibility.mjs"
  );
  const { EVENT_TYPE_EXCLUDE } = await import("./load-rehearsal/lib/hotpaths.mjs");

  const sites = [];
  let webChecked = false;
  try {
    for (const file of sqlSources()) {
      sites.push(...scanSqlSource(readFileSync(file, "utf8"), relative(ROOT, file)));
    }
    if (!sites.length) {
      throw new EventScanError(
        "no INSERTs into public.ledger_events were found in any migration — the SQL has changed " +
          "shape and this guard is verifying nothing",
      );
    }
    if (existsSync(WEB_FUNCTIONS)) {
      webChecked = true;
      for (const file of walkJs(WEB_FUNCTIONS)) {
        sites.push(...scanWebSource(readFileSync(file, "utf8"), `govehlo-web/${relative(WEB_FUNCTIONS, file)}`));
      }
    }
  } catch (e) {
    if (e instanceof EventScanError) {
      process.stderr.write(
        `\n::error title=ledger_events scan unreadable::${e.message}. ` +
          `Update the extractors in tools/check-ledger-event-classification.mjs so the event types are ` +
          `verified again rather than assumed.\n`,
      );
      process.exit(1);
    }
    throw e;
  }

  if (!webChecked) {
    const msg =
      `govehlo-web not found at ${WEB_FUNCTIONS} — the event types it writes directly ` +
      `(${WEB_WRITTEN_EVENT_TYPES.join(", ")}) were NOT verified against the register. ` +
      `The migrations half ran in full.`;
    if (STRICT) {
      process.stderr.write(`\n::error title=Web event types not checked::${msg}\n`);
      process.exit(1);
    }
    process.stdout.write(`::warning title=Web event types skipped::${msg}\n`);
  }

  const { types, undeclaredExpressions, staleExpressions } = collectEventTypes(sites, COMPUTED_EVENT_TYPE_EXPRESSIONS);
  const { unclassified, both, staleVisible } = classify(types, {
    excluded: EVENT_TYPE_EXCLUDE,
    visible: FEED_VISIBLE_EVENT_TYPES,
    // When govehlo-web was not scanned, the types only it writes are unverified, not
    // absent. Exempting them is the difference between "we could not look" and "nothing
    // writes this" — without it this guard fails its own register in fuel_sharing's CI.
    staleExempt: webChecked ? [] : WEB_WRITTEN_EVENT_TYPES,
  });

  const failures = [];

  for (const type of WEB_WRITTEN_EVENT_TYPES) {
    if (!FEED_VISIBLE_EVENT_TYPES.includes(type) && !EVENT_TYPE_EXCLUDE.includes(type)) {
      failures.push(
        `'${type}' is declared in WEB_WRITTEN_EVENT_TYPES but is in neither list. govehlo-web writes it into ` +
          `ledger_events, so it needs the same feed-or-audit choice as anything a migration writes.`,
      );
    }
  }

  const byExpression = new Map();
  for (const item of undeclaredExpressions) {
    if (!byExpression.has(item.expression)) byExpression.set(item.expression, { ...item, labels: [] });
    byExpression.get(item.expression).labels.push(item.label);
  }
  for (const item of byExpression.values()) {
    failures.push(
      `the event_type written into ledger_events by ${describeSources(item.labels)} is computed at runtime and ` +
        `cannot be reduced to literals:\n      ${item.expression}${item.via ? `   (via ${item.via})` : ""}\n` +
        `      Declare it in COMPUTED_EVENT_TYPE_EXPRESSIONS (tools/ledger-event-visibility.mjs) with the ` +
        `concrete event types it can produce, then classify each of those.`,
    );
  }

  for (const item of unclassified) {
    failures.push(
      `'${item.type}' is written into public.ledger_events by ${describeSources(item.sources)} and is in NEITHER list.\n` +
        `      Choose — feed or audit:\n` +
        `        FEED  → add it to FEED_VISIBLE_EVENT_TYPES in tools/ledger-event-visibility.mjs.\n` +
        `                It will render in the member Activity feed with its database title.\n` +
        `        AUDIT → add it to EVENT_TYPE_EXCLUDE in tools/load-rehearsal/lib/hotpaths.mjs AND to the\n` +
        `                .not('event_type','in',(…)) filter in govehlo-mobile's ledger-data-gateway.ts.\n` +
        `                Both sides, in the same order — check-hotpath-mirror.mjs compares them.`,
    );
  }

  for (const type of both) {
    failures.push(
      `'${type}' is in BOTH EVENT_TYPE_EXCLUDE and FEED_VISIBLE_EVENT_TYPES. The client filters it out, so ` +
        `it is not visible — remove it from FEED_VISIBLE_EVENT_TYPES.`,
    );
  }

  for (const type of staleVisible) {
    failures.push(
      `'${type}' is listed in FEED_VISIBLE_EVENT_TYPES but nothing writes it any more. Either the SQL that ` +
        `wrote it was removed (delete the entry) or the scanner stopped seeing it (fix the scanner).`,
    );
  }

  for (const expr of staleExpressions) {
    failures.push(
      `COMPUTED_EVENT_TYPE_EXPRESSIONS declares \`${expr}\`, but no INSERT writes that expression any more. ` +
        `Delete the entry so the register keeps matching the SQL.`,
    );
  }

  if (failures.length) {
    process.stderr.write(`\n❌ public.ledger_events event types are not fully classified:\n\n`);
    failures.forEach((f) => process.stderr.write(`  • ${f}\n\n`));
    process.stderr.write(
      `A new event type becomes visible in every member's Activity feed the moment a migration writes it —\n` +
        `the client has no allow-list, only the exclusion filter. This guard exists so that is a decision\n` +
        `someone makes, not one that happens by nobody making it (GV-413).\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `ok - ${types.size} ledger_events event types classified ` +
      `(${FEED_VISIBLE_EVENT_TYPES.length} feed-visible, ${EVENT_TYPE_EXCLUDE.length} audit-only)\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

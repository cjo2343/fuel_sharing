// Which migration ids does a SQL file actually INSERT into the schema-migration
// tracker? (GV-392)
//
// ── Why this exists ───────────────────────────────────────────────────────────
//
// The mirror check in tools/test-migrations.mjs used to be one line:
//
//     assert.ok(consolidatedSchema.includes(migrationId), …)
//
// A bare substring test. Three migrations — 024_schema_drift_healthcheck,
// 033_onboarding_rate_limit_scope_key_alignment and 036_invite_profile_setup — each
// insert their own id in their own migration file, but supabase-schema.sql had no
// INSERT for any of them. Replaying the migrations produced 146 tracker rows;
// replaying the consolidated schema produced 143, so a database provisioned from
// supabase-schema.sql booted reporting three missing migrations against itself.
//
// The guard stayed green because those three ids DO appear in supabase-schema.sql —
// inside fuel_ledger_healthcheck's own `expected_schema_migrations` VALUES list. The
// substring satisfying the mirror guard WAS the expectation list of the drift detector
// that would have reported the failure. Nothing else could have caught it either:
// check-schema-equivalence.mjs dumps schema-only on purpose, and tracker rows are data.
//
// A migration id is a plausible substring of a dozen innocent things — a healthcheck
// expectation list, a tracker description narrating an earlier migration, a `-- see
// migration 033` comment. So "the id appears somewhere" cannot mean "the row gets
// written". This module answers the real question instead: does a genuine INSERT …
// INTO public.fuel_ledger_schema_migrations statement carry this id as a value?
//
// ── How ───────────────────────────────────────────────────────────────────────
//
// A small SQL lexer — the same three states tools/test-sql-ambiguity-guard.mjs uses,
// for the same reason (a naive regex trips over `--` comments, '' escapes and
// dollar-quoted function bodies). It splits the file into statements on semicolons
// that are in code position, then for each statement that begins with the tracker
// INSERT it collects the single-quoted literals that look like migration ids.
//
// Consequences that are deliberate:
//   * an id named only inside a dollar-quoted function body (an expectation list) is
//     invisible — that body is a string to Postgres, not an INSERT;
//   * an id named only inside a description string is invisible — descriptions are
//     collected too, but they never match the id shape, and even a description that
//     did would have to sit in a tracker INSERT statement to count at all;
//   * `insert into public.fuel_ledger_schema_migrations` with any column list, single
//     or multi-row VALUES, and any ON CONFLICT clause all work, because the whole
//     statement is scanned rather than a fixed shape being pattern-matched.

/** Shape of a migration id: the 3-digit prefix plus a snake_case name. */
export const MIGRATION_ID = /^\d{3}_[a-z0-9_]+$/;

const TRACKER_TABLE = /^\s*insert\s+into\s+(public\s*\.\s*)?fuel_ledger_schema_migrations\b/i;

/**
 * Split SQL into statements, returning `{ code, strings }` for each.
 *
 * `code` is the statement with every `--` comment, every single-quoted literal and
 * every dollar-quoted body blanked out, so it can be matched against without a
 * comment or a body ever being mistaken for code. `strings` is the list of
 * single-quoted literals the statement contained, with '' unescaped to '.
 *
 * Dollar-quoted bodies are treated as opaque: a `;` inside a function body must not
 * end a statement, and an INSERT written inside a body is not executed by the file.
 */
export function splitStatements(sql) {
  const statements = [];
  let code = '';
  let strings = [];
  let current = '';
  let state = 'code'; // code | line_comment | block_comment | squote | dquote | dollar
  let dollarTag = '';
  let blockDepth = 0;

  const endStatement = () => {
    if (code.trim() || strings.length) statements.push({ code, strings });
    code = '';
    strings = [];
  };

  for (let i = 0; i < sql.length; ) {
    const c = sql[i];

    if (state === 'code') {
      const dq = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (dq) { i += dq[0].length; state = 'dollar'; dollarTag = dq[0]; code += ' '; continue; }
      if (c === '-' && sql[i + 1] === '-') { i += 2; state = 'line_comment'; continue; }
      if (c === '/' && sql[i + 1] === '*') { i += 2; state = 'block_comment'; blockDepth = 1; continue; }
      if (c === "'") { i += 1; state = 'squote'; current = ''; continue; }
      if (c === '"') { i += 1; state = 'dquote'; code += '"'; continue; }
      if (c === ';') { i += 1; endStatement(); continue; }
      code += c; i += 1; continue;
    }

    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length; state = 'code'; dollarTag = ''; continue; }
      i += 1; continue;
    }

    if (state === 'line_comment') {
      if (c === '\n') { code += '\n'; i += 1; state = 'code'; continue; }
      i += 1; continue;
    }

    if (state === 'block_comment') {
      // Postgres block comments nest.
      if (c === '/' && sql[i + 1] === '*') { blockDepth += 1; i += 2; continue; }
      if (c === '*' && sql[i + 1] === '/') { blockDepth -= 1; i += 2; if (blockDepth === 0) state = 'code'; continue; }
      i += 1; continue;
    }

    if (state === 'dquote') {
      code += c; i += 1;
      if (c === '"') state = 'code';
      continue;
    }

    // squote
    if (c === "'" && sql[i + 1] === "'") { current += "'"; i += 2; continue; }
    if (c === "'") { strings.push(current); current = ''; i += 1; state = 'code'; code += ' '; continue; }
    current += c; i += 1;
  }
  endStatement();
  return statements;
}

/**
 * Migration ids written into public.fuel_ledger_schema_migrations by `sql`.
 *
 * Returns a Set. An id that merely appears in the text — in a comment, in a tracker
 * description, or inside a function body's expectation list — is NOT in it. That
 * distinction is the whole point of the module; see the header.
 */
export function trackerInsertedIds(sql) {
  const ids = new Set();
  for (const { code, strings } of splitStatements(sql)) {
    if (!TRACKER_TABLE.test(code)) continue;
    for (const value of strings) {
      if (MIGRATION_ID.test(value)) ids.add(value);
    }
  }
  return ids;
}

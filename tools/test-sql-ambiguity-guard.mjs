import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sqlFiles = ["supabase-schema.sql"];
const migrationDir = "supabase/migrations";
if (existsSync(migrationDir)) {
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlFiles.push(join(migrationDir, file));
  }
}

const highRiskBareVariables = new Set([
  "actor_email",
  "user_email",
  "target_email",
  "email",
  "status",
  "role",
  "action",
  "scope_key",
  "ledger_id",
  "member_id",
  "period_id",
  "invite_id",
  "created_at",
  "updated_at",
  "id",
]);

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Blank out `--` line comments and '...' string literals so the DECLARE/BEGIN
// scan only sees actual code. Dollar-quoted bodies ($$…$$) are kept verbatim —
// that is where real declarations live. Prose like "re-declare" in a comment or
// a tracker-insert description string used to open phantom DECLARE blocks that
// swallowed a later function's parameter list (GV-252 / guard gap on GV-248).
// Newlines are preserved so reported line numbers stay accurate.
function maskNonCode(sql) {
  let out = "";
  let state = "code"; // code | line_comment | squote | dollar
  let dollarTag = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (state === "code") {
      const dq = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (dq) { out += dq[0]; i += dq[0].length; state = "dollar"; dollarTag = dq[0]; continue; }
      if (c === "-" && sql[i + 1] === "-") { out += "  "; i += 2; state = "line_comment"; continue; }
      if (c === "'") { out += " "; i += 1; state = "squote"; continue; }
      out += c; i += 1; continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarTag, i)) { out += dollarTag; i += dollarTag.length; state = "code"; dollarTag = ""; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line_comment") {
      if (c === "\n") { out += "\n"; i += 1; state = "code"; continue; }
      out += c === "\t" ? "\t" : " "; i += 1; continue;
    }
    // squote
    if (c === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
    if (c === "'") { out += " "; i += 1; state = "code"; continue; }
    out += c === "\n" ? "\n" : " "; i += 1; continue;
  }
  return out;
}

const problems = [];

for (const file of sqlFiles) {
  const sql = maskNonCode(readFileSync(file, "utf8"));
  const declarationBlocks = sql.matchAll(/\bDECLARE\b([\s\S]*?)\bBEGIN\b/gi);

  for (const blockMatch of declarationBlocks) {
    const block = blockMatch[1];
    const blockStartLine = lineNumberAt(sql, blockMatch.index ?? 0);
    const lines = block.split("\n");

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:constant\s+)?[a-zA-Z_][\w.\[\]]*/i);
      if (!match) return;

      const variableName = match[1].toLowerCase();
      if (!highRiskBareVariables.has(variableName)) return;

      problems.push(`${file}:${blockStartLine + index}: risky PL/pgSQL variable '${match[1]}' reuses a common table column name; use safe_*, target_*, current_*, requested_*, saved_*, or normalized_* instead.`);
    });
  }
}

assert.deepEqual(problems, [], `SQL ambiguity guard found risky local variable names:\n${problems.join("\n")}`);

const allSql = sqlFiles.map((file) => readFileSync(file, "utf8")).join("\n");
assert.match(
  allSql,
  /safe_actor_email\s+text\s*:=\s*public\.current_user_email\(\)/,
  "onboarding rate-limit RPC should keep actor email in a safely named local variable",
);
// NOTE: check_ledger_invite_email and update_own_ledger_member_profile were DROPPED by
// migration 147 — they were superseded by migration 045's join codes and by
// set_member_name + update_own_ledger_member_mobilepay, and no client called either.
// These two anchors still match because `allSql` is every migration file concatenated
// and migrations 036/037 still contain the definitions; they are historical text
// anchors for the safe_*/saved_* variable-naming assertions that follow, not claims
// about the live schema. Do not read them as "this RPC must exist".
assert.match(
  allSql,
  /create or replace function public\.check_ledger_invite_email\(/,
  "migration 037's invite email preflight should keep its dedicated RPC definition (dropped in 147; anchors the safe_login_email check below)",
);
assert.match(
  allSql,
  /safe_login_email\s+text\s*:=\s*lower\(btrim\(coalesce\(login_email, ''\)\)\)/,
  "invite email preflight should avoid a bare email local variable",
);
assert.match(
  allSql,
  /create or replace function public\.update_own_ledger_member_profile\(/,
  "migration 036's invite profile setup should keep its dedicated RPC definition (dropped in 147; anchors the safe_member_id/saved_member checks below)",
);
assert.match(
  allSql,
  /safe_member_id\s+uuid;/,
  "invite profile setup should avoid a bare member_id local variable",
);
assert.match(
  allSql,
  /saved_member\s+public\.ledger_members%rowtype;/,
  "invite profile setup should use a safely named saved_member row variable",
);

console.log("ok - SQL ambiguity guard blocks high-risk PL/pgSQL variable/column name collisions");

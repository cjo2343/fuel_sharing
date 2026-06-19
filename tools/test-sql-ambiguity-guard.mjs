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

const problems = [];

for (const file of sqlFiles) {
  const sql = readFileSync(file, "utf8");
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

console.log("ok - SQL ambiguity guard blocks high-risk PL/pgSQL variable/column name collisions");

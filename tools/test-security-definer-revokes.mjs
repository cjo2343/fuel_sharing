import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// GV-211 guard: every SECURITY DEFINER function in the consolidated schema must have
// an explicit `revoke execute on function <sig> from public;`.
//
// In Postgres a freshly created function grants EXECUTE to PUBLIC by default, so a
// SECURITY DEFINER RPC without a revoke is executable by any role including anon.
// Migration 083 revoked PUBLIC across the board; this guard fails the build if a new
// SECURITY DEFINER function is added later without the matching revoke.

const schema = readFileSync("supabase-schema.sql", "utf8");

const TYPE_WORDS = new Set([
  "bigint", "int8", "integer", "int", "int4", "smallint", "int2", "numeric",
  "decimal", "real", "float4", "double", "precision", "money", "boolean", "bool",
  "text", "varchar", "character", "varying", "char", "bpchar", "uuid", "json",
  "jsonb", "date", "time", "timestamp", "timestamptz", "interval", "bytea", "inet",
  "cidr", "macaddr", "name", "void", "record", "anyelement", "anyarray", "trigger",
  "xml", "tsvector", "tsquery", "citext", "hstore", "with", "without", "zone",
]);

function splitTopLevelArgs(argStr) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (const ch of argStr) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length) args.push(cur);
  return args;
}

// Reduce one declared argument to its bare type (strip mode, arg name, DEFAULT).
function argType(arg) {
  let a = arg
    .trim()
    .replace(/\bdefault\b[\s\S]*$/i, "")
    .trim()
    .replace(/^(in|out|inout|variadic)\s+/i, "")
    .trim();
  const tokens = a.split(/\s+/);
  if (tokens.length >= 2) {
    const first = tokens[0].toLowerCase().replace(/\[\]$/, "").replace(/\(.*/, "");
    if (!TYPE_WORDS.has(first)) tokens.shift();
  }
  return tokens.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

// Normalize the arg list of a revoke/drop statement (already types, just tidy).
function normArgs(argStr) {
  return splitTopLevelArgs(argStr)
    .map((a) => a.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((x) => x.length)
    .join(", ");
}

// Collect create + drop function events in document order, then replay them so that
// only the functions that actually survive a fresh replay are considered "live".
const events = [];

const createRe =
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi;
let m;
while ((m = createRe.exec(schema)) !== null) {
  const name = m[1];
  const parenOpen = createRe.lastIndex - 1;
  let depth = 0;
  let i = parenOpen;
  for (; i < schema.length; i++) {
    const ch = schema[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const args = splitTopLevelArgs(schema.slice(parenOpen + 1, i))
    .map(argType)
    .filter((x) => x.length);
  const tail = schema.slice(i);
  const dq = tail.match(/\$([a-zA-Z_]*)\$/);
  let bodyEnd;
  if (dq) {
    const tag = dq[0];
    const first = tail.indexOf(tag);
    const second = tail.indexOf(tag, first + tag.length);
    bodyEnd = i + (second >= 0 ? second + tag.length : tail.length);
  } else {
    bodyEnd = i + tail.indexOf(";");
  }
  const isDefiner = /security\s+definer/i.test(schema.slice(i, bodyEnd + 30));
  events.push({
    pos: m.index,
    type: "create",
    name,
    argstr: args.join(", "),
    sig: `${name}(${args.join(", ")})`,
    isDefiner,
  });
}

const dropRe =
  /drop\s+function\s+if\s+exists\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([^)]*)\)/gi;
while ((m = dropRe.exec(schema)) !== null) {
  events.push({ pos: m.index, type: "drop", sig: `${m[1]}(${normArgs(m[2])})` });
}

events.sort((a, b) => a.pos - b.pos);

const live = new Map();
for (const e of events) {
  if (e.type === "create") live.set(e.sig, e);
  else live.delete(e.sig);
}

const definers = [...live.values()]
  .filter((e) => e.isDefiner)
  .sort((a, b) => a.sig.localeCompare(b.sig));

assert.ok(
  definers.length > 0,
  "expected to find SECURITY DEFINER functions in supabase-schema.sql — parser likely broke",
);

// Collect every `revoke execute ... from public` signature.
const revokeRe =
  /revoke\s+(?:execute|all)\s+on\s+function\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([^)]*)\)\s+from\s+public/gi;
const revoked = new Set();
while ((m = revokeRe.exec(schema)) !== null) {
  revoked.add(`${m[1]}(${normArgs(m[2])})`);
}

const offenders = definers
  .filter((e) => !revoked.has(e.sig))
  .map((e) => `public.${e.name}(${e.argstr})`);

assert.equal(
  offenders.length,
  0,
  `SECURITY DEFINER functions missing a "revoke execute on function ... from public" ` +
    `(they are executable by PUBLIC/anon by default — add the revoke, see migration 083 / GV-211):\n  ` +
    offenders.join("\n  "),
);

console.log(
  `ok - all ${definers.length} SECURITY DEFINER functions revoke EXECUTE from PUBLIC (GV-211)`,
);

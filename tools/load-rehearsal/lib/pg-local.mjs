// Local (Docker Postgres) leg of the load rehearsal — GV-438.
//
// The hosted rehearsal (schema-apply → seed → load) needs a throwaway Supabase
// project: GoTrue for sign-ins, PostgREST for the reads. That is the right harness
// for end-to-end latency, and it is what GVM-533 measured. It is the WRONG harness
// for the question GV-438 asks — "at what history size does the unbounded feed read
// start to hurt, and would an index help?" — because it costs ~5,000 HTTP writes and
// a fresh project to build ONE aged workspace, and because the answer is a database
// answer that per-request network noise hides.
//
// So this module hosts the same fixture on a disposable Postgres 17 container (the
// canonical replay image every Docker guard in this repo uses), seeds it through the
// SAME production RPCs — impersonating members with request.jwt.claims exactly as
// tools/test-functional-smoke.sh does — and measures the reads with RLS applied as
// role `authenticated`. Server-side execution time only: no PostgREST, no network,
// so the numbers are NOT comparable to GVM-533's end-to-end ones in absolute terms
// (the evidence doc says so where it reports them). What they ARE good for is the
// shape: the same read at 1k, 5k, 20k rows of history, on the same machine.
//
// Nothing here can reach production — there is no env file and no URL; the only
// database it can talk to is a container it started itself.

import { spawnSync } from "node:child_process";
import {
  IMAGE,
  startPostgres,
  removeContainer,
  createDbWithPrelude,
} from "../../lib/replay-container.mjs";

export { IMAGE, removeContainer };

// createDbWithPrelude() already applies the shared replay PRELUDE (roles,
// auth.jwt()/auth.uid(), pgcrypto, the realtime publication). Two things it does
// not do, both needed here and both taken from tools/test-rls-role-matrix.mjs's
// Supabase-faithful prelude:
//
//   • auth.users — the onboarding RPCs resolve the signed-in identity against it
//     (tools/test-functional-smoke.sh adds the same line);
//   • the GRANTS. A real Supabase project has default privileges that grant every
//     new public table to anon/authenticated/service_role, and the schema's own
//     revoke/grant lines then carve the production state on top. Without them the
//     measured reads fail with "permission denied for table ledgers" — the privilege
//     system, not RLS. These MUST run before the schema is applied, so they cover
//     every object it creates.
export const LOCAL_PRELUDE = `
create table if not exists auth.users (id uuid primary key, email text);
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

// Scratch bookkeeping the harness owns (never part of the product schema): the
// slot → member/auth identity map the seeding steps read back into Node.
export const SCRATCH_DDL = `
create table if not exists public.load_rehearsal_state (k text primary key, v text);
create table if not exists public.load_rehearsal_members (
  workspace_index int,
  slot int,
  member_id uuid,
  sub uuid,
  email text,
  primary key (workspace_index, slot)
);
`;

export function psqlRun(container, db, sql, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", db, "-f", "-"],
    { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
  );
}

// Run SQL, throwing a readable Error on failure (psql's stderr, trimmed).
export function exec(container, db, sql, what = "statement") {
  const res = psqlRun(container, db, sql);
  if (res.error) throw new Error(`${what}: could not run psql (${res.error.message})`);
  if (res.status !== 0) {
    throw new Error(`${what} failed (psql exit ${res.status}):\n${(res.stderr || "").trim()}`);
  }
  return res.stdout;
}

// Run a single query and return its rows as unaligned, tuple-only lines.
export function queryLines(container, db, sql, what = "query") {
  const res = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-F", "\t",
      "-U", "postgres", "-d", db, "-f", "-"],
    { input: sql, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`${what} failed (psql exit ${res.status}):\n${(res.stderr || "").trim()}`);
  }
  return res.stdout.split("\n").filter((l) => l !== "");
}

export function queryValue(container, db, sql, what = "query") {
  const lines = queryLines(container, db, sql, what);
  return lines.length > 0 ? lines[0] : null;
}

export function queryJson(container, db, sql, what = "query") {
  const raw = queryValue(container, db, sql, what);
  return raw === null || raw === "" ? null : JSON.parse(raw);
}

// ── SQL literal helpers ──────────────────────────────────────────────────────
// Fixture values only (synthetic Danish names, generated ids) — but everything
// crossing into SQL still goes through these two.

// Dollar-quote a JSON payload. JSON can never contain the tag, so this is safe and
// keeps multi-KB plan documents readable in a failure dump.
export function jsonLiteral(value) {
  return `$loadjson$${JSON.stringify(value)}$loadjson$`;
}

export function textLiteral(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The claims a member's requests carry. Mirrors a real Supabase JWT closely enough
// for auth.uid() / auth.jwt() ->> 'email' / the `authenticated` role checks — which
// is everything the RPCs and the RLS policies actually read.
export function claimsFor({ sub, email }) {
  return JSON.stringify({ sub, email, role: "authenticated" });
}

// Impersonate a member for the rest of the psql session. Deliberately a DO block
// rather than `select set_config(...)`: a bare select PRINTS a row, and every
// helper here reads psql's output positionally — the claims JSON would arrive
// where the query's own first row was expected.
export function setClaimsSql(who) {
  const claims = claimsFor(who).replace(/'/g, "''");
  return `do $$ begin perform set_config('request.jwt.claims', '${claims}', false); end $$;`;
}

// Boot a container, apply the prelude + the consolidated schema, and add the
// harness's own scratch tables. Returns the elapsed schema-apply seconds, which is
// itself a fresh-install validation of supabase-schema.sql.
export function bootDatabase({ container, repoDir, db = "loadrehearsal" }) {
  startPostgres(container, repoDir);
  createDbWithPrelude(container, db);
  exec(container, db, LOCAL_PRELUDE, "local prelude");
  const started = Date.now();
  const res = psqlRun(container, db, "\\i /work/supabase-schema.sql");
  if (res.status !== 0) {
    throw new Error(`schema apply failed (psql exit ${res.status}):\n${(res.stderr || "").trim().slice(-4000)}`);
  }
  const seconds = (Date.now() - started) / 1000;
  exec(container, db, SCRATCH_DDL, "scratch DDL");
  return seconds;
}

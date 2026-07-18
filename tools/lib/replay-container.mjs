// Shared Docker replay helpers (GV-175 / GV-223).
//
// Both check-schema-equivalence.mjs and generate-db-types.mjs need the same
// bootstrap: a disposable Postgres 15 container (matches Supabase) with the
// repo mounted read-only at /work, plus a Supabase-stub prelude — roles
// anon/authenticated/service_role, auth.jwt()/auth.uid(), the extensions
// schema with pgcrypto (Supabase preinstalls it there, which is why migration
// 001's bare `create extension if not exists pgcrypto` is a no-op in prod),
// and the supabase_realtime publication. This module owns that bootstrap so
// the two tools can't drift apart.
//
// Error contract: startPostgres() and createDbWithPrelude() throw an Error
// with a human-readable message; callers catch and route it through their own
// fail() (which must also call removeContainer()). psql() returns the raw
// spawnSync result so callers keep full control of stderr reporting.

import { execFileSync, spawnSync } from "node:child_process";

export const IMAGE = "postgres:15-alpine";

export const PRELUDE = `
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
`;

export function docker(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

export function removeContainer(container) {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}

// Start a disposable Postgres container with the repo mounted read-only at
// /work and wait until it accepts connections. With publishPort: true the
// container's 5432 is published on an ephemeral localhost port (needed when a
// host-side tool — e.g. the supabase CLI — must reach the database directly;
// discover it with hostPort()).
export function startPostgres(container, repoDir, { publishPort = false, image = IMAGE } = {}) {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Docker is not available (daemon not running?). This check needs Docker to host disposable Postgres.",
    );
  }

  docker([
    "run", "-d", "--name", container,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    ...(publishPort ? ["-p", "127.0.0.1:0:5432"] : []),
    "-v", `${repoDir}:/work:ro`,
    image,
  ]);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    const res = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
    if (res.status === 0) { ready = true; break; }
    execFileSync("sleep", ["1"]);
  }
  if (!ready) throw new Error("Postgres did not become ready within 60s.");
  // pg_isready can flip true between the bootstrap restart; settle briefly.
  execFileSync("sleep", ["2"]);
}

// Host port mapped to the container's 5432 (requires publishPort: true).
export function hostPort(container) {
  const out = docker(["port", container, "5432"]).trim();
  // e.g. "127.0.0.1:55001" (possibly one line per address family)
  const match = out.split("\n")[0].match(/:(\d+)$/);
  if (!match) throw new Error(`Could not parse published port from: ${out}`);
  return match[1];
}

export function psql(container, db, extraArgs) {
  return spawnSync(
    "docker",
    ["exec", container, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", db, ...extraArgs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

export function createDbWithPrelude(container, db) {
  const created = spawnSync("docker", ["exec", container, "createdb", "-U", "postgres", db], { encoding: "utf8" });
  if (created.status !== 0) throw new Error(`createdb ${db} failed:\n${created.stderr}`);
  const res = psql(container, db, ["-c", PRELUDE]);
  if (res.status !== 0) throw new Error(`Prelude failed on ${db}:\n${res.stderr}`);
}

#!/bin/bash
# Functional regression test for migration 149 (GV-385).
#
# The defect being guarded against is a GDPR one, and none of the structural checks in
# this repo can see any part of it. Schema equivalence proves the two replay paths agree
# about the SHAPE of owner_api_rate_limits; it cannot tell you what ends up IN the
# column, which is the entire question. Four properties, four things only a running
# database shows:
#
# 1. NO ADDRESS IS STORED. The limiter is called with a real e-mail (its parameter
#    contract is unchanged, on purpose — the Cloudflare Functions still send
#    actor_email) and what lands in the table must be a digest. A future migration that
#    "helpfully" re-adds a readable actor column would pass every other guard here.
#
# 2. THE LIMITER STILL WORKS. Pseudonymising the key is only acceptable if it still
#    partitions callers: same address in any casing -> one bucket, different address ->
#    a different bucket, and the cap still trips. Collapsing everyone into one bucket
#    would turn a per-user limit into a global one and would look, structurally,
#    exactly like this change.
#
# 3. THE PEPPER IS OUT OF REACH. An unsalted sha256 of an e-mail is reversed by hashing
#    the known user list, so the whole fix rests on service_role — the role the admin
#    console and every Pages Function use — being unable to read the pepper or call the
#    hash helper. That is a privilege fact, not a schema fact.
#
# 4. RETENTION AND ERASURE REACH THE TABLE. run_operational_retention must purge stale
#    counters (and must still purge decommissioned workspaces — the first draft of 149
#    re-declared it off migration 131, which predates GV-316, and silently reverted
#    that), and delete_my_account must remove the caller's rows. PL/pgSQL resolves
#    table references at run time, so a wrong column name in either would pass
#    everything and fail on a real deletion request.
#
# The migrations path additionally seeds a clear-text row BEFORE 149 runs, so the
# in-place backfill is exercised rather than assumed. Both paths are checked, because a
# mirror that drifts is a failure mode this repo has actually shipped.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-rate-limit-pii-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the rate-limit pseudonymisation functional test." >&2
  exit 1
fi

# Keep in step with the canonical IMAGE constant in tools/lib/replay-container.mjs
# (shell can't import it). Prod Supabase runs Postgres 17.x — GV-314.
docker run -d --name "${C}" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO":/repo:ro postgres:17-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "${C}" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Postgres did not become ready within 60s." >&2
  exit 1
fi
sleep 2

PSQL() { local db="$1"; shift; docker exec -i "${C}" psql -v ON_ERROR_STOP=1 -q -U postgres -d "$db" "$@"; }

prelude() {
  local db="$1"
  docker exec "${C}" createdb -U postgres "$db"
  PSQL "$db" <<'SQL'
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
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
-- delete_my_account deletes the credential row last; the equivalence prelude has no
-- auth.users, so stub the two columns it touches (same shape as test-functional-smoke.sh).
create table if not exists auth.users (id uuid primary key, email text);
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
}

prelude schema_path
prelude migrations_path

PSQL schema_path -f /repo/supabase-schema.sql >/dev/null

# Replay the migrations, dropping a legacy clear-text row in just before 149 so the
# in-place backfill has something to convert.
for f in $(docker exec "${C}" sh -c "ls /repo/supabase/migrations/*.sql | sort"); do
  case "$f" in
    */149_*)
      PSQL migrations_path <<'SQL' >/dev/null
insert into public.owner_api_rate_limits (actor_email, action, window_started_at, attempts, last_attempt_at)
values ('Legacy.User@Example.DK', 'mobile.receipt_ocr', now() - interval '2 days', 7, now() - interval '2 days');
SQL
      ;;
  esac
  PSQL migrations_path -f "$f" >/dev/null
done

# ── 1. The legacy row was digested IN PLACE, keeping its count ────────────────
PSQL migrations_path <<'SQL'
do $$
declare
  v_hash text;
  v_attempts integer;
begin
  select actor_hash, attempts into v_hash, v_attempts from public.owner_api_rate_limits;
  if v_hash is null then
    raise exception 'FAIL: the pre-149 counter row disappeared instead of being converted';
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'FAIL: pre-149 row was not digested, actor_hash = %', v_hash;
  end if;
  if v_attempts is distinct from 7 then
    raise exception 'FAIL: the backfill lost the throttle count (% instead of 7)', v_attempts;
  end if;
  raise notice 'PASS: a clear-text row written before migration 149 was digested in place, count intact';
end $$;

delete from public.owner_api_rate_limits;
SQL

# ── The assertions, run identically against BOTH replay paths ─────────────────
for DB in schema_path migrations_path; do
  PSQL "$DB" -v path="${DB}" <<'SQL'
\set ON_ERROR_STOP on
\o /dev/null
select set_config('myvars.path', :'path', false);
\o

-- 1. No address is stored, however the limiter is called.
do $$
declare
  v_stored text;
begin
  perform public.check_owner_rate_limit('Anna@Example.dk', 'mobile.address_suggest', 3, 3600);
  select actor_hash into v_stored from public.owner_api_rate_limits;
  if v_stored is null then
    raise exception 'FAIL(%): the limiter wrote no row at all', current_setting('myvars.path', true);
  end if;
  if v_stored like '%@%' or lower(v_stored) like '%anna%' then
    raise exception 'FAIL(%): the limiter stored an address, not a digest: %',
      current_setting('myvars.path', true), v_stored;
  end if;
  if v_stored !~ '^[0-9a-f]{64}$' then
    raise exception 'FAIL(%): actor_hash is not a sha256 hex digest: %',
      current_setting('myvars.path', true), v_stored;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'owner_api_rate_limits'
      and column_name = 'actor_email'
  ) then
    raise exception 'FAIL(%): owner_api_rate_limits.actor_email is back', current_setting('myvars.path', true);
  end if;
  raise notice 'PASS(%): the limiter stores a digest and no actor_email column exists',
    current_setting('myvars.path', true);
end $$;

-- 2. The limiter still partitions callers and still trips its cap.
do $$
declare
  v_buckets integer;
  v_allowed boolean;
begin
  -- Same address, different casing and a trailing space: still one bucket.
  perform public.check_owner_rate_limit('anna@example.dk ', 'mobile.address_suggest', 3, 3600);
  select count(*) into v_buckets from public.owner_api_rate_limits;
  if v_buckets is distinct from 1 then
    raise exception 'FAIL(%): normalisation broke -- one actor produced % buckets',
      current_setting('myvars.path', true), v_buckets;
  end if;

  -- A different address must NOT share the bucket, or a per-user cap became global.
  perform public.check_owner_rate_limit('bo@example.dk', 'mobile.address_suggest', 3, 3600);
  select count(*) into v_buckets from public.owner_api_rate_limits;
  if v_buckets is distinct from 2 then
    raise exception 'FAIL(%): two actors collapsed into % bucket(s) -- the per-user limit is now global',
      current_setting('myvars.path', true), v_buckets;
  end if;

  -- Third call is the cap; the fourth must be refused.
  select allowed into v_allowed from public.check_owner_rate_limit('anna@example.dk', 'mobile.address_suggest', 3, 3600);
  if v_allowed is not true then
    raise exception 'FAIL(%): the limiter refused the third of three allowed calls',
      current_setting('myvars.path', true);
  end if;
  select allowed into v_allowed from public.check_owner_rate_limit('anna@example.dk', 'mobile.address_suggest', 3, 3600);
  if v_allowed is not false then
    raise exception 'FAIL(%): the limiter allowed a fourth call past a cap of three',
      current_setting('myvars.path', true);
  end if;
  raise notice 'PASS(%): one actor stays one bucket, two actors stay two, and the cap still trips',
    current_setting('myvars.path', true);
end $$;

-- 3. service_role can read the counters but cannot re-identify them.
do $$
declare
  v_leaked text;
begin
  begin
    set local role service_role;
    select pepper into v_leaked from public.rate_limit_actor_pepper;
    reset role;
    raise exception 'FAIL(%): service_role read the pepper -- every digest is re-identifiable',
      current_setting('myvars.path', true);
  exception when insufficient_privilege then
    reset role;
  end;

  begin
    set local role service_role;
    select public.hash_rate_limit_actor('anna@example.dk') into v_leaked;
    reset role;
    raise exception 'FAIL(%): service_role called hash_rate_limit_actor -- digests can be recomputed for any address',
      current_setting('myvars.path', true);
  exception when insufficient_privilege then
    reset role;
  end;
  raise notice 'PASS(%): service_role reaches neither the pepper nor the hash helper',
    current_setting('myvars.path', true);
end $$;

-- 4a. Retention purges stale counters -- and still purges workspaces (GV-316).
do $$
declare
  v_report jsonb;
  v_remaining integer;
begin
  update public.owner_api_rate_limits
  set window_started_at = now() - interval '40 days'
  where actor_hash = public.hash_rate_limit_actor('bo@example.dk');

  -- `is distinct from`, never `<>`: a reverted function returns a report with the key
  -- MISSING, so ->> yields NULL and `NULL <> 1` is NULL — the `if` never fires and the
  -- guard silently passes the exact regression it exists to catch. Mutation-tested:
  -- with run_operational_retention reverted to migration 132, `<>` here reported PASS.
  v_report := public.run_operational_retention(180, true);
  if (v_report ->> 'deletedRateLimitCounters')::integer is distinct from 1 then
    raise exception 'FAIL(%): dry run reported % stale counters, expected 1',
      current_setting('myvars.path', true), coalesce(v_report ->> 'deletedRateLimitCounters', '<key absent>');
  end if;
  if (v_report ->> 'rateLimitRetentionDays')::integer is distinct from 30 then
    raise exception 'FAIL(%): retention window is %, expected 30 days',
      current_setting('myvars.path', true), coalesce(v_report ->> 'rateLimitRetentionDays', '<key absent>');
  end if;
  -- The first draft of migration 149 re-declared this function off 131 instead of 132
  -- and silently reverted the GV-316 workspace purge. Keep that regression named.
  if not (v_report ? 'purgedWorkspaces') then
    raise exception 'FAIL(%): run_operational_retention lost purgedWorkspaces -- it was re-declared off a definition that predates GV-316',
      current_setting('myvars.path', true);
  end if;

  v_report := public.run_operational_retention(180, false);
  if (v_report ->> 'deletedRateLimitCounters')::integer is distinct from 1 then
    raise exception 'FAIL(%): the sweep deleted % stale counters, expected 1',
      current_setting('myvars.path', true), coalesce(v_report ->> 'deletedRateLimitCounters', '<key absent>');
  end if;
  select count(*) into v_remaining from public.owner_api_rate_limits;
  if v_remaining is distinct from 1 then
    raise exception 'FAIL(%): the sweep left % counters, expected only the fresh one',
      current_setting('myvars.path', true), v_remaining;
  end if;
  raise notice 'PASS(%): stale counters expire at 30 days, fresh ones survive, workspaces still purge',
    current_setting('myvars.path', true);
end $$;

-- 4b. Account deletion reaches the counter.
do $$
declare
  v_before integer;
  v_after integer;
begin
  insert into auth.users (id, email)
  values ('33333333-3333-3333-3333-333333333333', 'anna@example.dk')
  on conflict (id) do nothing;

  select count(*) into v_before from public.owner_api_rate_limits
  where actor_hash = public.hash_rate_limit_actor('anna@example.dk');
  if v_before is distinct from 1 then
    raise exception 'FAIL(%): expected one counter for the account about to be deleted, found %',
      current_setting('myvars.path', true), v_before;
  end if;

  perform set_config(
    'request.jwt.claims',
    '{"sub":"33333333-3333-3333-3333-333333333333","email":"anna@example.dk","role":"authenticated"}',
    true
  );
  perform public.delete_my_account();
  perform set_config('request.jwt.claims', '', true);

  select count(*) into v_after from public.owner_api_rate_limits
  where actor_hash = public.hash_rate_limit_actor('anna@example.dk');
  if v_after is distinct from 0 then
    raise exception 'FAIL(%): delete_my_account left % throttle counter(s) behind -- the article 17 hole is back',
      current_setting('myvars.path', true), v_after;
  end if;
  raise notice 'PASS(%): delete_my_account erases the caller''s throttle counters',
    current_setting('myvars.path', true);
end $$;
SQL
done

echo "ok - owner_api_rate_limits stores peppered digests, still throttles per actor, expires at 30 days, and is reached by account deletion (GV-385)"

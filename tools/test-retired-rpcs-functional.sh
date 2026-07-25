#!/bin/bash
# Functional regression test for migration 147 (GV-311, GV-383, GV-392).
#
# Three properties, none of which a structural check can see.
#
# 1. GV-383 — the ten dropped functions are GONE, and fuel_ledger_healthcheck no
#    longer ASKS for them. Schema-equivalence proves both paths agree; it cannot tell
#    you the operator diagnostic now reports a permanent false alarm, because a
#    healthcheck that says `"create_ledger_invite": false` is structurally identical
#    to one that says true. Only running it shows that. The same applies to the
#    dropped table's entries in expected_tables/expected_columns and to the three
#    invite-RPC probes in workspace_readiness.invite_onboarding_ready.
#
# 2. GV-311 — delete_my_account still works after push_subscriptions was dropped
#    underneath it. PL/pgSQL resolves table references at RUN time, so a stale
#    `delete from public.push_subscriptions` would pass every structural check in this
#    repo and then fail in production the first time somebody deleted their account.
#    The only way to know is to delete an account.
#
# 3. GV-392 — THE REAL REGRESSION TEST. Both replay paths must produce the same number
#    of tracker rows, and that number must be the number of migration files. The
#    consolidated schema was missing three INSERTs (146 rows from the migrations, 143
#    from supabase-schema.sql), so a fresh install booted reporting its own drift. The
#    count is derived from the directory listing rather than hardcoded, so this stays
#    true for migration 148 without anyone remembering to edit it.
#
# Both databases are checked, because the failure being guarded against is precisely
# the two paths disagreeing.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-retired-rpcs-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the retired-RPC functional test." >&2
  exit 1
fi

EXPECTED_MIGRATIONS="$(find "$REPO/supabase/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"

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
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL
}

prelude schema_path
prelude migrations_path

PSQL schema_path -f /repo/supabase-schema.sql >/dev/null

for f in $(docker exec "${C}" sh -c "ls /repo/supabase/migrations/*.sql | sort"); do
  PSQL migrations_path -f "$f" >/dev/null
done

# ── The assertions, run identically against BOTH replay paths ─────────────────
for DB in schema_path migrations_path; do
  PSQL "$DB" -v expected_migrations="${EXPECTED_MIGRATIONS}" -v path="${DB}" <<'SQL'
\set ON_ERROR_STOP on

-- Carry the two shell-supplied values into GUCs so the DO blocks can read them.
\o /dev/null
select set_config('myvars.expected_migrations', :'expected_migrations', false);
select set_config('myvars.path', :'path', false);
\o

-- 1. The ten functions are gone (GV-383).
do $$
declare
  v_left text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'set_ledger_member_active_admin', 'create_ledger_invite', 'revoke_ledger_invite',
      'check_ledger_invite_email', 'update_own_ledger_member_profile',
      'apply_payment_status_action', 'purge_generated_test_rows', 'upsert_test_lab_report',
      'preview_retention_cleanup', 'run_retention_cleanup'
    );
  if v_left is not null then
    raise exception 'FAIL(%): migration 147 should have dropped these, but they survive: %',
      current_setting('myvars.path', true), v_left;
  end if;
end $$;

-- 2. The legacy Web Push table is gone (GV-311).
do $$
begin
  if to_regclass('public.push_subscriptions') is not null then
    raise exception 'FAIL: public.push_subscriptions survives migration 147';
  end if;
end $$;

-- 3. What migration 147 deliberately did NOT remove. A drop list is only safe if the
--    things next to it on the list survive: enforce_onboarding_rate_limit sits in
--    critical_rpc_names with no client caller but has five in-SQL callers, and
--    ledger_invites is write-closed rather than dead (still read by resolve/redeem,
--    still updated by delete_my_account).
do $$
declare
  v_missing text;
begin
  select string_agg(want.name, ', ' order by want.name) into v_missing
  from (values
    ('enforce_onboarding_rate_limit'), ('hash_ledger_invite_code'), ('normalize_ledger_slug'),
    ('resolve_ledger_invite'), ('redeem_ledger_invite'), ('rotate_workspace_join_code'),
    ('delete_my_account'), ('upsert_ledger_member_admin'), ('transition_settlement_request_status'),
    ('run_operational_retention'), ('set_member_name'), ('update_own_ledger_member_mobilepay')
  ) as want(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = want.name
  );
  if v_missing is not null then
    raise exception 'FAIL: migration 147 removed functions it must keep: %', v_missing;
  end if;

  select string_agg(want.name, ', ' order by want.name) into v_missing
  from (values ('ledger_invites'), ('test_lab_reports'), ('expo_push_tokens')) as want(name)
  where to_regclass('public.' || want.name) is null;
  if v_missing is not null then
    raise exception 'FAIL: migration 147 removed tables it must keep: %', v_missing;
  end if;
end $$;

-- 4. delete_my_account no longer names the dropped table anywhere in its body.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_my_account'
      and p.prosrc like '%push_subscriptions%'
  ) then
    raise exception 'FAIL: delete_my_account still references push_subscriptions';
  end if;
  -- ...and still scrubs the store that replaced it.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_my_account'
      and p.prosrc like '%expo_push_tokens%'
  ) then
    raise exception 'FAIL: delete_my_account no longer scrubs expo_push_tokens';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_my_account'
      and p.prosrc like '%ledger_invites%'
  ) then
    raise exception 'FAIL: delete_my_account no longer scrubs ledger_invites (it is the reason the table stays)';
  end if;
end $$;

-- 5. THE HEALTHCHECK'S OWN LISTS. This is the coupling that made 147 one migration
--    rather than eleven: drop first and the diagnostic reports, forever, that objects
--    are missing which it is itself the only thing still asking for.
do $$
declare
  v_health jsonb;
  v_named text;
begin
  v_health := public.fuel_ledger_healthcheck('no-such-ledger');

  select string_agg(k, ', ' order by k) into v_named
  from jsonb_object_keys(v_health -> 'critical_rpcs') as k
  where k in (
    'set_ledger_member_active_admin', 'create_ledger_invite', 'revoke_ledger_invite',
    'check_ledger_invite_email', 'update_own_ledger_member_profile',
    'apply_payment_status_action', 'purge_generated_test_rows', 'upsert_test_lab_report',
    'preview_retention_cleanup', 'run_retention_cleanup'
  );
  if v_named is not null then
    raise exception 'FAIL: fuel_ledger_healthcheck still enumerates dropped functions in critical_rpc_names: %', v_named;
  end if;

  -- Every surviving entry must resolve to true. One false here IS the false alarm.
  select string_agg(k, ', ' order by k) into v_named
  from jsonb_each(v_health -> 'critical_rpcs') as e(k, v)
  where v <> 'true'::jsonb;
  if v_named is not null then
    raise exception 'FAIL: fuel_ledger_healthcheck reports critical RPCs missing: %', v_named;
  end if;

  -- enforce_onboarding_rate_limit is the one that looked droppable and is not.
  if not (v_health -> 'critical_rpcs' ? 'enforce_onboarding_rate_limit') then
    raise exception 'FAIL: enforce_onboarding_rate_limit was removed from critical_rpc_names — it has five live in-SQL callers';
  end if;

  -- The dropped TABLE was also enumerated, in two more lists.
  if (v_health -> 'schema_drift' -> 'missing_tables') <> '[]'::jsonb then
    raise exception 'FAIL: healthcheck reports missing tables: %', v_health -> 'schema_drift' -> 'missing_tables';
  end if;
  if (v_health -> 'schema_drift' -> 'missing_columns') <> '[]'::jsonb then
    raise exception 'FAIL: healthcheck reports missing columns: %', v_health -> 'schema_drift' -> 'missing_columns';
  end if;
  if (v_health -> 'schema_drift' -> 'missing_policies') <> '[]'::jsonb then
    raise exception 'FAIL: healthcheck reports missing policies: %', v_health -> 'schema_drift' -> 'missing_policies';
  end if;

  -- ...and three of the dropped functions again, as existence probes.
  if not (v_health -> 'workspace_readiness' ->> 'invite_onboarding_ready')::boolean then
    raise exception 'FAIL: workspace_readiness.invite_onboarding_ready is false — it still probes for dropped invite RPCs';
  end if;
  if not (v_health -> 'workspace_readiness' ->> 'workspace_foundation_ready')::boolean then
    raise exception 'FAIL: workspace_readiness.workspace_foundation_ready is false';
  end if;
  if not (v_health -> 'workspace_readiness' ->> 'abuse_rate_limit_ready')::boolean then
    raise exception 'FAIL: workspace_readiness.abuse_rate_limit_ready is false';
  end if;
end $$;

-- 6. GV-392: the tracker rows. Every migration file must have produced a row on THIS
--    replay path. From supabase-schema.sql this is the regression test — three rows
--    were missing and a fresh install reported its own drift, while the mirror guard
--    stayed green because the ids appeared inside the healthcheck's expectation list.
do $$
declare
  v_count integer;
  v_expected integer := current_setting('myvars.expected_migrations')::integer;
  v_missing text;
begin
  select count(*) into v_count from public.fuel_ledger_schema_migrations;
  if v_count <> v_expected then
    raise exception 'FAIL(%): % tracker rows, expected % (one per migration file). GV-392 was this exact symptom.',
      current_setting('myvars.path', true), v_count, v_expected;
  end if;

  -- Named explicitly: these three are the ones the substring guard could not see.
  select string_agg(want.id, ', ' order by want.id) into v_missing
  from (values
    ('024_schema_drift_healthcheck'),
    ('033_onboarding_rate_limit_scope_key_alignment'),
    ('036_invite_profile_setup'),
    ('147_retire_dead_rpcs_and_legacy_push_subscriptions')
  ) as want(id)
  where not exists (
    select 1 from public.fuel_ledger_schema_migrations m where m.migration_id = want.id
  );
  if v_missing is not null then
    raise exception 'FAIL(%): tracker rows missing: %', current_setting('myvars.path', true), v_missing;
  end if;

  -- The healthcheck's own verdict on the same question.
  if not (public.fuel_ledger_healthcheck('no-such-ledger') -> 'schema_migrations' ->> 'ok')::boolean then
    raise exception 'FAIL(%): the healthcheck reports missing migrations against itself: %',
      current_setting('myvars.path', true),
      public.fuel_ledger_healthcheck('no-such-ledger') -> 'schema_migrations' -> 'missing_migrations';
  end if;
end $$;
SQL
done

# ── 7. delete_my_account still RUNS with the table gone (GV-311) ──────────────
# PL/pgSQL resolves table references at run time. A stale reference to the dropped
# table passes every structural check in this repo and then throws 42P01 the first
# time a real user deletes their account. Run it against the consolidated schema.
PSQL schema_path <<'SQL'
insert into auth.users (id, email) values
  ('20000000-0000-0000-0000-000000000001', 'sletter@test.dk')
on conflict do nothing;

insert into public.ledgers (id, name, slug) values ('gdpr-ws', 'GDPR ws', 'gdpr-ws');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('30000000-0000-0000-0000-000000000001', 'gdpr-ws', 'Sletter Sletsen', 'sletter@test.dk', 'admin', true),
  ('30000000-0000-0000-0000-000000000002', 'gdpr-ws', 'Bliver Blivsen', 'bliver@test.dk', 'admin', true);

insert into public.expo_push_tokens (user_id, email, token)
values ('20000000-0000-0000-0000-000000000001', 'sletter@test.dk', 'ExponentPushToken[gv311test]');

\o /dev/null
select set_config('request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000001","email":"sletter@test.dk","role":"authenticated"}', false);
\o
set role authenticated;

do $$
declare
  v_result jsonb;
begin
  v_result := public.delete_my_account();
  if (v_result ->> 'ledgers_scrubbed')::integer < 1 then
    raise exception 'FAIL: delete_my_account scrubbed no ledgers: %', v_result;
  end if;
end $$;

reset role;

do $$
begin
  if exists (select 1 from public.expo_push_tokens where email = 'sletter@test.dk') then
    raise exception 'FAIL: delete_my_account left an expo push token behind';
  end if;
  if exists (select 1 from auth.users where email = 'sletter@test.dk') then
    raise exception 'FAIL: delete_my_account left the auth user behind';
  end if;
  if exists (
    select 1 from public.ledger_members
    where id = '30000000-0000-0000-0000-000000000001' and email is not null
  ) then
    raise exception 'FAIL: delete_my_account left the membership email behind';
  end if;
end $$;
SQL

echo "ok - the ten dead RPCs and push_subscriptions are gone, fuel_ledger_healthcheck no longer asks for them, delete_my_account still runs, and both replay paths carry ${EXPECTED_MIGRATIONS} tracker rows (GV-311, GV-383, GV-392)"

#!/bin/bash
# Functional smoke test for delete_my_account + expo push tokens (GV-180).
#
# The migration guard (test-migrations.mjs) greps, and the schema-equivalence
# checker (check-schema-equivalence.mjs) proves the consolidated schema matches
# the migrations' STRUCTURE — but neither runs the RPCs. Migrations 056/057 wire
# a lot of behaviour that only a functional replay can prove: anonymize-and-scrub
# on account deletion, admin succession, PII scrubbing THROUGH the 046 settlement
# lock, snapshot_json name rewrites, sole-member ledger cascade, unique
# 'Slettet medlem N' naming, bystander integrity, and push-token
# registration/re-point/purge.
#
# This is that replay. It spins a disposable Postgres 17 (matching prod Supabase,
# which runs 17.x) via Docker, applies the consolidated schema with the same
# Supabase stubs the equivalence checker uses (+ an auth.users table and
# auth.uid(), which delete_my_account deletes from), seeds a realistic
# two-ledger dataset, runs the
# deletion as an impersonated JWT user, and asserts every scrub. Any failed
# assertion raises inside psql (ON_ERROR_STOP) and aborts the script with the
# reason. It doubles as the regression harness for ANY future RPC change touching
# deletion, tokens, or the settlement lock.
#
# Usage: bash tools/test-functional-smoke.sh   (also wired into CI, needs Docker)

set -euo pipefail

# Repo root derived from this script's location — works in CI and on any machine
# (no hardcoded absolute path).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-func-smoke-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
# Preserve the script's real exit status across cleanup, and assert the explicit
# completion marker: exiting 0 without having reached the final marker line means
# the script was cut short (e.g. a stray `exit 0` or a truncated heredoc) — turn
# that into a loud failure instead of a silent green.
smoke_completed=0
trap 'rc=$?; cleanup; if [ "$rc" -eq 0 ] && [ "$smoke_completed" -ne 1 ]; then echo "❌ Smoke script exited 0 WITHOUT reaching its completion marker — treat as failure." >&2; rc=1; fi; exit $rc' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker is not available (daemon not running?). This smoke test needs Docker to host disposable Postgres." >&2
  exit 1
fi

# Keep in step with the canonical IMAGE constant in tools/lib/replay-container.mjs
# (shell can't import it). Prod Supabase runs Postgres 17.x — GV-314.
PG_IMAGE="postgres:17-alpine"

echo "⏳ Starting ${PG_IMAGE} as ${C}…"
docker run -d --name "${C}" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO":/repo:ro "${PG_IMAGE}" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "${C}" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "❌ Postgres did not become ready within 60s." >&2
  exit 1
fi
# pg_isready can flip true across the bootstrap restart; settle briefly.
sleep 2

PSQL() { docker exec -i "${C}" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

echo "── prelude + schema"
PSQL <<'SQL'
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
SQL
PSQL -f /repo/supabase-schema.sql >/dev/null

echo "── seed"
PSQL <<'SQL'
-- Users
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'lars@test.dk'),
  ('22222222-2222-2222-2222-222222222222', 'ole@test.dk');

-- Shared ledger with three active members (Lars = sole admin)
insert into public.ledgers (id, name, slug) values ('test-car', 'Testbilen', 'test-car');
insert into public.ledger_members (id, ledger_id, name, email, mobilepay_phone, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'test-car', 'Lars Ørberg', 'lars@test.dk', '12345678', 'admin',  true, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'test-car', 'Mette Holm',  'mette@test.dk', null,      'member', true, now() - interval '20 days'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'test-car', 'Ole Kjær',    'ole@test.dk',  null,       'member', true, now() - interval '10 days');

-- Open period + closed period with a name-bearing snapshot
insert into public.settlement_periods (id, ledger_id, status, label) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'test-car', 'open', 'Denne periode');
insert into public.settlement_periods (id, ledger_id, status, label, closed_at, snapshot_json) values
  ('bbbbbbbb-0000-0000-0000-000000000002', 'test-car', 'closed', 'Juni', now() - interval '5 days',
   '{"label":"Juni","entryFingerprint":"{\"trips\":[],\"fuel\":[]}",
     "people":[{"id":"aaaaaaaa-0000-0000-0000-000000000001","name":"Lars Ørberg","net":-52},
               {"id":"aaaaaaaa-0000-0000-0000-000000000002","name":"Mette Holm","net":52}],
     "settlements":[{"fromId":"aaaaaaaa-0000-0000-0000-000000000001","fromName":"Lars Ørberg",
                     "toId":"aaaaaaaa-0000-0000-0000-000000000002","toName":"Mette Holm",
                     "amount":52,"status":"paid"}]}'::jsonb);

-- Entries BEFORE the settlement request (046 blocks inserts once locked)
insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km, note, created_by_member_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'test-car', 'bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', current_date, 1000, 1100, 'Tur til sommerhuset',
   'aaaaaaaa-0000-0000-0000-000000000001');
insert into public.trip_participants (trip_id, member_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002');
insert into public.fuel_payments (id, ledger_id, period_id, payer_member_id, payment_date, amount, station_lat, station_lng, created_by_member_id) values
  ('dddddddd-0000-0000-0000-000000000001', 'test-car', 'bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', current_date, 300.00, 56.16, 10.21,
   'aaaaaaaa-0000-0000-0000-000000000001');

-- Requested settlement => the 046 lock is ACTIVE for the open period.
-- The request-integrity trigger requires the recipient to create it.
select set_config('request.jwt.claims', '{"email":"lars@test.dk","role":"authenticated"}', false);
insert into public.settlement_requests (ledger_id, period_id, from_member_id, to_member_id, amount, status, requested_at) values
  ('test-car', 'bbbbbbbb-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   150.00, 'requested', now());

-- Bookings (one future, one past), chat, feed event, invite
insert into public.car_bookings (id, ledger_id, member_id, start_at, end_at, purpose, created_by_member_id) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'test-car', 'aaaaaaaa-0000-0000-0000-000000000001',
   now() + interval '2 days', now() + interval '3 days', 'Weekendtur', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'test-car', 'aaaaaaaa-0000-0000-0000-000000000001',
   now() - interval '9 days', now() - interval '8 days', 'Gammel tur', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into public.messages (id, ledger_id, sender_member_id, body) values
  ('ffffffff-0000-0000-0000-000000000001', 'test-car', 'aaaaaaaa-0000-0000-0000-000000000001', 'Hej med jer');
insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email) values
  ('test-car', 'trip_created', 'Lars loggede en tur', '100 km · Tur til sommerhuset',
   'aaaaaaaa-0000-0000-0000-000000000001', 'lars@test.dk');
insert into public.ledger_invites (ledger_id, invite_code_hash, invited_email, created_by_member_id) values
  ('test-car', 'deadbeef', 'lars@test.dk', 'aaaaaaaa-0000-0000-0000-000000000001');

-- Identity-keyed rows
insert into public.push_subscriptions (user_email, subscription) values ('lars@test.dk', '{}'::jsonb);
insert into public.ledger_onboarding_rate_limits (action, actor_email) values ('create_invite', 'lars@test.dk');
insert into public.owner_activity_log (actor_user_id, actor_email, action) values
  ('11111111-1111-1111-1111-111111111111', 'lars@test.dk', 'test');

-- Second ledger where Lars is the only active member -> must be deleted outright
insert into public.ledgers (id, name, slug) values ('solo-car', 'Solobilen', 'solo-car');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'solo-car', 'Lars Ørberg', 'lars@test.dk', 'admin', true);
insert into public.settlement_periods (ledger_id, status, label) values ('solo-car', 'open', 'x');
SQL

echo "── push tokens (migration 057): register via RPC as Lars + Mette"
PSQL <<'SQL'
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"lars@test.dk","role":"authenticated"}', false);
select public.upsert_push_token('ExponentPushToken[lars-1]', 'ios');
select public.upsert_push_token('ExponentPushToken[lars-2]', 'android');
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","email":"mette@test.dk","role":"authenticated"}', false);
select public.upsert_push_token('ExponentPushToken[mette-1]', 'ios');
-- Shared-device re-point: Mette signs in on Lars's old phone → the token row
-- must move to her, not duplicate.
select public.upsert_push_token('ExponentPushToken[lars-2]', 'android');
do $$
begin
  if (select count(*) from public.expo_push_tokens) <> 3
    then raise exception 'FAIL token count: %', (select count(*) from public.expo_push_tokens); end if;
  if (select email from public.expo_push_tokens where token = 'ExponentPushToken[lars-2]') <> 'mette@test.dk'
    then raise exception 'FAIL shared-device token did not re-point'; end if;
  raise notice 'PASS: token registration + re-point';
end $$;
-- Point it back at Lars so the deletion purge below has 2 rows to kill.
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"lars@test.dk","role":"authenticated"}', false);
select public.upsert_push_token('ExponentPushToken[lars-2]', 'android');
SQL

echo "── run delete_my_account() as Lars"
PSQL <<'SQL'
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"lars@test.dk","role":"authenticated"}', false);
select public.delete_my_account();
SQL

echo "── assertions"
PSQL <<'SQL'
do $$
declare m record; t record; f record; e record; snap jsonb; r record;
begin
  -- a. member anonymized
  select * into m from public.ledger_members where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if m.name <> 'Slettet medlem' or m.email is not null or m.mobilepay_phone is not null
     or m.is_active or m.role <> 'member' then
    raise exception 'FAIL member anonymization: %', to_jsonb(m);
  end if;

  -- b. successor promoted (Mette, oldest remaining active)
  select * into m from public.ledger_members where id = 'aaaaaaaa-0000-0000-0000-000000000002';
  if m.role <> 'admin' then raise exception 'FAIL admin succession: %', to_jsonb(m); end if;
  if not exists (select 1 from public.ledger_events
                 where ledger_id = 'test-car' and event_type = 'member_promoted'
                   and target_member_id = 'aaaaaaaa-0000-0000-0000-000000000002') then
    raise exception 'FAIL missing promotion event';
  end if;

  -- c. trip: note scrubbed DESPITE the 046 lock, km intact
  select * into t from public.trips where id = 'cccccccc-0000-0000-0000-000000000001';
  if t.note is not null then raise exception 'FAIL trip note not scrubbed'; end if;
  if t.start_km <> 1000 or t.end_km <> 1100 then raise exception 'FAIL trip km changed!'; end if;

  -- d. fuel: user-GPS columns dropped outright (migration 071, GV-196 — the
  -- strongest form of "user coords scrubbed"); amount + station coords intact
  select * into f from public.fuel_payments where id = 'dddddddd-0000-0000-0000-000000000001';
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'fuel_payments'
      and column_name in ('user_lat', 'user_lng')
  ) then raise exception 'FAIL fuel user-GPS columns still exist'; end if;
  if f.amount <> 300.00 or f.station_lat is null then raise exception 'FAIL fuel financial/station data changed!'; end if;

  -- e. bookings: future cancelled, both purposes scrubbed, past not deleted
  if (select deleted_at from public.car_bookings where id = 'eeeeeeee-0000-0000-0000-000000000001') is null
     then raise exception 'FAIL future booking not cancelled'; end if;
  if (select deleted_at from public.car_bookings where id = 'eeeeeeee-0000-0000-0000-000000000002') is not null
     then raise exception 'FAIL past booking wrongly deleted'; end if;
  if exists (select 1 from public.car_bookings where ledger_id = 'test-car' and purpose is not null)
     then raise exception 'FAIL booking purpose not scrubbed'; end if;

  -- f. message blanked + soft-deleted
  if exists (select 1 from public.messages where id = 'ffffffff-0000-0000-0000-000000000001'
             and (body <> '' or deleted_at is null))
     then raise exception 'FAIL message scrub'; end if;

  -- g. event: email nulled, name replaced in title
  select * into e from public.ledger_events where ledger_id = 'test-car' and event_type = 'trip_created';
  if e.actor_email is not null then raise exception 'FAIL event actor_email'; end if;
  if e.title <> 'Slettet medlem loggede en tur' then raise exception 'FAIL event title: %', e.title; end if;

  -- h. snapshot names rewritten for Lars only, amounts intact
  select snapshot_json into snap from public.settlement_periods
    where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if snap -> 'people' -> 0 ->> 'name' <> 'Slettet medlem' then raise exception 'FAIL snapshot people: %', snap; end if;
  if snap -> 'people' -> 1 ->> 'name' <> 'Mette Holm' then raise exception 'FAIL snapshot touched Mette: %', snap; end if;
  if snap -> 'settlements' -> 0 ->> 'fromName' <> 'Slettet medlem'
     or snap -> 'settlements' -> 0 ->> 'toName' <> 'Mette Holm'
     or (snap -> 'settlements' -> 0 ->> 'amount')::numeric <> 52
     then raise exception 'FAIL snapshot settlements: %', snap; end if;

  -- i. solo ledger fully gone
  if exists (select 1 from public.ledgers where id = 'solo-car') then raise exception 'FAIL solo ledger survived'; end if;
  if exists (select 1 from public.ledger_members where ledger_id = 'solo-car') then raise exception 'FAIL solo members survived'; end if;

  -- j. identity-keyed rows
  if exists (select 1 from public.push_subscriptions where lower(user_email) = 'lars@test.dk')
     then raise exception 'FAIL push subscription survived'; end if;
  if exists (select 1 from public.ledger_onboarding_rate_limits where lower(actor_email) = 'lars@test.dk')
     then raise exception 'FAIL rate-limit row survived'; end if;
  if exists (select 1 from public.owner_activity_log
             where actor_user_id is not null or actor_email is not null)
     then raise exception 'FAIL owner_activity_log identifiers survived'; end if;
  if exists (select 1 from public.ledger_invites where lower(coalesce(invited_email,'')) = 'lars@test.dk')
     then raise exception 'FAIL invite email survived'; end if;

  -- k. auth user gone, financial record (settlement request) retained
  if exists (select 1 from auth.users where id = '11111111-1111-1111-1111-111111111111')
     then raise exception 'FAIL auth user survived'; end if;
  if not exists (select 1 from public.settlement_requests where ledger_id = 'test-car' and amount = 150.00)
     then raise exception 'FAIL settlement request was deleted (must be retained)'; end if;

  -- k2. push tokens purged for Lars only (migration 057)
  if exists (select 1 from public.expo_push_tokens where lower(email) = 'lars@test.dk'
             or user_id = '11111111-1111-1111-1111-111111111111')
     then raise exception 'FAIL push tokens survived deletion'; end if;
  if not exists (select 1 from public.expo_push_tokens where token = 'ExponentPushToken[mette-1]')
     then raise exception 'FAIL bystander push token was purged'; end if;

  -- l. feed transparency event
  if not exists (select 1 from public.ledger_events where ledger_id = 'test-car' and event_type = 'member_deleted')
     then raise exception 'FAIL missing member_deleted event'; end if;

  raise notice 'PASS: all first-deletion assertions';
end $$;
SQL

echo "── second deletion (Ole) — unique anonymized name"
PSQL <<'SQL'
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","email":"ole@test.dk","role":"authenticated"}', false);
select public.delete_my_account();
do $$
begin
  if (select name from public.ledger_members where id = 'aaaaaaaa-0000-0000-0000-000000000003')
     <> 'Slettet medlem 2'
    then raise exception 'FAIL second anonymized name: %',
      (select name from public.ledger_members where id = 'aaaaaaaa-0000-0000-0000-000000000003');
  end if;
  -- Mette (last one standing) must be untouched and still admin
  if not exists (select 1 from public.ledger_members
                 where id = 'aaaaaaaa-0000-0000-0000-000000000002'
                   and email = 'mette@test.dk' and role = 'admin' and is_active)
    then raise exception 'FAIL bystander member was touched';
  end if;
  raise notice 'PASS: second deletion + bystander integrity';
end $$;
SQL

# Explicit completion marker — the EXIT trap fails the run if the script exits 0
# without having set this flag.
smoke_completed=1
echo "✅ delete_my_account functional smoke: ALL PASS"

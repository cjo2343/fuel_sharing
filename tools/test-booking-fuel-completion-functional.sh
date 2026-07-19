#!/bin/bash
# Functional regression test for migration 136's atomic booking/fuel command.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-booking-fuel-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the booking fuel-completion functional test." >&2
  exit 1
fi

docker run -d --name "${C}" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO":/repo:ro postgres:15-alpine >/dev/null

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

PSQL() { docker exec -i "${C}" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

PSQL <<'SQL'
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
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL

PSQL -f /repo/supabase-schema.sql >/dev/null

PSQL <<'SQL'
insert into public.ledgers (id, name, slug) values
  ('fuel-flow', 'Fuel flow', 'fuel-flow');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'fuel-flow', 'Driver', 'driver@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'fuel-flow', 'Other', 'other@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000003', 'fuel-flow', 'Admin', 'admin@test.dk', 'admin', true);

insert into public.settlement_periods (id, ledger_id, status, label) values
  ('20000000-0000-0000-0000-000000000001', 'fuel-flow', 'open', 'Open');

insert into public.car_bookings (
  id, legacy_id, ledger_id, member_id, start_at, end_at, purpose, created_by_member_id
) values
  ('30000000-0000-0000-0000-000000000001', 'booking-logged', 'fuel-flow',
   '10000000-0000-0000-0000-000000000001',
   date_trunc('day', now() - interval '2 days') + interval '8 hours',
   date_trunc('day', now() - interval '2 days') + interval '9 hours',
   'Logged fuel', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', 'booking-rollback', 'fuel-flow',
   '10000000-0000-0000-0000-000000000001',
   date_trunc('day', now() - interval '2 days') + interval '10 hours',
   date_trunc('day', now() - interval '2 days') + interval '11 hours',
   'Rollback', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000003', 'booking-deferred', 'fuel-flow',
   '10000000-0000-0000-0000-000000000001',
   date_trunc('day', now() - interval '2 days') + interval '12 hours',
   date_trunc('day', now() - interval '2 days') + interval '13 hours',
   'Deferred', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000004', 'booking-unauthorized', 'fuel-flow',
   '10000000-0000-0000-0000-000000000001',
   date_trunc('day', now() - interval '2 days') + interval '14 hours',
   date_trunc('day', now() - interval '2 days') + interval '15 hours',
   'Unauthorized', '10000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claims', '{"email":"driver@test.dk","role":"authenticated"}', false);
set role authenticated;

-- First completion writes one linked trip and one real fuel payment atomically.
select public.complete_booking_trip_with_fuel(
  'fuel-flow',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'trip-attempt-1',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  1000,
  1100,
  'Skagen',
  array['10000000-0000-0000-0000-000000000001'::uuid],
  'logged',
  'fuel-attempt-1',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  500,
  'DKK',
  25,
  20,
  1060,
  'Circle K',
  'Circle K',
  57.0,
  10.0,
  false,
  'Tur registreret',
  '100 km',
  'Tankning registreret',
  '25 L'
);

-- Another device retries with new local keys and corrected values. Both durable
-- rows must be reused, with no duplicate activity events.
select public.complete_booking_trip_with_fuel(
  'fuel-flow',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'trip-attempt-2',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  1000,
  1112,
  'Skagen corrected',
  array[
    '10000000-0000-0000-0000-000000000001'::uuid,
    '10000000-0000-0000-0000-000000000002'::uuid
  ],
  'logged',
  'fuel-attempt-2',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  525,
  'DKK',
  25,
  21,
  1060,
  'Circle K',
  'Circle K',
  57.0,
  10.0,
  false,
  'Tur registreret',
  '112 km',
  'Tankning registreret',
  '25 L'
);

do $$
declare
  linked_trip public.trips%rowtype;
begin
  if (select count(*) from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 1 then
    raise exception 'FAIL: retry created more than one trip';
  end if;

  select * into linked_trip
  from public.trips
  where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null;

  if linked_trip.legacy_id <> 'trip-attempt-1'
     or linked_trip.end_km <> 1112
     or linked_trip.fuel_resolution <> 'logged'
     or linked_trip.completion_fuel_legacy_id <> 'fuel-attempt-1' then
    raise exception 'FAIL: linked trip was not replayed correctly: %', to_jsonb(linked_trip);
  end if;

  if (select count(*) from public.fuel_payments where ledger_id = 'fuel-flow' and deleted_at is null) <> 1 then
    raise exception 'FAIL: retry created more than one fuel payment';
  end if;

  if (select amount from public.fuel_payments where ledger_id = 'fuel-flow' and legacy_id = 'fuel-attempt-1') <> 525 then
    raise exception 'FAIL: retry did not update the original fuel payment';
  end if;

  if (select count(*) from public.ledger_events where event_type = 'trip_created') <> 1 then
    raise exception 'FAIL: retry emitted duplicate trip events';
  end if;
  if (select count(*) from public.ledger_events where event_type = 'fuel_created') <> 1 then
    raise exception 'FAIL: retry emitted duplicate fuel events';
  end if;
end $$;

-- A stale pre-refuel replay may reconcile trip details but cannot downgrade the
-- newer logged resolution or detach its fuel payment.
select public.complete_booking_trip_with_fuel(
  'fuel-flow', '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'stale-trip-key',
  '10000000-0000-0000-0000-000000000001', current_date - 2,
  1000, 1112, 'Stale replay',
  array['10000000-0000-0000-0000-000000000001'::uuid],
  'deferred'
);

do $$
begin
  if (select fuel_resolution from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 'logged' then
    raise exception 'FAIL: stale replay downgraded logged fuel';
  end if;
end $$;

-- A fuel authorization failure happens after the trip sub-command, but the outer
-- transaction must roll the trip back too.
do $$
begin
  perform public.complete_booking_trip_with_fuel(
    'fuel-flow', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002', 'rollback-trip',
    '10000000-0000-0000-0000-000000000001', current_date - 2,
    2000, 2100, null, array['10000000-0000-0000-0000-000000000001'::uuid],
    'logged', 'rollback-fuel',
    '10000000-0000-0000-0000-000000000002', current_date - 2, 300
  );
  raise exception 'FAIL: driver logged fuel paid by another member';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  if exists (select 1 from public.trips where booking_id = '30000000-0000-0000-0000-000000000002') then
    raise exception 'FAIL: fuel failure left a partial trip';
  end if;
  if exists (select 1 from public.fuel_payments where legacy_id = 'rollback-fuel') then
    raise exception 'FAIL: fuel failure left a partial fuel payment';
  end if;
end $$;

-- Non-logged resolutions reject hidden fuel payloads before writing anything.
do $$
begin
  perform public.complete_booking_trip_with_fuel(
    'fuel-flow', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000003', 'invalid-payload-trip',
    '10000000-0000-0000-0000-000000000001', current_date - 2,
    3000, 3100, null, array['10000000-0000-0000-0000-000000000001'::uuid],
    'deferred', 'hidden-fuel'
  );
  raise exception 'FAIL: deferred completion accepted fuel payload';
exception
  when invalid_parameter_value then null;
end $$;

select public.complete_booking_trip_with_fuel(
  'fuel-flow', '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000003', 'deferred-trip',
  '10000000-0000-0000-0000-000000000001', current_date - 2,
  3000, 3100, null, array['10000000-0000-0000-0000-000000000001'::uuid],
  'deferred'
);

-- The direct-write trigger independently rejects a false logged claim.
do $$
begin
  update public.trips
  set fuel_resolution = 'logged', completion_fuel_legacy_id = 'missing-fuel'
  where booking_id = '30000000-0000-0000-0000-000000000003';
  raise exception 'FAIL: direct update claimed a missing fuel payment';
exception
  when check_violation then null;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"other@test.dk","role":"authenticated"}', false);
set role authenticated;

-- An ordinary member cannot complete another member's booking through the wrapper.
do $$
begin
  perform public.complete_booking_trip_with_fuel(
    'fuel-flow', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000004', 'unauthorized-trip',
    '10000000-0000-0000-0000-000000000001', current_date - 2,
    4000, 4100, null, array['10000000-0000-0000-0000-000000000001'::uuid],
    'not_needed'
  );
  raise exception 'FAIL: non-driver completed another member''s booking';
exception
  when insufficient_privilege then null;
end $$;

reset role;

-- Retiring the linked fuel payment reopens a visible durable follow-up.
update public.fuel_payments
set deleted_at = now()
where ledger_id = 'fuel-flow' and legacy_id = 'fuel-attempt-1';

do $$
begin
  if (select fuel_resolution from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 'deferred' then
    raise exception 'FAIL: retiring linked fuel did not reopen the follow-up';
  end if;
  if (select completion_fuel_legacy_id from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) is not null then
    raise exception 'FAIL: retired fuel key remained attached';
  end if;
end $$;

-- Supabase-facing grants are explicit: anonymous callers cannot execute it.
do $$
begin
  if has_function_privilege(
    'anon',
    'public.complete_booking_trip_with_fuel(text,uuid,uuid,text,uuid,date,numeric,numeric,text,uuid[],text,text,uuid,date,numeric,text,numeric,numeric,numeric,text,text,numeric,numeric,boolean,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: anon retains EXECUTE on atomic completion';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.complete_booking_trip_with_fuel(text,uuid,uuid,text,uuid,date,numeric,numeric,text,uuid[],text,text,uuid,date,numeric,text,numeric,numeric,numeric,text,text,numeric,numeric,boolean,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'FAIL: authenticated lacks EXECUTE on atomic completion';
  end if;
end $$;
SQL

echo "ok - atomic booking fuel-completion lifecycle passes"

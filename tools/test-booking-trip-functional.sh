#!/bin/bash
# Functional regression test for migration 123's booking-completion command.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-booking-trip-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the booking-trip functional test." >&2
  exit 1
fi

docker run -d --name "${C}" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO":/repo:ro postgres:15-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "${C}" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

PSQL() { docker exec -i "${C}" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

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
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
SQL

PSQL -f /repo/supabase-schema.sql >/dev/null

PSQL <<'SQL'
insert into public.ledgers (id, name, slug) values
  ('trip-test', 'Trip test', 'trip-test'),
  ('other-ledger', 'Other ledger', 'other-ledger');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'trip-test', 'Driver', 'driver@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'trip-test', 'Other', 'other@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000003', 'trip-test', 'Admin', 'admin@test.dk', 'admin', true),
  ('10000000-0000-0000-0000-000000000004', 'other-ledger', 'Elsewhere', 'elsewhere@test.dk', 'admin', true);

insert into public.settlement_periods (id, ledger_id, status, label) values
  ('20000000-0000-0000-0000-000000000001', 'trip-test', 'open', 'Open'),
  ('20000000-0000-0000-0000-000000000002', 'other-ledger', 'open', 'Open');

insert into public.car_bookings (
  id, legacy_id, ledger_id, member_id, start_at, end_at, purpose, created_by_member_id
) values (
  '30000000-0000-0000-0000-000000000001', 'booking-1', 'trip-test',
  '10000000-0000-0000-0000-000000000001', now() - interval '2 days',
  now() - interval '1 day', 'Aarhus', '10000000-0000-0000-0000-000000000001'
);

select set_config('request.jwt.claims', '{"email":"driver@test.dk","role":"authenticated"}', false);

select public.upsert_booking_trip_with_participants(
  'trip-test',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'trip-attempt-1',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  1000,
  1100,
  'Aarhus',
  array['10000000-0000-0000-0000-000000000001'::uuid],
  'Driver logged a trip',
  '100 km'
);

-- A second device/retry supplies another local key and corrected odometer. The
-- command must update the linked trip rather than create a second one.
select public.upsert_booking_trip_with_participants(
  'trip-test',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'trip-attempt-2',
  '10000000-0000-0000-0000-000000000001',
  current_date - 2,
  1000,
  1112,
  'Aarhus corrected',
  array[
    '10000000-0000-0000-0000-000000000001'::uuid,
    '10000000-0000-0000-0000-000000000002'::uuid
  ],
  'Driver logged a trip',
  '112 km'
);

do $$
declare
  linked_trip public.trips%rowtype;
begin
  if (select count(*) from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 1 then
    raise exception 'FAIL: booking retry created more than one active trip';
  end if;

  select * into linked_trip
    from public.trips
    where booking_id = '30000000-0000-0000-0000-000000000001'
      and deleted_at is null;

  if linked_trip.legacy_id <> 'trip-attempt-1' or linked_trip.end_km <> 1112 then
    raise exception 'FAIL: retry did not reuse and update the original trip: %', to_jsonb(linked_trip);
  end if;

  if (select count(*) from public.trip_participants where trip_id = linked_trip.id) <> 2 then
    raise exception 'FAIL: retry did not replace participants atomically';
  end if;

  if (select count(*) from public.ledger_events where metadata ->> 'trip_id' = linked_trip.id::text) <> 1 then
    raise exception 'FAIL: retry emitted a duplicate trip-created event';
  end if;
end $$;

-- Another ordinary member cannot complete this driver's booking.
select set_config('request.jwt.claims', '{"email":"other@test.dk","role":"authenticated"}', false);
do $$
begin
  perform public.upsert_booking_trip_with_participants(
    'trip-test', '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 'unauthorized-attempt',
    '10000000-0000-0000-0000-000000000001', current_date - 2,
    1000, 1112, null, array['10000000-0000-0000-0000-000000000001'::uuid]
  );
  raise exception 'FAIL: non-driver completed another member''s booking';
exception
  when insufficient_privilege then null;
end $$;

-- The trigger independently rejects a cross-workspace booking link.
do $$
begin
  insert into public.trips (
    legacy_id, ledger_id, period_id, booking_id, driver_member_id,
    trip_date, start_km, end_km, created_by_member_id
  ) values (
    'cross-ledger', 'other-ledger', '20000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001', current_date, 1, 2,
    '10000000-0000-0000-0000-000000000004'
  );
  raise exception 'FAIL: cross-workspace booking link was accepted';
exception
  when check_violation then null;
end $$;

-- Removing the completed trip reopens the booking; a fresh completion may then
-- replace it, while the partial unique index still guarantees one active row.
update public.trips
set deleted_at = now()
where booking_id = '30000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claims', '{"email":"driver@test.dk","role":"authenticated"}', false);
select public.upsert_booking_trip_with_participants(
  'trip-test', '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 'trip-replacement',
  '10000000-0000-0000-0000-000000000001', current_date - 2,
  1000, 1115, 'Replacement', array['10000000-0000-0000-0000-000000000001'::uuid]
);

do $$
begin
  if (select count(*) from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 1 then
    raise exception 'FAIL: soft-deleted completion was not replaced exactly once';
  end if;
  if (select legacy_id from public.trips where booking_id = '30000000-0000-0000-0000-000000000001' and deleted_at is null) <> 'trip-replacement' then
    raise exception 'FAIL: replacement did not use its own idempotency key';
  end if;
end $$;
SQL

echo "ok - booking completion functional lifecycle passes"

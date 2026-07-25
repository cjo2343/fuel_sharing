#!/bin/bash
# Functional regression test for migration 144's deferred-fuel escape hatch (GVM-428).
#
# "Jeg tankede — registrerer den senere" used to be a one-way door: the only exit
# was complete_deferred_booking_fuel, which demands a real receipt with a positive
# amount. close_deferred_booking_fuel is the way back out. Structural checks
# (schema-equivalence) prove it EXISTS; only a replay proves it BEHAVES — that it
# closes the entry, refuses the wrong caller, survives a replay, works on a trip
# whose period is already closed, and never demolishes a receipt that landed first.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-deferred-close-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the deferred fuel-close functional test." >&2
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
  ('close-flow', 'Close flow', 'close-flow');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'close-flow', 'Driver', 'driver@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'close-flow', 'Other', 'other@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000003', 'close-flow', 'Admin', 'admin@test.dk', 'admin', true);

-- Only one period may be open per ledger, so the older one is opened, used and
-- closed before the current one exists — the real sequence.
insert into public.settlement_periods (id, ledger_id, status, label) values
  ('20000000-0000-0000-0000-000000000002', 'close-flow', 'open', 'Will be closed');

-- enforce_trip_booking_scope requires the trip driver to be the booked member, so
-- bookings 2 and 3 (the ones Other drove) are booked by Other.
insert into public.car_bookings (id, legacy_id, ledger_id, member_id, start_at, end_at, purpose, created_by_member_id)
select
  ('30000000-0000-0000-0000-00000000000' || n)::uuid,
  'booking-' || n,
  'close-flow',
  case when n in (2, 3)
    then '10000000-0000-0000-0000-000000000002'::uuid
    else '10000000-0000-0000-0000-000000000001'::uuid
  end,
  date_trunc('day', now() - interval '3 days') + (n || ' hours')::interval,
  date_trunc('day', now() - interval '3 days') + ((n + 1) || ' hours')::interval,
  'Booking ' || n,
  '10000000-0000-0000-0000-000000000001'
from generate_series(1, 7) as n;

-- t5 belongs to the period that is about to close: a receipt is most likely to be
-- abandoned long after the period it belongs to was settled, and that is exactly
-- the entry that nags forever.
insert into public.trips (
  id, legacy_id, ledger_id, period_id, booking_id, driver_member_id, created_by_member_id,
  trip_date, start_km, end_km, fuel_resolution, completion_fuel_legacy_id
) values
  ('40000000-0000-0000-0000-000000000005', 'trip-5', 'close-flow', '20000000-0000-0000-0000-000000000002',
   '30000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1400, 1500, 'deferred', null);

update public.settlement_periods
set status = 'closed', closed_at = now()
where id = '20000000-0000-0000-0000-000000000002';

insert into public.settlement_periods (id, ledger_id, status, label) values
  ('20000000-0000-0000-0000-000000000001', 'close-flow', 'open', 'Open');

-- The receipt that landed first, for the "never demolish a logged payment" case.
insert into public.fuel_payments (
  id, legacy_id, ledger_id, period_id, payer_member_id, payment_date, amount, currency, liters
) values (
  '50000000-0000-0000-0000-000000000001', 'fuel-already-logged', 'close-flow',
  '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  current_date - 3, 412.50, 'DKK', 21.5
);

-- Seeded directly so driver/creator/period/resolution can be set independently —
-- the point of this suite is the CLOSE path, not how the trips got there.
--   t1 driver=Driver  creator=Driver  deferred      open period
--   t2 driver=Other   creator=Other   deferred      open period    (Driver is a bystander)
--   t3 driver=Other   creator=Driver  deferred      open period    (Driver only deferred it)
--   t4 driver=Driver  creator=Driver  logged+fuel   open period
--   t5 driver=Driver  creator=Driver  deferred      closed period (seeded above)
--   t6 driver=Driver  creator=Driver  not_needed    open period
--   t7 driver=Driver  creator=Driver  deferred      NO booking (not a booking follow-up)
insert into public.trips (
  id, legacy_id, ledger_id, period_id, booking_id, driver_member_id, created_by_member_id,
  trip_date, start_km, end_km, fuel_resolution, completion_fuel_legacy_id
) values
  ('40000000-0000-0000-0000-000000000001', 'trip-1', 'close-flow', '20000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1000, 1100, 'deferred', null),
  ('40000000-0000-0000-0000-000000000002', 'trip-2', 'close-flow', '20000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000002', current_date - 3, 1100, 1200, 'deferred', null),
  ('40000000-0000-0000-0000-000000000003', 'trip-3', 'close-flow', '20000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1200, 1300, 'deferred', null),
  ('40000000-0000-0000-0000-000000000004', 'trip-4', 'close-flow', '20000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1300, 1400, 'logged', 'fuel-already-logged'),
  ('40000000-0000-0000-0000-000000000006', 'trip-6', 'close-flow', '20000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1500, 1600, 'not_needed', null),
  ('40000000-0000-0000-0000-000000000007', 'trip-7', 'close-flow', '20000000-0000-0000-0000-000000000001',
   null, '10000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', current_date - 3, 1600, 1700, 'deferred', null);
SQL

PSQL <<'SQL'
select set_config('request.jwt.claims', '{"email":"driver@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 1. The driver closes their own deferred entry with no amount and no litres.
do $$
declare
  result jsonb;
begin
  result := public.close_deferred_booking_fuel(
    'close-flow', '40000000-0000-0000-0000-000000000001',
    'Driver tankede alligevel ikke', '100 km'
  );
  if result ->> 'fuel_resolution' <> 'not_refuelled' then
    raise exception 'FAIL: close did not report not_refuelled: %', result;
  end if;
  if (result ->> 'already_closed')::boolean then
    raise exception 'FAIL: first close reported already_closed: %', result;
  end if;
end $$;

do $$
declare
  closed_trip public.trips%rowtype;
begin
  select * into closed_trip from public.trips where id = '40000000-0000-0000-0000-000000000001';
  if closed_trip.fuel_resolution <> 'not_refuelled' then
    raise exception 'FAIL: trip is still %', closed_trip.fuel_resolution;
  end if;
  if closed_trip.completion_fuel_legacy_id is not null then
    raise exception 'FAIL: close attached a fuel key';
  end if;
  -- Nothing financial may be invented by an escape hatch.
  if (select count(*) from public.fuel_payments where ledger_id = 'close-flow' and deleted_at is null) <> 1 then
    raise exception 'FAIL: close created or removed a fuel payment';
  end if;
  -- Without this event the other members' devices keep nagging about a trip that
  -- is already resolved (live sync IS a ledger_events insert).
  if (select count(*) from public.ledger_events
      where ledger_id = 'close-flow' and event_type = 'trip_fuel_closed') <> 1 then
    raise exception 'FAIL: close did not write exactly one trip_fuel_closed event';
  end if;
  if (select metadata ->> 'trip_id' from public.ledger_events where event_type = 'trip_fuel_closed')
     <> '40000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: close event did not carry its trip id';
  end if;
  if (select actor_email from public.ledger_events where event_type = 'trip_fuel_closed') <> 'driver@test.dk' then
    raise exception 'FAIL: close event lost its actor';
  end if;
end $$;

-- 2. A replay (double tap, offline retry, second device) is a no-op, not an error
--    and not a second event.
do $$
declare
  result jsonb;
begin
  result := public.close_deferred_booking_fuel(
    'close-flow', '40000000-0000-0000-0000-000000000001',
    'Driver tankede alligevel ikke', '100 km'
  );
  if not (result ->> 'already_closed')::boolean then
    raise exception 'FAIL: replay did not report already_closed: %', result;
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'close-flow' and event_type = 'trip_fuel_closed') <> 1 then
    raise exception 'FAIL: replay wrote a duplicate event';
  end if;
end $$;

-- 3. A bystander (neither driver nor creator nor admin) is refused.
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000002');
  raise exception 'FAIL: a bystander closed another member''s deferred entry';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  if (select fuel_resolution from public.trips where id = '40000000-0000-0000-0000-000000000002') <> 'deferred' then
    raise exception 'FAIL: refused close still changed the trip';
  end if;
end $$;

-- 4. The person who tapped "registrerer den senere" may close it even when someone
--    else drove (GV-253: admin OR creator).
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000003');
  if (select fuel_resolution from public.trips where id = '40000000-0000-0000-0000-000000000003') <> 'not_refuelled' then
    raise exception 'FAIL: the entry''s creator could not close it';
  end if;
end $$;

-- 5. A receipt that landed first wins: the close reports it and touches nothing.
do $$
declare
  result jsonb;
begin
  result := public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000004');
  if result ->> 'fuel_resolution' <> 'logged' then
    raise exception 'FAIL: close overrode a logged receipt: %', result;
  end if;
  if (result ->> 'fuel_id') <> '50000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: close did not report the winning fuel payment: %', result;
  end if;
  if (select completion_fuel_legacy_id from public.trips where id = '40000000-0000-0000-0000-000000000004')
     <> 'fuel-already-logged' then
    raise exception 'FAIL: close detached a real fuel payment';
  end if;
  if not exists (select 1 from public.fuel_payments
                 where legacy_id = 'fuel-already-logged' and deleted_at is null) then
    raise exception 'FAIL: close deleted a real fuel payment';
  end if;
end $$;

-- 6. THE case this RPC exists for: the trip's period closed long ago and the
--    receipt never came. The entry must still be closable.
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000005');
  if (select fuel_resolution from public.trips where id = '40000000-0000-0000-0000-000000000005') <> 'not_refuelled' then
    raise exception 'FAIL: a deferred entry in a closed period could not be closed';
  end if;
end $$;

-- 7. Only a DEFERRED entry is closable; anything else is a client bug, not a close.
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000006');
  raise exception 'FAIL: close accepted a not_needed trip';
exception
  when invalid_parameter_value then null;
end $$;

-- 8. A trip with no booking is not a booking follow-up and is not found here.
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000007');
  raise exception 'FAIL: close accepted a trip with no booking';
exception
  when invalid_parameter_value then null;
end $$;

do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', null);
  raise exception 'FAIL: close accepted a null trip id';
exception
  when invalid_parameter_value then null;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"admin@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 9. An admin can always unstick the workspace.
do $$
begin
  perform public.close_deferred_booking_fuel(
    'close-flow', '40000000-0000-0000-0000-000000000002', 'Admin lukkede en tankning', null
  );
  if (select fuel_resolution from public.trips where id = '40000000-0000-0000-0000-000000000002') <> 'not_refuelled' then
    raise exception 'FAIL: an admin could not close a member''s deferred entry';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"stranger@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 10. A signed-in non-member of this workspace never gets in.
do $$
begin
  perform public.close_deferred_booking_fuel('close-flow', '40000000-0000-0000-0000-000000000005');
  raise exception 'FAIL: a non-member reached another workspace''s trip';
exception
  when insufficient_privilege then null;
end $$;

reset role;

-- 11. Supabase-facing grants are explicit.
do $$
begin
  if has_function_privilege('anon', 'public.close_deferred_booking_fuel(text,uuid,text,text)', 'EXECUTE') then
    raise exception 'FAIL: anon retains EXECUTE on the deferred-fuel close';
  end if;
  if not has_function_privilege('authenticated', 'public.close_deferred_booking_fuel(text,uuid,text,text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated lacks EXECUTE on the deferred-fuel close';
  end if;
end $$;
SQL

echo "ok - deferred booking-fuel entries can be closed as not_refuelled (GVM-428)"

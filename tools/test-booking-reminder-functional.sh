#!/bin/bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-booking-reminder-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the booking-reminder functional test." >&2
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
create or replace function auth.jwt() returns jsonb language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
SQL

PSQL -f /repo/supabase-schema.sql >/dev/null

PSQL <<'SQL'
insert into public.ledgers (id, name, slug) values ('reminder-test', 'Reminder test', 'reminder-test');
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'reminder-test', 'Driver', 'driver@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'reminder-test', 'No mail', null, 'member', true),
  ('10000000-0000-0000-0000-000000000003', 'reminder-test', 'Inactive', 'inactive@test.dk', 'member', true);
insert into public.settlement_periods (id, ledger_id, status, label) values
  ('20000000-0000-0000-0000-000000000001', 'reminder-test', 'open', 'Open');

insert into public.car_bookings (
  id, legacy_id, ledger_id, member_id, start_at, end_at, purpose,
  created_by_member_id, requires_linked_trip
) values
  ('30000000-0000-0000-0000-000000000001', 'due', 'reminder-test',
   '10000000-0000-0000-0000-000000000001', now() - interval '2 hours', now() - interval '10 minutes',
   'Private route text', '10000000-0000-0000-0000-000000000001', true),
  ('30000000-0000-0000-0000-000000000002', 'future', 'reminder-test',
   '10000000-0000-0000-0000-000000000001', now(), now() + interval '1 hour',
   null, '10000000-0000-0000-0000-000000000001', true),
  ('30000000-0000-0000-0000-000000000003', 'legacy', 'reminder-test',
   '10000000-0000-0000-0000-000000000001', now() - interval '28 hours', now() - interval '24 hours',
   null, '10000000-0000-0000-0000-000000000001', false),
  ('30000000-0000-0000-0000-000000000004', 'no-mail', 'reminder-test',
   '10000000-0000-0000-0000-000000000002', now() - interval '52 hours', now() - interval '48 hours',
   null, '10000000-0000-0000-0000-000000000002', true),
  ('30000000-0000-0000-0000-000000000005', 'inactive', 'reminder-test',
   '10000000-0000-0000-0000-000000000003', now() - interval '76 hours', now() - interval '72 hours',
   null, '10000000-0000-0000-0000-000000000001', true),
  ('30000000-0000-0000-0000-000000000006', 'completed', 'reminder-test',
   '10000000-0000-0000-0000-000000000001', now() - interval '100 hours', now() - interval '96 hours',
   null, '10000000-0000-0000-0000-000000000001', true);

update public.ledger_members
set is_active = false
where id = '10000000-0000-0000-0000-000000000003';

insert into public.trips (
  id, legacy_id, ledger_id, period_id, booking_id, driver_member_id, trip_date,
  start_km, end_km, created_by_member_id
) values (
  '40000000-0000-0000-0000-000000000001', 'completed-trip', 'reminder-test',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001',
  current_date, 100, 110, '10000000-0000-0000-0000-000000000001'
);

-- An unrelated same-day trip must not suppress the due post-rollout booking.
insert into public.trips (
  id, legacy_id, ledger_id, period_id, driver_member_id, trip_date,
  start_km, end_km, created_by_member_id
) values (
  '40000000-0000-0000-0000-000000000002', 'ordinary-trip', 'reminder-test',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', current_date, 110, 120,
  '10000000-0000-0000-0000-000000000001'
);

create temporary table claimed as
select * from public.claim_due_booking_trip_reminders(200);

do $$
declare token uuid;
begin
  if (select count(*) from claimed) <> 1
     or (select booking_id from claimed) <> '30000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'FAIL: claim eligibility was not exactly the due durable booking: %',
      (select jsonb_agg(to_jsonb(c)) from claimed c);
  end if;

  if exists (select 1 from claimed where member_email <> 'driver@test.dk') then
    raise exception 'FAIL: claimed recipient email was wrong';
  end if;

  if exists (select 1 from public.claim_due_booking_trip_reminders(200)) then
    raise exception 'FAIL: live lease was claimed twice';
  end if;

  select claim_token into token from claimed;
  if public.confirm_booking_trip_reminders(jsonb_build_array(jsonb_build_object(
       'id', '30000000-0000-0000-0000-000000000001',
       'token', gen_random_uuid(), 'outcome', 'delivered'
     ))) <> 0 then
    raise exception 'FAIL: wrong claim token confirmed';
  end if;

  if public.confirm_booking_trip_reminders(jsonb_build_array(jsonb_build_object(
       'id', '30000000-0000-0000-0000-000000000001',
       'token', token, 'outcome', 'delivered'
     ))) <> 1 then
    raise exception 'FAIL: valid claim was not confirmed';
  end if;

  if (select count(*) from public.ledger_events
      where event_type = 'booking_completion_reminder_sent'
        and metadata ->> 'booking_id' = '30000000-0000-0000-0000-000000000001'
        and metadata ->> 'outcome' = 'delivered') <> 1 then
    raise exception 'FAIL: terminal reminder outcome was not audited exactly once';
  end if;
end $$;

set role authenticated;
do $$
begin
  perform public.claim_due_booking_trip_reminders(1);
  raise exception 'FAIL: authenticated client invoked service-role claim RPC';
exception when insufficient_privilege then null;
end $$;
reset role;
SQL

echo "ok - booking reminder eligibility, lease, token, audit, and grants pass"

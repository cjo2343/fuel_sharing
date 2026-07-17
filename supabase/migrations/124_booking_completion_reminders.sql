-- Migration 124: reliable booking-ended trip reminders.
--
-- Migration 123 made booking completion durable, but the Home nudge still had
-- two gaps: post-rollout bookings could be hidden by an unrelated same-day trip,
-- and no server-side push existed when a booking ended. Mark which bookings must
-- use the durable link and add the same lease/token/confirm reminder discipline
-- already used by payment, close-period, and receipt-confirmation reminders.

alter table public.car_bookings
  add column if not exists requires_linked_trip boolean not null default true,
  add column if not exists trip_reminder_claimed_at timestamptz,
  add column if not exists trip_reminder_claim_token uuid,
  add column if not exists trip_reminded_at timestamptz;

-- Bookings created before migration 123 was live retain the legacy date fallback.
-- Newer bookings require trips.booking_id, so another trip on the same date cannot
-- silently suppress their Home action or push reminder.
update public.car_bookings cb
set requires_linked_trip = false
from public.fuel_ledger_schema_migrations applied
where applied.migration_id = '123_booking_trip_link'
  and cb.created_at < applied.applied_at;

create index if not exists car_bookings_trip_reminder_due_idx
  on public.car_bookings (end_at)
  where deleted_at is null
    and requires_linked_trip = true
    and trip_reminded_at is null;

create or replace function public.claim_due_booking_trip_reminders(
  p_limit integer default 200
)
returns table (
  booking_id uuid,
  ledger_id text,
  member_id uuid,
  member_email text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select cb.id
    from public.car_bookings cb
    join public.ledger_members lm
      on lm.id = cb.member_id
     and lm.ledger_id = cb.ledger_id
    where cb.deleted_at is null
      and cb.requires_linked_trip = true
      and cb.end_at <= now()
      and cb.end_at > now() - interval '7 days'
      and cb.trip_reminded_at is null
      and (cb.trip_reminder_claimed_at is null
           or cb.trip_reminder_claimed_at <= now() - interval '15 minutes')
      and lm.is_active = true
      and lm.email is not null
      and not exists (
        select 1
        from public.trips t
        where t.booking_id = cb.id
          and t.deleted_at is null
      )
    order by cb.end_at
    limit greatest(coalesce(p_limit, 200), 0)
    for update of cb skip locked
  ),
  claimed as (
    update public.car_bookings cb
    set trip_reminder_claimed_at = now(),
        trip_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where cb.id = t.id
    returning cb.id as booking_id,
              cb.ledger_id as ledger_id,
              cb.member_id as member_id,
              cb.trip_reminder_claim_token as claim_token
  )
  select c.booking_id,
         c.ledger_id,
         c.member_id,
         lower(lm.email) as member_email,
         c.claim_token
  from claimed c
  join public.ledger_members lm
    on lm.id = c.member_id
   and lm.ledger_id = c.ledger_id;
end;
$$;

revoke all on function public.claim_due_booking_trip_reminders(integer) from public;
revoke all on function public.claim_due_booking_trip_reminders(integer) from anon;
revoke all on function public.claim_due_booking_trip_reminders(integer) from authenticated;
grant execute on function public.claim_due_booking_trip_reminders(integer) to service_role;

create or replace function public.confirm_booking_trip_reminders(confirmations jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with input as (
    select (elem ->> 'id')::uuid as booking_id,
           (elem ->> 'token')::uuid as claim_token,
           (elem ->> 'outcome') as outcome
    from jsonb_array_elements(coalesce(confirmations, '[]'::jsonb)) as elem
    where (elem ->> 'outcome') in ('delivered', 'suppressed_no_device', 'muted')
  ),
  confirmed as (
    update public.car_bookings cb
    set trip_reminded_at = now(),
        trip_reminder_claimed_at = null,
        trip_reminder_claim_token = null,
        updated_at = now()
    from input i
    where cb.id = i.booking_id
      and cb.deleted_at is null
      and cb.requires_linked_trip = true
      and cb.trip_reminded_at is null
      and cb.trip_reminder_claimed_at is not null
      and cb.trip_reminder_claim_token = i.claim_token
    returning cb.id as booking_id,
              cb.ledger_id as ledger_id,
              cb.member_id as member_id,
              i.outcome as outcome
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email,
      target_member_id, metadata
    )
    select c.ledger_id,
           'booking_completion_reminder_sent',
           'Turpåmindelse behandlet',
           '',
           null,
           null,
           c.member_id,
           jsonb_build_object('booking_id', c.booking_id, 'outcome', c.outcome)
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_booking_trip_reminders(jsonb) from public;
revoke all on function public.confirm_booking_trip_reminders(jsonb) from anon;
revoke all on function public.confirm_booking_trip_reminders(jsonb) from authenticated;
grant execute on function public.confirm_booking_trip_reminders(jsonb) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '124_booking_completion_reminders',
  'Mark post-123 bookings as requiring durable trip links and add service-role-only lease/token claim-confirm RPCs for one-time booking-ended trip reminders.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

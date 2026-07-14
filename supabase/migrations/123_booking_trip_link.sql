-- Migration 123: durable, idempotent booking -> trip completion.
--
-- A completed booking used to become only a client-side trip draft. Trips had no
-- booking key, so the reminder guessed from dates and another member's trip could
-- suppress it. Retrying the draft could also create a second trip. Persist the
-- relationship and expose a booking-specific command that serializes on the
-- booking row before delegating the accounting write to the canonical trip RPC.

alter table public.trips
  add column if not exists booking_id uuid
  references public.car_bookings(id) on delete set null;

-- A soft-deleted trip no longer completes the booking and may be replaced.
create unique index if not exists trips_one_active_per_booking_idx
  on public.trips (booking_id)
  where booking_id is not null and deleted_at is null;

-- Protect direct/RLS writes too: a linked trip must belong to the booking's
-- workspace and booked driver. The RPC below performs the same checks with a
-- clearer authorization path; this trigger is the final database invariant.
create or replace function public.enforce_trip_booking_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_ledger_id text;
  booking_member_id uuid;
  booking_deleted_at timestamptz;
begin
  if new.booking_id is null then
    return new;
  end if;

  select cb.ledger_id, cb.member_id, cb.deleted_at
    into booking_ledger_id, booking_member_id, booking_deleted_at
    from public.car_bookings cb
    where cb.id = new.booking_id;

  if not found or booking_deleted_at is not null then
    raise exception 'Trip booking must reference an active booking' using errcode = '23514';
  end if;

  if booking_ledger_id is distinct from new.ledger_id then
    raise exception 'Trip and booking must belong to the same ledger' using errcode = '23514';
  end if;

  if booking_member_id is null or booking_member_id is distinct from new.driver_member_id then
    raise exception 'Trip driver must match the booked member' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_trip_booking_scope() from public;
revoke all on function public.enforce_trip_booking_scope() from anon;
revoke all on function public.enforce_trip_booking_scope() from authenticated;

drop trigger if exists enforce_trip_booking_scope_trigger on public.trips;
create trigger enforce_trip_booking_scope_trigger
before insert or update of booking_id, ledger_id, driver_member_id, deleted_at
on public.trips
for each row execute function public.enforce_trip_booking_scope();

create or replace function public.upsert_booking_trip_with_participants(
  target_ledger_id text,
  target_open_period_id uuid,
  target_booking_id uuid,
  legacy_trip_id text,
  booking_driver_member_id uuid,
  trip_date_value date,
  start_km_value numeric,
  end_km_value numeric,
  note_value text,
  participant_member_ids uuid[],
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  booking_row public.car_bookings%rowtype;
  existing_booking_trip record;
  incoming_booking_id uuid;
  effective_legacy_trip_id text;
  saved_trip_id uuid;
  trip_result jsonb;
  reused_existing boolean := false;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_booking_id is null then
    raise exception 'Missing booking id' using errcode = '22023';
  end if;

  if legacy_trip_id is null or legacy_trip_id = '' then
    raise exception 'Missing legacy trip id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can complete bookings' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- The booking lock is the idempotency boundary: concurrent taps/devices for the
  -- same booking serialize here and the second call reuses the first trip.
  select cb.*
    into booking_row
    from public.car_bookings cb
    where cb.id = target_booking_id
      and cb.ledger_id = target_ledger_id
      and cb.deleted_at is null
    for update of cb;

  if not found then
    raise exception 'Booking was not found or is unavailable' using errcode = '42501';
  end if;

  if booking_row.member_id is null
     or booking_driver_member_id is distinct from booking_row.member_id then
    raise exception 'Trip driver must match the booked member' using errcode = '23514';
  end if;

  if actor_member_id <> booking_row.member_id
     and not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only the booked member or a ledger admin can complete this booking'
      using errcode = '42501';
  end if;

  -- Keep the durable link honest while allowing a late-night return to be logged
  -- the following calendar day, matching the existing reminder grace period.
  if trip_date_value < (booking_row.start_at at time zone 'UTC')::date
     or trip_date_value > ((booking_row.end_at at time zone 'UTC')::date + 1) then
    raise exception 'Trip date must fall inside the booking window' using errcode = '23514';
  end if;

  select t.id, t.legacy_id
    into existing_booking_trip
    from public.trips t
    where t.booking_id = target_booking_id
      and t.deleted_at is null
    for update of t;

  reused_existing := found;
  if reused_existing then
    effective_legacy_trip_id := nullif(existing_booking_trip.legacy_id, '');
    if effective_legacy_trip_id is null then
      raise exception 'Existing booking trip has no idempotency key' using errcode = '23514';
    end if;
  else
    effective_legacy_trip_id := legacy_trip_id;

    -- A retry key already attached to a different booking must never move between
    -- bookings. An unlinked trip with this key may be adopted by this completion.
    select t.booking_id
      into incoming_booking_id
      from public.trips t
      where t.ledger_id = target_ledger_id
        and t.legacy_id = legacy_trip_id
      for update of t;

    if found and incoming_booking_id is not null and incoming_booking_id <> target_booking_id then
      raise exception 'Trip idempotency key belongs to another booking' using errcode = '23514';
    end if;
  end if;

  trip_result := public.upsert_trip_with_participants(
    target_ledger_id,
    target_open_period_id,
    effective_legacy_trip_id,
    booking_driver_member_id,
    trip_date_value,
    start_km_value,
    end_km_value,
    note_value,
    participant_member_ids,
    event_title,
    event_body
  );

  saved_trip_id := nullif(trip_result ->> 'trip_id', '')::uuid;
  if saved_trip_id is null then
    raise exception 'Trip completion did not return a trip id' using errcode = '40001';
  end if;

  update public.trips t
    set booking_id = target_booking_id,
        updated_at = now()
    where t.id = saved_trip_id
      and t.ledger_id = target_ledger_id;

  if not found then
    raise exception 'Trip completion could not persist its booking link' using errcode = '40001';
  end if;

  return trip_result || jsonb_build_object(
    'booking_id', target_booking_id,
    'reused_existing', reused_existing
  );
end;
$$;

revoke all on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text
) from public;
revoke all on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text
) from anon;
grant execute on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text
) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '123_booking_trip_link',
  'Link one active trip to a booking and add an idempotent booking-completion RPC that enforces workspace, driver, date-window, and authorization boundaries.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

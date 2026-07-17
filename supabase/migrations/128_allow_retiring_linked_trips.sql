-- Migration 128: allow retiring a trip whose booking is gone (GV-307)
--
-- Migration 123's enforce_trip_booking_scope trigger fires on UPDATE OF deleted_at
-- and re-validates the booking link. That makes a linked trip un-deletable once its
-- booking has been soft-deleted (observed live 2026-07-17: the operator cleared the
-- bookings first, and every later attempt to soft-delete the completed trip failed
-- with 'Trip booking must reference an active booking' — including in the SQL
-- Editor). The link invariants only need to hold for rows that are, or become,
-- active: a soft-deleted trip leaves the one-active-trip-per-booking partial index,
-- so retiring a trip must always be allowed. Un-deleting still re-validates.

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
  -- Retiring a trip is always allowed: a soft-deleted trip leaves the partial
  -- one-active-trip-per-booking index, so the booking-link invariants below only
  -- guard rows that are (or become) active. Un-deleting re-enters validation.
  if new.deleted_at is not null then
    return new;
  end if;

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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '128_allow_retiring_linked_trips',
  'Soft-deleting a trip skips the booking-link trigger checks: the active-booking invariants only guard rows that are or become active, so retiring a linked trip works even after its booking was soft-deleted (GV-307).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

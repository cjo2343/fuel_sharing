-- Migration 063: structured fuel stop on car bookings (GVM-159)
--
-- The Plan tab can suggest an along-route refuel stop (GVM-150/153/154). GVM-157
-- already remembers it as free text folded into the booking's purpose. This adds a
-- STRUCTURED companion so the booked trip can re-offer "Open route via" and draw the
-- saved route on a booking detail view — neither of which is possible from a text note.
--
-- 1. car_bookings.fuel_stop jsonb (nullable). Shape (all optional, best-effort):
--      {
--        "from":    { "label", "lat", "lng" },
--        "to":      { "label", "lat", "lng" },
--        "station": { "brand", "lat", "lng", "kmIn", "pricePerLiter" }
--      }
--    This is trip data the user themselves planned; it carries the same personal-data
--    posture as station_lat/station_lng on fuel_payments (stored for a clear purpose,
--    never logged, never in a URL — GDPR data-minimisation is satisfied because the
--    whole point is to remember this exact route for navigation).
--
-- 2. upsert_car_booking gains a trailing `fuel_stop_value jsonb default null` param that
--    writes the column. Mirrors migration 051's pattern: drop the current signature
--    first (it dropped the 6-arg 011 signature the same way), then re-create the full
--    body with the extra defaulted param, so a client build that predates the param
--    still resolves to the one live signature (fuel_stop_value defaults to null).

alter table public.car_bookings
  add column if not exists fuel_stop jsonb;

drop function if exists public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text);

create or replace function public.upsert_car_booking(
  target_ledger_id text,
  legacy_booking_id text,
  booking_member_id uuid,
  start_at_value timestamptz,
  end_at_value timestamptz,
  purpose_value text,
  event_title text default null,
  event_body text default null,
  fuel_stop_value jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_booking_id uuid;
  existing_booking record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Missing legacy booking id' using errcode = '22023';
  end if;

  if start_at_value is null or end_at_value is null or end_at_value <= start_at_value then
    raise exception 'Booking end time must be after start time' using errcode = '23514';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save car bookings' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if booking_member_id is null or not public.member_belongs_to_ledger(booking_member_id, target_ledger_id) then
    raise exception 'Booking member must be an active member of this ledger' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':booking:' || legacy_booking_id));

  select *
    into existing_booking
  from public.car_bookings
  where ledger_id = target_ledger_id
    and legacy_id = legacy_booking_id
  for update;

  if existing_booking.id is not null and not public.can_manage_car_booking(existing_booking.id) then
    raise exception 'Only the booking creator, booked member, or a ledger admin can update this booking' using errcode = '42501';
  end if;

  if existing_booking.id is null
     and not (
       public.is_ledger_admin(target_ledger_id)
       or actor_member_id = booking_member_id
     ) then
    raise exception 'Only the booked member or a ledger admin can create this booking' using errcode = '42501';
  end if;

  if existing_booking.id is null then
    insert into public.car_bookings (
      legacy_id,
      ledger_id,
      member_id,
      start_at,
      end_at,
      purpose,
      fuel_stop,
      created_by_member_id,
      deleted_at,
      updated_at
    ) values (
      legacy_booking_id,
      target_ledger_id,
      booking_member_id,
      start_at_value,
      end_at_value,
      nullif(purpose_value, ''),
      fuel_stop_value,
      actor_member_id,
      null,
      now()
    )
    returning id into saved_booking_id;
  else
    update public.car_bookings
    set member_id = booking_member_id,
        start_at = start_at_value,
        end_at = end_at_value,
        purpose = nullif(purpose_value, ''),
        fuel_stop = fuel_stop_value,
        deleted_at = null,
        updated_at = now()
    where id = existing_booking.id
    returning id into saved_booking_id;
  end if;

  -- Activity feed event, on create only (GVM-84).
  if existing_booking.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'booking_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', saved_booking_id)
    );
  end if;

  return jsonb_build_object(
    'booking_id', saved_booking_id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('063_booking_fuel_stop', 'Structured fuel stop on car bookings + upsert_car_booking param (GVM-159)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

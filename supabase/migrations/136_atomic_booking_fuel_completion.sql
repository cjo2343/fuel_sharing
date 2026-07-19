-- Migration 136: atomic booking-trip fuel completion (GV-334)
--
-- A booking-linked trip was persisted before its required refuel was reviewed.
-- Dismissing or interrupting the second screen therefore left the booking looking
-- complete while the tank model and settlement were missing the fuel event. Store
-- an explicit resolution on the trip and provide one idempotent command that saves
-- the trip plus an optional real fuel payment in the same transaction.

alter table public.trips
  add column if not exists fuel_resolution text;

alter table public.trips
  add column if not exists completion_fuel_legacy_id text;

alter table public.trips
  drop constraint if exists trips_fuel_resolution_check;

alter table public.trips
  add constraint trips_fuel_resolution_check check (
    fuel_resolution is null
    or fuel_resolution in ('logged', 'deferred', 'not_refuelled', 'not_needed')
  );

create index if not exists trips_deferred_fuel_resolution_idx
  on public.trips (ledger_id, updated_at)
  where deleted_at is null and fuel_resolution = 'deferred';

-- Direct/RLS writes must not claim a logged refuel unless the referenced active
-- fuel payment exists in the same workspace. Non-logged states carry no key.
create or replace function public.enforce_trip_fuel_resolution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;

  if new.fuel_resolution = 'logged' then
    if nullif(new.completion_fuel_legacy_id, '') is null then
      raise exception 'Logged trip fuel requires a fuel idempotency key' using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.fuel_payments fp
      where fp.ledger_id = new.ledger_id
        and fp.legacy_id = new.completion_fuel_legacy_id
        and fp.deleted_at is null
    ) then
      raise exception 'Logged trip fuel must reference an active fuel payment in the same ledger'
        using errcode = '23514';
    end if;
  elsif new.completion_fuel_legacy_id is not null then
    raise exception 'Only logged trip fuel may reference a fuel payment' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_trip_fuel_resolution() from public;
revoke all on function public.enforce_trip_fuel_resolution() from anon;
revoke all on function public.enforce_trip_fuel_resolution() from authenticated;

drop trigger if exists enforce_trip_fuel_resolution_trigger on public.trips;
create trigger enforce_trip_fuel_resolution_trigger
before insert or update of fuel_resolution, completion_fuel_legacy_id, ledger_id, deleted_at
on public.trips
for each row execute function public.enforce_trip_fuel_resolution();

-- Retiring the linked fuel record reopens the durable follow-up instead of leaving
-- the trip falsely marked as resolved. Hard workspace purges delete both rows and
-- do not need this soft-delete repair path.
create or replace function public.reopen_trip_fuel_resolution_on_payment_retire()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and old.legacy_id is not null then
    update public.trips t
    set fuel_resolution = 'deferred',
        completion_fuel_legacy_id = null,
        updated_at = now()
    where t.ledger_id = old.ledger_id
      and t.completion_fuel_legacy_id = old.legacy_id
      and t.deleted_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.reopen_trip_fuel_resolution_on_payment_retire() from public;
revoke all on function public.reopen_trip_fuel_resolution_on_payment_retire() from anon;
revoke all on function public.reopen_trip_fuel_resolution_on_payment_retire() from authenticated;

drop trigger if exists reopen_trip_fuel_resolution_on_payment_retire_trigger on public.fuel_payments;
create trigger reopen_trip_fuel_resolution_on_payment_retire_trigger
after update of deleted_at on public.fuel_payments
for each row execute function public.reopen_trip_fuel_resolution_on_payment_retire();

create or replace function public.complete_booking_trip_with_fuel(
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
  fuel_resolution_value text,
  fuel_legacy_id text default null,
  fuel_payer_member_id uuid default null,
  fuel_payment_date_value date default null,
  fuel_amount_value numeric default null,
  fuel_currency_value text default 'DKK',
  fuel_liters_value numeric default null,
  fuel_price_per_liter_value numeric default null,
  fuel_odometer_value numeric default null,
  fuel_station_name_value text default null,
  fuel_station_brand_value text default null,
  fuel_station_lat_value numeric default null,
  fuel_station_lng_value numeric default null,
  fuel_full_tank_value boolean default false,
  trip_event_title text default null,
  trip_event_body text default null,
  fuel_event_title text default null,
  fuel_event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  trip_result jsonb;
  fuel_result jsonb := null;
  saved_trip_id uuid;
  saved_fuel_id uuid := null;
  existing_fuel_resolution text;
  existing_fuel_legacy_id text;
  effective_fuel_legacy_id text;
  fuel_payload_present boolean;
begin
  if fuel_resolution_value is null
     or fuel_resolution_value not in ('logged', 'deferred', 'not_refuelled', 'not_needed') then
    raise exception 'Invalid trip fuel resolution' using errcode = '22023';
  end if;

  fuel_payload_present :=
    nullif(fuel_legacy_id, '') is not null
    or fuel_payer_member_id is not null
    or fuel_payment_date_value is not null
    or fuel_amount_value is not null
    or fuel_liters_value is not null
    or fuel_price_per_liter_value is not null
    or fuel_odometer_value is not null
    or nullif(fuel_station_name_value, '') is not null
    or nullif(fuel_station_brand_value, '') is not null
    or fuel_station_lat_value is not null
    or fuel_station_lng_value is not null
    or coalesce(fuel_full_tank_value, false)
    or coalesce(nullif(fuel_currency_value, ''), 'DKK') <> 'DKK';

  if fuel_resolution_value = 'logged' then
    if nullif(fuel_legacy_id, '') is null
       or fuel_payer_member_id is null
       or fuel_payment_date_value is null
       or fuel_amount_value is null
       or fuel_amount_value <= 0 then
      raise exception 'Logged trip fuel requires a key, payer, date, and positive amount'
        using errcode = '22023';
    end if;
  elsif fuel_payload_present then
    raise exception 'Fuel details are only accepted when the resolution is logged'
      using errcode = '22023';
  end if;

  -- This command inherits the booking lock, actor/driver/date checks, open-period
  -- lock, participant validation, and trip idempotency from migration 123.
  trip_result := public.upsert_booking_trip_with_participants(
    target_ledger_id,
    target_open_period_id,
    target_booking_id,
    legacy_trip_id,
    booking_driver_member_id,
    trip_date_value,
    start_km_value,
    end_km_value,
    note_value,
    participant_member_ids,
    trip_event_title,
    trip_event_body
  );

  saved_trip_id := nullif(trip_result ->> 'trip_id', '')::uuid;
  if saved_trip_id is null then
    raise exception 'Booking completion did not return a trip id' using errcode = '40001';
  end if;

  select t.fuel_resolution, t.completion_fuel_legacy_id
    into existing_fuel_resolution, existing_fuel_legacy_id
    from public.trips t
    where t.id = saved_trip_id
      and t.ledger_id = target_ledger_id
      and t.deleted_at is null
    for update of t;

  if not found then
    raise exception 'Booking completion trip was not found' using errcode = '40001';
  end if;

  -- A delayed pre-refuel replay must never downgrade a fuel payment already logged
  -- by a newer attempt. The trip RPC remains free to reconcile odometer/participants.
  if existing_fuel_resolution = 'logged'
     and existing_fuel_legacy_id is not null
     and fuel_resolution_value <> 'logged' then
    return trip_result || jsonb_build_object(
      'fuel_resolution', 'logged',
      'fuel_id', (
        select fp.id
        from public.fuel_payments fp
        where fp.ledger_id = target_ledger_id
          and fp.legacy_id = existing_fuel_legacy_id
          and fp.deleted_at is null
        limit 1
      ),
      'reused_existing_fuel', true
    );
  end if;

  if fuel_resolution_value = 'logged' then
    -- Once a completion has a linked fuel key, all retries reuse it even if another
    -- device supplies a different local key. The booking lock serializes this read.
    effective_fuel_legacy_id := coalesce(
      nullif(existing_fuel_legacy_id, ''),
      nullif(fuel_legacy_id, '')
    );

    fuel_result := public.upsert_fuel_payment(
      target_ledger_id,
      target_open_period_id,
      effective_fuel_legacy_id,
      fuel_payer_member_id,
      fuel_payment_date_value,
      fuel_amount_value,
      coalesce(nullif(fuel_currency_value, ''), 'DKK'),
      fuel_liters_value,
      fuel_price_per_liter_value,
      fuel_odometer_value,
      fuel_station_name_value,
      fuel_station_brand_value,
      fuel_station_lat_value,
      fuel_station_lng_value,
      null,
      null,
      coalesce(fuel_full_tank_value, false),
      fuel_event_title,
      fuel_event_body
    );

    saved_fuel_id := nullif(fuel_result ->> 'fuel_id', '')::uuid;
    if saved_fuel_id is null then
      raise exception 'Booking completion did not return a fuel id' using errcode = '40001';
    end if;

    update public.trips t
    set fuel_resolution = 'logged',
        completion_fuel_legacy_id = effective_fuel_legacy_id,
        updated_at = now()
    where t.id = saved_trip_id
      and t.ledger_id = target_ledger_id;
  else
    update public.trips t
    set fuel_resolution = fuel_resolution_value,
        completion_fuel_legacy_id = null,
        updated_at = now()
    where t.id = saved_trip_id
      and t.ledger_id = target_ledger_id;
  end if;

  if not found then
    raise exception 'Booking completion could not persist its fuel resolution' using errcode = '40001';
  end if;

  return trip_result || jsonb_build_object(
    'fuel_resolution', fuel_resolution_value,
    'fuel_id', saved_fuel_id,
    'reused_existing_fuel', existing_fuel_legacy_id is not null
  );
end;
$$;

revoke all on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  numeric, numeric, boolean, text, text, text, text
) from public;
revoke all on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  numeric, numeric, boolean, text, text, text, text
) from anon;
grant execute on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  numeric, numeric, boolean, text, text, text, text
) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '136_atomic_booking_fuel_completion',
  'Atomic booking-trip fuel completion (GV-334): add durable trip fuel-resolution state and an idempotent command that atomically saves a booking-linked trip with an optional real fuel payment.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 157: bro/faerge crossing cost on the trip (GVM-415)
--
-- A crossing — Storebaeltsbroen, Oeresundsbroen, a ferry — is a real cost of a
-- specific drive, and until now there was nowhere to put it. Logging it as a
-- workspace expense splits it by the workspace Afregning rule over everyone,
-- including the members who were not in the car; logging it as fuel corrupts the
-- rate. The owner's decision (GVM-415) is that a crossing hangs on the TRIP and is
-- split EQUALLY across THAT trip's participants — the same circle the trip's fuel
-- is split over — with the person who paid credited for it.
--
-- Three things follow from "the same circle as that trip's fuel", and all three are
-- deliberate:
--
--   * the split universe is the trip's assignees (active participants, driver
--     fallback when the participant set is empty), not the workspace's active
--     members. Both settlement engines already resolve exactly this set for the km
--     split; the crossing reuses it rather than defining a second, near-identical
--     rule that can drift.
--   * the split is EQUAL, never km-weighted. A crossing is a flat toll for the
--     vehicle, so weighting it by distance would make the person who was dropped off
--     first pay less for a bridge they crossed too. It therefore does NOT follow
--     ledgers.repairs_split_mode or expense_split_defaults either.
--   * the credited payer is a column of its own, defaulting to the driver, because
--     the driver is usually but not always the one whose card the toll landed on
--     (the fuel and repair engines learned the same lesson in 108).
--
-- No new table: three nullable columns on public.trips, matching how repairs store
-- money (cost_dkk numeric(12,2)) and how fuel names a payer (payer_member_id). No
-- new event_type either — a crossing is written by the trip upsert RPCs and rides
-- their existing trip_created event, so the ledger-event classification guard
-- (GV-413) has nothing new to classify.
--
-- ARITY CHANGE, NOT A REPLACEMENT (the migration 156 lesson, and 063's before it):
-- the three trip-writing RPCs each gain three parameters, and `create or replace`
-- with a different parameter list creates a NEW OVERLOAD rather than replacing the
-- old one. Because every new parameter has a default, PostgREST would then find two
-- candidate signatures for the same body and fail to resolve between them. Each old
-- exact signature is therefore DROPped first, and since DROP + CREATE resets the
-- ACL, every grant is restated with anon named explicitly (migration 148).
--
-- Every re-declared function is based on its NEWEST prior definition, verified by
-- grepping every migration: upsert_trip_with_participants 054,
-- upsert_booking_trip_with_participants 123, complete_booking_trip_with_fuel 151,
-- calculate_period_settlement 114, calculate_period_entry_fingerprint 114. (083,
-- 148 and 151 touched only the grants on the first of these; 127, 141 and 143
-- reference the settlement functions without redefining them.)
--
-- BREAKING, and it must ship WITH its mobile twin: the entry fingerprint's trips
-- component changes from bare ids to ["<id>",<oere>] PAIRS, the same treatment
-- repairs got in 114 (GV-277) and for the same reason — a crossing-cost edit moves
-- neither totalKm nor totalPaid, so the close's amount guard cannot see it, and a
-- prepared close would archive a settlement computed from the pre-edit cost. Until
-- govehlo-mobile's periodEntryFingerprint mirrors the new format, every close from
-- an un-updated client is rejected with "Entries changed since this close was
-- prepared".

-- ── 1. The columns ──────────────────────────────────────────────────────────────
-- numeric(12,2) mirrors vehicle_repairs.cost_dkk (money in kroner, two decimals).
-- The named CHECK allows null (no crossing) and 0 (a crossing the RPCs normalise
-- away) but never a negative toll. crossing_note is the display label the trip
-- detail screen shows ("Storebaeltsbroen · retur"); it is never parsed. The payer FK
-- is on delete set null like every other member reference, and the settlement reads
-- coalesce(crossing_paid_by_member_id, driver_member_id) so a cleared payer falls
-- back to the driver rather than dropping the credit.
alter table public.trips
  add column if not exists crossing_cost_dkk numeric(12,2);

alter table public.trips
  add column if not exists crossing_note text;

alter table public.trips
  add column if not exists crossing_paid_by_member_id uuid
  references public.ledger_members(id) on delete set null;

alter table public.trips
  drop constraint if exists trips_crossing_cost_check;

alter table public.trips
  add constraint trips_crossing_cost_check check (
    crossing_cost_dkk is null or crossing_cost_dkk >= 0
  );

-- ── 2. upsert_trip_with_participants — re-declared off migration 054 ────────────
-- 054 verbatim apart from the three trailing-but-for-the-event-params crossing
-- arguments, the normalisation block that resolves them, and the three columns on
-- both the INSERT and the ON CONFLICT UPDATE path (an edit must be able to remove a
-- crossing, not only add one). The event params stay LAST, as in every RPC since
-- 051, so a client that names its arguments is unaffected by the insertion point.
drop function if exists public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text);

create or replace function public.upsert_trip_with_participants(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_trip_id text,
  driver_member_id uuid,
  trip_date_value date,
  start_km_value numeric,
  end_km_value numeric,
  note_value text,
  participant_member_ids uuid[],
  crossing_cost_value numeric default null,
  crossing_note_value text default null,
  crossing_paid_by uuid default null,
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
  locked_period_id uuid;
  saved_trip_id uuid;
  unique_participant_ids uuid[];
  existing_trip record;
  resolved_crossing_cost numeric;
  resolved_crossing_note text;
  resolved_crossing_payer uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_trip_id is null or legacy_trip_id = '' then
    raise exception 'Missing legacy trip id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save trips' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if driver_member_id is null or not public.member_belongs_to_ledger(driver_member_id, target_ledger_id) then
    raise exception 'Trip driver must be an active member of this ledger' using errcode = '23514';
  end if;

  select coalesce(array_agg(distinct member_id), array[]::uuid[])
    into unique_participant_ids
  from unnest(coalesce(participant_member_ids, array[]::uuid[])) as member_id
  where public.member_belongs_to_ledger(member_id, target_ledger_id);

  if coalesce(array_length(unique_participant_ids, 1), 0) = 0 then
    raise exception 'Trip must include at least one active ledger participant' using errcode = '23514';
  end if;

  if not driver_member_id = any(unique_participant_ids) then
    unique_participant_ids := array_append(unique_participant_ids, driver_member_id);
  end if;

  if end_km_value <= start_km_value then
    raise exception 'Trip end km must be greater than start km' using errcode = '23514';
  end if;

  -- GVM-415: a bro/faerge crossing (Storebaelt, a ferry) hangs on the TRIP, not on
  -- Udgifter, because it is incurred by that drive and shared by the people in that
  -- car. It is a FLAT per-trip cost: calculate_period_settlement splits it equally
  -- over the trip's assignees (participants, driver fallback), never by km and never
  -- by the workspace Afregning rule. Here we only persist it.
  --
  -- Null or zero cost means "no crossing", and it clears the note and the payer with
  -- it: an edit that removes the crossing must not leave orphaned metadata behind on
  -- the row (the settlement ignores a null cost, but the trip detail screen would
  -- still show a label for a crossing that no longer exists). A negative cost is
  -- rejected here rather than left to the table CHECK so the client gets a message.
  if crossing_cost_value is not null and crossing_cost_value < 0 then
    raise exception 'Crossing cost cannot be negative' using errcode = '23514';
  end if;

  if crossing_cost_value is null or round(crossing_cost_value, 2) = 0 then
    resolved_crossing_cost := null;
    resolved_crossing_note := null;
    resolved_crossing_payer := null;
  else
    resolved_crossing_cost := round(crossing_cost_value, 2);
    resolved_crossing_note := nullif(btrim(crossing_note_value), '');
    if length(coalesce(resolved_crossing_note, '')) > 120 then
      raise exception 'Crossing note must be 120 characters or fewer' using errcode = '22023';
    end if;
    -- Payer: null means the driver paid. A NAMED payer must be an ACTIVE member of
    -- this workspace, the same rule insert_repair holds a named repair payer to
    -- (108/114) — member_belongs_to_ledger is deliberately NOT used here, because it
    -- only asks whether the row exists in the workspace and would let a departed
    -- member be named as today's payer. That is a different case from the settlement
    -- CREDITING an inactive payer (GV-274), which is about a member who left AFTER
    -- the crossing was logged.
    resolved_crossing_payer := coalesce(crossing_paid_by, driver_member_id);
    if not exists (
      select 1
      from public.ledger_members lm
      where lm.id = resolved_crossing_payer
        and lm.ledger_id = target_ledger_id
        and lm.is_active = true
    ) then
      raise exception 'Crossing payer must be an active member of this workspace' using errcode = '23514';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':trip:' || legacy_trip_id));

  select * into existing_trip
  from public.trips t
  where t.ledger_id = target_ledger_id
    and t.legacy_id = legacy_trip_id
  for update;

  if existing_trip.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_trip.created_by_member_id = actor_member_id
    or existing_trip.driver_member_id = actor_member_id
  ) then
    raise exception 'Only the trip creator, driver, or a ledger admin can update this trip' using errcode = '42501';
  end if;

  insert into public.trips (
    legacy_id, ledger_id, period_id, driver_member_id, trip_date,
    start_km, end_km, note, crossing_cost_dkk, crossing_note,
    crossing_paid_by_member_id, created_by_member_id, deleted_at, updated_at
  ) values (
    legacy_trip_id, target_ledger_id, target_open_period_id, driver_member_id,
    trip_date_value, start_km_value, end_km_value, nullif(note_value, ''),
    resolved_crossing_cost, resolved_crossing_note, resolved_crossing_payer,
    actor_member_id, null, now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    driver_member_id = excluded.driver_member_id,
    trip_date = excluded.trip_date,
    start_km = excluded.start_km,
    end_km = excluded.end_km,
    note = excluded.note,
    crossing_cost_dkk = excluded.crossing_cost_dkk,
    crossing_note = excluded.crossing_note,
    crossing_paid_by_member_id = excluded.crossing_paid_by_member_id,
    deleted_at = null,
    updated_at = now()
  returning id into saved_trip_id;

  delete from public.trip_participants where trip_id = saved_trip_id;

  insert into public.trip_participants (trip_id, member_id)
  select saved_trip_id, member_id
  from unnest(unique_participant_ids) as member_id
  on conflict (trip_id, member_id) do nothing;

  -- Activity feed event, on create only (GVM-84).
  if existing_trip.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'trip_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('trip_id', saved_trip_id)
    );
  end if;

  return jsonb_build_object(
    'trip_id', saved_trip_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_trip_id,
    'participant_count', coalesce(array_length(unique_participant_ids, 1), 0)
  );
end;
$$;

revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text) from public;
revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text) from anon;
grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text) to authenticated;

-- ── 3. upsert_booking_trip_with_participants — re-declared off migration 123 ────
-- 123 verbatim apart from the three crossing parameters and passing them through to
-- the canonical trip RPC above. All the booking-specific behaviour — the booking
-- lock, the driver and date-window checks, the idempotency key rules — is untouched.
drop function if exists public.upsert_booking_trip_with_participants(text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text);

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
  crossing_cost_value numeric default null,
  crossing_note_value text default null,
  crossing_paid_by uuid default null,
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
    crossing_cost_value,
    crossing_note_value,
    crossing_paid_by,
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
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text
) from public;
revoke all on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text
) from anon;
grant execute on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text
) to authenticated;

-- ── 4. complete_booking_trip_with_fuel — re-declared off migration 151 ──────────
-- 151 verbatim apart from the three crossing parameters and passing them through.
-- They sit after the fuel block and before the four event params, so the fuel
-- payload's positional shape is unchanged for the SQL callers in this repo's
-- functional suites.
drop function if exists public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, text, text, text, text
);

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
  fuel_full_tank_value boolean default false,
  crossing_cost_value numeric default null,
  crossing_note_value text default null,
  crossing_paid_by uuid default null,
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
    crossing_cost_value,
    crossing_note_value,
    crossing_paid_by,
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
  boolean, numeric, text, uuid, text, text, text, text
) from public;
revoke all on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, numeric, text, uuid, text, text, text, text
) from anon;
grant execute on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, numeric, text, uuid, text, text, text, text
) to authenticated;

-- ── 5. calculate_period_settlement — re-declared off migration 114 ──────────────
-- 114 verbatim — the trips/fuel maths, the expense and repair largest-remainder
-- chains, the period_id repair scoping and the credit-only inactive payer rule are
-- untouched. The GVM-415 additions are one credit CTE, one debit chain, one clause
-- in the settlement_members universe, two per-member columns, one total and two
-- terms in net. Signature unchanged, so this stays a plain create-or-replace.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  all_members as (
    -- Every member of the ledger, active or not. Used to retain (not drop) an
    -- entry whose payer has since gone inactive so that payer can be credited
    -- (GV-274, credit-only). is_active decides who lands in settlement_members.
    select lm.id, lm.name, lm.is_active
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km,
           t.crossing_cost_dkk,
           coalesce(t.crossing_paid_by_member_id, t.driver_member_id) as crossing_payer_member_id
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
           lt.crossing_cost_dkk,
           lt.crossing_payer_member_id,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  member_km as (
    -- Unrounded per-member km, reused both for the settlement km and as the
    -- usage-split weight (the client weights usage on raw km).
    select ks.member_id, sum(ks.share_km) as km_sum
    from km_shares ks
    group by ks.member_id
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  ledger_defaults as (
    select l.expense_split_defaults as defaults
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  repairs_mode as (
    -- The workspace rule that governs repair folding (GVM-307). null (old row,
    -- pre-107) behaves like deles_ikke: the mode filter below excludes every
    -- repair, matching a client that has no mode field to read.
    select l.repairs_split_mode as mode
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  period_bounds as (
    -- Legacy null-period repairs (pre-114) have no period_id: such a repair counts
    -- in the period whose [opened_at, closed_at) window contains its created_at —
    -- the moment it was LOGGED (GV-269; repair_date is display-only). A stamped
    -- repair (GV-277) is matched by period_id instead and never needs this window.
    -- The settling period is still open here (closed_at null), so its window has no
    -- upper bound.
    select sp.opened_at, sp.closed_at
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is a MEMBER of the ledger (active
    -- OR inactive). An inactive payer is retained (credit-only, GV-274) rather
    -- than dropped: its cost is still split (over active members, via the weight
    -- CTEs below), and the payer is credited what they paid. An expense with no
    -- payer or a non-member payer is still skipped entirely.
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join all_members payer on payer.id = we.paid_by_member_id
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
      and we.amount_dkk > 0
  ),
  expense_weights as (
    select pe.id as expense_id,
           pe.amount_dkk,
           am.id as member_id,
           case pe.rule
             when 'usage'  then coalesce(mk.km_sum, 0)
             when 'custom' then coalesce((pe.split_config ->> am.id::text)::numeric, 0)
             else 1::numeric
           end as weight
    from period_expenses pe
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  expense_weight_totals as (
    select expense_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from expense_weights
    group by expense_id
  ),
  expense_cents as (
    -- Largest-remainder split, step 1 (GV-269): per expense, work in integer
    -- oere and compute each member's exact (unrounded) share of them. A
    -- non-positive total weight falls back to equal weights, matching the
    -- pre-108 fallback and the client.
    select ew.expense_id,
           ew.member_id,
           round(ew.amount_dkk * 100) as total_cents,
           round(ew.amount_dkk * 100)
             * (case when ewt.total_weight > 0 then ew.weight else 1 end)
             / (case when ewt.total_weight > 0 then ewt.total_weight else ewt.member_count end)
             as exact_cents
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
  ),
  expense_lr as (
    -- Step 2: floor every share, then hand the leftover oere (R = total oere -
    -- sum of floors, 0 <= R < member count) to the R members with the largest
    -- remainders; ties break on member id ascending (uuid byte order = its
    -- canonical text order), matching the client tie-break. Every expense's
    -- shares now sum EXACTLY to its amount.
    select ec.member_id,
           floor(ec.exact_cents)
             + case when row_number() over (
                      partition by ec.expense_id
                      order by ec.exact_cents - floor(ec.exact_cents) desc, ec.member_id asc
                    ) <= ec.total_cents - sum(floor(ec.exact_cents)) over (partition by ec.expense_id)
                    then 1 else 0 end
             as share_cents
    from expense_cents ec
  ),
  expense_share as (
    select el.member_id,
           sum(el.share_cents) / 100.0 as share
    from expense_lr el
    group by el.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  period_repairs as (
    -- Repairs folded per the workspace mode (GVM-307). Only efter_koersel /
    -- ligeligt fold; deles_ikke (or a null mode) yields no rows. The payer is
    -- paid_by_member_id, falling back to created_by_member_id for pre-108 rows
    -- (GV-269); a repair whose payer is a MEMBER of the ledger — active OR
    -- inactive — is retained (credit-only, GV-274). Scoped by period_id (GV-277):
    -- a stamped repair matches vr.period_id = target_period_id; a legacy
    -- null-period repair falls back to created_at within the period's
    -- [opened_at, closed_at) window (timestamps, no ::date truncation).
    select vr.id,
           vr.cost_dkk,
           coalesce(vr.paid_by_member_id, vr.created_by_member_id) as payer_member_id,
           rm.mode
    from public.vehicle_repairs vr
    cross join repairs_mode rm
    cross join period_bounds pb
    join all_members payer on payer.id = coalesce(vr.paid_by_member_id, vr.created_by_member_id)
    where vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.cost_dkk > 0
      and rm.mode in ('efter_koersel', 'ligeligt')
      and (
        vr.period_id = target_period_id
        or (vr.period_id is null
            and vr.created_at >= pb.opened_at
            and (pb.closed_at is null or vr.created_at < pb.closed_at))
      )
  ),
  repair_weights as (
    -- efter_koersel weights by each member's raw km (like the expense usage rule);
    -- ligeligt weights everyone equally. Zero total weight (efter_koersel with no
    -- km) falls back to an equal split below, matching the client.
    select pr.id as repair_id,
           pr.cost_dkk,
           am.id as member_id,
           case when pr.mode = 'efter_koersel' then coalesce(mk.km_sum, 0)
                else 1::numeric end as weight
    from period_repairs pr
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  repair_weight_totals as (
    select repair_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from repair_weights
    group by repair_id
  ),
  repair_cents as (
    -- Largest-remainder split for repairs — identical to the expense chain above
    -- (GV-269).
    select rw.repair_id,
           rw.member_id,
           round(rw.cost_dkk * 100) as total_cents,
           round(rw.cost_dkk * 100)
             * (case when rwt.total_weight > 0 then rw.weight else 1 end)
             / (case when rwt.total_weight > 0 then rwt.total_weight else rwt.member_count end)
             as exact_cents
    from repair_weights rw
    join repair_weight_totals rwt using (repair_id)
  ),
  repair_lr as (
    select rc.member_id,
           floor(rc.exact_cents)
             + case when row_number() over (
                      partition by rc.repair_id
                      order by rc.exact_cents - floor(rc.exact_cents) desc, rc.member_id asc
                    ) <= rc.total_cents - sum(floor(rc.exact_cents)) over (partition by rc.repair_id)
                    then 1 else 0 end
             as share_cents
    from repair_cents rc
  ),
  repair_share as (
    select rl.member_id,
           sum(rl.share_cents) / 100.0 as share
    from repair_lr rl
    group by rl.member_id
  ),
  repair_paid as (
    select pr.payer_member_id as member_id, sum(pr.cost_dkk)::numeric as paid
    from period_repairs pr
    group by pr.payer_member_id
  ),
  period_crossings as (
    -- Bro/faerge crossings (GVM-415). A crossing hangs on the TRIP and is shared by
    -- the people in that car: the split circle is the trip's own assignees — exactly
    -- the set trip_assignees already resolved for the km split (active participants,
    -- driver fallback) — NOT the workspace Afregning rule and NOT the active-member
    -- universe the expense/repair chains split over. It is also a FLAT cost, so it is
    -- split EQUALLY and never weighted by km: the second person in the car costs the
    -- ferry the same whether they rode 5 km or 500.
    --
    -- The credited payer is coalesce(crossing_paid_by_member_id, driver_member_id) —
    -- the column defaults to the driver at write time, and the coalesce also covers a
    -- payer whose row was later cleared by the FK's on delete set null. As with fuel,
    -- expenses and repairs, a payer who is a MEMBER of the ledger — active OR
    -- inactive — is retained (credit-only, GV-274).
    --
    -- A trip with NO assignees (every participant and the driver have since gone
    -- inactive) is skipped entirely, credit AND debit: crediting a cost nobody is
    -- debited for would stop the period netting to zero. That trip's km is already
    -- dropped by km_shares for the same reason.
    select ta.trip_id,
           ta.crossing_cost_dkk as cost_dkk,
           ta.crossing_payer_member_id as payer_member_id,
           ta.assignees
    from trip_assignees ta
    join all_members payer on payer.id = ta.crossing_payer_member_id
    where ta.crossing_cost_dkk is not null
      and ta.crossing_cost_dkk > 0
      and ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  crossing_cents as (
    -- Largest-remainder split, step 1 — the same integer-oere chain the expense and
    -- repair CTEs above run (GV-269), so the three cannot drift and all of them agree
    -- with the client's splitByWeights. The only difference is the universe (this
    -- trip's assignees) and the weights (equal, one each).
    select pc.trip_id,
           shared.member_id,
           round(pc.cost_dkk * 100) as total_cents,
           round(pc.cost_dkk * 100) / array_length(pc.assignees, 1)::numeric as exact_cents
    from period_crossings pc
    cross join lateral unnest(pc.assignees) as shared(member_id)
  ),
  crossing_lr as (
    -- Step 2: floor every share, then hand the leftover oere to the largest
    -- remainders; ties break on member id ascending. With equal weights EVERY
    -- remainder is identical, so the tie-break is what decides — the R lowest member
    -- ids each take one extra oere (250,00 kr over three people = 83,34 / 83,33 /
    -- 83,33, the extra oere going to the lowest id).
    select cl.member_id,
           floor(cl.exact_cents)
             + case when row_number() over (
                      partition by cl.trip_id
                      order by cl.exact_cents - floor(cl.exact_cents) desc, cl.member_id asc
                    ) <= cl.total_cents - sum(floor(cl.exact_cents)) over (partition by cl.trip_id)
                    then 1 else 0 end
             as share_cents
    from crossing_cents cl
  ),
  crossing_share as (
    select cs.member_id,
           sum(cs.share_cents) / 100.0 as share
    from crossing_lr cs
    group by cs.member_id
  ),
  crossing_paid as (
    select pc.payer_member_id as member_id, sum(pc.cost_dkk)::numeric as paid
    from period_crossings pc
    group by pc.payer_member_id
  ),
  settlement_members as (
    -- The settlement participant set (GV-274): every ACTIVE member, plus any
    -- member (necessarily inactive, since actives are already in) who PAID fuel,
    -- an expense, a repair, or a trip's bro/faerge crossing this period. Inactive
    -- payers are credit-only — they
    -- appear so they can be credited what they paid, but they carry zero weight in
    -- every share split (the weight CTEs cross join active_members only), so their
    -- net is exactly +paid. An inactive member who paid nothing never appears.
    select am.id, am.name
    from all_members am
    where am.is_active
       or am.id in (select fp.member_id from fuel_paid fp)
       or am.id in (select ep.member_id from expense_paid ep)
       or am.id in (select rp.member_id from repair_paid rp)
       or am.id in (select cp.member_id from crossing_paid cp)
  ),
  per_member as (
    select sm.id,
           sm.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share,
           round(coalesce(rp.paid, 0), 2) as repair_paid,
           round(coalesce(rs.share, 0), 2) as repair_share,
           round(coalesce(cp.paid, 0), 2) as crossing_paid,
           round(coalesce(cs.share, 0), 2) as crossing_share
    from settlement_members sm
    left join member_km mk on mk.member_id = sm.id
    left join fuel_paid f on f.member_id = sm.id
    left join expense_paid xp on xp.member_id = sm.id
    left join expense_share xs on xs.member_id = sm.id
    left join repair_paid rp on rp.member_id = sm.id
    left join repair_share rs on rs.member_id = sm.id
    left join crossing_paid cp on cp.member_id = sm.id
    left join crossing_share cs on cs.member_id = sm.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses,
           coalesce(sum(pm.repair_paid), 0) as total_repairs,
           coalesce(sum(pm.crossing_paid), 0) as total_crossings
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'totalRepairs', t.total_repairs,
    'totalCrossings', t.total_crossings,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'repairPaid', pm.repair_paid,
        'repairShare', pm.repair_share,
        'crossingPaid', pm.crossing_paid,
        'crossingShare', pm.crossing_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid + pm.repair_paid + pm.crossing_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share - pm.repair_share - pm.crossing_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid + pm.repair_paid + pm.crossing_paid - pm.expense_share - pm.repair_share - pm.crossing_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

-- ── 6. calculate_period_entry_fingerprint — re-declared off migration 114 ───────
-- 114 verbatim except that trips are emitted as ["<id>",<oere>] pairs instead of
-- bare ids, exactly the shape repairs took in 114 (GV-277) and for the same reason:
-- a crossing-cost edit changes neither totalKm nor totalPaid, so the close's amount
-- guard is blind to it, and a prepared close would archive a settlement computed
-- from the pre-edit cost. oere = round(coalesce(crossing_cost_dkk, 0) * 100), so a
-- crossing-free trip contributes ["<id>",0] and every trip in the period is present
-- with a pair — unlike "repairs", the "trips" key is never omitted. Integer oere
-- serialise byte-identically in Postgres and JS; the client's periodEntryFingerprint
-- mirrors the exact format.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result text;
  repairs_json text;
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

  -- Repairs are scoped by period_id (GV-277); a legacy null-period row (pre-114)
  -- falls back to created_at within the period's [opened_at, closed_at) window,
  -- exactly as calculate_period_settlement scopes them. During a close the period is
  -- still open (closed_at null), so the window has no upper bound. Each repair is
  -- emitted as an ["<id>",<oere>] pair so a cost edit changes the fingerprint; the
  -- empty string yields no "repairs" key below.
  select coalesce(
           string_agg(
             '[' || to_json(vr.id::text)::text || ',' || round(vr.cost_dkk * 100)::bigint::text || ']',
             ',' order by vr.id::text collate "C"),
           '')
    into repairs_json
    from public.vehicle_repairs vr
    cross join public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and (
        vr.period_id = target_period_id
        or (vr.period_id is null
            and vr.created_at >= sp.opened_at
            and (sp.closed_at is null or vr.created_at < sp.closed_at))
      );

  select '{"trips":['
    || coalesce((
         select string_agg(
                  '[' || to_json(t.id::text)::text || ','
                      || round(coalesce(t.crossing_cost_dkk, 0) * 100)::bigint::text || ']',
                  ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || '],"expenses":['
    || coalesce((
         select string_agg(to_json(we.id::text)::text, ',' order by we.id::text collate "C")
         from public.workspace_expenses we
         where we.ledger_id = target_ledger_id
           and we.period_id = target_period_id
           and we.deleted_at is null
       ), '')
    || ']'
    || case when repairs_json <> '' then ',"repairs":[' || repairs_json || ']' else '' end
    || '}'
  into result;

  return result;
end;
$$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '157_trip_crossing_cost',
  'Bro/faerge crossing cost on the trip (GVM-415). public.trips gains crossing_cost_dkk numeric(12,2) (named CHECK: null or >= 0), crossing_note text and crossing_paid_by_member_id uuid (FK, on delete set null). The three trip-writing RPCs each gain crossing_cost_value / crossing_note_value / crossing_paid_by immediately before their trailing event params: upsert_trip_with_participants (off 054) normalises them — null or zero cost clears the note and payer too, a negative cost is rejected, the payer defaults to the driver and a named payer must be an ACTIVE member (the insert_repair rule) — and persists them on both the INSERT and the ON CONFLICT UPDATE path; upsert_booking_trip_with_participants (off 123) and complete_booking_trip_with_fuel (off 151) pass them through. All three are DROP + CREATE, not create-or-replace, because a differing parameter list would leave the old overload live and PostgREST could not resolve between them (the 156/063 lesson); ACLs are restated with anon named explicitly per 148. calculate_period_settlement (off 114) folds crossings: the payer, coalesce(crossing_paid_by_member_id, driver_member_id), is credited crossingPaid, and each cost is split EQUALLY over that trip''s assignees (the existing trip_assignees CTE: active participants, driver fallback) through the same integer-oere largest-remainder chain the expense and repair splits use, ties broken by member id ascending, as crossingShare. A crossing does NOT follow the workspace Afregning rule and is never km-weighted. An INACTIVE crossing payer joins settlement_members credit-only exactly as fuel/expense/repair payers do (GV-274); a trip with no active assignees is skipped on both sides so the period still nets to zero. New output keys: totalCrossings at the top level, crossingPaid and crossingShare per person, and net = fuelPaid + expensePaid + repairPaid + crossingPaid - tripCost - expenseShare - repairShare - crossingShare. calculate_period_entry_fingerprint (off 114) emits trips as ["<id>",<oere>] pairs (oere = round(coalesce(crossing_cost_dkk, 0) * 100)) instead of bare ids, so a crossing-cost edit busts a prepared close the way a repair-cost edit has since GV-277; the mobile client mirrors the format byte-identically and must ship with this.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

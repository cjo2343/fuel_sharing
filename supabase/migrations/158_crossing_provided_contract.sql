-- Migration 158: an old client must not erase a crossing it cannot see (GV-417)
--
-- Migration 157 gave the three trip-writing RPCs three crossing parameters, all with
-- a `default null`, and DROPped the old narrower overloads. Both halves of that were
-- right on their own and wrong together: a client build that predates the crossing UI
-- now calls the SAME function it always called, with the three new parameters simply
-- absent, and PostgreSQL fills them with null. upsert_trip_with_participants then
-- normalises that to "no crossing" and its ON CONFLICT branch writes the three nulls
-- straight over the columns:
--
--     crossing_cost_dkk = excluded.crossing_cost_dkk,
--     crossing_note = excluded.crossing_note,
--     crossing_paid_by_member_id = excluded.crossing_paid_by_member_id,
--
-- So an old build that merely EDITS a trip — or retries a queued write, or completes a
-- booking, both of which route through that same upsert — silently erases a crossing a
-- newer device logged. Nobody is at risk today, because no third-party install exists
-- yet; that stops being true at the first TestFlight build, and after that the two
-- client versions coexist for as long as people put off updating.
--
-- ── The fix: make "I did not send a crossing" distinguishable from "clear it" ─────
-- A null cost cannot carry that distinction — it is already spoken for, as the way an
-- edit REMOVES a crossing (157 clears the note and the payer with it, deliberately).
-- The distinction therefore needs a channel of its own, and this migration adds it as
-- a single boolean:
--
--   crossing_provided = false (the parameter absent — i.e. every pre-crossing client)
--       the UPDATE paths PRESERVE the row's existing crossing_cost_dkk, crossing_note
--       and crossing_paid_by_member_id, per column. The INSERT path still writes
--       nulls, which is correct: a client with no crossing UI creating a NEW trip has
--       no crossing to write, and there is no prior value to preserve. All crossing
--       validation and normalisation is skipped — with the flag false the three
--       crossing arguments are IGNORED, so a caller that means to send a crossing must
--       send the flag with it.
--
--   crossing_provided = true (every call from a crossing-aware client)
--       exactly migration 157's semantics, unchanged: null-or-zero cost clears all
--       three columns, a negative cost is rejected with 23514, the payer defaults to
--       the driver and a named payer must be an ACTIVE member of the workspace.
--
-- The flag is the LAST parameter of all three functions, AFTER the trailing event
-- params, so every positional caller — this repo's functional suites, the SQL inside
-- these RPCs, the load-rehearsal driver — keeps its existing argument order and simply
-- omits the new one. The 051 convention that the event params come last is about
-- clients that name their arguments, and those are unaffected either way.
--
-- ARITY CHANGE, NOT A REPLACEMENT (the 157, 156 and 063 lesson): the parameter list
-- changes again, and `create or replace` with a different parameter list creates a NEW
-- OVERLOAD rather than replacing the old one. Every new parameter defaults, so
-- PostgREST would find two candidate signatures and fail to resolve between them. Each
-- exact 157 signature is therefore DROPped first, and since DROP + CREATE resets the
-- ACL, every grant is restated with anon named explicitly (migration 148).
--
-- Every re-declared function is based on its NEWEST prior definition, which for all
-- three is migration 157's; they are 157 verbatim apart from the new parameter, the
-- `if crossing_provided then` guard around the normalisation block, and the three
-- per-column CASE expressions on the ON CONFLICT branch. Nothing else in this
-- migration touches the settlement engine, the fingerprint, the columns or the CHECK —
-- 157's calculate_period_settlement and calculate_period_entry_fingerprint stay live
-- as written, and no new event_type is introduced.
--
-- MERGE ORDER: this SQL must be applied in production BEFORE govehlo-mobile's twin
-- (GVM-502) ships. PostgREST resolves an RPC by the NAMES of the arguments in the
-- request body, and rejects a body carrying an argument the function does not have
-- with PGRST202 ("Could not find the function ... in the schema cache"). A mobile
-- build that sends crossing_provided against an un-migrated database therefore cannot
-- save a trip at all. Applied-first is not a preference here; it is the only order
-- that works.

-- ── 1. upsert_trip_with_participants — re-declared off migration 157 ────────────
-- 157 verbatim apart from the trailing crossing_provided parameter, the guard around
-- the crossing normalisation block, and the three per-column CASE expressions on the
-- ON CONFLICT UPDATE path. In ON CONFLICT DO UPDATE the row as it exists today is
-- referenced by the TABLE name (trips.crossing_cost_dkk) while the row that would have
-- been inserted is `excluded` — so `case when crossing_provided then excluded.x else
-- trips.x end` is literally "use what the caller sent, or keep what is there". Both
-- sides are table-qualified and neither collides with a parameter name.
drop function if exists public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text);

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
  event_body text default null,
  crossing_provided boolean default false
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
  -- GV-417: everything below runs ONLY when the caller said it is sending a crossing.
  -- crossing_provided false means the three crossing arguments carry no information —
  -- they are the parameter defaults of a client that has never heard of a crossing —
  -- so there is nothing to validate and nothing to normalise, the resolved_* locals
  -- stay null (correct for the INSERT path: a new trip from such a client has no
  -- crossing), and the UPDATE path below preserves whatever is already on the row.
  if crossing_provided then
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
    -- GV-417: per column, because a crossing-aware caller must still be able to clear
    -- one field without the others, while a caller that sent no crossing at all must
    -- leave all three exactly as it found them.
    crossing_cost_dkk = case when crossing_provided then excluded.crossing_cost_dkk else trips.crossing_cost_dkk end,
    crossing_note = case when crossing_provided then excluded.crossing_note else trips.crossing_note end,
    crossing_paid_by_member_id = case when crossing_provided then excluded.crossing_paid_by_member_id else trips.crossing_paid_by_member_id end,
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

revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean) from public;
revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean) from anon;
grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean) to authenticated;

-- ── 2. upsert_booking_trip_with_participants — re-declared off migration 157 ────
-- 157 verbatim apart from the trailing crossing_provided parameter and forwarding it
-- to the canonical trip RPC above. The booking-specific behaviour — the booking lock,
-- the driver and date-window checks, the idempotency key rules — is untouched, and so
-- is the crossing itself: this function has never validated or normalised a crossing,
-- it only carries one.
drop function if exists public.upsert_booking_trip_with_participants(text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text);

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
  event_body text default null,
  crossing_provided boolean default false
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
    event_body,
    crossing_provided
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
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean
) from public;
revoke all on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean
) from anon;
grant execute on function public.upsert_booking_trip_with_participants(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean
) to authenticated;

-- ── 3. complete_booking_trip_with_fuel — re-declared off migration 157 ──────────
-- 157 verbatim apart from the trailing crossing_provided parameter and forwarding it.
-- It sits after the four event params — i.e. dead last — so the fuel payload's
-- positional shape, and the event params' position behind it, are both unchanged for
-- the SQL callers in this repo's functional suites.
drop function if exists public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, numeric, text, uuid, text, text, text, text
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
  fuel_event_body text default null,
  crossing_provided boolean default false
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
    trip_event_body,
    crossing_provided
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
  boolean, numeric, text, uuid, text, text, text, text, boolean
) from public;
revoke all on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, numeric, text, uuid, text, text, text, text, boolean
) from anon;
grant execute on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, numeric, text, uuid, text, text, text, text, boolean
) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '158_crossing_provided_contract',
  'A pre-crossing client must not erase a crossing it cannot see (GV-417). Migration 157 gave the three trip-writing RPCs crossing_cost_value / crossing_note_value / crossing_paid_by, all defaulting to null, and dropped the narrower overloads — so a client build that predates the crossing UI calls the same function with those three absent, and upsert_trip_with_participants'' ON CONFLICT branch wrote the normalised nulls straight over crossing_cost_dkk, crossing_note and crossing_paid_by_member_id. An old build editing a trip, retrying a queued write, or completing a booking (both other paths route through that upsert) therefore erased a crossing a newer device had logged. All three RPCs gain crossing_provided boolean default false as their LAST parameter, after the trailing event params, so every positional caller is unshifted. With the flag false — i.e. absent, the pre-crossing client — the UPDATE path PRESERVES the row''s existing crossing_cost_dkk, crossing_note and crossing_paid_by_member_id per column (case when crossing_provided then excluded.x else trips.x end), the INSERT path still writes nulls because a new trip from such a client has no crossing, and all crossing validation and normalisation is skipped, so the three crossing arguments are ignored entirely. With the flag true — every call from a crossing-aware client — the semantics are exactly migration 157''s: a null or zero cost clears all three columns together, a negative cost is rejected with 23514, the payer defaults to the driver and a named payer must be an ACTIVE member of the workspace. upsert_booking_trip_with_participants and complete_booking_trip_with_fuel accept the flag and forward it unchanged. All three are DROP + CREATE off their newest prior definitions (migration 157''s), not create-or-replace, because a differing parameter list would leave the old overload live and PostgREST could not resolve between them (the 157/156/063 lesson); ACLs are restated with anon named explicitly per 148. Nothing else changes: the trips columns and their CHECK, calculate_period_settlement''s crossing fold and calculate_period_entry_fingerprint''s ["<id>",<oere>] trip pairs all stay exactly as migration 157 left them, and no new event_type is written. MERGE ORDER: PostgREST rejects an RPC body carrying an argument the function does not have (PGRST202), so this migration must be applied in production BEFORE govehlo-mobile''s twin (GVM-502) ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

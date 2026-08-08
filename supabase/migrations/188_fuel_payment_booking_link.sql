-- Migration 188: link a fuel log to its booking (GVM-556)
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- A booking handover carries only a gauge FRACTION (the "Tankniveau"), never litres
-- or kroner. Migrations 183/186/187 taught the handover to re-anchor the running fuel
-- MODEL downward-only, and to nudge "log the tankning" when the tank reads FULLER than
-- the model expects — but a nudge with nowhere to land is only half the wiring. The
-- refuel that made the tank fuller has a COST, and splitting cost is the whole app.
--
-- This migration gives a fuel_payment a home booking, so the two halves meet:
--   • the nudge's "Log tankning" can open a booking-scoped fuel form and STAMP the
--     booking on the row it creates;
--   • the handover sheet can find "this booking's fuel log" with ONE lookup
--     (booking_id = X) and prefill its gauge from real litres instead of a guess.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────────
-- 1. fuel_payments.booking_id — a nullable FK to car_bookings, ON DELETE SET NULL
--    (deleting a booking must never delete its members' fuel receipts; the split of
--    that money outlives the booking). Null = "not tied to a booking", which is every
--    fuel row that has ever existed, so the column is purely additive.
-- 2. A partial index for the by-booking lookup the client will run constantly.
-- 3. upsert_fuel_payment gains a trailing booking_id_value (default null): validated to
--    belong to the ledger, written on insert, and STICKY on edit — an ordinary edit from
--    the plain fuel form passes null and must not wipe the link (coalesce-preserve). The
--    old 16-arg overload is dropped first (create or replace cannot widen a signature).
-- 4. The two booking-completion RPCs that already MINT a fuel_payment
--    (complete_booking_trip_with_fuel, complete_deferred_booking_fuel) pass their booking
--    straight through, so fuel born during completion is stamped automatically. Both are
--    re-declared byte-identically off their newest prior definition (39163 / 34956) bar
--    that one threaded argument.
--
-- ── GV-413 / GDPR ────────────────────────────────────────────────────────────
-- No new ledger_event (the fuel_created event already fires unchanged), so nothing to
-- classify. booking_id is a foreign key between two rows that already exist for the same
-- members in the same ledger — no new category of personal data, recipient or retention.

-- ── 1. the column ────────────────────────────────────────────────────────────
alter table public.fuel_payments
  add column if not exists booking_id uuid references public.car_bookings(id) on delete set null;

comment on column public.fuel_payments.booking_id is
  'Optional booking this refuel belongs to (GVM-556). Set when the fuel is logged as part '
  'of completing a booking, or from the handover "log tankning" nudge; null for standalone '
  'fuel. ON DELETE SET NULL — deleting the booking keeps the receipt and its cost split.';

-- ── 2. the by-booking lookup index ───────────────────────────────────────────
create index if not exists fuel_payments_booking_idx
  on public.fuel_payments (booking_id)
  where booking_id is not null and deleted_at is null;

-- ── 3. upsert_fuel_payment gains booking_id_value ─────────────────────────────
-- GVM-556 threads booking_id_value onto the signature, so the old 16-arg overload
-- must go first — create or replace cannot change the argument list, it would leave two.
drop function if exists public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz);

create or replace function public.upsert_fuel_payment(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_fuel_id text,
  payer_member_id uuid,
  payment_date_value date,
  amount_value numeric,
  currency_value text,
  liters_value numeric,
  price_per_liter_value numeric,
  odometer_value numeric,
  station_name_value text,
  station_brand_value text,
  full_tank_value boolean,
  event_title text default null,
  event_body text default null,
  expected_updated_at timestamptz default null,
  booking_id_value uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  locked_period_id uuid;
  saved_fuel_id uuid;
  existing_fuel record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_fuel_id is null or legacy_fuel_id = '' then
    raise exception 'Missing legacy fuel id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save fuel payments' using errcode = '42501';
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

  if payer_member_id is null or not public.member_belongs_to_ledger(payer_member_id, target_ledger_id) then
    raise exception 'Fuel payer must be an active member of this ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Fuel amount must be zero or greater' using errcode = '23514';
  end if;

  if liters_value is not null and liters_value < 0 then
    raise exception 'Fuel liters must be zero or greater' using errcode = '23514';
  end if;

  if price_per_liter_value is not null and price_per_liter_value < 0 then
    raise exception 'Fuel price per liter must be zero or greater' using errcode = '23514';
  end if;

  -- GVM-556: a booking link, when supplied, must point at a booking in THIS ledger.
  -- Null means "no booking" (every client that shipped before this) and is the default.
  if booking_id_value is not null and not exists (
    select 1
      from public.car_bookings cb
     where cb.id = booking_id_value
       and cb.ledger_id = target_ledger_id
  ) then
    raise exception 'Fuel booking must belong to this ledger' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':fuel:' || legacy_fuel_id));

  select *
    into existing_fuel
  from public.fuel_payments
  where ledger_id = target_ledger_id
    and legacy_id = legacy_fuel_id
  for update;

  if existing_fuel.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_fuel.created_by_member_id = actor_member_id
    or existing_fuel.payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel creator, payer, or a ledger admin can update this fuel payment' using errcode = '42501';
  end if;

  if existing_fuel.id is null and not (
    public.is_ledger_admin(target_ledger_id)
    or payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel payer or a ledger admin can create this fuel payment' using errcode = '42501';
  end if;

  -- GV-421: optimistic-concurrency precondition. Null (or absent) means no
  -- precondition, which is every client that has ever shipped and is byte-identical
  -- to the behaviour above this line. A token against a row that does not exist yet
  -- is ignored — a create cannot conflict. Truncated to milliseconds because a token
  -- that has passed through a JavaScript Date has lost its microseconds, and a
  -- microsecond-exact comparison would refuse every edit forever; see the header.
  if expected_updated_at is not null
     and existing_fuel.id is not null
     and date_trunc('milliseconds', existing_fuel.updated_at)
         is distinct from date_trunc('milliseconds', expected_updated_at) then
    raise exception 'En anden har ændret tankningen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.'
      using errcode = 'GV42F';
  end if;

  -- GDPR data minimisation (GV-186 / GV-196 / GV-400): no position is stored with a
  -- refuel any more. The driver's own coordinates went in migration 071 and the
  -- STATION's follow here — migration 062 kept those for a map view that was never
  -- built, so the purpose they were justified by has no implementation. The four
  -- accepted-and-ignored coordinate params are gone from the signature with them;
  -- station_name and station_brand still record WHERE, just not to seven decimals.
  insert into public.fuel_payments (
    legacy_id,
    ledger_id,
    period_id,
    payer_member_id,
    payment_date,
    amount,
    currency,
    liters,
    price_per_liter,
    odometer,
    station_name,
    station_brand,
    full_tank,
    booking_id,
    created_by_member_id,
    deleted_at,
    updated_at
  ) values (
    legacy_fuel_id,
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    payment_date_value,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    liters_value,
    price_per_liter_value,
    odometer_value,
    nullif(station_name_value, ''),
    nullif(station_brand_value, ''),
    coalesce(full_tank_value, false),
    booking_id_value,
    actor_member_id,
    null,
    now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    payer_member_id = excluded.payer_member_id,
    payment_date = excluded.payment_date,
    amount = excluded.amount,
    currency = excluded.currency,
    liters = excluded.liters,
    price_per_liter = excluded.price_per_liter,
    odometer = excluded.odometer,
    station_name = excluded.station_name,
    station_brand = excluded.station_brand,
    full_tank = excluded.full_tank,
    -- GVM-556: the booking link is sticky. A booking-scoped save sets it; an ordinary
    -- edit from the plain fuel form (no booking in scope) passes null and must NOT wipe
    -- which booking this refuel belonged to. coalesce keeps the existing link when the
    -- caller supplies none; a caller that does supply one re-affirms the same booking.
    booking_id = coalesce(excluded.booking_id, fuel_payments.booking_id),
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

-- DROP + CREATE resets the ACL, so both halves are restated: anon and authenticated
-- are named explicitly (migration 148) and only authenticated is granted back.
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz, uuid) from public;
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz, uuid) from anon;
grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz, uuid) to authenticated;

-- ── 4. booking-completion RPCs pass the booking straight through ─────────────
-- complete_booking_trip_with_fuel: re-declared byte-identically off migration's
-- newest prior definition, bar threading target_booking_id into the fuel upsert.

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
      fuel_event_body,
      -- GVM-556: fuel logged AS PART OF completing this booking belongs to it — stamp the
      -- booking so "this booking's fuel" is one column, not a join through the trip.
      booking_id_value => target_booking_id
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

-- complete_deferred_booking_fuel: same, threading the trip's booking_id through.

create or replace function public.complete_deferred_booking_fuel(
  target_ledger_id text,
  target_open_period_id uuid,
  target_trip_id uuid,
  fuel_legacy_id text,
  fuel_payer_member_id uuid,
  fuel_payment_date_value date,
  fuel_amount_value numeric,
  fuel_currency_value text default 'DKK',
  fuel_liters_value numeric default null,
  fuel_price_per_liter_value numeric default null,
  fuel_odometer_value numeric default null,
  fuel_station_name_value text default null,
  fuel_station_brand_value text default null,
  fuel_full_tank_value boolean default false,
  fuel_event_title text default null,
  fuel_event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_trip record;
  v_fuel_result jsonb;
  v_saved_fuel_id uuid;
begin
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can complete deferred fuel entries'
      using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member'
      using errcode = '42501';
  end if;

  if target_trip_id is null then
    raise exception 'Missing deferred trip id' using errcode = '22023';
  end if;

  select t.id, t.driver_member_id, t.fuel_resolution, t.completion_fuel_legacy_id, t.booking_id
    into v_trip
    from public.trips t
    where t.id = target_trip_id
      and t.ledger_id = target_ledger_id
      and t.booking_id is not null
      and t.deleted_at is null
    for update of t;

  if not found then
    raise exception 'Deferred booking trip was not found' using errcode = '22023';
  end if;

  if not (public.is_ledger_admin(target_ledger_id) or v_trip.driver_member_id = v_actor_member_id) then
    raise exception 'Only the trip driver or a ledger admin can complete its deferred fuel entry'
      using errcode = '42501';
  end if;

  if v_trip.fuel_resolution = 'logged' and v_trip.completion_fuel_legacy_id is not null then
    return jsonb_build_object(
      'trip_id', v_trip.id,
      'fuel_resolution', 'logged',
      'fuel_id', (
        select fp.id
        from public.fuel_payments fp
        where fp.ledger_id = target_ledger_id
          and fp.legacy_id = v_trip.completion_fuel_legacy_id
          and fp.deleted_at is null
        limit 1
      ),
      'reused_existing_fuel', true
    );
  end if;

  if v_trip.fuel_resolution <> 'deferred' then
    raise exception 'Trip does not have a deferred fuel entry' using errcode = '22023';
  end if;

  v_fuel_result := public.upsert_fuel_payment(
    target_ledger_id,
    target_open_period_id,
    fuel_legacy_id,
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
    fuel_event_body,
    -- GVM-556: a deferred fuel entry is always completed against a booking's trip
    -- (guarded by t.booking_id is not null above), so stamp that booking on the fuel.
    booking_id_value => v_trip.booking_id
  );

  v_saved_fuel_id := nullif(v_fuel_result ->> 'fuel_id', '')::uuid;
  if v_saved_fuel_id is null then
    raise exception 'Deferred fuel completion did not return a fuel id'
      using errcode = '40001';
  end if;

  -- The original trip may have become historical before the driver found the
  -- receipt. Reuse the existing transaction-local metadata scrub bypass for this
  -- one fixed-column UPDATE: neither field participates in settlement maths or
  -- the archived fingerprint, and enforce_trip_fuel_resolution still proves the
  -- linked fuel row exists. No caller-controlled SQL runs while the flag is set.
  perform set_config('govehlo.pii_scrub', '1', true);

  update public.trips t
  set fuel_resolution = 'logged',
      completion_fuel_legacy_id = fuel_legacy_id,
      updated_at = now()
  where t.id = target_trip_id
    and t.ledger_id = target_ledger_id
    and t.fuel_resolution = 'deferred';

  if not found then
    raise exception 'Deferred fuel completion could not update the trip'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'trip_id', target_trip_id,
    'fuel_resolution', 'logged',
    'fuel_id', v_saved_fuel_id,
    'reused_existing_fuel', false
  );
end;
$$;

revoke all on function public.complete_deferred_booking_fuel(
  text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric,
  text, text, boolean, text, text
) from public;
revoke all on function public.complete_deferred_booking_fuel(
  text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric,
  text, text, boolean, text, text
) from anon;
grant execute on function public.complete_deferred_booking_fuel(
  text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric,
  text, text, boolean, text, text
) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '188_fuel_payment_booking_link',
  'Link a fuel log to its booking (GVM-556). A handover carries only a gauge fraction, never litres/kr; migrations 183/186/187 made it re-anchor the fuel model downward-only and nudge "log the tankning" when the tank reads fuller than the model expects, but the nudge needs somewhere to land and the handover needs to find the booking''s real fuel to prefill from. Adds fuel_payments.booking_id — a nullable FK to car_bookings, ON DELETE SET NULL so deleting a booking keeps its members'' fuel receipts and cost split; null = not tied to a booking (every fuel row so far), purely additive — plus a partial index fuel_payments_booking_idx (booking_id) where booking_id is not null and deleted_at is null. upsert_fuel_payment gains a trailing booking_id_value (default null): validated to belong to the ledger, written on insert, and STICKY on edit via coalesce(excluded.booking_id, fuel_payments.booking_id) so an ordinary edit from the plain fuel form (null) never wipes the link; the old 16-arg overload is dropped first because create or replace cannot widen a signature. The two booking-completion RPCs that already mint a fuel_payment (complete_booking_trip_with_fuel off 39163, complete_deferred_booking_fuel off 34956 — the latter now also selecting t.booking_id into v_trip) pass their booking through booking_id_value so completion-fuel is stamped automatically; both re-declared byte-identically bar the threaded argument, signatures unchanged. No new ledger_event (fuel_created already fires), nothing for GV-413; GDPR: a FK between two existing rows in the same ledger, no new data/recipient/retention. Depends on migration 123 (trips.booking_id) and the handover model 182/183/186/187.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 151: erase and drop the precise refuel position, and retire the write-only RPC params (GV-400)
--
-- Server half of GVM-456 / GVM-457, whose client half shipped in govehlo-mobile PR
-- #479. The client has stopped WRITING these fields, which is not the same as them
-- being gone — and for the position data that difference is the entire point. Every
-- refuel row logged before #479 still holds a precise coordinate pair. Under data
-- minimisation those have to be removed, not merely stop growing.
--
-- ── 1. fuel_payments.station_lat / station_lng ────────────────────────────────────
-- Migration 062 kept these on an explicit purpose-limitation argument: it dropped
-- user_lat/user_lng as "extra personal data with no purpose" and justified keeping the
-- station's coordinates by saying only a map-coordinate view would need them. That view
-- was never built, so the stated purpose has no implementation — which is exactly the
-- state Article 5(1)(c) does not permit storage in. station_name and station_brand are
-- still written and still shown, so the place is not lost; only the precision, which
-- nothing ever read.
--
-- This follows migration 071's two-step for user_lat/user_lng rather than a bare DROP
-- COLUMN, and the order is deliberate:
--   a. FUNCTIONS FIRST, so no live function is left referencing a column that is about
--      to disappear.
--   b. NULL the existing values, THEN drop the columns. A bare drop only marks the
--      attribute dropped in the catalogue: the bytes stay in the live heap tuples until
--      those rows happen to be rewritten, so the coordinates would still be recoverable
--      from the table and from every base backup taken afterwards. The UPDATE writes new
--      row versions without them and leaves the old versions as dead tuples for vacuum.
--      Migration 062 nulled and 071 dropped; both halves are here because the client
--      already stopped writing, so there is nothing to stage across two releases.
--
-- The backfill runs inside a DO block with the transaction-local govehlo.pii_scrub GUC
-- set, the same bypass delete_my_account (072) and the retention job (131) use. Without
-- it the closed-period rejection in enforce_settlement_entry_lock (GV-199, migration
-- 120) and the boundary check in enforce_settlement_entry_period_boundary (121) would
-- refuse the UPDATE on every fuel row that belongs to an already-closed period — which
-- is most of them, and precisely the rows holding the oldest coordinates. The GUC is
-- transaction-local, which is why this is one DO block and not two loose statements: in
-- the SQL Editor each top-level statement is its own transaction. The bypass is sound
-- for the same reason it is elsewhere — neither column participates in settlement maths
-- or in the archived period fingerprint (migration 054 fingerprints entry ids only), so
-- no closed period's snapshot_json can be invalidated by this write. The requested/paid
-- lock is not bypassed at all and does not fire: its fuel_payments guard watches amount,
-- liters, payer, payment_date, full_tank, period_id and deleted_at, none of which change
-- here.
--
-- NOT in scope: car_bookings.fuel_stop (migration 063) is planned-route jsonb with a
-- live reader on the booking detail view — a different posture and a different ticket.
--
-- ── 2. syn_booked_at ──────────────────────────────────────────────────────────────
-- acknowledge_inspection_booking (migration 146) stamps three keys into
-- ledgers.vehicle_info. syn_booked_at, the acknowledgement timestamp, is written on
-- every acknowledgement and read by nothing: the question anyone actually asks — "is the
-- upcoming syn booked?" — is answered by syn_booked_for, which names its own inspection
-- date and therefore self-invalidates when the register writes a new one. A bare
-- timestamp adds no answer and, paired with syn_booked_by_member_id, does say when a
-- named person was doing admin. GVM-457 removed it from the client's vocabulary; this
-- removes the write. The acknowledge path now also strips any key an earlier
-- acknowledgement left behind, so the marker self-heals on next use, and the one-time
-- cleanup below clears the rest.
--
-- ── 3. The accepted-and-ignored coordinate parameters ─────────────────────────────
-- upsert_fuel_payment has carried user_lat_value / user_lng_value since migration 071
-- purely so an older client build would not break, and station_lat_value /
-- station_lng_value now join them in doing nothing. complete_booking_trip_with_fuel
-- (136) and complete_deferred_booking_fuel (140) pass their own fuel_station_lat_value /
-- fuel_station_lng_value straight through. Ignored parameters are not free: they are a
-- documented-looking invitation to send the data again, and the whole reason GVM-457
-- exists is that a silent write-only field is invisible until someone audits for it.
--
-- Changing a parameter list is a DROP + CREATE, not a CREATE OR REPLACE — replacing with
-- a different arity creates a second overload and leaves the old one live, which
-- PostgREST then cannot resolve between. Migration 063 established the drop-then-recreate
-- pattern for exactly this. Each function is re-declared off its NEWEST prior definition:
-- upsert_fuel_payment off 071, complete_booking_trip_with_fuel off 136,
-- complete_deferred_booking_fuel off 140, acknowledge_inspection_booking off 146.
--
-- ⚠ CLIENT COUPLING — READ BEFORE APPLYING. Dropping a parameter is a breaking change
-- for any build still sending it: PostgREST resolves an RPC by matching the body's keys
-- to a signature, so an extra key is PGRST202 "could not find the function", not a
-- silently ignored argument. govehlo-mobile PR #479 stopped sending the two booking-RPC
-- coordinate args, but src/lib/supabase-helpers.ts still sends user_lat_value,
-- user_lng_value, station_lat_value and station_lng_value to upsert_fuel_payment as
-- null. The sibling govehlo-mobile PR removes them. Merge and rebuild the app around
-- applying this migration, or fuel logging returns PGRST202 in between.
--
-- Safe to rerun (drop if exists + create; idempotent migration record). The backfill and
-- the column drop are both no-ops on a second run.

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 1. upsert_fuel_payment — re-declared off migration 071, minus four dead params
-- ═══════════════════════════════════════════════════════════════════════════════════

drop function if exists public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text);

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
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text) from public;
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text) from anon;
grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 2. complete_booking_trip_with_fuel — re-declared off migration 136
-- ═══════════════════════════════════════════════════════════════════════════════════

drop function if exists public.complete_booking_trip_with_fuel(text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, boolean, text, text, text, text);

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
  boolean, text, text, text, text
) from public;
revoke all on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, text, text, text, text
) from anon;
grant execute on function public.complete_booking_trip_with_fuel(
  text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], text,
  text, uuid, date, numeric, text, numeric, numeric, numeric, text, text,
  boolean, text, text, text, text
) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 3. complete_deferred_booking_fuel — re-declared off migration 140
-- ═══════════════════════════════════════════════════════════════════════════════════

drop function if exists public.complete_deferred_booking_fuel(text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, boolean, text, text);

-- Resolve an already-saved deferred booking receipt without replaying/moving the
-- original trip. The fuel INSERT is automatically queued by the boundary trigger
-- from migration 140 when the current period is locked; only fixed, non-financial
-- workflow metadata is updated on the original trip, including when it is already closed.
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

  select t.id, t.driver_member_id, t.fuel_resolution, t.completion_fuel_legacy_id
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
    fuel_event_body
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

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 4. acknowledge_inspection_booking — re-declared off migration 146, minus syn_booked_at
-- ═══════════════════════════════════════════════════════════════════════════════════
--
-- Signature unchanged, so this one is a plain create or replace and no client has to
-- move with it. Two keys remain: syn_booked_for (the acknowledged date, which is what
-- makes the marker self-invalidating) and syn_booked_by_member_id (who, so the group can
-- be told). The acknowledge path subtracts syn_booked_at before merging, so a workspace
-- that still carries one from an earlier acknowledgement loses it on next use even if the
-- one-time cleanup in section 5 is skipped; the clear path already removed it.

create or replace function public.acknowledge_inspection_booking(
  target_ledger_id text,
  acknowledged_inspection_date date,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_actor_email text;
  v_actor_first text;
  v_syn_date date;
  v_previous_ack date;
  v_title text;
  v_body text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can acknowledge a booked inspection'
      using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member'
      using errcode = '42501';
  end if;

  -- Lock the workspace row: two devices acknowledging at once must not interleave
  -- into a half-written marker (a date with nobody's name against it).
  select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date,
         nullif(l.vehicle_info ->> 'syn_booked_for', '')::date
    into v_syn_date, v_previous_ack
    from public.ledgers l
    where l.id = target_ledger_id
    for update;

  if not found then
    raise exception 'Workspace was not found' using errcode = '22023';
  end if;

  v_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

  select split_part(coalesce(nullif(btrim(m.name), ''), 'Nogen'), ' ', 1)
    into v_actor_first
    from public.ledger_members m
    where m.id = v_actor_member_id;
  v_actor_first := coalesce(v_actor_first, 'Nogen');

  -- ── Clear the acknowledgement (null date) ──────────────────────────────────────
  if acknowledged_inspection_date is null then
    -- Idempotent: nothing acknowledged means nothing to clear, so no write and no
    -- second event.
    if v_previous_ack is null then
      return jsonb_build_object(
        'acknowledged_for', null,
        'acknowledged_by_member_id', null,
        'changed', false
      );
    end if;

    update public.ledgers l
    set vehicle_info = l.vehicle_info
          - 'syn_booked_for'
          - 'syn_booked_at'
          - 'syn_booked_by_member_id',
        updated_at = now()
    where l.id = target_ledger_id;

    v_title := coalesce(nullif(btrim(event_title), ''), v_actor_first || ' fjernede syn-bookingen');
    v_body := coalesce(nullif(btrim(event_body), ''), 'Påmindelsen om syn er tilbage.');

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'vehicle_inspection_booking_cleared',
      v_title,
      v_body,
      v_actor_member_id,
      v_actor_email,
      jsonb_build_object('inspection_date', v_previous_ack::text)
    );

    return jsonb_build_object(
      'acknowledged_for', null,
      'acknowledged_by_member_id', null,
      'changed', true
    );
  end if;

  -- ── Acknowledge the current inspection date ───────────────────────────────────
  if v_syn_date is null then
    raise exception 'This workspace has no next inspection date to acknowledge'
      using errcode = '22023';
  end if;

  -- The ack names its date, so it may only ever name the CURRENT one. A stale client,
  -- or a register refresh that landed in between, would otherwise silence a date
  -- nobody is being reminded about — or park an ack the live date later grows into.
  if acknowledged_inspection_date <> v_syn_date then
    raise exception 'The acknowledged inspection date is not this workspace''s next inspection date'
      using errcode = '22023';
  end if;

  -- Idempotent: a replay (double tap, offline retry, a second device) finds the same
  -- date already acknowledged and writes neither a marker nor a second event.
  if v_previous_ack = acknowledged_inspection_date then
    return jsonb_build_object(
      'acknowledged_for', acknowledged_inspection_date::text,
      'acknowledged_by_member_id',
        nullif((select l.vehicle_info ->> 'syn_booked_by_member_id'
                from public.ledgers l where l.id = target_ledger_id), ''),
      'changed', false
    );
  end if;

  -- GVM-457 / GV-400: no syn_booked_at. The acknowledgement timestamp was stamped on
  -- every ack and read by nothing — "is the upcoming syn booked?" is answered by
  -- syn_booked_for, which names its own date and self-invalidates when the register
  -- writes a new one. Subtracted rather than merely not written, so a workspace still
  -- carrying one from before this migration is cleaned by its next acknowledgement.
  update public.ledgers l
  set vehicle_info = (l.vehicle_info - 'syn_booked_at') || jsonb_build_object(
        'syn_booked_for', acknowledged_inspection_date::text,
        'syn_booked_by_member_id', v_actor_member_id::text
      ),
      updated_at = now()
  where l.id = target_ledger_id;

  v_title := coalesce(nullif(btrim(event_title), ''), v_actor_first || ' har booket synet');
  v_body := coalesce(
    nullif(btrim(event_body), ''),
    'Syn senest ' || to_char(v_syn_date, 'DD-MM-YYYY') || '. Påmindelsen er slået fra indtil da.'
  );

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'vehicle_inspection_booked',
    v_title,
    v_body,
    v_actor_member_id,
    v_actor_email,
    jsonb_build_object('inspection_date', acknowledged_inspection_date::text)
  );

  return jsonb_build_object(
    'acknowledged_for', acknowledged_inspection_date::text,
    'acknowledged_by_member_id', v_actor_member_id::text,
    'changed', true
  );
end;
$$;

revoke all on function public.acknowledge_inspection_booking(text, date, text, text) from public;
revoke all on function public.acknowledge_inspection_booking(text, date, text, text) from anon;
grant execute on function public.acknowledge_inspection_booking(text, date, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 5. Erase what is already stored
-- ═══════════════════════════════════════════════════════════════════════════════════
--
-- The point of the ticket. One DO block because govehlo.pii_scrub is transaction-local
-- and the SQL Editor runs each top-level statement in its own transaction; see the
-- header for why the bypass is both necessary and safe here.

do $$
declare
  v_fuel_rows integer := 0;
  v_ledger_rows integer := 0;
begin
  perform set_config('govehlo.pii_scrub', '1', true);

  update public.fuel_payments fp
  set station_lat = null,
      station_lng = null
  where fp.station_lat is not null
     or fp.station_lng is not null;
  get diagnostics v_fuel_rows = row_count;

  update public.ledgers l
  set vehicle_info = l.vehicle_info - 'syn_booked_at'
  where l.vehicle_info ? 'syn_booked_at';
  get diagnostics v_ledger_rows = row_count;

  perform set_config('govehlo.pii_scrub', '', true);

  raise notice 'Migration 151: cleared station coordinates on % fuel row(s) and syn_booked_at on % workspace(s).',
    v_fuel_rows, v_ledger_rows;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- 6. Drop the columns
-- ═══════════════════════════════════════════════════════════════════════════════════
--
-- With the values already nulled above, this removes the attributes themselves — and
-- with them the direct-write path the fuel_payments RLS insert/update policies would
-- otherwise still allow around the RPC (the same argument migration 071 made for
-- user_lat/user_lng).

alter table public.fuel_payments
  drop column if exists station_lat,
  drop column if exists station_lng;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '151_drop_fuel_station_coordinates',
  'GV-400 (server half of GVM-456/457, client half in govehlo-mobile PR #479): erases and drops the precise refuel position and retires the write-only RPC parameters. fuel_payments.station_lat/station_lng are NULLED first and only then dropped -- a bare DROP COLUMN just marks the attribute dead in the catalogue and leaves the coordinates in the live heap tuples and in every later base backup, so the UPDATE (migration 062''s half) is what actually erases and the DROP (071''s half) is what closes the direct-write path the RLS policies still allow around the RPC. Migration 062 kept these columns for a map-coordinate view that was never built, so the purpose they were justified by has no implementation; station_name/station_brand still record where. The backfill runs in one DO block with the transaction-local govehlo.pii_scrub GUC set, because the closed-period rejection (GV-199, migration 120) and the period-boundary check (121) would otherwise refuse the UPDATE on every fuel row in an already-closed period -- exactly the rows holding the oldest coordinates -- and the bypass is sound because neither column feeds settlement maths or the archived entry fingerprint. acknowledge_inspection_booking (re-declared off 146, signature unchanged) stops stamping syn_booked_at and now subtracts it before merging, so the marker self-heals; the same DO block clears the key from existing workspaces. Finally the accepted-and-ignored coordinate parameters go: upsert_fuel_payment drops user_lat_value/user_lng_value (dead since 071) and station_lat_value/station_lng_value, 19 args to 15, and complete_booking_trip_with_fuel (off 136, 28 to 26) and complete_deferred_booking_fuel (off 140, 18 to 16) drop the fuel_station_lat_value/fuel_station_lng_value they passed through. Arity changes are DROP + CREATE, not CREATE OR REPLACE (migration 063''s pattern) -- replacing with a different arity leaves the old overload live and PostgREST cannot resolve between them -- so the ACLs are restated, anon named explicitly per 148. BREAKING for any client still sending a dropped parameter: PostgREST matches body keys to a signature, so an extra key is PGRST202, not an ignored argument. govehlo-mobile src/lib/supabase-helpers.ts still passes all four coordinate params to upsert_fuel_payment as null; its sibling PR removes them and must ship with this.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

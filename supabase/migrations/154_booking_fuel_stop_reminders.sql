-- Migration 154: pre-departure fuel-stop reminders (GV-405)
--
-- The twin of migration 124. That engine fires AFTER a booking ends ("you drove,
-- register the trip"); this one fires BEFORE a booking starts ("the tank no longer
-- covers your planned route"). In a shared car other members drive between planning
-- and departure, so the fuel stop persisted on the booking encodes a tank level that
-- may be hours and several trips out of date by the time the driver leaves.
--
-- ── Why the tank model is NOT ported ────────────────────────────────────────────
-- The verdict itself is ~20 lines of arithmetic (range minus a 10% reserve versus the
-- planned distance). What is expensive is the three numbers it eats — litersNow,
-- consumption, consumptionSpread — which come out of govehlo-mobile's
-- src/lib/trip-estimate.ts: a tank baseline (migration 092) plus every trip since,
-- minus every fuel log, with self-healing on full-tank overflow. Porting 518 lines of
-- that to PL/pgSQL would create a second model to keep in step forever.
--
-- So the client STAMPS ITS OUTPUT onto the ledger (set_tank_state below) and the server
-- reads the numbers. The arithmetic that IS duplicated — safeConsumption, the reserve
-- fraction, the deadband, the three verdicts — is pinned to the mobile source by
-- tools/test-fuel-stop-verdict-contract.mjs, which replays the exact scenarios of
-- govehlo-mobile/src/lib/__tests__/fuel-stop-revalidation.test.ts against this SQL.
--
-- ── Fail closed, everywhere ─────────────────────────────────────────────────────
-- fuel-stop-revalidation.ts states the principle: "we never nag on data we can't
-- trust". Server-side that means the claim below skips a booking outright when the
-- stamp is missing, when the stored fuel stop is malformed or has no usable distance,
-- and — the important one — when ANY trip or fuel payment for that car is newer than
-- the stamp's watermark. A stale stamp is not a stale nudge; it is no nudge.
--
-- Nothing here is client-callable except set_tank_state. The claim/confirm pair is
-- service_role only, on the same lease + one-shot-token discipline as migrations
-- 080/082/102/118/124/153: claim leases a row for 15 minutes, the sender pushes, and
-- only a confirm carrying the matching token marks it reminded. A crash between the
-- two under-sends rather than double-sends.

-- ── Tank state stamped by the client ────────────────────────────────────────────
-- Sits beside tank_baseline_* (migration 092), which is the ANCHOR the client's model
-- starts from; these five are that model's OUTPUT as of a point in time.
alter table public.ledgers
  add column if not exists tank_state_liters numeric,
  add column if not exists tank_state_as_of timestamptz,
  add column if not exists tank_state_consumption numeric,
  add column if not exists tank_state_consumption_spread numeric,
  add column if not exists tank_state_capacity numeric;

comment on column public.ledgers.tank_state_as_of is
  'Data watermark of the stamped tank state: the newest greatest(created_at, updated_at) across the trips and fuel_payments the client consumed when it computed tank_state_liters. NOT a wall-clock write time — that is what makes set_tank_state''s monotonic check meaningful (a client that has seen less data carries an older watermark and cannot overwrite a fresher stamp) and what claim_due_booking_fuel_reminders compares against to detect a stale stamp.';

-- Record the client's current tank-model output for this car. Called after every trip
-- and fuel write, so it is deliberately cheap: member-gated, no ledger_events row (a
-- mechanical stamp is not a domain event, and one per trip write would spam both the
-- activity feed and the realtime channel that migration 087 wired to it).
--
-- MONOTONIC on as_of: a stamp whose watermark is older than the stored one is a client
-- working from a stale cache, and applying it would move the tank level BACKWARDS. It
-- is refused as a no-op return, not an exception — a losing race is normal and the
-- client must be able to ignore it quietly. Callers read `applied` to tell the two
-- apart. An equal watermark is accepted: same data in, same numbers out, so the write
-- is idempotent.
create or replace function public.set_tank_state(
  target_ledger_id text,
  liters_value numeric,
  as_of_value timestamptz,
  consumption_value numeric,
  spread_value numeric,
  capacity_value numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_as_of timestamptz;
  normalized_spread numeric;
begin
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only an active workspace member can record tank state' using errcode = '42501';
  end if;

  if as_of_value is null then
    raise exception 'Tank state needs an as-of watermark' using errcode = '23514';
  end if;

  -- A watermark from the future would make every later staleness check pass forever
  -- and could lock out every subsequent stamp. It can only come from a client bug, so
  -- it raises rather than no-ops. One minute of slack absorbs ordinary clock skew.
  if as_of_value > now() + interval '1 minute' then
    raise exception 'Tank state as-of cannot be in the future' using errcode = '23514';
  end if;

  if liters_value is null or liters_value < 0 then
    raise exception 'Tank state litres must be zero or greater' using errcode = '23514';
  end if;

  if consumption_value is null or consumption_value <= 0 then
    raise exception 'Tank state consumption must be greater than zero' using errcode = '23514';
  end if;

  if capacity_value is null or capacity_value <= 0 then
    raise exception 'Tank state capacity must be greater than zero' using errcode = '23514';
  end if;

  -- Mirrors safeConsumption's tolerance in govehlo-mobile/src/lib/refuel-plan.ts: a
  -- non-positive or absent spread collapses to zero rather than being rejected.
  normalized_spread := case when spread_value is not null and spread_value > 0 then spread_value else 0 end;

  select l.tank_state_as_of into saved_as_of
  from public.ledgers l
  where l.id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;

  if saved_as_of is not null and as_of_value < saved_as_of then
    return jsonb_build_object(
      'ledger_id', target_ledger_id,
      'applied', false,
      'reason', 'stale_as_of',
      'stored_as_of', saved_as_of
    );
  end if;

  update public.ledgers l
     set tank_state_liters = liters_value,
         tank_state_as_of = as_of_value,
         tank_state_consumption = consumption_value,
         tank_state_consumption_spread = normalized_spread,
         tank_state_capacity = capacity_value,
         updated_at = now()
   where l.id = target_ledger_id;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'applied', true,
    'tank_state_liters', liters_value,
    'tank_state_as_of', as_of_value
  );
end;
$$;

revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from public;
revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from anon;
grant execute on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) to authenticated;

-- ── The verdict ─────────────────────────────────────────────────────────────────
-- A line-for-line mirror of revalidateFuelStop in
-- govehlo-mobile/src/lib/fuel-stop-revalidation.ts, which in turn calls planRefuel /
-- safeConsumption in govehlo-mobile/src/lib/refuel-plan.ts. Returns the same three
-- fields that module's result carries, so the contract test can assert on all of them:
--   { "verdict": "holds" | "move-earlier" | "now-needs-stop",
--     "reserveKm": <number|null>, "storedStopKm": <number|null> }
--
-- Not client-callable: it is an internal calculator for the claim below, which is
-- SECURITY DEFINER and therefore reaches it as the function owner.
--
-- On p_stored_fuel_stop ->> 'distanceKm': that value is the EFFECTIVE distance, already
-- doubled for a tur/retur plan (govehlo-mobile/src/screens/Book/EstimateView.tsx passes
-- `effDist` into buildBookingFuelStop, and useTripEstimate.ts computes it as
-- `returnTrip ? distNum * 2 : distNum`). The sibling `returnTrip` flag is presentational
-- metadata for the detail screen's return-leg date and must NOT be applied as a
-- multiplier here — doing so would model a 600 km round trip as 1200 km and push people
-- whose tank is fine. buildFuelStopNudge feeds the same value straight through.
create or replace function public.fuel_stop_revalidation_verdict(
  p_stored_fuel_stop jsonb,
  p_liters_now numeric,
  p_consumption numeric,
  p_consumption_spread numeric,
  p_tank_capacity numeric,
  p_deadband_km numeric
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  -- Fail-closed answer, byte-for-byte the `holds` constant in fuel-stop-revalidation.ts.
  holds constant jsonb := jsonb_build_object('verdict', 'holds', 'reserveKm', null, 'storedStopKm', null);
  distance_km numeric;
  stored_needs_fuel boolean;
  stored_stop_km numeric;
  station_json jsonb;
  cons_safe numeric;
  current_range_km numeric;
  reserve_km numeric;
  km_until_reserve numeric;
  plan_needs_fuel boolean;
  km_until_refuel numeric;
  deadband_km numeric;
  reserve_out jsonb;
begin
  -- Fail closed on anything we can't trust (revalidateFuelStop's opening guards).
  if p_stored_fuel_stop is null or jsonb_typeof(p_stored_fuel_stop) <> 'object' then
    return holds;
  end if;

  -- hasTankState / tankStateSource === 'none' server-side: no stamped numbers, no nudge.
  if p_liters_now is null or p_consumption is null or p_tank_capacity is null then
    return holds;
  end if;

  -- numOrNull: a JSON value that is not a number is not a number. A string "400" fails
  -- this exactly as `typeof v === 'number'` fails it in the TypeScript.
  if jsonb_typeof(p_stored_fuel_stop -> 'distanceKm') = 'number' then
    distance_km := (p_stored_fuel_stop ->> 'distanceKm')::numeric;
  end if;
  if distance_km is null or distance_km <= 0 then
    return holds;
  end if;

  -- storedNeedsFuel = fs.needsFuel === true || fs.station != null
  -- `fs.station != null` in the TypeScript is true for ANY present, non-null value, not
  -- only a well-formed object — and it has to stay that way here. A corrupt `station`
  -- means "the plan claimed a stop"; reading it as "no stop planned" would route a
  -- malformed booking down the now-needs-stop branch instead of failing closed. So the
  -- flag is taken from the RAW value, and only the kmIn lookup below narrows to objects
  -- (mirroring `fs.station?.kmIn`, which yields undefined on a non-object).
  station_json := p_stored_fuel_stop -> 'station';
  stored_needs_fuel := (jsonb_typeof(p_stored_fuel_stop -> 'needsFuel') = 'boolean'
                        and (p_stored_fuel_stop ->> 'needsFuel')::boolean)
                       or (station_json is not null and jsonb_typeof(station_json) <> 'null');
  if station_json is not null and jsonb_typeof(station_json) <> 'object' then
    station_json := null;
  end if;

  -- Where the stored plan said to fill: the station's own position, else the reserve km.
  if station_json is not null and jsonb_typeof(station_json -> 'kmIn') = 'number' then
    stored_stop_km := (station_json ->> 'kmIn')::numeric;
  elsif jsonb_typeof(p_stored_fuel_stop -> 'kmUntilRefuel') = 'number' then
    stored_stop_km := (p_stored_fuel_stop ->> 'kmUntilRefuel')::numeric;
  end if;

  -- A stored stop we can't locate can't be re-validated — fail closed.
  if stored_needs_fuel and stored_stop_km is null then
    return holds;
  end if;

  deadband_km := coalesce(p_deadband_km, 10);

  -- ── planRefuel, recomputed at the CURRENT tank state ──────────────────────────
  -- safeConsumption(consumption, spread) from refuel-plan.ts, ported verbatim: the
  -- SAFETY decision runs at the conservative "thirstier" burn mean + spread (GVM-385),
  -- and a non-positive or absent spread collapses to the mean.
  cons_safe := p_consumption
             + case when p_consumption_spread is not null and p_consumption_spread > 0
                    then p_consumption_spread else 0 end;

  -- planRefuel gates on the MEAN consumption being positive, not the safe one.
  if p_consumption <= 0 then
    plan_needs_fuel := false;
    km_until_refuel := 0;
  else
    current_range_km := (p_liters_now / cons_safe) * 100;
    -- RESERVE_FRACTION = 0.1 in govehlo-mobile/src/lib/refuel-plan.ts — the fraction of
    -- the tank kept as an untouchable reserve. Kept as an explicit literal here rather
    -- than a settings column precisely so the contract test can pin the two together.
    reserve_km := ((p_tank_capacity * 0.1) / cons_safe) * 100;
    km_until_reserve := current_range_km - reserve_km;

    if km_until_reserve >= distance_km then
      -- Comfortably makes it on the current tank.
      plan_needs_fuel := false;
      km_until_refuel := 0;
    else
      plan_needs_fuel := true;
      -- round1() in refuel-plan.ts: Math.round(n * 10) / 10. Every comparison below
      -- uses the ROUNDED figure, exactly as the TypeScript does.
      km_until_refuel := round(greatest(0, least(km_until_reserve, distance_km)), 1);
    end if;
  end if;

  reserve_out := case when plan_needs_fuel then to_jsonb(km_until_refuel) else 'null'::jsonb end;

  if not stored_needs_fuel then
    -- Plan said no stop; does the current level now demand one, with real margin?
    if plan_needs_fuel and km_until_refuel <= distance_km - deadband_km then
      return jsonb_build_object('verdict', 'now-needs-stop', 'reserveKm', reserve_out, 'storedStopKm', null);
    end if;
    return jsonb_build_object('verdict', 'holds', 'reserveKm', reserve_out, 'storedStopKm', null);
  end if;

  -- Stored plan had a stop. Is the reserve now crossed meaningfully before we'd reach it?
  -- (A fuller-than-planned tank — plan_needs_fuel false, or a later crossing — never nags.)
  if plan_needs_fuel and stored_stop_km is not null and stored_stop_km - km_until_refuel >= deadband_km then
    return jsonb_build_object('verdict', 'move-earlier', 'reserveKm', reserve_out, 'storedStopKm', to_jsonb(stored_stop_km));
  end if;
  return jsonb_build_object('verdict', 'holds', 'reserveKm', reserve_out, 'storedStopKm', to_jsonb(stored_stop_km));
end;
$$;

revoke all on function public.fuel_stop_revalidation_verdict(jsonb, numeric, numeric, numeric, numeric, numeric) from public;
revoke all on function public.fuel_stop_revalidation_verdict(jsonb, numeric, numeric, numeric, numeric, numeric) from anon;
revoke all on function public.fuel_stop_revalidation_verdict(jsonb, numeric, numeric, numeric, numeric, numeric) from authenticated;

-- ── Claim / confirm ─────────────────────────────────────────────────────────────
alter table public.car_bookings
  add column if not exists fuel_reminded_at timestamptz,
  add column if not exists fuel_reminder_claimed_at timestamptz,
  add column if not exists fuel_reminder_claim_token uuid;

create index if not exists car_bookings_fuel_reminder_due_idx
  on public.car_bookings (start_at)
  where deleted_at is null
    and fuel_reminded_at is null;

-- Lease the bookings that need a pre-departure fuel-stop push, newest lease wins for
-- 15 minutes. Due-ness is decided HERE rather than in the caller so the endpoint
-- (GV-406) cannot accidentally relax it, and so the whole predicate is one thing to
-- test.
--
-- A booking is due when ALL of these hold:
--   • it starts within the next 3 hours and has not started yet;
--   • it is neither soft-deleted nor cancelled — car_bookings has no status column, so
--     cancellation IS the soft delete (deleted_at), which is what cancel_booking writes;
--   • its workspace is not itself soft-deleted (migration 132) — a decommissioned car
--     must go quiet, and the RLS-side helpers all check this, but this RPC runs as
--     service_role and would otherwise never see it;
--   • the booked member is still active and reachable by email;
--   • it has never been reminded and carries no live lease;
--   • its fuel_stop is an object with a usable numeric distanceKm;
--   • the car has a complete stamped tank state;
--   • NOTHING has happened to the car since that stamp — see below;
--   • and the verdict over the CURRENT tank state is not 'holds'.
--
-- The staleness gate is the fail-closed rule from fuel-stop-revalidation.ts applied to
-- the stamp itself: if any trip or fuel payment for the car is newer than the stamp's
-- watermark, the client's numbers predate real driving or a real fill-up and we do not
-- know the tank level any more. greatest(created_at, updated_at) rather than created_at
-- alone because an EDIT to an old trip, and a soft delete (every soft-delete path in
-- this schema sets deleted_at and updated_at together), invalidate the stamp exactly as
-- a new row does — and deleted rows are deliberately not filtered out for that reason.
create or replace function public.claim_due_booking_fuel_reminders(
  p_limit integer default 200
)
returns table (
  booking_id uuid,
  ledger_id text,
  member_id uuid,
  member_email text,
  verdict text,
  reserve_km numeric,
  stored_stop_km numeric,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select cb.id as target_booking_id,
           public.fuel_stop_revalidation_verdict(
             cb.fuel_stop,
             l.tank_state_liters,
             l.tank_state_consumption,
             coalesce(l.tank_state_consumption_spread, 0),
             l.tank_state_capacity,
             -- DEFAULT_REVALIDATION_DEADBAND_KM = 10 in
             -- govehlo-mobile/src/lib/fuel-stop-revalidation.ts. Only flag when the
             -- stored stop is at least this far past the new reserve crossing, so
             -- small between-planning drift does not nag.
             10
           ) as target_verdict
    from public.car_bookings cb
    join public.ledger_members lm
      on lm.id = cb.member_id
     and lm.ledger_id = cb.ledger_id
    join public.ledgers l
      on l.id = cb.ledger_id
    where cb.deleted_at is null
      and l.deleted_at is null
      and cb.start_at > now()
      and cb.start_at <= now() + interval '3 hours'
      and cb.fuel_reminded_at is null
      and (cb.fuel_reminder_claimed_at is null
           or cb.fuel_reminder_claimed_at <= now() - interval '15 minutes')
      and lm.is_active = true
      and lm.email is not null
      and jsonb_typeof(cb.fuel_stop) = 'object'
      and jsonb_typeof(cb.fuel_stop -> 'distanceKm') = 'number'
      and (cb.fuel_stop ->> 'distanceKm')::numeric > 0
      and l.tank_state_as_of is not null
      and l.tank_state_liters is not null
      and l.tank_state_consumption is not null
      and l.tank_state_capacity is not null
      and not exists (
        select 1
        from public.trips t
        where t.ledger_id = cb.ledger_id
          and greatest(t.created_at, t.updated_at) > l.tank_state_as_of
      )
      and not exists (
        select 1
        from public.fuel_payments fp
        where fp.ledger_id = cb.ledger_id
          and greatest(fp.created_at, fp.updated_at) > l.tank_state_as_of
      )
      and public.fuel_stop_revalidation_verdict(
            cb.fuel_stop,
            l.tank_state_liters,
            l.tank_state_consumption,
            coalesce(l.tank_state_consumption_spread, 0),
            l.tank_state_capacity,
            10
          ) ->> 'verdict' <> 'holds'
    order by cb.start_at
    limit greatest(coalesce(p_limit, 200), 0)
    for update of cb skip locked
  ),
  claimed as (
    update public.car_bookings cb
    set fuel_reminder_claimed_at = now(),
        fuel_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where cb.id = t.target_booking_id
    returning cb.id as booking_id,
              cb.ledger_id as ledger_id,
              cb.member_id as member_id,
              cb.fuel_reminder_claim_token as claim_token,
              t.target_verdict as target_verdict
  )
  select c.booking_id,
         c.ledger_id,
         c.member_id,
         lower(lm.email) as member_email,
         c.target_verdict ->> 'verdict' as verdict,
         case when jsonb_typeof(c.target_verdict -> 'reserveKm') = 'number'
              then (c.target_verdict ->> 'reserveKm')::numeric end as reserve_km,
         case when jsonb_typeof(c.target_verdict -> 'storedStopKm') = 'number'
              then (c.target_verdict ->> 'storedStopKm')::numeric end as stored_stop_km,
         c.claim_token
  from claimed c
  join public.ledger_members lm
    on lm.id = c.member_id
   and lm.ledger_id = c.ledger_id;
end;
$$;

revoke all on function public.claim_due_booking_fuel_reminders(integer) from public;
revoke all on function public.claim_due_booking_fuel_reminders(integer) from anon;
revoke all on function public.claim_due_booking_fuel_reminders(integer) from authenticated;
grant execute on function public.claim_due_booking_fuel_reminders(integer) to service_role;

-- Mark the leased bookings reminded, but only for a caller holding the token the claim
-- handed out — the one-shot half of the contract from migration 124. Anything the
-- sender could not deliver is simply left unconfirmed and falls back into the pool when
-- its lease expires.
create or replace function public.confirm_booking_fuel_reminders(confirmations jsonb)
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
    set fuel_reminded_at = now(),
        fuel_reminder_claimed_at = null,
        fuel_reminder_claim_token = null,
        updated_at = now()
    from input i
    where cb.id = i.booking_id
      and cb.deleted_at is null
      and cb.fuel_reminded_at is null
      and cb.fuel_reminder_claimed_at is not null
      and cb.fuel_reminder_claim_token = i.claim_token
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
           'booking_fuel_reminder_sent',
           'Tankstop-påmindelse behandlet',
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

revoke all on function public.confirm_booking_fuel_reminders(jsonb) from public;
revoke all on function public.confirm_booking_fuel_reminders(jsonb) from anon;
revoke all on function public.confirm_booking_fuel_reminders(jsonb) from authenticated;
grant execute on function public.confirm_booking_fuel_reminders(jsonb) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '154_booking_fuel_stop_reminders',
  'GV-405: pre-departure fuel-stop reminders — the before-departure twin of migration 124''s after-booking trip reminders. Adds ledgers.tank_state_liters/as_of/consumption/consumption_spread/capacity plus the member-gated set_tank_state RPC that writes them: the client stamps the OUTPUT of its 518-line trip-estimate tank model rather than the model being ported to PL/pgSQL, and the stamp is monotonic on a DATA watermark (the newest greatest(created_at, updated_at) across the trips and fuel_payments it consumed), so a client on a stale cache is refused as a quiet no-op instead of moving the tank level backwards. public.fuel_stop_revalidation_verdict mirrors revalidateFuelStop / planRefuel / safeConsumption from govehlo-mobile with RESERVE_FRACTION 0.1 and the 10 km deadband as explicit literals, and is pinned to that TypeScript by tools/test-fuel-stop-verdict-contract.mjs, which replays the mobile vitest scenarios against this SQL. claim_due_booking_fuel_reminders + confirm_booking_fuel_reminders are service-role-only on the 15-minute lease + one-shot-token discipline of migrations 080/082/102/118/124/153, with new car_bookings columns fuel_reminded_at / fuel_reminder_claimed_at / fuel_reminder_claim_token. Due-ness lives in the claim: start_at within the next 3 hours and not yet passed, not soft-deleted (cancellation IS the soft delete — car_bookings has no status column), member active with an email, a fuel_stop object carrying a usable numeric distanceKm (already the effective, tur/retur-doubled distance — the returnTrip flag is presentational and must NOT be applied as a multiplier), a complete tank stamp, and a non-holds verdict. Fail-closed on a stale stamp: any trip or fuel payment newer than tank_state_as_of skips the booking entirely, because we never nag on data we cannot trust.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 155: atomic set_tank_state, a tombstone-blind freshness gate, bounded inputs (GV-411)
--
-- Three defects an external review found in migration 154 (GV-405). 154 is ALREADY
-- APPLIED in production, so it is left untouched and both functions are re-declared
-- here off 154's definitions — the newest prior ones.
--
-- ── A. set_tank_state could write the tank level BACKWARDS ──────────────────────
-- 154 enforced monotonicity as a read-modify-write across three statements: select the
-- stored watermark, compare, then update. A plain select takes no row lock, so two
-- devices stamping at once both read the same pre-state, both pass the comparison, and
-- whichever update commits LAST wins — which may be the one carrying the OLDER
-- watermark. That is exactly the outcome the watermark exists to prevent, and the whole
-- reason it is a data mark rather than a clock reading (see the column comment on
-- ledgers.tank_state_as_of, unchanged here).
--
-- The condition now rides ON the update, so there is a single statement and no window
-- between the read and the write. Under READ COMMITTED a loser that blocks on the
-- winner's row lock re-evaluates the WHERE against the row version the winner
-- committed, sees the fresher watermark, and matches nothing.
--
-- The return contract is unchanged, deliberately: govehlo-mobile reads `applied`
-- (tankStampApplied in src/lib/tank-state-stamp.ts, GVM-480) and treats false as a
-- quiet no-op, and the `stale_as_of` reason plus `stored_as_of` keep their shape. `<=`
-- rather than `<` keeps an equal watermark accepted and the write idempotent: same data
-- in, same numbers out.
--
-- ── B. one soft-deleted trip or fuel row could silence reminders FOREVER ────────
-- 154's freshness gate skipped a booking when any trip or fuel payment for the car was
-- newer than the stamp's watermark, and deliberately did NOT filter tombstones — the
-- reasoning being that a deletion invalidates the stamp exactly as an edit does.
--
-- That reasoning holds only if the client can produce a watermark that covers the
-- deleted row, and it cannot: govehlo-mobile/src/store/ledger-data-gateway.ts fetches
-- trips and fuel payments with `.is('deleted_at', null)`, and the stamp's watermark is
-- the newest greatest(created_at, updated_at) across the rows it LOADED. A soft delete
-- bumps updated_at, so a tombstone is permanently newer than any watermark the client
-- can ever send. `not exists` stays true forever, the claim never returns that booking,
-- and pre-departure reminders die silently for that workspace — no error anywhere —
-- until an active trip or fuel row happens to be created with an even newer stamp.
--
-- So the gate now asks precisely the question the client can answer: is any row the
-- client would have LOADED newer than the watermark?
--
-- The residual, stated honestly: a deletion no longer marks the stamp stale, so between
-- a delete and the next tank-changing write the server may reason from a model that is
-- slightly out of date (it still counts a trip that has been removed). That is far
-- milder than permanent silence and it self-heals — the next trip or fuel write
-- re-stamps the model without the deleted row. The fully robust alternative is a
-- server-derived watermark that includes tombstones (recorded on GV-411); it becomes
-- the right answer if client-side deletion ever ships. Today there is no delete path in
-- the client at all — deletions come from the admin console or the database directly.
--
-- ── C. bounds on the client-supplied numbers ────────────────────────────────────
-- set_tank_state takes litres, capacity, consumption and spread straight from the
-- client's model, and that is by design (GV-405: the model is not ported to PL/pgSQL).
-- Trusting the client is not the same as accepting the absurd, though, so the obvious
-- impossibilities are refused. The envelope is not invented here — it is the one
-- migration 125's update_ledger_fuel_settings already enforces on the very settings
-- columns these numbers are derived from (consumption 0.1–100 L/100 km, capacity
-- 1–500 L), so nothing an honest client can produce is newly rejected:
--
--   • litres ≤ capacity — every branch of buildTripEstimate clamps the modelled level
--     into [0, tankCapacity], so only a hand-rolled call can breach it.
--   • capacity ≤ 500 L and consumption ≤ 100 L/100 km — the upper half of migration
--     125's range. Only the UPPER bounds are added: the existing "> 0" lower bounds
--     stay, so a legacy workspace whose settings predate 125 is not newly refused.
--   • consumption + spread ≤ 100 L/100 km — the spread is the other half of the burn
--     the verdict actually runs on (safeConsumption = consumption + spread), so it is
--     held to the same ceiling as the mean rather than left unbounded.
--
-- Rejections raise, like every other validation in this function — a silent clamp would
-- store numbers the client never computed and nudge people on them.

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

  -- Upper bounds (GV-411), matching migration 125's update_ledger_fuel_settings on the
  -- settings columns these numbers come from. A tank that cannot hold what it is said
  -- to hold, a 5000-litre tank or a 900 L/100 km burn are not model output; they are a
  -- fabricated or corrupt call, and the verdict engine would nudge the whole workspace
  -- on them.
  if liters_value > capacity_value then
    raise exception 'Tank state litres cannot exceed the tank capacity' using errcode = '23514';
  end if;

  if capacity_value > 500 then
    raise exception 'Tank state capacity must be 500 litres or less' using errcode = '23514';
  end if;

  if consumption_value > 100 then
    raise exception 'Tank state consumption must be 100 per 100 km or less' using errcode = '23514';
  end if;

  -- Mirrors safeConsumption's tolerance in govehlo-mobile/src/lib/refuel-plan.ts: a
  -- non-positive or absent spread collapses to zero rather than being rejected.
  normalized_spread := case when spread_value is not null and spread_value > 0 then spread_value else 0 end;

  -- safeConsumption = consumption + spread is the burn the verdict actually plans on,
  -- so the ceiling applies to the sum, not only to the mean.
  if consumption_value + normalized_spread > 100 then
    raise exception 'Tank state consumption plus spread must be 100 per 100 km or less' using errcode = '23514';
  end if;

  -- MONOTONIC on as_of, in ONE statement (GV-411). A stamp whose watermark is older
  -- than the stored one is a client working from a stale cache, and applying it would
  -- move the tank level BACKWARDS. 154 checked that with a separate select, which takes
  -- no row lock: two devices could both pass the check and the older calculation could
  -- commit last. Riding the condition on the update closes that window — under READ
  -- COMMITTED a loser blocked on the winner's row lock re-evaluates this WHERE against
  -- the committed row and matches nothing. `<=` keeps an equal watermark accepted, so
  -- re-sending the same stamp stays idempotent.
  update public.ledgers l
     set tank_state_liters = liters_value,
         tank_state_as_of = as_of_value,
         tank_state_consumption = consumption_value,
         tank_state_consumption_spread = normalized_spread,
         tank_state_capacity = capacity_value,
         updated_at = now()
   where l.id = target_ledger_id
     and (l.tank_state_as_of is null or l.tank_state_as_of <= as_of_value)
  returning l.tank_state_as_of into saved_as_of;

  if found then
    return jsonb_build_object(
      'ledger_id', target_ledger_id,
      'applied', true,
      'tank_state_liters', liters_value,
      'tank_state_as_of', saved_as_of
    );
  end if;

  -- Nothing was updated, which is two different situations: the workspace does not
  -- exist, or a fresher stamp is already stored. Read it back to tell them apart — the
  -- refusal is a no-op return, not an exception, because a losing race is NORMAL (a
  -- queued offline write flushing late) and the client must be able to ignore it
  -- quietly. Callers read `applied` to tell the two apart.
  select l.tank_state_as_of into saved_as_of
  from public.ledgers l
  where l.id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'applied', false,
    'reason', 'stale_as_of',
    'stored_as_of', saved_as_of
  );
end;
$$;

revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from public;
revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from anon;
grant execute on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) to authenticated;

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
-- alone because an EDIT to an old trip invalidates the stamp exactly as a new row does.
--
-- Tombstones are excluded (GV-411, changed from 154). 154 counted soft-deleted rows on
-- the grounds that a deletion invalidates the stamp too — but the client cannot answer
-- that question. ledger-data-gateway.ts loads trips and fuel payments with
-- `.is('deleted_at', null)` and the watermark is the newest greatest(created_at,
-- updated_at) across the rows it LOADED, so a tombstone — whose updated_at is bumped at
-- deletion — is permanently newer than any watermark the client can send. That made
-- this `not exists` permanently true and killed pre-departure reminders for the whole
-- workspace, silently and indefinitely. The gate now compares against exactly the rows
-- the client sees. The residual is that a deletion no longer marks the stamp stale, so
-- until the next tank-changing write the server may still count a removed trip; that
-- self-heals on the next write and is much milder than permanent silence. See the
-- header for the server-derived-watermark alternative and when it becomes right.
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
          and t.deleted_at is null
          and greatest(t.created_at, t.updated_at) > l.tank_state_as_of
      )
      and not exists (
        select 1
        from public.fuel_payments fp
        where fp.ledger_id = cb.ledger_id
          and fp.deleted_at is null
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '155_tank_state_atomicity_and_tombstones',
  'GV-411: three fixes to migration 154 (GV-405), which stays untouched because it is already applied in production. (A) set_tank_state is now atomic: 154 enforced its monotonic watermark with a separate select, compare and update, and a plain select takes no row lock — two devices could both pass the check and the OLDER calculation could commit last, moving the tank level backwards, which is precisely what the data watermark exists to prevent. The condition now rides on a single conditional update, so a loser blocked on the winner''s row lock re-evaluates it against the committed row under READ COMMITTED and matches nothing. The return contract is unchanged (applied / stale_as_of / stored_as_of, read by govehlo-mobile per GVM-480) and an equal watermark is still accepted and idempotent. (B) claim_due_booking_fuel_reminders''s freshness gate now ignores soft-deleted trips and fuel payments. 154 counted them deliberately, but the client loads both tables with deleted_at is null and derives its watermark from the rows it loaded, so a tombstone''s bumped updated_at is permanently newer than any watermark the client can produce — the not-exists stayed true forever and pre-departure reminders died silently for that workspace. The gate now asks exactly the question the client can answer; the residual is that a deletion no longer marks the stamp stale, which self-heals on the next tank-changing write. (C) set_tank_state now bounds its client-supplied numbers: litres must not exceed capacity, capacity must be 500 L or less, consumption must be 100 L/100 km or less, and consumption + spread (safeConsumption, the burn the verdict actually plans on) must also be 100 or less. The envelope is migration 125''s update_ledger_fuel_settings range on the very settings columns these numbers derive from, only the upper half, so no honest client output and no pre-125 legacy setting is newly refused; rejections raise like every other validation rather than clamping silently.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

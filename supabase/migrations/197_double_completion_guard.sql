-- Migration 197: a Danish sentence for a booking that is already completed (GV-479)
--
-- ── PROVENANCE ────────────────────────────────────────────────────────────────
-- complete_booking_trip_with_fuel is re-declared COMPLETELY off its NEWEST prior
-- definition. The whole chain, so the next re-declaration does not have to grep for it:
--
--   136 (the original atomic booking+fuel completion)
--     → 151 (drop_fuel_station_coordinates: the station lat/lng arguments removed)
--       → 157 (trip_crossing_cost: the crossing triple threaded through)
--         → 158 (crossing_provided_contract: the trailing crossing_provided flag)
--           → 188 (fuel_payment_booking_link: target_booking_id threaded into the
--                  fuel upsert as booking_id_value)  ← THIS MIGRATION'S BASE
--
-- Nothing between 189 and 196 touches this function. The signature is UNCHANGED here,
-- so create-or-replace is the whole change and no second candidate is left behind for
-- PostgREST to fail on (PGRST203); 188's ACL block is restated verbatim regardless,
-- because a create-or-replace keeps the grants and restating them costs nothing.
--
-- ── WHAT WAS WRONG ────────────────────────────────────────────────────────────
-- Migration 123 gave trips a booking and made the link exclusive with a partial unique
-- index, `trips_one_active_per_booking_idx on trips (booking_id) where booking_id is
-- not null and deleted_at is null`. That index is the database's last word on "one
-- booking, one live trip", and it speaks English: a caller who trips it gets
--
--     duplicate key value violates unique constraint "trips_one_active_per_booking_idx"
--
-- which is the only rejection on this path that a member could ever be shown raw. Every
-- other refusal in this schema is a Danish sentence under a distinct errcode.
--
-- There is a second, quieter half, and it is the one a real group actually meets. Two
-- members completing the SAME booking from two phones do not normally reach the index at
-- all: upsert_booking_trip_with_participants (158) locks the booking row, finds the trip
-- that is already linked, and REUSES it — silently adopting the second caller's odometer,
-- participants and note over the first caller's. That reuse is exactly right for a RETRY
-- (the offline outbox replays a completion with the SAME idempotency key, and a member
-- who taps twice must not get an error) and exactly wrong for a SECOND COMPLETION, which
-- arrives with a DIFFERENT key: Bo's kilometres quietly replace Anna's and nobody is told.
--
-- ── THE GUARD ─────────────────────────────────────────────────────────────────
-- One Danish sentence under one distinct errcode, raised from TWO places, because the two
-- cover different ground and neither covers the other:
--
--   1. THE PRE-CHECK, which is what members will actually hit. It runs INSIDE the same
--      booking-row lock the inner RPC uses as its idempotency boundary — taken here, one
--      step earlier, so that the check and the write it guards cannot be interleaved by a
--      second completer. (Re-taking the identical row lock inside the inner function is a
--      no-op for a transaction that already holds it, and the lock ORDER is unchanged:
--      the booking row was already the first lock this call took.) With the lock held,
--      "does this booking already have a live trip, logged under a DIFFERENT idempotency
--      key?" is a deterministic question, so the answer is a deterministic raise rather
--      than a race.
--
--      THREE CONDITIONS NARROW IT, and each one keeps an existing behaviour intact:
--        · only for a caller who is a ledger member — the lock must not be takeable by a
--          stranger, and a non-member still hears the inner RPC's 42501 first. Members
--          can already read every trip in their own workspace through RLS, so telling one
--          of them that a booking has been completed discloses nothing new (this is the
--          reason migration 160's "after every permission gate" rule does not bind here);
--        · only when the caller sent an idempotency key at all, so a blank one still gets
--          the inner RPC's 'Missing legacy trip id' (22023);
--        · only when the existing trip HAS a key and it DIFFERS from the incoming one.
--          Same key = the retry path, which must stay silent and idempotent — that is the
--          promise the offline outbox and the duplicate catalogue both rest on. An
--          existing trip with no key at all falls through to the inner RPC's own
--          'Existing booking trip has no idempotency key' (23514), unchanged.
--
--   2. THE RACE BACKSTOP, a NARROW unique_violation handler around the delegation, and
--      only around the delegation — the one statement that can insert or re-link a trip.
--      It re-raises anything whose CONSTRAINT_NAME is not trips_one_active_per_booking_idx
--      (a unique violation on trips_ledger_legacy_uq, on a fuel_payments key, or on
--      anything a future migration adds must keep saying what it is; a handler that
--      swallowed every 23505 in this function would mislabel all of them). What it
--      covers is precisely what the pre-check cannot see: a trip linked to this booking
--      by a path that does NOT hold the booking lock — a direct table write under RLS,
--      or a future caller of upsert_booking_trip_with_participants that skips this
--      wrapper. Postgres reports the index name in CONSTRAINT_NAME for a partial unique
--      INDEX exactly as it does for a unique CONSTRAINT, which is what makes the match
--      narrow rather than a substring hunt through sqlerrm.
--
-- ERRCODE 'GV479' follows the GV328 / GV333 / GV42O / GV46D / GV475 convention for a code
-- a client matches on, and it is free: no other errcode in this schema uses it. One
-- ticket, one entity, one remedy, so the bare-ticket-number form is right here and the
-- lettered form 159/160 needed (GV46D/GV46H, GV42T/GV42F/GV42B — one code per entity) is
-- not. The sentence names the remedy, so even a raw surfacing tells a person what to do:
-- somebody else finished this booking, pull to refresh and look at their trip.
--
-- ── WHAT DOES NOT CHANGE ──────────────────────────────────────────────────────
-- No schema change, no column, no index, no policy, no grant change and no new
-- event_type, so there is nothing to classify under GV-413 and nothing new is written
-- anywhere: a refused completion is a write that did not happen. The signature and the
-- return shape are untouched, so types/database.ts is unchanged and neither client repo
-- needs to re-vendor. The idempotent retry, the pre-refuel replay protection, the fuel
-- key reuse and 188's booking_id threading all carry through verbatim.

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
  booking_is_lockable boolean;
  existing_completion_legacy_id text;
  guard_constraint text;
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

  -- GV-479: one booking, one completion. The booking row is the idempotency boundary
  -- the inner RPC already serialises on, so the check is taken UNDER that same lock —
  -- one step earlier than the inner call, which then re-takes a lock this transaction
  -- already holds. Only for a member (a stranger must not be able to take the lock, and
  -- still hears 42501 from the inner RPC), only when an idempotency key was sent (a
  -- blank one still gets 'Missing legacy trip id'), and only when the trip that already
  -- completes this booking carries a DIFFERENT key: the same key is the retry the
  -- offline outbox depends on and must stay silent, and a keyless existing trip still
  -- gets the inner RPC's own 23514.
  if target_booking_id is not null
     and nullif(legacy_trip_id, '') is not null
     and public.is_ledger_member(target_ledger_id) then
    select true
      into booking_is_lockable
      from public.car_bookings cb
      where cb.id = target_booking_id
        and cb.ledger_id = target_ledger_id
        and cb.deleted_at is null
      for update of cb;

    if coalesce(booking_is_lockable, false) then
      select nullif(t.legacy_id, '')
        into existing_completion_legacy_id
        from public.trips t
        where t.booking_id = target_booking_id
          and t.deleted_at is null;

      if existing_completion_legacy_id is not null
         and existing_completion_legacy_id is distinct from legacy_trip_id then
        raise exception 'Bookingen er allerede afsluttet med en tur — opdater og se den nye tur.'
          using errcode = 'GV479';
      end if;
    end if;
  end if;

  -- This command inherits the booking lock, actor/driver/date checks, open-period
  -- lock, participant validation, and trip idempotency from migration 123.
  --
  -- The handler is the GV-479 race backstop and it is deliberately narrow: it covers
  -- ONLY trips_one_active_per_booking_idx, the partial unique index from migration 123,
  -- and only around the one statement that can insert or re-link a trip. A trip linked
  -- to this booking by a path that does not hold the booking lock — a direct table write
  -- under RLS, a future caller that skips this wrapper — is what reaches it; every other
  -- unique violation is re-raised unchanged, because a handler that swallowed all of
  -- them would report a duplicate idempotency key as a completed booking.
  begin
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
  exception
    when unique_violation then
      get stacked diagnostics guard_constraint = constraint_name;
      if guard_constraint = 'trips_one_active_per_booking_idx' then
        raise exception 'Bookingen er allerede afsluttet med en tur — opdater og se den nye tur.'
          using errcode = 'GV479';
      end if;
      raise;
  end;

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

-- The signature is unchanged, so create-or-replace kept the ACL; restated anyway, with
-- anon named explicitly (migration 148) and only authenticated granted back.
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '197_double_completion_guard',
  'A Danish sentence for a booking that is already completed (GV-479, decided on the ticket 2026-08-09). THE GAP: migration 123''s partial unique index trips_one_active_per_booking_idx (trips.booking_id where booking_id is not null and deleted_at is null) is the database''s last word on "one booking, one live trip", and it is the ONLY rejection on the completion path that speaks raw English Postgres — "duplicate key value violates unique constraint ..." — where every other refusal in this schema is a Danish sentence under a distinct errcode. The quieter half is the one a real group meets: two members completing the SAME booking from two phones usually never reach the index, because upsert_booking_trip_with_participants (158) locks the booking row, finds the trip already linked and REUSES it, silently adopting the second caller''s odometer, participants and note over the first caller''s. That reuse is right for a RETRY (the offline outbox replays the same idempotency key, and a double tap must not error) and wrong for a SECOND COMPLETION, which arrives with a DIFFERENT key. THE FIX: complete_booking_trip_with_fuel re-declared COMPLETELY off its newest prior definition, migration 188 (chain: 136 -> 151 -> 157 -> 158 -> 188; nothing between 189 and 196 touches it), byte-identical bar three declared variables, one pre-check and one exception handler. Signature UNCHANGED, so create-or-replace suffices and no PGRST203 candidate is left behind; the ACL block is restated anyway with anon named explicitly (148). ONE Danish sentence, "Bookingen er allerede afsluttet med en tur — opdater og se den nye tur.", under ONE distinct errcode GV479 (the GV328/GV333/GV42O/GV46D/GV475 convention; free, no other errcode in the schema uses it; the bare-ticket-number form is right because there is one entity and one remedy, unlike 159/160 where one code per ticket could not say WHICH entity moved), raised from TWO places that cover different ground. (1) THE PRE-CHECK, which is what members hit: it runs INSIDE the same car_bookings row lock the inner RPC uses as its idempotency boundary, taken one step earlier so the check and the write it guards cannot be interleaved by a second completer — re-taking the identical row lock inside the inner function is a no-op for a transaction that already holds it, and the lock ORDER is unchanged because the booking row was already the first lock this call took. Three conditions narrow it, each preserving an existing behaviour: only for a caller who passes is_ledger_member (a stranger must not be able to take the lock and still hears the inner RPC''s 42501 first; a member can already read every trip in their own workspace through RLS, so telling one of them that a booking is completed discloses nothing new, which is why migration 160''s "after every permission gate" rule does not bind here), only when an idempotency key was actually sent (a blank one still gets the inner RPC''s ''Missing legacy trip id'', 22023), and only when the trip that already completes this booking carries a key that DIFFERS from the incoming one (the same key is the retry path the offline outbox and the simulator''s duplicate catalogue both rest on and must stay silent and idempotent; an existing trip with no key at all still falls through to the inner RPC''s ''Existing booking trip has no idempotency key'', 23514). (2) THE RACE BACKSTOP: a NARROW unique_violation handler wrapped around the delegation to upsert_booking_trip_with_participants and nothing else — the one statement that can insert or re-link a trip. It matches on GET STACKED DIAGNOSTICS CONSTRAINT_NAME = ''trips_one_active_per_booking_idx'' (Postgres reports the index name in CONSTRAINT_NAME for a partial unique INDEX exactly as for a unique CONSTRAINT, which is what keeps the match narrow instead of a substring hunt through sqlerrm) and RE-RAISES everything else unchanged, because a handler that swallowed every 23505 in this function would report a duplicate trip idempotency key, or a fuel key collision, as a completed booking. What it covers is precisely what the pre-check cannot see: a trip linked to this booking by a path that does not hold the booking lock — a direct table write under RLS, or a future caller of upsert_booking_trip_with_participants that skips this wrapper. WHAT DOES NOT CHANGE: no schema change, no column, no index, no policy, no RLS change, no grant change and no new event_type, so there is nothing to classify under GV-413 and nothing is written anywhere — a refused completion is a write that did not happen. The signature and the jsonb return shape are untouched, so types/database.ts is unchanged and neither client repo needs to re-vendor. The idempotent retry, the pre-refuel replay protection, the fuel-key reuse and 188''s booking_id threading all carry through verbatim. VERIFIED BY: tools/test-double-completion-guard-contract.mjs (npm run test:double-completion-guard), wired into npm run validate, which pins the errcode, the sentence in both the migration and the consolidated mirror, the provenance, the narrow handler shape and the behaviour on a real Postgres; and by the simulator''s fifth lockstep contention scenario, double_completion (tools/simulator/lib/interleave.mjs), which is the collision the Phase B README listed as deliberately NOT covered because its expectation was unsettled — this migration settles it. Depends on 188 (the definition it re-declares) and 123 (the index and the booking lock it defends).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

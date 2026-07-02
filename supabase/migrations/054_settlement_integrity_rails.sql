-- Migration 054: server-side settlement integrity rails (GVM-112)
--
-- Until now the database enforced WHO may write but trusted every kroner figure
-- the client sent. Two trust boundaries are closed here, plus one race:
--
--   1. close_settlement_period archived the client-built snapshot verbatim. It
--      now recomputes the period's entry fingerprint (exact match — a pure
--      function of the live trip/fuel id sets, no float parity involved) and the
--      settlement itself (calculate_period_settlement below), rejecting a close
--      whose snapshot is stale or miscalculated with a "refresh and try again"
--      error instead of archiving wrong money.
--   2. upsert_settlement_request_status accepted any amount. A pair settlement
--      can never exceed the period's total fuel spend, so a 'requested'
--      transition is now bounded by that (plus 1 kr tolerance). Strict per-mode
--      equality is deliberately NOT enforced — monthly/running request shapes
--      (GVM-76) would false-reject.
--   3. upsert_trip_with_participants / upsert_fuel_payment checked "period is
--      open" without locking, so a write in flight during a close could land in
--      the just-closed period — invisible in the open view AND missing from the
--      archive. The check now takes FOR SHARE on the period row: the close's
--      UPDATE (exclusive row lock) serializes with writers, so either the write
--      commits first and the close's recompute sees it, or the close commits
--      first and the writer fails cleanly.
--
-- Tolerances: amounts are compared within 0.05 kr (totals / settlement flows)
-- and 0.02 kr (per-member figures). JS computes in float64 and rounds half
-- toward +infinity; Postgres numeric rounds half away from zero — bit-parity is
-- unattainable and unnecessary. Real staleness diverges by whole kroner; the
-- fingerprint catches pure entry-set drift exactly.

-- ── 1. Server-side settlement recompute ─────────────────────────────────────
-- Mirrors govehlo-mobile src/lib/settlement-calc.ts (pinned by its vitest suite,
-- GVM-104): live entries only, participants restricted to active members,
-- driver fallback when a trip has no valid participants, per-member km and
-- fuel-paid rounded to 2dp before totals, trip cost = rounded km x unrounded
-- rate. Returns { totalKm, totalPaid, fuelRate, people:[{id,name,km,fuelPaid,
-- tripCost,net}] }.
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

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    -- Participants who are active members; when none remain, fall back to the
    -- driver (if active) — exactly settlement-calc.ts's assignee resolution.
    select lt.id as trip_id,
           lt.km,
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
  per_member as (
    select am.id,
           am.name,
           round(coalesce(k.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid
    from active_members am
    left join (
      select ks.member_id, sum(ks.share_km) as km_sum
      from km_shares ks
      group by ks.member_id
    ) k on k.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid - round(pm.km * (t.total_paid / t.total_km), 2), 2)
                    else round(pm.fuel_paid, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── 2. Fingerprint helper ───────────────────────────────────────────────────
-- Byte-exact reproduction of the client fingerprint (period-snapshot.ts →
-- periodEntryFingerprint / legacy period-closing-helpers.js): JSON of the live
-- trip ids then fuel ids, each sorted. UUID strings are lowercase hex, so
-- COLLATE "C" byte order equals JavaScript's default sort.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
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
    || ']}';
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── 3. close_settlement_period v2: validate before archiving ────────────────
-- Full re-declaration of migration 004's definition plus the integrity gate
-- (server fingerprint + amount validation) after the advisory lock, so the
-- recompute sees exactly the rows the close will archive.
create or replace function public.close_settlement_period(
  target_ledger_id text,
  target_period_id uuid,
  period_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  snapshot_fingerprint text;
  server_fingerprint text;
  computed jsonb;
  computed_person jsonb;
  snapshot_person jsonb;
  snapshot_flow numeric;
  duplicate_period_id uuid;
  closed_period_id uuid;
  new_open_period_id uuid;
  requested_closed_at timestamptz;
  lock_acquired boolean;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if period_snapshot is null or jsonb_typeof(period_snapshot) <> 'object' then
    raise exception 'Period snapshot must be a JSON object' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can close settlement periods' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Guard before taking the advisory lock. Older frontend builds and health probes
  -- may call this RPC with a fake or already-closed period id. Reject those
  -- immediately so they cannot queue behind the lock and burn database CPU.
  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  lock_acquired := pg_try_advisory_xact_lock(hashtext(target_ledger_id));
  if lock_acquired is not true then
    raise exception 'Another settlement close is already in progress for this ledger' using errcode = '55P03';
  end if;

  -- ── Integrity gate (GVM-112) ──────────────────────────────────────────────
  -- (a) Entry set: the snapshot's fingerprint must equal the one recomputed
  -- from the live rows. In-flight writers hold FOR SHARE on the period row, so
  -- by the time this runs the row set is stable for the transaction.
  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  server_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, target_period_id);

  if snapshot_fingerprint is not null and snapshot_fingerprint <> server_fingerprint then
    raise exception 'Entries changed since this close was prepared. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  -- (b) Amounts: per-member figures within 0.02 kr, totals within 0.05 kr.
  computed := public.calculate_period_settlement(target_ledger_id, target_period_id);

  if abs(coalesce((period_snapshot->>'totalKm')::numeric, 0) - (computed->>'totalKm')::numeric) > 0.05
     or abs(coalesce((period_snapshot->>'totalPaid')::numeric, 0) - (computed->>'totalPaid')::numeric) > 0.05 then
    raise exception 'Snapshot totals do not match the server calculation. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  for computed_person in
    select value from jsonb_array_elements(computed->'people')
  loop
    select p.value
      into snapshot_person
      from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb)) as p(value)
      where p.value->>'id' = computed_person->>'id'
      limit 1;

    if abs(coalesce((snapshot_person->>'km')::numeric, 0) - (computed_person->>'km')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'fuelPaid')::numeric, 0) - (computed_person->>'fuelPaid')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'net')::numeric, 0) - (computed_person->>'net')::numeric) > 0.02 then
      raise exception 'Snapshot member amounts do not match the server calculation. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;

    -- (c) The archived settlements must actually move each member's net:
    -- outflow - inflow ~= -net for every member.
    select coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'fromId' = computed_person->>'id'), 0)
         - coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'toId' = computed_person->>'id'), 0)
      into snapshot_flow
      from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb)) as s(value);

    if abs(snapshot_flow + (computed_person->>'net')::numeric) > 0.05 then
      raise exception 'Snapshot settlements do not match the member balances. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;

  -- Snapshot-only members (left the ledger between fetch and close) must carry
  -- no money, otherwise the archive would hide a real balance.
  for snapshot_person in
    select value from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb))
  loop
    if not exists (
      select 1 from jsonb_array_elements(computed->'people') as c(value)
      where c.value->>'id' = snapshot_person->>'id'
    ) and abs(coalesce((snapshot_person->>'net')::numeric, 0)) > 0.02 then
      raise exception 'Snapshot includes a member the server no longer recognizes. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;
  -- ── End integrity gate ────────────────────────────────────────────────────

  if snapshot_fingerprint is not null then
    select sp.id into duplicate_period_id
    from public.settlement_periods sp
    where sp.ledger_id = target_ledger_id
      and sp.status = 'closed'
      and sp.snapshot_json->>'entryFingerprint' = snapshot_fingerprint
    limit 1;

    if duplicate_period_id is not null then
      raise exception 'This settlement period snapshot has already been closed' using errcode = '23505';
    end if;
  end if;

  begin
    requested_closed_at := coalesce((period_snapshot->>'closedAt')::timestamptz, now());
  exception when others then
    requested_closed_at := now();
  end;

  update public.settlement_periods sp
  set status = 'closed',
      label = coalesce(nullif(period_snapshot->>'label', ''), sp.label, 'Closed period'),
      closed_at = requested_closed_at,
      closed_by_member_id = actor_member_id,
      snapshot_json = period_snapshot,
      updated_at = now()
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  returning sp.id into closed_period_id;

  if closed_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '40001';
  end if;

  insert into public.settlement_periods (ledger_id, status, label, opened_at)
  values (target_ledger_id, 'open', 'Current period', now())
  returning id into new_open_period_id;

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', snapshot_fingerprint
  );
end;
$$;

-- ── 4. upsert_trip_with_participants v2: FOR SHARE on the open period ───────
-- Verbatim re-declaration of migration 051's definition; only the period-open
-- check changed (see the comment inside).
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
    start_km, end_km, note, created_by_member_id, deleted_at, updated_at
  ) values (
    legacy_trip_id, target_ledger_id, target_open_period_id, driver_member_id,
    trip_date_value, start_km_value, end_km_value, nullif(note_value, ''),
    actor_member_id, null, now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    driver_member_id = excluded.driver_member_id,
    trip_date = excluded.trip_date,
    start_km = excluded.start_km,
    end_km = excluded.end_km,
    note = excluded.note,
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

grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) to authenticated;

-- ── 5. upsert_fuel_payment v2: FOR SHARE on the open period ─────────────────
-- Verbatim re-declaration of migration 051's definition; only the period-open
-- check changed.
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
  station_lat_value numeric,
  station_lng_value numeric,
  user_lat_value numeric,
  user_lng_value numeric,
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
    station_lat,
    station_lng,
    user_lat,
    user_lng,
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
    station_lat_value,
    station_lng_value,
    user_lat_value,
    user_lng_value,
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
    station_lat = excluded.station_lat,
    station_lng = excluded.station_lng,
    user_lat = excluded.user_lat,
    user_lng = excluded.user_lng,
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

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;

-- ── 6. upsert_settlement_request_status v2: bounded request amounts ─────────
-- Verbatim re-declaration of migration 022's definition plus the amount bound.
create or replace function public.upsert_settlement_request_status(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  next_status text,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_request_id uuid;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_status text := coalesce(nullif(next_status, ''), 'open');
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save settlement requests' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or recipient_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23514';
  end if;

  if payer_member_id = recipient_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(payer_member_id, target_ledger_id)
    or not public.member_belongs_to_ledger(recipient_member_id, target_ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Settlement request amount must be zero or greater' using errcode = '23514';
  end if;

  if normalized_status not in ('open', 'requested', 'paid', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  if normalized_status = 'requested' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
  elsif normalized_status = 'paid' then
    paid_at_value := now();
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':settlement:' || target_open_period_id::text));

  insert into public.settlement_requests (
    ledger_id,
    period_id,
    from_member_id,
    to_member_id,
    amount,
    currency,
    status,
    requested_at,
    requested_by_member_id,
    paid_at,
    updated_at
  ) values (
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    recipient_member_id,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    normalized_status,
    requested_at_value,
    requested_by_value,
    paid_at_value,
    now()
  )
  on conflict (period_id, from_member_id, to_member_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    requested_at = excluded.requested_at,
    requested_by_member_id = excluded.requested_by_member_id,
    paid_at = excluded.paid_at,
    updated_at = now()
  returning id into saved_request_id;

  update public.settlement_requests sr
     set status = 'cancelled',
         updated_at = now(),
         requested_at = null,
         requested_by_member_id = null,
         paid_at = null
   where sr.ledger_id = target_ledger_id
     and sr.period_id = target_open_period_id
     and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(coalesce(current_pair_keys, array[]::text[])))
     and sr.status <> 'cancelled';
  get diagnostics cancelled_count = row_count;

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'status', normalized_status,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (id)
values ('054_settlement_integrity_rails')
on conflict (id) do nothing;

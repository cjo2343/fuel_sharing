-- Migration 140: durable late-entry carry-over for locked settlement periods
--
-- A payment request freezes the current period so the amount cannot move while
-- members pay. Previously that also rejected every late trip, fuel receipt,
-- expense, and repair. The app could simultaneously require a deferred receipt
-- and prohibit saving it.
--
-- Keep the frozen-period invariant, but accept NEW financial entries into one
-- hidden queued successor period. When close_settlement_period inserts the next
-- open period, an AFTER INSERT trigger atomically moves the queued rows into it.
-- Existing rows in the frozen period remain immutable. This makes late entries
-- durable on the server without changing requested amounts or relying on one
-- device's local outbox.

alter table public.settlement_periods
  drop constraint if exists settlement_periods_status_check;

alter table public.settlement_periods
  add constraint settlement_periods_status_check
  check (status in ('open', 'queued', 'closed'));

create unique index if not exists one_queued_settlement_period_per_ledger
  on public.settlement_periods (ledger_id)
  where status = 'queued';

create or replace function public.ensure_settlement_carryover_period(
  p_ledger_id text,
  p_source_period_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_id uuid;
begin
  if p_ledger_id is null or p_ledger_id = '' or p_source_period_id is null then
    raise exception 'Missing ledger or source settlement period' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = p_source_period_id
      and sp.ledger_id = p_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Carry-over source must be the ledger''s open settlement period'
      using errcode = '22023';
  end if;

  -- One queue per ledger. The advisory lock makes the read/create sequence safe
  -- when several members save late entries at the same time.
  perform pg_advisory_xact_lock(hashtext(p_ledger_id || ':settlement-carryover'));

  select sp.id
    into v_period_id
    from public.settlement_periods sp
    where sp.ledger_id = p_ledger_id
      and sp.status = 'queued'
    limit 1;

  if v_period_id is null then
    insert into public.settlement_periods (ledger_id, status, label, opened_at)
    values (p_ledger_id, 'queued', 'Næste periode', now())
    returning id into v_period_id;
  end if;

  return v_period_id;
end;
$$;

revoke all on function public.ensure_settlement_carryover_period(text, uuid) from public;
revoke all on function public.ensure_settlement_carryover_period(text, uuid) from anon;
revoke all on function public.ensure_settlement_carryover_period(text, uuid) from authenticated;

-- Re-declared off migration 121. New live INSERTS aimed at a locked open period
-- are rebound to the queued successor before the existing settlement-lock trigger
-- runs. UPDATE/DELETE still check both old and new periods exactly as before.
create or replace function public.enforce_settlement_entry_period_boundary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_period_id uuid;
  new_period_id uuid;
  old_ledger_id text;
  new_ledger_id text;
  period_row record;
  v_rule_lock boolean;
  v_new_is_live boolean := false;
begin
  if coalesce(current_setting('govehlo.pii_scrub', true), '') = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_table_name = 'trip_participants' then
    if tg_op in ('UPDATE', 'DELETE') then
      select t.period_id, t.ledger_id into old_period_id, old_ledger_id
      from public.trips t
      where t.id = old.trip_id;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      select t.period_id, t.ledger_id into new_period_id, new_ledger_id
      from public.trips t
      where t.id = new.trip_id;
    end if;
  elsif tg_table_name = 'vehicle_repairs' then
    if tg_op in ('UPDATE', 'DELETE') then
      old_period_id := old.period_id;
      old_ledger_id := old.ledger_id;
      if old_period_id is null then
        select sp.id into old_period_id
        from public.settlement_periods sp
        where sp.ledger_id = old.ledger_id
          and old.created_at >= sp.opened_at
          and (sp.closed_at is null or old.created_at < sp.closed_at)
        order by sp.opened_at desc
        limit 1;
      end if;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      new_period_id := new.period_id;
      new_ledger_id := new.ledger_id;
      v_new_is_live := new.deleted_at is null;
    end if;
  else
    if tg_op in ('UPDATE', 'DELETE') then
      old_period_id := old.period_id;
      old_ledger_id := old.ledger_id;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      new_period_id := new.period_id;
      new_ledger_id := new.ledger_id;
      v_new_is_live := new.deleted_at is null;
    end if;
  end if;

  if tg_table_name <> 'trip_participants'
     and tg_op = 'INSERT'
     and new_period_id is null then
    select sp.id into new_period_id
    from public.settlement_periods sp
    where sp.ledger_id = new_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    order by sp.opened_at desc
    limit 1;

    if new_period_id is null then
      raise exception 'No open settlement period exists for this ledger'
        using errcode = '22023';
    end if;
    new.period_id := new_period_id;
  end if;

  -- A live INSERT is the only operation allowed to cross the freeze boundary.
  -- It is assigned to a separate period, so the requested amount and close
  -- fingerprint of the frozen period cannot change. Tombstone inserts retain
  -- the ordinary path and do not create an otherwise empty successor queue.
  if tg_table_name <> 'trip_participants'
     and tg_op = 'INSERT'
     and v_new_is_live
     and new_period_id is not null then
    -- Serialize the classification with close_settlement_period. Without this
    -- source-row lock, a direct INSERT could create/find the queue just before a
    -- concurrent close promoted and deleted it, then fail its FK after the BEFORE
    -- trigger returned. RPC writers already take this lock; direct RLS writes need
    -- the same guarantee here at the table boundary.
    perform 1
    from public.settlement_periods sp
    where sp.id = new_period_id
      and sp.ledger_id = new_ledger_id
    for share of sp;

    select l.rule_lock_period_after_payment
      into v_rule_lock
      from public.ledgers l
      where l.id = new_ledger_id;

    if v_rule_lock is not false
       and public.settlement_entry_is_locked(new_ledger_id, new_period_id) then
      new_period_id := public.ensure_settlement_carryover_period(new_ledger_id, new_period_id);
      new.period_id := new_period_id;
    end if;
  end if;

  for period_row in
    select sp.id, sp.ledger_id, sp.status, sp.closed_at
    from public.settlement_periods sp
    where sp.id in (old_period_id, new_period_id)
    order by sp.id
    for share of sp
  loop
    if (period_row.id = old_period_id and period_row.ledger_id is distinct from old_ledger_id)
       or (period_row.id = new_period_id and period_row.ledger_id is distinct from new_ledger_id) then
      raise exception 'Settlement entry period must belong to the same ledger as the entry'
        using errcode = '23514';
    end if;

    if period_row.status = 'closed' or period_row.closed_at is not null then
      raise exception
        'This settlement period is closed -- entries can no longer be added or changed.'
        using errcode = '22023';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_settlement_entry_period_boundary() from public;
revoke all on function public.enforce_settlement_entry_period_boundary() from anon;
revoke all on function public.enforce_settlement_entry_period_boundary() from authenticated;

-- Repair rows gained period_id in migration 114, but the old repair guard still
-- used created_at and never applied the requested-payment lock. Prefer the bound
-- period, retain the timestamp fallback for legacy rows, and freeze settlement-
-- bearing edits in the same way as trips/fuel/expenses.
create or replace function public.enforce_repair_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_closed boolean := false;
  v_guard boolean := tg_op = 'DELETE';
  v_rule_lock boolean;
begin
  if old.period_id is not null then
    select (sp.status = 'closed' or sp.closed_at is not null)
      into v_period_closed
      from public.settlement_periods sp
      where sp.id = old.period_id
        and sp.ledger_id = old.ledger_id;
  else
    select exists (
      select 1
      from public.settlement_periods sp
      where sp.ledger_id = old.ledger_id
        and sp.closed_at is not null
        and old.created_at >= sp.opened_at
        and old.created_at < sp.closed_at
    ) into v_period_closed;
  end if;

  if v_period_closed then
    raise exception
      'This repair belongs to a closed settlement period and can no longer be edited or deleted.'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    v_guard := (new.cost_dkk is distinct from old.cost_dkk)
            or (new.paid_by_member_id is distinct from old.paid_by_member_id)
            or (new.period_id is distinct from old.period_id)
            or (new.deleted_at is distinct from old.deleted_at);
  end if;

  select l.rule_lock_period_after_payment
    into v_rule_lock
    from public.ledgers l
    where l.id = old.ledger_id;

  if v_guard and v_rule_lock is not false
     and public.settlement_entry_is_locked(old.ledger_id, old.period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. New repairs are saved for the next period; existing repairs cannot be changed.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_repair_period_lock() from public;
revoke all on function public.enforce_repair_period_lock() from anon;
revoke all on function public.enforce_repair_period_lock() from authenticated;

-- close_settlement_period always INSERTS the next open row after freezing the
-- current one. Promote queued rows in that same transaction, keeping the close
-- RPC, its fingerprint checks, and its returned open_period_id unchanged.
create or replace function public.promote_settlement_carryover_entries()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queued_period_id uuid;
begin
  if new.status <> 'open' or new.closed_at is not null then
    return new;
  end if;

  select sp.id
    into v_queued_period_id
    from public.settlement_periods sp
    where sp.ledger_id = new.ledger_id
      and sp.status = 'queued'
    for update of sp;

  if v_queued_period_id is null then
    return new;
  end if;

  update public.trips
     set period_id = new.id
   where period_id = v_queued_period_id;

  update public.fuel_payments
     set period_id = new.id
   where period_id = v_queued_period_id;

  update public.workspace_expenses
     set period_id = new.id
   where period_id = v_queued_period_id;

  update public.vehicle_repairs
     set period_id = new.id
   where period_id = v_queued_period_id;

  delete from public.settlement_periods
   where id = v_queued_period_id
     and status = 'queued';

  return new;
end;
$$;

revoke all on function public.promote_settlement_carryover_entries() from public;
revoke all on function public.promote_settlement_carryover_entries() from anon;
revoke all on function public.promote_settlement_carryover_entries() from authenticated;

drop trigger if exists promote_settlement_carryover_on_open on public.settlement_periods;
create trigger promote_settlement_carryover_on_open
after insert on public.settlement_periods
for each row execute function public.promote_settlement_carryover_entries();

-- Resolve an already-saved deferred booking receipt without replaying/moving the
-- original trip. The fuel INSERT is automatically queued by the boundary trigger
-- above when the current period is locked; only fixed, non-financial workflow
-- metadata is updated on the original trip, including when it is already closed.
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
  fuel_station_lat_value numeric default null,
  fuel_station_lng_value numeric default null,
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
    fuel_station_lat_value,
    fuel_station_lng_value,
    null,
    null,
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
  text, text, numeric, numeric, boolean, text, text
) from public;
revoke all on function public.complete_deferred_booking_fuel(
  text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric,
  text, text, numeric, numeric, boolean, text, text
) from anon;
grant execute on function public.complete_deferred_booking_fuel(
  text, uuid, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric,
  text, text, numeric, numeric, boolean, text, text
) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '140_late_entry_carryover',
  'Durable late-entry carry-over: new trips, fuel, expenses, recurring materializations, and repairs saved during a requested/paid lock are bound to one queued successor period and promoted atomically when close creates the next open period. Existing frozen entries remain immutable; repair lock/scoping now follows period_id.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

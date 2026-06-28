-- Migration 046: settlement safety rail — lock period after payment.
--
-- Global, always-on rule (no per-workspace override, no settings UI): once a
-- settlement payment has been requested or paid for the current OPEN period,
-- the trips, fuel logs, and trip participants that feed that period's
-- calculation are frozen. To correct an entry you must first reopen the
-- requested/paid payment (set its settlement_request back to open/cancelled),
-- which lifts the lock.
--
-- This backstops the existing client-side guard in the legacy web app so the
-- rule also holds for the native app and any direct API write. The companion
-- rail "require all requests before close" stays in the application layer
-- because it needs the JS settlement calculation (who owes whom) that the
-- database does not reproduce.
--
-- Design notes:
--   * Scoped to the OPEN period only. Closed periods are archived history; their
--     entries keep their final requested/paid rows but are intentionally left
--     editable/deletable here so retention cleanup and admin test-row purges
--     (migrations 009/012) and production reset (004) keep working.
--   * Only LIVE rows are protected. Hard-deleting or rewriting an already
--     soft-deleted (deleted_at is not null) tombstone is a no-op for settlement,
--     so it is allowed.
--   * UPDATEs are blocked only when a settlement-affecting column actually
--     changes, so an idempotent re-save with identical values never trips it.

create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;

  -- Entries created through the trip/fuel RPCs always carry the open period id.
  -- Fall back to the ledger's open period for any row that has none.
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;

  if v_period_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid')
  );
end;
$$;

create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_settlement_entry_lock_trips on public.trips;
create trigger enforce_settlement_entry_lock_trips
before insert or update or delete on public.trips
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_fuel on public.fuel_payments;
create trigger enforce_settlement_entry_lock_fuel
before insert or update or delete on public.fuel_payments
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_participants on public.trip_participants;
create trigger enforce_settlement_entry_lock_participants
before insert or update or delete on public.trip_participants
for each row execute function public.enforce_settlement_entry_lock();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('046_settlement_safety_rails', 'Lock-after-payment safety rail: block edits/deletes of live trips, fuel logs, and participants while the open settlement period has a requested or paid payment (global, always-on; reopen the payment to edit).')
on conflict (migration_id) do update set
  description = excluded.description;

-- Migration 088: fix enforce_settlement_entry_lock crashing on trip_participants writes (GV-225)
--
-- The closed-period rejection block (GV-199, migration 072/075) does
--   v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
-- BEFORE the trip_participants override two lines later. trip_participants has NO
-- period_id column, so that dereference raises `record "old" has no field
-- "period_id"` (or "new" ...) on any participant insert/update/delete — i.e. it
-- breaks logging or editing ANY trip via upsert_trip_with_participants (which
-- inserts/deletes trip_participants rows). The trigger already resolves the
-- parent trip's period into v_period_id at the top, so the fix is to select the
-- check column per table: v_period_id for trip_participants, the old/new
-- period_id for the row-owning tables. Re-declared off migration 075's body with
-- ONLY that reorder.

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
  v_check_period_id uuid;
  v_period_closed boolean;
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

  else -- UPDATE on trips / fuel_payments / workspace_expenses
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
    elsif tg_table_name = 'workspace_expenses' then
      v_guard := (new.amount_dkk is distinct from old.amount_dkk)
              or (new.paid_by_member_id is distinct from old.paid_by_member_id)
              or (new.split_rule is distinct from old.split_rule)
              or (new.split_config is distinct from old.split_config)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock and covers every attached table. delete_my_account's GDPR scrubs set
  -- the transaction-local govehlo.pii_scrub GUC to opt out — those touch only
  -- non-settlement columns (e.g. trip note) and must succeed on closed rows.
  if coalesce(current_setting('govehlo.pii_scrub', true), '') <> '1' then
    -- trip_participants has no period_id column, so it must use the parent trip's
    -- period resolved above; only the row-owning tables carry old/new.period_id
    -- (dereferencing it on trip_participants raised 'record has no field period_id'
    -- and broke all trip logging/editing — GV-225).
    if tg_table_name = 'trip_participants' then
      v_check_period_id := v_period_id;
    else
      v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    end if;
    if v_check_period_id is not null then
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id;
      if v_period_closed then
        raise exception
          'This settlement period is closed — entries can no longer be added or changed.'
          using errcode = '22023';
      end if;
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('088_fix_trip_participants_period_check',
        'Fix enforce_settlement_entry_lock dereferencing old/new.period_id on trip_participants (no such column) in the GV-199 closed-period block, which raised ''record "old" has no field "period_id"'' and broke logging/editing any trip. Select the closed-period check column per table: v_period_id (parent trip) for trip_participants, old/new.period_id for the row-owning tables (GV-225).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

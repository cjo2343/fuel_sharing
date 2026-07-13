-- Migration 121: complete the settlement period boundary for direct writes.
--
-- Migration 120 correctly made request amounts immutable on paid-ish transitions
-- and made the existing entry trigger take a FOR SHARE lock. This follow-up covers
-- three adjacent direct-PostgREST paths that the single-current-period check does
-- not cover:
--
--   * a request/entry could combine a ledger_id with a period_id owned by another
--     ledger; for a requested payment that made the exact-amount lookup return no
--     row and fall through as though the period were historical;
--   * an UPDATE moving an entry checked/locked NEW.period_id only, so it could move
--     a row out of an OLD closed period;
--   * vehicle_repairs participates in settlement calculations but uses a separate
--     update/delete guard and had no direct-insert period-row serialization.
--
-- The guards below are deliberately table-boundary protections. RPC callers keep
-- their existing behavior; direct inserts with no period are bound to the ledger's
-- open period, and all affected old/new periods are locked in UUID order.

create or replace function public.enforce_settlement_request_period_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.period_id is null then
    raise exception 'Settlement requests must belong to a settlement period'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and (new.ledger_id is distinct from old.ledger_id
          or new.period_id is distinct from old.period_id
          or new.from_member_id is distinct from old.from_member_id
          or new.to_member_id is distinct from old.to_member_id) then
    raise exception 'Settlement request ledger, period, and parties are immutable'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = new.period_id
      and sp.ledger_id = new.ledger_id
  ) then
    raise exception 'Settlement request period must belong to the same ledger as the request'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_settlement_request_period_identity() from public;
revoke all on function public.enforce_settlement_request_period_identity() from anon;
revoke all on function public.enforce_settlement_request_period_identity() from authenticated;

drop trigger if exists assert_settlement_request_period_identity on public.settlement_requests;
create trigger assert_settlement_request_period_identity
before insert or update of ledger_id, period_id, from_member_id, to_member_id
on public.settlement_requests
for each row execute function public.enforce_settlement_request_period_identity();

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
begin
  -- Account deletion scrubs only PII fields on historical rows. Preserve the
  -- transaction-local bypass used by the existing closed-period guards.
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
    end if;
  else
    if tg_op in ('UPDATE', 'DELETE') then
      old_period_id := old.period_id;
      old_ledger_id := old.ledger_id;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      new_period_id := new.period_id;
      new_ledger_id := new.ledger_id;
    end if;
  end if;

  -- Legitimate RPCs already supply a period. Bind a direct row insert to the
  -- ledger's current open period so null cannot evade close serialization.
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

drop trigger if exists assert_settlement_period_boundary_trips on public.trips;
create trigger assert_settlement_period_boundary_trips
before insert or update or delete on public.trips
for each row execute function public.enforce_settlement_entry_period_boundary();

drop trigger if exists assert_settlement_period_boundary_fuel on public.fuel_payments;
create trigger assert_settlement_period_boundary_fuel
before insert or update or delete on public.fuel_payments
for each row execute function public.enforce_settlement_entry_period_boundary();

drop trigger if exists assert_settlement_period_boundary_participants on public.trip_participants;
create trigger assert_settlement_period_boundary_participants
before insert or update or delete on public.trip_participants
for each row execute function public.enforce_settlement_entry_period_boundary();

drop trigger if exists assert_settlement_period_boundary_expenses on public.workspace_expenses;
create trigger assert_settlement_period_boundary_expenses
before insert or update or delete on public.workspace_expenses
for each row execute function public.enforce_settlement_entry_period_boundary();

drop trigger if exists assert_settlement_period_boundary_repairs on public.vehicle_repairs;
create trigger assert_settlement_period_boundary_repairs
before insert or update or delete on public.vehicle_repairs
for each row execute function public.enforce_settlement_entry_period_boundary();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('121_settlement_period_boundary',
        'Settlement period boundary completion: request identity + same-ledger period ownership, old/new period locking for direct entry writes, null-period insert binding, and direct vehicle-repair serialization.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

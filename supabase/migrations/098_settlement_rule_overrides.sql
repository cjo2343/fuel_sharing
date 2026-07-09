-- Migration 098: per-workspace operator override for settlement safety rules (GV-158)
--
-- The two settlement safety rules shipped as global, always-on invariants and are
-- shown read-only ("Enforced") in the admin console (GV-105):
--   (a) Lock period after payment — closed/paid periods are protected against
--       modification (enforced in the database by enforce_settlement_entry_lock,
--       migrations 046 → 072/075/088, plus the closed-period rejection from GV-199).
--   (b) Require all requests before close — a period cannot close until every
--       calculated payment has been requested. This rule has NEVER had database
--       enforcement: close_settlement_period (latest migration 087) checks the
--       entry fingerprint and per-member amounts, but not request coverage. As
--       migration 046 already noted, that check lives in the application layer
--       because it needs the JS settlement calculation the database does not
--       reproduce.
--
-- This migration makes both rules overridable PER WORKSPACE, changeable ONLY by the
-- app owner (operator) through the admin console's owner API (service-role writes,
-- GV-137/148 pattern — no new RPC needed). Two boolean columns on public.ledgers
-- default to true, so applying this migration changes nothing until an operator
-- flips a flag.
--
-- Wiring:
--   * rule_lock_period_after_payment  — WIRED. enforce_settlement_entry_lock is
--     re-declared (off its newest prior body, migration 088) to consult this flag;
--     when false it skips BOTH the closed-period rejection and the requested/paid
--     lock for that ledger only.
--   * rule_require_requests_before_close — STORED ONLY. There is no database guard
--     to gate (see rule (b) above), so this column exists for the operator toggle
--     and any future client-side use; it has no effect on the database today.

alter table public.ledgers
  add column if not exists rule_lock_period_after_payment boolean not null default true;

alter table public.ledgers
  add column if not exists rule_require_requests_before_close boolean not null default true;

-- Re-declared off migration 088 (newest prior body) with ONE addition: a
-- per-workspace override lookup. When the ledger's rule_lock_period_after_payment
-- flag is false, both the closed-period rejection and the requested/paid lock are
-- skipped for that ledger. Only an explicit false disables the rail; a null (no
-- ledger row resolved) keeps the always-on behaviour (GV-158).
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
  v_rule_lock boolean;
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

  -- Per-workspace override (GV-158): an operator can disable the lock-after-payment
  -- safety rail for a single workspace via the admin console. Default true keeps the
  -- always-on behaviour below; when a ledger's rule_lock_period_after_payment is
  -- false, skip BOTH the closed-period rejection and the requested/paid lock so its
  -- members can edit freely. Only an explicit false disables the rail — a null (no
  -- ledger row resolved) leaves the rail on.
  if v_ledger_id is not null then
    select l.rule_lock_period_after_payment
      into v_rule_lock
      from public.ledgers l
      where l.id = v_ledger_id;
    if v_rule_lock is false then
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
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
values ('098_settlement_rule_overrides',
        'Per-workspace operator override for the settlement safety rules (GV-158): rule_lock_period_after_payment + rule_require_requests_before_close boolean columns on ledgers (default true = current enforced behaviour). enforce_settlement_entry_lock (re-declared off 088) skips the closed-period rejection and requested/paid lock for a ledger whose rule_lock_period_after_payment is false. rule_require_requests_before_close is stored only — that rule has no database enforcement (close_settlement_period never checked request coverage), so the flag drives the operator toggle and any future client use.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

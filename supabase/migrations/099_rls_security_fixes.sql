-- Migration 099: RLS security fixes — remove forgeable insert policies, split the lock override (GV-243)
--
-- Three verified fixes to the settlement/activity RLS surface.
--
-- FIX 1 (HIGH) — settlement_periods INSERT forgery. Migration 005 shipped
--   `create policy "Ledger members can insert periods" ... with check
--   (public.is_ledger_member(ledger_id))` with no column restriction. Any member
--   could therefore INSERT a row directly with status = 'closed', a fabricated
--   snapshot_json, and arbitrary closed_at/closed_by_member_id — forging settlement
--   history and sailing past close_settlement_period's integrity gate (that gate only
--   guards the SECURITY DEFINER close path). Both legitimate creators
--   (create_private_ledger_workspace, close_settlement_period) are SECURITY DEFINER and
--   bypass RLS, and no client inserts this table directly (verified: govehlo-mobile and
--   govehlo-web only SELECT it). So the insert policy is dropped outright — with RLS
--   enabled and no INSERT policy, direct client inserts are default-denied.
--
-- FIX 2 (HIGH) — ledger_events actor spoofing. Same migration-005 shape:
--   `with check (public.is_ledger_member(ledger_id))`. actor_member_id / actor_email
--   are client-supplied and unchecked, so a member could insert a feed event
--   impersonating another member. All legitimate events are written by SECURITY DEFINER
--   RPCs; no client inserts this table directly (verified: govehlo-mobile has no direct
--   inserts, and govehlo-web only SELECTs it plus a service-role PATCH of push_sent_at).
--   The insert policy is dropped outright (default-deny).
--
-- FIX 3 (MEDIUM) — the 098 override must keep the closed-period archive lock.
--   Migration 098 made enforce_settlement_entry_lock consult a per-workspace flag
--   (rule_lock_period_after_payment) and, when false, skipped BOTH the requested/paid
--   lock AND the closed-period rejection. Skipping the closed-period rejection lets
--   archived rows in a closed period diverge silently from that period's frozen
--   snapshot_json. This migration re-declares the function (off its newest prior body,
--   migration 098) so the flag only relaxes the requested/paid lock; the closed-period
--   rejection now always applies, override or not. Migration 088's trip_participants
--   handling is preserved unchanged.

-- FIX 1 — drop the forgeable settlement_periods insert policy (default-deny).
drop policy if exists "Ledger members can insert periods" on public.settlement_periods;

-- FIX 2 — drop the forgeable ledger_events insert policy (default-deny).
drop policy if exists "Ledger members can insert ledger events" on public.ledger_events;

-- FIX 3 — re-declared off migration 098 (newest prior body). Only change: the
-- per-workspace override now relaxes ONLY the requested/paid lock; the closed-period
-- rejection is always enforced so archived rows cannot diverge from snapshot_json.
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

  -- Per-workspace override (GV-158, split by GV-243): an operator can disable the
  -- lock-after-payment safety rail for a single workspace via the admin console. The
  -- override is SPLIT across the two protections it used to skip together:
  --   * the requested/paid settlement lock (further below) IS skipped when the flag
  --     is false, so members can freely edit trips/fuel in an OPEN period.
  --   * the closed-period rejection (below) is NOT skipped by this flag — archived
  --     rows in a closed period must always match that period's frozen snapshot_json,
  --     so the closed lock stays enforced regardless of the override.
  -- Only an explicit false relaxes the requested/paid lock; a null (no ledger row
  -- resolved) keeps the always-on behaviour. This lookup no longer returns early.
  if v_ledger_id is not null then
    select l.rule_lock_period_after_payment
      into v_rule_lock
      from public.ledgers l
      where l.id = v_ledger_id;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock, covers every attached table, and is NOT affected by the override flag
  -- above (GV-243). delete_my_account's GDPR scrubs set the transaction-local
  -- govehlo.pii_scrub GUC to opt out — those touch only non-settlement columns
  -- (e.g. trip note) and must succeed on closed rows.
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

  -- Requested/paid settlement lock — this is the only protection the per-workspace
  -- override relaxes: skipped when the ledger's rule_lock_period_after_payment is
  -- false (GV-243). The closed-period rejection above always runs.
  if v_guard and v_rule_lock is not false
     and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
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
values ('099_rls_security_fixes',
        'RLS security fixes (GV-243): drop the forgeable "Ledger members can insert periods" policy on settlement_periods and "Ledger members can insert ledger events" policy on ledger_events (both had only is_ledger_member checks; no client inserts either table directly, all legitimate writes are SECURITY DEFINER, so RLS default-deny is safe). Re-declare enforce_settlement_entry_lock (off migration 088/098) so the per-workspace rule_lock_period_after_payment override relaxes only the requested/paid lock — the closed-period rejection now always applies so archived rows cannot diverge from the period''s frozen snapshot_json.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

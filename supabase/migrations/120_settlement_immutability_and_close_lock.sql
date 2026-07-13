-- Migration 120: settlement amount immutability + close-race row locks (GV-293)
--
-- Two verified release-blockers from the settlement-integrity Codex review:
--
--   FINDING 1 — settlement amounts were mutable via a direct PostgREST UPDATE.
--     enforce_settlement_request_exact_amount (migration 117) early-returns for any
--     row whose new status is not 'requested', and only migration 117's dispute guard
--     (old.status = 'paid_pending') re-checked immutability. So requested -> paid_pending,
--     paid_pending -> paid, and every other exit from 'requested' could rewrite the
--     ledger, period, pair, amount, or currency through the parties' direct-write RLS.
--     The dispute guard is generalized: on ANY update whose result is not 'requested',
--     those six fields must equal the stored row (errcode 23514 otherwise). Transitions
--     INTO 'requested' (fresh request, re-request, dispute) still set the amount — that
--     path is validated against the server pairing further below. Reminder bookkeeping
--     (claim tokens / timestamps on requested OR paid_pending rows) touches none of the
--     six fields, so it passes unchanged.
--
--   FINDING 2 — a direct table write could pass a trigger's period-status read and
--     commit after close_settlement_period committed, so it landed in an OPEN period the
--     archived snapshot no longer covered. The close wrapper (migration 117) takes FOR
--     UPDATE on the period row, but the triggers' status reads were plain SELECTs that
--     never synchronized with it, and authenticated members keep direct-write RLS.
--     enforce_settlement_entry_lock's closed-period read (covering trips, fuel_payments,
--     workspace_expenses, trip_participants) and enforce_settlement_request_exact_amount's
--     period-open read now take FOR SHARE OF the period row: an in-flight direct writer
--     holds the share lock so the close blocks on it, and a writer that starts during the
--     close blocks on the close's FOR UPDATE and, once it commits, re-reads the now-closed
--     row and is rejected (or, for a request, treated as a closed-period historical row).
--
-- Both functions are re-declared off their newest prior definitions
-- (enforce_settlement_entry_lock: migration 099; enforce_settlement_request_exact_amount:
-- migration 117), verified by searching every later migration for a re-declaration.

-- ── FINDING 2: enforce_settlement_entry_lock — closed-period read takes FOR SHARE ──
-- Re-declared off migration 099 (its newest prior body). The ONLY change from 099 is
-- that the closed-period rejection's SELECT now locks the period row FOR SHARE, so a
-- direct trips/fuel/expenses/trip_participants writer synchronizes with the FOR UPDATE
-- that close_settlement_period holds: in-flight writers make the close wait, and writers
-- that begin during the close block until it commits and then see the closed row.
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
      -- FOR SHARE OF sp (GV-293): synchronize this closed-period read with the FOR
      -- UPDATE close_settlement_period holds on the same row. A direct writer that is
      -- in flight when the close starts holds this share lock, forcing the close to
      -- wait for it; a writer that starts mid-close blocks here on the close's FOR
      -- UPDATE and, once it commits, re-reads the row as closed and is rejected below.
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id
        for share of sp;
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

revoke all on function public.enforce_settlement_entry_lock() from public;
revoke all on function public.enforce_settlement_entry_lock() from anon;
revoke all on function public.enforce_settlement_entry_lock() from authenticated;

-- ── FINDING 1 + 2: enforce_settlement_request_exact_amount ───────────────────────
-- Re-declared off migration 117 (its newest prior body). Two changes:
--   FINDING 1 — the paid_pending-only dispute guard is generalized to a blanket
--     immutability guard: on ANY UPDATE whose result status is not 'requested', the
--     ledger, period, pair, amount, and currency must equal the stored row, closing the
--     requested -> paid_pending / paid_pending -> paid / -> cancelled / -> open direct
--     UPDATE mutation holes. Rows landing in 'requested' still flow into the exact-amount
--     validation below; the reminder-bookkeeping carve-out for requested rows is retained.
--   FINDING 2 — the period-open read locks the period row FOR SHARE so a direct request
--     writer synchronizes with close_settlement_period's FOR UPDATE (see the entry-lock
--     trigger above for the same pattern).
create or replace function public.enforce_settlement_request_exact_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  computed_settlement jsonb;
  debtor_ids uuid[] := array[]::uuid[];
  debtor_amts numeric[] := array[]::numeric[];
  creditor_ids uuid[] := array[]::uuid[];
  creditor_amts numeric[] := array[]::numeric[];
  di integer := 1;
  ci integer := 1;
  pair_amount numeric;
  expected_pair_amount numeric := null;
  period_is_open boolean;
begin
  -- FINDING 1 (GV-293): a settlement request's obligation is immutable across any
  -- status transition that does NOT (re)enter 'requested'. Migration 117 only guarded
  -- the paid_pending -> requested dispute edge and early-returned for everything else,
  -- so a settlement party could rewrite the ledger, period, pair, amount, or currency
  -- through a direct RLS UPDATE while claiming/confirming/cancelling a payment. Any
  -- UPDATE whose result is not 'requested' must therefore preserve all six fields.
  -- Transitions INTO 'requested' (fresh request, re-request, dispute) fall through to
  -- the exact-amount validation below, which pins the amount to the server pairing.
  -- Reminder bookkeeping (claim tokens / timestamps) never changes these six fields,
  -- so it is unaffected.
  if tg_op = 'UPDATE' and new.status <> 'requested' then
    if new.ledger_id is distinct from old.ledger_id
       or new.period_id is distinct from old.period_id
       or new.from_member_id is distinct from old.from_member_id
       or new.to_member_id is distinct from old.to_member_id
       or new.amount is distinct from old.amount
       or new.currency is distinct from old.currency then
      raise exception 'A settlement request''s ledger, period, pair, amount, and currency are immutable once requested; only its status may change'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status <> 'requested'
     or new.period_id is null
     or new.from_member_id is null
     or new.to_member_id is null then
    return new;
  end if;

  new.currency := upper(coalesce(nullif(btrim(new.currency), ''), 'DKK'));
  if new.currency <> 'DKK' then
    raise exception 'Settlement requests must use DKK' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    -- A dispute must always be able to reopen a claim. The recipient can issue a
    -- fresh request afterwards if the live balance changed while it was pending,
    -- but the dispute transition itself cannot rewrite the claimed obligation.
    if old.status = 'paid_pending' then
      if new.ledger_id is distinct from old.ledger_id
         or new.period_id is distinct from old.period_id
         or new.from_member_id is distinct from old.from_member_id
         or new.to_member_id is distinct from old.to_member_id
         or new.amount is distinct from old.amount
         or new.currency is distinct from old.currency then
        raise exception 'Disputing a payment claim must preserve its pair, amount, and currency'
          using errcode = '23514';
      end if;
      return new;
    end if;

    -- Reminder bookkeeping updates requested rows without re-requesting them.
    -- Do not turn those background writes into an amount recalculation gate.
    if old.status = 'requested'
       and new.amount is not distinct from old.amount
       and new.from_member_id is not distinct from old.from_member_id
       and new.to_member_id is not distinct from old.to_member_id
       and new.period_id is not distinct from old.period_id
       and new.ledger_id is not distinct from old.ledger_id
       and new.currency is not distinct from old.currency
       and new.requested_at is not distinct from old.requested_at then
      return new;
    end if;
  end if;

  -- FOR SHARE OF sp (GV-293): synchronize this period-open read with the FOR UPDATE
  -- close_settlement_period holds on the same row, so an in-flight requested-status
  -- writer blocks the close and a writer that starts mid-close waits for the commit
  -- and then sees the period as closed (falling through to the stored-amount path).
  select (sp.status = 'open' and sp.closed_at is null)
    into period_is_open
    from public.settlement_periods sp
    where sp.id = new.period_id
      and sp.ledger_id = new.ledger_id
    for share of sp;

  -- Closed-period requests are immutable historical obligations; status-only
  -- transitions continue to use their stored amount.
  if period_is_open is not true then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.ledger_id || ':settlement:' || new.period_id::text));
  computed_settlement := public.calculate_period_settlement(new.ledger_id, new.period_id);

  select coalesce(array_agg((p.value->>'id')::uuid order by (p.value->>'net')::numeric asc, (p.value->>'id') collate "C"), array[]::uuid[]),
         coalesce(array_agg(round(-((p.value->>'net')::numeric), 2) order by (p.value->>'net')::numeric asc, (p.value->>'id') collate "C"), array[]::numeric[])
    into debtor_ids, debtor_amts
    from jsonb_array_elements(computed_settlement->'people') as p(value)
    where (p.value->>'net')::numeric < -0.005;

  select coalesce(array_agg((p.value->>'id')::uuid order by (p.value->>'net')::numeric desc, (p.value->>'id') collate "C"), array[]::uuid[]),
         coalesce(array_agg(round((p.value->>'net')::numeric, 2) order by (p.value->>'net')::numeric desc, (p.value->>'id') collate "C"), array[]::numeric[])
    into creditor_ids, creditor_amts
    from jsonb_array_elements(computed_settlement->'people') as p(value)
    where (p.value->>'net')::numeric > 0.005;

  while di <= coalesce(array_length(debtor_ids, 1), 0)
        and ci <= coalesce(array_length(creditor_ids, 1), 0) loop
    pair_amount := round(least(debtor_amts[di], creditor_amts[ci]), 2);
    if debtor_ids[di] = new.from_member_id and creditor_ids[ci] = new.to_member_id then
      expected_pair_amount := pair_amount;
      exit;
    end if;
    debtor_amts[di] := round(debtor_amts[di] - pair_amount, 2);
    creditor_amts[ci] := round(creditor_amts[ci] - pair_amount, 2);
    if debtor_amts[di] <= 0.005 then di := di + 1; end if;
    if creditor_amts[ci] <= 0.005 then ci := ci + 1; end if;
  end loop;

  if expected_pair_amount is null or expected_pair_amount <= 0 then
    raise exception 'This settlement pair is no longer part of the current server calculation. Refresh the app and try again.'
      using errcode = '23514';
  end if;
  if round(coalesce(new.amount, 0), 2) <> expected_pair_amount then
    raise exception 'Settlement request amount does not match the current server calculation. Refresh the app and try again.'
      using errcode = '23514';
  end if;

  new.amount := expected_pair_amount;
  return new;
end;
$$;

revoke all on function public.enforce_settlement_request_exact_amount() from public;
revoke all on function public.enforce_settlement_request_exact_amount() from anon;
revoke all on function public.enforce_settlement_request_exact_amount() from authenticated;

drop trigger if exists enforce_settlement_request_exact_amount_trigger on public.settlement_requests;
create trigger enforce_settlement_request_exact_amount_trigger
before insert or update on public.settlement_requests
for each row execute function public.enforce_settlement_request_exact_amount();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('120_settlement_immutability_and_close_lock',
        'Settlement immutability + close-race row locks (GV-293). FINDING 1: enforce_settlement_request_exact_amount (re-declared off 117) generalizes the paid_pending dispute guard — ANY UPDATE whose result status is not ''requested'' must preserve ledger_id, period_id, from_member_id, to_member_id, amount, and currency (errcode 23514), closing the requested->paid_pending / paid_pending->paid / ->cancelled / ->open direct-UPDATE mutation holes; transitions INTO ''requested'' still validate against the server pairing and the requested-row reminder carve-out is retained. FINDING 2: the period-status reads in enforce_settlement_entry_lock (re-declared off 099; covers trips/fuel_payments/workspace_expenses/trip_participants) and enforce_settlement_request_exact_amount now take FOR SHARE OF the settlement_periods row, so a direct PostgREST writer synchronizes with close_settlement_period''s FOR UPDATE: an in-flight writer blocks the close and a writer starting mid-close waits for the commit and then sees the period closed.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

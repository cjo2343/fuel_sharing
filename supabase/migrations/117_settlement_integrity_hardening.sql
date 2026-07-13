-- Migration 117: settlement close, amount, and confirmation hardening (security audit)
--
-- Three financial-state boundaries are tightened together:
--   1. close_settlement_period now locks the open period row BEFORE fingerprinting
--      and calculating, so an in-flight writer cannot commit a row that is omitted
--      from the archived snapshot.
--   2. requested settlement amounts must match the server's deterministic pairing,
--      not merely remain below total fuel spend.
--   3. paid_pending claims are never promoted to paid by elapsed time alone. Only
--      the recipient can confirm receipt through the normal status RPC.

-- Preserve the battle-tested close implementation and put the serialization
-- boundary in a narrow wrapper. Re-running the migration is safe: the rename only
-- happens once, while CREATE OR REPLACE refreshes the public wrapper.
do $$
begin
  if to_regprocedure('public.close_settlement_period_unlocked(text,uuid,jsonb)') is null then
    if to_regprocedure('public.close_settlement_period(text,uuid,jsonb)') is null then
      raise exception 'close_settlement_period(text, uuid, jsonb) is missing';
    end if;
    execute 'alter function public.close_settlement_period(text, uuid, jsonb) rename to close_settlement_period_unlocked';
  end if;
end
$$;

revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from public;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from anon;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from authenticated;

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
  locked_period_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;
  if target_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can close settlement periods' using errcode = '42501';
  end if;

  -- This is deliberately a separate statement before the existing close body.
  -- READ COMMITTED therefore takes a fresh snapshot for every calculation after a
  -- blocked writer commits. Writers already take FOR SHARE on this row; writers
  -- that start later block here until the close commits and then see no open row.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for update of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  return public.close_settlement_period_unlocked(target_ledger_id, target_period_id, period_snapshot);
end;
$$;

revoke all on function public.close_settlement_period(text, uuid, jsonb) from public;
revoke all on function public.close_settlement_period(text, uuid, jsonb) from anon;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;

-- Validate the amount at the table boundary, covering both the SECURITY DEFINER
-- RPC and any direct PostgREST write that RLS permits. The pairing is the same
-- deterministic largest-debtor/largest-creditor algorithm used by the RPC's stale
-- request sweep and by the mobile client.
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

  select (sp.status = 'open' and sp.closed_at is null)
    into period_is_open
    from public.settlement_periods sp
    where sp.id = new.period_id
      and sp.ledger_id = new.ledger_id;

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

-- Elapsed time is not evidence that money arrived. Keep the old signature as a
-- deployment-compatible no-op while the web scheduler is removed separately.
create or replace function public.claim_due_settlement_confirmations(
  p_max_age_hours integer default 72,
  p_limit integer default 200
)
returns integer
language sql
security definer
set search_path = public
as $$
  select 0::integer
$$;

revoke all on function public.claim_due_settlement_confirmations(integer, integer) from public;
revoke all on function public.claim_due_settlement_confirmations(integer, integer) from anon;
revoke all on function public.claim_due_settlement_confirmations(integer, integer) from authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('117_settlement_integrity_hardening',
        'Settlement integrity hardening (security audit): close_settlement_period now takes an exclusive period-row lock before calculation via a non-bypassable wrapper; requested amounts must equal the server-derived pair amount; elapsed paid_pending claims are no longer auto-confirmed.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

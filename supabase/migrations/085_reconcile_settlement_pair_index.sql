-- Migration 085: reconcile settlement pair unique index + ON CONFLICT predicate (GVM-241, GV-183)
--
-- Root cause of the mark-as-paid failure (GVM-241): the pair upsert in
-- upsert_settlement_request_status used `on conflict (period_id, from_member_id,
-- to_member_id) do update` with NO index predicate. The intended arbiter is the
-- PARTIAL unique index settlement_requests_current_pair_idx (... WHERE status <>
-- 'cancelled', from 001_initial_schema). Prod, however, ALSO carried a DRIFTED
-- full unique index settlement_requests_period_from_to_unique on the same three
-- columns with NO predicate — this index is not in the repo migrations (GV-183).
-- With two competing indexes and a predicate-less ON CONFLICT, Postgres could not
-- deterministically arbiter the `paid` write against the existing `requested`
-- row, so it INSERTed a fresh row directly at status 'paid' and tripped the 003
-- trigger guard ('Request the payment before marking it paid').
--
-- This migration: (1) drops the drifted full pair-uniqueness (no-op on fresh
-- installs), (2) ensures the canonical partial index exists, and (3) re-declares
-- the function off migration 084's latest body with ONE change — the upsert's
-- conflict target gains ` where status <> 'cancelled'` so Postgres uses the
-- partial index as arbiter and mark-as-paid UPDATEs instead of INSERTing.

-- In prod the drifted pair-uniqueness is backed by a CONSTRAINT (which owns its
-- index), so `drop index` is rejected — the constraint must be dropped and the
-- index goes with it. The `drop index` line then covers any environment where it
-- exists only as a bare index. Both are `if exists`, so both are no-ops on a
-- fresh install where neither was ever created.
alter table public.settlement_requests drop constraint if exists settlement_requests_period_from_to_unique;
drop index if exists public.settlement_requests_period_from_to_unique;

create unique index if not exists settlement_requests_current_pair_idx
on public.settlement_requests (period_id, from_member_id, to_member_id)
where status <> 'cancelled';

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

  -- Require an existing, non-cancelled request before marking paid (GVM-241).
  -- Without this the pair upsert's on-conflict misses for a stale/foreign-period
  -- request and INSERTs a fresh row directly at status 'paid', which trips the
  -- 003 trigger guard with the cryptic 'Request the payment before marking it
  -- paid'. Raise a clean, mappable error instead.
  if normalized_status = 'paid' then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
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
  on conflict (period_id, from_member_id, to_member_id) where status <> 'cancelled' do update set
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

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('085_reconcile_settlement_pair_index',
        'Reconcile the settlement pair unique index: drop the drifted full unique index settlement_requests_period_from_to_unique (GV-183), ensure the canonical partial index, and add the WHERE status <> cancelled predicate to the upsert ON CONFLICT so mark-as-paid UPDATEs instead of INSERTing (GVM-241).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

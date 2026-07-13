-- Migration 122: request-id settlement transition commands.
--
-- Creation/re-requesting still uses upsert_settlement_request_status because that
-- command owns amount validation and stale-pair reconciliation. Lifecycle actions
-- must not resend mutable identity or money fields from a cached client row, though.
-- These wrappers resolve and lock the canonical request by id, then delegate to the
-- established transition engine with the stored ledger/period/pair/amount/currency.
--
-- The batch command runs every transition in one transaction. A running-mode card
-- therefore changes all constituent requests or none of them, instead of leaving a
-- partial payment/reminder state when one request fails midway through a client loop.

create or replace function public.transition_settlement_request_status(
  target_request_id uuid,
  next_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  request_row public.settlement_requests%rowtype;
  actor_member_id uuid;
  normalized_status text := nullif(btrim(next_status), '');
  transition_result jsonb;
  is_noop boolean := false;
begin
  if target_request_id is null then
    raise exception 'Missing settlement request id' using errcode = '22023';
  end if;

  if normalized_status not in ('open', 'requested', 'paid_pending', 'paid') then
    raise exception 'Invalid settlement request status transition command' using errcode = '23514';
  end if;

  -- Resolve identity before locking so an unauthorised caller cannot hold a row lock.
  -- Migration 121 makes ledger/period/party identity immutable, so these fields cannot
  -- move between this read and the locked re-read below.
  select sr.*
    into request_row
    from public.settlement_requests sr
    where sr.id = target_request_id;

  if not found or not public.is_ledger_member(request_row.ledger_id) then
    raise exception 'Settlement request was not found or is unavailable' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(request_row.ledger_id);
  if actor_member_id is null
     or (
       actor_member_id not in (request_row.from_member_id, request_row.to_member_id)
       and not public.is_ledger_admin(request_row.ledger_id)
     ) then
    raise exception 'Only the payer, recipient, or a ledger admin can change this settlement request'
      using errcode = '42501';
  end if;

  -- Match the lock order used by upsert_settlement_request_status: period advisory
  -- lock first, request row second. Keeping that order avoids a wrapper-vs-legacy-RPC
  -- deadlock while old clients are still in circulation.
  perform pg_advisory_xact_lock(
    hashtext(request_row.ledger_id || ':settlement:' || request_row.period_id::text)
  );

  select sr.*
    into request_row
    from public.settlement_requests sr
    where sr.id = target_request_id
    for update;

  if not found or request_row.status = 'cancelled' then
    raise exception 'Settlement request is no longer active — refresh and try again'
      using errcode = '22023';
  end if;

  -- Retried claims/confirms/reopens are idempotent. requested->requested is NOT a
  -- no-op because that command intentionally re-stamps requested_at and emits the
  -- reminder event used by the payment-reminder UI.
  if request_row.status = normalized_status and normalized_status <> 'requested' then
    is_noop := true;
  else
    transition_result := public.upsert_settlement_request_status(
      request_row.ledger_id,
      request_row.period_id,
      request_row.from_member_id,
      request_row.to_member_id,
      request_row.amount,
      request_row.currency,
      normalized_status,
      array[]::text[],
      p_note
    );

    select sr.*
      into request_row
      from public.settlement_requests sr
      where sr.id = target_request_id;

    if not found then
      raise exception 'Settlement request disappeared during transition' using errcode = '40001';
    end if;
  end if;

  return coalesce(transition_result, '{}'::jsonb) || jsonb_build_object(
    'settlement_request_id', request_row.id,
    'ledger_id', request_row.ledger_id,
    'period_id', request_row.period_id,
    'status', request_row.status,
    'requested_at', request_row.requested_at,
    'paid_claimed_at', request_row.paid_claimed_at,
    'paid_at', request_row.paid_at,
    'paid_note', request_row.paid_note,
    'dispute_note', request_row.dispute_note,
    'updated_at', request_row.updated_at,
    'noop', is_noop
  );
end;
$$;

revoke all on function public.transition_settlement_request_status(uuid, text, text) from public;
revoke all on function public.transition_settlement_request_status(uuid, text, text) from anon;
grant execute on function public.transition_settlement_request_status(uuid, text, text) to authenticated;

create or replace function public.transition_settlement_requests_status(
  target_request_ids uuid[],
  next_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  unique_request_ids uuid[];
  ordered_request_ids uuid[];
  requested_count integer;
  found_count integer;
  request_id uuid;
  results jsonb := '[]'::jsonb;
begin
  if target_request_ids is null or cardinality(target_request_ids) = 0 then
    raise exception 'At least one settlement request id is required' using errcode = '22023';
  end if;

  if exists (select 1 from unnest(target_request_ids) as ids(id) where id is null) then
    raise exception 'Settlement request ids cannot contain null' using errcode = '22023';
  end if;

  select array_agg(ids.id order by ids.id), count(*)
    into unique_request_ids, requested_count
    from (select distinct id from unnest(target_request_ids) as input(id)) ids;

  if requested_count > 50 then
    raise exception 'A settlement transition batch may contain at most 50 requests'
      using errcode = '54000';
  end if;

  -- Every caller locks a mixed-period batch in the same ledger/period/id order.
  -- Missing ids are rejected before any transition runs.
  select array_agg(sr.id order by sr.ledger_id, sr.period_id, sr.id), count(*)
    into ordered_request_ids, found_count
    from public.settlement_requests sr
    where sr.id = any(unique_request_ids);

  if found_count <> requested_count then
    raise exception 'One or more settlement requests were not found or are unavailable'
      using errcode = '42501';
  end if;

  foreach request_id in array ordered_request_ids loop
    results := results || jsonb_build_array(
      public.transition_settlement_request_status(request_id, next_status, p_note)
    );
  end loop;

  return jsonb_build_object(
    'count', jsonb_array_length(results),
    'requests', results
  );
end;
$$;

revoke all on function public.transition_settlement_requests_status(uuid[], text, text) from public;
revoke all on function public.transition_settlement_requests_status(uuid[], text, text) from anon;
grant execute on function public.transition_settlement_requests_status(uuid[], text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '122_settlement_transition_commands',
  'Add request-id lifecycle commands that load canonical settlement identity and money fields server-side, make settled-state retries idempotent, and provide an atomic max-50 batch transition for running-mode payment cards.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

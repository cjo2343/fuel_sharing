-- Migration 089: allow mark-paid / reopen / remind on a CLOSED settlement period (GVM-243)
--
-- The Pay tab renders settlement requests across periods — including debts carried
-- past a period close — and offers mark-paid / remind on them. But
-- upsert_settlement_request_status (migration 087) hard-required the target period
-- to be OPEN, and its GVM-241 guard looked for the pair's request in that open
-- period. setSettlementStatus (mobile) always passed the current OPEN period id, so
-- acting on a closed-period row either failed ("No active payment request to mark as
-- paid") or, if the same pair also had an open-period request, marked the WRONG
-- period's request paid.
--
-- This re-declares the function off its latest body (087) with one change: the
-- target period may be OPEN (unchanged behaviour — request, pay, remind, and the
-- stale-pair cancellation sweep) or CLOSED. On a closed period only an EXISTING
-- request for the pair may transition (paid / open / requested) — a closed period
-- can gain no new requests, the requested-amount bound (an open-period concept) is
-- skipped, and the stale-pair cancellation sweep is skipped so the archived
-- period's other requests are never touched. Event logging + realtime nudge are
-- unchanged, so a closed-period mark-paid still syncs live like an open-period one.
--
-- Mobile passes the request row's own period_id (GVM-243); an open-period row's
-- period_id equals the active period, so open-period behaviour is identical.

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
  event_type_value text;
  event_title_value text;
  period_is_open boolean;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save settlement requests' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Resolve the target period. Normally OPEN (request + pay on the live period).
  -- For a debt carried past a close, mobile acts on the request in its own CLOSED
  -- period (GVM-243): mark paid / remind / reopen are allowed there, but only
  -- against an existing request (guarded below). A missing/foreign period is
  -- rejected outright.
  select (sp.status = 'open' and sp.closed_at is null)
    into period_is_open
  from public.settlement_periods sp
  where sp.id = target_open_period_id
    and sp.ledger_id = target_ledger_id;

  if period_is_open is null then
    raise exception 'Settlement period was not found or does not belong to this ledger' using errcode = '22023';
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

  -- A closed period can gain no NEW requests: only an existing (non-cancelled)
  -- request for the pair may transition. This blanket-guards paid / requested /
  -- open on a closed period; the insert branch + stale sweep below stay
  -- open-period-only.
  if not period_is_open then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active settlement request for this pair in the closed period' using errcode = '22023';
    end if;
  end if;

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request. Open-period only: a
  -- closed period's fuel total is frozen and the amount already exists on the row.
  if normalized_status = 'requested' and period_is_open then
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

  -- Transition the pair's request via an explicit lookup + UPDATE, NOT
  -- INSERT ... ON CONFLICT. The 003 integrity trigger is BEFORE INSERT OR UPDATE,
  -- and a BEFORE INSERT trigger fires on an upsert's proposed row *before* the
  -- ON CONFLICT resolves to DO UPDATE — so an upsert to status 'paid' trips the
  -- trigger's INSERT-paid guard even when a matching request exists (GVM-241).
  -- An explicit UPDATE fires BEFORE UPDATE, where the guard validates the
  -- requested->paid transition as legal. Genuinely new rows still INSERT (open
  -- period only — a closed period was guaranteed an existing request above).
  select sr.id into saved_request_id
  from public.settlement_requests sr
  where sr.period_id = target_open_period_id
    and sr.from_member_id = payer_member_id
    and sr.to_member_id = recipient_member_id
    and sr.status <> 'cancelled'
  for update;

  if saved_request_id is not null then
    update public.settlement_requests
       set amount = amount_value,
           currency = coalesce(nullif(currency_value, ''), 'DKK'),
           status = normalized_status,
           requested_at = requested_at_value,
           requested_by_member_id = requested_by_value,
           paid_at = paid_at_value,
           updated_at = now()
     where id = saved_request_id;
  elsif period_is_open then
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
    returning id into saved_request_id;
  else
    raise exception 'No active settlement request for this pair in the closed period' using errcode = '22023';
  end if;

  -- Cancel stale requests whose pair is no longer valid this period. Open-period
  -- only: current_pair_keys is computed from the OPEN period's live settlements,
  -- so running it against a closed period would wrongly cancel that archived
  -- period's requests.
  if period_is_open then
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
  end if;

  -- Activity feed + realtime nudge (GVM-247): every status change writes a
  -- ledger_events row so the other member's client (subscribed to ledger_events)
  -- refetches immediately, and the change lands in the activity feed.
  -- 'requested' -> payment_requested (the feed's role-aware Pay/Remind CTA keys
  -- on this type + metadata.settlement_request_id); 'paid' -> payment_paid;
  -- reopen/cancel -> settlement_open / settlement_cancelled.
  event_type_value := case normalized_status
    when 'requested' then 'payment_requested'
    when 'paid' then 'payment_paid'
    else 'settlement_' || normalized_status
  end;
  event_title_value := case normalized_status
    when 'requested' then 'Betaling anmodet'
    when 'paid' then 'Betaling markeret som betalt'
    when 'cancelled' then 'Betaling annulleret'
    else 'Betaling genåbnet'
  end;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, event_type_value, event_title_value, '',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'from_member_id', payer_member_id,
      'to_member_id', recipient_member_id,
      'amount', amount_value
    )
  );

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
values ('089_settlement_status_on_closed_period',
        'Let upsert_settlement_request_status act on a CLOSED period (mark-paid / reopen / remind) against an existing request, so debts carried past a period close can be settled from the Pay tab — skips new-row insert, the requested-amount bound, and the stale-pair cancellation sweep on closed periods so archived requests are untouched (GVM-243).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

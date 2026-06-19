-- Migration 031: Backend-owned payment status action RPC.
-- Moves the settlement payment request/paid/reopen action into one database
-- transaction that saves the normalized payment status, prunes stale settlement
-- rows, and emits a lightweight ledger event for realtime/admin diagnostics.

create or replace function public.apply_payment_status_action(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  previous_status text,
  next_status text,
  audit_summary text,
  audit_detail text,
  audit_metadata jsonb default '{}'::jsonb,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  safe_actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  saved_request_id uuid;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_previous text := coalesce(nullif(previous_status, ''), 'open');
  normalized_next text := coalesce(nullif(next_status, ''), 'open');
  event_type_value text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can update payment status' using errcode = '42501';
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

  if normalized_next not in ('open', 'requested', 'paid', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  if not public.is_valid_payment_status_transition(normalized_previous, normalized_next) then
    raise exception 'Invalid settlement request status transition from % to %', normalized_previous, normalized_next using errcode = '23514';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    if normalized_next = 'requested' and actor_member_id is distinct from recipient_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    if normalized_next = 'paid' and actor_member_id is distinct from payer_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;
  end if;

  if normalized_next = 'requested' then
    requested_at_value := now();
    requested_by_value := actor_member_id;
    event_type_value := 'payment_requested';
  elsif normalized_next = 'paid' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
    paid_at_value := now();
    event_type_value := 'payment_marked_paid';
  else
    event_type_value := 'payment_reopened';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':payment-action:' || target_open_period_id::text));

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
    normalized_next,
    requested_at_value,
    requested_by_value,
    paid_at_value,
    now()
  )
  on conflict (period_id, from_member_id, to_member_id) do update set
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

  insert into public.ledger_events (
    ledger_id,
    event_type,
    title,
    body,
    actor_member_id,
    actor_email,
    target_member_id,
    metadata
  ) values (
    target_ledger_id,
    event_type_value,
    coalesce(nullif(audit_summary, ''), 'Payment status updated'),
    coalesce(nullif(audit_detail, ''), 'Payment status was updated by the backend action RPC.'),
    actor_member_id,
    nullif(safe_actor_email, ''),
    case when normalized_next = 'requested' then payer_member_id else recipient_member_id end,
    coalesce(audit_metadata, '{}'::jsonb) || jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'previous_status', normalized_previous,
      'next_status', normalized_next,
      'backend_action', 'apply_payment_status_action'
    )
  );

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'previous_status', normalized_previous,
    'status', normalized_next,
    'event_type', event_type_value,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from public;
revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from anon;
grant execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('031_payment_status_action_rpc', 'Backend-owned payment status action RPC writes settlement status and ledger event in one transaction.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();

-- Migration 090: two-step settlement confirmation — paid_pending state (GVM-213)
--
-- Until now a debtor's "mark paid" was one-sided and final: the row went
-- straight to 'paid' and the debt was settled with no say from the creditor.
-- GVM-213 (Tier 2) makes payment a handshake:
--
--   open → requested → paid_pending → paid          (creditor confirms, or auto)
--                           └──(dispute)──→ requested   (debt goes live again)
--
--   • Debtor "mark paid"      : requested     → paid_pending  (payer only)
--   • Creditor "confirm"      : paid_pending  → paid          (recipient only)
--   • Creditor "dispute"      : paid_pending  → requested     (recipient only)
--   • Auto-confirm after ~3d  : paid_pending  → paid          (service role sweep)
--
-- Balance treatment is OPTIMISTIC: paid_pending counts as settled the moment the
-- debtor claims it (see the mobile side + settlement_entry_is_locked below), and
-- a dispute restores the debt. The stuck-forever case is handled by
-- claim_due_settlement_confirmations, run daily by the scheduler.
--
-- This adds the paid_pending status + a paid_claimed_at timestamp, extends the
-- transition validator and the integrity trigger (including a bypass for the
-- service-role auto-confirm), re-declares upsert_settlement_request_status off
-- migration 089 to speak the new states, teaches settlement_entry_is_locked that
-- a paid_pending request still locks the period, and adds the auto-confirm RPC.

-- ── Schema: new status + claim timestamp ────────────────────────────────────

alter table public.settlement_requests
  add column if not exists paid_claimed_at timestamptz;

alter table public.settlement_requests
  drop constraint if exists settlement_requests_status_check;
alter table public.settlement_requests
  add constraint settlement_requests_status_check
  check (status in ('open', 'requested', 'paid', 'paid_pending', 'cancelled'));

-- ── Transition validator: allow the paid_pending edges ──────────────────────

create or replace function public.is_valid_payment_status_transition(p_previous_status text, p_next_status text)
returns boolean
language sql
immutable
as $$
  select case coalesce(p_previous_status, 'open')
    when 'open' then coalesce(p_next_status, 'open') in ('open', 'requested', 'cancelled')
    when 'requested' then coalesce(p_next_status, 'open') in ('requested', 'paid', 'paid_pending', 'open', 'cancelled')
    when 'paid_pending' then coalesce(p_next_status, 'open') in ('paid_pending', 'paid', 'requested', 'open', 'cancelled')
    when 'paid' then coalesce(p_next_status, 'open') in ('paid', 'open')
    when 'cancelled' then coalesce(p_next_status, 'open') in ('cancelled', 'requested', 'open')
    else false
  end;
$$;

-- ── Integrity trigger: role gates for claim / confirm / dispute ─────────────

create or replace function public.enforce_settlement_request_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if new.ledger_id is null or new.ledger_id = '' then
    raise exception 'Settlement request is missing a ledger id' using errcode = '23502';
  end if;

  if new.from_member_id is null or new.to_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23502';
  end if;

  if new.from_member_id = new.to_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(new.from_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.to_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.requested_by_member_id, new.ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and not public.is_valid_payment_status_transition(old.status, new.status) then
    raise exception 'Invalid settlement request status transition from % to %', old.status, new.status using errcode = '23514';
  end if;

  -- A settlement can only reach paid / paid_pending by transitioning an existing
  -- request, never by a fresh INSERT into a settled-ish state (GVM-213 extends the
  -- original paid-only guard to the new paid_pending claim).
  if tg_op = 'INSERT' and coalesce(new.status, 'open') in ('paid', 'paid_pending') then
    raise exception 'Request the payment before marking it paid' using errcode = '23514';
  end if;

  actor_member_id := public.current_ledger_member_id(new.ledger_id);
  -- Role gates, bypassed for ledger admins and for the service-role / SQL-editor
  -- operator context — the daily auto-confirm sweep (GVM-213) runs there.
  if not public.is_ledger_admin(new.ledger_id) and not public.is_operator_context() then
    -- Only the recipient may (re-)request payment. A dispute is the recipient
    -- sending a paid_pending debt back to 'requested', so the same rule covers it.
    if coalesce(new.status, 'open') = 'requested'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'requested')
       and actor_member_id is distinct from new.to_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    -- Only the payer may claim a payment as made (requested -> paid_pending).
    if coalesce(new.status, 'open') = 'paid_pending'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'paid_pending')
       and actor_member_id is distinct from new.from_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;

    -- Reaching 'paid': from paid_pending only the recipient may confirm; a direct
    -- requested -> paid (legacy / admin) stays payer-only.
    if coalesce(new.status, 'open') = 'paid'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'paid') then
      if tg_op = 'UPDATE' and coalesce(old.status, 'open') = 'paid_pending' then
        if actor_member_id is distinct from new.to_member_id then
          raise exception 'Only the payment recipient can confirm this payment' using errcode = '42501';
        end if;
      elsif actor_member_id is distinct from new.from_member_id then
        raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
      end if;
    end if;
  end if;

  if new.status = 'requested' then
    new.requested_at := coalesce(new.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, actor_member_id, new.to_member_id);
    new.paid_at := null;
    new.paid_claimed_at := null;
  elsif new.status = 'paid_pending' then
    new.requested_at := coalesce(new.requested_at, old.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, old.requested_by_member_id, new.to_member_id);
    new.paid_claimed_at := coalesce(new.paid_claimed_at, now());
    new.paid_at := null;
  elsif new.status = 'paid' then
    new.requested_at := coalesce(new.requested_at, old.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, old.requested_by_member_id, new.to_member_id);
    new.paid_at := coalesce(new.paid_at, now());
  elsif new.status in ('open', 'cancelled') then
    new.requested_at := null;
    new.requested_by_member_id := null;
    new.paid_at := null;
    new.paid_claimed_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_settlement_request_integrity_trigger on public.settlement_requests;
create trigger enforce_settlement_request_integrity_trigger
before insert or update of ledger_id, period_id, from_member_id, to_member_id, amount, status, requested_at, paid_at, requested_by_member_id, paid_claimed_at
on public.settlement_requests
for each row execute function public.enforce_settlement_request_integrity();

-- ── Period lock: a paid_pending request still locks the open period ─────────

create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;

  -- Entries created through the trip/fuel RPCs always carry the open period id.
  -- Fall back to the ledger's open period for any row that has none.
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;

  if v_period_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid', 'paid_pending')
  );
end;
$$;

-- ── upsert_settlement_request_status: speak paid_pending / confirm / dispute ─
--
-- Re-declared off migration 089. The mobile client keeps ONE entry point: the
-- debtor sends 'paid_pending', the creditor sends 'paid' (confirm) or 'requested'
-- (dispute, detected because the row was paid_pending). The integrity trigger
-- enforces who may do which; here we just validate, transition, and log the
-- right event so the other member's client syncs live (GVM-247).

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
  prev_status_value text := null;
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

  if normalized_status not in ('open', 'requested', 'paid', 'paid_pending', 'cancelled') then
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

  -- Require an existing, non-cancelled request before claiming or confirming a
  -- payment (GVM-241, extended to paid_pending in GVM-213). Without this the
  -- pair upsert's on-conflict misses for a stale/foreign-period request and
  -- INSERTs a fresh row directly at a settled-ish status, which trips the 003
  -- trigger guard with the cryptic 'Request the payment before marking it paid'.
  -- Raise a clean, mappable error instead.
  if normalized_status in ('paid', 'paid_pending') then
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
  -- ON CONFLICT resolves to DO UPDATE — so an upsert to a settled status trips
  -- the trigger's INSERT guard even when a matching request exists (GVM-241).
  -- An explicit UPDATE fires BEFORE UPDATE, where the guard validates the
  -- transition as legal. Genuinely new rows still INSERT (open period only — a
  -- closed period was guaranteed an existing request above). prev_status drives
  -- the dispute event below (a paid_pending row sent back to 'requested').
  select sr.id, sr.status into saved_request_id, prev_status_value
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
  -- refetches immediately, and the change lands in the activity feed. The
  -- two-step confirmation (GVM-213) adds payment_claimed (debtor marked paid,
  -- awaiting confirmation) and payment_disputed (recipient sent a paid_pending
  -- debt back to 'requested'); payment_paid now means confirmed/received.
  event_type_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' then 'payment_disputed'
    when normalized_status = 'requested' then 'payment_requested'
    when normalized_status = 'paid_pending' then 'payment_claimed'
    when normalized_status = 'paid' then 'payment_paid'
    else 'settlement_' || normalized_status
  end;
  event_title_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' then 'Betaling afvist'
    when normalized_status = 'requested' then 'Betaling anmodet'
    when normalized_status = 'paid_pending' then 'Afventer bekræftelse'
    when normalized_status = 'paid' then 'Betaling bekræftet'
    when normalized_status = 'cancelled' then 'Betaling annulleret'
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

-- ── Auto-confirm sweep: finalize paid_pending the recipient never disputed ──
--
-- Called daily by the scheduler (service role). Any paid_pending settlement
-- whose claim is older than the grace window (default 72h = 3 days) and hasn't
-- been disputed flips to paid. Runs in the operator context, so the integrity
-- trigger's recipient-only confirm gate is bypassed. Not granted to clients.

create or replace function public.claim_due_settlement_confirmations(
  p_max_age_hours integer default 72,
  p_limit integer default 200
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  confirmed_count integer := 0;
  r record;
begin
  for r in
    select sr.id, sr.ledger_id, sr.from_member_id, sr.to_member_id, sr.amount
    from public.settlement_requests sr
    where sr.status = 'paid_pending'
      and sr.paid_claimed_at is not null
      and sr.paid_claimed_at < now() - make_interval(hours => greatest(p_max_age_hours, 1))
    order by sr.paid_claimed_at asc
    limit greatest(p_limit, 1)
    for update skip locked
  loop
    update public.settlement_requests
       set status = 'paid',
           paid_at = now(),
           updated_at = now()
     where id = r.id;

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      r.ledger_id, 'payment_paid', 'Betaling bekræftet automatisk', '',
      null, null,
      jsonb_build_object(
        'settlement_request_id', r.id,
        'from_member_id', r.from_member_id,
        'to_member_id', r.to_member_id,
        'amount', r.amount,
        'auto_confirmed', true
      )
    );

    confirmed_count := confirmed_count + 1;
  end loop;

  return confirmed_count;
end;
$$;

revoke execute on function public.claim_due_settlement_confirmations(integer, integer) from public;
revoke execute on function public.claim_due_settlement_confirmations(integer, integer) from anon;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('090_settlement_paid_pending',
        'Two-step settlement confirmation (GVM-213): new paid_pending status + paid_claimed_at. Debtor mark-paid → paid_pending; recipient confirms → paid or disputes → requested; unreviewed claims auto-confirm after ~3 days via claim_due_settlement_confirmations (service role). Extends the transition validator + integrity trigger (with an operator-context bypass for the sweep), teaches settlement_entry_is_locked that paid_pending locks the period, and re-declares upsert_settlement_request_status off 089 to log payment_claimed / payment_disputed and treat payment_paid as confirmed.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 115: payment evidence notes on the paid_pending/dispute lifecycle (GV-279, GVM-331)
--
-- P2P settlements are manual (MobilePay deep-link + Mark paid + reminders), so the
-- only trace that money actually moved is what the two parties say. This adds a
-- lightweight evidence trail without touching the money math:
--
--   * settlement_requests gains paid_note + dispute_note (text, ≤ 280 chars each).
--   * upsert_settlement_request_status gains a trailing p_note param (defaulted, so
--     older clients that never pass it keep working):
--       - the DEBTOR claiming payment (-> paid_pending) may attach an optional note
--         (e.g. a MobilePay reference) → written to paid_note.
--       - the CREDITOR disputing a claim (paid_pending -> requested) attaches a short
--         required reason → written to dispute_note.
--       - every other transition, and any other actor, ignores p_note.
--   * Both notes are IMMUTABLE once set: a repeat transition never overwrites an
--     existing note (coalesce keep-existing). The note is echoed into the
--     ledger_events metadata 'note' key so the feed and push can surface it.
--
-- upsert_settlement_request_status is re-declared off migration 104 (the newest
-- prior definition) with the SAME body plus the note handling; the signature grows
-- one defaulted trailing param, so the old 8-arg function is dropped and the 9-arg
-- one replaces it (a single function, no ambiguous overload). The mark-paid
-- discipline is unchanged: status transitions UPDATE the existing row — a BEFORE
-- INSERT trigger rejects non-open inserts (GVM-241).

-- ── settlement_requests: paid_note + dispute_note (≤ 280 chars) ──────────────
alter table public.settlement_requests
  add column if not exists paid_note text,
  add column if not exists dispute_note text;

alter table public.settlement_requests
  drop constraint if exists settlement_requests_paid_note_len,
  add constraint settlement_requests_paid_note_len
    check (paid_note is null or char_length(paid_note) <= 280);

alter table public.settlement_requests
  drop constraint if exists settlement_requests_dispute_note_len,
  add constraint settlement_requests_dispute_note_len
    check (dispute_note is null or char_length(dispute_note) <= 280);

-- ── upsert_settlement_request_status (off 104) + p_note ──────────────────────
-- current_pair_keys stays DEPRECATED and IGNORED (server-side sweep, GV-259). The
-- new trailing p_note is optional: only the debtor's paid_pending claim and the
-- creditor's dispute persist it, both immutably.
drop function if exists public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]);
create or replace function public.upsert_settlement_request_status(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  next_status text,
  current_pair_keys text[] default array[]::text[],
  p_note text default null
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
  prev_amount_value numeric := null;
  prev_currency_value text := null;
  prev_paid_note text := null;
  prev_dispute_note text := null;
  final_paid_note text := null;
  final_dispute_note text := null;
  event_note_value text := null;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_status text := coalesce(nullif(next_status, ''), 'open');
  normalized_note text := nullif(btrim(p_note), '');
  event_type_value text;
  event_title_value text;
  period_is_open boolean;
  computed_settlement jsonb;
  valid_pair_keys text[] := array[]::text[];
  debtor_ids uuid[];
  debtor_amts numeric[];
  creditor_ids uuid[];
  creditor_amts numeric[];
  di integer := 1;
  ci integer := 1;
  pair_amount numeric;
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

  -- GV-244: a settlement request may only be created or transitioned by one of
  -- its two parties or a ledger admin. Without this any signed-in member could
  -- drive a request between two OTHER members (incl. marking it paid) through
  -- this SECURITY DEFINER RPC, bypassing the party-or-admin table RLS.
  if actor_member_id not in (payer_member_id, recipient_member_id)
    and not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only the payer, recipient, or a ledger admin can save this settlement request' using errcode = '42501';
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
  select sr.id, sr.status, sr.amount, sr.currency, sr.paid_note, sr.dispute_note
    into saved_request_id, prev_status_value, prev_amount_value, prev_currency_value, prev_paid_note, prev_dispute_note
  from public.settlement_requests sr
  where sr.period_id = target_open_period_id
    and sr.from_member_id = payer_member_id
    and sr.to_member_id = recipient_member_id
    and sr.status <> 'cancelled'
  for update;

  -- GV-259: amount + currency are IMMUTABLE once a request has left 'open'. The
  -- single permitted adjustment is the creditor (recipient) or a ledger admin
  -- re-requesting a still-live 'requested' row when balances shift (the mobile
  -- re-request flow). Every other transition — anything touching
  -- paid_pending/paid/cancelled, or the payer acting — must carry the stored
  -- amount + currency unchanged, so a claimed/settled figure can never be
  -- rewritten under a status change. Creation ('open' or no row) sets the amount
  -- freely and is skipped here.
  if saved_request_id is not null and prev_status_value <> 'open' then
    if normalized_status = 'requested'
       and (actor_member_id = recipient_member_id
            or public.is_ledger_admin(target_ledger_id)) then
      null; -- creditor/admin may re-request a live request at a new amount
    elsif amount_value = prev_amount_value
          and coalesce(nullif(currency_value, ''), 'DKK') = prev_currency_value then
      null; -- amount + currency preserved
    else
      raise exception 'Settlement request amount is locked during status transitions' using errcode = '23514';
    end if;
  end if;

  -- GV-279: payment evidence notes. Only two transitions persist a note, and each
  -- is IMMUTABLE once set (a repeat call keeps the existing note via coalesce):
  --   * the DEBTOR (payer) claiming payment → paid_pending writes paid_note;
  --   * the CREDITOR (recipient) disputing a claim (paid_pending → requested)
  --     writes dispute_note.
  -- Every other transition, and any other actor, leaves both notes untouched.
  final_paid_note := prev_paid_note;
  final_dispute_note := prev_dispute_note;
  if normalized_status = 'paid_pending' and actor_member_id = payer_member_id then
    final_paid_note := coalesce(prev_paid_note, normalized_note);
  elsif normalized_status = 'requested'
        and prev_status_value = 'paid_pending'
        and actor_member_id = recipient_member_id then
    final_dispute_note := coalesce(prev_dispute_note, normalized_note);
  end if;
  event_note_value := case
    when normalized_status = 'paid_pending' and actor_member_id = payer_member_id then final_paid_note
    when normalized_status = 'requested'
         and prev_status_value = 'paid_pending'
         and actor_member_id = recipient_member_id then final_dispute_note
    else null
  end;

  if saved_request_id is not null then
    update public.settlement_requests
       set amount = amount_value,
           currency = coalesce(nullif(currency_value, ''), 'DKK'),
           status = normalized_status,
           requested_at = requested_at_value,
           requested_by_member_id = requested_by_value,
           paid_at = paid_at_value,
           paid_note = final_paid_note,
           dispute_note = final_dispute_note,
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
      paid_note,
      dispute_note,
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
      final_paid_note,
      final_dispute_note,
      now()
    )
    returning id into saved_request_id;
  else
    raise exception 'No active settlement request for this pair in the closed period' using errcode = '22023';
  end if;

  -- GV-259: cancel stale requests whose pair is no longer part of the live
  -- settlement. The set of valid pairs is computed SERVER-SIDE (current_pair_keys
  -- is ignored): calculate_period_settlement returns each member's net, and the
  -- valid (debtor -> creditor) pairs are derived from those nets with the same
  -- greedy min-cash-flow the client uses (settlement-calc.ts / buildSettlements).
  -- Open-period only, as before: a closed period's settlements are frozen. Only
  -- 'open'/'requested' rows are swept — a paid_pending/paid row is money already
  -- claimed or moved (history, not staleness) and is never cancelled here.
  if period_is_open then
    computed_settlement := public.calculate_period_settlement(target_ledger_id, target_open_period_id);

    -- Debtors carry net < 0 (owe money), creditors net > 0 (are owed). Each side
    -- is ordered by magnitude descending, matching the client's debtor/creditor
    -- sort; ties break on id for a deterministic server result. Amounts round to
    -- 2 dp (nets are already 2 dp; round is a defensive no-op).
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

    -- Greedy min-cash-flow pairing (mirrors buildSettlements): match the largest
    -- debtor against the largest creditor, emit a 'fromId->toId' key when the
    -- matched amount rounds > 0, then advance whichever side is exhausted. Every
    -- matched amount is <= 0.005 => index advances, so the loop always terminates.
    while di <= coalesce(array_length(debtor_ids, 1), 0)
          and ci <= coalesce(array_length(creditor_ids, 1), 0) loop
      pair_amount := round(least(debtor_amts[di], creditor_amts[ci]), 2);
      if pair_amount > 0 then
        valid_pair_keys := valid_pair_keys
          || (debtor_ids[di]::text || '->' || creditor_ids[ci]::text);
      end if;
      debtor_amts[di] := round(debtor_amts[di] - pair_amount, 2);
      creditor_amts[ci] := round(creditor_amts[ci] - pair_amount, 2);
      if debtor_amts[di] <= 0.005 then di := di + 1; end if;
      if creditor_amts[ci] <= 0.005 then ci := ci + 1; end if;
    end loop;

    update public.settlement_requests sr
       set status = 'cancelled',
           updated_at = now(),
           requested_at = null,
           requested_by_member_id = null,
           paid_at = null
     where sr.ledger_id = target_ledger_id
       and sr.period_id = target_open_period_id
       and sr.status in ('open', 'requested')
       and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(valid_pair_keys));
    get diagnostics cancelled_count = row_count;
  end if;

  -- Activity feed + realtime nudge (GVM-247): every status change writes a
  -- ledger_events row so the other member's client (subscribed to ledger_events)
  -- refetches immediately, and the change lands in the activity feed. The
  -- two-step confirmation (GVM-213) adds payment_claimed (debtor marked paid,
  -- awaiting confirmation) and payment_disputed (recipient sent a paid_pending
  -- debt back to 'requested'); payment_paid now means confirmed/received. GV-279
  -- carries the evidence note (paid_note on a claim, dispute_note on a dispute)
  -- in metadata 'note' so the feed and push can surface it.
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
      'amount', amount_value,
      'note', event_note_value
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

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[], text) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[], text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('115_payment_evidence_notes',
        'Payment evidence notes (GV-279, GVM-331). settlement_requests gains paid_note + dispute_note (text, ≤ 280 chars, CHECK-guarded). upsert_settlement_request_status re-declared off 104 (old 8-arg dropped, replaced by a 9-arg function) with a trailing p_note text default null: the debtor''s paid_pending claim writes paid_note, the creditor''s dispute (paid_pending -> requested) writes dispute_note, every other transition/actor ignores it; both notes are immutable once set (coalesce keep-existing) and echoed into ledger_events metadata ''note''. Status transitions still UPDATE the existing row (BEFORE INSERT trigger rejects non-open inserts).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

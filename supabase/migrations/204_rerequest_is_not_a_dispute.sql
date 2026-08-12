-- Migration 204: a re-request is not a dispute (GV-487)
--
-- THE MISNOMER. public.upsert_settlement_request_status announces every
-- paid_pending -> requested transition as event_type 'payment_disputed', titled
-- "Betaling afvist" — your payment was rejected. That was defensible while the
-- transition had exactly one meaning. It no longer does.
--
-- TWO ACTIONS, ONE STATUS EDGE.
--
--   * DISPUTE. The creditor rejects a payment claim: mobile's "Afvis", with a
--     required reason that lands in dispute_note (migration 115). Somebody is
--     saying the money did not arrive.
--   * RE-REQUEST. The creditor, or a ledger admin, asks again — at the same
--     amount or a NEW one — because the balances moved underneath the claim.
--     GV-259 has always permitted this (migration 104, re-declared in 115);
--     migration 203 removed the trigger that was refusing the changed-amount half
--     of it; GVM-589 is putting a button on it. Nobody rejected anything.
--
-- WHY IT MATTERS NOW rather than as a tidy-up: the moment that CTA ships, pressing
-- "ask again" pushes "Betaling afvist" at the other member. Telling somebody their
-- payment was rejected when it was not is the kind of false statement that starts
-- an argument between two people about money, and the feed row is retained and
-- unretractable.
--
-- THE DISCRIMINATOR IS THE COMMAND, BECAUSE IT CANNOT BE THE ROW. Dispute and
-- re-request share the pair, the status edge, and the actor — the CREDITOR drives
-- both (the debtor claims; the creditor confirms, rejects, or asks again) — and
-- they share the amount too whenever the re-request is at an unchanged figure. The
-- difference is intent, reject versus ask again, and intent lives in the command
-- the client invoked:
--
--   * public.transition_settlement_request_status (migration 122) is the by-id
--     lifecycle command. It is what "Afvis" calls, and it re-sends the STORED
--     amount, so it cannot be a re-price. It now sets a transaction-local flag
--     around its delegate call — the govehlo.pii_scrub convention from migrations
--     131/176 — and every genuine dispute therefore emits exactly what it emitted
--     before this migration, down to the title and the note in metadata.
--   * A direct call to the pair-keyed upsert RPC is a create or a re-request. It
--     is the only path that can carry a new amount, so it is the path the mobile
--     re-request CTA must use.
--
-- WHAT A RE-REQUEST EMITS INSTEAD: payment_requested / "Betaling anmodet" — an
-- EXISTING, already feed-classified type, not a new one. It is the honest answer
-- (the same CASE already says payment_requested for a re-request made from
-- 'requested' or 'open', so this makes the branch consistent rather than special),
-- and it keeps the row actionable: govehlo-mobile emits the role-aware Pay /
-- Remind button only for event_type = 'payment_requested', so the debtor gets
-- "Betal 52,00 kr →" at the updated amount instead of a dead line of text. No new
-- event_type means nothing to classify under GV-413, no EVENT_TYPE_EXCLUDE append,
-- and no order-sensitive mobile gateway change.
--
-- THE HISTORY ROW IS FIXED WITH IT. public.record_settlement_request_event
-- (migration 137) labels the same transition 'disputed', and that table is not an
-- internal audit trail: mobile reads it back as the per-request "Betalingsforløb"
-- and renders 'disputed' as "Betaling afvist". Fixing the feed alone would leave
-- the two accounts of one transition contradicting each other in front of the same
-- two people. A re-request now records 'requested' with from_status 'paid_pending'
-- — a label the client already renders — so no client changes for this either.
--
-- Each function is re-declared off its NEWEST prior definition per the GV-202 rule:
-- upsert_settlement_request_status off 115 (ancestry 022 -> 054 -> 084 -> 085 ->
-- 086 -> 087 -> 089 -> 090 -> 103 -> 104 -> 115; verified nothing in 116..203
-- re-declares it), transition_settlement_request_status off 122 and
-- record_settlement_request_event off 137 (each declared exactly once, verified).
-- No signature moves, so types/database.ts changes only by its generation stamp.

-- ── upsert_settlement_request_status (off 115): the feed writer ──────────────
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
  -- GV-487: true when this write arrived through public.transition_settlement_request_status
  -- (migration 122), the by-id lifecycle command. See the event block at the bottom.
  dispute_command boolean := coalesce(current_setting('govehlo.settlement_lifecycle_command', true), '') = '1';
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
  --
  -- GV-487: paid_pending -> requested is TWO different actions wearing one status
  -- transition, and until now both were announced as the first one.
  --
  --   * DISPUTE — the creditor rejects a payment claim ("Afvis", with a required
  --     reason). Nothing about it changes here: it still writes payment_disputed /
  --     "Betaling afvist", and it still carries dispute_note in metadata 'note'.
  --   * RE-REQUEST — the creditor (or a ledger admin) asks again, at the same or a
  --     NEW amount, because the balances moved underneath the claim. Migration 203
  --     made that write legal; GVM-589 puts a button on it. Telling the debtor
  --     "Betaling afvist" — that their payment was rejected — when nobody rejected
  --     anything is simply false, and it is the kind of false that starts an
  --     argument between two people about money.
  --
  -- The two are indistinguishable from the ROW: same pair, same status edge, same
  -- actor (the creditor drives both; see the note logic above), and same amount
  -- whenever the re-request is at an unchanged figure. What separates them is not
  -- state but INTENT — reject versus ask again — so it has to be carried by the
  -- COMMAND the client invoked, and that is exactly what dispute_command reads:
  --
  --   * public.transition_settlement_request_status (migration 122), the by-id
  --     lifecycle command, sets govehlo.settlement_lifecycle_command for the
  --     transaction before delegating here. That is the only path a dispute takes
  --     — mobile's "Afvis" goes through it, and it cannot re-price a claim anyway
  --     because it re-sends the STORED amount — so every genuine dispute keeps
  --     emitting precisely what it emits today.
  --   * A direct call to this pair-keyed RPC is a create or a re-request. It is
  --     the only path that can carry a new amount, so it is the path GVM-589's
  --     re-request CTA must use, and it now announces itself as what it is.
  --
  -- The re-request is NOT given a new event type. It reuses payment_requested,
  -- because that is what it is: this same CASE already answers payment_requested
  -- for a re-request made from 'requested' or from 'open', so keying the answer on
  -- the intent instead of on the previous status is what makes the branch
  -- consistent rather than what makes it special. It also keeps the row ACTIONABLE
  -- — govehlo-mobile's feed emits the role-aware Pay / Remind button only for
  -- event_type = 'payment_requested' — so the debtor whose claim was sent back at
  -- an updated figure gets "Betal 52,00 kr →" instead of a dead line of text, and
  -- no client, exclusion list or feed classification has to move for it.
  --
  -- Exactly one ledger_events row is still written on every call, on every path
  -- (migration 087): only the type and title move, never the insert.
  event_type_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' and dispute_command then 'payment_disputed'
    when normalized_status = 'requested' then 'payment_requested'
    when normalized_status = 'paid_pending' then 'payment_claimed'
    when normalized_status = 'paid' then 'payment_paid'
    else 'settlement_' || normalized_status
  end;
  event_title_value := case
    when normalized_status = 'requested' and prev_status_value = 'paid_pending' and dispute_command then 'Betaling afvist'
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

-- ── transition_settlement_request_status (off 122): declares the intent ──────
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
    -- GV-487: announce WHICH command is driving the write. paid_pending -> requested
    -- is both "the creditor rejects this claim" (this command, from mobile's "Afvis")
    -- and "the creditor asks again at a possibly new amount" (a direct call to the
    -- pair-keyed RPC, which is the only path that can carry a new amount) — and the
    -- two are indistinguishable from the row itself. The flag is transaction-local
    -- (the govehlo.pii_scrub convention from migrations 131/176), set immediately
    -- before the delegate call and cleared immediately after, so it describes one
    -- delegate call and never leaks to a later statement in the same transaction;
    -- a batch loop re-sets it per request. It is read by
    -- upsert_settlement_request_status (ledger_events) and by
    -- record_settlement_request_event (the settlement_request_events history), so
    -- both accounts of the same transition tell the same story.
    perform set_config('govehlo.settlement_lifecycle_command', '1', true);
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
    perform set_config('govehlo.settlement_lifecycle_command', '', true);

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

-- ── record_settlement_request_event (off 137): the per-request history ───────
create or replace function public.record_settlement_request_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_actor_member_id uuid;
  -- GV-487: set for the transaction by public.transition_settlement_request_status
  -- (migration 122) around its delegate call. See the paid_pending branch below.
  dispute_command boolean := coalesce(current_setting('govehlo.settlement_lifecycle_command', true), '') = '1';
begin
  safe_actor_member_id := public.current_ledger_member_id(new.ledger_id);

  if tg_op = 'INSERT' then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'calculated', null, 'open',
      safe_actor_member_id, new.created_at
    );

    if new.status = 'requested' and new.requested_at is not null then
      insert into public.settlement_request_events (
        settlement_request_id, ledger_id, event_type, from_status, to_status,
        actor_member_id, occurred_at
      ) values (
        new.id, new.ledger_id, 'requested', 'open', 'requested',
        coalesce(safe_actor_member_id, new.requested_by_member_id), new.requested_at
      );
    end if;

    return new;
  end if;

  -- GV-487: this history is not an internal audit trail — govehlo-mobile reads it
  -- back as the per-request "Betalingsforløb", where 'disputed' is rendered as
  -- "Betaling afvist". So the misnomer this migration removes from the activity feed
  -- lives on this row too, in front of the same two people, and fixing one without
  -- the other would leave the two accounts of one transition contradicting each
  -- other. Same discriminator as the feed writer, for the same reason: only the by-id
  -- lifecycle command (migration 122) can be a dispute, because it is the only one
  -- mobile's "Afvis" uses and the only one that cannot re-price the claim. A
  -- re-request falls through to the branch below and is recorded as 'requested',
  -- with from_status 'paid_pending' preserving what it was re-requested FROM — a
  -- label the client already renders as "Betalingsanmodning sendt", so nothing has
  -- to change in any client and no new event_type enters this table.
  if old.status = 'paid_pending' and new.status = 'requested' and dispute_command then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'disputed', old.status, new.status,
      safe_actor_member_id, now()
    );
  elsif new.status = 'requested'
        and (old.status is distinct from new.status or old.requested_at is distinct from new.requested_at) then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'requested', old.status, new.status,
      coalesce(safe_actor_member_id, new.requested_by_member_id), coalesce(new.requested_at, now())
    );
  elsif old.status is distinct from new.status then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id,
      new.ledger_id,
      case new.status
        when 'paid_pending' then 'marked_paid'
        when 'paid' then 'confirmed'
        when 'cancelled' then 'cancelled'
        when 'open' then 'reopened'
      end,
      old.status,
      new.status,
      safe_actor_member_id,
      case new.status
        when 'paid_pending' then coalesce(new.paid_claimed_at, now())
        when 'paid' then coalesce(new.paid_at, now())
        else now()
      end
    );
  end if;

  if new.reminder_count > old.reminder_count
     and new.last_reminder_at is distinct from old.last_reminder_at then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, reminder_number, occurred_at
    ) values (
      new.id, new.ledger_id, 'payment_reminder_sent', new.status, new.status,
      null, new.reminder_count, coalesce(new.last_reminder_at, now())
    );
  end if;

  if new.last_confirm_reminder_at is distinct from old.last_confirm_reminder_at
     and new.last_confirm_reminder_at is not null then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'confirmation_reminder_sent', new.status, new.status,
      null, new.last_confirm_reminder_at
    );
  end if;

  return new;
end;
$$;

revoke all on function public.record_settlement_request_event() from public;
revoke all on function public.record_settlement_request_event() from anon;
revoke all on function public.record_settlement_request_event() from authenticated;
revoke all on function public.record_settlement_request_event() from service_role;

drop trigger if exists record_settlement_request_event_trigger
  on public.settlement_requests;
create trigger record_settlement_request_event_trigger
after insert or update on public.settlement_requests
for each row execute function public.record_settlement_request_event();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '204_rerequest_is_not_a_dispute',
  'A re-request is not a dispute (GV-487). public.upsert_settlement_request_status announced EVERY paid_pending -> requested transition as event_type ''payment_disputed'' titled "Betaling afvist" — your payment was rejected — which was defensible only while that status edge carried exactly one meaning. It carries two. A DISPUTE is the creditor rejecting a payment claim (mobile''s "Afvis", with a required reason that migration 115 stores in dispute_note). A RE-REQUEST is the creditor, or a ledger admin, asking again at the same or a NEW amount because the balances moved underneath the claim — permitted since GV-259 (migration 104, re-declared in 115), unblocked for the changed-amount half by migration 203, and about to get a button in GVM-589. Nobody rejected anything, and the moment that CTA ships, pressing "ask again" would push "Betaling afvist" at the other member: a false statement about money, in a retained and unretractable feed row, between two people who have to keep sharing a car. THE DISCRIMINATOR IS THE COMMAND, BECAUSE IT CANNOT BE THE ROW: dispute and re-request share the pair, the status edge and the actor (the creditor drives both — the debtor claims, the creditor confirms, rejects or asks again), and they share the amount too whenever the re-request is at an unchanged figure, so no predicate over the row can separate them. What separates them is intent — reject versus ask again — which lives in the command the client invoked. public.transition_settlement_request_status (migration 122), the by-id lifecycle command, is what "Afvis" calls and it re-sends the STORED amount so it can never be a re-price; it is re-declared here to set the transaction-local govehlo.settlement_lifecycle_command around its delegate call (the govehlo.pii_scrub convention from migrations 131/176 — set immediately before, cleared immediately after, re-set per request by the batch loop, never leaking to a later statement). A direct call to the pair-keyed upsert RPC is a create or a re-request, and is the only path that can carry a new amount, so it is the path the mobile re-request CTA must use. NET EFFECT ON THE FEED, stated exhaustively: ONE case moves — a paid_pending -> requested driven by a direct pair-keyed call now emits payment_requested / "Betaling anmodet" instead of payment_disputed / "Betaling afvist", at the same amount or a changed one. Every genuine dispute, arriving through the by-id command, emits exactly what it emitted before: payment_disputed, "Betaling afvist", dispute_note carried in metadata ''note''. Every other transition (claim, confirm, cancel, reopen, plain re-request, reminder re-stamp) is untouched. NO NEW EVENT TYPE: the re-request reuses payment_requested, which is the honest answer rather than the convenient one — this same CASE already answers payment_requested for a re-request made from ''requested'' or from ''open'', so keying on intent instead of on the previous status makes the branch consistent rather than special — and it keeps the row ACTIONABLE, because govehlo-mobile''s feed emits the role-aware Pay / Remind button only for event_type = ''payment_requested'', so the debtor whose claim was sent back at an updated figure gets "Betal 52,00 kr →" instead of a dead line of text. Nothing to classify under GV-413, no EVENT_TYPE_EXCLUDE append, and no order-sensitive mobile gateway change. Exactly one ledger_events row is still written on every call and every path (the migration 087 live-sync contract): only the type and title move, never the insert. THE HISTORY ROW IS FIXED WITH IT: public.record_settlement_request_event (migration 137) labels the same transition ''disputed'', and settlement_request_events is NOT an internal audit table — govehlo-mobile reads it back as the per-request "Betalingsforløb" and renders ''disputed'' as "Betaling afvist", so fixing only the feed would leave the two accounts of one transition contradicting each other in front of the same two people. It is re-declared off 137 with the same discriminator; a re-request falls through to the existing branch and is recorded as ''requested'' with from_status ''paid_pending'' preserving what it was re-requested FROM, a label mobile already renders as "Betalingsanmodning sendt", so no client changes and no new event_type enters that table either. Each function is re-declared off its NEWEST prior definition per the GV-202 rule: upsert_settlement_request_status off 115 (ancestry 022 -> 054 -> 084 -> 085 -> 086 -> 087 -> 089 -> 090 -> 103 -> 104 -> 115, with 116..203 verified clean), transition_settlement_request_status off 122 and record_settlement_request_event off 137, each declared exactly once. No signature moves, so types/database.ts changes only by its generation stamp and the two client repos need only the mechanical re-vendor. Guarded by tools/test-rerequest-event-contract.mjs against a real Postgres replay of the consolidated schema: a debtor claim still emits payment_claimed, a creditor dispute through the by-id command still emits payment_disputed / "Betaling afvist" with its reason and still records ''disputed'' in the history, a same-amount re-request and a changed-amount re-request through the pair-keyed RPC both emit payment_requested / "Betaling anmodet" and record ''requested'', every one of those calls writes EXACTLY ONE ledger_events row, and the flag does not leak from a dispute to a later re-request in the same session.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 104: settlement amount integrity + server-side pair sweep (GV-259, GV-260)
--
-- Codex lead review 2026-07-10; verified against code. Two re-declarations, no
-- schema/table change.
--
-- GV-259 — upsert_settlement_request_status, re-declared off migration 103 (the
--   newest prior definition), signature byte-identical. Two changes:
--     A. Amount + currency immutability. Once a request has left 'open', its
--        amount/currency can only change on a creditor/admin re-request of a
--        still-live 'requested' row (the mobile re-request-on-drift flow). Every
--        other transition (paid_pending/paid/cancelled, or the payer acting)
--        must preserve the stored amount, so a claimed/settled figure can't be
--        rewritten under a status change (raises 23514 otherwise).
--     B. Server-side stale-pair sweep. The old sweep trusted the client's
--        current_pair_keys; that parameter is now DEPRECATED and IGNORED. The
--        RPC computes the valid pairs itself from calculate_period_settlement's
--        per-member nets (same greedy min-cash-flow as the client's
--        buildSettlements) and sweeps against that. Tightened further to only
--        cancel 'open'/'requested' rows — never paid_pending/paid (money already
--        claimed/moved is history, not staleness). Open-period only, as before.
--
--   NOTE / discrepancy vs the ticket text: calculate_period_settlement (newest
--   def migration 070) returns per-member `people[].net`, NOT a ready-made
--   `settlements` array — the debtor->creditor pairs are derived from nets by the
--   client. This migration therefore ports that greedy pairing into the RPC to
--   build the valid-pair set, which is the ticket's intent ("compute the truth
--   inside the RPC").
--
-- GV-260 — close_settlement_period, re-declared off migration 101 (newest). The
--   require-requests-before-close coverage check now also requires each pair's
--   request to be at its CURRENT amount (sr.amount = round(snapshot amount, 2)),
--   so a stale request left at an old amount no longer satisfies the gate. The
--   operator message is updated to say so. Nothing else changes.

-- ── GV-259: upsert_settlement_request_status (off 103) ──────────────────────
-- current_pair_keys (the trailing parameter) is DEPRECATED and IGNORED as of this
-- migration: the stale-pair sweep now derives the valid settlement pairs
-- SERVER-SIDE from calculate_period_settlement. The parameter is kept in the
-- signature (byte-identical) so existing PostgREST callers that still pass it do
-- not break.
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
  prev_amount_value numeric := null;
  prev_currency_value text := null;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_status text := coalesce(nullif(next_status, ''), 'open');
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
  select sr.id, sr.status, sr.amount, sr.currency
    into saved_request_id, prev_status_value, prev_amount_value, prev_currency_value
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

-- ── GV-260: close_settlement_period (off 101) ──────────────────────────────
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
  actor_member_id uuid;
  snapshot_fingerprint text;
  server_fingerprint text;
  computed jsonb;
  computed_person jsonb;
  snapshot_person jsonb;
  snapshot_flow numeric;
  duplicate_period_id uuid;
  closed_period_id uuid;
  new_open_period_id uuid;
  requested_closed_at timestamptz;
  lock_acquired boolean;
  v_rule_require_requests boolean;
  v_settlement jsonb;
  v_missing_settlements integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if period_snapshot is null or jsonb_typeof(period_snapshot) <> 'object' then
    raise exception 'Period snapshot must be a JSON object' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can close settlement periods' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Guard before taking the advisory lock. Older frontend builds and health probes
  -- may call this RPC with a fake or already-closed period id. Reject those
  -- immediately so they cannot queue behind the lock and burn database CPU.
  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  lock_acquired := pg_try_advisory_xact_lock(hashtext(target_ledger_id));
  if lock_acquired is not true then
    raise exception 'Another settlement close is already in progress for this ledger' using errcode = '55P03';
  end if;

  -- ── Integrity gate (GVM-112) ──────────────────────────────────────────────
  -- (a) Entry set: the snapshot's fingerprint must equal the one recomputed
  -- from the live rows. In-flight writers hold FOR SHARE on the period row, so
  -- by the time this runs the row set is stable for the transaction.
  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  server_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, target_period_id);

  if snapshot_fingerprint is not null and snapshot_fingerprint <> server_fingerprint then
    raise exception 'Entries changed since this close was prepared. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  -- (b) Amounts: per-member figures within 0.02 kr, totals within 0.05 kr.
  computed := public.calculate_period_settlement(target_ledger_id, target_period_id);

  if abs(coalesce((period_snapshot->>'totalKm')::numeric, 0) - (computed->>'totalKm')::numeric) > 0.05
     or abs(coalesce((period_snapshot->>'totalPaid')::numeric, 0) - (computed->>'totalPaid')::numeric) > 0.05 then
    raise exception 'Snapshot totals do not match the server calculation. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  for computed_person in
    select value from jsonb_array_elements(computed->'people')
  loop
    select p.value
      into snapshot_person
      from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb)) as p(value)
      where p.value->>'id' = computed_person->>'id'
      limit 1;

    if abs(coalesce((snapshot_person->>'km')::numeric, 0) - (computed_person->>'km')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'fuelPaid')::numeric, 0) - (computed_person->>'fuelPaid')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'net')::numeric, 0) - (computed_person->>'net')::numeric) > 0.02 then
      raise exception 'Snapshot member amounts do not match the server calculation. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;

    -- (c) The archived settlements must actually move each member's net:
    -- outflow - inflow ~= -net for every member.
    select coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'fromId' = computed_person->>'id'), 0)
         - coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'toId' = computed_person->>'id'), 0)
      into snapshot_flow
      from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb)) as s(value);

    if abs(snapshot_flow + (computed_person->>'net')::numeric) > 0.05 then
      raise exception 'Snapshot settlements do not match the member balances. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;

  -- Snapshot-only members (left the ledger between fetch and close) must carry
  -- no money, otherwise the archive would hide a real balance.
  for snapshot_person in
    select value from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb))
  loop
    if not exists (
      select 1 from jsonb_array_elements(computed->'people') as c(value)
      where c.value->>'id' = snapshot_person->>'id'
    ) and abs(coalesce((snapshot_person->>'net')::numeric, 0)) > 0.02 then
      raise exception 'Snapshot includes a member the server no longer recognizes. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;
  -- ── End integrity gate ────────────────────────────────────────────────────

  -- ── FIX 2 (GV-253 / GVM-278): require requests before close ────────────────
  -- rule_require_requests_before_close (migration 098) shipped stored-only — this
  -- is its first database enforcement. When the workspace flag is NOT an explicit
  -- false, every settlement pair that moves money must already have a request row
  -- for this period in a requested-or-later state (status not 'open'/'cancelled').
  -- The period_snapshot settlements are safe to read here: integrity gate (c) just
  -- proved they reconcile each member's server-computed net, so they ARE the real
  -- outstanding pairs. A settlement_requests row is keyed by period + payer
  -- (from_member_id) + recipient (to_member_id), matching the snapshot fromId/toId.
  select l.rule_require_requests_before_close
    into v_rule_require_requests
    from public.ledgers l
    where l.id = target_ledger_id;

  if v_rule_require_requests is not false then
    for v_settlement in
      select value from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb))
    loop
      if coalesce((v_settlement->>'amount')::numeric, 0) > 0
         and not exists (
           select 1
           from public.settlement_requests sr
           where sr.period_id = target_period_id
             and sr.from_member_id = (v_settlement->>'fromId')::uuid
             and sr.to_member_id = (v_settlement->>'toId')::uuid
             and sr.status not in ('open', 'cancelled')
             and sr.amount = round((v_settlement->>'amount')::numeric, 2)
         ) then
        v_missing_settlements := v_missing_settlements + 1;
      end if;
    end loop;

    if v_missing_settlements > 0 then
      raise exception
        'All settlements must be requested at their current amounts before this period can be closed. Request or update the outstanding payments and try again.'
        using errcode = '42501';
    end if;
  end if;
  -- ── End require-requests-before-close ──────────────────────────────────────

  if snapshot_fingerprint is not null then
    select sp.id into duplicate_period_id
    from public.settlement_periods sp
    where sp.ledger_id = target_ledger_id
      and sp.status = 'closed'
      and sp.snapshot_json->>'entryFingerprint' = snapshot_fingerprint
    limit 1;

    if duplicate_period_id is not null then
      raise exception 'This settlement period snapshot has already been closed' using errcode = '23505';
    end if;
  end if;

  begin
    requested_closed_at := coalesce((period_snapshot->>'closedAt')::timestamptz, now());
  exception when others then
    requested_closed_at := now();
  end;

  update public.settlement_periods sp
  set status = 'closed',
      label = coalesce(nullif(period_snapshot->>'label', ''), sp.label, 'Closed period'),
      closed_at = requested_closed_at,
      closed_by_member_id = actor_member_id,
      snapshot_json = period_snapshot,
      updated_at = now()
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  returning sp.id into closed_period_id;

  if closed_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '40001';
  end if;

  -- FIX 3 (GV-253): label the freshly opened period in Danish to match the app's
  -- own period labels (client formats da-DK month+year; demo data uses 'Juni
  -- 2026'). to_char(..., 'Month') only speaks English, so index a Danish month
  -- array by the current month and capitalize, e.g. 'Juli 2026'. Deterministic and
  -- server-clock based; the client overwrites this with its own snapshot label when
  -- it later closes, so it only shows while this is the current period.
  insert into public.settlement_periods (ledger_id, status, label, opened_at)
  values (
    target_ledger_id,
    'open',
    (array['Januar','Februar','Marts','April','Maj','Juni','Juli','August','September','Oktober','November','December'])[extract(month from now())::int]
      || ' ' || to_char(now(), 'YYYY'),
    now()
  )
  returning id into new_open_period_id;

  -- Activity feed + realtime nudge (GVM-247): closing a period writes a
  -- ledger_events row so every other member's client (subscribed to
  -- ledger_events) refetches immediately — otherwise the close only reaches them
  -- on a manual refresh. metadata carries both period ids for the feed/routing.
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, 'period_closed', 'Periode lukket', 'En ny periode er klar.',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object('closed_period_id', closed_period_id, 'open_period_id', new_open_period_id)
  );

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', snapshot_fingerprint
  );
end;
$$;

revoke execute on function public.close_settlement_period(text, uuid, jsonb) from public;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('104_settlement_amount_integrity',
        'Settlement amount integrity (GV-259, GV-260). upsert_settlement_request_status re-declared off 103 (signature byte-identical): (A) amount + currency are immutable once a request leaves open — only a creditor/admin re-request of a live requested row may change them, every other transition must preserve the stored amount (23514); (B) the stale-pair sweep is now computed server-side from calculate_period_settlement nets via the same greedy min-cash-flow as the client, current_pair_keys is deprecated/ignored, and only open/requested rows are swept (never paid_pending/paid). close_settlement_period re-declared off 101: the require-requests-before-close coverage check now also requires each request to be at its current amount, with an updated operator message.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

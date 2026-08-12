-- Migration 203: the settlement dispute guard must not wedge a period close (GV-485)
--
-- Two rules in this schema disagreed with each other, and the disagreement had a
-- production consequence: a workspace whose period close was refused had no way, from
-- inside the app, to make it closeable.
--
-- THE RULE THAT SAYS YES. GV-259 (migration 104, re-declared in 115) decided that a
-- settlement request's amount is immutable once it leaves 'open' — with exactly one
-- exception: the creditor (recipient) or a ledger admin may RE-REQUEST a still-live
-- request at a NEW amount when the balances move underneath it. That is the mobile
-- re-request flow, and public.upsert_settlement_request_status implements it as an
-- UPDATE of the existing row.
--
-- THE RULE THAT SAYS NO. public.enforce_settlement_request_exact_amount (migration 117,
-- re-declared in 120) refuses ANY change to ledger_id, period_id, from_member_id,
-- to_member_id, amount or currency on an UPDATE whose old status is 'paid_pending'. It
-- was written for the dispute edge — paid_pending -> requested — and it is right about
-- disputes. But it does not ask who is writing or why, so it also refused the one write
-- GV-259 exists to allow, whenever the row being re-requested happened to be a claim.
--
-- WHY THAT WEDGES A CLOSE. close_settlement_period's require-requests gate gives a period
-- one way out: every settlement in the snapshot needs a live request (status not in
-- open/cancelled) AT THE CURRENT amount. A paid_pending row at a stale amount fails that
-- test, and the only remedy — re-request it at the current amount — was the write this
-- trigger forbade. Nobody could unstick it: not the debtor, not the creditor, not an
-- admin. The period simply would not close.
--
-- THE FIX. The 'paid_pending' branch becomes three-way, and nothing else in the function
-- moves. Identity drift still raises, verbatim. An unchanged amount and currency still
-- return immediately — the path every genuine dispute takes, because
-- public.transition_settlement_request_status (migration 122) re-sends the STORED amount.
-- A changed amount falls THROUGH to the exact-amount validation this function already
-- ends with, where it must equal calculate_period_settlement's current pairing under the
-- period advisory lock: the re-request is admitted, an invented figure is still refused.
--
-- ONE GUARD IS ADDED RATHER THAN RELAXED. That fall-through would otherwise reach the
-- closed-period early return, which returns the row unvalidated because a closed
-- period's obligations are historical — so a re-price in a CLOSED period would have been
-- silently accepted, reopening the immutability GV-293 built. The new
-- dispute_amount_change flag carries that single case to the closed-period return, where
-- migration 120's refusal stands unchanged.
--
-- Re-declared off migration 120, its NEWEST prior definition (ancestry 117 -> 120 -> 203;
-- nothing between 121 and 202 re-declares it — the GV-202 rule). No signature to move, so
-- types/database.ts is untouched and no client needs re-vendoring. Out of scope by owner
-- decision: the bogus 'Betaling afvist' event a same-amount re-request writes (GV-487) and
-- the mobile client's pre-flight gate and error copy (GVM-589).

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
  dispute_amount_change boolean := false;
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
    -- GV-485: a dispute must always be able to reopen a claim, and it must reopen the
    -- SAME claim — but which amount that claim carries is not this guard's to freeze.
    -- Migrations 117 and 120 raised on any change to all six fields here, which put this
    -- trigger in direct contradiction with public.upsert_settlement_request_status:
    -- GV-259 deliberately lets the creditor (recipient) or a ledger admin re-request a
    -- live claim at a NEW amount when the balances move underneath it, and that RPC
    -- performs the re-request as an UPDATE which lands on exactly this branch whenever
    -- the row it rewrites is 'paid_pending'. The contradiction had a production
    -- consequence rather than a theoretical one: a paid_pending row left at a stale
    -- amount could not be brought up to date by ANY caller, while
    -- close_settlement_period's require-requests gate gives the period no other way out
    -- — it demands a live request AT THE CURRENT amount — so the workspace's period
    -- close was wedged with no in-app remedy.
    --
    -- The branch is therefore three-way instead of two-way:
    --
    --   * identity drift (ledger, period, or either party) still raises, verbatim. A
    --     dispute may re-price a claim; it may never re-address it. Migration 121's
    --     assert_settlement_request_period_identity trigger guards those same four
    --     columns and, sorting first by trigger name, answers first in practice — this
    --     stays as the belt behind that brace, because a guard has to be correct on its
    --     own terms rather than because of what runs before it. The sentence is kept
    --     word for word (it still names amount and currency, which this branch no longer
    --     refuses on its own) so the string a client may be matching on does not move.
    --   * amount AND currency unchanged → return, exactly as before. This is the path
    --     every GENUINE dispute takes: public.transition_settlement_request_status
    --     (migration 122) re-sends the STORED amount, so nothing about disputing a claim
    --     changes here, and neither do the reminder or confirm writers.
    --   * amount (or currency) changed → do NOT raise; fall through to the exact-amount
    --     validation at the bottom of this function. That is the re-request, and letting
    --     it through is not the same as trusting it: under the period advisory lock the
    --     new figure must equal calculate_period_settlement's current pairing for these
    --     two members, so an invented amount is still rejected — by the server's own
    --     arithmetic instead of by a blanket freeze. dispute_amount_change carries the
    --     one case that validation cannot reach: a CLOSED period returns early below,
    --     and a re-price there must keep raising, or GV-293's immutability of a settled
    --     historical obligation would be reopened by this fix.
    if old.status = 'paid_pending' then
      if new.ledger_id is distinct from old.ledger_id
         or new.period_id is distinct from old.period_id
         or new.from_member_id is distinct from old.from_member_id
         or new.to_member_id is distinct from old.to_member_id then
        raise exception 'Disputing a payment claim must preserve its pair, amount, and currency'
          using errcode = '23514';
      end if;
      if new.amount is not distinct from old.amount
         and new.currency is not distinct from old.currency then
        return new;
      end if;
      dispute_amount_change := true;
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
  -- transitions continue to use their stored amount. A dispute that re-prices a claim in
  -- a CLOSED period is the one case the validation below can never see, because the
  -- validation is only reached while the period is open — so it is refused here with
  -- migration 120's answer, unchanged. Reopening a settled figure was never the bug.
  if period_is_open is not true then
    if dispute_amount_change then
      raise exception 'Disputing a payment claim must preserve its pair, amount, and currency'
        using errcode = '23514';
    end if;
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
values (
  '203_dispute_guard_reprice',
  'The settlement dispute guard must not wedge a period close (GV-485). public.enforce_settlement_request_exact_amount is re-declared off its NEWEST prior definition, migration 120 (ancestry 117 -> 120 -> 203; verified that nothing between 121 and 202 re-declares it — the GV-202 rule), byte-identical apart from the ''paid_pending'' branch and the one closed-period line that branch reaches. THE CONTRADICTION: migration 117 froze all six of ledger_id, period_id, from_member_id, to_member_id, amount and currency on any UPDATE whose old status is ''paid_pending'', and 120 inherited that branch unchanged while generalising the rest of the function — but GV-259 had already decided the opposite for the RPC that performs the write. public.upsert_settlement_request_status (migration 104, re-declared in 115) deliberately permits the creditor (recipient) or a ledger admin to re-request a still-live request AT A NEW AMOUNT when balances move underneath it, and it performs that re-request as an UPDATE of the existing row, so every re-request of a paid_pending claim hit this trigger and raised "Disputing a payment claim must preserve its pair, amount, and currency" (23514). PRODUCTION IMPACT, which is why this is a fix rather than a tidy-up: a paid_pending claim sitting at a stale amount could not be brought up to date by ANY caller, while close_settlement_period''s require-requests gate (newest copy in migration 194) demands, for every settlement in the snapshot, a live request in a status other than open/cancelled AT THE CURRENT amount — so the workspace''s period close was wedged with no in-app remedy at all: not by the debtor, not by the creditor, not by an admin. THE BRANCH IS NOW THREE-WAY. (1) Identity drift — ledger, period, or either party — still raises, with the sentence kept WORD FOR WORD even though it names two fields this branch no longer refuses on its own, so a client matching on that string does not move; a dispute may re-price a claim, it may never re-address it. Migration 121''s assert_settlement_request_period_identity trigger guards those same four columns and sorts first by trigger name, so in practice it answers first — this stays as the belt behind that brace, because a guard has to be correct on its own terms rather than because of whatever happens to run before it. (2) Amount AND currency unchanged: return, exactly as before — and this is the path every GENUINE dispute takes, because public.transition_settlement_request_status (migration 122) re-sends the STORED amount, so disputing a claim behaves identically to before this migration, as do the reminder and confirm writers. (3) Amount (or currency) changed: fall THROUGH to the exact-amount validation this function already ends with, instead of raising. Admitting the re-request is not the same as trusting it — under the period advisory lock the new figure must equal calculate_period_settlement''s current greedy pairing for those two members, so an invented amount is still rejected with "Settlement request amount does not match the current server calculation", by the server''s own arithmetic rather than by a blanket freeze, and new.amount is pinned to the computed figure on the way out. ONE GUARD IS ADDED RATHER THAN RELAXED: that fall-through would otherwise reach the closed-period early return, which returns the row unvalidated because a closed period''s obligations are historical — so a re-price in a CLOSED period would have been silently ACCEPTED, reopening exactly the immutability GV-293 built. The one new declared flag, dispute_amount_change, carries that single case to the closed-period return, where migration 120''s refusal stands unchanged. NET BEHAVIOUR DELTA versus 120, stated exhaustively: ONE case moves — an OPEN period''s paid_pending -> requested at a CHANGED amount now validates against the server calculation instead of raising unconditionally. Every other input to this trigger answers exactly as it did. No signature to move (a trigger function takes none), so types/database.ts is untouched and no client re-vendoring is needed; the trigger is re-wired with 120''s statement verbatim and the three revokes are restated (148 convention). No change to upsert_settlement_request_status, to close_settlement_period, or to any client repo. NO new event_type, so nothing to classify under GV-413 — the bogus "Betaling afvist" event a same-amount re-request writes is a separate defect tracked as GV-487, and the mobile client''s pre-flight gate and error copy as GVM-589. Guarded by tools/test-dispute-guard-reprice-contract.mjs against a real Postgres replay of the consolidated schema: an unchanged-amount dispute still passes, a changed-amount re-request matching the current calculation now passes, an invented amount is still rejected, identity drift is still rejected, a closed period still refuses a re-price, and the wedge itself is proven END TO END — a period whose close is refused is re-requested at its current amount and then closes.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

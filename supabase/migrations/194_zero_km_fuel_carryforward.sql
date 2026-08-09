-- Migration 194: fuel paid in a zero-kilometre period carries forward to the next one (GV-472)
--
-- THE BUG (GV-471-F1, surfaced by the simulator, verified by hand). In
-- calculate_period_settlement, a member's `net` is
--
--     case when totalKm > 0 then fuelPaid + … - tripCost - shares
--                           else fuelPaid + … - shares  end
--
-- The else branch drops tripCost, which is right -- a per-km fuel rate is undefined
-- at zero kilometres -- but it keeps the fuel CREDIT while removing the only debit
-- that ever balanced it. So a period holding fuel logs and no live trips credits the
-- payer the full amount, debits nobody, and stops netting to zero by exactly
-- totalPaid. Reachable the first time a group fills the tank before its first trip of
-- a new period, or deletes the only trip in one. Worse, close_settlement_period let
-- such a period close: its guard compares the client snapshot's totalKm/totalPaid
-- against the server's and says nothing about whether the nets balance, so the period
-- was archived with a payer owed money nobody owed and the fuel cost simply gone.
-- Reproduce on the pre-194 schema with
--   node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 11 \
--     --oracle-every 25 --epoch 2026-06-07 --headless
-- which hits it three times, once on a QUEUED period.
--
-- THE DECISION (owner, 2026-08-09): CARRY FORWARD. Fuel bought in a period with no
-- kilometres is not splittable in that period -- there is no usage to split it by --
-- but it is also not a gift, so it moves to the period that follows and is split
-- there against real kilometres. Not "split it equally", which would charge a member
-- who demonstrably did not drive; not "leave it and warn", which is what shipped.
--
-- WHAT THAT MEANS IN THREE PLACES, and nothing else changes:
--
--   1. calculate_period_settlement (re-declared off migration 157, its newest prior
--      definition) drops fuelPaid from `net` in the zero-km branch ONLY, and reports
--      what it set aside in a new, conditional `deferredFuel` block -- total plus the
--      per-member amounts -- so a client can render an "afventer km" line. At
--      totalKm > 0 the function is byte-for-byte 157. totalPaid and each person's
--      fuelPaid stay RAW in both branches, because the close guard compares a client
--      snapshot's copies of those numbers against these.
--
--   2. close_settlement_period_unlocked (re-declared off migration 141, its newest
--      prior definition; the public close_settlement_period wrapper from 117 that
--      takes the FOR UPDATE row lock is untouched) promotes the closing period's live
--      fuel_payments rows into migration 140's queued carry-over period when the
--      server's own totalKm is 0, then re-freezes the archived snapshot's
--      entryFingerprint over what remains. The INSERT of the next open period fires
--      140's promote_settlement_carryover_on_open, which moves the queue -- fuel and
--      any late entries alike -- into it, so one transaction ends with the fuel in
--      the new open period and the closed one holding exactly what it settled.
--
--   3. One ledger_events row, event_type `fuel_carried_forward`, Danish title naming
--      the amount. GV-413 requires every new event type to be classified; this one is
--      feed-visible (tools/ledger-event-visibility.mjs) -- money moving between
--      periods is news for every member, and the mobile feed renders whatever the
--      database writes, so it needs no client change to appear.
--
-- WHY THE PROMOTION RUNS AFTER THE FLIP TO CLOSED. enforce_settlement_entry_lock's
-- requested/paid rail (migration 120) rejects a period_id change on fuel_payments
-- while settlement_entry_is_locked holds, and rule_require_requests_before_close
-- makes a live request near-certain at close time. settlement_entry_is_locked
-- (migration 090) only counts requests whose period is still OPEN, so after the flip
-- the rail is silent and the closed-period rejection is the only thing left -- and
-- that one honours the transaction-local govehlo.pii_scrub bypass, used here exactly
-- as migration 141 uses it for close's own repair stamping: one server-authored
-- statement, opened and closed around it, no caller SQL in between. The alternative
-- was widening a security-critical trigger to buy statement order; it was declined.
--
-- OLD CLIENTS. A client whose settlement-calc.ts still credits fuel at zero km now
-- disagrees with the server on every affected member's `net`, so the close's
-- per-member 0,02 kr gate rejects it with "Refresh the app and try closing again".
-- That is the intended direction -- fail closed, not close wrong -- and it makes the
-- mobile parity change a hard dependency rather than a cosmetic one. Nothing else
-- regresses: totalKm/totalPaid are unchanged, so the staleness gate still passes, and
-- a period with kilometres closes from an old client exactly as before.
--
-- No schema change, no new table, no column, no grant change, no policy change, no
-- RPC signature change (both returns stay jsonb, so types/database.ts is untouched).

-- ── 1. calculate_period_settlement — re-declared off migration 157 ─────────────
-- Migration 157 verbatim except for two edits, both inside the final SELECT: the
-- zero-km branch of `net` loses `pm.fuel_paid +`, and a conditional `deferredFuel`
-- object is concatenated onto the result. Every CTE -- the km shares, the expense,
-- repair and crossing largest-remainder chains, the GV-274 credit-only inactive payer
-- rule, the GV-277 repair period scoping -- is untouched. Signature unchanged, so this
-- stays a plain create-or-replace and the existing grants carry over.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  all_members as (
    -- Every member of the ledger, active or not. Used to retain (not drop) an
    -- entry whose payer has since gone inactive so that payer can be credited
    -- (GV-274, credit-only). is_active decides who lands in settlement_members.
    select lm.id, lm.name, lm.is_active
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km,
           t.crossing_cost_dkk,
           coalesce(t.crossing_paid_by_member_id, t.driver_member_id) as crossing_payer_member_id
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
           lt.crossing_cost_dkk,
           lt.crossing_payer_member_id,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  member_km as (
    -- Unrounded per-member km, reused both for the settlement km and as the
    -- usage-split weight (the client weights usage on raw km).
    select ks.member_id, sum(ks.share_km) as km_sum
    from km_shares ks
    group by ks.member_id
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  ledger_defaults as (
    select l.expense_split_defaults as defaults
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  repairs_mode as (
    -- The workspace rule that governs repair folding (GVM-307). null (old row,
    -- pre-107) behaves like deles_ikke: the mode filter below excludes every
    -- repair, matching a client that has no mode field to read.
    select l.repairs_split_mode as mode
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  period_bounds as (
    -- Legacy null-period repairs (pre-114) have no period_id: such a repair counts
    -- in the period whose [opened_at, closed_at) window contains its created_at —
    -- the moment it was LOGGED (GV-269; repair_date is display-only). A stamped
    -- repair (GV-277) is matched by period_id instead and never needs this window.
    -- The settling period is still open here (closed_at null), so its window has no
    -- upper bound.
    select sp.opened_at, sp.closed_at
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is a MEMBER of the ledger (active
    -- OR inactive). An inactive payer is retained (credit-only, GV-274) rather
    -- than dropped: its cost is still split (over active members, via the weight
    -- CTEs below), and the payer is credited what they paid. An expense with no
    -- payer or a non-member payer is still skipped entirely.
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join all_members payer on payer.id = we.paid_by_member_id
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
      and we.amount_dkk > 0
  ),
  expense_weights as (
    select pe.id as expense_id,
           pe.amount_dkk,
           am.id as member_id,
           case pe.rule
             when 'usage'  then coalesce(mk.km_sum, 0)
             when 'custom' then coalesce((pe.split_config ->> am.id::text)::numeric, 0)
             else 1::numeric
           end as weight
    from period_expenses pe
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  expense_weight_totals as (
    select expense_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from expense_weights
    group by expense_id
  ),
  expense_cents as (
    -- Largest-remainder split, step 1 (GV-269): per expense, work in integer
    -- oere and compute each member's exact (unrounded) share of them. A
    -- non-positive total weight falls back to equal weights, matching the
    -- pre-108 fallback and the client.
    select ew.expense_id,
           ew.member_id,
           round(ew.amount_dkk * 100) as total_cents,
           round(ew.amount_dkk * 100)
             * (case when ewt.total_weight > 0 then ew.weight else 1 end)
             / (case when ewt.total_weight > 0 then ewt.total_weight else ewt.member_count end)
             as exact_cents
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
  ),
  expense_lr as (
    -- Step 2: floor every share, then hand the leftover oere (R = total oere -
    -- sum of floors, 0 <= R < member count) to the R members with the largest
    -- remainders; ties break on member id ascending (uuid byte order = its
    -- canonical text order), matching the client tie-break. Every expense's
    -- shares now sum EXACTLY to its amount.
    select ec.member_id,
           floor(ec.exact_cents)
             + case when row_number() over (
                      partition by ec.expense_id
                      order by ec.exact_cents - floor(ec.exact_cents) desc, ec.member_id asc
                    ) <= ec.total_cents - sum(floor(ec.exact_cents)) over (partition by ec.expense_id)
                    then 1 else 0 end
             as share_cents
    from expense_cents ec
  ),
  expense_share as (
    select el.member_id,
           sum(el.share_cents) / 100.0 as share
    from expense_lr el
    group by el.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  period_repairs as (
    -- Repairs folded per the workspace mode (GVM-307). Only efter_koersel /
    -- ligeligt fold; deles_ikke (or a null mode) yields no rows. The payer is
    -- paid_by_member_id, falling back to created_by_member_id for pre-108 rows
    -- (GV-269); a repair whose payer is a MEMBER of the ledger — active OR
    -- inactive — is retained (credit-only, GV-274). Scoped by period_id (GV-277):
    -- a stamped repair matches vr.period_id = target_period_id; a legacy
    -- null-period repair falls back to created_at within the period's
    -- [opened_at, closed_at) window (timestamps, no ::date truncation).
    select vr.id,
           vr.cost_dkk,
           coalesce(vr.paid_by_member_id, vr.created_by_member_id) as payer_member_id,
           rm.mode
    from public.vehicle_repairs vr
    cross join repairs_mode rm
    cross join period_bounds pb
    join all_members payer on payer.id = coalesce(vr.paid_by_member_id, vr.created_by_member_id)
    where vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.cost_dkk > 0
      and rm.mode in ('efter_koersel', 'ligeligt')
      and (
        vr.period_id = target_period_id
        or (vr.period_id is null
            and vr.created_at >= pb.opened_at
            and (pb.closed_at is null or vr.created_at < pb.closed_at))
      )
  ),
  repair_weights as (
    -- efter_koersel weights by each member's raw km (like the expense usage rule);
    -- ligeligt weights everyone equally. Zero total weight (efter_koersel with no
    -- km) falls back to an equal split below, matching the client.
    select pr.id as repair_id,
           pr.cost_dkk,
           am.id as member_id,
           case when pr.mode = 'efter_koersel' then coalesce(mk.km_sum, 0)
                else 1::numeric end as weight
    from period_repairs pr
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  repair_weight_totals as (
    select repair_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from repair_weights
    group by repair_id
  ),
  repair_cents as (
    -- Largest-remainder split for repairs — identical to the expense chain above
    -- (GV-269).
    select rw.repair_id,
           rw.member_id,
           round(rw.cost_dkk * 100) as total_cents,
           round(rw.cost_dkk * 100)
             * (case when rwt.total_weight > 0 then rw.weight else 1 end)
             / (case when rwt.total_weight > 0 then rwt.total_weight else rwt.member_count end)
             as exact_cents
    from repair_weights rw
    join repair_weight_totals rwt using (repair_id)
  ),
  repair_lr as (
    select rc.member_id,
           floor(rc.exact_cents)
             + case when row_number() over (
                      partition by rc.repair_id
                      order by rc.exact_cents - floor(rc.exact_cents) desc, rc.member_id asc
                    ) <= rc.total_cents - sum(floor(rc.exact_cents)) over (partition by rc.repair_id)
                    then 1 else 0 end
             as share_cents
    from repair_cents rc
  ),
  repair_share as (
    select rl.member_id,
           sum(rl.share_cents) / 100.0 as share
    from repair_lr rl
    group by rl.member_id
  ),
  repair_paid as (
    select pr.payer_member_id as member_id, sum(pr.cost_dkk)::numeric as paid
    from period_repairs pr
    group by pr.payer_member_id
  ),
  period_crossings as (
    -- Bro/faerge crossings (GVM-415). A crossing hangs on the TRIP and is shared by
    -- the people in that car: the split circle is the trip's own assignees — exactly
    -- the set trip_assignees already resolved for the km split (active participants,
    -- driver fallback) — NOT the workspace Afregning rule and NOT the active-member
    -- universe the expense/repair chains split over. It is also a FLAT cost, so it is
    -- split EQUALLY and never weighted by km: the second person in the car costs the
    -- ferry the same whether they rode 5 km or 500.
    --
    -- The credited payer is coalesce(crossing_paid_by_member_id, driver_member_id) —
    -- the column defaults to the driver at write time, and the coalesce also covers a
    -- payer whose row was later cleared by the FK's on delete set null. As with fuel,
    -- expenses and repairs, a payer who is a MEMBER of the ledger — active OR
    -- inactive — is retained (credit-only, GV-274).
    --
    -- A trip with NO assignees (every participant and the driver have since gone
    -- inactive) is skipped entirely, credit AND debit: crediting a cost nobody is
    -- debited for would stop the period netting to zero. That trip's km is already
    -- dropped by km_shares for the same reason.
    select ta.trip_id,
           ta.crossing_cost_dkk as cost_dkk,
           ta.crossing_payer_member_id as payer_member_id,
           ta.assignees
    from trip_assignees ta
    join all_members payer on payer.id = ta.crossing_payer_member_id
    where ta.crossing_cost_dkk is not null
      and ta.crossing_cost_dkk > 0
      and ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  crossing_cents as (
    -- Largest-remainder split, step 1 — the same integer-oere chain the expense and
    -- repair CTEs above run (GV-269), so the three cannot drift and all of them agree
    -- with the client's splitByWeights. The only difference is the universe (this
    -- trip's assignees) and the weights (equal, one each).
    select pc.trip_id,
           shared.member_id,
           round(pc.cost_dkk * 100) as total_cents,
           round(pc.cost_dkk * 100) / array_length(pc.assignees, 1)::numeric as exact_cents
    from period_crossings pc
    cross join lateral unnest(pc.assignees) as shared(member_id)
  ),
  crossing_lr as (
    -- Step 2: floor every share, then hand the leftover oere to the largest
    -- remainders; ties break on member id ascending. With equal weights EVERY
    -- remainder is identical, so the tie-break is what decides — the R lowest member
    -- ids each take one extra oere (250,00 kr over three people = 83,34 / 83,33 /
    -- 83,33, the extra oere going to the lowest id).
    select cl.member_id,
           floor(cl.exact_cents)
             + case when row_number() over (
                      partition by cl.trip_id
                      order by cl.exact_cents - floor(cl.exact_cents) desc, cl.member_id asc
                    ) <= cl.total_cents - sum(floor(cl.exact_cents)) over (partition by cl.trip_id)
                    then 1 else 0 end
             as share_cents
    from crossing_cents cl
  ),
  crossing_share as (
    select cs.member_id,
           sum(cs.share_cents) / 100.0 as share
    from crossing_lr cs
    group by cs.member_id
  ),
  crossing_paid as (
    select pc.payer_member_id as member_id, sum(pc.cost_dkk)::numeric as paid
    from period_crossings pc
    group by pc.payer_member_id
  ),
  settlement_members as (
    -- The settlement participant set (GV-274): every ACTIVE member, plus any
    -- member (necessarily inactive, since actives are already in) who PAID fuel,
    -- an expense, a repair, or a trip's bro/faerge crossing this period. Inactive
    -- payers are credit-only — they
    -- appear so they can be credited what they paid, but they carry zero weight in
    -- every share split (the weight CTEs cross join active_members only), so their
    -- net is exactly +paid. An inactive member who paid nothing never appears.
    select am.id, am.name
    from all_members am
    where am.is_active
       or am.id in (select fp.member_id from fuel_paid fp)
       or am.id in (select ep.member_id from expense_paid ep)
       or am.id in (select rp.member_id from repair_paid rp)
       or am.id in (select cp.member_id from crossing_paid cp)
  ),
  per_member as (
    select sm.id,
           sm.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share,
           round(coalesce(rp.paid, 0), 2) as repair_paid,
           round(coalesce(rs.share, 0), 2) as repair_share,
           round(coalesce(cp.paid, 0), 2) as crossing_paid,
           round(coalesce(cs.share, 0), 2) as crossing_share
    from settlement_members sm
    left join member_km mk on mk.member_id = sm.id
    left join fuel_paid f on f.member_id = sm.id
    left join expense_paid xp on xp.member_id = sm.id
    left join expense_share xs on xs.member_id = sm.id
    left join repair_paid rp on rp.member_id = sm.id
    left join repair_share rs on rs.member_id = sm.id
    left join crossing_paid cp on cp.member_id = sm.id
    left join crossing_share cs on cs.member_id = sm.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses,
           coalesce(sum(pm.repair_paid), 0) as total_repairs,
           coalesce(sum(pm.crossing_paid), 0) as total_crossings
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'totalRepairs', t.total_repairs,
    'totalCrossings', t.total_crossings,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'repairPaid', pm.repair_paid,
        'repairShare', pm.repair_share,
        'crossingPaid', pm.crossing_paid,
        'crossingShare', pm.crossing_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        -- GV-472. The then-branch is migration 157 VERBATIM and must stay that way:
        -- at totalKm > 0 this function's answer is byte-for-byte what it always was.
        -- The else branch is the fix. It no longer carries pm.fuel_paid. At zero km a
        -- per-km rate is undefined, so tripCost is 0 -- correctly -- but 157 still
        -- credited the payer their fuel with nothing debited against it, so the period
        -- summed to +totalPaid instead of 0 and the payer was owed money nobody owed
        -- (GV-471-F1, found by the simulator; the residue equalled totalPaid to the
        -- oere every time, which is the signature). The fuel is NOT written off: it is
        -- not splittable in a period with no kilometres, so close_settlement_period
        -- moves those fuel_payments rows into the period that follows and they are
        -- split there against real kilometres. deferredFuel below reports what was set
        -- aside so a client can say so. Expenses, repairs and crossings still settle in
        -- this period -- each splits its own cost over its own universe with a
        -- largest-remainder integer-oere chain -- so this branch sums to EXACTLY zero.
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid + pm.repair_paid + pm.crossing_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share - pm.repair_share - pm.crossing_share, 2)
                    else round(pm.expense_paid + pm.repair_paid + pm.crossing_paid - pm.expense_share - pm.repair_share - pm.crossing_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  -- GV-472: deferredFuel is ADDITIVE and conditional. It appears only when the period
  -- has no kilometres AND holds fuel -- i.e. exactly when the net expression above
  -- dropped the fuel credit -- so a caller reading a totalKm > 0 period sees the same
  -- keys it always saw, and `deferredFuel is null` is a sound test for "nothing was
  -- set aside". Note what does NOT move: totalPaid and each person's fuelPaid stay the
  -- RAW figures, because the close guard compares a client snapshot's totalPaid and
  -- fuelPaid against these and an older client computes them from the same rows. The
  -- deferral shows up in `net` and here, nowhere else.
  || case
       when t.total_km = 0 and t.total_paid > 0 then jsonb_build_object(
         'deferredFuel', jsonb_build_object(
           'total', t.total_paid,
           'people', coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', pm.id,
               'name', pm.name,
               'fuelPaid', pm.fuel_paid
             ) order by pm.id::text collate "C")
             from per_member pm
             where pm.fuel_paid <> 0
           ), '[]'::jsonb)))
       else '{}'::jsonb
     end
  into result
  from totals t;

  return result;
end;
$$;

-- ── 2. close_settlement_period_unlocked — re-declared off migration 141 ────────
-- Migration 141's body verbatim (which is itself 114's, renamed by 117 and never
-- re-declared since) plus the carry-forward in three parts, marked GV-472 below, and
-- one added condition on the duplicate-snapshot guard. The wrapper, the signature, the
-- integrity gate, the require-requests coverage, the repair stamping, the close/open
-- pair, the period_closed event and the grants are unchanged.
create or replace function public.close_settlement_period_unlocked(
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
  v_period_has_entries boolean;
  v_carry_fuel_count integer := 0;
  v_carry_fuel_total numeric := 0;
  v_carry_fuel_ids uuid[] := array[]::uuid[];
  v_carry_period_id uuid;
  v_carry_fingerprint text;
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

  -- ── GV-472: does this period hold any live entry at all? ───────────────────
  -- Two things below need the answer, and both are new. It is read HERE, before
  -- anything moves, so it describes the period the caller prepared its close against.
  select exists (
    select 1
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
    union all
    select 1
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
    union all
    select 1
    from public.workspace_expenses we
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
    union all
    select 1
    from public.vehicle_repairs vr
    cross join public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and (
        vr.period_id = target_period_id
        or (vr.period_id is null
            and vr.created_at >= sp.opened_at
            and (sp.closed_at is null or vr.created_at < sp.closed_at))
      )
  ) into v_period_has_entries;

  -- ── GV-472: the zero-km fuel carry-forward, part 1 -- decide and reserve ───
  -- `computed` is the server's own settlement, read above by the integrity gate, so
  -- this asks the same question the gate already answered: is totalKm zero? If it is
  -- and the period holds live fuel, that fuel cannot be split here (see the net
  -- expression in calculate_period_settlement) and must land in the next period
  -- instead. The DESTINATION is migration 140's queued carry-over period -- the same
  -- hidden successor a late entry saved against a locked period goes to -- because
  -- the period that will succeed this one does not exist yet, and the AFTER INSERT
  -- trigger promote_settlement_carryover_on_open moves everything queued into it the
  -- moment this function inserts it, a few statements below. Reserving the queue here
  -- (while this period is still open, which ensure_settlement_carryover_period
  -- requires) keeps the whole carry-forward inside one transaction.
  if coalesce((computed->>'totalKm')::numeric, 0) = 0 then
    select count(*)::integer,
           coalesce(sum(fp.amount), 0),
           coalesce(array_agg(fp.id order by fp.id), array[]::uuid[])
      into v_carry_fuel_count, v_carry_fuel_total, v_carry_fuel_ids
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_period_id
        and fp.deleted_at is null;

    if v_carry_fuel_count > 0 then
      v_carry_period_id := public.ensure_settlement_carryover_period(target_ledger_id, target_period_id);
    end if;
  end if;

  -- GV-472 adds `and v_period_has_entries` to this guard. The duplicate check exists
  -- to reject a prepared snapshot being REPLAYED onto a second period, and it works by
  -- matching the incoming fingerprint against the ones already archived. An entry
  -- fingerprint over a period with no entries identifies no entries, so two such
  -- periods are not one snapshot replayed -- they are two genuinely empty months, and
  -- rejecting the second one would brick the workspace's close. That collision was
  -- already reachable before this migration (close an empty period twice), but the
  -- carry-forward makes it ordinary: a period whose only content was fuel archives the
  -- entry-less fingerprint once the fuel has moved on, so the very next empty month
  -- would have matched it. A period WITH entries still cannot be closed twice.
  if snapshot_fingerprint is not null and v_period_has_entries then
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

  -- GV-277: bind this period's remaining legacy null-period repairs to it BEFORE
  -- the period flips to closed, so period_id is authoritative for every repair
  -- once the period is closed. A stamped repair already carries period_id from
  -- insert_repair; only pre-114 rows are updated here, matched by the same
  -- created_at window the settlement/fingerprint use.
  --
  -- GV-358: since migration 140 the repair guard ALSO rejects a period_id change
  -- while the period is locked by a requested or paid settlement -- and close
  -- cannot legally run without those requests when
  -- rule_require_requests_before_close is on, so this statement rejected the
  -- close it belongs to. Reuse the transaction-local metadata bypass exactly as
  -- migration 140 does for trip workflow metadata: it is opened for this single
  -- server-authored statement and closed again immediately, no caller-controlled
  -- SQL runs while it is set, and the write only records the period a legacy
  -- repair already belonged to by created_at -- no amount, payer or membership
  -- changes, so neither the archived snapshot nor the fingerprint can move.
  perform set_config('govehlo.pii_scrub', '1', true);

  update public.vehicle_repairs vr
  set period_id = target_period_id
  from public.settlement_periods sp
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and vr.ledger_id = target_ledger_id
    and vr.period_id is null
    and vr.deleted_at is null
    and vr.created_at >= sp.opened_at
    and vr.created_at < requested_closed_at;

  perform set_config('govehlo.pii_scrub', '', true);

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

  -- ── GV-472: the zero-km fuel carry-forward, part 2 -- move the rows ────────
  -- Deliberately AFTER the flip to closed, and that ordering is the whole trick.
  -- enforce_settlement_entry_lock's requested/paid rail (migration 120) rejects any
  -- change to period_id while settlement_entry_is_locked(ledger, period) holds, and
  -- that predicate is true for a period carrying a requested/paid/paid_pending request
  -- -- which rule_require_requests_before_close makes near-certain for any period that
  -- settles money. But settlement_entry_is_locked (migration 090) only counts requests
  -- whose period is still OPEN, so once this period is closed the rail no longer fires
  -- and the only remaining objection is the closed-period rejection -- which is exactly
  -- what the transaction-local govehlo.pii_scrub bypass is for, used here precisely as
  -- migration 141 uses it for close's own repair stamping and 140 for trip metadata:
  -- opened for one server-authored statement, closed again immediately, no
  -- caller-controlled SQL in between. The alternative -- re-declaring the
  -- settlement-entry lock trigger to know about carry-forward -- would have widened a
  -- security-critical rail to buy nothing but statement order.
  --
  -- The rows go to the queued period reserved above; the INSERT below then promotes
  -- them into the freshly opened one along with any late entries already waiting
  -- there. Their amount, payer and date are untouched: only which period splits them.
  if v_carry_period_id is not null then
    perform set_config('govehlo.pii_scrub', '1', true);

    update public.fuel_payments fp
    set period_id = v_carry_period_id
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null;

    perform set_config('govehlo.pii_scrub', '', true);
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

  -- ── GV-472: the zero-km fuel carry-forward, part 3 -- re-freeze and announce ─
  if v_carry_period_id is not null then
    -- The archived snapshot must describe the period as it ENDS UP, not as it looked
    -- while the fuel was still in it. The stored entryFingerprint is what
    -- closed-period immutability is checked against (recompute it later and it must
    -- still match -- the simulator's second invariant does exactly that), so it is
    -- recomputed here, over what remains. This is also what makes a CHAINED carry
    -- possible: if the fingerprint kept the moved fuel's id, the next period -- now
    -- holding that same fuel and no trips -- would produce the identical fingerprint
    -- and the duplicate guard would refuse to close it. The rest of the snapshot is
    -- the client's own and is left alone; only a snapshot that HAD a fingerprint gets
    -- one back, so a client that cannot hash still closes exactly as before.
    v_carry_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, closed_period_id);

    update public.settlement_periods sp
    set snapshot_json = case
                          when sp.snapshot_json ? 'entryFingerprint'
                            then jsonb_set(sp.snapshot_json, '{entryFingerprint}', to_jsonb(v_carry_fingerprint))
                          else sp.snapshot_json
                        end
                        || jsonb_build_object('deferredFuel', jsonb_build_object(
                             'total', round(v_carry_fuel_total, 2),
                             'count', v_carry_fuel_count,
                             'carriedToPeriodId', new_open_period_id)),
        updated_at = now()
    where sp.id = closed_period_id
      and sp.ledger_id = target_ledger_id;

    -- One feed row, server-authored in Danish (GV-413: fuel_carried_forward is
    -- classified feed-visible in tools/ledger-event-visibility.mjs -- money that moved
    -- between periods is news every member should read, and the mobile feed renders
    -- whatever the database writes, so no client change is needed to show it). The
    -- amount is formatted with the template's own literal separators rather than G/D,
    -- which follow lc_numeric, and then transposed to Danish: 1234.5 -> '1.234,50'.
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'fuel_carried_forward',
      'Brændstof på '
        || translate(to_char(round(v_carry_fuel_total, 2), 'FM999,999,990.00'), '.,', ',.')
        || ' kr flyttet til næste periode',
      'Der var ingen kørte kilometer i perioden, så brændstoffet deles i den nye periode.',
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object(
        'closed_period_id', closed_period_id,
        'open_period_id', new_open_period_id,
        'fuel_total', round(v_carry_fuel_total, 2),
        'fuel_count', v_carry_fuel_count,
        'fuel_payment_ids', to_jsonb(v_carry_fuel_ids))
    );
  end if;

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', coalesce(v_carry_fingerprint, snapshot_fingerprint),
    -- GV-472, additive: how much fuel this close moved into the new period, so the
    -- caller can confirm it without a second round trip. 0 on every close that carried
    -- nothing, which is every close a totalKm > 0 period makes.
    'carried_forward_fuel_total', round(v_carry_fuel_total, 2),
    'carried_forward_fuel_count', v_carry_fuel_count
  );
end;
$$;

revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from public;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from anon;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '194_zero_km_fuel_carryforward',
  'Fuel paid in a zero-kilometre period carries forward to the next period (GV-472; the bug is GV-471-F1, the first finding the deterministic simulator produced). THE DEFECT: calculate_period_settlement''s net is `case when totalKm > 0 then fuelPaid + … - tripCost - shares else fuelPaid + … - shares end` -- the else branch correctly drops tripCost (a per-km rate is undefined at zero km) but keeps the fuel CREDIT with no debit anywhere, so a period holding fuel logs and no live trips credits the payer in full, debits nobody, and stops netting to zero by exactly totalPaid; close_settlement_period''s guard only compares the client snapshot''s totalKm/totalPaid against the server''s and never asks whether the nets balance, so such a period COULD be archived, leaving a payer owed money nobody owed and the fuel cost gone. Reachable the first time a group fills the tank before its first trip of a period, or deletes the only trip in one; the simulator hits it three times on seed 11 (400 ticks, 4 workspaces), once on a QUEUED period, and the residue equals totalPaid to the oere every time. THE DECISION (owner, 2026-08-09) is CARRY FORWARD, not equal-split (which would charge a member who demonstrably did not drive) and not warn-and-leave (which is what shipped): fuel bought in a period with no kilometres is not splittable there, so it moves to the period that follows and is split against real kilometres. (1) calculate_period_settlement, re-declared off migration 157 (its newest prior definition, verified against every later migration), drops pm.fuel_paid from net in the zero-km branch ONLY and concatenates a new conditional deferredFuel block (total plus the per-member paid amounts, emitted only when totalKm = 0 and totalPaid > 0) so clients can render an "afventer km" line; at totalKm > 0 the function is byte-for-byte 157, and totalPaid plus each person''s fuelPaid stay RAW in both branches because the close guard compares a client snapshot''s copies of those numbers against them. The zero-km branch now sums to EXACTLY zero: expenses, repairs and crossings each split their own cost over their own universe with a largest-remainder integer-oere chain. (2) close_settlement_period_unlocked, re-declared off migration 141 (its newest prior definition; 141 is 114''s body, renamed by 117, never re-declared since -- the public close_settlement_period wrapper from 117 that takes the FOR UPDATE row lock is untouched), promotes the closing period''s live fuel_payments rows into migration 140''s queued carry-over period when the SERVER''s own totalKm is 0, then re-freezes the archived snapshot''s entryFingerprint over what remains; the INSERT of the next open period fires 140''s promote_settlement_carryover_on_open, which moves the queue -- carried fuel and any late entries alike -- into it, so one transaction ends with the fuel in the new open period and the closed period holding exactly what it settled. Re-freezing the fingerprint is what keeps closed-period immutability coherent (recompute it later and it still matches) AND what makes a CHAINED carry possible: a fingerprint that kept the moved fuel''s id would be reproduced verbatim by the successor period and rejected by the duplicate-snapshot guard. The promotion deliberately runs AFTER the flip to closed: enforce_settlement_entry_lock''s requested/paid rail (migration 120) rejects a period_id change while settlement_entry_is_locked holds and rule_require_requests_before_close makes a live request near-certain at close time, but settlement_entry_is_locked (migration 090) only counts requests whose period is still OPEN, so after the flip only the closed-period rejection remains -- and that one honours the transaction-local govehlo.pii_scrub bypass, used here exactly as migration 141 uses it for close''s own repair stamping (one server-authored statement, opened and closed around it, no caller SQL in between). Widening the settlement-entry lock trigger instead was declined: it would have relaxed a security-critical rail to buy nothing but statement order. The duplicate-snapshot guard gains one condition -- it is skipped when the closing period holds no live entry at all -- because an entry fingerprint over an entry-less period identifies no entries, so two such periods are two genuinely empty months rather than one snapshot replayed; that collision was already reachable (close an empty period twice) and the carry-forward would have made it ordinary. (3) ONE ledger_events row per carry, event_type fuel_carried_forward, server-authored Danish title naming the amount in Danish number format ("Braendstof paa 1.234,50 kr flyttet til naeste periode"), metadata carrying both period ids, the total, the count and the moved fuel_payment ids. GV-413: the new type is classified FEED-VISIBLE in tools/ledger-event-visibility.mjs -- money moving between periods is news for every member, and the mobile feed renders whatever the database writes, so no client change is needed for it to appear. OLD CLIENTS: a client whose settlement-calc.ts still credits fuel at zero km now disagrees with the server on every affected member''s net, so the close''s per-member 0,02 kr gate rejects it with "Refresh the app and try closing again" -- fail closed rather than close wrong, which makes the mobile parity change a hard dependency; a period WITH kilometres closes from an old client exactly as before, since totalKm/totalPaid are unchanged. No schema change, no new table or column, no grant change, no policy change, no RPC signature change (both returns stay jsonb, so types/database.ts is unchanged). Pinned by tools/test-zero-km-fuel-carryforward-contract.mjs against a real Postgres replay.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

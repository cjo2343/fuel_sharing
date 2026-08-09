-- Migration 196: tripCost multiplies before it divides, so an exact half-øre tie rounds the way the app rounds it (GV-477)
--
-- THE BUG (GV-471-F2, surfaced by the simulator's client-parity oracle on its first
-- long Phase A run, verified by hand). calculate_period_settlement computes a member's
-- share of the period's fuel as
--
--     round(pm.km * (t.total_paid / t.total_km), 2)
--
-- -- divide FIRST, then multiply. Postgres' numeric division cannot represent a
-- repeating decimal, so it truncates the quotient to 16 fractional digits, and the
-- product of that truncated quotient lands just BELOW an exact half-øre instead of on
-- it. One trip, 90 km, two participants, one fill of 221,43 kr: each share is
-- 45 × (221,43 / 90) = exactly 110,715 kr, a true tie.
--
--   Postgres  221.43 / 90.0 -> 2.4603333333333333 (truncated), × 45.0
--             = 110.7149999999999985  ->  110,71 kr
--   Client    221.43 / 90   -> 2.4603333333333332611 (double), × 45
--             = 110.71500000000000341, × 100 = 11071.5 exactly  ->  110,72 kr
--
-- Both engines round half away from zero. They simply disagree about which side of the
-- half the product is on, and the divide-then-multiply order is what puts it there.
-- Sofie's phone says she is owed 110,71 kr and the server-derived settlement request
-- says 110,72 kr, on every exact tie, forever. Reproduce on the pre-196 schema with
--   node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 42 \
--     --oracle-every 25 --epoch 2026-05-26 --sessions 2 --headless
-- which reports it once (workspace 2, tick 50: tripCost 642,53 client vs 642,52
-- server, and the member's net one øre the other way).
--
-- THE FIX is one expression, twice: round(pm.km * t.total_paid / t.total_km, 2) --
-- multiply first. Numeric multiplication is exact, so the full-precision product
-- 221.43 × 45.0 = 9964.35 is divided by 90.0 to exactly 110.715, which rounds to
-- 110,72 and agrees with the client. It does not make the two engines PROVABLY
-- identical -- the client is still a double and a double cannot hold every decimal --
-- but it removes the systematic half-øre case, which is the one that recurs, and it is
-- the one that recurs precisely because a group splitting a fill evenly between two or
-- three drivers hits exact ties all the time.
--
-- WHAT CHANGES AND WHAT DOES NOT. calculate_period_settlement is re-declared COMPLETELY
-- off migration 194 (its newest prior definition -- 054, 055, 068, 070, 107, 108, 112,
-- 114, 157 and 194 all declare it, and nothing after 194 touches it), byte-for-byte bar
-- two occurrences of the same expression and the in-body comment that described the old
-- one:
--
--   1. 'tripCost' -- the per-member fuel share the app prints.
--   2. the tripCost term INSIDE the totalKm > 0 branch of 'net', which recomputes the
--      same share inline. Both must move together or `net` stops equalling
--      fuelPaid + … − tripCost − shares by an øre, which is a worse bug than the one
--      being fixed.
--
-- 'fuelRate' -- round(t.total_paid / t.total_km, 2) -- is deliberately LEFT ALONE. It
-- is a different quantity (kr per km, displayed), it is not multiplied by anything, and
-- there is no multiply to move in front of the divide. The zero-km branches are
-- untouched: at totalKm = 0 tripCost is 0 and there is nothing to round.
--
-- WHO DEPENDS ON THIS. The mobile client's settlement-calc.ts is UNCHANGED and is the
-- reference the fix moves toward, so no client work is needed and no old client
-- regresses: the close's per-member 0,02 kr integrity gate already absorbed the one-øre
-- disagreement in both directions, which is why this was never able to block a close
-- and why nobody saw it. The direction of the change is server-toward-client, so a
-- client that was one øre high is now agreed with rather than newly contradicted.
-- Migration 194's carry-forward, its deferredFuel block and its zero-km branch are
-- carried through verbatim, and tools/test-zero-km-fuel-carryforward-contract.mjs pins
-- them (its pin on the totalKm > 0 branch is updated to the new expression -- it tracks
-- the live definition, it does not freeze 157).
--
-- No schema change, no new table, no column, no grant change, no policy change, no new
-- event type, no RPC signature change (the return stays jsonb, so types/database.ts is
-- unchanged and neither client repo needs to re-vendor). GDPR: nothing stored, nothing
-- logged, one arithmetic expression.

-- ── calculate_period_settlement — re-declared off migration 194 ────────────────
-- Migration 194 VERBATIM except for the two tripCost expressions marked GV-477 below
-- and the comment above `net`, which described the old order. Every CTE -- the km
-- shares, the expense, repair and crossing largest-remainder chains, the GV-274
-- credit-only inactive payer rule, the GV-277 repair period scoping, 194's zero-km
-- branch and its conditional deferredFuel block -- is untouched. Signature unchanged,
-- so this stays a plain create-or-replace and the existing grants carry over.
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
        'tripCost', case when t.total_km > 0 then round(pm.km * t.total_paid / t.total_km, 2) else 0 end,
        -- GV-477. BOTH tripCost expressions -- the printed one above and the copy the
        -- then-branch recomputes inline below -- multiply BEFORE they divide:
        -- round(km * totalPaid / totalKm, 2), never round(km * (totalPaid / totalKm), 2).
        -- Numeric division truncates a repeating quotient to 16 fractional digits, which
        -- drops an exact half-oere tie just BELOW the half: the old order rounded
        -- 45 x 221,43 / 90 down to 110,71 while the client's double rounded the same tie
        -- up to 110,72 -- one oere of standing disagreement between a member's phone and
        -- the settlement request (GV-471-F2). The two expressions must move together:
        -- `net` subtracts its own copy of the share, so one of them lagging behind the
        -- other is an oere of self-disagreement, which is worse than the bug being
        -- fixed. Apart from those two, the then-branch is migration 194's, which was
        -- migration 157's.
        -- GV-472. The else branch is the zero-km fix. It no longer carries pm.fuel_paid. At zero km a
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
                    then round(pm.fuel_paid + pm.expense_paid + pm.repair_paid + pm.crossing_paid - round(pm.km * t.total_paid / t.total_km, 2) - pm.expense_share - pm.repair_share - pm.crossing_share, 2)
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


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '196_trip_cost_multiply_first',
  'Per-member tripCost multiplies before it divides, so an exact half-oere tie rounds the way the app rounds it (GV-477; the bug is GV-471-F2, the second finding the deterministic simulator produced and the first from its client-parity oracle). THE DEFECT: calculate_period_settlement computed a member''s share of the period''s fuel as round(pm.km * (t.total_paid / t.total_km), 2) -- divide FIRST. Postgres numeric division cannot represent a repeating decimal, so it truncates the quotient to 16 fractional digits, and the product of that truncated quotient lands just BELOW an exact half-oere instead of on it. One trip of 90 km with two participants and one fill of 221,43 kr gives each of them 45 x (221,43 / 90) = exactly 110,715 kr, a true tie: Postgres computes 221.43 / 90.0 -> 2.4603333333333333, x 45.0 = 110.7149999999999985 -> 110,71 kr, while the client computes the same quotient in a double (2.4603333333333332611), x 45 = 110.71500000000000341, x 100 = 11071.5 exactly -> 110,72 kr. Both engines round half away from zero; they disagree only about which side of the half the product is on, and the divide-then-multiply order is what puts it there. A member''s phone therefore printed 110,71 kr where the server-derived settlement request printed 110,72 kr, on every exact tie, systematically -- and exact ties are common precisely because a group splitting one fill evenly between two or three drivers hits them all the time. Never seen in production because the close''s integrity gate allows 0,02 kr per member, so no close could be blocked by it and the period still netted to zero on both sides; found instead by tools/simulator (seed 42, 400 ticks, 4 workspaces, epoch 2026-05-26: workspace 2, tick 50, tripCost 642,53 client vs 642,52 server with the member''s net one oere the other way), which compares the mobile client''s own settlement code against the RPC row by row. THE FIX is one expression, appearing TWICE, and nothing else: round(pm.km * t.total_paid / t.total_km, 2) -- multiply first. Numeric multiplication is exact, so the full-precision product 221.43 x 45.0 = 9964.35 divided by 90.0 is exactly 110.715, which rounds to 110,72 and agrees with the client. It does not make the two engines PROVABLY identical (the client is still a double, and a double cannot hold every decimal) but it removes the systematic half-oere case, which is the one that recurs. The two places are (1) the printed ''tripCost'' key and (2) the tripCost term recomputed inline inside the totalKm > 0 branch of ''net''; they must move together, because net is fuelPaid + expensePaid + repairPaid + crossingPaid - tripCost - shares and one of them lagging the other would be an oere of self-disagreement inside a single payload, a worse bug than the one being fixed. ''fuelRate'' -- round(t.total_paid / t.total_km, 2) -- is deliberately LEFT ALONE: it is a different quantity (kr per km, displayed, never multiplied by a member''s kilometres) and there is no multiply to move in front of its divide. The zero-km branches are untouched: at totalKm = 0 tripCost is 0 and there is nothing to round. calculate_period_settlement is re-declared COMPLETELY off migration 194 (its newest prior definition -- 054, 055, 068, 070, 107, 108, 112, 114, 157 and 194 declare it and nothing after 194 touches it), byte-for-byte bar those two expressions and the in-body comment that described the old order; 194''s zero-km carry-forward branch, its conditional deferredFuel block, the largest-remainder integer-oere chains for expenses, repairs and crossings, the GV-274 credit-only inactive-payer rule and the GV-277 repair period scoping are all carried through verbatim. Signature unchanged, so a plain create-or-replace suffices, the existing grants carry over and no PGRST203 candidate is left behind. WHO DEPENDS ON THIS: the mobile client''s settlement-calc.ts is UNCHANGED and is the reference this fix moves toward, so no client work is required and no old client regresses -- the close''s per-member 0,02 kr gate already absorbed the one-oere disagreement in both directions, and the direction of travel is server-toward-client, so a client that was one oere high is now agreed with rather than newly contradicted. tools/test-zero-km-fuel-carryforward-contract.mjs pins the totalKm > 0 branch of net and its pin is updated to the new expression (it tracks the live definition, it does not freeze migration 157); the simulator''s KNOWN_FINDINGS registry is emptied, GV-471-F2 moving to the README''s Fixed section, so the same seed-42 run that reported one known finding now reports none and the parity oracle agreeing IS this migration''s verification. No schema change, no new table or column, no grant change, no policy or RLS change, no new event type and no RPC signature change (the return stays jsonb, so types/database.ts is unchanged and neither client repo needs to re-vendor). GDPR: nothing stored, nothing logged, one arithmetic expression. Depends on 194 (the definition it re-declares) and 157 (the crossing split that 194 carried forward).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

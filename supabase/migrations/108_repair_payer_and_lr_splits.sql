-- Migration 108: repair payer + largest-remainder splits + repair validation (GV-269)
--
-- Three locked decisions (Codex review 2026-07-11):
--
--   1. Repairs get a PAYER. vehicle_repairs.paid_by_member_id names who paid the
--      workshop bill; it backfills to the logger (created_by_member_id) and the
--      settlement reads coalesce(paid_by_member_id, created_by_member_id) so
--      pre-108 rows and clients keep working — no not-null constraint. Per the
--      2026-07-10 any-member-attribution decision, a member may name any ACTIVE
--      member of the workspace as payer.
--
--   2. Splits move to the LARGEST-REMAINDER algorithm. The 068/107 pattern rounds
--      each member's share of each item independently, so a 100 kr item over 3
--      members yields 3 x 33,33 = 99,99 while the payer is credited 100,00 —
--      six such repairs leave a 0,06 kr residual that breaks the close-integrity
--      gate's 0,05 tolerance. Largest remainder works per item in integer oere:
--      floor every member's exact share, then hand the leftover oere (R = item
--      total - sum of floors) to the R members with the largest remainders, ties
--      broken by member id ascending (uuid byte order = its canonical text
--      order). Per-item shares now sum EXACTLY to the item amount, always.
--      Applied to expense_share AND repair_share; the mobile settlement engine
--      (settlement-calc.ts, GVM-309) mirrors the identical algorithm.
--
--   3. Repairs scope to periods by created_at (when they were LOGGED), not
--      repair_date. repair_date is user-editable display data and may lie years
--      in the past, which under 107 silently dropped the repair from every
--      period. created_at is compared as a timestamp against the period's
--      [opened_at, closed_at) window — no ::date truncation.
--
-- insert_repair is re-declared off migration 105 (its newest prior definition)
-- with a trailing paid_by_member_id_value uuid param. Adding a parameter changes
-- the signature, so the 6-arg version is dropped first (create-or-replace cannot
-- widen a signature) and the grants are restated in full. Old clients calling by
-- named params keep working; the new param defaults to null = the actor pays.
-- Repairs are financial records now, so the RPC also gains validation (all
-- errcode 22023): trimmed description required and <= 500 chars (the trimmed
-- value is stored), cost required and > 0 (rounded to 2 decimals on insert; the
-- old coalesce-to-0 is gone), odometer >= 0 when present, repair_date within
-- [2000-01-01, current_date + 1 year] when present, workshop <= 120 chars after
-- btrim, and a non-null payer must be an ACTIVE member of the target workspace.
--
-- calculate_period_settlement is re-declared off migration 107 (its newest prior
-- definition). The trips/fuel math is untouched; the changes are (a) the
-- largest-remainder CTE chains expense_cents/expense_lr and repair_cents/
-- repair_lr replacing the per-member round() in expense_share/repair_share,
-- (b) the repair payer coalesce in period_repairs + repair_paid, and (c) the
-- created_at period scoping. Signature unchanged, so no drop is needed; grants
-- are restated anyway.

-- ── Repair payer column + backfill ──────────────────────────────────────────────
alter table public.vehicle_repairs
  add column if not exists paid_by_member_id uuid references public.ledger_members(id);

update public.vehicle_repairs
set paid_by_member_id = created_by_member_id
where paid_by_member_id is null;

-- ── insert_repair: payer param + financial validation ───────────────────────────
-- Re-declared off migration 105. Mirrors the "Creators and admins can insert
-- repairs" RLS policy: any active member may log a repair, always CREATED BY
-- themselves; the PAYER defaults to the actor but may be any active member of
-- the workspace (any-member attribution, decided 2026-07-10).
drop function public.insert_repair(text, date, text, numeric, integer, text);

create or replace function public.insert_repair(
  target_ledger_id text,
  repair_date_value date,
  description_value text,
  cost_dkk_value numeric,
  odo_km_value integer default null,
  workshop text default null,
  paid_by_member_id_value uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  resolved_payer_member_id uuid;
  clean_description text;
  clean_workshop text;
  result_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can log repairs' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  clean_description := nullif(btrim(description_value), '');
  if clean_description is null then
    raise exception 'Repair description is required' using errcode = '22023';
  end if;
  if length(clean_description) > 500 then
    raise exception 'Repair description must be 500 characters or fewer' using errcode = '22023';
  end if;

  -- Repairs are financial records (GVM-307 folds them into the settlement), so a
  -- missing or non-positive cost is rejected rather than coalesced to 0.
  if cost_dkk_value is null or cost_dkk_value <= 0 then
    raise exception 'Repair cost must be greater than zero' using errcode = '22023';
  end if;

  if odo_km_value is not null and odo_km_value < 0 then
    raise exception 'Odometer reading cannot be negative' using errcode = '22023';
  end if;

  if repair_date_value is not null
     and (repair_date_value < date '2000-01-01'
          or repair_date_value > current_date + interval '1 year') then
    raise exception 'Repair date is out of range' using errcode = '22023';
  end if;

  clean_workshop := nullif(btrim(workshop), '');
  if clean_workshop is not null and length(clean_workshop) > 120 then
    raise exception 'Workshop name must be 120 characters or fewer' using errcode = '22023';
  end if;

  -- Payer: null means the actor paid. A named payer must be an ACTIVE member of
  -- THIS workspace — an inactive or foreign member is rejected, mirroring how the
  -- settlement skips repairs whose payer is not active.
  if paid_by_member_id_value is not null then
    if not exists (
      select 1
      from public.ledger_members lm
      where lm.id = paid_by_member_id_value
        and lm.ledger_id = target_ledger_id
        and lm.is_active = true
    ) then
      raise exception 'Payer must be an active member of this workspace' using errcode = '22023';
    end if;
  end if;
  resolved_payer_member_id := coalesce(paid_by_member_id_value, actor_member_id);

  insert into public.vehicle_repairs (
    ledger_id, repair_date, description, cost_dkk, odo_km, workshop,
    created_by_member_id, paid_by_member_id
  ) values (
    target_ledger_id,
    coalesce(repair_date_value, current_date),
    clean_description,
    round(cost_dkk_value, 2),
    odo_km_value,
    clean_workshop,
    actor_member_id,
    resolved_payer_member_id
  )
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

revoke all on function public.insert_repair(text, date, text, numeric, integer, text, uuid) from public;
revoke all on function public.insert_repair(text, date, text, numeric, integer, text, uuid) from anon;
grant execute on function public.insert_repair(text, date, text, numeric, integer, text, uuid) to authenticated;

-- ── calculate_period_settlement: LR splits + repair payer + created_at scoping ──
-- Re-declared off migration 107 (the newest prior definition). Trips/fuel CTEs
-- are byte-identical to 107; expense_share and repair_share now distribute via
-- the largest-remainder chain (expense_cents/expense_lr, repair_cents/repair_lr),
-- period_repairs/repair_paid credit coalesce(paid_by_member_id,
-- created_by_member_id), and repairs scope by created_at (GV-269).
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
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
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
    -- Repairs have no period_id: a repair counts in the period whose
    -- [opened_at, closed_at) window contains its created_at — the moment it was
    -- LOGGED (GV-269; repair_date is display-only and may lie far in the past).
    -- The settling period is still open here (closed_at null), so its window has
    -- no upper bound.
    select sp.opened_at, sp.closed_at
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is an active member (an expense
    -- with no active payer is skipped entirely, matching the client).
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join active_members payer on payer.id = we.paid_by_member_id
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
    -- (GV-269); a repair whose payer is not an active member is skipped
    -- entirely, exactly like an expense. Scoped by created_at (timestamps, no
    -- ::date truncation) within the period's [opened_at, closed_at) window.
    select vr.id,
           vr.cost_dkk,
           coalesce(vr.paid_by_member_id, vr.created_by_member_id) as payer_member_id,
           rm.mode
    from public.vehicle_repairs vr
    cross join repairs_mode rm
    cross join period_bounds pb
    join active_members payer on payer.id = coalesce(vr.paid_by_member_id, vr.created_by_member_id)
    where vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.cost_dkk > 0
      and rm.mode in ('efter_koersel', 'ligeligt')
      and vr.created_at >= pb.opened_at
      and (pb.closed_at is null or vr.created_at < pb.closed_at)
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
  per_member as (
    select am.id,
           am.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share,
           round(coalesce(rp.paid, 0), 2) as repair_paid,
           round(coalesce(rs.share, 0), 2) as repair_share
    from active_members am
    left join member_km mk on mk.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
    left join expense_paid xp on xp.member_id = am.id
    left join expense_share xs on xs.member_id = am.id
    left join repair_paid rp on rp.member_id = am.id
    left join repair_share rs on rs.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses,
           coalesce(sum(pm.repair_paid), 0) as total_repairs
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'totalRepairs', t.total_repairs,
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
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid + pm.repair_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share - pm.repair_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid + pm.repair_paid - pm.expense_share - pm.repair_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('108_repair_payer_and_lr_splits',
        'Repair payer + largest-remainder splits + repair validation (GV-269). vehicle_repairs.paid_by_member_id added (backfilled to created_by_member_id; settlement reads the coalesce). insert_repair re-declared off 105 (6-arg dropped, trailing paid_by_member_id_value uuid param) with financial validation: trimmed description required <= 500 chars, cost required > 0 (rounded to 2 decimals), odometer >= 0, repair_date within [2000-01-01, today + 1 year], workshop <= 120 chars, payer must be an active member of the workspace. calculate_period_settlement re-declared off 107: expense_share and repair_share now use per-item largest-remainder distribution in integer oere (floor + remainder rank, ties by member id ascending) so every item''s shares sum exactly to its amount; repairs credit coalesce(paid_by_member_id, created_by_member_id) and scope by created_at within the period''s [opened_at, closed_at) window instead of repair_date. Mirrored by the mobile settlement engine (GVM-309).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

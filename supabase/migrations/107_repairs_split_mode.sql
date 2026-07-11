-- Migration 107: repairs split per workspace rule (GVM-307)
--
-- Product decision (owner, 2026-07-10): repairs logged in Reparationshistorik can
-- be folded into the period settlement, governed by ONE workspace-level rule
-- "Reparationer deles" with three modes. Per-entry split toggles were rejected.
--
--   * efter_koersel — split by each member's km share for the period, exactly the
--     way fuel tripCost / the expense `usage` rule already weight members.
--   * ligeligt (DEFAULT) — split equally among the active members.
--   * deles_ikke — repairs are excluded from settlement entirely.
--
-- The payer of a repair is credited its full cost, then every active member is
-- debited their split share — the same payer-credit / split-debit shape expenses
-- already use (migration 068). A repair whose payer is NOT an active member is
-- skipped entirely, matching how an expense with no active payer is skipped.
--
-- v1 ASSUMPTION (documented, no schema change): vehicle_repairs has no paid_by
-- column, so the repair's LOGGER — vehicle_repairs.created_by_member_id — is
-- treated as its payer. A dedicated payer column is deferred.
--
-- Period scoping: vehicle_repairs has no period_id (unlike trips/fuel/expenses),
-- so a repair counts in the period whose window contains its repair_date —
-- repair_date >= period.opened_at (date) and, for an already-closed period,
-- < period.closed_at (date). The settling (open) period has closed_at = null, so
-- its window is simply repair_date >= opened_at — the only window that matters for
-- the close-integrity parity check, which runs while the period is still open.
--
-- CRITICAL PARITY (GVM-307): calculate_period_settlement's per-member net feeds
-- BOTH the stale-pair sweep (migration 104) AND the close-period integrity gate
-- (migration 101/104), which reconciles the CLIENT snapshot's nets against these
-- server nets. The mobile settlement engine (settlement-calc.ts) mirrors this
-- repairs math per mode exactly; both are verified against the shared fixture
-- below. Rounding, active-member scoping, and the zero-weight fallback copy the
-- expense conventions (migration 068) verbatim so the two sides never disagree.
--
-- ── Shared fixture (asserted in govehlo-mobile settlement-calc vitest) ────────
-- Active members A/B/C with uneven km 60/30/10 (total 100); C's id also stands in
-- for the split universe. Fuel: A paid 200 kr for the 100 km → fuelRate 2,00
-- kr/km, so tripCost A=120 B=60 C=20. Two repairs: R1 cost 300 paid by A
-- (active); R2 cost 150 paid by D, a member INACTIVE at close — R2 is excluded in
-- every mode (payer not active). Nets per mode (each column sums to 0):
--
--   mode           | A net  | B net  | C net  | repairs folded
--   ---------------+--------+--------+--------+------------------------------
--   deles_ikke     |  +80   |  -60   |  -20   | none (R1, R2 both excluded)
--   ligeligt       | +280   | -160   | -120   | R1 split 100/100/100, A +300
--   efter_koersel  | +200   | -150   |  -50   | R1 split 180/90/30, A +300
--
--   deles_ikke:    net = fuelPaid − tripCost
--                  A 200−120=+80   B 0−60=−60   C 0−20=−20
--   ligeligt:      net = fuelPaid + repairPaid − tripCost − repairShare
--                  A 200+300−120−100=+280   B 0−60−100=−160   C 0−20−100=−120
--   efter_koersel: repair 300 by km 60/30/10 → 180/90/30
--                  A 200+300−120−180=+200   B 0−60−90=−150   C 0−20−30=−50
--
-- An absent repairs_split_mode column (old DB, this migration unapplied) makes the
-- client fall back to EXCLUDING repairs (deles_ikke), matching the pre-107 server
-- that never saw repairs — so mobile can merge ahead of the SQL being applied.

-- ── Workspace rule column ────────────────────────────────────────────────────
-- Default 'ligeligt' so applying this migration begins folding repairs equally for
-- every workspace; an operator/admin can switch to efter_koersel or deles_ikke.
alter table public.ledgers
  add column if not exists repairs_split_mode text not null default 'ligeligt'
    check (repairs_split_mode in ('efter_koersel', 'ligeligt', 'deles_ikke'));

-- ── update_ledger_settings: accept repairs_split_mode ────────────────────────
-- Re-declared off migration 078 (newest prior body) with ONE new trailing param,
-- repairs_split_mode_value, validated against the three modes and written via the
-- same coalesce-patch path as settlement_mode. Adding a parameter changes the
-- signature, so the old 4-arg function is dropped first (create-or-replace cannot
-- widen a signature); the new param defaults to null, so existing 4-arg callers
-- resolve to this one function with no ambiguity.
drop function if exists public.update_ledger_settings(text, text, jsonb, jsonb);

create or replace function public.update_ledger_settings(
  target_ledger_id text,
  settlement_mode_value text default null,
  expense_split_defaults_value jsonb default null,
  vehicle_info_value jsonb default null,
  repairs_split_mode_value text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update workspace settings' using errcode = '42501';
  end if;

  if settlement_mode_value is not null
     and settlement_mode_value not in ('monthly', 'running') then
    raise exception 'Invalid settlement mode' using errcode = '22023';
  end if;

  if repairs_split_mode_value is not null
     and repairs_split_mode_value not in ('efter_koersel', 'ligeligt', 'deles_ikke') then
    raise exception 'Invalid repairs split mode' using errcode = '22023';
  end if;

  update public.ledgers set
    settlement_mode        = coalesce(settlement_mode_value, settlement_mode),
    expense_split_defaults = coalesce(expense_split_defaults_value, expense_split_defaults),
    vehicle_info           = coalesce(vehicle_info_value, vehicle_info),
    repairs_split_mode     = coalesce(repairs_split_mode_value, repairs_split_mode),
    updated_at             = now()
  where id = target_ledger_id;
end;
$$;

revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb, text) from public;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb, text) from anon;
grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb, text) to authenticated;

-- ── calculate_period_settlement: fold repairs per workspace mode ─────────────
-- Re-declared off migration 070 (the newest prior definition — 083 only
-- re-grants; 087/101/104 re-declare close/upsert, not this). The trips/fuel/
-- expense math is byte-identical to 070; the ONLY additions are the repairs CTEs
-- (period_repairs / repair_weights / repair_weight_totals / repair_share /
-- repair_paid), the repair_paid/repair_share per_member columns + totalRepairs,
-- and repairPaid/repairShare/net folding repairs in. deles_ikke or a null mode
-- yields no period_repairs, so net is unchanged.
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
    -- Repairs are date-scoped (no period_id): a repair counts in the period whose
    -- [opened_at, closed_at) date window contains repair_date. The settling period
    -- is still open here (closed_at null), so its window has no upper bound.
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
  expense_share as (
    select ew.member_id,
           sum(
             case when ewt.total_weight > 0
                  then round(ew.amount_dkk * ew.weight / ewt.total_weight, 2)
                  else round(ew.amount_dkk / ewt.member_count, 2)
             end
           ) as share
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
    group by ew.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  period_repairs as (
    -- Repairs folded per the workspace mode (GVM-307). Only efter_koersel /
    -- ligeligt fold; deles_ikke (or a null mode) yields no rows. The logger
    -- (created_by_member_id) is treated as the payer (v1); a repair whose payer is
    -- not an active member is skipped entirely, exactly like an expense.
    select vr.id,
           vr.cost_dkk,
           vr.created_by_member_id,
           rm.mode
    from public.vehicle_repairs vr
    cross join repairs_mode rm
    cross join period_bounds pb
    join active_members payer on payer.id = vr.created_by_member_id
    where vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.cost_dkk > 0
      and rm.mode in ('efter_koersel', 'ligeligt')
      and vr.repair_date >= pb.opened_at::date
      and (pb.closed_at is null or vr.repair_date < pb.closed_at::date)
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
  repair_share as (
    select rw.member_id,
           sum(
             case when rwt.total_weight > 0
                  then round(rw.cost_dkk * rw.weight / rwt.total_weight, 2)
                  else round(rw.cost_dkk / rwt.member_count, 2)
             end
           ) as share
    from repair_weights rw
    join repair_weight_totals rwt using (repair_id)
    group by rw.member_id
  ),
  repair_paid as (
    select pr.created_by_member_id as member_id, sum(pr.cost_dkk)::numeric as paid
    from period_repairs pr
    group by pr.created_by_member_id
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('107_repairs_split_mode',
        'Repairs split per workspace rule (GVM-307). ledgers.repairs_split_mode (efter_koersel|ligeligt|deles_ikke, default ligeligt). calculate_period_settlement re-declared off 070 folds vehicle_repairs per mode: the logger (created_by_member_id) is credited as payer (v1, no paid_by column), each active member debited their split share (efter_koersel = km weights, ligeligt = equal, deles_ikke/null = excluded); repairs are date-scoped by repair_date within the period''s [opened_at, closed_at) window. update_ledger_settings re-declared off 078 (4-arg dropped, new trailing repairs_split_mode_value param, validated). Client settlement-calc.ts mirrors the math; both verified against a shared fixture (see header).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

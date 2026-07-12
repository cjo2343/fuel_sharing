-- Migration 114: repair↔period binding + payer-deactivation recurring suspension (GV-277)
--
-- Two Codex 2026-07-12 hardening items for repairs and recurring templates:
--
--   A) Repair/close race. Repairs had NO period_id — every consumer scoped them
--      to a period by created_at (calculate_period_settlement 112, the entry
--      fingerprint 112, the enforce_repair_period_lock trigger 112). A repair
--      logged in the same instant a close runs could therefore be scoped
--      ambiguously (the settlement and the fingerprint each recompute the set
--      independently). This binds a repair to its period AT INSERT:
--        * vehicle_repairs.period_id (nullable FK, on delete set null) is added.
--        * insert_repair (off 108) takes the SAME ledger advisory lock the close
--          uses — the BLOCKING variant pg_advisory_xact_lock(hashtext(ledger_id))
--          so a repair insert QUEUES behind an in-flight close (which holds the
--          lock via pg_try_advisory_xact_lock and would reject a concurrent writer
--          otherwise), then resolves the ledger's open period and stamps period_id.
--          A repair therefore lands in exactly the period that was open when it was
--          logged, never straddling a close.
--        * calculate_period_settlement (off 112) and calculate_period_entry_fingerprint
--          (off 112) scope repairs by period_id, falling back to the 112 created_at
--          window ONLY for legacy null-period rows (pre-114). For a stamped row the
--          two agree by construction (created_at is inside the period that was open
--          at insert), so the client — which still scopes by created_at
--          (scopeRepairsToPeriod) — stays in lockstep with the server.
--        * close_settlement_period (off 104) stamps period_id on the closing
--          period's remaining legacy null-period repairs BEFORE it flips the period
--          to closed (so enforce_repair_period_lock still permits the write), making
--          period_id authoritative for every repair once a period is closed.
--        * The entry fingerprint's repair component becomes id+amount PAIRS
--          (["<id>",<oere>]) instead of bare ids — a financial revision, so editing
--          a repair's COST now busts a prepared close (repairs move neither totalKm
--          nor totalPaid, so the amount guard never caught a repair-cost edit). oere
--          integers serialise byte-identically in Postgres and JS; the client
--          (src/lib/period-snapshot.ts, GVM PR) mirrors the exact format. The
--          "repairs" key is still omitted when the period has no in-scope repair, so
--          a repair-free period keeps its pre-114 trips/fuel/expenses string.
--
--   B) Recurring templates on payer deactivation. Deactivating a member left their
--      recurring-expense templates active, so the generators kept materialising
--      expenses charged to an inactive payer (credit-only in the settlement since
--      112) — silently distorting balances. set_ledger_member_active_admin (off 012)
--      now, on deactivation, suspends (is_active = false) every recurring template
--      the member pays for and writes a 'recurring_suspended' ledger_events row (in
--      Danish, naming the templates) so admins get an action item to reassign the
--      payer or delete the template. Both generators (off 112) additionally guard
--      payer activity — they skip a template whose payer is a known inactive member
--      — as defense in depth (member_is_active_in_ledger returns true for a null
--      payer, so legacy null-payer templates are unaffected).
--
-- Every re-declared function is based on its NEWEST prior definition, verified by
-- grepping every migration: insert_repair 108, calculate_period_settlement 112,
-- calculate_period_entry_fingerprint 112, close_settlement_period 104,
-- set_ledger_member_active_admin 012, both generators 112.

-- ── A.1: repair → period binding column ─────────────────────────────────────────
-- Nullable so pre-114 rows keep a null period_id (scoped by created_at until a
-- close stamps them). on delete set null so dropping a period never deletes repair
-- history — the created_at fallback then re-scopes the row.
alter table public.vehicle_repairs
  add column if not exists period_id uuid references public.settlement_periods(id) on delete set null;

-- ── A.2: insert_repair — ledger advisory lock + period_id stamp ──────────────────
-- Re-declared off migration 108 (its newest prior definition). The validation,
-- payer resolution and grants are 108 verbatim; the only additions (GV-277) are the
-- blocking ledger advisory lock (shared with close_settlement_period so a repair
-- insert and a close can never interleave) and resolving + stamping the open
-- period's id. Signature is unchanged, so this is a plain create-or-replace.
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
  resolved_period_id uuid;
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

  -- GV-277: take the SAME ledger advisory lock close_settlement_period uses. The
  -- BLOCKING variant queues this insert behind an in-flight close (which holds the
  -- lock and rejects concurrent writers via its own pg_try_advisory_xact_lock), so a
  -- repair can never be logged into a period mid-close. The lock is re-entrant
  -- within a transaction, so an RPC that already holds it (or a later close in the
  -- same txn) is unaffected. Then stamp the id of the ledger's currently OPEN period
  -- (if any) so the repair is bound to exactly the period that was open when it was
  -- logged; a null (no open period, e.g. the brief post-close gap) falls back to the
  -- created_at scoping in the settlement/fingerprint.
  perform pg_advisory_xact_lock(hashtext(target_ledger_id));

  select sp.id
    into resolved_period_id
    from public.settlement_periods sp
    where sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    order by sp.opened_at desc
    limit 1;

  insert into public.vehicle_repairs (
    ledger_id, repair_date, description, cost_dkk, odo_km, workshop,
    created_by_member_id, paid_by_member_id, period_id
  ) values (
    target_ledger_id,
    coalesce(repair_date_value, current_date),
    clean_description,
    round(cost_dkk_value, 2),
    odo_km_value,
    clean_workshop,
    actor_member_id,
    resolved_payer_member_id,
    resolved_period_id
  )
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

revoke all on function public.insert_repair(text, date, text, numeric, integer, text, uuid) from public;
revoke all on function public.insert_repair(text, date, text, numeric, integer, text, uuid) from anon;
grant execute on function public.insert_repair(text, date, text, numeric, integer, text, uuid) to authenticated;

-- ── A.3: calculate_period_settlement — repair scoping by period_id ──────────────
-- Re-declared off migration 112 (its newest prior definition). Everything — the
-- trips/fuel maths, the largest-remainder splits, and the credit-only inactive
-- payer rule — is 112 verbatim. The ONLY change (GV-277) is the period_repairs
-- scope predicate: a repair belongs to this period when vr.period_id equals it, or
-- (legacy null-period rows only) when its created_at falls in the period's
-- [opened_at, closed_at) window. Signature unchanged; grants restated.
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
  settlement_members as (
    -- The settlement participant set (GV-274): every ACTIVE member, plus any
    -- member (necessarily inactive, since actives are already in) who PAID fuel,
    -- an expense, or a repair this period. Inactive payers are credit-only — they
    -- appear so they can be credited what they paid, but they carry zero weight in
    -- every share split (the weight CTEs cross join active_members only), so their
    -- net is exactly +paid. An inactive member who paid nothing never appears.
    select am.id, am.name
    from all_members am
    where am.is_active
       or am.id in (select fp.member_id from fuel_paid fp)
       or am.id in (select ep.member_id from expense_paid ep)
       or am.id in (select rp.member_id from repair_paid rp)
  ),
  per_member as (
    select sm.id,
           sm.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share,
           round(coalesce(rp.paid, 0), 2) as repair_paid,
           round(coalesce(rs.share, 0), 2) as repair_share
    from settlement_members sm
    left join member_km mk on mk.member_id = sm.id
    left join fuel_paid f on f.member_id = sm.id
    left join expense_paid xp on xp.member_id = sm.id
    left join expense_share xs on xs.member_id = sm.id
    left join repair_paid rp on rp.member_id = sm.id
    left join repair_share rs on rs.member_id = sm.id
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

-- ── A.4: calculate_period_entry_fingerprint — period_id scope + id+amount pairs ──
-- Re-declared off migration 112 (its newest prior definition). Trips/fuel/expenses
-- are 112 verbatim. Two GV-277 changes to the repair component: (1) scope by
-- period_id, falling back to the 112 created_at window for legacy null-period rows;
-- (2) emit id+amount PAIRS (["<id>",<oere>]) instead of bare ids so a repair-cost
-- edit — which moves neither totalKm nor totalPaid, and so slips the amount guard —
-- busts a prepared close. oere integers (round(cost*100)) serialise byte-identically
-- in Postgres and JS; the client (periodEntryFingerprint) mirrors the exact format.
-- The "repairs" key is still omitted when the period has no in-scope repair, so a
-- repair-free period keeps its pre-114 trips/fuel/expenses string.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result text;
  repairs_json text;
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

  -- Repairs are scoped by period_id (GV-277); a legacy null-period row (pre-114)
  -- falls back to created_at within the period's [opened_at, closed_at) window,
  -- exactly as calculate_period_settlement scopes them. During a close the period is
  -- still open (closed_at null), so the window has no upper bound. Each repair is
  -- emitted as an ["<id>",<oere>] pair so a cost edit changes the fingerprint; the
  -- empty string yields no "repairs" key below.
  select coalesce(
           string_agg(
             '[' || to_json(vr.id::text)::text || ',' || round(vr.cost_dkk * 100)::bigint::text || ']',
             ',' order by vr.id::text collate "C"),
           '')
    into repairs_json
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
      );

  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || '],"expenses":['
    || coalesce((
         select string_agg(to_json(we.id::text)::text, ',' order by we.id::text collate "C")
         from public.workspace_expenses we
         where we.ledger_id = target_ledger_id
           and we.period_id = target_period_id
           and we.deleted_at is null
       ), '')
    || ']'
    || case when repairs_json <> '' then ',"repairs":[' || repairs_json || ']' else '' end
    || '}'
  into result;

  return result;
end;
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── A.5: close_settlement_period — stamp legacy repairs before closing ──────────
-- Re-declared off migration 104 (its newest prior definition). The integrity gate,
-- require-requests coverage, duplicate guard, close/open and event are 104 verbatim.
-- The only GV-277 addition is one UPDATE: while the period is still OPEN (so
-- enforce_repair_period_lock permits the write), stamp period_id = target_period_id
-- on the period's remaining legacy null-period repairs (matched by the same
-- created_at window the settlement/fingerprint use), so period_id is authoritative
-- for every repair once the period is closed. New repairs already carry period_id
-- (insert_repair, under the same advisory lock this RPC holds). Signature and grants
-- unchanged.
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

  -- GV-277: bind this period's remaining legacy null-period repairs to it BEFORE
  -- the period flips to closed, so enforce_repair_period_lock (which freezes a
  -- repair once its period is closed) still permits this write. A stamped repair
  -- already carries period_id from insert_repair; only pre-114 rows are updated
  -- here, matched by the same created_at window the settlement/fingerprint use.
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

-- ── B.1: set_ledger_member_active_admin — suspend the payer's recurring templates ──
-- Re-declared off migration 012 (its newest prior definition). The admin gate,
-- self-deactivation guard, member update and last-admin guard are 012 verbatim. The
-- GV-277 addition: when the member is being DEACTIVATED, suspend (is_active = false)
-- every recurring-expense template they PAY for and write a 'recurring_suspended'
-- ledger_events row (Danish, naming the templates) so admins get an action item to
-- reassign the payer or delete the template. This runs after the last-admin guard,
-- so a rejected deactivation rolls the suspension back with the rest of the txn.
create or replace function public.set_ledger_member_active_admin(
  target_ledger_id text default 'main-car',
  target_member_id uuid default null,
  member_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_member public.ledger_members%rowtype;
  active_admin_count integer := 0;
  suspended_count integer := 0;
  suspended_names text;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can activate or deactivate members' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not identify the current ledger admin' using errcode = '42501';
  end if;

  if target_member_id is null then
    raise exception 'Member id is required' using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  select * into existing_member
  from public.ledger_members
  where id = target_member_id and ledger_id = target_ledger_id
  for update;

  if existing_member.id is null then
    raise exception 'Member does not belong to this ledger' using errcode = '23503';
  end if;

  if existing_member.id = actor_member_id and member_is_active is false then
    raise exception 'Admins cannot deactivate themselves' using errcode = '42501';
  end if;

  update public.ledger_members
  set is_active = coalesce(member_is_active, true), updated_at = now()
  where id = target_member_id and ledger_id = target_ledger_id;

  select count(*) into active_admin_count
  from public.ledger_members
  where ledger_id = target_ledger_id and is_active = true and role = 'admin';

  if active_admin_count < 1 then
    raise exception 'At least one active admin is required' using errcode = '23514';
  end if;

  -- GV-277: on deactivation, suspend every recurring template the member fronts.
  -- Left active, the generators would keep charging an inactive payer (credit-only
  -- in the settlement since 112), silently distorting balances. The event gives
  -- admins an action item to reassign the payer or delete the template.
  if coalesce(member_is_active, true) is false then
    with suspended as (
      update public.recurring_expenses re
      set is_active = false, updated_at = now()
      where re.ledger_id = target_ledger_id
        and re.paid_by_member_id = target_member_id
        and re.is_active = true
        and re.deleted_at is null
      returning re.description, re.category
    )
    select count(*),
           string_agg(coalesce(nullif(btrim(s.description), ''), initcap(s.category)),
                      ', ' order by coalesce(nullif(btrim(s.description), ''), initcap(s.category)))
      into suspended_count, suspended_names
      from suspended s;

    if suspended_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, target_member_id, metadata
      ) values (
        target_ledger_id,
        'recurring_suspended',
        'Faste udgifter sat på pause',
        coalesce(existing_member.name, 'Et medlem')
          || ' blev deaktiveret, så deres faste udgifter blev sat på pause: '
          || suspended_names
          || '. Vælg en ny betaler eller slet dem.',
        actor_member_id,
        nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
        target_member_id,
        jsonb_build_object('deactivated_member_id', target_member_id, 'suspended_count', suspended_count)
      );
    end if;
  end if;

  return target_member_id;
end;
$$;

revoke all on function public.set_ledger_member_active_admin(text, uuid, boolean) from public;
revoke all on function public.set_ledger_member_active_admin(text, uuid, boolean) from anon;
grant execute on function public.set_ledger_member_active_admin(text, uuid, boolean) to authenticated;

-- ── B.2: generate_due_recurring_expenses — skip inactive-payer templates ────────
-- Re-declared off migration 112 (its newest prior definition). Body is 112 verbatim
-- plus one GV-277 guard on the template scan: skip a template whose payer is a known
-- inactive member (defense in depth — set_ledger_member_active_admin already
-- suspends them, but a template edited to an inactive payer is caught here too).
-- member_is_active_in_ledger returns true for a null payer, so legacy null-payer
-- templates are unaffected.
create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  occurrences integer;
  total_generated integer := 0;
  -- Bound the per-template catch-up so one stale template can't materialise an
  -- unbounded backlog in a single run; the remainder catches up on later runs
  -- (GV-274). Same value in generate_all_due_recurring_expenses (the scheduler).
  max_catchup_occurrences constant integer := 24;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up. FOR SHARE serializes against a
  -- concurrent close (which exclusively locks the period row).
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1
  for share of sp;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
      and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;
    occurrences := 0;

    while due_date <= current_date and occurrences < max_catchup_occurrences loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
        open_period_id,
        tmpl.category,
        tmpl.description,
        tmpl.amount_dkk,
        due_date,
        tmpl.split_rule,
        tmpl.split_config,
        tmpl.paid_by_member_id,
        tmpl.created_by_member_id,
        tmpl.id,
        due_date
      )
      on conflict (recurring_expense_id, occurrence_date)
        where recurring_expense_id is not null do nothing
      returning id into inserted_id;

      if inserted_id is not null then
        template_count := template_count + 1;
      end if;
      inserted_id := null;
      occurrences := occurrences + 1;

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
        when 'semiannual' then due_date + interval '6 months'
        when 'yearly' then due_date + interval '1 year'
        else due_date + interval '1 month'
      end)::date;
    end loop;

    update public.recurring_expenses
      set next_due_date = due_date, last_generated_at = now(), updated_at = now()
    where id = tmpl.id;

    if template_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
      ) values (
        target_ledger_id,
        'expense_recurring_added',
        'Fast udgift tilføjet',
        coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
          || ' blev automatisk tilføjet og delt.',
        null,
        null,
        jsonb_build_object(
          'category', tmpl.category,
          'recurring_expense_id', tmpl.id,
          'count', template_count
        )
      );
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

revoke all on function public.generate_due_recurring_expenses(text) from public;
revoke all on function public.generate_due_recurring_expenses(text) from anon;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

-- ── B.3: generate_all_due_recurring_expenses — skip inactive-payer templates ────
-- Re-declared off migration 112 (its newest prior definition). Body is 112 verbatim
-- plus the same GV-277 payer-activity guard on BOTH the candidate-ledger scan (so a
-- ledger whose only due template has an inactive payer never occupies a batch slot)
-- and the inner template scan. Service-role only (grants restated).
create or replace function public.generate_all_due_recurring_expenses(
  batch_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  due_ledger record;
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  occurrences integer;
  ledger_generated integer;
  total_generated integer := 0;
  ledgers_touched integer := 0;
  ledgers_scanned integer := 0;
  -- Same per-template catch-up bound as generate_due_recurring_expenses (GV-274).
  max_catchup_occurrences constant integer := 24;
begin
  for due_ledger in
    -- Only ledgers with a due active template (with an active payer, GV-277) AND an
    -- open period to receive it, oldest debt first, so no-open-period ledgers never
    -- occupy a batch slot and the most overdue ledger is caught up first under
    -- batch_limit (GV-274).
    select r.ledger_id
    from public.recurring_expenses r
    where r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
      and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
      and exists (
        select 1
        from public.settlement_periods sp
        where sp.ledger_id = r.ledger_id
          and sp.status = 'open'
          and sp.closed_at is null
      )
    group by r.ledger_id
    order by min(r.next_due_date) asc, r.ledger_id
    limit greatest(coalesce(batch_limit, 200), 0)
  loop
    ledgers_scanned := ledgers_scanned + 1;

    -- Materialise into the ledger's open period. If none is open (a period close
    -- briefly precedes the next open), skip this ledger this run; the next tick catches
    -- up. FOR SHARE serializes against a concurrent close (which exclusively locks the
    -- period row).
    select sp.id into open_period_id
    from public.settlement_periods sp
    where sp.ledger_id = due_ledger.ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    order by sp.opened_at desc
    limit 1
    for share of sp;

    if open_period_id is null then
      open_period_id := null;
      continue;
    end if;

    ledger_generated := 0;

    for tmpl in
      select *
      from public.recurring_expenses r
      where r.ledger_id = due_ledger.ledger_id
        and r.is_active
        and r.deleted_at is null
        and r.next_due_date <= current_date
        and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
      order by r.next_due_date
      for update skip locked
    loop
      due_date := tmpl.next_due_date;
      template_count := 0;
      occurrences := 0;

      while due_date <= current_date and occurrences < max_catchup_occurrences loop
        insert into public.workspace_expenses (
          ledger_id, period_id, category, description, amount_dkk, expense_date,
          split_rule, split_config, paid_by_member_id, created_by_member_id,
          recurring_expense_id, occurrence_date
        ) values (
          due_ledger.ledger_id,
          open_period_id,
          tmpl.category,
          tmpl.description,
          tmpl.amount_dkk,
          due_date,
          tmpl.split_rule,
          tmpl.split_config,
          tmpl.paid_by_member_id,
          tmpl.created_by_member_id,
          tmpl.id,
          due_date
        )
        on conflict (recurring_expense_id, occurrence_date)
          where recurring_expense_id is not null do nothing
        returning id into inserted_id;

        if inserted_id is not null then
          template_count := template_count + 1;
        end if;
        inserted_id := null;
        occurrences := occurrences + 1;

        due_date := (case tmpl.cadence
          when 'monthly' then due_date + interval '1 month'
          when 'quarterly' then due_date + interval '3 months'
          when 'semiannual' then due_date + interval '6 months'
          when 'yearly' then due_date + interval '1 year'
          else due_date + interval '1 month'
        end)::date;
      end loop;

      update public.recurring_expenses
        set next_due_date = due_date, last_generated_at = now(), updated_at = now()
      where id = tmpl.id;

      if template_count > 0 then
        insert into public.ledger_events (
          ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
        ) values (
          due_ledger.ledger_id,
          'expense_recurring_added',
          'Fast udgift tilføjet',
          coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
            || ' blev automatisk tilføjet og delt.',
          null,
          null,
          jsonb_build_object(
            'category', tmpl.category,
            'recurring_expense_id', tmpl.id,
            'count', template_count
          )
        );
        ledger_generated := ledger_generated + template_count;
      end if;
    end loop;

    if ledger_generated > 0 then
      ledgers_touched := ledgers_touched + 1;
      total_generated := total_generated + ledger_generated;
    end if;

    open_period_id := null;
  end loop;

  return jsonb_build_object(
    'generated', total_generated,
    'ledgers_touched', ledgers_touched,
    'ledgers_scanned', ledgers_scanned
  );
end;
$$;

revoke execute on function public.generate_all_due_recurring_expenses(integer) from public;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from anon;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from authenticated;
grant execute on function public.generate_all_due_recurring_expenses(integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('114_repair_period_binding_and_deactivation',
        'Repair↔period binding + payer-deactivation recurring suspension (GV-277). A) vehicle_repairs.period_id added (nullable FK, on delete set null). insert_repair re-declared off 108: takes the blocking ledger advisory lock close_settlement_period uses (pg_advisory_xact_lock(hashtext(ledger_id))) so a repair insert queues behind an in-flight close, then stamps the open period id. calculate_period_settlement (off 112) and calculate_period_entry_fingerprint (off 112) scope repairs by period_id, falling back to the 112 created_at window for legacy null-period rows; the fingerprint''s repair component becomes id+oere PAIRS so a repair-cost edit busts a prepared close (the amount guard misses it — repairs move neither totalKm nor totalPaid), key still omitted when empty and mirrored byte-identically by the mobile client. close_settlement_period (off 104) stamps period_id on the closing period''s remaining legacy null-period repairs before flipping it to closed (so enforce_repair_period_lock permits the write). B) set_ledger_member_active_admin (off 012): on deactivation, suspends every recurring template the member pays for and writes a recurring_suspended ledger_events row (Danish, naming the templates). Both recurring generators (off 112) additionally skip templates whose payer is a known inactive member (defense in depth; member_is_active_in_ledger returns true for a null payer).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 199: a workspace can store ONE named weight set as its expense-split default, invalidated by any member change (GVM-563)
--
-- WHAT WAS MISSING. A workspace has three split rules per expense category
-- (ledgers.expense_split_defaults, migration 065: equal | usage | custom) but only two of
-- them were reachable as a DEFAULT. "Tilpasset" (custom) needs weights, and weights only
-- ever existed per expense — workspace_expenses.split_config / recurring_expenses.split_config,
-- a { "<member_id>": <weight> } object typed on each entry. A group whose real-world
-- arrangement is "Anna 40, Bo 30, Cille 30 on everything" therefore had to retype the same
-- three numbers on every single expense, and one typo silently changed the split.
--
-- Writing 'custom' into expense_split_defaults was already ACCEPTED by the column (it is a
-- free-form jsonb, never validated) and already DEGRADED to an equal split: with no weights
-- to read, every member's weight resolved to 0, the total weight was 0, and the
-- expense_cents fallback divided the amount equally. So a workspace default of custom was
-- reachable-but-inert, on the server and in the client alike. This migration gives it
-- something to read.
--
-- ── THE SHAPE, AND WHY IT IS ON `ledgers` ────────────────────────────────────────────
--
-- Three nullable columns on public.ledgers, all three set or all three null:
--
--   default_split_set_name           text   — the group's own name for it ("Hverdagskørsel")
--   default_split_weights            jsonb  — { "<member_id>": <weight> }, EXACTLY the shape
--                                             workspace_expenses.split_config already uses
--   default_split_member_fingerprint text   — the ACTIVE member list as it stood when the
--                                             set was saved (see below)
--
-- A satellite table was considered and rejected: there is exactly ONE set per workspace (the
-- product decision — a *default*, not a library of named presets), and settlement_mode,
-- repairs_split_mode and expense_split_defaults are all already columns here. A one-row-per-
-- ledger table would add a join to the hottest read in the schema to model a 1:1.
--
-- Weights reuse split_config's shape on purpose. The settlement engine already knows how to
-- read that object — `coalesce((config ->> member_id)::numeric, 0)` — so the workspace set
-- flows into the SAME largest-remainder integer-øre chain (migration 108) as a per-expense
-- custom split. There is no second splitter to keep in step, on either side.
--
-- ── MEMBER CHANGES: INVALIDATE + FALL BACK, NEVER RE-NORMALISE ───────────────────────
--
-- OWNER DECISION (2026-08-10). Weights are a statement about a specific group of people.
-- "40/30/30" between Anna, Bo and Cille says nothing about what Dagmar's share should be
-- when she joins, and re-normalising 40/30/30 over four people would invent a number nobody
-- agreed to and then charge real money against it. So when the member list changes the set
-- becomes STALE:
--
--   • new expenses that would have inherited it fall back to an EQUAL split, and
--   • the app shows the admin a banner asking for the weights to be saved again.
--
-- No automatic re-normalisation, ever. Nothing is deleted either — the stored weights are
-- kept verbatim so re-saving is a review, not a re-entry.
--
-- Staleness is COMPUTED, not stamped. The set carries a FINGERPRINT of the active member
-- list captured at save time, and it is stale exactly when that fingerprint differs from the
-- one the CURRENT active members produce. That means:
--
--   • no trigger on ledger_members — join, leave, deactivate, reactivate and delete all
--     change the answer with no write of any kind, including the paths that never call an
--     RPC (an admin deactivating a member, a cascade delete, a restore);
--   • the same comparison is available to the client and to the SQL, so the two agree by
--     construction rather than by two implementations happening to match;
--   • re-activating the very member who left silently makes the set VALID again, which is
--     the correct answer — it is the same group of people it was saved for.
--
-- THE FINGERPRINT is the ids of the ledger's ACTIVE members, each as canonical uuid text,
-- sorted in C (byte) order and joined with commas — public.active_member_fingerprint below.
-- Byte order over lowercase-hex uuid text is the same order JavaScript's default
-- Array.prototype.sort() produces, so the client's
-- `members.filter(active).map(m => m.id).sort().join(',')` is character-for-character the
-- same string; the schema already relies on that equivalence for the `order by id::text
-- collate "C"` the settlement payload is sorted by. It is deliberately NOT a hash: at 2–8
-- members it is a few hundred bytes, and a mismatch that can be read by eye is worth more
-- than the bytes. A ledger with no active members produces NULL, which is distinct from any
-- stored fingerprint, so the set is stale — the safe direction.
--
-- ── HOW A NEW EXPENSE INHERITS IT ────────────────────────────────────────────────────
--
-- calculate_period_settlement resolves an expense's rule exactly as before —
-- `coalesce(nullif(split_rule,''), defaults->>category, 'equal')` — and then, and ONLY when
-- that resolves to 'custom' AND the expense carries no split_config of its own:
--
--   • valid set  → the workspace weights are used as that expense's weights;
--   • stale set, or no set at all → the rule becomes 'equal'.
--
-- An expense that has its OWN split_config is untouched in every case; the workspace set
-- never overrides weights somebody typed. The fallback is written as an explicit rule change
-- to 'equal' rather than left to the zero-total-weight path so that the intent is legible and
-- so the two branches cannot drift apart — both produce one weight per active member, which
-- is what the client's `else` branch produces for the same expense.
--
-- CLIENT PARITY IS THE POINT. govehlo-mobile's settlement-calc.ts runs this same arithmetic
-- for every screen, and close_settlement_period's integrity gate reconciles the client's
-- snapshot against this function's per-member nets within 0,02 kr. If the two disagreed
-- about whether a set is stale, a close would be REFUSED — so the client mirrors the
-- fingerprint rule in src/lib/workspace-split-set.ts and the same wave ships it.
--
-- ── PROVENANCE ───────────────────────────────────────────────────────────────────────
--
-- calculate_period_settlement is re-declared COMPLETELY off migration 196, its newest prior
-- definition (chain: 054 → 055 → 068 → 070 → 107 → 108 → 112 → 114 → 157 → 194 → 196;
-- nothing after 196 touches it). Byte-for-byte identical bar the ledger_defaults CTE, which
-- gains the validated workspace weights, and period_expenses, which is wrapped in one
-- subquery so the resolved rule is computed once instead of three times. Every other CTE —
-- the km shares, GV-269's largest-remainder øre chains for expenses/repairs/crossings,
-- GV-274's credit-only inactive payer, GV-277's repair period scoping, GV-472's zero-km
-- carry-forward and deferredFuel block, GV-477's multiply-before-divide tripCost — is
-- carried through verbatim. Signature unchanged, so this stays a plain create-or-replace and
-- the existing grants carry over.
--
-- update_ledger_settings (newest: 119) is deliberately NOT touched. Its expense_split_defaults
-- param already accepts 'custom' and has never validated its contents; setting a category to
-- custom before a set exists is harmless (the fallback above splits equally) and the app
-- saves the set first. Widening a 5-arg signature that every settings write in both clients
-- calls, to add a validation the fallback already makes safe, is the larger risk.
--
-- ── EVENT ────────────────────────────────────────────────────────────────────────────
--
-- Saving or clearing the set writes ONE feed-visible ledger_events row of the EXISTING
-- 'settings_changed' type (migration 119, already in FEED_VISIBLE_EVENT_TYPES) — no new
-- event_type, so the GV-413 classification register is unchanged. It has to be written: a
-- write RPC that logs no event does not live-sync to the other members' clients (the
-- migration 087 lesson), and this one changes how everybody's money is divided. Server-
-- authored Danish, metadata carries the OLD and NEW set names and the member count only —
-- never the weights, never a member id. No-op suppression matches 119: a call that leaves
-- all three columns as they were writes nothing and emits nothing.
--
-- GDPR: the weights are keyed by ledger_members.id (an internal uuid), never by name or
-- email. The set NAME is group-chosen free text and is shown to that group only, in their
-- own feed — the same posture as an expense description. Nothing is logged.

-- ── Workspace weight-set columns ─────────────────────────────────────────────────────
-- All three nullable and all three written together by the RPC below; "no named set" is
-- all three null, which is every existing workspace the moment this is applied.
alter table public.ledgers
  add column if not exists default_split_set_name text;
alter table public.ledgers
  add column if not exists default_split_weights jsonb;
alter table public.ledgers
  add column if not exists default_split_member_fingerprint text;

-- ── active_member_fingerprint ────────────────────────────────────────────────────────
-- The one definition of "which people is this set for". Extracted rather than inlined
-- because it is read from TWO places that must not drift — the RPC that stamps it and the
-- settlement function that checks it — and because a future reader (the close guard, an
-- admin view) must get the same string without re-deriving the ordering rule.
--
-- Not granted to authenticated: it is an internal helper with no client caller. Both
-- callers are SECURITY DEFINER and owned by the same role, so they reach it regardless.
create or replace function public.active_member_fingerprint(target_ledger_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select string_agg(lm.id::text, ',' order by lm.id::text collate "C")
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.is_active = true;
$$;

revoke all on function public.active_member_fingerprint(text) from public;
revoke all on function public.active_member_fingerprint(text) from anon;
-- And from authenticated too, explicitly. Revoking from PUBLIC is not enough here: this
-- project's default privileges hand `authenticated` execute on new functions, and a
-- browser-reachable helper with no client caller is exactly what the GV-379 coverage check
-- refuses to let the role matrix certify. Both callers are SECURITY DEFINER and run as the
-- owner, so neither notices.
revoke all on function public.active_member_fingerprint(text) from authenticated;

-- ── set_workspace_split_weight_set ───────────────────────────────────────────────────
-- Admin-only (workspace settings, same gate as update_ledger_settings). Saves the named set
-- and stamps the fingerprint SERVER-SIDE from the live active members, so a client cannot
-- store a set that is born stale or, worse, born falsely fresh.
--
-- Passing NULL for both name and weights CLEARS the set (all three columns to null).
-- Anything else must be a complete, valid set: a non-blank name, a jsonb OBJECT of weights,
-- every key the id of an ACTIVE member of THIS ledger, every value a non-negative number,
-- and at least one of them positive. Partial input is rejected rather than half-applied —
-- a set with no weights would be indistinguishable from a stale one at settle time.
create or replace function public.set_workspace_split_weight_set(
  target_ledger_id text,
  set_name_value text,
  weights_value jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clearing boolean;
  normalized_name text;
  new_fingerprint text;
  weight_key text;
  weight_entry jsonb;
  positive_count integer := 0;
  member_count integer;
  old_name text;
  old_weights jsonb;
  old_fingerprint text;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update workspace settings' using errcode = '42501';
  end if;

  normalized_name := nullif(btrim(coalesce(set_name_value, '')), '');
  clearing := set_name_value is null and weights_value is null;

  if not clearing then
    if normalized_name is null then
      raise exception 'Fordelingen skal have et navn' using errcode = '22023';
    end if;
    if length(normalized_name) > 40 then
      raise exception 'Navnet må højst være 40 tegn' using errcode = '22023';
    end if;
    if weights_value is null or jsonb_typeof(weights_value) <> 'object' then
      raise exception 'Fordelingen skal have vægte' using errcode = '22023';
    end if;

    for weight_key, weight_entry in select * from jsonb_each(weights_value) loop
      if not exists (
        select 1 from public.ledger_members lm
        where lm.ledger_id = target_ledger_id
          and lm.is_active = true
          and lm.id::text = weight_key
      ) then
        raise exception 'Vægt for et ukendt eller inaktivt medlem' using errcode = '22023';
      end if;
      if jsonb_typeof(weight_entry) <> 'number' then
        raise exception 'Vægte skal være tal' using errcode = '22023';
      end if;
      if (weight_entry #>> '{}')::numeric < 0 then
        raise exception 'Vægte kan ikke være negative' using errcode = '22023';
      end if;
      if (weight_entry #>> '{}')::numeric > 0 then
        positive_count := positive_count + 1;
      end if;
    end loop;

    if positive_count = 0 then
      raise exception 'Mindst én person skal have en vægt over 0' using errcode = '22023';
    end if;
  end if;

  select ledgers.default_split_set_name,
         ledgers.default_split_weights,
         ledgers.default_split_member_fingerprint
    into old_name, old_weights, old_fingerprint
    from public.ledgers
   where ledgers.id = target_ledger_id;

  -- Stamped from the live active members, never from the caller. A set saved by a client
  -- holding a stale member list is stamped against the list the DATABASE sees, so it is
  -- immediately stale (the safe direction) rather than silently blessed.
  new_fingerprint := case when clearing then null
                          else public.active_member_fingerprint(target_ledger_id) end;

  update public.ledgers set
    default_split_set_name           = case when clearing then null else normalized_name end,
    default_split_weights            = case when clearing then null else weights_value end,
    default_split_member_fingerprint = new_fingerprint,
    updated_at                       = now()
  where ledgers.id = target_ledger_id;

  -- No-op suppression (the GV-292 rule): a re-save that leaves all three columns exactly as
  -- they were is not a change and must not reach anybody's feed.
  if old_name is not distinct from (case when clearing then null else normalized_name end)
     and old_weights is not distinct from (case when clearing then null else weights_value end)
     and old_fingerprint is not distinct from new_fingerprint then
    return;
  end if;

  actor_id := public.current_ledger_member_id(target_ledger_id);
  current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');
  member_count := coalesce((select count(*)::integer from jsonb_object_keys(coalesce(weights_value, '{}'::jsonb))), 0);

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'settings_changed',
    'Fordeling ændret',
    case when clearing
         then 'Den navngivne fordeling er fjernet. Nye udgifter deles efter gruppens standard.'
         else 'Fordelingen blev sat til "' || normalized_name || '".'
    end,
    actor_id,
    current_actor_email,
    jsonb_build_object(
      'field', 'default_split_weight_set',
      'old', old_name,
      'new', case when clearing then null else normalized_name end,
      'memberCount', case when clearing then 0 else member_count end
    )
  );
end;
$$;

revoke all on function public.set_workspace_split_weight_set(text, text, jsonb) from public;
revoke all on function public.set_workspace_split_weight_set(text, text, jsonb) from anon;
grant execute on function public.set_workspace_split_weight_set(text, text, jsonb) to authenticated;

-- ── calculate_period_settlement — re-declared off migration 196 ──────────────────────
-- Migration 196 VERBATIM except for the two blocks marked GVM-563 below: ledger_defaults
-- now also yields the workspace weight set, validated against the live member fingerprint,
-- and period_expenses is wrapped in one subquery so the effective rule is resolved once and
-- can fall back to 'equal' when a custom default has nothing valid to read. Signature
-- unchanged, so this stays a plain create-or-replace and the existing grants carry over.
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
    -- GVM-563. Besides the per-category defaults, this now yields the workspace's NAMED
    -- weight set — but ONLY while it is still valid, i.e. the active member list is
    -- byte-identical to the one it was saved against. A stale set (anyone joined, left,
    -- was deactivated or reactivated since) resolves to null here and the expense falls
    -- back to an equal split below; the stored weights are kept in the row untouched so
    -- an admin re-saves rather than re-types. Never re-normalised over a changed group:
    -- 40/30/30 between three named people says nothing about a fourth person's share.
    select l.expense_split_defaults as defaults,
           case
             when l.default_split_weights is not null
              and jsonb_typeof(l.default_split_weights) = 'object'
              and l.default_split_member_fingerprint is not null
              and l.default_split_member_fingerprint
                  = public.active_member_fingerprint(target_ledger_id)
             then l.default_split_weights
           end as workspace_weights
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
    --
    -- GVM-563: the effective rule is resolved ONCE in the inner select (it was
    -- inlined three times over) and then reconciled with the workspace weight set.
    -- An expense that carries its OWN split_config keeps it in every case — the
    -- workspace set never overrides weights somebody typed on the entry. It fills in
    -- only where a 'custom' rule was INHERITED and there is nothing on the expense to
    -- read, and where even that is unavailable (no set, or a stale one) the rule
    -- becomes 'equal' outright. Writing the fallback as an explicit rule change rather
    -- than leaving it to the zero-total-weight path keeps it legible and keeps it
    -- identical to the client's `else` branch: one weight per active member.
    select pe.id,
           pe.amount_dkk,
           pe.paid_by_member_id,
           case when pe.raw_rule = 'custom'
                then coalesce(pe.own_config, pe.workspace_weights)
                else pe.own_config end as split_config,
           case when pe.raw_rule = 'custom'
                     and pe.own_config is null
                     and pe.workspace_weights is null
                then 'equal'
                else pe.raw_rule end as rule
    from (
      select we.id,
             we.amount_dkk,
             we.paid_by_member_id,
             we.split_config as own_config,
             ld.workspace_weights,
             coalesce(nullif(we.split_rule, ''),
                      (ld.defaults ->> we.category),
                      'equal') as raw_rule
      from public.workspace_expenses we
      cross join ledger_defaults ld
      join all_members payer on payer.id = we.paid_by_member_id
      where we.ledger_id = target_ledger_id
        and we.period_id = target_period_id
        and we.deleted_at is null
        and we.amount_dkk > 0
    ) pe
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
  '199_workspace_split_weight_set',
  'A workspace can store ONE named weight set as its expense-split default, invalidated by any member change (GVM-563). WHAT WAS MISSING: expense_split_defaults has accepted three rules per category since migration 065 (equal | usage | custom) but only two were reachable as a DEFAULT, because weights existed only per entry (workspace_expenses.split_config / recurring_expenses.split_config). A group whose arrangement is "Anna 40, Bo 30, Cille 30 on everything" retyped the same three numbers on every expense, and a workspace default of custom was reachable-but-inert: with nothing to read, every weight resolved to 0, the total weight was 0, and the expense_cents fallback split equally -- on the server and in the client alike. THE SHAPE: three nullable columns on public.ledgers, all three written together -- default_split_set_name (the group''s own name, e.g. "Hverdagskoersel", max 40 chars), default_split_weights (jsonb { "<member_id>": <weight> }, EXACTLY the shape split_config already uses so the workspace set flows into the same GV-269 largest-remainder integer-oere chain with no second splitter to keep in step), and default_split_member_fingerprint (the active member list as it stood at save time). A satellite table was rejected: there is exactly one set per workspace (a default, not a library of presets) and settlement_mode / repairs_split_mode / expense_split_defaults are already columns here, so a 1:1 table would add a join to the hottest read in the schema. MEMBER-CHANGE SEMANTICS, OWNER DECISION 2026-08-10 -- INVALIDATE + FALL BACK, NEVER RE-NORMALISE: weights are a statement about specific people, and 40/30/30 between three named members says nothing about a fourth member''s share, so re-normalising would invent a number nobody agreed to and charge real money against it. When the member list changes the set goes STALE: new expenses that would have inherited it fall back to an EQUAL split and the app banners the admin to save the weights again. Nothing is deleted -- the stored weights stay verbatim so re-saving is a review, not a re-entry. Staleness is COMPUTED, never stamped: public.active_member_fingerprint(ledger) returns the ACTIVE members'' ids as canonical uuid text, sorted in C (byte) order and comma-joined, and the set is stale exactly when the stored fingerprint differs from the live one. That needs NO trigger on ledger_members -- join, leave, deactivate, reactivate, cascade delete and restore all change the answer with no write at all, including the paths that call no RPC -- and it gives the client the same comparison, so the two agree by construction: byte order over lowercase-hex uuid text is the order JavaScript''s default Array.sort() produces, the same equivalence the settlement payload''s `order by id::text collate "C"` already relies on. Deliberately not a hash (2-8 members is a few hundred bytes and a mismatch you can read by eye is worth more); no active members yields NULL, distinct from any stored fingerprint, so the set is stale -- the safe direction. Re-activating the member who left makes the set valid again, which is correct: it is the same group it was saved for. INHERITANCE: calculate_period_settlement resolves the rule as before -- coalesce(nullif(split_rule,''''), defaults->>category, ''equal'') -- and then, ONLY when that is ''custom'' AND the expense carries no split_config of its own, uses the workspace weights if the set is valid and otherwise rewrites the rule to ''equal''. An expense with its own split_config is untouched in every case: the workspace set never overrides weights somebody typed. The fallback is an explicit rule change rather than a reliance on the zero-total-weight path so the intent is legible and the two branches cannot drift -- both produce one weight per active member, matching the client''s else branch. NEW RPC set_workspace_split_weight_set(target_ledger_id, set_name_value, weights_value): SECURITY DEFINER, admin-only (is_ledger_admin, the same gate as update_ledger_settings -- this is a workspace setting). Both params null CLEARS the set; anything else must be complete and valid -- non-blank name <= 40 chars, a jsonb OBJECT, every key the id of an ACTIVE member of THIS ledger, every value a non-negative number, at least one positive -- because a half-applied set with no weights is indistinguishable from a stale one at settle time. The fingerprint is stamped SERVER-SIDE from the live active members, never accepted from the caller, so a client holding a stale member list produces a set that is immediately stale (safe) rather than falsely fresh. Grants: revoked from public/anon, granted to authenticated; the helper active_member_fingerprint is NOT granted to authenticated (internal, no client caller -- both callers are SECURITY DEFINER and reach it regardless). EVENT: saving or clearing writes ONE feed-visible ledger_events row of the EXISTING ''settings_changed'' type (migration 119, already in FEED_VISIBLE_EVENT_TYPES) -- no new event_type, so the GV-413 register is unchanged. It must be written: an RPC that logs no event does not live-sync to other members (the migration 087 lesson) and this one changes how everybody''s money is divided. Server-authored Danish ("Fordeling aendret" / "Fordelingen blev sat til \\"<navn>\\"." or the cleared variant), metadata {field, old, new, memberCount} -- names and a count only, never the weights and never a member id. No-op suppression matches GV-292: a re-save leaving all three columns as they were writes nothing and emits nothing. calculate_period_settlement is re-declared COMPLETELY off migration 196, its newest prior definition (chain 054 -> 055 -> 068 -> 070 -> 107 -> 108 -> 112 -> 114 -> 157 -> 194 -> 196; nothing after 196 touches it), byte-for-byte bar the ledger_defaults CTE (which now also yields the validated workspace weights) and period_expenses (wrapped in one subquery so the effective rule is resolved once instead of three times); every other CTE -- the km shares, the three largest-remainder chains, GV-274 credit-only, GV-277 repair scoping, GV-472 zero-km carry-forward and deferredFuel, GV-477 multiply-before-divide -- is carried through verbatim, and the signature is unchanged so a plain create-or-replace suffices and the grants carry over. update_ledger_settings (newest 119) is deliberately NOT touched: its expense_split_defaults param already accepts ''custom'' and has never validated its contents, setting a category to custom before a set exists is harmless (the fallback splits equally) and the app saves the set first, so widening a 5-arg signature every settings write in both clients calls, for a validation the fallback already makes safe, is the larger risk. CLIENT PARITY IS LOAD-BEARING: govehlo-mobile''s settlement-calc.ts runs this arithmetic for every screen and close_settlement_period''s integrity gate reconciles its snapshot against these per-member nets within 0,02 kr, so a disagreement about staleness would REFUSE a close -- the mobile half of GVM-563 mirrors the fingerprint rule in src/lib/workspace-split-set.ts and ships in the same wave; the mobile PR must not merge before this migration is applied. Verified by tools/test-workspace-split-weight-set-contract.mjs (static, Docker-free, wired into npm run validate) plus role-matrix cases for the admin gate, the validation refusals, the inheritance, the stale fallback and the event. Adds three columns and one RPC to types/database.ts, so both client repos re-vendor. GDPR: weights are keyed by ledger_members.id (an internal uuid), never by name or email; the set name is group-chosen free text shown only to that group in their own feed, the same posture as an expense description; nothing is logged. Depends on 196 (the definition it re-declares), 119 (the settings_changed event type it reuses) and 065 (expense_split_defaults).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 200: the SHARED workspace monthly budget — one column on ledgers and the admin-only RPC that writes it (GVM-574)
--
-- WHAT EXISTS TODAY, AND WHAT IT IS NOT. GVM-368 shipped a monthly budget that lives in
-- AsyncStorage under `govehlo_monthly_budget:<ledger_id>` on ONE device, is compared
-- against that member's OWN share of next month's forecast, and is visible to nobody
-- else. That was a deliberate v1: the hook's own header says so and names the follow-up
-- — "a shared workspace budget is a possible follow-up; it would live beside
-- `repairs_split_mode` on `ledgers`" — because a number the whole group can see and
-- argue about needs a column, RLS, an admin gate and an event on the Activity feed, and
-- a personal reference number needs none of that.
--
-- This is that follow-up. It does NOT replace the device-local budget: a member may
-- still hold a personal target, and the two answer different questions — "what should
-- the car cost us" versus "what should it cost me". The mobile half (GVM-574) shows the
-- shared figure to everyone and lets a member's own device-local budget take precedence
-- for their personal view; nothing about that choice is encoded here, because nothing
-- server-side reads this number at all (see below).
--
-- ── THE SHAPE ────────────────────────────────────────────────────────────────────────
--
-- ONE nullable column on public.ledgers:
--
--   monthly_budget_dkk  numeric  — kroner per calendar month for the WHOLE car.
--                                  NULL means no shared budget, which is every existing
--                                  workspace the moment this is applied.
--
-- Nullable rather than defaulted, and null rather than 0: "we have not set one" is a
-- different statement from "we budget nothing", and only the first one may hide the
-- section. A CHECK keeps a stored value strictly positive and at or below 1.000.000 kr
-- — a monthly figure above a million kroner for a shared car is a typo or a unit mix-up
-- (øre entered as kroner), and a budget that silently absorbs one would make every
-- progress bar meaningless rather than obviously wrong. Both bounds are ALSO enforced
-- in the RPC with Danish sentences, so a member sees an explanation rather than a
-- constraint name; the constraint is the backstop that survives a future writer.
--
-- It sits on `ledgers` beside settlement_mode, repairs_split_mode, expense_split_defaults
-- and the booking caps — the same class of thing (a workspace setting the admin owns)
-- stored the same way, and it therefore arrives on every client for free: the fan-out
-- reads `ledgers` with `select *`, so no client needs a new query to receive it.
--
-- ── NOTHING ON THE SERVER READS IT, AND THAT IS CHECKED, NOT ASSUMED ─────────────────
--
-- The budget is CLIENT-CONSUMED. It changes no split, no settlement, no reminder and no
-- push. calculate_period_settlement deliberately does not read it — a budget is a
-- statement about what the group WANTS to spend, and letting it touch how a real cost is
-- divided would be a bug, not a feature. Nothing else could want it either: every
-- server-side consumer of workspace state is a splitter (calculate_period_settlement,
-- close_settlement_period), a scheduler claim (claim_due_*), a cap enforcer
-- (upsert_car_booking) or a retention sweep, and none of them has a question a budget
-- answers. The forecast the budget is compared AGAINST is itself derived on-device
-- (govehlo-mobile src/lib/cost-forecast.ts) from rows the app already holds — there is no
-- server-side forecast to compare with.
--
-- The consequence, stated because it is the thing to re-check if this ever changes: no
-- existing function needs re-declaring, so this migration declares no function twice and
-- the GV-202 "re-declare off the newest prior definition" rule has nothing to apply to.
-- The moment something server-side DOES want the budget — a "I er over budget" push, say
-- — that is a new decision with a new event type, and this comment is where to start.
--
-- ── THE RPC ──────────────────────────────────────────────────────────────────────────
--
-- set_workspace_monthly_budget(target_ledger_id text, budget_dkk_value numeric), SECURITY
-- DEFINER, gated on is_ledger_admin — the same gate update_ledger_settings uses, because
-- this is a workspace setting and not a personal one. A member who wants a private target
-- already has one: the device-local budget, which needs no permission from anybody.
--
-- NULL clears the budget. There is no separate clear RPC and no magic zero: zero is
-- rejected, null is the clear, and the two are never confused.
--
-- A dedicated RPC rather than a sixth parameter on update_ledger_settings, for migration
-- 199's reason: that 5-argument signature is called by every settings write in both
-- clients, and widening it is a DROP + CREATE (PostgREST cannot resolve two overloads,
-- the 170 lesson) that would break every shipped client until they re-vendor. A new
-- function breaks nothing and can be granted, tested and revoked on its own.
--
-- ── THE EVENT ────────────────────────────────────────────────────────────────────────
--
-- Saving or clearing writes ONE feed-visible ledger_events row of the EXISTING
-- 'settings_changed' type (migration 119, already in FEED_VISIBLE_EVENT_TYPES), so the
-- GV-413 classification register is unchanged. It has to be written: a write RPC that
-- logs no event does not live-sync to the other members' clients (the migration 087
-- lesson), and a shared budget that changed silently would be a number people plan
-- against without knowing it moved.
--
-- Title and body are server-authored Danish, second person, sentence case:
--   'Budget ændret' / 'Det fælles månedsbudget blev sat til 2.500 kr.'
--   'Budget ændret' / 'Det fælles månedsbudget er fjernet.'
--
-- The amount is formatted here rather than left to the client because ledger_events.body
-- is rendered verbatim by the feed. Danish money formatting (period thousands, comma
-- decimals, "kr" suffix) is built from to_char's LITERAL ',' group separator and then
-- swapped to '.', deliberately NOT from the locale-dependent 'G'/'D' patterns, which
-- would render 2.500 as "2,500" on a database whose lc_numeric is en_US. Øre are printed
-- only when they are non-zero: a budget is a round number in practice, and "2.500,00 kr"
-- reads like a bill rather than a target.
--
-- METADATA carries the OLD and the NEW amount. This is a departure from the instinct to
-- keep amounts out of event metadata, and it is the right one here: the budget is the
-- GROUP's shared setting, already visible to every member on the ledger row and already
-- spelled out in the body of this very event. Withholding it from the metadata would
-- hide it from nobody while making the row useless to anything that wants to render the
-- change rather than re-parse the sentence. It matches migration 199's shape
-- ({field, old, new}) — the field name, what it was, what it became — and, like 199, it
-- names no member.
--
-- GV-292 no-op suppression: a re-save of the identical amount (or a clear of an
-- already-clear budget) writes nothing to the feed.
--
-- GDPR: no personal data. A workspace-level kroner figure, chosen by the group, shown to
-- that group, dying with the workspace. Nothing is logged.

-- ── The column ───────────────────────────────────────────────────────────────────────
alter table public.ledgers
  add column if not exists monthly_budget_dkk numeric;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ledgers_monthly_budget_check'
  ) then
    alter table public.ledgers
      add constraint ledgers_monthly_budget_check
      check (monthly_budget_dkk is null
             or (monthly_budget_dkk > 0 and monthly_budget_dkk <= 1000000));
  end if;
end $$;

comment on column public.ledgers.monthly_budget_dkk is
  'GVM-574: the SHARED monthly budget for the whole car, in kroner. NULL = no shared budget (the default, and every workspace before this migration). Strictly positive and <= 1.000.000 when set. Written ONLY by public.set_workspace_monthly_budget (admin-gated); read only by clients — no server function consumes it, and calculate_period_settlement deliberately does not, because a budget must never change how a real cost is divided. Distinct from the device-local per-member budget in AsyncStorage (GVM-368), which is personal and stays personal.';

-- ── set_workspace_monthly_budget ─────────────────────────────────────────────────────
-- Admin-only (is_ledger_admin, the same gate as update_ledger_settings). NULL clears.
create or replace function public.set_workspace_monthly_budget(
  target_ledger_id text,
  budget_dkk_value numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clearing boolean;
  new_budget numeric;
  old_budget numeric;
  whole_part text;
  ore_part text;
  amount_text text;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update workspace settings' using errcode = '42501';
  end if;

  clearing := budget_dkk_value is null;

  if not clearing then
    -- numeric accepts 'NaN', and NaN passes every comparison below without failing one,
    -- so it is refused first and explicitly rather than stored as a budget nothing can
    -- compare against.
    if budget_dkk_value = 'NaN'::numeric then
      raise exception 'Budgettet skal være et tal' using errcode = '22023';
    end if;
    if budget_dkk_value <= 0 then
      raise exception 'Budgettet skal være over 0 kr' using errcode = '22023';
    end if;
    if budget_dkk_value > 1000000 then
      raise exception 'Budgettet kan højst være 1.000.000 kr' using errcode = '22023';
    end if;
    -- Kroner with øre precision, exactly as the device-local budget rounds (GVM-368):
    -- 1.500,005 kr is a typo, not an intention. Rounded BEFORE the no-op comparison, so
    -- re-saving the same amount typed with one more decimal is correctly a no-op.
    new_budget := round(budget_dkk_value, 2);
    -- Rounding cannot cross either bound (round(0.001, 2) = 0.00 would), so re-check the
    -- lower one against the value that will actually be stored.
    if new_budget <= 0 then
      raise exception 'Budgettet skal være over 0 kr' using errcode = '22023';
    end if;
  end if;

  select ledgers.monthly_budget_dkk
    into old_budget
    from public.ledgers
   where ledgers.id = target_ledger_id;

  update public.ledgers set
    monthly_budget_dkk = new_budget,
    updated_at         = now()
  where ledgers.id = target_ledger_id;

  -- No-op suppression (the GV-292 rule): an unchanged budget is not a change and must
  -- not reach anybody's feed.
  if old_budget is not distinct from new_budget then
    return;
  end if;

  actor_id := public.current_ledger_member_id(target_ledger_id);
  current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

  -- Danish money formatting, built from to_char's LITERAL ',' group separator (which
  -- always emits a comma, unlike the locale-dependent 'G') and then swapped for the
  -- Danish '.'; øre are appended only when non-zero. 2500 -> '2.500 kr',
  -- 1234.5 -> '1.234,50 kr'.
  if clearing then
    amount_text := null;
  else
    whole_part := replace(to_char(trunc(new_budget), 'FM9,999,999'), ',', '.');
    ore_part := to_char(round((new_budget - trunc(new_budget)) * 100), 'FM00');
    amount_text := whole_part
      || case when ore_part = '00' then '' else ',' || ore_part end
      || ' kr';
  end if;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'settings_changed',
    'Budget ændret',
    case when clearing
         then 'Det fælles månedsbudget er fjernet.'
         else 'Det fælles månedsbudget blev sat til ' || amount_text || '.'
    end,
    actor_id,
    current_actor_email,
    jsonb_build_object(
      'field', 'monthly_budget_dkk',
      'old', old_budget,
      'new', new_budget
    )
  );
end;
$$;

revoke all on function public.set_workspace_monthly_budget(text, numeric) from public;
revoke all on function public.set_workspace_monthly_budget(text, numeric) from anon;
grant execute on function public.set_workspace_monthly_budget(text, numeric) to authenticated;


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '200_workspace_monthly_budget',
  'The SHARED workspace monthly budget: one nullable column on public.ledgers and the admin-only RPC that writes it (GVM-574). WHAT EXISTED BEFORE: GVM-368''s monthly budget is DEVICE-LOCAL -- AsyncStorage under govehlo_monthly_budget:<ledger_id>, compared against that member''s OWN share of next month''s forecast, visible to nobody else. That was a deliberate v1 and the hook''s header names this follow-up verbatim ("a shared workspace budget is a possible follow-up; it would live beside repairs_split_mode on ledgers"), because a number the whole group can see and argue about needs a column, RLS, an admin gate and a feed event, and a personal reference number needs none of them. This migration does NOT replace the personal one: the two answer different questions -- what should the car cost US, versus what should it cost ME. THE SHAPE: ledgers.monthly_budget_dkk numeric, nullable, kroner per calendar month for the WHOLE car. NULL means "no shared budget", which is every existing workspace the moment this is applied -- nullable rather than defaulted and null rather than 0 because "we have not set one" is a different statement from "we budget nothing", and only the first may hide the section. Constraint ledgers_monthly_budget_check keeps a stored value strictly positive and <= 1.000.000 kr: a monthly figure above a million kroner for a shared car is a typo or a unit mix-up (oere entered as kroner), and silently absorbing one would make every progress bar meaningless rather than obviously wrong. Both bounds are enforced AGAIN in the RPC with Danish sentences so a member sees an explanation rather than a constraint name; the constraint is the backstop that survives a future writer. It sits beside settlement_mode, repairs_split_mode, expense_split_defaults and the booking caps -- the same class of thing stored the same way -- and therefore reaches every client for free, since the workspace fan-out reads ledgers with select *. NOTHING SERVER-SIDE READS IT, and that was checked rather than assumed: the budget changes no split, no settlement, no reminder and no push. calculate_period_settlement deliberately does not read it -- a budget states what the group WANTS to spend, and letting it touch how a real cost is divided would be a bug, not a feature -- and no other server-side consumer of workspace state has a question a budget answers (they are splitters, scheduler claims, cap enforcers and retention sweeps). The forecast the budget is compared against is itself derived ON DEVICE from rows the app already holds (govehlo-mobile src/lib/cost-forecast.ts); there is no server-side forecast to compare with. CONSEQUENCE, stated so it is re-checked if it ever changes: no existing function needed re-declaring, so this migration declares no function twice and the GV-202 newest-prior-definition rule has nothing to apply to. THE RPC set_workspace_monthly_budget(target_ledger_id text, budget_dkk_value numeric) returns void: SECURITY DEFINER with a pinned search_path, gated on is_ledger_admin -- the same gate update_ledger_settings uses, because this is a workspace setting; a member who wants a private target already has the device-local one, which needs nobody''s permission. NULL CLEARS the budget: there is no separate clear RPC and no magic zero (zero is rejected, null is the clear, and the two are never confused). A dedicated RPC rather than a sixth parameter on update_ledger_settings for migration 199''s reason: that 5-argument signature is called by every settings write in both clients and widening it is a DROP + CREATE (PostgREST cannot resolve two overloads -- the migration 170 lesson) that would break every shipped client until it re-vendors, whereas a new function breaks nothing. Validation, all 22023 and all Danish: NaN is refused first and explicitly (numeric accepts ''NaN'' and it passes every comparison without failing one), <= 0 is "Budgettet skal vaere over 0 kr", > 1.000.000 is "Budgettet kan hoejst vaere 1.000.000 kr", and the accepted value is rounded to oere precision BEFORE the no-op comparison (so re-saving the same amount with one more decimal is correctly a no-op) with the lower bound re-checked against the rounded value. Grants: revoked from public and anon, granted to authenticated. THE EVENT: saving or clearing writes ONE feed-visible ledger_events row of the EXISTING ''settings_changed'' type (migration 119, already in FEED_VISIBLE_EVENT_TYPES), so the GV-413 classification register is unchanged. It must be written -- a write RPC that logs no event does not live-sync to the other members'' clients (the migration 087 lesson), and a shared budget that changed silently would be a number people plan against without knowing it moved. Server-authored Danish: "Budget aendret" / "Det faelles maanedsbudget blev sat til 2.500 kr." or "Det faelles maanedsbudget er fjernet." The amount is formatted in SQL because ledger_events.body is rendered verbatim by the feed: period thousands and comma decimals are built from to_char''s LITERAL '','' group separator swapped to ''.'', deliberately NOT from the locale-dependent G/D patterns, which would render 2.500 as "2,500" on a database whose lc_numeric is en_US; oere are printed only when non-zero, because a budget is a round number in practice and "2.500,00 kr" reads like a bill rather than a target. METADATA carries {field, old, new} -- the old and the new AMOUNT, matching migration 199''s shape and naming no member. Including the amount is deliberate rather than an oversight of the usual keep-money-out-of-metadata instinct: this is the GROUP''s shared setting, already visible to every member on the ledger row and already spelled out in the body of this very event, so withholding it would hide it from nobody while making the row useless to anything that wants to render the change instead of re-parsing the sentence. GV-292 no-op suppression: a re-save of the identical amount, or a clear of an already-clear budget, writes nothing and emits nothing. GDPR: no personal data whatsoever -- a workspace-level kroner figure chosen by the group, shown to that group, dying with the workspace; nothing is logged. Adds one column and one RPC to types/database.ts, so both client repos re-vendor. Pinned by tools/test-rls-role-matrix.mjs (admin sets and clears, member and outsider refused, the four validation refusals, the rounding, the no-op suppression, the Danish-formatted event body and the metadata) and, until the mobile half ships, by a dated entry in tools/role-matrix-coverage-allowlist.mjs -- the RPC has no client caller yet, which is exactly the migration-first window that list exists to record. MERGE ORDER: PostgREST answers PGRST202 for a function that does not exist, so this SQL must be applied in the Supabase SQL Editor BEFORE govehlo-mobile''s GVM-574 half ships. Depends on 119 (the settings_changed event type it reuses) and on the ledgers table itself; depends on nothing it re-declares, because it re-declares nothing.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

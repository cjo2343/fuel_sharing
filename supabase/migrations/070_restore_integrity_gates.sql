-- Migration 070: restore integrity access gates + expense payer/lock rails (GVM-177)
--
-- Three confirmed regressions from migrations 067/068/069 (external Codex review,
-- verified against main):
--
--   1. CRITICAL — migration 068 rewrote calculate_period_entry_fingerprint as
--      `language sql` and dropped migration 055's member-or-operator gate while
--      keeping `security definer`, so any authenticated user could enumerate
--      another workspace's trip/fuel/expense row UUIDs. It is restored to plpgsql
--      with 055's gate; the fingerprint EXPRESSION is byte-identical to 068's so
--      the mobile client's period-snapshot.ts parity and close_settlement_period's
--      integrity gate are unaffected. calculate_period_settlement kept its member
--      gate but lost 055's is_operator_context() OR-branch (SQL Editor / service
--      role diagnostics); that branch is restored.
--
--   2. HIGH — upsert_workspace_expense (067) and upsert_recurring_expense (069)
--      accepted paid_by_value with no validation, letting a caller assign a payer
--      from outside the ledger. Both now reject a non-member payer (matching how
--      051/062 validate drivers/payers via member_belongs_to_ledger).
--
--   3. HIGH — upsert_workspace_expense used a plain existence check on the open
--      period, so it did not serialize against close_settlement_period the way
--      upsert_fuel_payment does. It now takes the same `for share of sp` row lock.
--      generate_due_recurring_expenses' open-period lookup gains the same lock.
--
-- All five functions keep their existing signatures, so create-or-replace is
-- sufficient (no drop). Bodies are copied verbatim from the latest migration that
-- defines each (068 / 067 / 069); only the specified lines change.

-- ── calculate_period_settlement: restore the operator OR-branch (055) ────────
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
  per_member as (
    select am.id,
           am.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share
    from active_members am
    left join member_km mk on mk.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
    left join expense_paid xp on xp.member_id = am.id
    left join expense_share xs on xs.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid - pm.expense_share, 2) end
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

-- ── calculate_period_entry_fingerprint: restore the 055 gate ────────────────
-- Back to plpgsql so it can enforce member-or-operator before revealing row ids
-- (068 dropped this while keeping security definer). The fingerprint EXPRESSION
-- is byte-identical to 068's — including the "expenses" section — so the client's
-- periodEntryFingerprint and close_settlement_period stay in exact parity.
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
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

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
    || ']}'
  into result;

  return result;
end;
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── upsert_workspace_expense: payer membership + open-period row lock ────────
-- 067 body verbatim, with two rails added: (1) reject a paid_by_value that is not
-- a member of this ledger, and (2) take a `for share of sp` lock on the open
-- period (like upsert_fuel_payment) instead of a plain existence check, so an
-- in-flight expense write serializes against close_settlement_period.
create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  target_open_period_id uuid,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
  locked_period_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112 pattern): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight expense write and a close
  -- serialize here — either this entry commits first and the close's recompute sees
  -- it, or the close commits first and this check finds no open period and fails.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, period_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
      target_open_period_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error). period_id is intentionally NOT
    -- updated — an edit never moves an expense to a different period.
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      expense_date      = coalesce(expense_date_value, expense_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      updated_at        = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      normalized_event_type,
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

-- ── upsert_recurring_expense: payer membership validation ───────────────────
-- 069 body verbatim, plus the same non-member payer rejection as
-- upsert_workspace_expense.
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      normalized_event_type,
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;

-- ── generate_due_recurring_expenses: lock the open period ───────────────────
-- 069 body verbatim, with `for share of sp` added to the open-period lookup so
-- materialisation serializes against close_settlement_period the same way the
-- expense/fuel upserts do. FOR SHARE with LIMIT requires the lock clause after
-- the limit.
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
  total_generated integer := 0;
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
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;

    while due_date <= current_date loop
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

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
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

grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('070_restore_integrity_gates',
        'Restore migration 055 member/operator gates on calculate_period_entry_fingerprint (back to plpgsql) and calculate_period_settlement; validate expense payer membership in upsert_workspace_expense/upsert_recurring_expense; take the open-period FOR SHARE lock in upsert_workspace_expense and generate_due_recurring_expenses (GVM-177).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

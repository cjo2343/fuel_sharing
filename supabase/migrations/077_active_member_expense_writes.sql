-- Migration 077: require an active payer on new expense / recurring writes (GV-208)
--
-- An external review found that upsert_workspace_expense and upsert_recurring_expense
-- gate the payer with member_belongs_to_ledger, which checks ledger membership WITHOUT
-- is_active. So a brand-new expense or recurring template could be assigned to a
-- deactivated member. Historical rows must still tolerate a payer who was deactivated
-- after the fact (member_belongs_to_ledger stays on the update paths and everywhere
-- else), but a new write should require an active payer.
--
-- Adds member_is_active_in_ledger (member_belongs_to_ledger + is_active) and applies
-- it only on the INSERT (is_new) branch of both expense write RPCs. Editing an
-- existing row keeps the looser membership gate, so an amount change that re-sends a
-- now-inactive payer is not blocked. Both RPCs are re-declared off their latest
-- definitions (upsert_workspace_expense from 070, upsert_recurring_expense from 075).

-- ── Helper: active-membership check ─────────────────────────────────────────
create or replace function public.member_is_active_in_ledger(p_member_id uuid, p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_member_id is null or exists (
    select 1
    from public.ledger_members lm
    where lm.id = p_member_id
      and lm.ledger_id = p_ledger_id
      and lm.is_active = true
  );
$$;

-- ── upsert_workspace_expense (070 body + active-payer gate on INSERT) ────────
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
    -- A brand-new expense must be paid by an ACTIVE member (GV-208). Edits keep the
    -- looser membership gate above so a payer deactivated after the fact is tolerated.
    if paid_by_value is not null
       and not public.member_is_active_in_ledger(paid_by_value, target_ledger_id) then
      raise exception 'Payer must be an active member of this ledger' using errcode = '22023';
    end if;

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

-- ── upsert_recurring_expense (075 body + active-payer gate on INSERT) ────────
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

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'semiannual', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    -- A brand-new template must be paid by an ACTIVE member (GV-208) — its payer
    -- drives every future generated expense. Edits keep the looser membership gate.
    if paid_by_value is not null
       and not public.member_is_active_in_ledger(paid_by_value, target_ledger_id) then
      raise exception 'Payer must be an active member of this ledger' using errcode = '22023';
    end if;

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

-- ── Register migration ──────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('077_active_member_expense_writes',
        'Require an active payer on new expense / recurring writes via member_is_active_in_ledger (GV-208).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 067: bind workspace expenses to a settlement period (GVM-173)
--
-- Expenses must settle per-period exactly like trips and fuel: the balance
-- screens scope to the open period so a closed month's data can't leak into the
-- current one, and closing a period must archive that period's expenses with its
-- fuel. That needs a period_id on each expense, stamped at insert to the open
-- period (mirroring fuel_payments / trips).
--
-- The upsert RPC gains a leading target_open_period_id param and validates it is
-- the ledger's open period, the same guard fuel/trips use. Drop-then-recreate
-- (migration 051 pattern) keeps a single live signature. period_id is set on
-- INSERT only; editing an expense never moves it between periods.

alter table public.workspace_expenses
  add column if not exists period_id uuid references public.settlement_periods(id) on delete set null;

create index if not exists workspace_expenses_period_idx
  on public.workspace_expenses (period_id)
  where deleted_at is null;

drop function if exists public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, uuid, text, text);

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

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('067_expense_period',
        'Bind workspace_expenses to a settlement period (period_id) + upsert RPC open-period param (GVM-173).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

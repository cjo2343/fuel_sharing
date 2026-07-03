-- Migration 066: add payer to workspace expenses (GVM-169)
--
-- Settling an expense needs to know WHO PAID it — that member is the creditor,
-- everyone else owes their split. Migration 065 only recorded created_by_member_id
-- (who entered the row), which is not necessarily the payer. Add an explicit
-- paid_by_member_id, mirroring fuel_payments.payer_member_id, so the generalised
-- settlement engine (GVM-169) can fold expenses into who-owes-whom.
--
-- The upsert RPC gains a paid_by_value param. Because Postgres treats a new
-- argument signature as an overload (not a replacement), we DROP the old
-- signature first and recreate — the migration 051 pattern — so there is exactly
-- one live upsert_workspace_expense and calls stay unambiguous.

alter table public.workspace_expenses
  add column if not exists paid_by_member_id uuid references public.ledger_members(id) on delete set null;

drop function if exists public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, text, text);

create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
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

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
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
    -- too; re-checked here for a clear error).
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

grant execute on function public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('066_expense_paid_by',
        'Add paid_by_member_id to workspace_expenses + upsert RPC payer param (GVM-169).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

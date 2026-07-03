-- Migration 065: workspace expenses model + per-category split defaults (GVM-168)
--
-- Phase 1 backbone of the shared-car total-cost ledger (epic GVM-167): a
-- generalised expense that is NOT fuel — insurance, ownership tax, inspection,
-- repairs, financing, parking, other — each captured once and split across the
-- workspace. This migration adds the storage + write path only; the settlement
-- engine that folds these into who-owes-whom is GVM-169, and recurring
-- auto-generation is Phase 2 (GVM-174).
--
-- Split model (decided 2026-07-03): three modes — 'equal' (per active member),
-- 'usage' (km share, like fuel) and 'custom' (explicit % per member). Each
-- expense's split_rule may be null, meaning "use the workspace default for this
-- category" (expense_split_defaults below); smart defaults are seeded so nobody
-- has to configure anything.

-- ── Per-category default split rule on the ledger ─────────────────
-- Owner-editable via the existing "Ledger admins can update ledgers" RLS (same
-- path as settlement_mode), so no dedicated RPC is needed to change it.
alter table public.ledgers
  add column if not exists expense_split_defaults jsonb not null default
    '{"fuel":"usage","insurance":"equal","tax":"equal","inspection":"equal","repair":"equal","financing":"equal","parking":"equal","other":"equal"}'::jsonb;

-- ── Expenses table ────────────────────────────────────────────────
-- One value per row (Phase 1 is one-off entries; recurrence columns arrive in
-- Phase 2). RLS mirrors vehicle_repairs: members read, creator-or-admin write,
-- admin delete.
create table if not exists public.workspace_expenses (
  id                   uuid primary key default gen_random_uuid(),
  ledger_id            text not null references public.ledgers(id) on delete cascade,
  category             text not null default 'other',
  description          text,
  amount_dkk           numeric(12, 2) not null default 0,
  expense_date         date not null,
  -- null => resolve against ledgers.expense_split_defaults[category] at settle time.
  split_rule           text check (split_rule in ('equal', 'usage', 'custom')),
  -- for split_rule = 'custom': { "<member_id>": <weight> }, weights normalised at settle time.
  split_config         jsonb,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists workspace_expenses_ledger_date_idx
  on public.workspace_expenses (ledger_id, expense_date desc)
  where deleted_at is null;

alter table public.workspace_expenses enable row level security;

drop policy if exists "Ledger members can read expenses" on public.workspace_expenses;
create policy "Ledger members can read expenses" on public.workspace_expenses
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

drop policy if exists "Creators and admins can insert expenses" on public.workspace_expenses;
create policy "Creators and admins can insert expenses" on public.workspace_expenses
  for insert to authenticated
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  );

drop policy if exists "Creators and admins can update expenses" on public.workspace_expenses;
create policy "Creators and admins can update expenses" on public.workspace_expenses
  for update to authenticated
  using (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  )
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  );

drop policy if exists "Admins can delete expenses" on public.workspace_expenses;
create policy "Admins can delete expenses" on public.workspace_expenses
  for delete to authenticated
  using (public.is_ledger_admin(ledger_id));

-- ── Write path: upsert_workspace_expense ──────────────────────────
-- Insert (expense_id_value null) or update an expense, re-checking membership +
-- creator/admin server-side, and emitting an expense_added/expense_updated
-- ledger_events row for the activity feed + operator audit trail (051/052
-- pattern). Returns the row id.
create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
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
      split_rule, split_config, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
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
      category     = coalesce(nullif(category_value, ''), category),
      description  = nullif(description_value, ''),
      amount_dkk   = coalesce(amount_value, amount_dkk),
      expense_date = coalesce(expense_date_value, expense_date),
      split_rule   = split_rule_value,
      split_config = split_config_value,
      updated_at   = now()
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

-- ── Soft delete: soft_delete_workspace_expense ────────────────────
create or replace function public.soft_delete_workspace_expense(
  target_ledger_id text,
  expense_id_value uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_expense record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;
  if expense_id_value is null then
    raise exception 'Missing expense id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can delete expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);

  select * into existing_expense
  from public.workspace_expenses
  where id = expense_id_value
    and ledger_id = target_ledger_id
    and deleted_at is null
  for update;

  if existing_expense.id is null then
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;

  if not (public.is_ledger_admin(target_ledger_id)
          or existing_expense.created_by_member_id = actor_member_id) then
    raise exception 'Only the expense creator or a ledger admin can delete this expense' using errcode = '42501';
  end if;

  update public.workspace_expenses
    set deleted_at = now(), updated_at = now()
  where id = expense_id_value;

  return jsonb_build_object('deleted', true, 'id', expense_id_value);
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, text, text) to authenticated;
grant execute on function public.soft_delete_workspace_expense(text, uuid) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('065_workspace_expenses',
        'Workspace expenses table + per-category split defaults + upsert/soft-delete RPCs (GVM-168).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

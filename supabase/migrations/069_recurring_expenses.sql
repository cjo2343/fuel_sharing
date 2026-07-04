-- Migration 069: recurring expense templates + auto-materialisation (GVM-174)
--
-- Phase 2 of the shared-car total-cost ledger (epic GVM-167): the anti-forgetting
-- mechanism. A workspace owner records a standing cost once — the insurance
-- premium, the quarterly ownership tax, a monthly financing instalment — as a
-- recurring template with a cadence. Each time it comes due, a concrete
-- workspace_expenses row is materialised into the open period automatically, with
-- the template's split and payer, and a feed event nudges the group.
--
-- Trigger model (decided 2026-07-04): CLIENT CATCH-UP. The app calls
-- generate_due_recurring_expenses(ledger) when the ledger + open period resolve;
-- the RPC is idempotent and catches up every occurrence missed since the last
-- run, so no server cron is required on the current Supabase + Cloudflare stack.
-- pg_cron can be layered on later against the same RPC.
--
-- Auto vs confirm (decided 2026-07-04): AUTO-ADD. The expense is inserted and a
-- nudge fires; the payer can edit the amount or soft-delete it if a given month
-- differs. An unconfirmed suggestion would itself be something to forget.
--
-- Idempotency: workspace_expenses gains (recurring_expense_id, occurrence_date)
-- with a unique index, so a template's occurrence can never be materialised twice
-- even if two clients race the catch-up. next_due_date advances transactionally
-- under a row lock, and inserts use ON CONFLICT DO NOTHING as a second guard.

-- ── Link generated expenses back to their template ────────────────
alter table public.workspace_expenses
  add column if not exists recurring_expense_id uuid,
  add column if not exists occurrence_date date;

-- One row per (template, occurrence). The partial index only covers generated
-- rows; manual expenses (recurring_expense_id null) are unaffected.
create unique index if not exists workspace_expenses_recurrence_uq
  on public.workspace_expenses (recurring_expense_id, occurrence_date)
  where recurring_expense_id is not null;

-- ── Recurring templates table ─────────────────────────────────────
-- Admin-managed standing policy (like expense_split_defaults / settlement_mode):
-- members read, admins write/delete. Writes go through the RPCs below, but RLS is
-- defensive for direct selects (the client lists templates to manage them).
create table if not exists public.recurring_expenses (
  id                   uuid primary key default gen_random_uuid(),
  ledger_id            text not null references public.ledgers(id) on delete cascade,
  category             text not null default 'other',
  description          text,
  amount_dkk           numeric(12, 2) not null default 0,
  -- how often a new occurrence is materialised
  cadence              text not null default 'monthly' check (cadence in ('monthly', 'quarterly', 'yearly')),
  -- date of the next occurrence to materialise; advanced by cadence on generate.
  next_due_date        date not null,
  -- same split semantics as workspace_expenses: null => workspace default.
  split_rule           text check (split_rule in ('equal', 'usage', 'custom')),
  split_config         jsonb,
  -- who fronts the cost each occurrence; null => the template creator.
  paid_by_member_id    uuid references public.ledger_members(id) on delete set null,
  is_active            boolean not null default true,
  last_generated_at    timestamptz,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists recurring_expenses_ledger_idx
  on public.recurring_expenses (ledger_id, next_due_date)
  where deleted_at is null and is_active;

alter table public.recurring_expenses enable row level security;

drop policy if exists "Ledger members can read recurring expenses" on public.recurring_expenses;
create policy "Ledger members can read recurring expenses" on public.recurring_expenses
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

drop policy if exists "Admins can insert recurring expenses" on public.recurring_expenses;
create policy "Admins can insert recurring expenses" on public.recurring_expenses
  for insert to authenticated
  with check (public.is_ledger_admin(ledger_id));

drop policy if exists "Admins can update recurring expenses" on public.recurring_expenses;
create policy "Admins can update recurring expenses" on public.recurring_expenses
  for update to authenticated
  using (public.is_ledger_admin(ledger_id))
  with check (public.is_ledger_admin(ledger_id));

drop policy if exists "Admins can delete recurring expenses" on public.recurring_expenses;
create policy "Admins can delete recurring expenses" on public.recurring_expenses
  for delete to authenticated
  using (public.is_ledger_admin(ledger_id));

-- ── Write path: upsert_recurring_expense (admin) ──────────────────
-- Insert (recurring_id_value null) or update a template, re-checking admin
-- server-side, and emitting a recurring_expense_added/updated feed event.
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

-- ── Soft delete: soft_delete_recurring_expense (admin) ────────────
create or replace function public.soft_delete_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_template record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;
  if recurring_id_value is null then
    raise exception 'Missing recurring expense id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can delete recurring expenses' using errcode = '42501';
  end if;

  select * into existing_template
  from public.recurring_expenses
  where id = recurring_id_value
    and ledger_id = target_ledger_id
    and deleted_at is null
  for update;

  if existing_template.id is null then
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;

  update public.recurring_expenses
    set deleted_at = now(), is_active = false, updated_at = now()
  where id = recurring_id_value;

  return jsonb_build_object('deleted', true, 'id', recurring_id_value);
end;
$$;

-- ── Materialisation: generate_due_recurring_expenses ──────────────
-- Idempotent catch-up. For each active template whose next_due_date has arrived,
-- materialise a workspace_expenses row per missed occurrence into the ledger's
-- OPEN period, advancing next_due_date by the cadence until it is in the future.
-- Emits one system feed event per template that produced rows (the nudge). Any
-- member may trigger it (the client calls it on load); it is security definer so
-- it can write regardless of the caller's own expense-write scope. Returns the
-- total number of expenses generated.
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
  -- nothing this run; the next call catches up.
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1;

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

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;
grant execute on function public.soft_delete_recurring_expense(text, uuid) to authenticated;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('069_recurring_expenses',
        'Recurring expense templates + idempotent client catch-up materialisation into the open period (GVM-174).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 039: Make workspace listing stable when a signed-in email has more than one active member row.
-- The UI must see one row per workspace. If duplicate active rows exist for the same email/workspace,
-- prefer an admin role over member for that workspace instead of showing duplicate selector options.

create or replace function public.list_my_ledgers()
returns table (
  ledger_id text,
  slug text,
  name text,
  role text,
  member_id uuid,
  is_public_signup_enabled boolean,
  invite_required boolean,
  bootstrap_locked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked_members as (
    select
      l.id as ledger_id,
      l.slug,
      l.name,
      case when bool_or(lm.role = 'admin') then 'admin' else 'member' end as role,
      (array_agg(lm.id order by case when lm.role = 'admin' then 0 else 1 end, lm.created_at asc, lm.id asc))[1] as member_id,
      l.is_public_signup_enabled,
      l.invite_required,
      l.bootstrap_locked_at,
      l.created_at
    from public.ledgers l
    join public.ledger_members lm on lm.ledger_id = l.id
    where lm.is_active = true
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
    group by l.id, l.slug, l.name, l.is_public_signup_enabled, l.invite_required, l.bootstrap_locked_at, l.created_at
  )
  select
    ranked_members.ledger_id,
    ranked_members.slug,
    ranked_members.name,
    ranked_members.role,
    ranked_members.member_id,
    ranked_members.is_public_signup_enabled,
    ranked_members.invite_required,
    ranked_members.bootstrap_locked_at
  from ranked_members
  order by ranked_members.created_at asc, ranked_members.ledger_id asc;
$$;

revoke all on function public.list_my_ledgers() from public;
revoke all on function public.list_my_ledgers() from anon;
revoke all on function public.list_my_ledgers() from authenticated;
grant execute on function public.list_my_ledgers() to authenticated;


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('039_list_my_ledgers_dedup', 'De-duplicate list_my_ledgers rows so the workspace selector shows one stable row per workspace.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

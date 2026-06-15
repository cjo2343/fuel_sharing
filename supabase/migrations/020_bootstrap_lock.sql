-- Migration 020: permanently close bootstrap access once a real admin email is attached.
-- Safe to rerun.

alter table public.ledgers
  add column if not exists bootstrap_locked_at timestamptz;

create or replace function public.is_ledger_bootstrap_open(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ledger_members lm where lm.ledger_id = p_ledger_id
  )
  and not exists (
    select 1
    from public.ledgers l
    where l.id = p_ledger_id
      and l.bootstrap_locked_at is not null
  )
  and not exists (
    select 1
    from public.ledger_members lm
    where lm.ledger_id = p_ledger_id
      and lm.is_active = true
      and lm.email is not null
      and lm.email <> ''
  );
$$;

create or replace function public.lock_ledger_bootstrap_when_admin_email_attached()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true
    and new.role = 'admin'
    and new.email is not null
    and btrim(new.email) <> '' then
    update public.ledgers
    set bootstrap_locked_at = coalesce(bootstrap_locked_at, now()),
        updated_at = now()
    where id = new.ledger_id;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_ledger_bootstrap_on_admin_email on public.ledger_members;
create trigger lock_ledger_bootstrap_on_admin_email
after insert or update of email, role, is_active on public.ledger_members
for each row execute function public.lock_ledger_bootstrap_when_admin_email_attached();

-- Lock any existing ledgers that already have a real active admin email.
update public.ledgers l
set bootstrap_locked_at = coalesce(l.bootstrap_locked_at, now()),
    updated_at = now()
where exists (
  select 1
  from public.ledger_members lm
  where lm.ledger_id = l.id
    and lm.is_active = true
    and lm.role = 'admin'
    and lm.email is not null
    and btrim(lm.email) <> ''
);

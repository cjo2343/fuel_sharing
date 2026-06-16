-- Migration 027: Fix invite code generation pgcrypto lookup.
-- Ensure invite code generation works on Supabase projects where pgcrypto
-- lives outside the function search_path.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_ledger_invite(
  target_ledger_id text default 'main-car',
  invite_role text default 'member',
  invite_email text default null,
  expires_in_hours integer default 168,
  max_uses integer default 1
)
returns table (
  invite_id uuid,
  invite_code text,
  ledger_id text,
  role text,
  invited_email text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  generated_code text;
  normalized_role text := case when invite_role = 'admin' then 'admin' else 'member' end;
  normalized_email text := nullif(lower(btrim(coalesce(invite_email, ''))), '');
  safe_max_uses integer := greatest(coalesce(max_uses, 1), 1);
  safe_expires_at timestamptz := case
    when expires_in_hours is null or expires_in_hours <= 0 then now() + interval '7 days'
    else now() + make_interval(hours => least(expires_in_hours, 24 * 30))
  end;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can create invites' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not linked to this ledger' using errcode = '42501';
  end if;

  generated_code := 'fl-' || lower(encode(extensions.gen_random_bytes(16), 'hex'));

  insert into public.ledger_invites (
    ledger_id,
    invite_code_hash,
    role,
    invited_email,
    max_uses,
    uses_count,
    expires_at,
    created_by_member_id
  ) values (
    target_ledger_id,
    public.hash_ledger_invite_code(generated_code),
    normalized_role,
    normalized_email,
    safe_max_uses,
    0,
    safe_expires_at,
    actor_member_id
  ) returning id into invite_id;

  return query
  select invite_id, generated_code, target_ledger_id, normalized_role, normalized_email, safe_expires_at;
end;
$$;

revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from public;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from anon;
grant execute on function public.create_ledger_invite(text, text, text, integer, integer) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('027_invite_code_generation_pgcrypto_fix', 'Schema-qualify pgcrypto invite code generation so invite RPCs work on deployed Supabase projects.')
on conflict (migration_id) do update set
  description = excluded.description;

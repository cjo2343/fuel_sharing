-- Migration 042: Lock member onboarding to the invite flow.
-- The member-management admin RPC used to create brand-new members on a null
-- target_member_id (the "Add member" form). That was a parallel onboarding path
-- that bypassed invite consent, expiry, max-uses, and rate limits. New members
-- must now join by redeeming a workspace invite (redeem_ledger_invite); this RPC
-- may only UPDATE or deactivate members that already exist in the workspace.
-- Safe to rerun (create or replace; idempotent migration record).

create or replace function public.upsert_ledger_member_admin(
  target_ledger_id text default 'main-car',
  target_member_id uuid default null,
  member_name text default null,
  member_email text default null,
  member_mobilepay_phone text default null,
  member_role text default 'member',
  member_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_member public.ledger_members%rowtype;
  saved_member_id uuid;
  normalized_email text := nullif(lower(trim(coalesce(member_email, ''))), '');
  normalized_role text := case when member_role = 'admin' then 'admin' else 'member' end;
  active_admin_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage members' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not identify the current ledger admin' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(member_name, '')), '') is null then
    raise exception 'Member name is required' using errcode = '23502';
  end if;

  if normalized_email is null then
    raise exception 'Member login email is required' using errcode = '23502';
  end if;

  -- Invite-only onboarding: this RPC may only update existing members. New members
  -- join by redeeming a workspace invite (redeem_ledger_invite), which enforces
  -- consent, expiry, max-uses, and rate limits. Reject creating a brand-new member
  -- row (null target_member_id) for everyone, including the app owner.
  if target_member_id is null then
    raise exception 'New members join by redeeming a workspace invite; member management can only update existing members' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members
  where id = target_member_id and ledger_id = target_ledger_id
  for update;

  if existing_member.id is null then
    raise exception 'Member does not belong to this ledger' using errcode = '23503';
  end if;

  if existing_member.id = actor_member_id and (member_is_active is false or normalized_role <> 'admin') then
    raise exception 'Admins cannot demote or deactivate themselves' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  update public.ledger_members
  set name = trim(member_name),
      email = normalized_email,
      mobilepay_phone = nullif(trim(coalesce(member_mobilepay_phone, '')), ''),
      role = normalized_role,
      is_active = coalesce(member_is_active, true),
      updated_at = now()
  where id = target_member_id and ledger_id = target_ledger_id
  returning id into saved_member_id;

  select count(*) into active_admin_count
  from public.ledger_members
  where ledger_id = target_ledger_id and is_active = true and role = 'admin';

  if active_admin_count < 1 then
    raise exception 'At least one active admin is required' using errcode = '23514';
  end if;

  return saved_member_id;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('042_member_invite_only_creation_lockdown', 'upsert_ledger_member_admin updates existing members only; new members must redeem a workspace invite.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

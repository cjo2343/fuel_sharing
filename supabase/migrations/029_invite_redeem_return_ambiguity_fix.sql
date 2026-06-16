-- Migration 029: Fix invite redemption return-column ambiguity.
-- Redeeming an invite returned table columns named ledger_id/role, which can
-- collide with table columns inside UPDATE/INSERT RETURNING clauses. Store
-- return values in local variables and assign the output columns explicitly.

create or replace function public.redeem_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  member_id uuid,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
begin
  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  select * into invite_row
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1
  for update;

  if invite_row.id is null then
    raise exception 'Invite is invalid, expired, revoked, or already used.' using errcode = 'P0001';
  end if;

  if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
    raise exception 'This invite is for a different email address.' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = invite_row.ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else invite_row.role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = invite_row.ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (
      ledger_id,
      name,
      email,
      role,
      is_active
    ) values (
      invite_row.ledger_id,
      base_name,
      current_email,
      invite_row.role,
      true
    ) returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  update public.ledger_invites
  set uses_count = uses_count + 1,
      updated_at = now()
  where id = invite_row.id;

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

revoke all on function public.redeem_ledger_invite(text) from public;
revoke all on function public.redeem_ledger_invite(text) from anon;
grant execute on function public.redeem_ledger_invite(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '029_invite_redeem_return_ambiguity_fix',
  'Fixes ambiguous ledger_id/role return-column references in redeem_ledger_invite so login invite auto-redemption and signed-in dashboard redemption work without requiring a second paste.'
)
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();

-- Migration 059: emit a member_joined activity event on invite redemption (GVM-127)
--
-- Joining a workspace produced no activity/audit entry — existing members had no
-- record that someone new came in. Recreate redeem_ledger_invite (keeping the
-- VOLATILE volatility from migration 058) so it writes a 'member_joined' event
-- into public.ledger_events after the member is added or reactivated. The event
-- follows the migration 051/052 pattern (actor = the joining member) and, via the
-- ledger_events INSERT webhook, also pushes "new activity" to the other members.
-- The mobile feed already renders any member_* event with a user-plus icon, so no
-- client change is needed.

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
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text;
  target_role text := 'member';
  is_stable boolean := false;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
  was_existing boolean := false;
  saved_member_name text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into target_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  if target_ledger_id is not null then
    is_stable := true;
  else
    -- Legacy one-time invite.
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

    target_ledger_id := invite_row.ledger_id;
    target_role := invite_row.role;
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    was_existing := true;
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else target_role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  -- Only one-time invites consume a use; the stable code is reusable.
  if not is_stable then
    update public.ledger_invites
    set uses_count = uses_count + 1,
        updated_at = now()
    where id = invite_row.id;
  end if;

  -- Activity / audit entry for the join (GVM-127). Actor = the joining member;
  -- the ledger_events INSERT webhook pushes "new activity" to the others.
  select lm.name into saved_member_name
  from public.ledger_members lm
  where lm.id = saved_member_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    redeemed_ledger_id,
    'member_joined',
    coalesce(saved_member_name, 'Et nyt medlem') || ' kom med i gruppen',
    case when was_existing then 'Kom med i gruppen igen' else 'Nyt medlem' end,
    saved_member_id,
    current_email,
    jsonb_build_object(
      'via', case when is_stable then 'join_code' else 'invite' end,
      'new_member', not was_existing
    )
  );

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('059_member_joined_event', 'emit a member_joined activity event on invite redemption (GVM-127)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

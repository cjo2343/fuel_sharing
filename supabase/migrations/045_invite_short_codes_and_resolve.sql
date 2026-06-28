-- Migration 045: Stable per-workspace join code + join-by-code resolution (GVM-17).
-- DRAFT — review before applying.
--
-- Each workspace keeps ONE stable, human-typeable join code in the GV-XXXX
-- format (e.g. GV-7F2K). It is reusable, does not expire, and is stored in
-- plaintext on the ledger so the owner can re-display it any time. Read access
-- is admin-only (via the RPCs below — the column is not exposed through a
-- SELECT policy). A leaked code can be invalidated with rotate.
--
--   - generate_workspace_join_code()         internal unique GV-XXXX generator
--   - get_workspace_join_code(ledger)        admin: get-or-create the code
--   - rotate_workspace_join_code(ledger)     admin: mint a fresh code
--   - resolve_ledger_invite(code)            preview a group before joining
--   - redeem_ledger_invite(code)             join the group
--
-- resolve/redeem accept the stable code first, then fall back to the legacy
-- one-time ledger_invites (create_ledger_invite, unchanged) so existing fl-
-- codes and email-pinned invites keep working — and the live web app's invite
-- path is untouched.

-- ── Stable code column ────────────────────────────────────────────────
alter table public.ledgers
  add column if not exists join_code text,
  add column if not exists join_code_rotated_at timestamptz;

create unique index if not exists ledgers_join_code_unique_idx
  on public.ledgers (join_code) where join_code is not null;

-- ── Code generation ───────────────────────────────────────────────────
create or replace function public.generate_workspace_join_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Crockford-ish base32 without easily-confused chars (no I, O, 0, 1).
  code_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  rand_bytes bytea;
  candidate text;
  tries integer := 0;
begin
  loop
    tries := tries + 1;
    rand_bytes := extensions.gen_random_bytes(4);
    candidate := 'GV-'
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 0) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 1) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 2) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 3) % 32), 1);
    exit when not exists (select 1 from public.ledgers where join_code = candidate);
    if tries >= 20 then
      raise exception 'Could not generate a unique join code; please try again.' using errcode = 'P0001';
    end if;
  end loop;
  return candidate;
end;
$$;

-- ── Get-or-create the workspace's stable code (admin) ──────────────────
create or replace function public.get_workspace_join_code(target_ledger_id text default 'main-car')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_code text;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can view the workspace join code' using errcode = '42501';
  end if;

  select join_code into existing_code from public.ledgers where id = target_ledger_id;

  if existing_code is null then
    existing_code := public.generate_workspace_join_code();
    update public.ledgers
    set join_code = existing_code,
        join_code_rotated_at = now(),
        updated_at = now()
    where id = target_ledger_id;
  end if;

  return existing_code;
end;
$$;

-- ── Rotate the workspace's stable code (admin) ─────────────────────────
create or replace function public.rotate_workspace_join_code(target_ledger_id text default 'main-car')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  new_code text;
begin
  perform public.enforce_onboarding_rate_limit('rotate_workspace_join_code', target_ledger_id, 10, 60);

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can rotate the workspace join code' using errcode = '42501';
  end if;

  new_code := public.generate_workspace_join_code();
  update public.ledgers
  set join_code = new_code,
      join_code_rotated_at = now(),
      updated_at = now()
  where id = target_ledger_id;

  return new_code;
end;
$$;

-- ── Code resolution (preview before join) ─────────────────────────────
create or replace function public.resolve_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  ledger_name text,
  member_count integer,
  owner_name text,
  role text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  matched_ledger_id text;
  matched_role text := 'member';
  invite_row public.ledger_invites%rowtype;
begin
  perform public.enforce_onboarding_rate_limit('resolve_ledger_invite', null, 15, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to look up an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into matched_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  -- Fall back to a legacy one-time invite.
  if matched_ledger_id is null then
    select * into invite_row
    from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null
      and (li.expires_at is null or li.expires_at > now())
      and li.uses_count < li.max_uses
    order by li.created_at asc
    limit 1;

    if invite_row.id is null then
      return; -- invalid / expired / used: reveal nothing
    end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
      return; -- pinned to a different email
    end if;

    matched_ledger_id := invite_row.ledger_id;
    matched_role := invite_row.role;
  end if;

  return query
  select
    l.id,
    l.name,
    (
      select count(*)::integer
      from public.ledger_members m
      where m.ledger_id = l.id and m.is_active = true
    ),
    (
      select o.name
      from public.ledger_members o
      where o.ledger_id = l.id and o.role = 'admin' and o.is_active = true
      order by o.created_at asc
      limit 1
    ),
    matched_role
  from public.ledgers l
  where l.id = matched_ledger_id;
end;
$$;

-- ── Redeem (join) — stable code, then legacy one-time fallback ─────────
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

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

-- ── Restore the legacy one-time invite generator ──────────────────────
-- An earlier draft of this migration changed create_ledger_invite to emit
-- one-time GV-XXXX codes. The stable workspace code makes that unnecessary, so
-- we restore create_ledger_invite to its original migration-030 form (fl-<hex>
-- one-time / email-pinned invites). This is a no-op on a database that only
-- ever saw the final migration, and undoes the change on one that ran the draft
-- — so the live web app's invite path is unaffected either way.
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
  perform public.enforce_onboarding_rate_limit('create_ledger_invite', target_ledger_id, 20, 60);

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

revoke all on function public.generate_workspace_join_code() from public;
revoke all on function public.generate_workspace_join_code() from anon;
revoke all on function public.generate_workspace_join_code() from authenticated;
revoke all on function public.get_workspace_join_code(text) from public;
revoke all on function public.get_workspace_join_code(text) from anon;
revoke all on function public.rotate_workspace_join_code(text) from public;
revoke all on function public.rotate_workspace_join_code(text) from anon;
revoke all on function public.resolve_ledger_invite(text) from public;
revoke all on function public.resolve_ledger_invite(text) from anon;
grant execute on function public.get_workspace_join_code(text) to authenticated;
grant execute on function public.rotate_workspace_join_code(text) to authenticated;
grant execute on function public.resolve_ledger_invite(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('045_invite_short_codes_and_resolve', 'Stable per-workspace GV-XXXX join code (get/rotate) plus resolve/redeem dual-path for join-by-code.')
on conflict (migration_id) do update set
  description = excluded.description;

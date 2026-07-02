-- Migration 058: resolve_ledger_invite must be VOLATILE, not STABLE (GVM-123)
--
-- resolve_ledger_invite was declared STABLE, but its first statement calls
-- enforce_onboarding_rate_limit(), which does an `insert ... on conflict` into
-- ledger_onboarding_rate_limits. PostgREST executes STABLE functions in a
-- READ-ONLY transaction, so that write fails with
--   "cannot execute INSERT in a read-only transaction"
-- and the whole invite-lookup / join flow is blocked. (Only surfaced now that a
-- real signed-in session hits the RPC — demo mode uses a local stand-in.)
--
-- A function that writes must be VOLATILE. Recreate it identically, dropping
-- the STABLE marker (VOLATILE is the default). Body is otherwise unchanged.

create or replace function public.resolve_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  ledger_name text,
  member_count integer,
  owner_name text,
  role text
)
language plpgsql
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('058_resolve_invite_volatile_fix', 'resolve_ledger_invite must be VOLATILE, not STABLE (GVM-123)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

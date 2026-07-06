-- Migration 079: rename a workspace member (self or, for admins, anyone) (GVM-139)
--
-- Member names are set only at create/join time and were read-only afterwards, so a
-- member stuck with a wrong name (e.g. the pre-GVM-138 email-local-part bug) needed
-- raw SQL to fix. This adds set_member_name: a member may rename themselves, and an
-- admin may rename any member in the workspace. Names stay unique per ledger — an
-- explicit rename that clashes with a DIFFERENT member is rejected (so the caller can
-- pick another), rather than silently suffixed the way an auto-join is. Emits a
-- member_renamed feed event (051/052 pattern) when the client supplies a title.

create or replace function public.set_member_name(
  target_ledger_id text,
  target_member_id uuid,
  new_name text,
  event_title text default null,
  event_body text default null
)
returns table (member_id uuid, ledger_id text, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  safe_name text := btrim(coalesce(new_name, ''));
  saved public.ledger_members%rowtype;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not an active member of this workspace.' using errcode = '42501';
  end if;

  -- Self-rename is always allowed; renaming anyone else requires admin.
  if target_member_id <> actor_member_id and not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only an admin can rename other members.' using errcode = '42501';
  end if;

  if safe_name = '' then
    raise exception 'Name is required.' using errcode = '22023';
  end if;
  if length(safe_name) > 60 then
    raise exception 'Name is too long.' using errcode = '22001';
  end if;

  -- Target must be an active member of this ledger.
  if not exists (
    select 1 from public.ledger_members lm
    where lm.id = target_member_id
      and lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ) then
    raise exception 'Member was not found in this workspace.' using errcode = 'P0002';
  end if;

  -- Names are unique per ledger; reject a clash with a DIFFERENT member so the caller
  -- can choose another (an explicit rename shouldn't get silently suffixed).
  if exists (
    select 1 from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.name = safe_name
      and lm.id <> target_member_id
  ) then
    raise exception 'That name is already used in this workspace.' using errcode = '23505';
  end if;

  update public.ledger_members lm
  set name = safe_name,
      updated_at = now()
  where lm.id = target_member_id
    and lm.ledger_id = target_ledger_id
  returning lm.* into saved;

  if saved.id is null then
    raise exception 'Member name could not be updated.' using errcode = 'P0001';
  end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'member_renamed',
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('member_id', target_member_id, 'name', safe_name)
    );
  end if;

  set_member_name.member_id := saved.id;
  set_member_name.ledger_id := saved.ledger_id;
  set_member_name.name := saved.name;
  return next;
end;
$$;

revoke all on function public.set_member_name(text, uuid, text, text, text) from public;
revoke all on function public.set_member_name(text, uuid, text, text, text) from anon;
grant execute on function public.set_member_name(text, uuid, text, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('079_set_member_name',
        'Rename a workspace member — self, or any member for admins (GVM-139).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

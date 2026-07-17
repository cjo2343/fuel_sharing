-- Migration 126: publish and clear app announcements atomically.
--
-- The owner endpoint previously deactivated the current banner and inserted its
-- replacement in separate HTTP requests. An insert or network failure after the
-- first request left the app with no active banner. These service-role-only RPCs
-- serialize replacement/clear operations in one database transaction, while a
-- partial unique index enforces the single-active-row invariant for every writer.

-- Repair any historical race residue before adding the invariant. Keep the newest
-- active row and retire older active rows. Data-only cleanup is intentionally not
-- mirrored in the consolidated schema.
with ranked as (
  select id,
         row_number() over (order by created_at desc, id desc) as position
    from public.app_announcements
   where active = true
)
update public.app_announcements announcement
   set active = false
  from ranked
 where announcement.id = ranked.id
   and ranked.position > 1;

create unique index if not exists app_announcements_one_active_idx
  on public.app_announcements ((active))
  where active = true;

create or replace function public.replace_app_announcement(
  announcement_text text,
  announcement_url text default null,
  announcement_variant text default 'info',
  announcement_starts_at timestamptz default null,
  announcement_expires_at timestamptz default null,
  announcement_created_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_text text;
  normalized_url text;
  normalized_variant text;
  normalized_created_by text;
  created_row public.app_announcements;
begin
  normalized_text := btrim(coalesce(announcement_text, ''));
  normalized_url := nullif(btrim(coalesce(announcement_url, '')), '');
  normalized_variant := lower(btrim(coalesce(announcement_variant, 'info')));
  normalized_created_by := nullif(lower(btrim(coalesce(announcement_created_by, ''))), '');

  if normalized_text = '' or char_length(normalized_text) > 280 then
    raise exception 'Announcement text must contain 1 to 280 characters' using errcode = '22023';
  end if;

  if normalized_variant not in ('info', 'warning', 'success') then
    raise exception 'Invalid announcement variant' using errcode = '22023';
  end if;

  if normalized_url is not null
     and lower(normalized_url) not like 'https://%'
     and lower(normalized_url) not like 'govehlo://%' then
    raise exception 'Invalid announcement URL scheme' using errcode = '22023';
  end if;

  if announcement_starts_at is not null
     and announcement_expires_at is not null
     and announcement_expires_at <= announcement_starts_at then
    raise exception 'Announcement expiry must be after its start' using errcode = '22023';
  end if;

  if normalized_created_by is not null and char_length(normalized_created_by) > 320 then
    raise exception 'Announcement creator is too long' using errcode = '22023';
  end if;

  -- All callers of the companion clear command use the same transaction-scoped
  -- lock. The unique index remains the final invariant if another writer bypasses
  -- these commands with the service role.
  perform pg_advisory_xact_lock(hashtext('public.app_announcements.active'));

  update public.app_announcements
     set active = false
   where active = true;

  insert into public.app_announcements (
    text, url, variant, active, starts_at, expires_at, created_by
  ) values (
    normalized_text,
    normalized_url,
    normalized_variant,
    true,
    announcement_starts_at,
    announcement_expires_at,
    normalized_created_by
  )
  returning * into created_row;

  return to_jsonb(created_row);
end;
$$;

create or replace function public.clear_app_announcements()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cleared_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('public.app_announcements.active'));

  update public.app_announcements
     set active = false
   where active = true;

  get diagnostics cleared_count = row_count;
  return cleared_count;
end;
$$;

revoke all on function public.replace_app_announcement(text, text, text, timestamptz, timestamptz, text) from public;
revoke all on function public.replace_app_announcement(text, text, text, timestamptz, timestamptz, text) from anon;
revoke all on function public.replace_app_announcement(text, text, text, timestamptz, timestamptz, text) from authenticated;
grant execute on function public.replace_app_announcement(text, text, text, timestamptz, timestamptz, text) to service_role;

revoke all on function public.clear_app_announcements() from public;
revoke all on function public.clear_app_announcements() from anon;
revoke all on function public.clear_app_announcements() from authenticated;
grant execute on function public.clear_app_announcements() to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '126_atomic_app_announcements',
  'Add service-role-only transactional replace/clear announcement RPCs, serialize active-banner writes, repair historical duplicates, and enforce at most one active row with a partial unique index.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

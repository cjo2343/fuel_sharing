-- Migration 053: Seed an open settlement period when a workspace is created (GVM-97).
-- The seeded main-car ledger got an open period in 001, and production_activity_reset
-- opens one on reset, but create_private_ledger_workspace never did — so every
-- freshly created workspace had ZERO open periods. Trip + fuel logging require an
-- open period (upsert_trip_with_participants / upsert_fuel_payment raise otherwise),
-- so the very first trip in a new workspace always failed with "no open period".
--
-- Fix: create_private_ledger_workspace now opens a "Current period" for the new
-- workspace (partial unique index one_open_settlement_period_per_ledger keeps it to
-- exactly one). Recreated from the 052 definition (adds only the period insert);
-- signature + return type unchanged, so no client change is needed.
create or replace function public.create_private_ledger_workspace(
  workspace_name text,
  workspace_slug text default null
)
returns table (
  ledger_id text,
  slug text,
  name text,
  admin_member_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_slug text;
  new_ledger_id text;
  new_member_id uuid;
  current_email text := public.current_user_email();
begin
  perform public.enforce_onboarding_rate_limit('create_private_workspace', null, 3, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to create a private ledger workspace.' using errcode = 'P0001';
  end if;

  normalized_slug := public.normalize_ledger_slug(coalesce(workspace_slug, workspace_name));
  if normalized_slug is null or length(normalized_slug) < 3 then
    raise exception 'Workspace slug must contain at least 3 letters or numbers.' using errcode = 'P0001';
  end if;

  if normalized_slug = 'main-car' then
    raise exception 'main-car is reserved for the existing private beta ledger.' using errcode = 'P0001';
  end if;

  new_ledger_id := normalized_slug;

  insert into public.ledgers (
    id,
    slug,
    name,
    is_public_signup_enabled,
    invite_required,
    bootstrap_locked_at
  ) values (
    new_ledger_id,
    normalized_slug,
    nullif(btrim(workspace_name), ''),
    false,
    true,
    now()
  );

  insert into public.ledger_members (
    ledger_id,
    name,
    email,
    role,
    is_active
  ) values (
    new_ledger_id,
    split_part(current_email, '@', 1),
    current_email,
    'admin',
    true
  ) returning id into new_member_id;

  update public.ledgers
  set created_by_member_id = new_member_id,
      updated_at = now()
  where id = new_ledger_id;

  -- Open the first settlement period so trips + fuel can be logged immediately
  -- (GVM-97). Matches the main-car seed (001) and production_activity_reset (004).
  insert into public.settlement_periods (ledger_id, status, label)
  values (new_ledger_id, 'open', 'Current period');

  -- Activity/audit event (GVM-96).
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    new_ledger_id,
    'workspace_created',
    coalesce(nullif(btrim(workspace_name), ''), normalized_slug),
    'Nyt arbejdsområde oprettet',
    new_member_id,
    current_email,
    jsonb_build_object('slug', normalized_slug)
  );

  return query
  select new_ledger_id, normalized_slug, nullif(btrim(workspace_name), ''), new_member_id;
exception
  when unique_violation then
    raise exception 'Workspace slug is already in use.' using errcode = '23505';
end;
$$;

grant execute on function public.create_private_ledger_workspace(text, text) to authenticated;

-- Backfill: any already-created workspace that has no open period gets one, so
-- existing test/early workspaces can log trips without being recreated.
insert into public.settlement_periods (ledger_id, status, label)
select l.id, 'open', 'Current period'
from public.ledgers l
where not exists (
  select 1 from public.settlement_periods sp
  where sp.ledger_id = l.id and sp.status = 'open'
);

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('053_seed_open_period_on_workspace_create', 'create_private_ledger_workspace opens an initial settlement period so trips/fuel can be logged in a new workspace; backfills an open period for any existing workspace missing one (GVM-97).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

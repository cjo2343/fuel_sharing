-- Migration 052: Emit ledger_events for workspace-create and vehicle add/edit (GVM-96).
-- Migration 051 gave trip/fuel/booking their activity events, but two owner-facing
-- actions still left no trace in the operator audit trail (admin.govehlo.dk reads
-- ledger_events):
--   1. Creating a workspace — the create RPC never wrote an event.
--   2. Adding/editing the car — the app writes vehicle columns with a DIRECT
--      `ledgers` update (updateLedgerSettings), so no RPC hook fires and no event
--      is recorded.
-- This migration closes both gaps. Workspace-create emits a server-built
-- `workspace_created` event; a new `update_ledger_vehicle` RPC becomes the sole
-- write path for vehicle settings so add/edit can emit `vehicle_added` /
-- `vehicle_updated` (client-built title/body, same convention as 051).

-- ── 1. workspace_created ──────────────────────────────────────────────
-- Recreate create_private_ledger_workspace (latest def: migration 030) with an
-- added ledger_events insert. Signature + return type are unchanged, so a plain
-- create-or-replace suffices — no client change to createWorkspace() is needed.
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

  -- Activity/audit event (GVM-96). Server-built (no client params) so every
  -- client records it. The owner is renamed right after via
  -- upsert_ledger_member_admin, so we keep the body name-free and let the feed +
  -- operator console resolve the actor from actor_member_id.
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

-- ── 2. vehicle_added / vehicle_updated ────────────────────────────────
-- The app has been writing vehicle settings with a direct `ledgers` update
-- (updateLedgerSettings), which the owner-only RLS "Ledger admins can update
-- ledgers" already guards but which fires no event. This RPC becomes the write
-- path for vehicle fields: it re-checks admin, updates ONLY the columns actually
-- provided (coalesce keeps the rest), and emits one activity event per save.
-- Nulling a field is intentionally not supported (the app never clears these).
create or replace function public.update_ledger_vehicle(
  target_ledger_id text,
  vehicle_plate_value text default null,
  vehicle_info_value jsonb default null,
  vehicle_lookup_source_value text default null,
  vehicle_lookup_at_value timestamptz default null,
  fuel_type_value text default null,
  estimated_consumption_value numeric default null,
  fuel_tank_capacity_value numeric default null,
  event_type_value text default 'vehicle_updated',
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  normalized_event_type text;
  changed_keys text[] := array[]::text[];
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update the vehicle' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  normalized_event_type := case
    when event_type_value = 'vehicle_added' then 'vehicle_added'
    else 'vehicle_updated'
  end;

  update public.ledgers set
    vehicle_plate = coalesce(vehicle_plate_value, vehicle_plate),
    vehicle_info = coalesce(vehicle_info_value, vehicle_info),
    vehicle_lookup_source = coalesce(vehicle_lookup_source_value, vehicle_lookup_source),
    vehicle_lookup_at = coalesce(vehicle_lookup_at_value, vehicle_lookup_at),
    fuel_type = coalesce(fuel_type_value, fuel_type),
    estimated_consumption_l_per_100km = coalesce(estimated_consumption_value, estimated_consumption_l_per_100km),
    fuel_tank_capacity_l = coalesce(fuel_tank_capacity_value, fuel_tank_capacity_l),
    updated_at = now()
  where id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '22023';
  end if;

  -- Record which fields the save touched (redacted: keys only, no values —
  -- GDPR data minimisation; the human-readable summary lives in event_body).
  if vehicle_plate_value is not null then changed_keys := array_append(changed_keys, 'plate'); end if;
  if fuel_type_value is not null then changed_keys := array_append(changed_keys, 'fuel_type'); end if;
  if estimated_consumption_value is not null then changed_keys := array_append(changed_keys, 'consumption'); end if;
  if fuel_tank_capacity_value is not null then changed_keys := array_append(changed_keys, 'tank'); end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      normalized_event_type,
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('changed', to_jsonb(changed_keys))
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('052_activity_events_for_workspace_and_vehicle', 'Workspace-create emits a workspace_created event; new update_ledger_vehicle RPC becomes the vehicle write path and emits vehicle_added/vehicle_updated so the operator audit trail (ledger_events) captures both (GVM-96).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 138: vehicle incidents + photos (GVM-396)
--
-- A shared-car damage & incident log. Members record what happened to the car
-- (dents, scrapes, breakdowns, insurance matters) with an incident date, an
-- optional odometer, an optional link to the booking or trip it happened on, a
-- repair-status lifecycle, an optional free-text insurance claim number
-- (skadenummer), and optional photos. Every write goes through a security-definer
-- RPC so the SAME membership + identity gates apply no matter which client calls
-- them, and create + status-change log a ledger_events row -- that is what drives
-- the activity feed and cross-client live sync (migration 051/052 pattern).
--
-- Identity policy (GV-253): the reporter is always resolved from the caller, never
-- trusted from a param, and only a workspace admin OR the incident's reporter may
-- edit an incident (kept strict for v1 -- that covers driver + every other field).
--
-- Photos live in a PRIVATE Supabase Storage bucket, workspace-scoped by the leading
-- path segment (<ledger_id>/<incident_id>/<uuid>.<ext>). The photo ROWS are
-- registered through add_incident_photo / delete_incident_photo, so the database is
-- the authority on who may attach or detach a photo; the storage.objects policies
-- are workspace-level defense-in-depth on top.
--
-- STORAGE COMPATIBILITY -- READ BEFORE EDITING. The `storage` schema only exists in
-- a real Supabase project. The CI guards (schema-equivalence replay, role matrix,
-- db-types) run in a PLAIN Postgres container with NO storage schema. So EVERY
-- storage statement below (the bucket row + the storage.objects policies) is wrapped
-- in a `do $$ begin if exists (storage schema) then ... end if; end $$;` guard: in
-- plain Postgres the guard is false and nothing storage-related runs (both replays
-- stay identical and pass); in prod the guard is true and the real bucket + policies
-- are created. The storage half therefore ONLY takes effect when this SQL is applied
-- in the real Supabase SQL Editor.

-- ── 1. Incident table ────────────────────────────────────────────────────────
create table if not exists public.vehicle_incidents (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  reporter_member_id uuid references public.ledger_members(id) on delete set null,
  driver_member_id uuid references public.ledger_members(id) on delete set null,
  booking_id uuid references public.car_bookings(id) on delete set null,
  trip_id uuid references public.trips(id) on delete set null,
  incident_date date not null,
  odometer integer check (odometer is null or odometer > 0),
  title text not null,
  description text not null,
  repair_status text not null default 'open'
    check (repair_status in ('open', 'under_repair', 'repaired', 'closed')),
  insurance_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vehicle_incidents_ledger_date_idx
  on public.vehicle_incidents (ledger_id, incident_date desc, id);

create index if not exists vehicle_incidents_ledger_status_idx
  on public.vehicle_incidents (ledger_id, repair_status);

create index if not exists vehicle_incidents_booking_idx
  on public.vehicle_incidents (booking_id) where booking_id is not null;

create index if not exists vehicle_incidents_trip_idx
  on public.vehicle_incidents (trip_id) where trip_id is not null;

alter table public.vehicle_incidents enable row level security;

drop policy if exists "Ledger members can read vehicle incidents"
  on public.vehicle_incidents;
create policy "Ledger members can read vehicle incidents"
  on public.vehicle_incidents
  for select
  using (public.is_ledger_member(ledger_id));

-- Reads for workspace members only; all writes go through the RPCs below.
revoke all on table public.vehicle_incidents from public;
revoke all on table public.vehicle_incidents from anon;
revoke all on table public.vehicle_incidents from authenticated;
revoke all on table public.vehicle_incidents from service_role;
grant select on table public.vehicle_incidents to authenticated;
grant select on table public.vehicle_incidents to service_role;

-- ── 2. Incident photos table ─────────────────────────────────────────────────
create table if not exists public.vehicle_incident_photos (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.vehicle_incidents(id) on delete cascade,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  storage_path text not null unique,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vehicle_incident_photos_incident_idx
  on public.vehicle_incident_photos (incident_id, created_at, id);

alter table public.vehicle_incident_photos enable row level security;

drop policy if exists "Ledger members can read vehicle incident photos"
  on public.vehicle_incident_photos;
create policy "Ledger members can read vehicle incident photos"
  on public.vehicle_incident_photos
  for select
  using (public.is_ledger_member(ledger_id));

-- Reads for workspace members only; inserts/deletes go through the photo RPCs.
revoke all on table public.vehicle_incident_photos from public;
revoke all on table public.vehicle_incident_photos from anon;
revoke all on table public.vehicle_incident_photos from authenticated;
revoke all on table public.vehicle_incident_photos from service_role;
grant select on table public.vehicle_incident_photos to authenticated;
grant select on table public.vehicle_incident_photos to service_role;

-- ── 3. Write RPCs ────────────────────────────────────────────────────────────
-- Create an incident. Any active workspace member may log one; the reporter is
-- resolved from the caller (current_ledger_member_id), never a param. Follows the
-- 051/052 activity-event pattern: the client supplies event_title/event_body and
-- the RPC writes one ledger_events row on create so the feed + realtime light up.
create or replace function public.log_vehicle_incident(
  target_ledger_id text,
  incident_date_value date,
  title_value text,
  description_value text,
  driver_member_id_value uuid default null,
  booking_id_value uuid default null,
  trip_id_value uuid default null,
  odometer_value integer default null,
  repair_status_value text default 'open',
  insurance_ref_value text default null,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_incident_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can log incidents' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if nullif(btrim(title_value), '') is null then
    raise exception 'Incident title is required' using errcode = '22023';
  end if;

  if nullif(btrim(description_value), '') is null then
    raise exception 'Incident description is required' using errcode = '22023';
  end if;

  if repair_status_value is null
     or repair_status_value not in ('open', 'under_repair', 'repaired', 'closed') then
    raise exception 'Invalid repair status' using errcode = '22023';
  end if;

  if odometer_value is not null and odometer_value <= 0 then
    raise exception 'Odometer must be positive' using errcode = '22023';
  end if;

  -- member_belongs_to_ledger(null, ...) is true, so this also allows "no driver".
  if not public.member_belongs_to_ledger(driver_member_id_value, target_ledger_id) then
    raise exception 'Incident driver must belong to this ledger' using errcode = '23514';
  end if;

  if booking_id_value is not null and not exists (
    select 1 from public.car_bookings cb
    where cb.id = booking_id_value and cb.ledger_id = target_ledger_id
  ) then
    raise exception 'Linked booking must belong to this ledger' using errcode = '22023';
  end if;

  if trip_id_value is not null and not exists (
    select 1 from public.trips t
    where t.id = trip_id_value and t.ledger_id = target_ledger_id
  ) then
    raise exception 'Linked trip must belong to this ledger' using errcode = '22023';
  end if;

  insert into public.vehicle_incidents (
    ledger_id, reporter_member_id, driver_member_id, booking_id, trip_id,
    incident_date, odometer, title, description, repair_status, insurance_ref
  ) values (
    target_ledger_id, v_actor_member_id, driver_member_id_value, booking_id_value, trip_id_value,
    incident_date_value, odometer_value, btrim(title_value), btrim(description_value),
    repair_status_value, nullif(btrim(insurance_ref_value), '')
  )
  returning id into v_incident_id;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'incident_logged', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('incident_id', v_incident_id)
    );
  end if;

  return jsonb_build_object(
    'incident_id', v_incident_id,
    'ledger_id', target_ledger_id
  );
end;
$$;

revoke all on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text) from public;
grant execute on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text) to authenticated;

-- Edit an incident. GV-253, kept strict for v1: only a workspace admin OR the
-- incident's original reporter may edit ANY field (driver + everything else). Null
-- args mean "leave unchanged"; non-null args replace. When the client supplies an
-- event_title (typically on a status change) the RPC logs a ledger_events row so
-- the change reaches the feed + live sync.
create or replace function public.update_vehicle_incident(
  target_incident_id uuid,
  title_value text default null,
  description_value text default null,
  repair_status_value text default null,
  insurance_ref_value text default null,
  driver_member_id_value uuid default null,
  incident_date_value date default null,
  odometer_value integer default null,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident public.vehicle_incidents%rowtype;
  v_actor_member_id uuid;
  v_new_status text;
  v_status_changed boolean;
begin
  if target_incident_id is null then
    raise exception 'Missing incident id' using errcode = '22023';
  end if;

  select * into v_incident
  from public.vehicle_incidents vi
  where vi.id = target_incident_id;

  if v_incident.id is null then
    raise exception 'Incident was not found' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_incident.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Only workspace members can edit incidents' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_incident.ledger_id)
    or coalesce(v_incident.reporter_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the incident reporter or a workspace admin can edit this incident' using errcode = '42501';
  end if;

  if repair_status_value is not null
     and repair_status_value not in ('open', 'under_repair', 'repaired', 'closed') then
    raise exception 'Invalid repair status' using errcode = '22023';
  end if;

  if odometer_value is not null and odometer_value <= 0 then
    raise exception 'Odometer must be positive' using errcode = '22023';
  end if;

  if driver_member_id_value is not null
     and not public.member_belongs_to_ledger(driver_member_id_value, v_incident.ledger_id) then
    raise exception 'Incident driver must belong to this ledger' using errcode = '23514';
  end if;

  v_new_status := coalesce(repair_status_value, v_incident.repair_status);
  v_status_changed := v_new_status is distinct from v_incident.repair_status;

  update public.vehicle_incidents vi
  set title = coalesce(nullif(btrim(title_value), ''), vi.title),
      description = coalesce(nullif(btrim(description_value), ''), vi.description),
      repair_status = v_new_status,
      insurance_ref = case
        when insurance_ref_value is null then vi.insurance_ref
        else nullif(btrim(insurance_ref_value), '')
      end,
      driver_member_id = coalesce(driver_member_id_value, vi.driver_member_id),
      incident_date = coalesce(incident_date_value, vi.incident_date),
      odometer = coalesce(odometer_value, vi.odometer),
      updated_at = now()
  where vi.id = target_incident_id;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      v_incident.ledger_id, 'incident_updated', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('incident_id', target_incident_id, 'repair_status', v_new_status, 'status_changed', v_status_changed)
    );
  end if;

  return jsonb_build_object(
    'incident_id', target_incident_id,
    'ledger_id', v_incident.ledger_id,
    'repair_status', v_new_status,
    'status_changed', v_status_changed
  );
end;
$$;

revoke all on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text) from public;
grant execute on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text) to authenticated;

-- Register a photo against an incident. Any workspace member may attach a photo to
-- an incident in their own workspace. The storage_path MUST live under the
-- incident's own <ledger_id>/<incident_id>/ prefix, so a member cannot register a
-- row that points at another workspace's or incident's object.
create or replace function public.add_incident_photo(
  p_incident_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident public.vehicle_incidents%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_photo_id uuid;
begin
  if p_incident_id is null then
    raise exception 'Missing incident id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Missing storage path' using errcode = '22023';
  end if;

  select * into v_incident
  from public.vehicle_incidents vi
  where vi.id = p_incident_id;

  if v_incident.id is null then
    raise exception 'Incident was not found' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_incident.ledger_id) then
    raise exception 'Only ledger members can attach incident photos' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_incident.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<incident_id>/<uuid>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_incident.ledger_id || '/' || p_incident_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Storage path must live under the incident''s workspace/incident prefix' using errcode = '22023';
  end if;

  insert into public.vehicle_incident_photos (
    incident_id, ledger_id, storage_path, created_by_member_id
  ) values (
    p_incident_id, v_incident.ledger_id, p_storage_path, v_actor_member_id
  )
  returning id into v_photo_id;

  return jsonb_build_object(
    'photo_id', v_photo_id,
    'incident_id', p_incident_id,
    'ledger_id', v_incident.ledger_id
  );
end;
$$;

revoke all on function public.add_incident_photo(uuid, text) from public;
grant execute on function public.add_incident_photo(uuid, text) to authenticated;

-- Delete a registered incident photo. Only a workspace admin or the member who
-- uploaded it may delete it. The storage object itself is cleaned up by the client
-- (and the storage.objects delete policy gates that to workspace members); THIS row
-- is the authority on who may detach a photo.
create or replace function public.delete_incident_photo(
  p_photo_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_photo public.vehicle_incident_photos%rowtype;
  v_actor_member_id uuid;
begin
  if p_photo_id is null then
    raise exception 'Missing photo id' using errcode = '22023';
  end if;

  select * into v_photo
  from public.vehicle_incident_photos vip
  where vip.id = p_photo_id;

  if v_photo.id is null then
    raise exception 'Incident photo was not found' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_photo.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Only ledger members can delete incident photos' using errcode = '42501';
  end if;

  if not (
    public.is_ledger_admin(v_photo.ledger_id)
    or coalesce(v_photo.created_by_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the photo uploader or a workspace admin can delete this photo' using errcode = '42501';
  end if;

  delete from public.vehicle_incident_photos vip where vip.id = p_photo_id;

  return jsonb_build_object(
    'photo_id', p_photo_id,
    'incident_id', v_photo.incident_id,
    'ledger_id', v_photo.ledger_id
  );
end;
$$;

revoke all on function public.delete_incident_photo(uuid) from public;
grant execute on function public.delete_incident_photo(uuid) to authenticated;

-- ── 4. Supabase Storage (PROD-ONLY; see the STORAGE COMPATIBILITY note above) ──
-- Guarded on the `storage` schema existing so plain-Postgres CI replays skip it
-- entirely and only the real Supabase project materialises the private bucket +
-- workspace-scoped object policies.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- Private bucket, 5 MiB cap, images only.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'incident-photos', 'incident-photos', false, 5242880,
      array['image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

    -- Workspace-scoped access: the first path segment is the ledger id
    -- (<ledger_id>/<incident_id>/<uuid>.<ext>), gated through is_ledger_member.
    drop policy if exists "Incident photos are readable by workspace members" on storage.objects;
    create policy "Incident photos are readable by workspace members"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'incident-photos'
        and public.is_ledger_member((storage.foldername(name))[1])
      );

    drop policy if exists "Incident photos are writable by workspace members" on storage.objects;
    create policy "Incident photos are writable by workspace members"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'incident-photos'
        and public.is_ledger_member((storage.foldername(name))[1])
      );

    -- Creator-only delete cannot be expressed purely in a storage.objects policy
    -- (the uploader identity lives in public.vehicle_incident_photos, and
    -- delete_incident_photo is the row-level authority). Storage deletes are gated
    -- to workspace members here as defense-in-depth; the RPC enforces creator/admin.
    drop policy if exists "Incident photos are deletable by workspace members" on storage.objects;
    create policy "Incident photos are deletable by workspace members"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'incident-photos'
        and public.is_ledger_member((storage.foldername(name))[1])
      );
  end if;
end
$$;

-- ── 5. GDPR: extend delete_my_account (re-declared off migration 111) ──────────
-- Re-declared off migration 111 (its newest prior definition -- GV-202 rule). The
-- ONLY change is one added step inside the per-membership loop: detach this account
-- from workspace-owned incident photos. The incident rows themselves keep their
-- reporter/driver references pointing at THIS member row, which the loop already
-- anonymizes in place (name -> 'Slettet medlem', email -> null) -- identical to how
-- trips.driver_member_id and every other retained membership reference is handled,
-- so no incident PII survives. Photos belong to the workspace (they die with the
-- incident or the workspace via cascade), so deletion only detaches their authorship.
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := public.current_user_email();
  v_member record;
  v_old_name text;
  v_first_name text;
  v_anon_name text;
  v_suffix integer;
  v_no_other_active boolean;
  v_successor record;
  v_ledgers_scrubbed integer := 0;
  v_ledgers_deleted integer := 0;
  v_admins_promoted integer := 0;
begin
  if v_uid is null or v_email is null then
    raise exception 'Account deletion requires a signed-in user' using errcode = '42501';
  end if;

  -- Let the settlement lock trigger (GV-199) know these writes are GDPR PII
  -- scrubs, not settlement edits, so its closed-period rejection stands aside.
  -- Transaction-local, so it clears automatically at commit/rollback.
  perform set_config('govehlo.pii_scrub', '1', true);

  for v_member in
    select lm.id, lm.ledger_id, lm.name, lm.role, lm.is_active
    from public.ledger_members lm
    where lm.email is not null
      and lower(lm.email) = v_email
  loop
    v_old_name := v_member.name;
    v_first_name := split_part(v_old_name, ' ', 1);

    -- No other active member left? The workspace dies with this account: nobody
    -- could ever access it again, so full deletion is the cleanest erasure.
    -- Every child table references ledgers(id) with on delete cascade.
    select not exists (
      select 1
      from public.ledger_members lm2
      where lm2.ledger_id = v_member.ledger_id
        and lm2.is_active = true
        and lm2.id <> v_member.id
    ) into v_no_other_active;
    if v_no_other_active then
      delete from public.ledgers l where l.id = v_member.ledger_id;
      v_ledgers_deleted := v_ledgers_deleted + 1;
      continue;
    end if;

    -- Admin succession: never leave a live workspace admin-less. Promote the
    -- longest-standing active member and say so in the feed (system actor).
    if v_member.is_active and v_member.role = 'admin' and not exists (
      select 1
      from public.ledger_members lm3
      where lm3.ledger_id = v_member.ledger_id
        and lm3.is_active = true
        and lm3.role = 'admin'
        and lm3.id <> v_member.id
    ) then
      select lm4.id, lm4.name
      into v_successor
      from public.ledger_members lm4
      where lm4.ledger_id = v_member.ledger_id
        and lm4.is_active = true
        and lm4.id <> v_member.id
      order by lm4.created_at asc, lm4.id asc
      limit 1;

      update public.ledger_members lm5
      set role = 'admin', updated_at = now()
      where lm5.id = v_successor.id;

      insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, target_member_id, metadata)
      values (
        v_member.ledger_id,
        'member_promoted',
        v_successor.name || ' er nu administrator',
        'Automatisk, fordi den tidligere administrator slettede sin konto',
        null,
        null,
        v_successor.id,
        jsonb_build_object('reason', 'account_deleted')
      );
      v_admins_promoted := v_admins_promoted + 1;
    end if;

    -- Per-ledger-unique anonymized name (unique(ledger_id, name) would reject a
    -- second 'Slettet medlem' in the same group).
    v_anon_name := 'Slettet medlem';
    v_suffix := 1;
    while exists (
      select 1
      from public.ledger_members lm6
      where lm6.ledger_id = v_member.ledger_id
        and lm6.name = v_anon_name
        and lm6.id <> v_member.id
    ) loop
      v_suffix := v_suffix + 1;
      v_anon_name := 'Slettet medlem ' || v_suffix;
    end loop;

    -- Authored free text: trip notes are the creator's words, not car facts.
    update public.trips t
    set note = null, updated_at = now()
    where t.ledger_id = v_member.ledger_id
      and t.created_by_member_id = v_member.id
      and t.note is not null;

    -- Bookings: purposes are authored text; future bookings would block the car
    -- for a person who no longer exists.
    update public.car_bookings cb
    set purpose = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.purpose is not null;

    -- Structured fuel stop (migration 063): the from/to labels + lat/lng are the
    -- member's route history — potentially their home address. Null the whole
    -- jsonb; station coords are public, but from/to are personal, so simplest-
    -- correct wins (GV-197).
    update public.car_bookings cb
    set fuel_stop = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.fuel_stop is not null;

    update public.car_bookings cb
    set deleted_at = now(), updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and cb.member_id = v_member.id
      and cb.start_at > now()
      and cb.deleted_at is null;

    -- Chat: blank + soft-delete their messages (the app already filters deleted).
    update public.messages msg
    set body = '', deleted_at = coalesce(msg.deleted_at, now())
    where msg.ledger_id = v_member.ledger_id
      and msg.sender_member_id = v_member.id;

    -- Incident photos (GVM-396): the photos belong to the workspace (they die with
    -- the incident or the workspace via cascade). Only the authorship pointer is
    -- personal, so detach it. The incident rows' own reporter/driver references
    -- are left pointing at this member row, which is anonymized in place below —
    -- exactly like trips.driver_member_id and every other retained reference.
    update public.vehicle_incident_photos vip
    set created_by_member_id = null
    where vip.ledger_id = v_member.ledger_id
      and vip.created_by_member_id = v_member.id;

    -- Feed events: drop stored emails and replace the member's name inside titles
    -- and bodies they authored or are targeted by. Events self-expire after 30
    -- days, so this is belt-and-braces on top of bounded retention. Very short
    -- first names (< 3 chars) are skipped for the substring pass — the collision
    -- risk with unrelated words outweighs the residual exposure.
    if char_length(v_first_name) < 3 then
      v_first_name := v_old_name;
    end if;
    update public.ledger_events ev
    set actor_email = case when ev.actor_member_id = v_member.id then null else ev.actor_email end,
        target_email = case when ev.target_member_id = v_member.id then null else ev.target_email end,
        title = replace(replace(ev.title, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem'),
        body = replace(replace(ev.body, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem')
    where ev.ledger_id = v_member.ledger_id
      and (ev.actor_member_id = v_member.id or ev.target_member_id = v_member.id);

    -- Archived snapshots: closed periods keep their maths, but the name fields
    -- inside people[] / settlements[] must stop identifying the person. The
    -- entry fingerprint (migration 054) covers trip/fuel ids only, never names,
    -- so this rewrite cannot invalidate any integrity check.
    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{people}',
      (
        select coalesce(jsonb_agg(
          case when person ->> 'id' = v_member.id::text
            then jsonb_set(person, '{name}', to_jsonb(v_anon_name))
            else person
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(sp.snapshot_json -> 'people') as person
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'people') = 'array';

    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{settlements}',
      (
        select coalesce(jsonb_agg(
          case when settled ->> 'toId' = v_member.id::text
            then jsonb_set(settled, '{toName}', to_jsonb(v_anon_name))
            else settled
          end
        ), '[]'::jsonb)
        from (
          select case when raw ->> 'fromId' = v_member.id::text
            then jsonb_set(raw, '{fromName}', to_jsonb(v_anon_name))
            else raw
          end as settled
          from jsonb_array_elements(sp.snapshot_json -> 'settlements') as raw
        ) as renamed
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'settlements') = 'array';

    -- Invites addressed to this email in this ledger.
    update public.ledger_invites li
    set invited_email = null, updated_at = now()
    where li.ledger_id = v_member.ledger_id
      and lower(coalesce(li.invited_email, '')) = v_email;

    -- Finally the member row itself. Role drops to 'member' (succession above
    -- already ensured another admin exists when one was needed). last_seen_at is
    -- nulled too (GVM-66): activity metadata must not outlive the account.
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
        last_seen_at = null,
        updated_at = now()
    where lm7.id = v_member.id;

    -- Feed transparency, in app voice, without re-publishing the old name.
    insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
    values (
      v_member.ledger_id,
      'member_deleted',
      'Et medlem slettede sin konto',
      v_anon_name || ' er anonymiseret. Gruppens regnskab er uændret.',
      null,
      null,
      jsonb_build_object('member_id', v_member.id)
    );

    v_ledgers_scrubbed := v_ledgers_scrubbed + 1;
  end loop;

  -- Cross-ledger cleanup keyed by identity rather than membership.
  delete from public.push_subscriptions ps
  where lower(ps.user_email) = v_email;

  delete from public.ledger_onboarding_rate_limits rl
  where lower(rl.actor_email) = v_email;

  update public.owner_activity_log oal
  set actor_email = null, actor_user_id = null
  where oal.actor_user_id = v_uid
     or lower(coalesce(oal.actor_email, '')) = v_email;

  -- Push tokens die with the account (migration 057): match by user id and by
  -- the scrubbed email so nothing keeps addressing this person's devices.
  delete from public.expo_push_tokens ept
  where ept.user_id = v_uid
     or lower(ept.email) = v_email;


  -- Purge this user's notification preferences (GV-229). No PII (three booleans
  -- + a uuid), but data minimisation says don't leave an orphaned row behind.
  delete from public.notification_preferences np where np.user_id = v_uid;

  -- Kill the credentials last: cascades sessions/identities, frees the email for
  -- a fresh sign-up. The caller's JWT stays technically valid until expiry but no
  -- longer matches any member (email scrubbed), so RLS yields nothing.
  delete from auth.users au where au.id = v_uid;

  return jsonb_build_object(
    'ledgers_scrubbed', v_ledgers_scrubbed,
    'ledgers_deleted', v_ledgers_deleted,
    'admins_promoted', v_admins_promoted
  );
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '138_vehicle_incidents',
  'Vehicle incidents + photos (GVM-396): workspace-scoped damage/incident log (vehicle_incidents) with an optional booking/trip link, repair-status lifecycle, optional skadenummer, and private-bucket photos (vehicle_incident_photos). Reads via is_ledger_member RLS; writes only through security-definer RPCs (log/update incident, add/delete photo) that gate on membership + the GV-253 admin-or-reporter identity policy and log ledger_events. Storage bucket + storage.objects policies are guarded on the storage schema so plain-Postgres CI replays skip them. delete_my_account re-declared off 111 to detach incident-photo authorship.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

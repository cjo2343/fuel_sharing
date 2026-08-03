-- Migration 166: incident damage kind + repair link (GVM-521)
--
-- The two deltas GVM-521 still asks for on top of migration 138's damage log. The
-- ticket's photo half shipped there (vehicle_incident_photos + the private
-- incident-photos bucket, hardened in 139), so this migration adds only:
--
--   1. EXISTING DAMAGE vs NEW INCIDENT. vehicle_incidents.damage_kind, a not-null
--      text column checked against exactly two values. Until now the log could not
--      express the difference between "this dent was already on the car when I took
--      it" and "this dent happened on my watch" — which is the whole question a
--      handover argument turns on, and the reason an honest member hesitates to log
--      pre-existing damage at all.
--
--      DEFAULT 'new_incident', which is also what every existing row backfills to.
--      That is not the neutral choice, it is the ACCURATE one: every field migration
--      138 shipped reads as an event — a required incident_date, an optional
--      odometer AT that moment, an optional link to the booking or trip it happened
--      on, a repair_status that starts 'open' — and the mobile copy asks members to
--      log "hvad der skete". A row written under those affordances is a report of
--      something that happened, so classifying the backlog as new incidents restates
--      what the log already meant rather than guessing. The other direction would
--      have been a silent claim that every dent on record predates the group.
--
--   2. REPAIR LINK. vehicle_incidents.repair_id, a nullable FK to
--      public.vehicle_repairs. "Which repair fixed this damage?" was previously only
--      answerable from prose in two free-text fields. NO new status column comes with
--      it: whether an incident is being repaired is derivable from the link plus the
--      repair's own row (its date, cost, workshop), and vehicle_incidents already
--      carries repair_status from 138, so a second copy of that state could only
--      drift.
--
-- INTEGRITY: the linked repair must belong to the SAME workspace as the incident,
-- and must not be soft-deleted. A plain FK cannot say that — vehicle_repairs.id is
-- unique across every workspace — so the rule lives in the setter RPC, which is the
-- only way a client can write the column at all: vehicle_incidents has no write
-- policy and no INSERT/UPDATE grant to `authenticated` (138 revoked all and granted
-- select only), exactly as migration 138 already enforces the same-ledger rule for
-- booking_id and trip_id. No trigger, for the same reason 138 shipped none: the RPC
-- is not one path among several, it is the only path.
--
-- WHY A DEDICATED SETTER rather than another optional argument on
-- update_vehicle_incident: that RPC is patch-shaped — a null argument means "leave
-- unchanged" — so a nullable FK simply cannot be CLEARED through it, and a repair
-- linked to the wrong incident must be unlinkable. set_incident_repair therefore
-- owns the column outright, with null meaning UNLINK. It carries the same
-- admin-or-reporter gate update_vehicle_incident does (GV-253): someone who may not
-- edit the incident must not be able to change what it is attributed to either.
--
-- SIGNATURES: log_vehicle_incident and update_vehicle_incident are DROPPED and
-- recreated off their newest prior definition (migration 138 for both bodies;
-- migration 148 only revoked anon's execute) rather than create-or-replace, because
-- both gain a parameter and a differing parameter list would leave the old overload
-- live for PostgREST to fail on (the 157/156/063 lesson, restated in 158). The new
-- damage_kind_value sits BEFORE the trailing event_title/event_body, per the
-- convention every RPC has followed since 051.
--
-- OLD CLIENTS ARE SAFE, which is the GV-417 question this migration has to answer
-- rather than assume. Both new parameters have defaults and neither can erase a
-- value a newer client wrote: on log_vehicle_incident the default 'new_incident' is
-- applied to a row being CREATED, and on update_vehicle_incident a null
-- damage_kind_value means "leave unchanged", so a pre-GVM-521 build editing an
-- incident that was classified as existing damage preserves that classification. No
-- `_provided` flag is needed here — 158 needed one only because its upsert wrote
-- normalised nulls over columns on the conflict path.
--
-- No new event_type: a repair link and a damage-kind change are edits to an existing
-- incident, so both reuse 'incident_updated' (already feed-visible since 138), and
-- both stay silent unless the client supplies an event_title.

-- ── 1. damage_kind ───────────────────────────────────────────────────────────
alter table public.vehicle_incidents
  add column if not exists damage_kind text not null default 'new_incident';

alter table public.vehicle_incidents
  drop constraint if exists vehicle_incidents_damage_kind_check;

alter table public.vehicle_incidents
  add constraint vehicle_incidents_damage_kind_check check (
    damage_kind in ('existing_damage', 'new_incident')
  );

-- ── 2. repair link ───────────────────────────────────────────────────────────
-- on delete set null like every other cross-table reference on this table: deleting
-- a repair must never take the damage record with it.
alter table public.vehicle_incidents
  add column if not exists repair_id uuid
  references public.vehicle_repairs(id) on delete set null;

create index if not exists vehicle_incidents_repair_idx
  on public.vehicle_incidents (repair_id) where repair_id is not null;

-- ── 3. log_vehicle_incident — re-declared off migration 138 ──────────────────
-- 138 verbatim apart from damage_kind_value (validated against the same two values
-- as the CHECK, and written on the INSERT) and the parameter itself. Dropped first
-- because the parameter list changes.
drop function if exists public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text);

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
  damage_kind_value text default 'new_incident',
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

  -- GVM-521. Null is rejected rather than coalesced: the column is not nullable, and
  -- an explicit null here means a client sent something it thought was a value.
  if damage_kind_value is null
     or damage_kind_value not in ('existing_damage', 'new_incident') then
    raise exception 'Invalid damage kind' using errcode = '22023';
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
    incident_date, odometer, title, description, repair_status, insurance_ref,
    damage_kind
  ) values (
    target_ledger_id, v_actor_member_id, driver_member_id_value, booking_id_value, trip_id_value,
    incident_date_value, odometer_value, btrim(title_value), btrim(description_value),
    repair_status_value, nullif(btrim(insurance_ref_value), ''),
    damage_kind_value
  )
  returning id into v_incident_id;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'incident_logged', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('incident_id', v_incident_id, 'damage_kind', damage_kind_value)
    );
  end if;

  return jsonb_build_object(
    'incident_id', v_incident_id,
    'ledger_id', target_ledger_id,
    'damage_kind', damage_kind_value
  );
end;
$$;

revoke all on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text, text) from public;
revoke all on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text, text) from anon;
grant execute on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text, text) to authenticated;

-- ── 4. update_vehicle_incident — re-declared off migration 138 ───────────────
-- 138 verbatim apart from damage_kind_value: validated when non-null, "leave
-- unchanged" when null (the patch semantics every other argument here already has),
-- and reported back in the return value so a client can render the new state without
-- a re-read. The repair link is deliberately NOT settable here; see the header.
drop function if exists public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text);

create or replace function public.update_vehicle_incident(
  target_incident_id uuid,
  title_value text default null,
  description_value text default null,
  repair_status_value text default null,
  insurance_ref_value text default null,
  driver_member_id_value uuid default null,
  incident_date_value date default null,
  odometer_value integer default null,
  damage_kind_value text default null,
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
  v_new_damage_kind text;
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

  -- GVM-521. Null means "leave unchanged" here, so a client that predates the
  -- damage-kind UI cannot reclassify an incident by omitting the argument.
  if damage_kind_value is not null
     and damage_kind_value not in ('existing_damage', 'new_incident') then
    raise exception 'Invalid damage kind' using errcode = '22023';
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
  v_new_damage_kind := coalesce(damage_kind_value, v_incident.damage_kind);

  update public.vehicle_incidents vi
  set title = coalesce(nullif(btrim(title_value), ''), vi.title),
      description = coalesce(nullif(btrim(description_value), ''), vi.description),
      repair_status = v_new_status,
      damage_kind = v_new_damage_kind,
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
      jsonb_build_object('incident_id', target_incident_id, 'repair_status', v_new_status, 'status_changed', v_status_changed, 'damage_kind', v_new_damage_kind)
    );
  end if;

  return jsonb_build_object(
    'incident_id', target_incident_id,
    'ledger_id', v_incident.ledger_id,
    'repair_status', v_new_status,
    'status_changed', v_status_changed,
    'damage_kind', v_new_damage_kind
  );
end;
$$;

revoke all on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text, text) from public;
revoke all on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text, text) from anon;
grant execute on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text, text) to authenticated;

-- ── 5. set_incident_repair — the repair link's only writer ───────────────────
-- p_repair_id null means UNLINK; a non-null one must name a live (not soft-deleted)
-- repair in the INCIDENT'S OWN workspace. The cross-workspace check is the reason
-- this function exists: vehicle_repairs.id is unique globally, so without it a
-- member could point their incident at another group's repair row and read its
-- costs straight out of the join.
--
-- The incident's repair_status is deliberately left alone. Linking a repair is a
-- statement about WHICH repair, not about how far along it is, and quietly moving
-- the status would overwrite a member's own judgement.
create or replace function public.set_incident_repair(
  p_incident_id uuid,
  p_repair_id uuid default null,
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
begin
  if p_incident_id is null then
    raise exception 'Missing incident id' using errcode = '22023';
  end if;

  select * into v_incident
  from public.vehicle_incidents vi
  where vi.id = p_incident_id;

  if v_incident.id is null then
    raise exception 'Incident was not found' using errcode = '22023';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_incident.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Only workspace members can link a repair to an incident' using errcode = '42501';
  end if;

  -- Same gate as update_vehicle_incident (GV-253): whoever may not edit the
  -- incident may not change what it is attributed to either.
  if not (
    public.is_ledger_admin(v_incident.ledger_id)
    or coalesce(v_incident.reporter_member_id = v_actor_member_id, false)
  ) then
    raise exception 'Only the incident reporter or a workspace admin can link a repair to this incident' using errcode = '42501';
  end if;

  if p_repair_id is not null and not exists (
    select 1 from public.vehicle_repairs vr
    where vr.id = p_repair_id
      and vr.ledger_id = v_incident.ledger_id
      and vr.deleted_at is null
  ) then
    raise exception 'Linked repair must be a live repair in this ledger' using errcode = '22023';
  end if;

  update public.vehicle_incidents vi
  set repair_id = p_repair_id,
      updated_at = now()
  where vi.id = p_incident_id;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      v_incident.ledger_id, 'incident_updated', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('incident_id', p_incident_id, 'repair_id', p_repair_id, 'linked', p_repair_id is not null)
    );
  end if;

  return jsonb_build_object(
    'incident_id', p_incident_id,
    'ledger_id', v_incident.ledger_id,
    'repair_id', p_repair_id,
    'linked', p_repair_id is not null,
    'repair_status', v_incident.repair_status
  );
end;
$$;

revoke all on function public.set_incident_repair(uuid, uuid, text, text) from public;
revoke all on function public.set_incident_repair(uuid, uuid, text, text) from anon;
grant execute on function public.set_incident_repair(uuid, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '166_incident_damage_kind_and_repair_link',
  'Damage log: existing damage vs new incident, and the repair that fixed it (GVM-521). Migration 138 shipped the ticket''s photo half; these are the two remaining deltas. (1) vehicle_incidents.damage_kind — not null text, checked against exactly (''existing_damage'', ''new_incident''), default ''new_incident''. Existing rows backfill to ''new_incident'' because that is what the log has meant: 138''s required incident_date, its odometer-at-the-moment, its booking/trip link and its ''open'' starting status all describe an event, so the backlog is restated rather than guessed at. (2) vehicle_incidents.repair_id — nullable FK to vehicle_repairs, on delete set null, with a partial index. No second status column: whether an incident is under repair is derivable from the link plus the repair row, and repair_status already exists. The same-ledger rule (the linked repair must be a live, non-soft-deleted repair in the incident''s OWN workspace — vehicle_repairs.id is globally unique, so without it an incident could point at another group''s costs) is enforced in set_incident_repair, the column''s only writer, exactly as 138 enforces the same rule for booking_id/trip_id; no trigger, because the table has no write policy and no INSERT/UPDATE grant to authenticated, so the RPC is not one path among several but the only one. set_incident_repair carries update_vehicle_incident''s admin-or-reporter gate (GV-253) and takes null to mean UNLINK — which is why it is a dedicated setter rather than another patch-shaped argument on update_vehicle_incident, where null already means "leave unchanged" and a nullable FK could therefore never be cleared. log_vehicle_incident and update_vehicle_incident are DROP + CREATE off their newest prior definition (138 for both bodies; 148 only revoked anon''s execute) because both gain a parameter and a differing list would leave the old overload live for PostgREST to fail on (157/156/063 lesson); damage_kind_value sits before the trailing event params per the 051 convention. Old clients are unaffected and cannot erase anything: on create the default applies to a NEW row, and on edit a null damage_kind_value leaves the stored classification alone, so no _provided flag is needed (158 needed one only for an upsert''s conflict path). No new event_type — both writes reuse ''incident_updated'', already feed-visible since 138, and stay silent unless the client sends an event_title. ACLs restate anon explicitly per 148. MERGE ORDER: PostgREST rejects a body carrying an argument the function lacks (PGRST202), so this must be applied in production BEFORE govehlo-mobile''s GVM-521 half ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 144: close a deferred booking-fuel entry as not_refuelled (GVM-428)
--
-- "Jeg tankede — registrerer den senere" (trips.fuel_resolution = 'deferred',
-- migration 136) was a one-way door. The ONLY exit was
-- complete_deferred_booking_fuel (migration 140), which requires a real fuel
-- payment with a positive amount. A driver who tapped defer by mistake, or who
-- simply never found the receipt, had no way back: the entry nags permanently in
-- Home's queue, in Log, and — because the deferred fuel lands in whichever period
-- is open when it is finally resolved — in the Afregn pre-request warning of every
-- period from then on. The workaround was to invent an amount, which corrupts the
-- split, or to live with the nag forever.
--
-- This adds the missing exit: resolve the entry to 'not_refuelled' with NO amount
-- and NO litres. Nothing financial is created or removed — only the trip's
-- workflow metadata changes — so the settlement maths and every closed period's
-- frozen snapshot are untouched. The three nag surfaces all derive from
-- fuel_resolution = 'deferred', so they clear themselves once this runs.
--
-- Authorisation follows the recorded reassignment policy (GV-253): the person who
-- deferred it (the trip's creator), the driver it is nagging, or a workspace admin.

create or replace function public.close_deferred_booking_fuel(
  target_ledger_id text,
  target_trip_id uuid,
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
  v_actor_email text;
  v_trip record;
begin
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can close deferred fuel entries'
      using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member'
      using errcode = '42501';
  end if;

  if target_trip_id is null then
    raise exception 'Missing deferred trip id' using errcode = '22023';
  end if;

  select t.id, t.driver_member_id, t.created_by_member_id, t.fuel_resolution,
         t.completion_fuel_legacy_id
    into v_trip
    from public.trips t
    where t.id = target_trip_id
      and t.ledger_id = target_ledger_id
      and t.booking_id is not null
      and t.deleted_at is null
    for update of t;

  if not found then
    raise exception 'Deferred booking trip was not found' using errcode = '22023';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the gate lives here. Creator OR driver OR
  -- admin (GV-253): the creator is whoever tapped "registrerer den senere", the
  -- driver is who the follow-up nags, and an admin can always unstick a workspace.
  if not (
    public.is_ledger_admin(target_ledger_id)
    or v_trip.driver_member_id = v_actor_member_id
    or v_trip.created_by_member_id = v_actor_member_id
  ) then
    raise exception 'Only the trip driver, its creator, or a ledger admin can close its deferred fuel entry'
      using errcode = '42501';
  end if;

  -- Idempotent: a replay (double tap, offline retry, two devices) finds the entry
  -- already closed and reports that instead of failing or logging a second event.
  if v_trip.fuel_resolution = 'not_refuelled' then
    return jsonb_build_object(
      'trip_id', v_trip.id,
      'fuel_resolution', 'not_refuelled',
      'already_closed', true
    );
  end if;

  -- Someone else (or an earlier queued write) found the receipt first. A close must
  -- never demolish a real, linked fuel payment — report the winning state instead.
  if v_trip.fuel_resolution = 'logged' and v_trip.completion_fuel_legacy_id is not null then
    return jsonb_build_object(
      'trip_id', v_trip.id,
      'fuel_resolution', 'logged',
      'fuel_id', (
        select fp.id
        from public.fuel_payments fp
        where fp.ledger_id = target_ledger_id
          and fp.legacy_id = v_trip.completion_fuel_legacy_id
          and fp.deleted_at is null
        limit 1
      ),
      'already_closed', false
    );
  end if;

  if v_trip.fuel_resolution <> 'deferred' then
    raise exception 'Trip does not have a deferred fuel entry' using errcode = '22023';
  end if;

  -- The trip may have become historical (even closed) before the driver gave up on
  -- the receipt — which is exactly the case this RPC exists for. Reuse migration
  -- 140's transaction-local metadata scrub bypass for this one fixed-column UPDATE:
  -- fuel_resolution participates in neither the settlement maths nor the archived
  -- fingerprint, no fuel row is created or removed, and enforce_trip_fuel_resolution
  -- still validates the result. No caller-controlled SQL runs while the flag is set,
  -- and it is cleared again before the event insert.
  perform set_config('govehlo.pii_scrub', '1', true);

  update public.trips t
  set fuel_resolution = 'not_refuelled',
      completion_fuel_legacy_id = null,
      updated_at = now()
  where t.id = target_trip_id
    and t.ledger_id = target_ledger_id
    and t.fuel_resolution = 'deferred';

  if not found then
    raise exception 'Deferred fuel close could not update the trip'
      using errcode = '40001';
  end if;

  perform set_config('govehlo.pii_scrub', '', true);

  -- Cross-client live sync IS a ledger_events insert: without this row the other
  -- members' devices keep the stale 'deferred' trip and go on nagging.
  if nullif(event_title, '') is not null then
    v_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'trip_fuel_closed', event_title, coalesce(event_body, ''),
      v_actor_member_id, v_actor_email,
      jsonb_build_object('trip_id', target_trip_id)
    );
  end if;

  return jsonb_build_object(
    'trip_id', target_trip_id,
    'fuel_resolution', 'not_refuelled',
    'already_closed', false
  );
end;
$$;

revoke all on function public.close_deferred_booking_fuel(text, uuid, text, text) from public;
revoke all on function public.close_deferred_booking_fuel(text, uuid, text, text) from anon;
grant execute on function public.close_deferred_booking_fuel(text, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '144_close_deferred_booking_fuel',
  'Close a deferred booking-fuel entry as not_refuelled (GVM-428): new close_deferred_booking_fuel(text, uuid, text, text) gives the "Jeg tankede — registrerer den senere" state a second exit that needs no amount and no litres, so a mistaken tap or a lost receipt stops nagging Home, Log and the Afregn pre-request warning forever. Gated to the trip driver, its creator, or a ledger admin; idempotent on replay; never demolishes an already-logged fuel payment; writes a trip_fuel_closed ledger_event so other devices live-sync.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

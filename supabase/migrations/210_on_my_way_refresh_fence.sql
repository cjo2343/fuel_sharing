-- Migration 210: fence automatic on-my-way refreshes to the observed share
--
-- A delayed foreground/background refresh or re-key must not start a share after
-- clear_on_my_way, or overwrite a newer share/key. Keep explicit starts compatible.
-- Apply before deploying clients that call refresh_on_my_way.
create or replace function public.refresh_on_my_way(
  target_ledger_id text,
  legacy_booking_id text,
  eta_minutes integer,
  expected_started_at timestamptz,
  expected_pubkey text,
  share_pubkey text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.car_bookings%rowtype;
  v_actor uuid;
begin
  if expected_started_at is null then
    raise exception 'Mangler delingens starttid' using errcode = '22023';
  end if;
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer kan opdatere delingen' using errcode = '42501';
  end if;
  v_actor := public.current_ledger_member_id(target_ledger_id);
  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':onmyway:' || legacy_booking_id));
  select * into v_booking from public.car_bookings cb
    where cb.ledger_id = target_ledger_id and cb.legacy_id = legacy_booking_id
      and cb.deleted_at is null
    for update;
  if v_booking.id is null or v_actor is null
     or (v_actor is distinct from v_booking.member_id
         and v_actor is distinct from v_booking.created_by_member_id) then
    raise exception 'Du kan ikke opdatere denne deling' using errcode = '42501';
  end if;
  if v_booking.on_my_way is null
     or (v_booking.on_my_way ->> 'started_at')::timestamptz is distinct from expected_started_at
     or (v_booking.on_my_way ->> 'pubkey') is distinct from expected_pubkey then
    raise exception 'Delingen er stoppet eller opdateret. Opdater og prøv igen.'
      using errcode = '40001';
  end if;
  -- The same lock is held through the existing command's validation and event write.
  return public.set_on_my_way(target_ledger_id, legacy_booking_id, eta_minutes,
    null, null, share_pubkey);
end;
$$;

create or replace function public.clear_on_my_way_if_current(
  target_ledger_id text, legacy_booking_id text, expected_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.car_bookings%rowtype;
begin
  if expected_started_at is null then
    raise exception 'Mangler delingens starttid' using errcode = '22023';
  end if;
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer kan stoppe delingen' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':onmyway:' || legacy_booking_id));
  select * into v_booking from public.car_bookings cb
    where cb.ledger_id = target_ledger_id and cb.legacy_id = legacy_booking_id for update;
  if v_booking.id is null or not public.can_manage_car_booking(v_booking.id) then
    raise exception 'Du kan ikke stoppe denne deling' using errcode = '42501';
  end if;
  if v_booking.on_my_way is null
     or (v_booking.on_my_way ->> 'started_at')::timestamptz is distinct from expected_started_at then
    return jsonb_build_object('booking_id', v_booking.id, 'ledger_id', target_ledger_id,
      'legacy_id', legacy_booking_id, 'cleared', false);
  end if;
  return public.clear_on_my_way(target_ledger_id, legacy_booking_id);
end;
$$;

revoke all on function public.clear_on_my_way_if_current(text, text, timestamptz) from public, anon;
grant execute on function public.clear_on_my_way_if_current(text, text, timestamptz) to authenticated;

revoke all on function public.refresh_on_my_way(text, text, integer, timestamptz, text, text) from public, anon;
grant execute on function public.refresh_on_my_way(text, text, integer, timestamptz, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('210_on_my_way_refresh_fence', 'Fence automatic ETA refresh and re-key to the observed share start and public key; never recreate a stopped share.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

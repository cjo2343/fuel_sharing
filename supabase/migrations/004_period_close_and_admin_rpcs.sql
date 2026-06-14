-- Migration 004: period-close RPC with fast guards plus admin production reset RPC.

create or replace function public.close_settlement_period(
  target_ledger_id text,
  target_period_id uuid,
  period_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  snapshot_fingerprint text;
  duplicate_period_id uuid;
  closed_period_id uuid;
  new_open_period_id uuid;
  requested_closed_at timestamptz;
  lock_acquired boolean;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if period_snapshot is null or jsonb_typeof(period_snapshot) <> 'object' then
    raise exception 'Period snapshot must be a JSON object' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can close settlement periods' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Guard before taking the advisory lock. Older frontend builds and health probes
  -- may call this RPC with a fake or already-closed period id. Reject those
  -- immediately so they cannot queue behind the lock and burn database CPU.
  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  lock_acquired := pg_try_advisory_xact_lock(hashtext(target_ledger_id));
  if lock_acquired is not true then
    raise exception 'Another settlement close is already in progress for this ledger' using errcode = '55P03';
  end if;

  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  if snapshot_fingerprint is not null then
    select sp.id into duplicate_period_id
    from public.settlement_periods sp
    where sp.ledger_id = target_ledger_id
      and sp.status = 'closed'
      and sp.snapshot_json->>'entryFingerprint' = snapshot_fingerprint
    limit 1;

    if duplicate_period_id is not null then
      raise exception 'This settlement period snapshot has already been closed' using errcode = '23505';
    end if;
  end if;

  begin
    requested_closed_at := coalesce((period_snapshot->>'closedAt')::timestamptz, now());
  exception when others then
    requested_closed_at := now();
  end;

  update public.settlement_periods sp
  set status = 'closed',
      label = coalesce(nullif(period_snapshot->>'label', ''), sp.label, 'Closed period'),
      closed_at = requested_closed_at,
      closed_by_member_id = actor_member_id,
      snapshot_json = period_snapshot,
      updated_at = now()
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  returning sp.id into closed_period_id;

  if closed_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '40001';
  end if;

  insert into public.settlement_periods (ledger_id, status, label, opened_at)
  values (target_ledger_id, 'open', 'Current period', now())
  returning id into new_open_period_id;

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', snapshot_fingerprint
  );
end;
$$;

create or replace function public.production_activity_reset(target_ledger_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_open_period_id uuid;
  existing_state jsonb;
  reset_state jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can reset production activity' using errcode = '42501';
  end if;

  delete from public.settlement_requests where ledger_id = target_ledger_id;

  delete from public.trip_participants tp
  using public.trips t
  where tp.trip_id = t.id
    and t.ledger_id = target_ledger_id;

  delete from public.trips where ledger_id = target_ledger_id;
  delete from public.fuel_payments where ledger_id = target_ledger_id;
  delete from public.car_bookings where ledger_id = target_ledger_id;
  delete from public.settlement_periods where ledger_id = target_ledger_id;

  insert into public.settlement_periods (ledger_id, status, label)
  values (target_ledger_id, 'open', 'Current period')
  returning id into new_open_period_id;

  select state into existing_state
  from public.car_share_ledgers
  where id = target_ledger_id;

  reset_state := coalesce(existing_state, '{}'::jsonb)
    || jsonb_build_object(
      'trips', '[]'::jsonb,
      'bookings', '[]'::jsonb,
      'fuel', '[]'::jsonb,
      'paymentStatuses', '{}'::jsonb,
      'closedPeriods', '[]'::jsonb,
      'lastOdometer', ''
    );

  insert into public.car_share_ledgers (id, state, updated_at)
  values (target_ledger_id, reset_state, now())
  on conflict (id) do update
    set state = excluded.state,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'open_period_id', new_open_period_id
  );
end;
$$;

revoke all on function public.production_activity_reset(text) from public;
grant execute on function public.production_activity_reset(text) to authenticated;

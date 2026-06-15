-- Migration 012: Add Admin/tools guardrails.
-- Moves sensitive member management and generated-test cleanup behind RPCs,
-- and clarifies that stale push subscription retention is global because the
-- push_subscriptions table is user/device scoped rather than ledger scoped.

create or replace function public.upsert_ledger_member_admin(
  target_ledger_id text default 'main-car',
  target_member_id uuid default null,
  member_name text default null,
  member_email text default null,
  member_mobilepay_phone text default null,
  member_role text default 'member',
  member_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_member public.ledger_members%rowtype;
  saved_member_id uuid;
  normalized_email text := nullif(lower(trim(coalesce(member_email, ''))), '');
  normalized_role text := case when member_role = 'admin' then 'admin' else 'member' end;
  active_admin_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage members' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not identify the current ledger admin' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(member_name, '')), '') is null then
    raise exception 'Member name is required' using errcode = '23502';
  end if;

  if normalized_email is null then
    raise exception 'Member login email is required' using errcode = '23502';
  end if;

  if target_member_id is not null then
    select * into existing_member
    from public.ledger_members
    where id = target_member_id and ledger_id = target_ledger_id
    for update;

    if existing_member.id is null then
      raise exception 'Member does not belong to this ledger' using errcode = '23503';
    end if;

    if existing_member.id = actor_member_id and (member_is_active is false or normalized_role <> 'admin') then
      raise exception 'Admins cannot demote or deactivate themselves' using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  if target_member_id is null then
    insert into public.ledger_members (ledger_id, name, email, mobilepay_phone, role, is_active, updated_at)
    values (target_ledger_id, trim(member_name), normalized_email, nullif(trim(coalesce(member_mobilepay_phone, '')), ''), normalized_role, coalesce(member_is_active, true), now())
    on conflict (ledger_id, name) do update set
      email = excluded.email,
      mobilepay_phone = excluded.mobilepay_phone,
      role = excluded.role,
      is_active = excluded.is_active,
      updated_at = now()
    returning id into saved_member_id;
  else
    update public.ledger_members
    set name = trim(member_name),
        email = normalized_email,
        mobilepay_phone = nullif(trim(coalesce(member_mobilepay_phone, '')), ''),
        role = normalized_role,
        is_active = coalesce(member_is_active, true),
        updated_at = now()
    where id = target_member_id and ledger_id = target_ledger_id
    returning id into saved_member_id;
  end if;

  select count(*) into active_admin_count
  from public.ledger_members
  where ledger_id = target_ledger_id and is_active = true and role = 'admin';

  if active_admin_count < 1 then
    raise exception 'At least one active admin is required' using errcode = '23514';
  end if;

  return saved_member_id;
end;
$$;

create or replace function public.set_ledger_member_active_admin(
  target_ledger_id text default 'main-car',
  target_member_id uuid default null,
  member_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_member public.ledger_members%rowtype;
  active_admin_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can activate or deactivate members' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not identify the current ledger admin' using errcode = '42501';
  end if;

  if target_member_id is null then
    raise exception 'Member id is required' using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  select * into existing_member
  from public.ledger_members
  where id = target_member_id and ledger_id = target_ledger_id
  for update;

  if existing_member.id is null then
    raise exception 'Member does not belong to this ledger' using errcode = '23503';
  end if;

  if existing_member.id = actor_member_id and member_is_active is false then
    raise exception 'Admins cannot deactivate themselves' using errcode = '42501';
  end if;

  update public.ledger_members
  set is_active = coalesce(member_is_active, true), updated_at = now()
  where id = target_member_id and ledger_id = target_ledger_id;

  select count(*) into active_admin_count
  from public.ledger_members
  where ledger_id = target_ledger_id and is_active = true and role = 'admin';

  if active_admin_count < 1 then
    raise exception 'At least one active admin is required' using errcode = '23514';
  end if;

  return target_member_id;
end;
$$;

create or replace function public.purge_generated_test_rows(
  target_ledger_id text default 'main-car',
  dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  trip_count integer := 0;
  fuel_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can purge generated test rows' using errcode = '42501';
  end if;

  select count(*) into trip_count
  from public.trips
  where ledger_id = target_ledger_id
    and deleted_at is not null
    and (legacy_id like 'test-%' or note like '%Generated test%');

  select count(*) into fuel_count
  from public.fuel_payments
  where ledger_id = target_ledger_id
    and deleted_at is not null
    and (legacy_id like 'test-%' or station_name like '%Generated test%');

  if not dry_run then
    with eligible_trips as (
      select id from public.trips
      where ledger_id = target_ledger_id
        and deleted_at is not null
        and (legacy_id like 'test-%' or note like '%Generated test%')
    ), deleted_participants as (
      delete from public.trip_participants tp
      using eligible_trips et
      where tp.trip_id = et.id
      returning 1
    )
    delete from public.trips t
    using eligible_trips et
    where t.id = et.id;

    delete from public.fuel_payments
    where ledger_id = target_ledger_id
      and deleted_at is not null
      and (legacy_id like 'test-%' or station_name like '%Generated test%');
  end if;

  return jsonb_build_object(
    'trips', trip_count,
    'fuel', fuel_count,
    'total', trip_count + fuel_count,
    'dry_run', dry_run
  );
end;
$$;

grant execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.set_ledger_member_active_admin(text, uuid, boolean) to authenticated;
grant execute on function public.purge_generated_test_rows(text, boolean) to authenticated;

create or replace function public.preview_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can preview retention cleanup';
  end if;

  select count(*) into event_count
  from public.ledger_events
  where ledger_id = target_ledger_id
    and (
      expires_at < now()
      or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
    );

  select count(*) into push_count
  from public.push_subscriptions
  where updated_at < now() - make_interval(days => greatest(stale_push_days, 30));

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

create or replace function public.run_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run retention cleanup';
  end if;

  with deleted_events as (
    delete from public.ledger_events
    where ledger_id = target_ledger_id
      and (
        expires_at < now()
        or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
      )
    returning 1
  )
  select count(*) into event_count from deleted_events;

  with deleted_push as (
    delete from public.push_subscriptions
    where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
    returning 1
  )
  select count(*) into push_count from deleted_push;

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

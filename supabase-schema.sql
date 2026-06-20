-- Fuel Ledger complete Supabase schema for a fresh project.
-- This creates both the legacy JSON backup table and the normalized table-primary backend.
-- After running, update ledger_members.email for each real user before inviting people.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.car_share_ledgers (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ledgers (
  id text primary key,
  name text not null default 'Fuel Ledger',
  currency text not null default 'DKK',
  fuel_type text not null default 'diesel',
  estimated_consumption_l_per_100km numeric(8,3) not null default 5.3,
  fuel_tank_capacity_l numeric(8,2) not null default 55,
  fallback_fuel_price numeric(10,2) not null default 14.50,
  low_fuel_threshold_percent numeric(6,2) not null default 70,
  high_fuel_threshold_percent numeric(6,2) not null default 140,
  vehicle_plate text not null default '',
  vehicle_info jsonb not null default '{}'::jsonb,
  vehicle_lookup_source text not null default 'manual',
  vehicle_lookup_at timestamptz,
  bootstrap_locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ledgers
  add column if not exists fuel_tank_capacity_l numeric(8,2) not null default 55;

alter table public.ledgers
  add column if not exists bootstrap_locked_at timestamptz;

alter table public.ledgers
  add column if not exists vehicle_plate text not null default '',
  add column if not exists vehicle_info jsonb not null default '{}'::jsonb,
  add column if not exists vehicle_lookup_source text not null default 'manual',
  add column if not exists vehicle_lookup_at timestamptz;

create table if not exists public.ledger_members (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  name text not null,
  email text,
  mobilepay_phone text,
  role text not null default 'member' check (role in ('admin', 'member')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, name)
);

create unique index if not exists ledger_members_ledger_email_idx
on public.ledger_members (ledger_id, lower(email))
where email is not null;

create table if not exists public.settlement_periods (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  label text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by_member_id uuid references public.ledger_members(id) on delete set null,
  snapshot_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists one_open_settlement_period_per_ledger
on public.settlement_periods (ledger_id)
where status = 'open';

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  period_id uuid references public.settlement_periods(id) on delete set null,
  driver_member_id uuid references public.ledger_members(id) on delete set null,
  trip_date date not null,
  start_km numeric(12,1) not null,
  end_km numeric(12,1) not null,
  note text,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_km > start_km),
  unique (ledger_id, legacy_id)
);

create table if not exists public.trip_participants (
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid not null references public.ledger_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, member_id)
);

create table if not exists public.fuel_payments (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  period_id uuid references public.settlement_periods(id) on delete set null,
  payer_member_id uuid references public.ledger_members(id) on delete set null,
  payment_date date not null,
  amount numeric(12,2) not null,
  currency text not null default 'DKK',
  liters numeric(10,3),
  price_per_liter numeric(10,3),
  odometer numeric(12,1),
  station_name text,
  station_brand text,
  station_lat numeric(10,7),
  station_lng numeric(10,7),
  user_lat numeric(10,7),
  user_lng numeric(10,7),
  full_tank boolean not null default false,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (amount > 0),
  check (liters is null or liters > 0),
  unique (ledger_id, legacy_id)
);

create table if not exists public.car_bookings (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  member_id uuid references public.ledger_members(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  purpose text,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_at > start_at),
  unique (ledger_id, legacy_id)
);

create index if not exists car_bookings_ledger_start_idx
on public.car_bookings (ledger_id, start_at)
where deleted_at is null;

create table if not exists public.settlement_requests (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  period_id uuid references public.settlement_periods(id) on delete cascade,
  from_member_id uuid references public.ledger_members(id) on delete set null,
  to_member_id uuid references public.ledger_members(id) on delete set null,
  amount numeric(12,2) not null,
  currency text not null default 'DKK',
  status text not null default 'open' check (status in ('open', 'requested', 'paid', 'cancelled')),
  requested_at timestamptz,
  paid_at timestamptz,
  requested_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount >= 0)
);

create unique index if not exists settlement_requests_current_pair_idx
on public.settlement_requests (period_id, from_member_id, to_member_id)
where status <> 'cancelled';


create table if not exists public.ledger_events (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  event_type text not null default 'ledger_updated',
  title text not null,
  body text not null,
  actor_member_id uuid references public.ledger_members(id) on delete set null,
  actor_email text,
  target_member_id uuid references public.ledger_members(id) on delete set null,
  target_email text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists ledger_events_ledger_created_idx
on public.ledger_events (ledger_id, created_at desc);

create index if not exists ledger_events_target_email_idx
on public.ledger_events (ledger_id, lower(target_email), created_at desc)
where target_email is not null;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.ledger_members(id) on delete set null,
  user_email text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.ledgers (id, name, currency, fuel_type, estimated_consumption_l_per_100km, fuel_tank_capacity_l, fallback_fuel_price)
values ('main-car', 'Fuel Ledger', 'DKK', 'diesel', 5.3, 55, 14.50)
on conflict (id) do nothing;

insert into public.ledger_members (ledger_id, name, role)
values
  ('main-car', 'Christian', 'admin'),
  ('main-car', 'Emilie', 'member'),
  ('main-car', 'Jonas', 'member'),
  ('main-car', 'Marie', 'member')
on conflict (ledger_id, name) do update set role = excluded.role, updated_at = now();

insert into public.settlement_periods (ledger_id, status, label)
values ('main-car', 'open', 'Current period')
on conflict do nothing;

insert into public.car_share_ledgers (id, state)
values (
  'main-car',
  '{
    "currency": "DKK",
    "members": ["Christian", "Emilie", "Jonas", "Marie"],
    "memberProfiles": {
      "Christian": { "email": "", "role": "admin" },
      "Emilie": { "email": "", "role": "member" },
      "Jonas": { "email": "", "role": "member" },
      "Marie": { "email": "", "role": "member" }
    },
    "trips": [],
    "bookings": [],
    "fuel": [],
    "paymentStatuses": {},
    "closedPeriods": [],
    "lastOdometer": "",
    "fuelType": "diesel",
    "fuelConsumption": 5.3,
    "fuelFallbackPrice": 14.5,
    "fuelWarningThreshold": 70,
    "carSettingsVersion": 2
  }'::jsonb
)
on conflict (id) do nothing;

create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_ledger_member(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ledger_members lm
    where lm.ledger_id = p_ledger_id
      and lm.is_active = true
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  );
$$;

create or replace function public.is_ledger_admin(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ledger_members lm
    where lm.ledger_id = p_ledger_id
      and lm.is_active = true
      and lm.role = 'admin'
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  );
$$;

create or replace function public.current_ledger_member_id(p_ledger_id text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select lm.id
  from public.ledger_members lm
  where lm.ledger_id = p_ledger_id
    and lm.is_active = true
    and lm.email is not null
    and lower(lm.email) = public.current_user_email()
  limit 1;
$$;

create or replace function public.can_manage_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trips t
    where t.id = p_trip_id
      and public.is_ledger_member(t.ledger_id)
      and (
        public.is_ledger_admin(t.ledger_id)
        or t.created_by_member_id = public.current_ledger_member_id(t.ledger_id)
        or t.driver_member_id = public.current_ledger_member_id(t.ledger_id)
      )
  );
$$;

create or replace function public.can_manage_fuel_payment(p_fuel_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.fuel_payments fp
    where fp.id = p_fuel_payment_id
      and public.is_ledger_member(fp.ledger_id)
      and (
        public.is_ledger_admin(fp.ledger_id)
        or fp.created_by_member_id = public.current_ledger_member_id(fp.ledger_id)
        or fp.payer_member_id = public.current_ledger_member_id(fp.ledger_id)
      )
  );
$$;

create or replace function public.can_manage_car_booking(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.car_bookings cb
    where cb.id = p_booking_id
      and public.is_ledger_member(cb.ledger_id)
      and (
        public.is_ledger_admin(cb.ledger_id)
        or cb.created_by_member_id = public.current_ledger_member_id(cb.ledger_id)
        or cb.member_id = public.current_ledger_member_id(cb.ledger_id)
      )
  );
$$;

create or replace function public.member_belongs_to_ledger(p_member_id uuid, p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_member_id is null or exists (
    select 1
    from public.ledger_members lm
    where lm.id = p_member_id
      and lm.ledger_id = p_ledger_id
  );
$$;

create or replace function public.is_valid_payment_status_transition(p_previous_status text, p_next_status text)
returns boolean
language sql
immutable
as $$
  select case coalesce(p_previous_status, 'open')
    when 'open' then coalesce(p_next_status, 'open') in ('open', 'requested')
    when 'requested' then coalesce(p_next_status, 'open') in ('requested', 'paid', 'open', 'cancelled')
    when 'paid' then coalesce(p_next_status, 'open') in ('paid', 'open')
    when 'cancelled' then coalesce(p_next_status, 'open') in ('cancelled', 'requested', 'open')
    else false
  end;
$$;

create or replace function public.enforce_settlement_request_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if new.ledger_id is null or new.ledger_id = '' then
    raise exception 'Settlement request is missing a ledger id' using errcode = '23502';
  end if;

  if new.from_member_id is null or new.to_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23502';
  end if;

  if new.from_member_id = new.to_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(new.from_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.to_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.requested_by_member_id, new.ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and not public.is_valid_payment_status_transition(old.status, new.status) then
    raise exception 'Invalid settlement request status transition from % to %', old.status, new.status using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and coalesce(new.status, 'open') = 'paid' then
    raise exception 'Request the payment before marking it paid' using errcode = '23514';
  end if;

  actor_member_id := public.current_ledger_member_id(new.ledger_id);
  if not public.is_ledger_admin(new.ledger_id) then
    if coalesce(new.status, 'open') = 'requested'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'requested')
       and actor_member_id is distinct from new.to_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    if coalesce(new.status, 'open') = 'paid'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'paid')
       and actor_member_id is distinct from new.from_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;
  end if;

  if new.status = 'requested' then
    new.requested_at := coalesce(new.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, actor_member_id, new.to_member_id);
    new.paid_at := null;
  elsif new.status = 'paid' then
    new.requested_at := coalesce(new.requested_at, old.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, old.requested_by_member_id, new.to_member_id);
    new.paid_at := coalesce(new.paid_at, now());
  elsif new.status in ('open', 'cancelled') then
    new.requested_at := null;
    new.requested_by_member_id := null;
    new.paid_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_settlement_request_integrity_trigger on public.settlement_requests;
create trigger enforce_settlement_request_integrity_trigger
before insert or update of ledger_id, period_id, from_member_id, to_member_id, amount, status, requested_at, paid_at, requested_by_member_id
on public.settlement_requests
for each row execute function public.enforce_settlement_request_integrity();

create or replace function public.prevent_overlapping_car_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.car_bookings existing
    where existing.ledger_id = new.ledger_id
      and existing.deleted_at is null
      and existing.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and new.start_at < existing.end_at
      and new.end_at > existing.start_at
  ) then
    raise exception 'The car is already booked for that time.' using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_overlapping_car_bookings_trigger on public.car_bookings;
create trigger prevent_overlapping_car_bookings_trigger
before insert or update of ledger_id, start_at, end_at, deleted_at
on public.car_bookings
for each row execute function public.prevent_overlapping_car_bookings();


create or replace function public.upsert_trip_with_participants(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_trip_id text,
  driver_member_id uuid,
  trip_date_value date,
  start_km_value numeric,
  end_km_value numeric,
  note_value text,
  participant_member_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_trip_id uuid;
  unique_participant_ids uuid[];
  existing_trip record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_trip_id is null or legacy_trip_id = '' then
    raise exception 'Missing legacy trip id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save trips' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if driver_member_id is null or not public.member_belongs_to_ledger(driver_member_id, target_ledger_id) then
    raise exception 'Trip driver must be an active member of this ledger' using errcode = '23514';
  end if;

  select coalesce(array_agg(distinct member_id), array[]::uuid[])
    into unique_participant_ids
  from unnest(coalesce(participant_member_ids, array[]::uuid[])) as member_id
  where public.member_belongs_to_ledger(member_id, target_ledger_id);

  if coalesce(array_length(unique_participant_ids, 1), 0) = 0 then
    raise exception 'Trip must include at least one active ledger participant' using errcode = '23514';
  end if;

  if not driver_member_id = any(unique_participant_ids) then
    unique_participant_ids := array_append(unique_participant_ids, driver_member_id);
  end if;

  if end_km_value <= start_km_value then
    raise exception 'Trip end km must be greater than start km' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':trip:' || legacy_trip_id));

  select * into existing_trip
  from public.trips t
  where t.ledger_id = target_ledger_id
    and t.legacy_id = legacy_trip_id
  for update;

  if existing_trip.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_trip.created_by_member_id = actor_member_id
    or existing_trip.driver_member_id = actor_member_id
  ) then
    raise exception 'Only the trip creator, driver, or a ledger admin can update this trip' using errcode = '42501';
  end if;

  insert into public.trips (
    legacy_id,
    ledger_id,
    period_id,
    driver_member_id,
    trip_date,
    start_km,
    end_km,
    note,
    created_by_member_id,
    deleted_at,
    updated_at
  ) values (
    legacy_trip_id,
    target_ledger_id,
    target_open_period_id,
    driver_member_id,
    trip_date_value,
    start_km_value,
    end_km_value,
    nullif(note_value, ''),
    actor_member_id,
    null,
    now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    driver_member_id = excluded.driver_member_id,
    trip_date = excluded.trip_date,
    start_km = excluded.start_km,
    end_km = excluded.end_km,
    note = excluded.note,
    deleted_at = null,
    updated_at = now()
  returning id into saved_trip_id;

  delete from public.trip_participants
  where trip_id = saved_trip_id;

  insert into public.trip_participants (trip_id, member_id)
  select saved_trip_id, member_id
  from unnest(unique_participant_ids) as member_id
  on conflict (trip_id, member_id) do nothing;

  return jsonb_build_object(
    'trip_id', saved_trip_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_trip_id,
    'participant_count', coalesce(array_length(unique_participant_ids, 1), 0)
  );
end;
$$;

grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[]) to authenticated;


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


create or replace function public.is_ledger_bootstrap_open(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ledger_members lm where lm.ledger_id = p_ledger_id
  )
  and not exists (
    select 1
    from public.ledgers l
    where l.id = p_ledger_id
      and l.bootstrap_locked_at is not null
  )
  and not exists (
    select 1
    from public.ledger_members lm
    where lm.ledger_id = p_ledger_id
      and lm.is_active = true
      and lm.email is not null
      and lm.email <> ''
  );
$$;

create or replace function public.lock_ledger_bootstrap_when_admin_email_attached()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active = true
    and new.role = 'admin'
    and new.email is not null
    and btrim(new.email) <> '' then
    update public.ledgers
    set bootstrap_locked_at = coalesce(bootstrap_locked_at, now()),
        updated_at = now()
    where id = new.ledger_id;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_ledger_bootstrap_on_admin_email on public.ledger_members;
create trigger lock_ledger_bootstrap_on_admin_email
after insert or update of email, role, is_active on public.ledger_members
for each row execute function public.lock_ledger_bootstrap_when_admin_email_attached();

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

alter table public.car_share_ledgers enable row level security;
alter table public.ledgers enable row level security;
alter table public.ledger_members enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.trips enable row level security;
alter table public.trip_participants enable row level security;
alter table public.fuel_payments enable row level security;
alter table public.car_bookings enable row level security;
alter table public.settlement_requests enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.ledger_events enable row level security;

-- Drop broad/test policies and recreate member-restricted policies.
drop policy if exists "Authenticated friends can read ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated friends can insert ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated friends can update ledgers" on public.car_share_ledgers;
drop policy if exists "Authenticated users can read ledgers" on public.ledgers;
drop policy if exists "Authenticated users can read members" on public.ledger_members;
drop policy if exists "Authenticated users can read periods" on public.settlement_periods;
drop policy if exists "Authenticated users can read trips" on public.trips;
drop policy if exists "Authenticated users can read participants" on public.trip_participants;
drop policy if exists "Authenticated users can read fuel" on public.fuel_payments;
drop policy if exists "Authenticated users can read settlement requests" on public.settlement_requests;

drop policy if exists "Ledger members can read JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can insert JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can update JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger admins can insert JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger admins can update JSON ledger" on public.car_share_ledgers;
drop policy if exists "Ledger members can read ledgers" on public.ledgers;
drop policy if exists "Ledger admins can update ledgers" on public.ledgers;
drop policy if exists "Bootstrap users can update ledgers" on public.ledgers;
drop policy if exists "Ledger members can read members" on public.ledger_members;
drop policy if exists "Ledger admins can insert members" on public.ledger_members;
drop policy if exists "Ledger admins can update members" on public.ledger_members;
drop policy if exists "Ledger admins can delete members" on public.ledger_members;
drop policy if exists "Bootstrap users can read members" on public.ledger_members;
drop policy if exists "Bootstrap users can update members" on public.ledger_members;
drop policy if exists "Ledger members can read periods" on public.settlement_periods;
drop policy if exists "Ledger members can insert periods" on public.settlement_periods;
drop policy if exists "Ledger members can update periods" on public.settlement_periods;
drop policy if exists "Ledger admins can update periods" on public.settlement_periods;
drop policy if exists "Ledger members can read trips" on public.trips;
drop policy if exists "Ledger members can insert trips" on public.trips;
drop policy if exists "Ledger members can update trips" on public.trips;
drop policy if exists "Trip creators and admins can insert trips" on public.trips;
drop policy if exists "Trip creators drivers and admins can update trips" on public.trips;
drop policy if exists "Ledger members can read trip participants" on public.trip_participants;
drop policy if exists "Ledger members can insert trip participants" on public.trip_participants;
drop policy if exists "Ledger members can update trip participants" on public.trip_participants;
drop policy if exists "Ledger members can delete trip participants" on public.trip_participants;
drop policy if exists "Trip managers can insert trip participants" on public.trip_participants;
drop policy if exists "Trip managers can update trip participants" on public.trip_participants;
drop policy if exists "Trip managers can delete trip participants" on public.trip_participants;
drop policy if exists "Ledger members can read fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can insert fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can update fuel payments" on public.fuel_payments;
drop policy if exists "Fuel creators payers and admins can insert fuel payments" on public.fuel_payments;
drop policy if exists "Fuel creators payers and admins can update fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can read car bookings" on public.car_bookings;
drop policy if exists "Booking creators members and admins can insert car bookings" on public.car_bookings;
drop policy if exists "Booking creators members and admins can update car bookings" on public.car_bookings;
drop policy if exists "Ledger members can read settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can insert settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can update settlement requests" on public.settlement_requests;
drop policy if exists "Settlement parties and admins can insert settlement requests" on public.settlement_requests;
drop policy if exists "Settlement parties and admins can update settlement requests" on public.settlement_requests;

create policy "Ledger members can read JSON ledger" on public.car_share_ledgers for select to authenticated using (public.is_ledger_member(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can insert JSON ledger" on public.car_share_ledgers for insert to authenticated with check (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can update JSON ledger" on public.car_share_ledgers for update to authenticated using (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id)) with check (public.is_ledger_admin(id) or public.is_ledger_bootstrap_open(id));

create policy "Ledger members can read ledgers" on public.ledgers for select to authenticated using (public.is_ledger_member(id) or public.is_ledger_bootstrap_open(id));
create policy "Ledger admins can update ledgers" on public.ledgers for update to authenticated using (public.is_ledger_admin(id)) with check (public.is_ledger_admin(id));
create policy "Bootstrap users can update ledgers" on public.ledgers for update to authenticated using (public.is_ledger_bootstrap_open(id)) with check (public.is_ledger_bootstrap_open(id));

create policy "Ledger members can read members" on public.ledger_members for select to authenticated using (public.is_ledger_member(ledger_id) or public.is_ledger_bootstrap_open(ledger_id));
create policy "Ledger admins can insert members" on public.ledger_members for insert to authenticated with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can update members" on public.ledger_members for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can delete members" on public.ledger_members for delete to authenticated using (public.is_ledger_admin(ledger_id));
create policy "Bootstrap users can read members" on public.ledger_members for select to authenticated using (public.is_ledger_bootstrap_open(ledger_id));
create policy "Bootstrap users can update members" on public.ledger_members for update to authenticated using (public.is_ledger_bootstrap_open(ledger_id)) with check (public.is_ledger_bootstrap_open(ledger_id));

create policy "Ledger members can read periods" on public.settlement_periods for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert periods" on public.settlement_periods for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger admins can update periods" on public.settlement_periods for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));

create policy "Ledger members can read trips" on public.trips for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Trip creators and admins can insert trips" on public.trips for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Trip creators drivers and admins can update trips" on public.trips for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or driver_member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read trip participants" on public.trip_participants for select to authenticated using (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));
create policy "Trip managers can insert trip participants" on public.trip_participants for insert to authenticated with check (public.can_manage_trip(trip_id));
create policy "Trip managers can update trip participants" on public.trip_participants for update to authenticated using (public.can_manage_trip(trip_id)) with check (public.can_manage_trip(trip_id));
create policy "Trip managers can delete trip participants" on public.trip_participants for delete to authenticated using (public.can_manage_trip(trip_id));

create policy "Ledger members can read fuel payments" on public.fuel_payments for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Fuel creators payers and admins can insert fuel payments" on public.fuel_payments for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Fuel creators payers and admins can update fuel payments" on public.fuel_payments for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or payer_member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read car bookings" on public.car_bookings for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Booking creators members and admins can insert car bookings" on public.car_bookings for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id)));
create policy "Booking creators members and admins can update car bookings" on public.car_bookings for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id) or member_id = public.current_ledger_member_id(ledger_id)));

create policy "Ledger members can read settlement requests" on public.settlement_requests for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Settlement parties and admins can insert settlement requests" on public.settlement_requests for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Settlement parties and admins can update settlement requests" on public.settlement_requests for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or from_member_id = public.current_ledger_member_id(ledger_id) or to_member_id = public.current_ledger_member_id(ledger_id) or requested_by_member_id = public.current_ledger_member_id(ledger_id)));


drop policy if exists "Ledger members can read ledger events" on public.ledger_events;
drop policy if exists "Ledger members can insert ledger events" on public.ledger_events;
drop policy if exists "Ledger admins can delete ledger events" on public.ledger_events;
create policy "Ledger members can read ledger events" on public.ledger_events for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert ledger events" on public.ledger_events for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger admins can delete ledger events" on public.ledger_events for delete to authenticated using (public.is_ledger_admin(ledger_id));

-- Keep Supabase Realtime narrow: only the tiny event stream should be needed
-- for in-app notifications. Broad table Realtime remains off in the app.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'ledger_events'
     ) then
    execute 'alter publication supabase_realtime add table public.ledger_events';
  end if;
exception
  when duplicate_object then null;
  when insufficient_privilege then null;
end $$;

drop policy if exists "Users can read own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can insert own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can update own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can delete own push subscriptions" on public.push_subscriptions;
create policy "Users can read own push subscriptions" on public.push_subscriptions for select to authenticated using (lower(user_email) = public.current_user_email());
create policy "Users can insert own push subscriptions" on public.push_subscriptions for insert to authenticated with check (lower(user_email) = public.current_user_email());
create policy "Users can update own push subscriptions" on public.push_subscriptions for update to authenticated using (lower(user_email) = public.current_user_email()) with check (lower(user_email) = public.current_user_email());
create policy "Users can delete own push subscriptions" on public.push_subscriptions for delete to authenticated using (lower(user_email) = public.current_user_email());


-- Lightweight read-only healthcheck for frontend Security Health.
-- Important: this must not call close_settlement_period because that RPC takes an advisory lock.
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status;
$$;
revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;


-- Scheduled backend reminder helpers.
-- These RPC functions are called by the Render cron endpoint with the service-role key.
-- They let the backend process the same Supabase production JSON mirror used by the app,
-- instead of scanning Render's local ledger-data.json file.
create or replace function public.scheduled_reminder_state(p_ledger_id text default 'main-car')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'ledger_id', id,
    'state', state,
    'updated_at', updated_at
  ) into result
  from public.car_share_ledgers
  where id = p_ledger_id;

  return coalesce(result, jsonb_build_object(
    'ledger_id', p_ledger_id,
    'state', null,
    'updated_at', null
  ));
end;
$$;

create or replace function public.save_scheduled_reminder_state(p_ledger_id text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  insert into public.car_share_ledgers (id, state, updated_at)
  values (p_ledger_id, coalesce(p_state, '{}'::jsonb), now())
  on conflict (id) do update set
    state = excluded.state,
    updated_at = excluded.updated_at
  returning jsonb_build_object(
    'ledger_id', id,
    'updated_at', updated_at
  ) into result;

  return result;
end;
$$;

-- Post-run setup check:
-- select name, email, role, is_active from ledger_members where ledger_id = 'main-car' order by name;

-- Scheduled reminder RPCs must not be executable by normal client roles.
-- The Render reminder endpoint calls them with the Supabase service-role key.
revoke all on function public.scheduled_reminder_state(text) from public;
revoke all on function public.scheduled_reminder_state(text) from anon;
revoke all on function public.scheduled_reminder_state(text) from authenticated;
grant execute on function public.scheduled_reminder_state(text) to service_role;

revoke all on function public.save_scheduled_reminder_state(text, jsonb) from public;
revoke all on function public.save_scheduled_reminder_state(text, jsonb) from anon;
revoke all on function public.save_scheduled_reminder_state(text, jsonb) from authenticated;
grant execute on function public.save_scheduled_reminder_state(text, jsonb) to service_role;



-- Data retention and privacy cleanup helpers. These functions intentionally delete
-- only temporary/debug records: old in-app notification events and stale push
-- subscriptions. Real trips, fuel logs, bookings, settlements, closed periods,
-- and audit-critical ledger history are not touched.
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
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days
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
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days
  );
end;
$$;

grant execute on function public.preview_retention_cleanup(text, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer) to authenticated;
-- Migration 011: Add transactional booking write/delete RPCs.
-- Moves booking upsert and soft-delete behind explicit server-side validation,
-- permission checks, and per-booking advisory locks.

create or replace function public.upsert_car_booking(
  target_ledger_id text,
  legacy_booking_id text,
  booking_member_id uuid,
  start_at_value timestamptz,
  end_at_value timestamptz,
  purpose_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_booking_id uuid;
  existing_booking record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Missing legacy booking id' using errcode = '22023';
  end if;

  if start_at_value is null or end_at_value is null or end_at_value <= start_at_value then
    raise exception 'Booking end time must be after start time' using errcode = '23514';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save car bookings' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if booking_member_id is null or not public.member_belongs_to_ledger(booking_member_id, target_ledger_id) then
    raise exception 'Booking member must be an active member of this ledger' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':booking:' || legacy_booking_id));

  select *
    into existing_booking
  from public.car_bookings
  where ledger_id = target_ledger_id
    and legacy_id = legacy_booking_id
  for update;

  if existing_booking.id is not null and not public.can_manage_car_booking(existing_booking.id) then
    raise exception 'Only the booking creator, booked member, or a ledger admin can update this booking' using errcode = '42501';
  end if;

  if existing_booking.id is null
     and not (
       public.is_ledger_admin(target_ledger_id)
       or actor_member_id = booking_member_id
     ) then
    raise exception 'Only the booked member or a ledger admin can create this booking' using errcode = '42501';
  end if;

  if existing_booking.id is null then
    insert into public.car_bookings (
      legacy_id,
      ledger_id,
      member_id,
      start_at,
      end_at,
      purpose,
      created_by_member_id,
      deleted_at,
      updated_at
    ) values (
      legacy_booking_id,
      target_ledger_id,
      booking_member_id,
      start_at_value,
      end_at_value,
      nullif(purpose_value, ''),
      actor_member_id,
      null,
      now()
    )
    returning id into saved_booking_id;
  else
    update public.car_bookings
    set member_id = booking_member_id,
        start_at = start_at_value,
        end_at = end_at_value,
        purpose = nullif(purpose_value, ''),
        deleted_at = null,
        updated_at = now()
    where id = existing_booking.id
    returning id into saved_booking_id;
  end if;

  return jsonb_build_object(
    'booking_id', saved_booking_id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

create or replace function public.soft_delete_car_booking(
  target_ledger_id text,
  legacy_booking_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_booking record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Missing legacy booking id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can delete car bookings' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':booking:' || legacy_booking_id));

  select *
    into existing_booking
  from public.car_bookings
  where ledger_id = target_ledger_id
    and legacy_id = legacy_booking_id
  for update;

  if existing_booking.id is null then
    return jsonb_build_object(
      'deleted', false,
      'legacy_id', legacy_booking_id,
      'reason', 'not_found'
    );
  end if;

  if not public.can_manage_car_booking(existing_booking.id) then
    raise exception 'Only the booking creator, booked member, or a ledger admin can delete this booking' using errcode = '42501';
  end if;

  update public.car_bookings
  set deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
  where id = existing_booking.id;

  return jsonb_build_object(
    'deleted', true,
    'booking_id', existing_booking.id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.soft_delete_car_booking(text, text) to authenticated;
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
-- Migration 013: Add fuel payment write RPC.
-- Moves single-row fuel payment upsert behind explicit server-side validation,
-- permission checks, and a per-fuel advisory lock for consistency with trips/bookings.

create or replace function public.upsert_fuel_payment(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_fuel_id text,
  payer_member_id uuid,
  payment_date_value date,
  amount_value numeric,
  currency_value text,
  liters_value numeric,
  price_per_liter_value numeric,
  odometer_value numeric,
  station_name_value text,
  station_brand_value text,
  station_lat_value numeric,
  station_lng_value numeric,
  user_lat_value numeric,
  user_lng_value numeric,
  full_tank_value boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_fuel_id uuid;
  existing_fuel record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_fuel_id is null or legacy_fuel_id = '' then
    raise exception 'Missing legacy fuel id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save fuel payments' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or not public.member_belongs_to_ledger(payer_member_id, target_ledger_id) then
    raise exception 'Fuel payer must be an active member of this ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Fuel amount must be zero or greater' using errcode = '23514';
  end if;

  if liters_value is not null and liters_value < 0 then
    raise exception 'Fuel liters must be zero or greater' using errcode = '23514';
  end if;

  if price_per_liter_value is not null and price_per_liter_value < 0 then
    raise exception 'Fuel price per liter must be zero or greater' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':fuel:' || legacy_fuel_id));

  select *
    into existing_fuel
  from public.fuel_payments
  where ledger_id = target_ledger_id
    and legacy_id = legacy_fuel_id
  for update;

  if existing_fuel.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_fuel.created_by_member_id = actor_member_id
    or existing_fuel.payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel creator, payer, or a ledger admin can update this fuel payment' using errcode = '42501';
  end if;

  if existing_fuel.id is null and not (
    public.is_ledger_admin(target_ledger_id)
    or payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel payer or a ledger admin can create this fuel payment' using errcode = '42501';
  end if;

  insert into public.fuel_payments (
    legacy_id,
    ledger_id,
    period_id,
    payer_member_id,
    payment_date,
    amount,
    currency,
    liters,
    price_per_liter,
    odometer,
    station_name,
    station_brand,
    station_lat,
    station_lng,
    user_lat,
    user_lng,
    full_tank,
    created_by_member_id,
    deleted_at,
    updated_at
  ) values (
    legacy_fuel_id,
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    payment_date_value,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    liters_value,
    price_per_liter_value,
    odometer_value,
    nullif(station_name_value, ''),
    nullif(station_brand_value, ''),
    station_lat_value,
    station_lng_value,
    user_lat_value,
    user_lng_value,
    coalesce(full_tank_value, false),
    actor_member_id,
    null,
    now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    payer_member_id = excluded.payer_member_id,
    payment_date = excluded.payment_date,
    amount = excluded.amount,
    currency = excluded.currency,
    liters = excluded.liters,
    price_per_liter = excluded.price_per_liter,
    odometer = excluded.odometer,
    station_name = excluded.station_name,
    station_brand = excluded.station_brand,
    station_lat = excluded.station_lat,
    station_lng = excluded.station_lng,
    user_lat = excluded.user_lat,
    user_lng = excluded.user_lng,
    full_tank = excluded.full_tank,
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean) to authenticated;
-- Migration 015: store Test Lab reports outside the full JSON ledger mirror.

-- Cloud-saved diagnostic reports are operational/debug records, not ledger state.
-- Keep them in a small normalized table so saving a report does not upsert the
-- full car_share_ledgers JSON mirror.
create table if not exists public.test_lab_reports (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  report_id text not null,
  report_payload jsonb not null,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists test_lab_reports_ledger_synced_idx
on public.test_lab_reports (ledger_id, synced_at desc);

create index if not exists test_lab_reports_ledger_report_id_idx
on public.test_lab_reports (ledger_id, report_id);

alter table public.test_lab_reports enable row level security;

drop policy if exists "Ledger members can read test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can insert test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can update test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can delete test lab reports" on public.test_lab_reports;
create policy "Ledger members can read test lab reports" on public.test_lab_reports
  for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger admins can insert test lab reports" on public.test_lab_reports
  for insert to authenticated with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can update test lab reports" on public.test_lab_reports
  for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can delete test lab reports" on public.test_lab_reports
  for delete to authenticated using (public.is_ledger_admin(ledger_id));

create or replace function public.upsert_test_lab_report(
  target_ledger_id text,
  report_id_value text,
  report_payload_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  normalized_report_id text := nullif(trim(coalesce(report_id_value, '')), '');
  saved_row public.test_lab_reports%rowtype;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can save Test Lab reports';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not an active ledger member';
  end if;

  if normalized_report_id is null then
    raise exception 'Test Lab report id is required';
  end if;

  if report_payload_value is null or jsonb_typeof(report_payload_value) <> 'object' then
    raise exception 'Test Lab report payload must be a JSON object';
  end if;

  -- Intentionally insert a new row for every cloud save. The function name stays
  -- as upsert_test_lab_report for backward compatibility with deployed clients.
  insert into public.test_lab_reports (ledger_id, report_id, report_payload, created_by_member_id, synced_at)
  values (
    target_ledger_id,
    normalized_report_id,
    report_payload_value,
    actor_member_id,
    now()
  )
  returning * into saved_row;

  return jsonb_build_object(
    'id', saved_row.id,
    'ledger_id', saved_row.ledger_id,
    'report_id', saved_row.report_id,
    'synced_at', saved_row.synced_at,
    'created_at', saved_row.created_at,
    'immutable_history', true
  );
end;
$$;

revoke all on function public.upsert_test_lab_report(text, text, jsonb) from public;
revoke all on function public.upsert_test_lab_report(text, text, jsonb) from anon;
grant execute on function public.upsert_test_lab_report(text, text, jsonb) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
    'critical_rpcs', jsonb_build_object(
      'close_settlement_period',
        to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
      'upsert_trip_with_participants',
        to_regprocedure('public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[])') is not null,
      'upsert_fuel_payment',
        to_regprocedure('public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean)') is not null,
      'upsert_car_booking',
        to_regprocedure('public.upsert_car_booking(text, text, uuid, timestamp with time zone, timestamp with time zone, text)') is not null,
      'soft_delete_car_booking',
        to_regprocedure('public.soft_delete_car_booking(text, text)') is not null,
      'upsert_ledger_member_admin',
        to_regprocedure('public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean)') is not null,
      'set_ledger_member_active_admin',
        to_regprocedure('public.set_ledger_member_active_admin(text, uuid, boolean)') is not null,
      'purge_generated_test_rows',
        to_regprocedure('public.purge_generated_test_rows(text, boolean)') is not null,
      'production_activity_reset',
        to_regprocedure('public.production_activity_reset(text)') is not null,
      'preview_retention_cleanup',
        to_regprocedure('public.preview_retention_cleanup(text, integer, integer, integer)') is not null,
      'run_retention_cleanup',
        to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer)') is not null,
      'upsert_test_lab_report',
        to_regprocedure('public.upsert_test_lab_report(text, text, jsonb)') is not null
    ),
    'checked_at', now()
  );
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 016: expose Supabase Realtime publication health in backend diagnostics.

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
    'critical_rpcs', jsonb_build_object(
      'close_settlement_period',
        to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
      'upsert_trip_with_participants',
        to_regprocedure('public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[])') is not null,
      'upsert_fuel_payment',
        to_regprocedure('public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean)') is not null,
      'upsert_car_booking',
        to_regprocedure('public.upsert_car_booking(text, text, uuid, timestamp with time zone, timestamp with time zone, text)') is not null,
      'soft_delete_car_booking',
        to_regprocedure('public.soft_delete_car_booking(text, text)') is not null,
      'upsert_ledger_member_admin',
        to_regprocedure('public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean)') is not null,
      'set_ledger_member_active_admin',
        to_regprocedure('public.set_ledger_member_active_admin(text, uuid, boolean)') is not null,
      'purge_generated_test_rows',
        to_regprocedure('public.purge_generated_test_rows(text, boolean)') is not null,
      'production_activity_reset',
        to_regprocedure('public.production_activity_reset(text)') is not null,
      'preview_retention_cleanup',
        to_regprocedure('public.preview_retention_cleanup(text, integer, integer, integer)') is not null,
      'run_retention_cleanup',
        to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer)') is not null,
      'upsert_test_lab_report',
        to_regprocedure('public.upsert_test_lab_report(text, text, jsonb)') is not null
    ),
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  );
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 017: make Security Health RPC availability checks signature-tolerant.

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 018: narrow Supabase Realtime publication to lightweight ledger events.

-- The app now uses public.ledger_events for lightweight cross-tab/cloud sync. Keeping the
-- broad public.car_share_ledgers JSON table in Supabase Realtime can make
-- realtime.list_changes dominate database time, especially when old tabs or Live Sync are open.
-- This migration removes only that broad legacy table from the Supabase Realtime publication
-- and leaves/adds public.ledger_events as the recommended Realtime table.
do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'car_share_ledgers'
    ) then
      execute 'alter publication supabase_realtime drop table public.car_share_ledgers';
    end if;

    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'ledger_events'
    ) and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ledger_events'
    ) then
      execute 'alter publication supabase_realtime add table public.ledger_events';
    end if;
  end if;
end $$;
-- Migration 021: include cloud Test Lab report history in retention cleanup.
--
-- Test Lab reports are useful diagnostics, but they can contain environment metadata and
-- should not accumulate forever. Retention cleanup now prunes old cloud report history
-- while always keeping the newest reports for recent audit/debug context.

drop function if exists public.preview_retention_cleanup(text, integer, integer);
drop function if exists public.run_retention_cleanup(text, integer, integer);

create or replace function public.preview_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
  kept_report_count integer := 0;
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

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), removable_reports as (
    select id
    from ranked_reports
    where newest_rank > greatest(keep_latest_test_lab_reports, 1)
       or retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
  )
  select count(*) into report_count from removable_reports;

  select count(*) into kept_report_count
  from public.test_lab_reports
  where ledger_id = target_ledger_id;
  kept_report_count := greatest(kept_report_count - report_count, 0);

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'kept_test_lab_reports', kept_report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

create or replace function public.run_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
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

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), deleted_reports as (
    delete from public.test_lab_reports reports
    using ranked_reports ranked
    where reports.id = ranked.id
      and (
        ranked.newest_rank > greatest(keep_latest_test_lab_reports, 1)
        or ranked.retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
      )
    returning 1
  )
  select count(*) into report_count from deleted_reports;

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from anon;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  realtime_tables text[] := array[]::text[];
  extra_realtime_tables text[] := array[]::text[];
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run health checks';
  end if;

  select coalesce(array_agg(schemaname || '.' || tablename order by schemaname, tablename), array[]::text[])
  into realtime_tables
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and schemaname = 'public';

  select coalesce(array_agg(table_name order by table_name), array[]::text[])
  into extra_realtime_tables
  from unnest(realtime_tables) as table_name
  where table_name <> 'public.ledger_events';

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'checked_at', now(),
    'is_admin', true,
    'current_member_id', public.current_ledger_member_id(target_ledger_id),
    'critical_rpcs', jsonb_object_agg(rpc_name, exists_flag),
    'realtime_publication', jsonb_build_object(
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'published_tables', to_jsonb(realtime_tables),
      'extra_tables', to_jsonb(extra_realtime_tables),
      'has_extra_tables', cardinality(extra_realtime_tables) > 0,
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    )
  )
  from (
    values
      ('close_current_period'),
      ('upsert_trip_transaction'),
      ('upsert_booking_transaction'),
      ('mark_booking_logged_transaction'),
      ('cancel_booking_transaction'),
      ('upsert_fuel_payment'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ) rpc_names(rpc_name)
  cross join lateral (
    select case rpc_name
      when 'preview_retention_cleanup' then to_regprocedure('public.preview_retention_cleanup(text, integer, integer, integer, integer)') is not null
      when 'run_retention_cleanup' then to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer, integer)') is not null
      else exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
    end as exists_flag
  ) rpc_exists;
end;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 022: Add transactional settlement request status RPC.
-- Keeps payment status upsert and stale payment-line cancellation in one database
-- transaction so the normalized backend cannot persist a payment status change
-- without the matching stale-row cleanup.

create or replace function public.upsert_settlement_request_status(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  next_status text,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  saved_request_id uuid;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_status text := coalesce(nullif(next_status, ''), 'open');
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save settlement requests' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or recipient_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23514';
  end if;

  if payer_member_id = recipient_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(payer_member_id, target_ledger_id)
    or not public.member_belongs_to_ledger(recipient_member_id, target_ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Settlement request amount must be zero or greater' using errcode = '23514';
  end if;

  if normalized_status not in ('open', 'requested', 'paid', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  if normalized_status = 'requested' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
  elsif normalized_status = 'paid' then
    paid_at_value := now();
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':settlement:' || target_open_period_id::text));

  insert into public.settlement_requests (
    ledger_id,
    period_id,
    from_member_id,
    to_member_id,
    amount,
    currency,
    status,
    requested_at,
    requested_by_member_id,
    paid_at,
    updated_at
  ) values (
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    recipient_member_id,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    normalized_status,
    requested_at_value,
    requested_by_value,
    paid_at_value,
    now()
  )
  on conflict (period_id, from_member_id, to_member_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    requested_at = excluded.requested_at,
    requested_by_member_id = excluded.requested_by_member_id,
    paid_at = excluded.paid_at,
    updated_at = now()
  returning id into saved_request_id;

  update public.settlement_requests sr
     set status = 'cancelled',
         updated_at = now(),
         requested_at = null,
         requested_by_member_id = null,
         paid_at = null
   where sr.ledger_id = target_ledger_id
     and sr.period_id = target_open_period_id
     and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(coalesce(current_pair_keys, array[]::text[])))
     and sr.status <> 'cancelled';
  get diagnostics cancelled_count = row_count;

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'status', normalized_status,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 023: Track applied Fuel Ledger schema migrations.
-- Adds an idempotent migration ledger so Security Health can report whether the
-- live Supabase schema has all expected Fuel Ledger migrations applied.

create table if not exists public.fuel_ledger_schema_migrations (
  migration_id text primary key,
  description text not null default '',
  applied_at timestamptz not null default now()
);

comment on table public.fuel_ledger_schema_migrations is
  'Tracks Fuel Ledger Supabase migrations that have been applied to this project.';

alter table public.fuel_ledger_schema_migrations enable row level security;

revoke all on public.fuel_ledger_schema_migrations from public;
revoke all on public.fuel_ledger_schema_migrations from anon;
grant select on public.fuel_ledger_schema_migrations to authenticated;

drop policy if exists fuel_ledger_schema_migrations_admin_select on public.fuel_ledger_schema_migrations;

create policy fuel_ledger_schema_migrations_admin_select
  on public.fuel_ledger_schema_migrations
  for select
  to authenticated
  using (exists (
    select 1
    from public.ledger_members lm
    where lm.is_active = true
      and lm.role = 'admin'
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  ));

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values
    ('001_initial_schema', 'Core tables, indexes, seed ledger/member records, push subscriptions, and ledger events.'),
    ('002_auth_helpers', 'Auth/member helper functions used by RLS and write guards.'),
    ('003_payment_booking_guards', 'Payment status/integrity triggers and booking overlap guard.'),
    ('004_period_close_and_admin_rpcs', 'Period-close RPC and admin production reset RPC.'),
    ('005_rls_policies', 'RLS enablement plus member/admin policies.'),
    ('006_realtime_ledger_events', 'Narrow ledger events Realtime stream.'),
    ('007_security_health_rpc', 'Lightweight Security Health RPC.'),
    ('008_scheduled_reminder_rpcs', 'Service-role scheduled reminder RPCs.'),
    ('009_retention_privacy_cleanup', 'Retention/privacy cleanup RPCs.'),
    ('010_trip_transaction_rpc', 'Trip plus participant transaction RPC.'),
    ('011_booking_transaction_rpcs', 'Booking upsert/delete transaction RPCs.'),
    ('012_admin_tools_guardrails', 'Admin guardrail RPCs.'),
    ('013_fuel_payment_rpc', 'Fuel/payment transaction RPC.'),
    ('014_rpc_health_visibility', 'Critical RPC health visibility.'),
    ('015_test_lab_report_store', 'Cloud Test Lab report store.'),
    ('016_realtime_publication_health', 'Realtime publication health details.'),
    ('017_healthcheck_rpc_detection_fix', 'Healthcheck RPC detection fix.'),
    ('018_realtime_publication_cleanup', 'Realtime publication cleanup.'),
    ('019_immutable_test_lab_report_history', 'Immutable Test Lab report history.'),
    ('020_bootstrap_lock', 'Bootstrap lock guard.'),
    ('021_cloud_test_lab_report_retention', 'Cloud Test Lab report retention cleanup.'),
    ('022_settlement_request_transaction_rpc', 'Settlement request status transaction RPC.'),
    ('023_schema_migration_tracking', 'Schema migration tracking table and healthcheck drift detection.')
on conflict (migration_id) do update set
  description = excluded.description;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
-- Migration 025: Add private workspace/ledger isolation foundation for future public launch readiness.
-- This does not enable public signup. It adds safe metadata and RPCs so future onboarding can create/list isolated ledgers.

alter table public.ledgers
  add column if not exists slug text,
  add column if not exists created_by_member_id uuid,
  add column if not exists is_public_signup_enabled boolean not null default false,
  add column if not exists invite_required boolean not null default true;

update public.ledgers
set slug = coalesce(nullif(slug, ''), lower(regexp_replace(id, '[^a-z0-9]+', '-', 'g')))
where slug is null or slug = '';

alter table public.ledgers
  alter column slug set not null;

create unique index if not exists ledgers_slug_unique_idx on public.ledgers (lower(slug));
create index if not exists ledger_members_email_ledger_active_idx on public.ledger_members (lower(email), ledger_id) where is_active = true and email is not null;
create index if not exists ledger_members_ledger_role_active_idx on public.ledger_members (ledger_id, role) where is_active = true;

create or replace function public.normalize_ledger_slug(raw_slug text)
returns text
language sql
immutable
as $$
  select trim(both '-' from lower(regexp_replace(coalesce(raw_slug, ''), '[^a-zA-Z0-9]+', '-', 'g')));
$$;

create or replace function public.list_my_ledgers()
returns table (
  ledger_id text,
  slug text,
  name text,
  role text,
  member_id uuid,
  is_public_signup_enabled boolean,
  invite_required boolean,
  bootstrap_locked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id as ledger_id,
    l.slug,
    l.name,
    lm.role,
    lm.id as member_id,
    l.is_public_signup_enabled,
    l.invite_required,
    l.bootstrap_locked_at
  from public.ledgers l
  join public.ledger_members lm on lm.ledger_id = l.id
  where lm.is_active = true
    and lm.email is not null
    and lower(lm.email) = public.current_user_email()
  order by l.created_at asc, l.id asc;
$$;

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

  return query
  select new_ledger_id, normalized_slug, nullif(btrim(workspace_name), ''), new_member_id;
exception
  when unique_violation then
    raise exception 'Workspace slug is already in use.' using errcode = '23505';
end;
$$;

revoke all on function public.normalize_ledger_slug(text) from public;
revoke all on function public.list_my_ledgers() from public;
revoke all on function public.create_private_ledger_workspace(text, text) from public;
revoke all on function public.list_my_ledgers() from anon;
revoke all on function public.create_private_ledger_workspace(text, text) from anon;
grant execute on function public.normalize_ledger_slug(text) to authenticated;
grant execute on function public.list_my_ledgers() to authenticated;
grant execute on function public.create_private_ledger_workspace(text, text) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('025_workspace_foundation', 'Private workspace and ledger isolation foundation with slug metadata and safe list/create RPCs.')
on conflict (migration_id) do update set
  description = excluded.description;
-- Migration 026: Add private invite onboarding foundation for future public workspace joins.
-- This keeps public signup disabled. Invites are admin-created, signed-in-user redeemed, and scoped to one ledger.

create table if not exists public.ledger_invites (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  invite_code_hash text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_email text,
  max_uses integer not null default 1 check (max_uses > 0),
  uses_count integer not null default 0 check (uses_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, invite_code_hash),
  check (uses_count <= max_uses)
);

create index if not exists ledger_invites_ledger_active_idx
on public.ledger_invites (ledger_id, expires_at)
where revoked_at is null and uses_count < max_uses;

create index if not exists ledger_invites_email_active_idx
on public.ledger_invites (lower(invited_email), ledger_id)
where invited_email is not null and revoked_at is null and uses_count < max_uses;

alter table public.ledger_invites enable row level security;

drop policy if exists "Ledger admins can read invites" on public.ledger_invites;
create policy "Ledger admins can read invites"
  on public.ledger_invites
  for select
  to authenticated
  using (public.is_ledger_admin(ledger_id));

drop policy if exists "Ledger admins can update invites" on public.ledger_invites;
create policy "Ledger admins can update invites"
  on public.ledger_invites
  for update
  to authenticated
  using (public.is_ledger_admin(ledger_id))
  with check (public.is_ledger_admin(ledger_id));

create or replace function public.hash_ledger_invite_code(invite_code text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(coalesce(invite_code, ''), 'sha256'), 'hex');
$$;

create or replace function public.create_ledger_invite(
  target_ledger_id text default 'main-car',
  invite_role text default 'member',
  invite_email text default null,
  expires_in_hours integer default 168,
  max_uses integer default 1
)
returns table (
  invite_id uuid,
  invite_code text,
  ledger_id text,
  role text,
  invited_email text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  generated_code text;
  normalized_role text := case when invite_role = 'admin' then 'admin' else 'member' end;
  normalized_email text := nullif(lower(btrim(coalesce(invite_email, ''))), '');
  safe_max_uses integer := greatest(coalesce(max_uses, 1), 1);
  safe_expires_at timestamptz := case
    when expires_in_hours is null or expires_in_hours <= 0 then now() + interval '7 days'
    else now() + make_interval(hours => least(expires_in_hours, 24 * 30))
  end;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can create invites' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not linked to this ledger' using errcode = '42501';
  end if;

  generated_code := 'fl-' || lower(encode(extensions.gen_random_bytes(16), 'hex'));

  insert into public.ledger_invites (
    ledger_id,
    invite_code_hash,
    role,
    invited_email,
    max_uses,
    uses_count,
    expires_at,
    created_by_member_id
  ) values (
    target_ledger_id,
    public.hash_ledger_invite_code(generated_code),
    normalized_role,
    normalized_email,
    safe_max_uses,
    0,
    safe_expires_at,
    actor_member_id
  ) returning id into invite_id;

  return query
  select invite_id, generated_code, target_ledger_id, normalized_role, normalized_email, safe_expires_at;
end;
$$;

create or replace function public.redeem_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  member_id uuid,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
begin
  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  select * into invite_row
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1
  for update;

  if invite_row.id is null then
    raise exception 'Invite is invalid, expired, revoked, or already used.' using errcode = 'P0001';
  end if;

  if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
    raise exception 'This invite is for a different email address.' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = invite_row.ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else invite_row.role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = invite_row.ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (
      ledger_id,
      name,
      email,
      role,
      is_active
    ) values (
      invite_row.ledger_id,
      base_name,
      current_email,
      invite_row.role,
      true
    ) returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  update public.ledger_invites
  set uses_count = uses_count + 1,
      updated_at = now()
  where id = invite_row.id;

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

create or replace function public.revoke_ledger_invite(
  target_ledger_id text,
  target_invite_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can revoke invites' using errcode = '42501';
  end if;

  update public.ledger_invites
  set revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where id = target_invite_id
    and ledger_id = target_ledger_id;
end;
$$;

revoke all on table public.ledger_invites from public;
revoke all on table public.ledger_invites from anon;
revoke all on table public.ledger_invites from authenticated;
grant select on public.ledger_invites to authenticated;

revoke all on function public.hash_ledger_invite_code(text) from public;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from public;
revoke all on function public.redeem_ledger_invite(text) from public;
revoke all on function public.revoke_ledger_invite(text, uuid) from public;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from anon;
revoke all on function public.redeem_ledger_invite(text) from anon;
revoke all on function public.revoke_ledger_invite(text, uuid) from anon;
grant execute on function public.hash_ledger_invite_code(text) to authenticated;
grant execute on function public.create_ledger_invite(text, text, text, integer, integer) to authenticated;
grant execute on function public.redeem_ledger_invite(text) to authenticated;
grant execute on function public.revoke_ledger_invite(text, uuid) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('026_invite_onboarding_foundation', 'Private invite onboarding foundation with admin-created invites and signed-in redemption RPCs.')
on conflict (migration_id) do update set
  description = excluded.description;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('027_invite_code_generation_pgcrypto_fix', 'Schema-qualify pgcrypto invite code generation so invite RPCs work on deployed Supabase projects.')
on conflict (migration_id) do update set
  description = excluded.description;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('028_invite_code_hash_pgcrypto_fix', 'Schema-qualify pgcrypto invite code hashing so invite RPCs work on deployed Supabase projects.')
on conflict (migration_id) do update set
  description = excluded.description;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '029_invite_redeem_return_ambiguity_fix',
  'Fixes ambiguous ledger_id/role return-column references in redeem_ledger_invite so login invite auto-redemption and signed-in dashboard redemption work without requiring a second paste.'
)
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();


-- Migration 030: Add onboarding abuse monitoring and rate-limit foundation for private workspace/invite flows.
-- This keeps public signup disabled and adds server-side throttles before broader private-beta testing.

create table if not exists public.ledger_onboarding_rate_limits (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  actor_email text not null,
  ledger_id text,
  scope_key text not null default '',
  window_started_at timestamptz not null default now(),
  attempts integer not null default 1 check (attempts > 0),
  last_attempt_at timestamptz not null default now(),
  unique (action, actor_email, scope_key, window_started_at)
);

create unique index if not exists ledger_onboarding_rate_limits_scope_key_window_idx
on public.ledger_onboarding_rate_limits (action, actor_email, scope_key, window_started_at);

create index if not exists ledger_onboarding_rate_limits_scope_key_idx
on public.ledger_onboarding_rate_limits (scope_key, action, window_started_at desc);

create index if not exists ledger_onboarding_rate_limits_actor_idx
on public.ledger_onboarding_rate_limits (actor_email, action, window_started_at desc);

create index if not exists ledger_onboarding_rate_limits_ledger_idx
on public.ledger_onboarding_rate_limits (ledger_id, action, window_started_at desc)
where ledger_id is not null;

alter table public.ledger_onboarding_rate_limits enable row level security;

revoke all on public.ledger_onboarding_rate_limits from public;
revoke all on public.ledger_onboarding_rate_limits from anon;
revoke all on public.ledger_onboarding_rate_limits from authenticated;
grant select on public.ledger_onboarding_rate_limits to authenticated;

drop policy if exists "Ledger admins can read onboarding rate limits" on public.ledger_onboarding_rate_limits;
create policy "Ledger admins can read onboarding rate limits"
  on public.ledger_onboarding_rate_limits
  for select
  to authenticated
  using (
    (ledger_id is not null and public.is_ledger_admin(ledger_id))
    or exists (
      select 1
      from public.ledger_members lm
      where lm.is_active = true
        and lm.role = 'admin'
        and lm.email is not null
        and lower(lm.email) = public.current_user_email()
    )
  );

create or replace function public.enforce_onboarding_rate_limit(
  limit_action text,
  target_ledger_id text default null,
  max_attempts integer default 10,
  window_minutes integer default 60
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_actor_email text := public.current_user_email();
  safe_action text := nullif(btrim(coalesce(limit_action, '')), '');
  safe_scope_key text := coalesce(nullif(btrim(coalesce(target_ledger_id, '')), ''), '__global__');
  safe_window_minutes integer := greatest(coalesce(window_minutes, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_actor_email is null or btrim(safe_actor_email) = '' then
    raise exception 'A signed-in user email is required for onboarding actions.' using errcode = '42501';
  end if;
  if safe_action is null then
    raise exception 'A rate-limit action name is required.' using errcode = 'P0001';
  end if;

  window_start := date_trunc('minute', now()) - ((extract(minute from now())::integer % safe_window_minutes) * interval '1 minute');

  insert into public.ledger_onboarding_rate_limits (
    action,
    actor_email,
    ledger_id,
    scope_key,
    window_started_at,
    attempts,
    last_attempt_at
  ) values (
    safe_action,
    lower(safe_actor_email),
    nullif(btrim(coalesce(target_ledger_id, '')), ''),
    safe_scope_key,
    window_start,
    1,
    now()
  )
  on conflict (action, actor_email, scope_key, window_started_at)
  do update set attempts = public.ledger_onboarding_rate_limits.attempts + 1,
                last_attempt_at = now()
  returning attempts into current_attempts;

  if current_attempts > greatest(coalesce(max_attempts, 10), 1) then
    raise exception 'Too many onboarding attempts. Try again later.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from public;
revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from anon;
grant execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) to authenticated;

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

  return query
  select new_ledger_id, normalized_slug, nullif(btrim(workspace_name), ''), new_member_id;
exception
  when unique_violation then
    raise exception 'Workspace slug is already in use.' using errcode = '23505';
end;
$$;

create or replace function public.create_ledger_invite(
  target_ledger_id text default 'main-car',
  invite_role text default 'member',
  invite_email text default null,
  expires_in_hours integer default 168,
  max_uses integer default 1
)
returns table (
  invite_id uuid,
  invite_code text,
  ledger_id text,
  role text,
  invited_email text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  generated_code text;
  normalized_role text := case when invite_role = 'admin' then 'admin' else 'member' end;
  normalized_email text := nullif(lower(btrim(coalesce(invite_email, ''))), '');
  safe_max_uses integer := greatest(coalesce(max_uses, 1), 1);
  safe_expires_at timestamptz := case
    when expires_in_hours is null or expires_in_hours <= 0 then now() + interval '7 days'
    else now() + make_interval(hours => least(expires_in_hours, 24 * 30))
  end;
begin
  perform public.enforce_onboarding_rate_limit('create_ledger_invite', target_ledger_id, 20, 60);

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can create invites' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not linked to this ledger' using errcode = '42501';
  end if;

  generated_code := 'fl-' || lower(encode(extensions.gen_random_bytes(16), 'hex'));

  insert into public.ledger_invites (
    ledger_id,
    invite_code_hash,
    role,
    invited_email,
    max_uses,
    uses_count,
    expires_at,
    created_by_member_id
  ) values (
    target_ledger_id,
    public.hash_ledger_invite_code(generated_code),
    normalized_role,
    normalized_email,
    safe_max_uses,
    0,
    safe_expires_at,
    actor_member_id
  ) returning id into invite_id;

  return query
  select invite_id, generated_code, target_ledger_id, normalized_role, normalized_email, safe_expires_at;
end;
$$;

create or replace function public.redeem_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  member_id uuid,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  select * into invite_row
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1
  for update;

  if invite_row.id is null then
    raise exception 'Invite is invalid, expired, revoked, or already used.' using errcode = 'P0001';
  end if;

  if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
    raise exception 'This invite is for a different email address.' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = invite_row.ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else invite_row.role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = invite_row.ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (
      ledger_id,
      name,
      email,
      role,
      is_active
    ) values (
      invite_row.ledger_id,
      base_name,
      current_email,
      invite_row.role,
      true
    ) returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  update public.ledger_invites
  set uses_count = uses_count + 1,
      updated_at = now()
  where id = invite_row.id;

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('apply_payment_status_action'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('030_onboarding_abuse_rate_limits', 'Adds server-side onboarding abuse monitoring and throttles for private workspace creation, invite creation, and invite redemption.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();
-- Migration 031: Backend-owned payment status action RPC.
-- Moves the settlement payment request/paid/reopen action into one database
-- transaction that saves the normalized payment status, prunes stale settlement
-- rows, and emits a lightweight ledger event for realtime/admin diagnostics.

create or replace function public.apply_payment_status_action(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  previous_status text,
  next_status text,
  audit_summary text,
  audit_detail text,
  audit_metadata jsonb default '{}'::jsonb,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  safe_actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  saved_request_id uuid;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_previous text := coalesce(nullif(previous_status, ''), 'open');
  normalized_next text := coalesce(nullif(next_status, ''), 'open');
  event_type_value text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can update payment status' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or recipient_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23514';
  end if;

  if payer_member_id = recipient_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(payer_member_id, target_ledger_id)
    or not public.member_belongs_to_ledger(recipient_member_id, target_ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Settlement request amount must be zero or greater' using errcode = '23514';
  end if;

  if normalized_next not in ('open', 'requested', 'paid', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  if not public.is_valid_payment_status_transition(normalized_previous, normalized_next) then
    raise exception 'Invalid settlement request status transition from % to %', normalized_previous, normalized_next using errcode = '23514';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    if normalized_next = 'requested' and actor_member_id is distinct from recipient_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    if normalized_next = 'paid' and actor_member_id is distinct from payer_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;
  end if;

  if normalized_next = 'requested' then
    requested_at_value := now();
    requested_by_value := actor_member_id;
    event_type_value := 'payment_requested';
  elsif normalized_next = 'paid' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
    paid_at_value := now();
    event_type_value := 'payment_marked_paid';
  else
    event_type_value := 'payment_reopened';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':payment-action:' || target_open_period_id::text));

  insert into public.settlement_requests (
    ledger_id,
    period_id,
    from_member_id,
    to_member_id,
    amount,
    currency,
    status,
    requested_at,
    requested_by_member_id,
    paid_at,
    updated_at
  ) values (
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    recipient_member_id,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    normalized_next,
    requested_at_value,
    requested_by_value,
    paid_at_value,
    now()
  )
  on conflict (period_id, from_member_id, to_member_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    requested_at = excluded.requested_at,
    requested_by_member_id = excluded.requested_by_member_id,
    paid_at = excluded.paid_at,
    updated_at = now()
  returning id into saved_request_id;

  update public.settlement_requests sr
     set status = 'cancelled',
         updated_at = now(),
         requested_at = null,
         requested_by_member_id = null,
         paid_at = null
   where sr.ledger_id = target_ledger_id
     and sr.period_id = target_open_period_id
     and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(coalesce(current_pair_keys, array[]::text[])))
     and sr.status <> 'cancelled';
  get diagnostics cancelled_count = row_count;

  insert into public.ledger_events (
    ledger_id,
    event_type,
    title,
    body,
    actor_member_id,
    actor_email,
    target_member_id,
    metadata
  ) values (
    target_ledger_id,
    event_type_value,
    coalesce(nullif(audit_summary, ''), 'Payment status updated'),
    coalesce(nullif(audit_detail, ''), 'Payment status was updated by the backend action RPC.'),
    actor_member_id,
    nullif(safe_actor_email, ''),
    case when normalized_next = 'requested' then payer_member_id else recipient_member_id end,
    coalesce(audit_metadata, '{}'::jsonb) || jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'previous_status', normalized_previous,
      'next_status', normalized_next,
      'backend_action', 'apply_payment_status_action'
    )
  );

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'previous_status', normalized_previous,
    'status', normalized_next,
    'event_type', event_type_value,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from public;
revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from anon;
grant execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('031_payment_status_action_rpc', 'Backend-owned payment status action RPC writes settlement status and ledger event in one transaction.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();

-- Migration 032: Security Health current migration expectations.
-- Keeps fuel_ledger_healthcheck aligned with the migrations currently shipped in
-- this repo, so Security Health reports 031/032 as expected instead of showing
-- newer applied migrations as confusing "extra" tracked migrations.

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('032_security_health_current_migration_expectations', 'Refreshes Security Health migration expectations and critical RPC coverage through migration 032.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();



-- Migration 034: Fix invite rate-limit actor_email ambiguity.
-- The onboarding rate-limit RPC used a local variable named actor_email, which
-- can collide with the ledger_onboarding_rate_limits.actor_email column during
-- invite creation. Use a safely named local variable and keep Security Health's
-- migration expectation current.

create or replace function public.enforce_onboarding_rate_limit(
  limit_action text,
  target_ledger_id text default null,
  max_attempts integer default 10,
  window_minutes integer default 60
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_actor_email text := public.current_user_email();
  safe_action text := nullif(btrim(coalesce(limit_action, '')), '');
  safe_scope_key text := coalesce(nullif(btrim(coalesce(target_ledger_id, '')), ''), '__global__');
  safe_window_minutes integer := greatest(coalesce(window_minutes, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_actor_email is null or btrim(safe_actor_email) = '' then
    raise exception 'A signed-in user email is required for onboarding actions.' using errcode = '42501';
  end if;
  if safe_action is null then
    raise exception 'A rate-limit action name is required.' using errcode = 'P0001';
  end if;

  window_start := date_trunc('minute', now()) - ((extract(minute from now())::integer % safe_window_minutes) * interval '1 minute');

  insert into public.ledger_onboarding_rate_limits (
    action,
    actor_email,
    ledger_id,
    scope_key,
    window_started_at,
    attempts,
    last_attempt_at
  ) values (
    safe_action,
    lower(safe_actor_email),
    nullif(btrim(coalesce(target_ledger_id, '')), ''),
    safe_scope_key,
    window_start,
    1,
    now()
  )
  on conflict (action, actor_email, scope_key, window_started_at)
  do update set attempts = public.ledger_onboarding_rate_limits.attempts + 1,
                last_attempt_at = now()
  returning attempts into current_attempts;

  if current_attempts > greatest(coalesce(max_attempts, 10), 1) then
    raise exception 'Too many onboarding attempts. Try again later.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from public;
revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from anon;
grant execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('034_invite_rate_limit_actor_email_ambiguity_fix', 'Renames the onboarding rate-limit RPC local actor email variable to avoid actor_email column ambiguity during invite creation and updates Security Health expectations through migration 034.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();

-- Migration 035: SQL ambiguity guardrail fixes.
-- Replaces remaining PL/pgSQL local variables that reused high-risk table
-- column names, then updates Security Health expectations through 035.

-- Migration 031: Backend-owned payment status action RPC.
-- Moves the settlement payment request/paid/reopen action into one database
-- transaction that saves the normalized payment status, prunes stale settlement
-- rows, and emits a lightweight ledger event for realtime/admin diagnostics.

create or replace function public.apply_payment_status_action(
  target_ledger_id text,
  target_open_period_id uuid,
  payer_member_id uuid,
  recipient_member_id uuid,
  amount_value numeric,
  currency_value text,
  previous_status text,
  next_status text,
  audit_summary text,
  audit_detail text,
  audit_metadata jsonb default '{}'::jsonb,
  current_pair_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  safe_actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  saved_request_id uuid;
  requested_at_value timestamptz := null;
  requested_by_value uuid := null;
  paid_at_value timestamptz := null;
  cancelled_count integer := 0;
  normalized_previous text := coalesce(nullif(previous_status, ''), 'open');
  normalized_next text := coalesce(nullif(next_status, ''), 'open');
  event_type_value text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can update payment status' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or recipient_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23514';
  end if;

  if payer_member_id = recipient_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(payer_member_id, target_ledger_id)
    or not public.member_belongs_to_ledger(recipient_member_id, target_ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Settlement request amount must be zero or greater' using errcode = '23514';
  end if;

  if normalized_next not in ('open', 'requested', 'paid', 'cancelled') then
    raise exception 'Invalid settlement request status' using errcode = '23514';
  end if;

  if not public.is_valid_payment_status_transition(normalized_previous, normalized_next) then
    raise exception 'Invalid settlement request status transition from % to %', normalized_previous, normalized_next using errcode = '23514';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    if normalized_next = 'requested' and actor_member_id is distinct from recipient_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    if normalized_next = 'paid' and actor_member_id is distinct from payer_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;
  end if;

  if normalized_next = 'requested' then
    requested_at_value := now();
    requested_by_value := actor_member_id;
    event_type_value := 'payment_requested';
  elsif normalized_next = 'paid' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
    paid_at_value := now();
    event_type_value := 'payment_marked_paid';
  else
    event_type_value := 'payment_reopened';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':payment-action:' || target_open_period_id::text));

  insert into public.settlement_requests (
    ledger_id,
    period_id,
    from_member_id,
    to_member_id,
    amount,
    currency,
    status,
    requested_at,
    requested_by_member_id,
    paid_at,
    updated_at
  ) values (
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    recipient_member_id,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    normalized_next,
    requested_at_value,
    requested_by_value,
    paid_at_value,
    now()
  )
  on conflict (period_id, from_member_id, to_member_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    status = excluded.status,
    requested_at = excluded.requested_at,
    requested_by_member_id = excluded.requested_by_member_id,
    paid_at = excluded.paid_at,
    updated_at = now()
  returning id into saved_request_id;

  update public.settlement_requests sr
     set status = 'cancelled',
         updated_at = now(),
         requested_at = null,
         requested_by_member_id = null,
         paid_at = null
   where sr.ledger_id = target_ledger_id
     and sr.period_id = target_open_period_id
     and not ((sr.from_member_id::text || '->' || sr.to_member_id::text) = any(coalesce(current_pair_keys, array[]::text[])))
     and sr.status <> 'cancelled';
  get diagnostics cancelled_count = row_count;

  insert into public.ledger_events (
    ledger_id,
    event_type,
    title,
    body,
    actor_member_id,
    actor_email,
    target_member_id,
    metadata
  ) values (
    target_ledger_id,
    event_type_value,
    coalesce(nullif(audit_summary, ''), 'Payment status updated'),
    coalesce(nullif(audit_detail, ''), 'Payment status was updated by the backend action RPC.'),
    actor_member_id,
    nullif(safe_actor_email, ''),
    case when normalized_next = 'requested' then payer_member_id else recipient_member_id end,
    coalesce(audit_metadata, '{}'::jsonb) || jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'previous_status', normalized_previous,
      'next_status', normalized_next,
      'backend_action', 'apply_payment_status_action'
    )
  );

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'previous_status', normalized_previous,
    'status', normalized_next,
    'event_type', event_type_value,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from public;
revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from anon;
grant execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix'),
      ('035_sql_ambiguity_guardrail')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;


insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('035_sql_ambiguity_guardrail', 'Renames remaining high-risk PL/pgSQL local variables that reused table column names and updates Security Health expectations through migration 035.')
on conflict (migration_id) do update set
  description = excluded.description,
  applied_at = now();


-- Migration 036: Add invite onboarding profile setup RPC and Security Health expectation.
-- Lets invited members safely update their own display name and optional MobilePay phone after joining.

create or replace function public.update_own_ledger_member_profile(
  target_ledger_id text default 'main-car',
  member_name text default null,
  member_mobilepay_phone text default null
)
returns table (
  member_id uuid,
  ledger_id text,
  name text,
  email text,
  role text,
  mobilepay_phone text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_actor_email text := public.current_user_email();
  safe_member_id uuid;
  safe_name text := nullif(btrim(coalesce(member_name, '')), '');
  safe_phone text := nullif(btrim(coalesce(member_mobilepay_phone, '')), '');
  saved_member public.ledger_members%rowtype;
begin
  if safe_actor_email is null or btrim(safe_actor_email) = '' then
    raise exception 'A signed-in user email is required to update a member profile.' using errcode = '42501';
  end if;

  if safe_name is null then
    raise exception 'Display name is required.' using errcode = 'P0001';
  end if;

  if length(safe_name) > 80 then
    raise exception 'Display name is too long.' using errcode = '22001';
  end if;

  safe_member_id := public.current_ledger_member_id(target_ledger_id);
  if safe_member_id is null then
    raise exception 'Current user is not an active member of this workspace.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
      and lower(lm.name) = lower(safe_name)
      and lm.id <> safe_member_id
  ) then
    raise exception 'Another active member in this workspace already uses that display name.' using errcode = '23505';
  end if;

  update public.ledger_members lm
  set name = safe_name,
      mobilepay_phone = safe_phone,
      updated_at = now()
  where lm.id = safe_member_id
    and lm.ledger_id = target_ledger_id
  returning lm.* into saved_member;

  if saved_member.id is null then
    raise exception 'Member profile could not be updated.' using errcode = 'P0001';
  end if;

  update_own_ledger_member_profile.member_id := saved_member.id;
  update_own_ledger_member_profile.ledger_id := saved_member.ledger_id;
  update_own_ledger_member_profile.name := saved_member.name;
  update_own_ledger_member_profile.email := saved_member.email;
  update_own_ledger_member_profile.role := saved_member.role;
  update_own_ledger_member_profile.mobilepay_phone := saved_member.mobilepay_phone;
  return next;
end;
$$;

revoke all on function public.update_own_ledger_member_profile(text, text, text) from public;
revoke all on function public.update_own_ledger_member_profile(text, text, text) from anon;
grant execute on function public.update_own_ledger_member_profile(text, text, text) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('update_own_ledger_member_profile'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix'),
      ('035_sql_ambiguity_guardrail'),
      ('036_invite_profile_setup'),
      ('037_invite_email_preflight'),
      ('038_vehicle_settings_columns')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;



insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('037_invite_email_preflight', 'Adds restricted invite email preflight RPCs.'),
       ('038_vehicle_settings_columns', 'Stores sanitized vehicle settings on normalized ledger rows.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();


-- Migration 037: Invite email preflight guard
-- Blocks restricted invite links from sending login codes to the wrong email before account/session creation continues.

create or replace function public.check_ledger_invite_email(
  invite_code text,
  login_email text
)
returns table (
  allowed boolean,
  result_code text,
  message text,
  restricted boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_login_email text := lower(btrim(coalesce(login_email, '')));
  matched_invite public.ledger_invites%rowtype;
begin
  if btrim(coalesce(invite_code, '')) = '' then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_CODE_MISSING';
    check_ledger_invite_email.message := 'Enter a workspace invite code before requesting an email login code.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  if safe_login_email = '' then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_EMAIL_MISSING';
    check_ledger_invite_email.message := 'Enter the email address that should join this workspace before requesting a login code.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  select * into matched_invite
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1;

  if matched_invite.id is null then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_INVALID';
    check_ledger_invite_email.message := 'Invite code is invalid, expired, revoked, or already used. Ask the workspace admin for a fresh invite.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  if matched_invite.invited_email is not null and lower(matched_invite.invited_email) <> safe_login_email then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_EMAIL_MISMATCH';
    check_ledger_invite_email.message := 'This invite is restricted to a different email address. Enter the email address the admin invited, or ask the admin for a new invite.';
    check_ledger_invite_email.restricted := true;
    return next;
    return;
  end if;

  check_ledger_invite_email.allowed := true;
  check_ledger_invite_email.result_code := case when matched_invite.invited_email is null then 'INVITE_EMAIL_ALLOWED_OPEN' else 'INVITE_EMAIL_ALLOWED_RESTRICTED' end;
  check_ledger_invite_email.message := case when matched_invite.invited_email is null then 'Invite can be redeemed by this email after login verification.' else 'Restricted invite email matches. Continue with the email login code.' end;
  check_ledger_invite_email.restricted := matched_invite.invited_email is not null;
  return next;
end;
$$;

revoke all on function public.check_ledger_invite_email(text, text) from public;
grant execute on function public.check_ledger_invite_email(text, text) to anon;
grant execute on function public.check_ledger_invite_email(text, text) to authenticated;



-- Previous migration marker retained for consolidated-schema validation: 036_invite_profile_setup


-- Consolidated latest healthcheck after migration 037
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('update_own_ledger_member_profile'),
      ('check_ledger_invite_email'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix'),
      ('035_sql_ambiguity_guardrail'),
      ('036_invite_profile_setup'),
      ('037_invite_email_preflight'),
      ('038_vehicle_settings_columns')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'check_ledger_invite_email'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;





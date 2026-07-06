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
  fuel_price_warn_low numeric(10,2) not null default 8.00,
  fuel_price_warn_high numeric(10,2) not null default 25.00,
  fuel_sanity_threshold_pct numeric(6,2) not null default 70,
  low_fuel_threshold_percent numeric(6,2) not null default 70,
  high_fuel_threshold_percent numeric(6,2) not null default 140,
  vehicle_plate text not null default '',
  vehicle_info jsonb not null default '{}'::jsonb,
  vehicle_lookup_source text not null default 'manual',
  vehicle_lookup_at timestamptz,
  settlement_mode text not null default 'monthly' check (settlement_mode in ('monthly', 'running')),
  bootstrap_locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ledgers
  add column if not exists fuel_tank_capacity_l numeric(8,2) not null default 55;

alter table public.ledgers
  add column if not exists bootstrap_locked_at timestamptz;

alter table public.ledgers
  add column if not exists fuel_price_warn_low numeric(10,2) not null default 8.00,
  add column if not exists fuel_price_warn_high numeric(10,2) not null default 25.00,
  add column if not exists fuel_sanity_threshold_pct numeric(6,2) not null default 70;

alter table public.ledgers
  add column if not exists vehicle_plate text not null default '',
  add column if not exists vehicle_info jsonb not null default '{}'::jsonb,
  add column if not exists vehicle_lookup_source text not null default 'manual',
  add column if not exists vehicle_lookup_at timestamptz;

alter table public.ledgers
  add column if not exists settlement_mode text not null default 'monthly';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ledgers_settlement_mode_check'
  ) then
    alter table public.ledgers
      add constraint ledgers_settlement_mode_check
      check (settlement_mode in ('monthly', 'running'));
  end if;
end$$;

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
  participant_member_ids uuid[],
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

  -- Activity feed event, on create only (GVM-84).
  if existing_trip.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'trip_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('trip_id', saved_trip_id)
    );
  end if;

  return jsonb_build_object(
    'trip_id', saved_trip_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_trip_id,
    'participant_count', coalesce(array_length(unique_participant_ids, 1), 0)
  );
end;
$$;

grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) to authenticated;


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
-- (Relocated ahead of fuel_ledger_healthcheck, whose LANGUAGE SQL body references
-- the tracker table and is therefore validated at creation time — a fresh install
-- replaying this file top-to-bottom broke here before the move. GV-175.)
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
  purpose_value text,
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

  -- Activity feed event, on create only (GVM-84).
  if existing_booking.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'booking_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', saved_booking_id)
    );
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

grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text) to authenticated;
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

  -- Invite-only onboarding: this RPC may only update existing members. New members
  -- join by redeeming a workspace invite (redeem_ledger_invite), which enforces
  -- consent, expiry, max-uses, and rate limits. Reject creating a brand-new member
  -- row (null target_member_id) for everyone, including the app owner.
  if target_member_id is null then
    raise exception 'New members join by redeeming a workspace invite; member management can only update existing members' using errcode = '42501';
  end if;

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

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':member-admin'));

  update public.ledger_members
  set name = trim(member_name),
      email = normalized_email,
      mobilepay_phone = nullif(trim(coalesce(member_mobilepay_phone, '')), ''),
      role = normalized_role,
      is_active = coalesce(member_is_active, true),
      updated_at = now()
  where id = target_member_id and ledger_id = target_ledger_id
  returning id into saved_member_id;

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
  full_tank_value boolean,
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

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;
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
  with ranked_members as (
    select
      l.id as ledger_id,
      l.slug,
      l.name,
      case when bool_or(lm.role = 'admin') then 'admin' else 'member' end as role,
      (array_agg(lm.id order by case when lm.role = 'admin' then 0 else 1 end, lm.created_at asc, lm.id asc))[1] as member_id,
      l.is_public_signup_enabled,
      l.invite_required,
      l.bootstrap_locked_at,
      l.created_at
    from public.ledgers l
    join public.ledger_members lm on lm.ledger_id = l.id
    where lm.is_active = true
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
    group by l.id, l.slug, l.name, l.is_public_signup_enabled, l.invite_required, l.bootstrap_locked_at, l.created_at
  )
  select
    ranked_members.ledger_id,
    ranked_members.slug,
    ranked_members.name,
    ranked_members.role,
    ranked_members.member_id,
    ranked_members.is_public_signup_enabled,
    ranked_members.invite_required,
    ranked_members.bootstrap_locked_at
  from ranked_members
  order by ranked_members.created_at asc, ranked_members.ledger_id asc;
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





insert into public.fuel_ledger_schema_migrations (migration_id, description) values ('039_list_my_ledgers_dedup', 'De-duplicate list_my_ledgers rows so the workspace selector shows one stable row per workspace.');


-- Consolidated append: 040_workspace_identity_hardening
-- Migration 040: Workspace identity hardening.
-- Collapse duplicate active member rows per signed-in email/workspace, keep the strongest role,
-- and add a database constraint so the workspace selector cannot be fed duplicate identities again.

with ranked_active_members as (
  select
    lm.id,
    row_number() over (
      partition by lm.ledger_id, lower(lm.email)
      order by
        case when lm.role = 'admin' then 0 else 1 end,
        lm.created_at asc nulls last,
        lm.id asc
    ) as keep_rank
  from public.ledger_members lm
  where lm.is_active = true
    and lm.email is not null
    and btrim(lm.email) <> ''
)
update public.ledger_members lm
set is_active = false,
    updated_at = now()
from ranked_active_members ranked
where lm.id = ranked.id
  and ranked.keep_rank > 1;

create unique index if not exists ledger_members_one_active_email_per_workspace_idx
  on public.ledger_members (ledger_id, lower(email))
  where is_active = true
    and email is not null
    and btrim(email) <> '';

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
  with ranked_members as (
    select
      l.id as ledger_id,
      l.slug,
      l.name,
      case when bool_or(lm.role = 'admin') then 'admin' else 'member' end as role,
      (array_agg(lm.id order by case when lm.role = 'admin' then 0 else 1 end, lm.created_at asc nulls last, lm.id asc))[1] as member_id,
      l.is_public_signup_enabled,
      l.invite_required,
      l.bootstrap_locked_at,
      l.created_at
    from public.ledgers l
    join public.ledger_members lm on lm.ledger_id = l.id
    where lm.is_active = true
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
    group by l.id, l.slug, l.name, l.is_public_signup_enabled, l.invite_required, l.bootstrap_locked_at, l.created_at
  )
  select
    ranked_members.ledger_id,
    ranked_members.slug,
    ranked_members.name,
    ranked_members.role,
    ranked_members.member_id,
    ranked_members.is_public_signup_enabled,
    ranked_members.invite_required,
    ranked_members.bootstrap_locked_at
  from ranked_members
  order by ranked_members.created_at asc, ranked_members.ledger_id asc;
$$;

revoke all on function public.list_my_ledgers() from public;
revoke all on function public.list_my_ledgers() from anon;
revoke all on function public.list_my_ledgers() from authenticated;
grant execute on function public.list_my_ledgers() to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('040_workspace_identity_hardening', 'Collapse duplicate active workspace memberships and enforce one active email membership per workspace.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Consolidated schema addition: 041_owner_activity_log
-- ledger_id is nullable here, reflecting migration 048 (NULL = console-level /
-- cross-workspace owner action). The 041 migration created it NOT NULL; the
-- consolidated schema is a fresh-DB recreate, so it is created already-nullable.
create table if not exists public.owner_activity_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ledger_id text references public.ledgers(id) on delete cascade,
  workspace_label text not null default '',
  actor_user_id uuid,
  actor_email text,
  actor_member_id uuid references public.ledger_members(id) on delete set null,
  actor_role text not null default 'member' check (actor_role in ('member', 'admin', 'owner', 'system')),
  route text not null default '',
  action text not null default '',
  result_code text not null default '',
  status_code integer not null default 200,
  duration_ms integer,
  ok boolean not null default true,
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb
);
comment on column public.owner_activity_log.ledger_id is
  'Workspace this action concerned, or NULL for console-level / cross-workspace owner actions (e.g. listing all workspaces).';
create index if not exists owner_activity_log_created_at_idx on public.owner_activity_log (created_at desc);
create index if not exists owner_activity_log_ledger_created_at_idx on public.owner_activity_log (ledger_id, created_at desc);
create index if not exists owner_activity_log_actor_email_created_at_idx on public.owner_activity_log (lower(actor_email), created_at desc) where actor_email is not null;
create index if not exists owner_activity_log_action_created_at_idx on public.owner_activity_log (action, created_at desc);
create index if not exists owner_activity_log_ok_created_at_idx on public.owner_activity_log (ok, created_at desc);
alter table public.owner_activity_log enable row level security;
revoke all on public.owner_activity_log from public;
revoke all on public.owner_activity_log from anon;
revoke all on public.owner_activity_log from authenticated;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('041_owner_activity_log', 'Server-owned owner-only cross-workspace activity log for Render backend actions.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Consolidated schema addition: 048_owner_activity_log_nullable_ledger
-- The nullable ledger_id is already baked into the create table above; this seed
-- records the migration so schema tracking stays aligned with supabase/migrations/.
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('048_owner_activity_log_nullable_ledger', 'Make owner_activity_log.ledger_id nullable so cross-workspace owner-console reads (workspace/errors lists) can be audited (GV-148).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Consolidated schema addition: 042_member_invite_only_creation_lockdown
-- upsert_ledger_member_admin (defined above) now rejects creating brand-new
-- members; the only onboarding path is redeem_ledger_invite. This seed records the
-- migration so schema tracking stays aligned with supabase/migrations/.
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('042_member_invite_only_creation_lockdown', 'upsert_ledger_member_admin updates existing members only; new members must redeem a workspace invite.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Migration 043: car maintenance, repair history & insurance (GVM-11).
alter table public.ledgers
  add column if not exists next_service_date date,
  add column if not exists next_service_km integer,
  add column if not exists insurance_provider text,
  add column if not exists insurance_policy_no text,
  add column if not exists insurance_renewal date;
create table if not exists public.vehicle_repairs (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  repair_date date not null,
  description text not null,
  cost_dkk numeric(12, 2) not null default 0,
  odo_km integer,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists vehicle_repairs_ledger_date_idx on public.vehicle_repairs (ledger_id, repair_date desc) where deleted_at is null;
alter table public.vehicle_repairs enable row level security;
create policy "Ledger members can read repairs" on public.vehicle_repairs for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Creators and admins can insert repairs" on public.vehicle_repairs for insert to authenticated with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Creators and admins can update repairs" on public.vehicle_repairs for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or created_by_member_id = public.current_ledger_member_id(ledger_id)));
create policy "Admins can delete repairs" on public.vehicle_repairs for delete to authenticated using (public.is_ledger_admin(ledger_id));
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('043_car_maintenance_repairs_insurance', 'Add maintenance + insurance fields to ledgers and a vehicle_repairs table (GVM-11).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Migration 044: in-app messages / chat (GVM-12).
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  sender_member_id uuid not null references public.ledger_members(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists messages_ledger_created_idx on public.messages (ledger_id, created_at desc) where deleted_at is null;
alter table public.messages enable row level security;
create policy "Ledger members can read messages" on public.messages for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Members can send messages" on public.messages for insert to authenticated with check (public.is_ledger_member(ledger_id) and sender_member_id = public.current_ledger_member_id(ledger_id));
create policy "Senders and admins can update messages" on public.messages for update to authenticated using (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or sender_member_id = public.current_ledger_member_id(ledger_id))) with check (public.is_ledger_member(ledger_id) and (public.is_ledger_admin(ledger_id) or sender_member_id = public.current_ledger_member_id(ledger_id)));
create table if not exists public.message_read_state (
  ledger_id text not null references public.ledgers(id) on delete cascade,
  member_id uuid not null references public.ledger_members(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (ledger_id, member_id)
);
alter table public.message_read_state enable row level security;
create policy "Members read own read-state" on public.message_read_state for select to authenticated using (public.is_ledger_member(ledger_id) and member_id = public.current_ledger_member_id(ledger_id));
create policy "Members upsert own read-state" on public.message_read_state for insert to authenticated with check (public.is_ledger_member(ledger_id) and member_id = public.current_ledger_member_id(ledger_id));
create policy "Members update own read-state" on public.message_read_state for update to authenticated using (public.is_ledger_member(ledger_id) and member_id = public.current_ledger_member_id(ledger_id)) with check (public.is_ledger_member(ledger_id) and member_id = public.current_ledger_member_id(ledger_id));
do $$ begin if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then execute 'alter publication supabase_realtime add table public.messages'; end if; end if; end $$;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('044_messages_chat', 'Add messages + message_read_state tables with member-scoped RLS and realtime (GVM-12).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Migration 045: stable per-workspace join code + join-by-code resolution (GVM-17).
alter table public.ledgers add column if not exists join_code text;
alter table public.ledgers add column if not exists join_code_rotated_at timestamptz;
create unique index if not exists ledgers_join_code_unique_idx on public.ledgers (join_code) where join_code is not null;
create or replace function public.generate_workspace_join_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  code_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  rand_bytes bytea; candidate text; tries integer := 0;
begin
  loop
    tries := tries + 1;
    rand_bytes := extensions.gen_random_bytes(4);
    candidate := 'GV-'
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 0) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 1) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 2) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 3) % 32), 1);
    exit when not exists (select 1 from public.ledgers where join_code = candidate);
    if tries >= 20 then raise exception 'Could not generate a unique join code; please try again.' using errcode = 'P0001'; end if;
  end loop;
  return candidate;
end; $$;
create or replace function public.get_workspace_join_code(target_ledger_id text default 'main-car')
returns text language plpgsql security definer set search_path = public as $$
declare existing_code text;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can view the workspace join code' using errcode = '42501';
  end if;
  select join_code into existing_code from public.ledgers where id = target_ledger_id;
  if existing_code is null then
    existing_code := public.generate_workspace_join_code();
    update public.ledgers set join_code = existing_code, join_code_rotated_at = now(), updated_at = now() where id = target_ledger_id;
  end if;
  return existing_code;
end; $$;
create or replace function public.rotate_workspace_join_code(target_ledger_id text default 'main-car')
returns text language plpgsql security definer set search_path = public as $$
declare new_code text;
begin
  perform public.enforce_onboarding_rate_limit('rotate_workspace_join_code', target_ledger_id, 10, 60);
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can rotate the workspace join code' using errcode = '42501';
  end if;
  new_code := public.generate_workspace_join_code();
  update public.ledgers set join_code = new_code, join_code_rotated_at = now(), updated_at = now() where id = target_ledger_id;
  return new_code;
end; $$;
create or replace function public.resolve_ledger_invite(invite_code text)
returns table (ledger_id text, ledger_name text, member_count integer, owner_name text, role text)
language plpgsql stable security definer set search_path = public as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  matched_ledger_id text; matched_role text := 'member';
  invite_row public.ledger_invites%rowtype;
begin
  perform public.enforce_onboarding_rate_limit('resolve_ledger_invite', null, 15, 60);
  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to look up an invite.' using errcode = 'P0001';
  end if;
  select id into matched_ledger_id from public.ledgers where join_code = normalized_code limit 1;
  if matched_ledger_id is null then
    select * into invite_row from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null and (li.expires_at is null or li.expires_at > now()) and li.uses_count < li.max_uses
    order by li.created_at asc limit 1;
    if invite_row.id is null then return; end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then return; end if;
    matched_ledger_id := invite_row.ledger_id; matched_role := invite_row.role;
  end if;
  return query select l.id, l.name,
    (select count(*)::integer from public.ledger_members m where m.ledger_id = l.id and m.is_active = true),
    (select o.name from public.ledger_members o where o.ledger_id = l.id and o.role = 'admin' and o.is_active = true order by o.created_at asc limit 1),
    matched_role
  from public.ledgers l where l.id = matched_ledger_id;
end; $$;
create or replace function public.redeem_ledger_invite(invite_code text)
returns table (ledger_id text, member_id uuid, role text)
language plpgsql security definer set search_path = public as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text; target_role text := 'member'; is_stable boolean := false;
  base_name text; saved_member_id uuid; redeemed_ledger_id text; redeemed_role text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);
  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;
  select id into target_ledger_id from public.ledgers where join_code = normalized_code limit 1;
  if target_ledger_id is not null then
    is_stable := true;
  else
    select * into invite_row from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null and (li.expires_at is null or li.expires_at > now()) and li.uses_count < li.max_uses
    order by li.created_at asc limit 1 for update;
    if invite_row.id is null then raise exception 'Invite is invalid, expired, revoked, or already used.' using errcode = 'P0001'; end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
      raise exception 'This invite is for a different email address.' using errcode = '42501';
    end if;
    target_ledger_id := invite_row.ledger_id; target_role := invite_row.role;
  end if;
  select * into existing_member from public.ledger_members lm
  where lm.ledger_id = target_ledger_id and lm.email is not null and lower(lm.email) = current_email limit 1;
  if existing_member.id is not null then
    update public.ledger_members set is_active = true,
      role = case when existing_member.role = 'admin' then 'admin' else target_role end, updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;
  if not is_stable then
    update public.ledger_invites set uses_count = uses_count + 1, updated_at = now() where id = invite_row.id;
  end if;
  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end; $$;
-- Restore the legacy fl- one-time invite generator (undoes an earlier draft that
-- emitted GV-XXXX one-time codes; no-op on a DB that only saw the final form).
create or replace function public.create_ledger_invite(
  target_ledger_id text default 'main-car',
  invite_role text default 'member',
  invite_email text default null,
  expires_in_hours integer default 168,
  max_uses integer default 1
)
returns table (invite_id uuid, invite_code text, ledger_id text, role text, invited_email text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  actor_member_id uuid; generated_code text;
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
  insert into public.ledger_invites (ledger_id, invite_code_hash, role, invited_email, max_uses, uses_count, expires_at, created_by_member_id)
  values (target_ledger_id, public.hash_ledger_invite_code(generated_code), normalized_role, normalized_email, safe_max_uses, 0, safe_expires_at, actor_member_id)
  returning id into invite_id;
  return query select invite_id, generated_code, target_ledger_id, normalized_role, normalized_email, safe_expires_at;
end; $$;
revoke all on function public.generate_workspace_join_code() from public;
revoke all on function public.generate_workspace_join_code() from anon;
revoke all on function public.generate_workspace_join_code() from authenticated;
revoke all on function public.get_workspace_join_code(text) from public;
revoke all on function public.get_workspace_join_code(text) from anon;
revoke all on function public.rotate_workspace_join_code(text) from public;
revoke all on function public.rotate_workspace_join_code(text) from anon;
revoke all on function public.resolve_ledger_invite(text) from public;
revoke all on function public.resolve_ledger_invite(text) from anon;
grant execute on function public.get_workspace_join_code(text) to authenticated;
grant execute on function public.rotate_workspace_join_code(text) to authenticated;
grant execute on function public.resolve_ledger_invite(text) to authenticated;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('045_invite_short_codes_and_resolve', 'Stable per-workspace GV-XXXX join code (get/rotate) plus resolve/redeem dual-path for join-by-code.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Migration 046: settlement safety rail — lock period after payment.
create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;
  if v_period_id is null then
    return false;
  end if;
  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid')
  );
end;
$$;

create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
begin
  if tg_table_name = 'trip_participants' then
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;
    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;
  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    v_guard := new.deleted_at is null;
  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    v_guard := old.deleted_at is null;
  else
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);
    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_settlement_entry_lock_trips on public.trips;
create trigger enforce_settlement_entry_lock_trips
before insert or update or delete on public.trips
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_fuel on public.fuel_payments;
create trigger enforce_settlement_entry_lock_fuel
before insert or update or delete on public.fuel_payments
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_participants on public.trip_participants;
create trigger enforce_settlement_entry_lock_participants
before insert or update or delete on public.trip_participants
for each row execute function public.enforce_settlement_entry_lock();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('046_settlement_safety_rails', 'Lock-after-payment safety rail: block edits/deletes of live trips, fuel logs, and participants while the open settlement period has a requested or paid payment (global, always-on; reopen the payment to edit).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('047_fuel_price_warning_thresholds', 'Add fuel_price_warn_low/high (DKK/L bounds) and fuel_sanity_threshold_pct (real-world consumption tolerance) to ledgers, with global defaults 8.00 / 25.00 / 70.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Migration 049: owner-API rate limiting (GV-156).
create table if not exists public.owner_api_rate_limits (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  action text not null default 'owner.api',
  window_started_at timestamptz not null,
  attempts integer not null default 1 check (attempts > 0),
  last_attempt_at timestamptz not null default now(),
  unique (actor_email, action, window_started_at)
);
comment on table public.owner_api_rate_limits is
  'Per-operator fixed-window request counts for the owner API (GV-156). Service-role only; rows are ephemeral throttle state, not an audit trail (see owner_activity_log for auditing).';
create index if not exists owner_api_rate_limits_actor_idx
  on public.owner_api_rate_limits (actor_email, action, window_started_at desc);
alter table public.owner_api_rate_limits enable row level security;
revoke all on public.owner_api_rate_limits from public;
revoke all on public.owner_api_rate_limits from anon;
revoke all on public.owner_api_rate_limits from authenticated;

create or replace function public.check_owner_rate_limit(
  actor_email text,
  limit_action text default 'owner.api',
  max_attempts integer default 60,
  window_seconds integer default 60
)
returns table (
  allowed boolean,
  attempts integer,
  limit_value integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_email text := nullif(lower(btrim(coalesce(actor_email, ''))), '');
  safe_action text := coalesce(nullif(btrim(coalesce(limit_action, '')), ''), 'owner.api');
  safe_max integer := greatest(coalesce(max_attempts, 60), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_email is null then
    raise exception 'actor_email is required for owner rate limiting' using errcode = 'P0001';
  end if;
  window_start := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);
  insert into public.owner_api_rate_limits (actor_email, action, window_started_at, attempts, last_attempt_at)
  values (safe_email, safe_action, window_start, 1, now())
  on conflict (actor_email, action, window_started_at)
  do update set attempts = public.owner_api_rate_limits.attempts + 1,
               last_attempt_at = now()
  returning public.owner_api_rate_limits.attempts into current_attempts;
  return query
  select
    current_attempts <= safe_max,
    current_attempts,
    safe_max,
    greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => safe_window) - now())))::integer);
end;
$$;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from public;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from authenticated;
grant execute on function public.check_owner_rate_limit(text, text, integer, integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('049_owner_api_rate_limit', 'Service-role-callable per-operator rate limiter for the owner API /api/owner/* (GV-156).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('050_settlement_mode', 'Add settlement_mode (monthly|running, default monthly) to ledgers — owner-chosen settlement cadence driving the monthly close nudge and Pay-screen layout.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('051_activity_events_for_trip_fuel_booking', 'Trip/fuel/booking upsert RPCs emit a ledger_events row on create (client-built event_title/event_body, actor_member_id stamped) so the unified Activity feed populates in production (GVM-84).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Consolidated schema addition: 052_activity_events_for_workspace_and_vehicle
-- Workspace-create emits a workspace_created event; a new update_ledger_vehicle
-- RPC becomes the vehicle write path and emits vehicle_added/vehicle_updated so
-- the operator audit trail (ledger_events) captures both (GVM-96).
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
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- Consolidated schema addition: 053_seed_open_period_on_workspace_create
-- create_private_ledger_workspace opens an initial settlement period so trips +
-- fuel can be logged immediately in a new workspace (GVM-97).
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

  insert into public.settlement_periods (ledger_id, status, label)
  values (new_ledger_id, 'open', 'Current period');

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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('053_seed_open_period_on_workspace_create', 'create_private_ledger_workspace opens an initial settlement period so trips/fuel can be logged in a new workspace; backfills an open period for any existing workspace missing one (GVM-97).')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

-- ═══ Migration 054 mirror: settlement integrity rails (GVM-112) ═══
-- Migration 054: server-side settlement integrity rails (GVM-112)
--
-- Until now the database enforced WHO may write but trusted every kroner figure
-- the client sent. Two trust boundaries are closed here, plus one race:
--
--   1. close_settlement_period archived the client-built snapshot verbatim. It
--      now recomputes the period's entry fingerprint (exact match — a pure
--      function of the live trip/fuel id sets, no float parity involved) and the
--      settlement itself (calculate_period_settlement below), rejecting a close
--      whose snapshot is stale or miscalculated with a "refresh and try again"
--      error instead of archiving wrong money.
--   2. upsert_settlement_request_status accepted any amount. A pair settlement
--      can never exceed the period's total fuel spend, so a 'requested'
--      transition is now bounded by that (plus 1 kr tolerance). Strict per-mode
--      equality is deliberately NOT enforced — monthly/running request shapes
--      (GVM-76) would false-reject.
--   3. upsert_trip_with_participants / upsert_fuel_payment checked "period is
--      open" without locking, so a write in flight during a close could land in
--      the just-closed period — invisible in the open view AND missing from the
--      archive. The check now takes FOR SHARE on the period row: the close's
--      UPDATE (exclusive row lock) serializes with writers, so either the write
--      commits first and the close's recompute sees it, or the close commits
--      first and the writer fails cleanly.
--
-- Tolerances: amounts are compared within 0.05 kr (totals / settlement flows)
-- and 0.02 kr (per-member figures). JS computes in float64 and rounds half
-- toward +infinity; Postgres numeric rounds half away from zero — bit-parity is
-- unattainable and unnecessary. Real staleness diverges by whole kroner; the
-- fingerprint catches pure entry-set drift exactly.

-- ── 1. Server-side settlement recompute ─────────────────────────────────────
-- Mirrors govehlo-mobile src/lib/settlement-calc.ts (pinned by its vitest suite,
-- GVM-104): live entries only, participants restricted to active members,
-- driver fallback when a trip has no valid participants, per-member km and
-- fuel-paid rounded to 2dp before totals, trip cost = rounded km x unrounded
-- rate. Returns { totalKm, totalPaid, fuelRate, people:[{id,name,km,fuelPaid,
-- tripCost,net}] }.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    -- Participants who are active members; when none remain, fall back to the
    -- driver (if active) — exactly settlement-calc.ts's assignee resolution.
    select lt.id as trip_id,
           lt.km,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  per_member as (
    select am.id,
           am.name,
           round(coalesce(k.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid
    from active_members am
    left join (
      select ks.member_id, sum(ks.share_km) as km_sum
      from km_shares ks
      group by ks.member_id
    ) k on k.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid - round(pm.km * (t.total_paid / t.total_km), 2), 2)
                    else round(pm.fuel_paid, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── 2. Fingerprint helper ───────────────────────────────────────────────────
-- Byte-exact reproduction of the client fingerprint (period-snapshot.ts →
-- periodEntryFingerprint / legacy period-closing-helpers.js): JSON of the live
-- trip ids then fuel ids, each sorted. UUID strings are lowercase hex, so
-- COLLATE "C" byte order equals JavaScript's default sort.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || ']}';
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── 3. close_settlement_period v2: validate before archiving ────────────────
-- Full re-declaration of migration 004's definition plus the integrity gate
-- (server fingerprint + amount validation) after the advisory lock, so the
-- recompute sees exactly the rows the close will archive.
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
  server_fingerprint text;
  computed jsonb;
  computed_person jsonb;
  snapshot_person jsonb;
  snapshot_flow numeric;
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

  -- ── Integrity gate (GVM-112) ──────────────────────────────────────────────
  -- (a) Entry set: the snapshot's fingerprint must equal the one recomputed
  -- from the live rows. In-flight writers hold FOR SHARE on the period row, so
  -- by the time this runs the row set is stable for the transaction.
  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  server_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, target_period_id);

  if snapshot_fingerprint is not null and snapshot_fingerprint <> server_fingerprint then
    raise exception 'Entries changed since this close was prepared. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  -- (b) Amounts: per-member figures within 0.02 kr, totals within 0.05 kr.
  computed := public.calculate_period_settlement(target_ledger_id, target_period_id);

  if abs(coalesce((period_snapshot->>'totalKm')::numeric, 0) - (computed->>'totalKm')::numeric) > 0.05
     or abs(coalesce((period_snapshot->>'totalPaid')::numeric, 0) - (computed->>'totalPaid')::numeric) > 0.05 then
    raise exception 'Snapshot totals do not match the server calculation. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  for computed_person in
    select value from jsonb_array_elements(computed->'people')
  loop
    select p.value
      into snapshot_person
      from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb)) as p(value)
      where p.value->>'id' = computed_person->>'id'
      limit 1;

    if abs(coalesce((snapshot_person->>'km')::numeric, 0) - (computed_person->>'km')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'fuelPaid')::numeric, 0) - (computed_person->>'fuelPaid')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'net')::numeric, 0) - (computed_person->>'net')::numeric) > 0.02 then
      raise exception 'Snapshot member amounts do not match the server calculation. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;

    -- (c) The archived settlements must actually move each member's net:
    -- outflow - inflow ~= -net for every member.
    select coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'fromId' = computed_person->>'id'), 0)
         - coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'toId' = computed_person->>'id'), 0)
      into snapshot_flow
      from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb)) as s(value);

    if abs(snapshot_flow + (computed_person->>'net')::numeric) > 0.05 then
      raise exception 'Snapshot settlements do not match the member balances. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;

  -- Snapshot-only members (left the ledger between fetch and close) must carry
  -- no money, otherwise the archive would hide a real balance.
  for snapshot_person in
    select value from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb))
  loop
    if not exists (
      select 1 from jsonb_array_elements(computed->'people') as c(value)
      where c.value->>'id' = snapshot_person->>'id'
    ) and abs(coalesce((snapshot_person->>'net')::numeric, 0)) > 0.02 then
      raise exception 'Snapshot includes a member the server no longer recognizes. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;
  -- ── End integrity gate ────────────────────────────────────────────────────

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

-- ── 4. upsert_trip_with_participants v2: FOR SHARE on the open period ───────
-- Verbatim re-declaration of migration 051's definition; only the period-open
-- check changed (see the comment inside).
create or replace function public.upsert_trip_with_participants(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_trip_id text,
  driver_member_id uuid,
  trip_date_value date,
  start_km_value numeric,
  end_km_value numeric,
  note_value text,
  participant_member_ids uuid[],
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
  locked_period_id uuid;
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

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
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
    legacy_id, ledger_id, period_id, driver_member_id, trip_date,
    start_km, end_km, note, created_by_member_id, deleted_at, updated_at
  ) values (
    legacy_trip_id, target_ledger_id, target_open_period_id, driver_member_id,
    trip_date_value, start_km_value, end_km_value, nullif(note_value, ''),
    actor_member_id, null, now()
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

  delete from public.trip_participants where trip_id = saved_trip_id;

  insert into public.trip_participants (trip_id, member_id)
  select saved_trip_id, member_id
  from unnest(unique_participant_ids) as member_id
  on conflict (trip_id, member_id) do nothing;

  -- Activity feed event, on create only (GVM-84).
  if existing_trip.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'trip_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('trip_id', saved_trip_id)
    );
  end if;

  return jsonb_build_object(
    'trip_id', saved_trip_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_trip_id,
    'participant_count', coalesce(array_length(unique_participant_ids, 1), 0)
  );
end;
$$;

grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) to authenticated;

-- ── 5. upsert_fuel_payment v2: FOR SHARE on the open period ─────────────────
-- Verbatim re-declaration of migration 051's definition; only the period-open
-- check changed.
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
  full_tank_value boolean,
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
  locked_period_id uuid;
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

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
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

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;

-- ── 6. upsert_settlement_request_status v2: bounded request amounts ─────────
-- Verbatim re-declaration of migration 022's definition plus the amount bound.
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

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('054_settlement_integrity_rails', 'Server-side settlement integrity: close_settlement_period validates the snapshot against a recomputed entry fingerprint + SQL settlement recompute; requested amounts bounded by the period''s fuel spend; trip/fuel inserts take FOR SHARE on the open period so writes serialize with closes (GVM-112).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ═══ Migration 055 mirror: integrity function gates (GVM-112) ═══
-- Migration 055: operator access + membership gate for the integrity functions (GVM-112)
--
-- Two gate corrections to migration 054's helpers, found during live verification:
--
--   1. calculate_period_settlement required ledger membership unconditionally, so
--      the operator running the verification queries in the Supabase SQL Editor
--      (role postgres, no user JWT) was rejected. Diagnostics from the SQL Editor
--      or the service role are legitimate operator contexts.
--   2. calculate_period_entry_fingerprint shipped with NO membership gate at all:
--      any authenticated user could list another workspace's trip/fuel row ids.
--      It now enforces the same member-or-operator rule.
--
-- public.is_operator_context() is true only when the request carries no user JWT
-- (direct database access: SQL Editor, psql) or the service_role JWT. anon and
-- authenticated PostgREST requests always carry their role claim, so end users
-- can never satisfy it — they still need active membership.

create or replace function public.is_operator_context()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'role', '') in ('', 'service_role');
$$;

revoke all on function public.is_operator_context() from public;
revoke all on function public.is_operator_context() from anon;
grant execute on function public.is_operator_context() to authenticated;

-- ── calculate_period_settlement: allow operator context ─────────────────────
-- Verbatim re-declaration of migration 054's definition; only the gate changed.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    -- Participants who are active members; when none remain, fall back to the
    -- driver (if active) — exactly settlement-calc.ts's assignee resolution.
    select lt.id as trip_id,
           lt.km,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  per_member as (
    select am.id,
           am.name,
           round(coalesce(k.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid
    from active_members am
    left join (
      select ks.member_id, sum(ks.share_km) as km_sum
      from km_shares ks
      group by ks.member_id
    ) k on k.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid - round(pm.km * (t.total_paid / t.total_km), 2), 2)
                    else round(pm.fuel_paid, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── calculate_period_entry_fingerprint: add the missing gate ────────────────
-- Same computation as migration 054 (byte-exact vs period-snapshot.ts), now as
-- plpgsql so it can enforce member-or-operator before revealing row ids.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result text;
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || ']}'
  into result;

  return result;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('055_integrity_function_gates', 'is_operator_context() helper; calculate_period_settlement allows operator diagnostics (SQL Editor / service role); calculate_period_entry_fingerprint gains the membership gate it shipped without (GVM-112).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ═══ Schema-equivalence convergence (GV-175) ══════════════════════════════════
-- tools/check-schema-equivalence.mjs replays this file and the migrations into
-- disposable Postgres instances and diffs the results. This section re-declares,
-- VERBATIM from each function's latest migration, every definition where this
-- file's earlier text had drifted from the migrations' end state (reflowed
-- whitespace, an edited healthcheck expectation list, hash_ledger_invite_code's
-- volatility, the trips read policy, two missing comments). Last definition
-- wins on replay, so appending the authoritative text here converges the file
-- without rewriting history above. Semantic follow-ups (e.g. whether the trips
-- read policy SHOULD check is_active) belong in new migrations, not here.

-- Verbatim from 049_owner_api_rate_limit.sql:
create or replace function public.check_owner_rate_limit(
  actor_email text,
  limit_action text default 'owner.api',
  max_attempts integer default 60,
  window_seconds integer default 60
)
returns table (
  allowed boolean,
  attempts integer,
  limit_value integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_email text := nullif(lower(btrim(coalesce(actor_email, ''))), '');
  safe_action text := coalesce(nullif(btrim(coalesce(limit_action, '')), ''), 'owner.api');
  safe_max integer := greatest(coalesce(max_attempts, 60), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_email is null then
    raise exception 'actor_email is required for owner rate limiting' using errcode = 'P0001';
  end if;

  -- Fixed window aligned to safe_window-second boundaries from the epoch.
  window_start := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);

  insert into public.owner_api_rate_limits (actor_email, action, window_started_at, attempts, last_attempt_at)
  values (safe_email, safe_action, window_start, 1, now())
  on conflict (actor_email, action, window_started_at)
  do update set attempts = public.owner_api_rate_limits.attempts + 1,
               last_attempt_at = now()
  returning public.owner_api_rate_limits.attempts into current_attempts;

  return query
  select
    current_attempts <= safe_max,
    current_attempts,
    safe_max,
    greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => safe_window) - now())))::integer);
end;
$$;

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
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

-- Verbatim from 053_seed_open_period_on_workspace_create.sql:
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

-- Verbatim from 046_settlement_safety_rails.sql:
create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Verbatim from 037_invite_email_preflight.sql:
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
      ('037_invite_email_preflight')
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

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
create or replace function public.generate_workspace_join_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Crockford-ish base32 without easily-confused chars (no I, O, 0, 1).
  code_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  rand_bytes bytea;
  candidate text;
  tries integer := 0;
begin
  loop
    tries := tries + 1;
    rand_bytes := extensions.gen_random_bytes(4);
    candidate := 'GV-'
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 0) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 1) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 2) % 32), 1)
      || substr(code_alphabet, 1 + (get_byte(rand_bytes, 3) % 32), 1);
    exit when not exists (select 1 from public.ledgers where join_code = candidate);
    if tries >= 20 then
      raise exception 'Could not generate a unique join code; please try again.' using errcode = 'P0001';
    end if;
  end loop;
  return candidate;
end;
$$;

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
create or replace function public.get_workspace_join_code(target_ledger_id text default 'main-car')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_code text;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can view the workspace join code' using errcode = '42501';
  end if;

  select join_code into existing_code from public.ledgers where id = target_ledger_id;

  if existing_code is null then
    existing_code := public.generate_workspace_join_code();
    update public.ledgers
    set join_code = existing_code,
        join_code_rotated_at = now(),
        updated_at = now()
    where id = target_ledger_id;
  end if;

  return existing_code;
end;
$$;

-- Verbatim from 028_invite_code_hash_pgcrypto_fix.sql:
create or replace function public.hash_ledger_invite_code(invite_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(extensions.digest(coalesce(invite_code, ''), 'sha256'), 'hex');
$$;

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
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
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text;
  target_role text := 'member';
  is_stable boolean := false;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into target_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  if target_ledger_id is not null then
    is_stable := true;
  else
    -- Legacy one-time invite.
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

    target_ledger_id := invite_row.ledger_id;
    target_role := invite_row.role;
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else target_role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  -- Only one-time invites consume a use; the stable code is reusable.
  if not is_stable then
    update public.ledger_invites
    set uses_count = uses_count + 1,
        updated_at = now()
    where id = invite_row.id;
  end if;

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
create or replace function public.resolve_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  ledger_name text,
  member_count integer,
  owner_name text,
  role text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  matched_ledger_id text;
  matched_role text := 'member';
  invite_row public.ledger_invites%rowtype;
begin
  perform public.enforce_onboarding_rate_limit('resolve_ledger_invite', null, 15, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to look up an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into matched_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  -- Fall back to a legacy one-time invite.
  if matched_ledger_id is null then
    select * into invite_row
    from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null
      and (li.expires_at is null or li.expires_at > now())
      and li.uses_count < li.max_uses
    order by li.created_at asc
    limit 1;

    if invite_row.id is null then
      return; -- invalid / expired / used: reveal nothing
    end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
      return; -- pinned to a different email
    end if;

    matched_ledger_id := invite_row.ledger_id;
    matched_role := invite_row.role;
  end if;

  return query
  select
    l.id,
    l.name,
    (
      select count(*)::integer
      from public.ledger_members m
      where m.ledger_id = l.id and m.is_active = true
    ),
    (
      select o.name
      from public.ledger_members o
      where o.ledger_id = l.id and o.role = 'admin' and o.is_active = true
      order by o.created_at asc
      limit 1
    ),
    matched_role
  from public.ledgers l
  where l.id = matched_ledger_id;
end;
$$;

-- Verbatim from 045_invite_short_codes_and_resolve.sql:
create or replace function public.rotate_workspace_join_code(target_ledger_id text default 'main-car')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  new_code text;
begin
  perform public.enforce_onboarding_rate_limit('rotate_workspace_join_code', target_ledger_id, 10, 60);

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can rotate the workspace join code' using errcode = '42501';
  end if;

  new_code := public.generate_workspace_join_code();
  update public.ledgers
  set join_code = new_code,
      join_code_rotated_at = now(),
      updated_at = now()
  where id = target_ledger_id;

  return new_code;
end;
$$;

-- Verbatim from 046_settlement_safety_rails.sql:
create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;

  -- Entries created through the trip/fuel RPCs always carry the open period id.
  -- Fall back to the ledger's open period for any row that has none.
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;

  if v_period_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid')
  );
end;
$$;

-- Verbatim from 052_activity_events_for_workspace_and_vehicle.sql:
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

-- Verbatim from 005_rls_policies.sql (the version live in production — the base
-- section above declares a different, never-migrated is_ledger_member variant):
drop policy if exists "Ledger members can read trips" on public.trips;
create policy "Ledger members can read trips" on public.trips 
for select to authenticated 
using (
  EXISTS (
    SELECT 1 FROM public.ledger_members 
    WHERE public.ledger_members.ledger_id = trips.ledger_id 
    AND public.ledger_members.email = public.current_user_email() 
  )
);

-- Verbatim from 041_owner_activity_log.sql:
comment on table public.owner_activity_log is
  'Server-owned owner-only activity ledger for safe cross-user/cross-workspace backend support diagnostics.';

-- Verbatim from 041_owner_activity_log.sql:
comment on column public.owner_activity_log.metadata is
  'Small redacted JSON payload. Do not store provider secrets, auth tokens, cookies, VINs, or raw request bodies.';


-- ────────────────────────────────────────────────────────────────────
-- Migration 056: In-app account deletion (GVM-115)
-- Verbatim from 056_delete_my_account.sql (see that file for the full
-- design rationale: anonymize-and-scrub, admin succession, ledger cascade
-- for sole members, auth.users delete).
-- ────────────────────────────────────────────────────────────────────

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

    -- Fuel-stop user coordinates are the member's location history. Station
    -- coordinates describe a public place and stay (they price-check the entry).
    update public.fuel_payments fp
    set user_lat = null, user_lng = null, updated_at = now()
    where fp.ledger_id = v_member.ledger_id
      and (fp.payer_member_id = v_member.id or fp.created_by_member_id = v_member.id)
      and (fp.user_lat is not null or fp.user_lng is not null);

    -- Bookings: purposes are authored text; future bookings would block the car
    -- for a person who no longer exists.
    update public.car_bookings cb
    set purpose = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.purpose is not null;

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
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
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

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('056_delete_my_account', 'In-app account deletion: anonymize-and-scrub RPC + auth user delete (GVM-115)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ────────────────────────────────────────────────────────────────────
-- Migration 057: Expo push tokens + delivery claim column (GVM-62)
-- Verbatim from 057_expo_push_tokens.sql. Includes a full re-declaration
-- of delete_my_account (056 body + push-token purge) — last definition
-- wins on replay.
-- ────────────────────────────────────────────────────────────────────

create table if not exists public.expo_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email text not null,
  token text not null unique,
  platform text not null default 'unknown' check (platform in ('ios', 'android', 'unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expo_push_tokens_email_idx on public.expo_push_tokens (email);
create index if not exists expo_push_tokens_user_idx on public.expo_push_tokens (user_id);

alter table public.expo_push_tokens enable row level security;

drop policy if exists "Users manage own push tokens" on public.expo_push_tokens;
create policy "Users manage own push tokens" on public.expo_push_tokens
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Device registers (or re-points) its Expo push token after sign-in.
create or replace function public.upsert_push_token(
  token_value text,
  platform_value text default 'unknown'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := public.current_user_email();
  v_platform text := case when platform_value in ('ios', 'android') then platform_value else 'unknown' end;
begin
  if v_uid is null or v_email is null or v_email = '' then
    raise exception 'Push token registration requires a signed-in user' using errcode = '42501';
  end if;
  if token_value is null or btrim(token_value) = '' or length(token_value) > 4096 then
    raise exception 'Invalid push token' using errcode = '22023';
  end if;

  insert into public.expo_push_tokens (user_id, email, token, platform)
  values (v_uid, v_email, btrim(token_value), v_platform)
  on conflict (token) do update set
    user_id = excluded.user_id,
    email = excluded.email,
    platform = excluded.platform,
    updated_at = now();
end;
$$;

revoke all on function public.upsert_push_token(text, text) from public;
grant execute on function public.upsert_push_token(text, text) to authenticated;

-- Device unregisters its token (sign-out). Own tokens only.
create or replace function public.delete_push_token(token_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Push token removal requires a signed-in user' using errcode = '42501';
  end if;
  delete from public.expo_push_tokens ept
  where ept.token = btrim(coalesce(token_value, ''))
    and ept.user_id = v_uid;
end;
$$;

revoke all on function public.delete_push_token(text) from public;
grant execute on function public.delete_push_token(text) to authenticated;

-- The webhook sender's idempotency claim (see header).
alter table public.ledger_events add column if not exists push_sent_at timestamptz;

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

    -- Fuel-stop user coordinates are the member's location history. Station
    -- coordinates describe a public place and stay (they price-check the entry).
    update public.fuel_payments fp
    set user_lat = null, user_lng = null, updated_at = now()
    where fp.ledger_id = v_member.ledger_id
      and (fp.payer_member_id = v_member.id or fp.created_by_member_id = v_member.id)
      and (fp.user_lat is not null or fp.user_lng is not null);

    -- Bookings: purposes are authored text; future bookings would block the car
    -- for a person who no longer exists.
    update public.car_bookings cb
    set purpose = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.purpose is not null;

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
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
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
values ('057_expo_push_tokens', 'Expo push tokens table + RPCs, ledger_events.push_sent_at claim, delete_my_account purges tokens (GVM-62)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 058: resolve_ledger_invite must be VOLATILE, not STABLE (GVM-123)
create or replace function public.resolve_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  ledger_name text,
  member_count integer,
  owner_name text,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  matched_ledger_id text;
  matched_role text := 'member';
  invite_row public.ledger_invites%rowtype;
begin
  perform public.enforce_onboarding_rate_limit('resolve_ledger_invite', null, 15, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to look up an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into matched_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  -- Fall back to a legacy one-time invite.
  if matched_ledger_id is null then
    select * into invite_row
    from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null
      and (li.expires_at is null or li.expires_at > now())
      and li.uses_count < li.max_uses
    order by li.created_at asc
    limit 1;

    if invite_row.id is null then
      return; -- invalid / expired / used: reveal nothing
    end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
      return; -- pinned to a different email
    end if;

    matched_ledger_id := invite_row.ledger_id;
    matched_role := invite_row.role;
  end if;

  return query
  select
    l.id,
    l.name,
    (
      select count(*)::integer
      from public.ledger_members m
      where m.ledger_id = l.id and m.is_active = true
    ),
    (
      select o.name
      from public.ledger_members o
      where o.ledger_id = l.id and o.role = 'admin' and o.is_active = true
      order by o.created_at asc
      limit 1
    ),
    matched_role
  from public.ledgers l
  where l.id = matched_ledger_id;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('058_resolve_invite_volatile_fix', 'resolve_ledger_invite must be VOLATILE, not STABLE (GVM-123)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 059: emit a member_joined activity event on invite redemption (GVM-127)
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
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text;
  target_role text := 'member';
  is_stable boolean := false;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
  was_existing boolean := false;
  saved_member_name text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into target_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  if target_ledger_id is not null then
    is_stable := true;
  else
    -- Legacy one-time invite.
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

    target_ledger_id := invite_row.ledger_id;
    target_role := invite_row.role;
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    was_existing := true;
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else target_role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  -- Only one-time invites consume a use; the stable code is reusable.
  if not is_stable then
    update public.ledger_invites
    set uses_count = uses_count + 1,
        updated_at = now()
    where id = invite_row.id;
  end if;

  -- Activity / audit entry for the join (GVM-127). Actor = the joining member;
  -- the ledger_events INSERT webhook pushes "new activity" to the others.
  select lm.name into saved_member_name
  from public.ledger_members lm
  where lm.id = saved_member_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    redeemed_ledger_id,
    'member_joined',
    coalesce(saved_member_name, 'Et nyt medlem') || ' kom med i gruppen',
    case when was_existing then 'Kom med i gruppen igen' else 'Nyt medlem' end,
    saved_member_id,
    current_email,
    jsonb_build_object(
      'via', case when is_stable then 'join_code' else 'invite' end,
      'new_member', not was_existing
    )
  );

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('059_member_joined_event', 'emit a member_joined activity event on invite redemption (GVM-127)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 060: allow cancelling a reopened (open) settlement request (GV-182).
-- Recreates is_valid_payment_status_transition with one added edge (open ->
-- cancelled) so migration 054's stale-pair reconciliation can cancel a request
-- that was reopened (requested -> open) before the debt direction flipped. Last
-- definition wins on replay — this supersedes the migration 003 body above.
create or replace function public.is_valid_payment_status_transition(p_previous_status text, p_next_status text)
returns boolean
language sql
immutable
as $$
  select case coalesce(p_previous_status, 'open')
    when 'open' then coalesce(p_next_status, 'open') in ('open', 'requested', 'cancelled')
    when 'requested' then coalesce(p_next_status, 'open') in ('requested', 'paid', 'open', 'cancelled')
    when 'paid' then coalesce(p_next_status, 'open') in ('paid', 'open')
    when 'cancelled' then coalesce(p_next_status, 'open') in ('cancelled', 'requested', 'open')
    else false
  end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('060_allow_cancel_open_request', 'allow cancelling a reopened (open) settlement request so stale-pair reconciliation can cancel it (GV-182)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 061: redeem_ledger_invite honors the onboarding display name (GV-185).
-- Recreate redeem_ledger_invite with a new trailing, defaulted `display_name` param
-- so a user who typed a name in onboarding and JOINED by code is added under that
-- name instead of their email local-part. Drop the old 1-arg version first so the
-- new 2-arg (defaulted) signature does not coexist and make 1-arg calls ambiguous.
-- Falls back to split_part(email, '@', 1) when no display name is supplied. Last
-- definition wins on replay — this supersedes the migration 059 body above.
drop function if exists public.redeem_ledger_invite(text);

create or replace function public.redeem_ledger_invite(invite_code text, display_name text default null)
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
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text;
  target_role text := 'member';
  is_stable boolean := false;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
  was_existing boolean := false;
  saved_member_name text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into target_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  if target_ledger_id is not null then
    is_stable := true;
  else
    -- Legacy one-time invite.
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

    target_ledger_id := invite_row.ledger_id;
    target_role := invite_row.role;
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    was_existing := true;
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else target_role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    -- Prefer the name the user typed during onboarding; fall back to the email
    -- local-part when no display name was supplied (backward-compatible).
    if display_name is not null and btrim(display_name) <> '' then
      base_name := btrim(display_name);
    else
      base_name := split_part(current_email, '@', 1);
    end if;
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  -- Only one-time invites consume a use; the stable code is reusable.
  if not is_stable then
    update public.ledger_invites
    set uses_count = uses_count + 1,
        updated_at = now()
    where id = invite_row.id;
  end if;

  -- Activity / audit entry for the join (GVM-127). Actor = the joining member;
  -- the ledger_events INSERT webhook pushes "new activity" to the others.
  select lm.name into saved_member_name
  from public.ledger_members lm
  where lm.id = saved_member_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    redeemed_ledger_id,
    'member_joined',
    coalesce(saved_member_name, 'Et nyt medlem') || ' kom med i gruppen',
    case when was_existing then 'Kom med i gruppen igen' else 'Nyt medlem' end,
    saved_member_id,
    current_email,
    jsonb_build_object(
      'via', case when is_stable then 'join_code' else 'invite' end,
      'new_member', not was_existing
    )
  );

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

revoke all on function public.redeem_ledger_invite(text, text) from public;
revoke all on function public.redeem_ledger_invite(text, text) from anon;
grant execute on function public.redeem_ledger_invite(text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('061_redeem_invite_display_name', 'redeem_ledger_invite honors the onboarding display name (GV-185)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 062: stop persisting user GPS in fuel_payments (GV-186) ────────
-- GDPR data minimisation. Final definition of upsert_fuel_payment: the
-- user_lat_value/user_lng_value params are retained for client backward
-- compatibility but discarded — user_lat/user_lng are always written NULL.
-- station_lat/station_lng are still recorded. Last definition wins on replay.
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
  full_tank_value boolean,
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
  locked_period_id uuid;
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

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
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

  -- GDPR data minimisation (GV-186): user_lat/user_lng are never stored. The
  -- user_lat_value/user_lng_value params are retained in the signature for
  -- backward compatibility with older client builds but are intentionally
  -- discarded here — we write NULL. station_lat/station_lng are still recorded.
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
    null,
    null,
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
    user_lat = null,
    user_lng = null,
    full_tank = excluded.full_tank,
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;

update public.fuel_payments
set user_lat = null,
    user_lng = null
where user_lat is not null
   or user_lng is not null;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('062_drop_user_gps_from_fuel', 'Stop persisting user GPS in fuel_payments (GV-186)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 063: structured fuel stop on car bookings (GVM-159).
-- Mirrors supabase/migrations/063_booking_fuel_stop.sql: add the nullable fuel_stop
-- jsonb column and re-create upsert_car_booking with a trailing fuel_stop_value param
-- (dropping the prior 8-arg signature first, exactly as migration 051 dropped the
-- 6-arg one). Appended last so this definition wins on replay.
alter table public.car_bookings
  add column if not exists fuel_stop jsonb;

drop function if exists public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text);

create or replace function public.upsert_car_booking(
  target_ledger_id text,
  legacy_booking_id text,
  booking_member_id uuid,
  start_at_value timestamptz,
  end_at_value timestamptz,
  purpose_value text,
  event_title text default null,
  event_body text default null,
  fuel_stop_value jsonb default null
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
      fuel_stop,
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
      fuel_stop_value,
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
        fuel_stop = fuel_stop_value,
        deleted_at = null,
        updated_at = now()
    where id = existing_booking.id
    returning id into saved_booking_id;
  end if;

  -- Activity feed event, on create only (GVM-84).
  if existing_booking.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'booking_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', saved_booking_id)
    );
  end if;

  return jsonb_build_object(
    'booking_id', saved_booking_id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('063_booking_fuel_stop', 'Structured fuel stop on car bookings + upsert_car_booking param (GVM-159)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 064: insurance coverage/premium/deductible + write RPC (GVM-165).
-- Mirrors supabase/migrations/064_insurance_details.sql: three more insurance
-- columns on the ledger and a security-definer write path emitting an
-- insurance_updated event (completes the migration-043 read-only stub).
alter table public.ledgers
  add column if not exists insurance_coverage        text,
  add column if not exists insurance_premium_dkk      numeric(12, 2),
  add column if not exists insurance_deductible_dkk   numeric(12, 2);

create or replace function public.update_ledger_insurance(
  target_ledger_id text,
  provider_value text default null,
  policy_no_value text default null,
  coverage_value text default null,
  renewal_value date default null,
  premium_value numeric default null,
  deductible_value numeric default null,
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
  changed_keys text[] := array[]::text[];
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update the insurance' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  update public.ledgers set
    insurance_provider       = coalesce(provider_value, insurance_provider),
    insurance_policy_no      = coalesce(policy_no_value, insurance_policy_no),
    insurance_coverage       = coalesce(coverage_value, insurance_coverage),
    insurance_renewal        = coalesce(renewal_value, insurance_renewal),
    insurance_premium_dkk    = coalesce(premium_value, insurance_premium_dkk),
    insurance_deductible_dkk = coalesce(deductible_value, insurance_deductible_dkk),
    updated_at = now()
  where id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '22023';
  end if;

  -- Record which fields the save touched (keys only, no values — GDPR data
  -- minimisation; the human-readable summary lives in event_body).
  if provider_value is not null then changed_keys := array_append(changed_keys, 'provider'); end if;
  if policy_no_value is not null then changed_keys := array_append(changed_keys, 'policy_no'); end if;
  if coverage_value is not null then changed_keys := array_append(changed_keys, 'coverage'); end if;
  if renewal_value is not null then changed_keys := array_append(changed_keys, 'renewal'); end if;
  if premium_value is not null then changed_keys := array_append(changed_keys, 'premium'); end if;
  if deductible_value is not null then changed_keys := array_append(changed_keys, 'deductible'); end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'insurance_updated',
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('changed', to_jsonb(changed_keys))
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'event_type', 'insurance_updated'
  );
end;
$$;

grant execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('064_insurance_details', 'Add insurance coverage/premium/deductible to ledgers + update_ledger_insurance RPC (GVM-165).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 065: workspace expenses model + per-category split defaults (GVM-168).
-- Mirrors supabase/migrations/065_workspace_expenses.sql: the workspace_expenses
-- table + RLS, the expense_split_defaults column, and the upsert/soft-delete RPCs.
-- ── Per-category default split rule on the ledger ─────────────────
-- Owner-editable via the existing "Ledger admins can update ledgers" RLS (same
-- path as settlement_mode), so no dedicated RPC is needed to change it.
alter table public.ledgers
  add column if not exists expense_split_defaults jsonb not null default
    '{"fuel":"usage","insurance":"equal","tax":"equal","inspection":"equal","repair":"equal","financing":"equal","parking":"equal","other":"equal"}'::jsonb;

-- ── Expenses table ────────────────────────────────────────────────
-- One value per row (Phase 1 is one-off entries; recurrence columns arrive in
-- Phase 2). RLS mirrors vehicle_repairs: members read, creator-or-admin write,
-- admin delete.
create table if not exists public.workspace_expenses (
  id                   uuid primary key default gen_random_uuid(),
  ledger_id            text not null references public.ledgers(id) on delete cascade,
  category             text not null default 'other',
  description          text,
  amount_dkk           numeric(12, 2) not null default 0,
  expense_date         date not null,
  -- null => resolve against ledgers.expense_split_defaults[category] at settle time.
  split_rule           text check (split_rule in ('equal', 'usage', 'custom')),
  -- for split_rule = 'custom': { "<member_id>": <weight> }, weights normalised at settle time.
  split_config         jsonb,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists workspace_expenses_ledger_date_idx
  on public.workspace_expenses (ledger_id, expense_date desc)
  where deleted_at is null;

alter table public.workspace_expenses enable row level security;

drop policy if exists "Ledger members can read expenses" on public.workspace_expenses;
create policy "Ledger members can read expenses" on public.workspace_expenses
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

drop policy if exists "Creators and admins can insert expenses" on public.workspace_expenses;
create policy "Creators and admins can insert expenses" on public.workspace_expenses
  for insert to authenticated
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  );

drop policy if exists "Creators and admins can update expenses" on public.workspace_expenses;
create policy "Creators and admins can update expenses" on public.workspace_expenses
  for update to authenticated
  using (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  )
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  );

drop policy if exists "Admins can delete expenses" on public.workspace_expenses;
create policy "Admins can delete expenses" on public.workspace_expenses
  for delete to authenticated
  using (public.is_ledger_admin(ledger_id));

-- ── Write path: upsert_workspace_expense ──────────────────────────
-- Insert (expense_id_value null) or update an expense, re-checking membership +
-- creator/admin server-side, and emitting an expense_added/expense_updated
-- ledger_events row for the activity feed + operator audit trail (051/052
-- pattern). Returns the row id.
create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
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
  result_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error).
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category     = coalesce(nullif(category_value, ''), category),
      description  = nullif(description_value, ''),
      amount_dkk   = coalesce(amount_value, amount_dkk),
      expense_date = coalesce(expense_date_value, expense_date),
      split_rule   = split_rule_value,
      split_config = split_config_value,
      updated_at   = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

-- ── Soft delete: soft_delete_workspace_expense ────────────────────
create or replace function public.soft_delete_workspace_expense(
  target_ledger_id text,
  expense_id_value uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  existing_expense record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;
  if expense_id_value is null then
    raise exception 'Missing expense id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can delete expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);

  select * into existing_expense
  from public.workspace_expenses
  where id = expense_id_value
    and ledger_id = target_ledger_id
    and deleted_at is null
  for update;

  if existing_expense.id is null then
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;

  if not (public.is_ledger_admin(target_ledger_id)
          or existing_expense.created_by_member_id = actor_member_id) then
    raise exception 'Only the expense creator or a ledger admin can delete this expense' using errcode = '42501';
  end if;

  update public.workspace_expenses
    set deleted_at = now(), updated_at = now()
  where id = expense_id_value;

  return jsonb_build_object('deleted', true, 'id', expense_id_value);
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, text, text) to authenticated;
grant execute on function public.soft_delete_workspace_expense(text, uuid) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('065_workspace_expenses', 'Workspace expenses table + per-category split defaults + upsert/soft-delete RPCs (GVM-168).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 066: add payer to workspace expenses (GVM-169).
-- Mirrors supabase/migrations/066_expense_paid_by.sql: paid_by_member_id column
-- + upsert_workspace_expense recreated with the paid_by_value param (drop-then-
-- create so there is one live signature).
alter table public.workspace_expenses
  add column if not exists paid_by_member_id uuid references public.ledger_members(id) on delete set null;

drop function if exists public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, text, text);

create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
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
  result_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error).
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      expense_date      = coalesce(expense_date_value, expense_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      updated_at        = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('066_expense_paid_by', 'Add paid_by_member_id to workspace_expenses + upsert RPC payer param (GVM-169).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 067: bind workspace expenses to a settlement period (GVM-173).
-- Mirrors supabase/migrations/067_expense_period.sql: period_id column + index,
-- and upsert_workspace_expense recreated with the target_open_period_id param.
alter table public.workspace_expenses
  add column if not exists period_id uuid references public.settlement_periods(id) on delete set null;

create index if not exists workspace_expenses_period_idx
  on public.workspace_expenses (period_id)
  where deleted_at is null;

drop function if exists public.upsert_workspace_expense(text, uuid, text, text, numeric, date, text, jsonb, uuid, text, text);

create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  target_open_period_id uuid,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
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
  result_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
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

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, period_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
      target_open_period_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error). period_id is intentionally NOT
    -- updated — an edit never moves an expense to a different period.
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      expense_date      = coalesce(expense_date_value, expense_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      updated_at        = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('067_expense_period', 'Bind workspace_expenses to a settlement period (period_id) + upsert RPC open-period param (GVM-173).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 068: fold workspace expenses into the settlement rails (GVM-173).
-- Mirrors supabase/migrations/068_settlement_expenses.sql: calculate_period_settlement
-- credits payers + debits per-member split shares (net includes expenses), and
-- calculate_period_entry_fingerprint gains the expense id set. Last definition wins.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  member_km as (
    -- Unrounded per-member km, reused both for the settlement km and as the
    -- usage-split weight (the client weights usage on raw km).
    select ks.member_id, sum(ks.share_km) as km_sum
    from km_shares ks
    group by ks.member_id
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  ledger_defaults as (
    select l.expense_split_defaults as defaults
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is an active member (an expense
    -- with no active payer is skipped entirely, matching the client).
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join active_members payer on payer.id = we.paid_by_member_id
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
      and we.amount_dkk > 0
  ),
  expense_weights as (
    select pe.id as expense_id,
           pe.amount_dkk,
           am.id as member_id,
           case pe.rule
             when 'usage'  then coalesce(mk.km_sum, 0)
             when 'custom' then coalesce((pe.split_config ->> am.id::text)::numeric, 0)
             else 1::numeric
           end as weight
    from period_expenses pe
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  expense_weight_totals as (
    select expense_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from expense_weights
    group by expense_id
  ),
  expense_share as (
    select ew.member_id,
           sum(
             case when ewt.total_weight > 0
                  then round(ew.amount_dkk * ew.weight / ewt.total_weight, 2)
                  else round(ew.amount_dkk / ewt.member_count, 2)
             end
           ) as share
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
    group by ew.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  per_member as (
    select am.id,
           am.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share
    from active_members am
    left join member_km mk on mk.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
    left join expense_paid xp on xp.member_id = am.id
    left join expense_share xs on xs.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid - pm.expense_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- Fingerprint now also covers the period's expense id set (sorted, byte-exact
-- with the client's periodEntryFingerprint) so a changed expense invalidates a
-- stale close just like a trip/fuel change.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || '],"expenses":['
    || coalesce((
         select string_agg(to_json(we.id::text)::text, ',' order by we.id::text collate "C")
         from public.workspace_expenses we
         where we.ledger_id = target_ledger_id
           and we.period_id = target_period_id
           and we.deleted_at is null
       ), '')
    || ']}';
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('068_settlement_expenses', 'Fold workspace expenses into calculate_period_settlement (payer credit + per-member split share, net includes expenses) and calculate_period_entry_fingerprint (expense id set) (GVM-173).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- ═══════════════════════════════════════════════════════════════════
-- Migration 069: recurring expense templates + auto-materialisation (GVM-174)
-- ═══════════════════════════════════════════════════════════════════

alter table public.workspace_expenses
  add column if not exists recurring_expense_id uuid,
  add column if not exists occurrence_date date;

-- One row per (template, occurrence). The partial index only covers generated
-- rows; manual expenses (recurring_expense_id null) are unaffected.
create unique index if not exists workspace_expenses_recurrence_uq
  on public.workspace_expenses (recurring_expense_id, occurrence_date)
  where recurring_expense_id is not null;

-- ── Recurring templates table ─────────────────────────────────────
-- Admin-managed standing policy (like expense_split_defaults / settlement_mode):
-- members read, admins write/delete. Writes go through the RPCs below, but RLS is
-- defensive for direct selects (the client lists templates to manage them).
create table if not exists public.recurring_expenses (
  id                   uuid primary key default gen_random_uuid(),
  ledger_id            text not null references public.ledgers(id) on delete cascade,
  category             text not null default 'other',
  description          text,
  amount_dkk           numeric(12, 2) not null default 0,
  -- how often a new occurrence is materialised
  cadence              text not null default 'monthly' check (cadence in ('monthly', 'quarterly', 'yearly')),
  -- date of the next occurrence to materialise; advanced by cadence on generate.
  next_due_date        date not null,
  -- same split semantics as workspace_expenses: null => workspace default.
  split_rule           text check (split_rule in ('equal', 'usage', 'custom')),
  split_config         jsonb,
  -- who fronts the cost each occurrence; null => the template creator.
  paid_by_member_id    uuid references public.ledger_members(id) on delete set null,
  is_active            boolean not null default true,
  last_generated_at    timestamptz,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists recurring_expenses_ledger_idx
  on public.recurring_expenses (ledger_id, next_due_date)
  where deleted_at is null and is_active;

alter table public.recurring_expenses enable row level security;

drop policy if exists "Ledger members can read recurring expenses" on public.recurring_expenses;
create policy "Ledger members can read recurring expenses" on public.recurring_expenses
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

drop policy if exists "Admins can insert recurring expenses" on public.recurring_expenses;
create policy "Admins can insert recurring expenses" on public.recurring_expenses
  for insert to authenticated
  with check (public.is_ledger_admin(ledger_id));

drop policy if exists "Admins can update recurring expenses" on public.recurring_expenses;
create policy "Admins can update recurring expenses" on public.recurring_expenses
  for update to authenticated
  using (public.is_ledger_admin(ledger_id))
  with check (public.is_ledger_admin(ledger_id));

drop policy if exists "Admins can delete recurring expenses" on public.recurring_expenses;
create policy "Admins can delete recurring expenses" on public.recurring_expenses
  for delete to authenticated
  using (public.is_ledger_admin(ledger_id));

-- ── Write path: upsert_recurring_expense (admin) ──────────────────
-- Insert (recurring_id_value null) or update a template, re-checking admin
-- server-side, and emitting a recurring_expense_added/updated feed event.
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
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
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

-- ── Soft delete: soft_delete_recurring_expense (admin) ────────────
create or replace function public.soft_delete_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_template record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;
  if recurring_id_value is null then
    raise exception 'Missing recurring expense id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can delete recurring expenses' using errcode = '42501';
  end if;

  select * into existing_template
  from public.recurring_expenses
  where id = recurring_id_value
    and ledger_id = target_ledger_id
    and deleted_at is null
  for update;

  if existing_template.id is null then
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;

  update public.recurring_expenses
    set deleted_at = now(), is_active = false, updated_at = now()
  where id = recurring_id_value;

  return jsonb_build_object('deleted', true, 'id', recurring_id_value);
end;
$$;

-- ── Materialisation: generate_due_recurring_expenses ──────────────
-- Idempotent catch-up. For each active template whose next_due_date has arrived,
-- materialise a workspace_expenses row per missed occurrence into the ledger's
-- OPEN period, advancing next_due_date by the cadence until it is in the future.
-- Emits one system feed event per template that produced rows (the nudge). Any
-- member may trigger it (the client calls it on load); it is security definer so
-- it can write regardless of the caller's own expense-write scope. Returns the
-- total number of expenses generated.
create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  total_generated integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up.
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;

    while due_date <= current_date loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
        open_period_id,
        tmpl.category,
        tmpl.description,
        tmpl.amount_dkk,
        due_date,
        tmpl.split_rule,
        tmpl.split_config,
        tmpl.paid_by_member_id,
        tmpl.created_by_member_id,
        tmpl.id,
        due_date
      )
      on conflict (recurring_expense_id, occurrence_date)
        where recurring_expense_id is not null do nothing
      returning id into inserted_id;

      if inserted_id is not null then
        template_count := template_count + 1;
      end if;
      inserted_id := null;

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
        when 'yearly' then due_date + interval '1 year'
        else due_date + interval '1 month'
      end)::date;
    end loop;

    update public.recurring_expenses
      set next_due_date = due_date, last_generated_at = now(), updated_at = now()
    where id = tmpl.id;

    if template_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
      ) values (
        target_ledger_id,
        'expense_recurring_added',
        'Fast udgift tilføjet',
        coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
          || ' blev automatisk tilføjet og delt.',
        null,
        null,
        jsonb_build_object(
          'category', tmpl.category,
          'recurring_expense_id', tmpl.id,
          'count', template_count
        )
      );
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;
grant execute on function public.soft_delete_recurring_expense(text, uuid) to authenticated;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('069_recurring_expenses',
        'Recurring expense templates + idempotent client catch-up materialisation into the open period (GVM-174).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 070: restore integrity gates + expense payer/lock rails (GVM-177) ──
-- ── calculate_period_settlement: restore the operator OR-branch (055) ────────
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  member_km as (
    -- Unrounded per-member km, reused both for the settlement km and as the
    -- usage-split weight (the client weights usage on raw km).
    select ks.member_id, sum(ks.share_km) as km_sum
    from km_shares ks
    group by ks.member_id
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  ledger_defaults as (
    select l.expense_split_defaults as defaults
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is an active member (an expense
    -- with no active payer is skipped entirely, matching the client).
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join active_members payer on payer.id = we.paid_by_member_id
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
      and we.amount_dkk > 0
  ),
  expense_weights as (
    select pe.id as expense_id,
           pe.amount_dkk,
           am.id as member_id,
           case pe.rule
             when 'usage'  then coalesce(mk.km_sum, 0)
             when 'custom' then coalesce((pe.split_config ->> am.id::text)::numeric, 0)
             else 1::numeric
           end as weight
    from period_expenses pe
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  expense_weight_totals as (
    select expense_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from expense_weights
    group by expense_id
  ),
  expense_share as (
    select ew.member_id,
           sum(
             case when ewt.total_weight > 0
                  then round(ew.amount_dkk * ew.weight / ewt.total_weight, 2)
                  else round(ew.amount_dkk / ewt.member_count, 2)
             end
           ) as share
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
    group by ew.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  per_member as (
    select am.id,
           am.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share
    from active_members am
    left join member_km mk on mk.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
    left join expense_paid xp on xp.member_id = am.id
    left join expense_share xs on xs.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid - pm.expense_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── calculate_period_entry_fingerprint: restore the 055 gate ────────────────
-- Back to plpgsql so it can enforce member-or-operator before revealing row ids
-- (068 dropped this while keeping security definer). The fingerprint EXPRESSION
-- is byte-identical to 068's — including the "expenses" section — so the client's
-- periodEntryFingerprint and close_settlement_period stay in exact parity.
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result text;
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || '],"expenses":['
    || coalesce((
         select string_agg(to_json(we.id::text)::text, ',' order by we.id::text collate "C")
         from public.workspace_expenses we
         where we.ledger_id = target_ledger_id
           and we.period_id = target_period_id
           and we.deleted_at is null
       ), '')
    || ']}'
  into result;

  return result;
end;
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── upsert_workspace_expense: payer membership + open-period row lock ────────
-- 067 body verbatim, with two rails added: (1) reject a paid_by_value that is not
-- a member of this ledger, and (2) take a `for share of sp` lock on the open
-- period (like upsert_fuel_payment) instead of a plain existence check, so an
-- in-flight expense write serializes against close_settlement_period.
create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  target_open_period_id uuid,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
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
  result_id uuid;
  locked_period_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112 pattern): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight expense write and a close
  -- serialize here — either this entry commits first and the close's recompute sees
  -- it, or the close commits first and this check finds no open period and fails.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.workspace_expenses (
      ledger_id, period_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
      target_open_period_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error). period_id is intentionally NOT
    -- updated — an edit never moves an expense to a different period.
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      expense_date      = coalesce(expense_date_value, expense_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      updated_at        = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

-- ── upsert_recurring_expense: payer membership validation ───────────────────
-- 069 body verbatim, plus the same non-member payer rejection as
-- upsert_workspace_expense.
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
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
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;

-- ── generate_due_recurring_expenses: lock the open period ───────────────────
-- 069 body verbatim, with `for share of sp` added to the open-period lookup so
-- materialisation serializes against close_settlement_period the same way the
-- expense/fuel upserts do. FOR SHARE with LIMIT requires the lock clause after
-- the limit.
create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  total_generated integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up. FOR SHARE serializes against a
  -- concurrent close (which exclusively locks the period row).
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1
  for share of sp;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;

    while due_date <= current_date loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
        open_period_id,
        tmpl.category,
        tmpl.description,
        tmpl.amount_dkk,
        due_date,
        tmpl.split_rule,
        tmpl.split_config,
        tmpl.paid_by_member_id,
        tmpl.created_by_member_id,
        tmpl.id,
        due_date
      )
      on conflict (recurring_expense_id, occurrence_date)
        where recurring_expense_id is not null do nothing
      returning id into inserted_id;

      if inserted_id is not null then
        template_count := template_count + 1;
      end if;
      inserted_id := null;

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
        when 'yearly' then due_date + interval '1 year'
        else due_date + interval '1 month'
      end)::date;
    end loop;

    update public.recurring_expenses
      set next_due_date = due_date, last_generated_at = now(), updated_at = now()
    where id = tmpl.id;

    if template_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
      ) values (
        target_ledger_id,
        'expense_recurring_added',
        'Fast udgift tilføjet',
        coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
          || ' blev automatisk tilføjet og delt.',
        null,
        null,
        jsonb_build_object(
          'category', tmpl.category,
          'recurring_expense_id', tmpl.id,
          'count', template_count
        )
      );
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('070_restore_integrity_gates',
        'Restore migration 055 member/operator gates on calculate_period_entry_fingerprint (back to plpgsql) and calculate_period_settlement; validate expense payer membership in upsert_workspace_expense/upsert_recurring_expense; take the open-period FOR SHARE lock in upsert_workspace_expense and generate_due_recurring_expenses (GVM-177).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 071: drop the driver-GPS columns from fuel_payments (GV-196) ───
-- GDPR data minimisation, defence-in-depth follow-up to GV-186 (migration 062).
-- upsert_fuel_payment and delete_my_account are re-declared without the
-- user_lat/user_lng references, then the columns are dropped. Last definition
-- wins on replay: the earlier create-table fuel_payments block still lists the
-- columns, and this drop removes them, matching a fresh install of every migration.
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
  full_tank_value boolean,
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
  locked_period_id uuid;
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

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
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

  -- GDPR data minimisation (GV-186 / GV-196): the driver's own position is never
  -- stored — the user_lat/user_lng columns have been dropped (migration 071). The
  -- user_lat_value/user_lng_value params are retained in the signature for
  -- backward compatibility with older client builds but are intentionally
  -- discarded here. station_lat/station_lng are still recorded.
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
    full_tank = excluded.full_tank,
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;

-- Re-declare delete_my_account (verbatim from migration 057) with the fuel-stop
-- user-coordinate scrub removed: the user_lat/user_lng columns are dropped below,
-- so there is nothing left to null out.
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
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
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

-- Drop the driver-GPS columns. Migration 062 already backfilled every row to
-- NULL; this removes the columns (and with them the direct-write bypass the
-- fuel_payments RLS insert/update policies would otherwise allow).
alter table public.fuel_payments
  drop column if exists user_lat,
  drop column if exists user_lng;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('071_drop_fuel_gps_columns', 'Drop driver-GPS columns user_lat/user_lng from fuel_payments; re-declare upsert_fuel_payment and delete_my_account without them (GV-196)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 072 mirror (review hardening — GV-197, GV-198, GV-199) ──────
create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;

  -- Entries created through the trip/fuel RPCs always carry the open period id.
  -- Fall back to the ledger's open period for any row that has none.
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;

  if v_period_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid')
  );
end;
$$;

-- enforce_settlement_entry_lock, extended from migration 046 with a closed-period
-- rejection (GV-199) that runs BEFORE the existing requested/paid lock. It is
-- bypassed only for delete_my_account's PII scrubs via the govehlo.pii_scrub GUC.
create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
  v_check_period_id uuid;
  v_period_closed boolean;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments / workspace_expenses
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock and covers every attached table. delete_my_account's GDPR scrubs set
  -- the transaction-local govehlo.pii_scrub GUC to opt out — those touch only
  -- non-settlement columns (e.g. trip note) and must succeed on closed rows.
  if coalesce(current_setting('govehlo.pii_scrub', true), '') <> '1' then
    v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    if tg_table_name = 'trip_participants' then
      v_check_period_id := v_period_id;
    end if;
    if v_check_period_id is not null then
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id;
      if v_period_closed then
        raise exception
          'This settlement period is closed — entries can no longer be added or changed.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Attach the trigger to workspace_expenses (migration 065 created the table
-- without it, leaving expenses writable into closed periods). The trips /
-- fuel_payments / trip_participants triggers from migration 046 already exist;
-- re-create them idempotently so a fresh install and a replay match.
drop trigger if exists enforce_settlement_entry_lock_trips on public.trips;
create trigger enforce_settlement_entry_lock_trips
before insert or update or delete on public.trips
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_fuel on public.fuel_payments;
create trigger enforce_settlement_entry_lock_fuel
before insert or update or delete on public.fuel_payments
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_participants on public.trip_participants;
create trigger enforce_settlement_entry_lock_participants
before insert or update or delete on public.trip_participants
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_expenses on public.workspace_expenses;
create trigger enforce_settlement_entry_lock_expenses
before insert or update or delete on public.workspace_expenses
for each row execute function public.enforce_settlement_entry_lock();

-- ── FIX B: run_retention_cleanup + preview, push_subscriptions tenant-scoped ─
-- Re-declared verbatim from migration 021, except the push_subscriptions
-- read/DELETE is now scoped to emails of the target ledger's members and the
-- returned push_subscription_scope reflects that.
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

  -- Tenant-scoped (GV-198): only this ledger's members' device records.
  select count(*) into push_count
  from public.push_subscriptions
  where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
    and user_email in (
      select lm.email
      from public.ledger_members lm
      where lm.ledger_id = target_ledger_id
        and lm.email is not null
    );

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
    'push_subscription_scope', 'target_ledger_members'
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

  -- Tenant-scoped (GV-198): a workspace admin may only purge stale device
  -- records for members of their own ledger, never every user's.
  with deleted_push as (
    delete from public.push_subscriptions
    where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
      and user_email in (
        select lm.email
        from public.ledger_members lm
        where lm.ledger_id = target_ledger_id
          and lm.email is not null
      )
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
    'push_subscription_scope', 'target_ledger_members'
  );
end;
$$;

revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from anon;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;

-- ── FIX A: delete_my_account scrubs car_bookings.fuel_stop ──────────────────
-- Re-declared verbatim from migration 071, with: (1) a transaction-local GUC set
-- so the settlement trigger permits PII scrubs on closed-period rows (GV-199),
-- and (2) a new fuel_stop null-out in the bookings section (GV-197).
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
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
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
values ('072_review_hardening', 'Review hardening: delete_my_account scrubs car_bookings.fuel_stop (GV-197); run_retention_cleanup push_subscriptions DELETE scoped to the target ledger''s members (GV-198); enforce_settlement_entry_lock rejects writes into closed periods across trips/fuel/expenses, with a PII-scrub GUC bypass for delete_my_account (GV-199)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 073: semiannual (halvårlig) recurring cadence (GVM-175) ──
-- Grøn ejerafgift is billed twice yearly; widen the cadence set + teach the
-- write guard and the materialisation loop the new value. Last definition wins.
alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_cadence_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_cadence_check
  check (cadence in ('monthly', 'quarterly', 'semiannual', 'yearly'));

create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
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
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'semiannual', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  total_generated integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up.
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;

    while due_date <= current_date loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
        open_period_id,
        tmpl.category,
        tmpl.description,
        tmpl.amount_dkk,
        due_date,
        tmpl.split_rule,
        tmpl.split_config,
        tmpl.paid_by_member_id,
        tmpl.created_by_member_id,
        tmpl.id,
        due_date
      )
      on conflict (recurring_expense_id, occurrence_date)
        where recurring_expense_id is not null do nothing
      returning id into inserted_id;

      if inserted_id is not null then
        template_count := template_count + 1;
      end if;
      inserted_id := null;

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
        when 'semiannual' then due_date + interval '6 months'
        when 'yearly' then due_date + interval '1 year'
        else due_date + interval '1 month'
      end)::date;
    end loop;

    update public.recurring_expenses
      set next_due_date = due_date, last_generated_at = now(), updated_at = now()
    where id = tmpl.id;

    if template_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
      ) values (
        target_ledger_id,
        'expense_recurring_added',
        'Fast udgift tilføjet',
        coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
          || ' blev automatisk tilføjet og delt.',
        null,
        null,
        jsonb_build_object(
          'category', tmpl.category,
          'recurring_expense_id', tmpl.id,
          'count', template_count
        )
      );
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('073_recurring_semiannual_cadence',
        'Add a semiannual (halvårlig) recurring cadence so grøn ejerafgift recurs twice yearly (GVM-175).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 074: idempotent inspection-due (syn) feed event (GVM-187) ──
-- Client catch-up like recurring generation: emits at most one 'inspection_due'
-- event per (ledger, syn date) when the owner-entered next-syn date comes within
-- 30 days (or overdue). Re-emits only when the date changes.
create or replace function public.emit_inspection_due_event(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Lead time: nudge once the syn deadline is within this many days (or overdue).
  threshold_days int := 30;
  syn_date date;
  existing_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can check inspection status' using errcode = '42501';
  end if;

  -- Owner-entered next-syn date lives in the vehicle metadata jsonb.
  select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
    into syn_date
  from public.ledgers l
  where l.id = target_ledger_id;

  -- Nothing to nudge if it is unset or still comfortably in the future.
  if syn_date is null or syn_date > current_date + threshold_days then
    return jsonb_build_object('emitted', false, 'reason', 'not_due');
  end if;

  -- Idempotent: one feed event per (ledger, syn date). A new date (after the car
  -- passes syn) is a distinct key, so the next deadline nudges afresh.
  select le.id into existing_id
  from public.ledger_events le
  where le.ledger_id = target_ledger_id
    and le.event_type = 'inspection_due'
    and (le.metadata ->> 'inspection_date') = syn_date::text
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('emitted', false, 'reason', 'already_emitted');
  end if;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'inspection_due',
    case when syn_date < current_date then 'Syn er overskredet' else 'Syn forfalder snart' end,
    case when syn_date < current_date
      then 'Bilen skulle have været til syn ' || to_char(syn_date, 'DD-MM-YYYY') || '. Book en tid hurtigst muligt.'
      else 'Bilen skal til syn senest ' || to_char(syn_date, 'DD-MM-YYYY') || '. Husk at booke en tid.'
    end,
    null,
    null,
    jsonb_build_object('inspection_date', syn_date::text)
  );

  return jsonb_build_object('emitted', true, 'inspection_date', syn_date::text);
end;
$$;

grant execute on function public.emit_inspection_due_event(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('074_inspection_due_event',
        'Idempotent inspection-due (syn) feed event, client catch-up like recurring generation (GVM-187).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 075: restore recurring gates + guard expense updates (GV-202) ──
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
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
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'semiannual', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;

create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  total_generated integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up. FOR SHARE serializes against a
  -- concurrent close (which exclusively locks the period row).
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1
  for share of sp;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;

    while due_date <= current_date loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
        open_period_id,
        tmpl.category,
        tmpl.description,
        tmpl.amount_dkk,
        due_date,
        tmpl.split_rule,
        tmpl.split_config,
        tmpl.paid_by_member_id,
        tmpl.created_by_member_id,
        tmpl.id,
        due_date
      )
      on conflict (recurring_expense_id, occurrence_date)
        where recurring_expense_id is not null do nothing
      returning id into inserted_id;

      if inserted_id is not null then
        template_count := template_count + 1;
      end if;
      inserted_id := null;

      due_date := (case tmpl.cadence
        when 'monthly' then due_date + interval '1 month'
        when 'quarterly' then due_date + interval '3 months'
        when 'semiannual' then due_date + interval '6 months'
        when 'yearly' then due_date + interval '1 year'
        else due_date + interval '1 month'
      end)::date;
    end loop;

    update public.recurring_expenses
      set next_due_date = due_date, last_generated_at = now(), updated_at = now()
    where id = tmpl.id;

    if template_count > 0 then
      insert into public.ledger_events (
        ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
      ) values (
        target_ledger_id,
        'expense_recurring_added',
        'Fast udgift tilføjet',
        coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
          || ' blev automatisk tilføjet og delt.',
        null,
        null,
        jsonb_build_object(
          'category', tmpl.category,
          'recurring_expense_id', tmpl.id,
          'count', template_count
        )
      );
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
  v_check_period_id uuid;
  v_period_closed boolean;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments / workspace_expenses
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'workspace_expenses' then
      v_guard := (new.amount_dkk is distinct from old.amount_dkk)
              or (new.paid_by_member_id is distinct from old.paid_by_member_id)
              or (new.split_rule is distinct from old.split_rule)
              or (new.split_config is distinct from old.split_config)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock and covers every attached table. delete_my_account's GDPR scrubs set
  -- the transaction-local govehlo.pii_scrub GUC to opt out — those touch only
  -- non-settlement columns (e.g. trip note) and must succeed on closed rows.
  if coalesce(current_setting('govehlo.pii_scrub', true), '') <> '1' then
    v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    if tg_table_name = 'trip_participants' then
      v_check_period_id := v_period_id;
    end if;
    if v_check_period_id is not null then
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id;
      if v_period_closed then
        raise exception
          'This settlement period is closed — entries can no longer be added or changed.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('075_restore_recurring_and_expense_gates',
        'Restore 070 payer-membership gate + FOR SHARE close-lock dropped by 073, and guard workspace_expenses UPDATEs in the settlement lock trigger (GV-202).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

create or replace function public.update_own_ledger_member_mobilepay(
  target_ledger_id text default 'main-car',
  member_mobilepay_phone text default null
)
returns table (
  member_id uuid,
  ledger_id text,
  mobilepay_phone text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_member_id uuid;
  safe_phone text := nullif(btrim(coalesce(member_mobilepay_phone, '')), '');
  saved_member public.ledger_members%rowtype;
begin
  safe_member_id := public.current_ledger_member_id(target_ledger_id);
  if safe_member_id is null then
    raise exception 'Current user is not an active member of this workspace.' using errcode = '42501';
  end if;

  if safe_phone is not null and length(safe_phone) > 40 then
    raise exception 'MobilePay number is too long.' using errcode = '22001';
  end if;

  update public.ledger_members lm
  set mobilepay_phone = safe_phone,
      updated_at = now()
  where lm.id = safe_member_id
    and lm.ledger_id = target_ledger_id
  returning lm.* into saved_member;

  if saved_member.id is null then
    raise exception 'Member profile could not be updated.' using errcode = 'P0001';
  end if;

  update_own_ledger_member_mobilepay.member_id := saved_member.id;
  update_own_ledger_member_mobilepay.ledger_id := saved_member.ledger_id;
  update_own_ledger_member_mobilepay.mobilepay_phone := saved_member.mobilepay_phone;
  return next;
end;
$$;

revoke all on function public.update_own_ledger_member_mobilepay(text, text) from public;
revoke all on function public.update_own_ledger_member_mobilepay(text, text) from anon;
grant execute on function public.update_own_ledger_member_mobilepay(text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('076_member_mobilepay_self_update', 'member MobilePay self-update RPC (GVM-209)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Helper: active-membership check ─────────────────────────────────────────
create or replace function public.member_is_active_in_ledger(p_member_id uuid, p_ledger_id text)
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
      and lm.is_active = true
  );
$$;

-- ── upsert_workspace_expense (070 body + active-payer gate on INSERT) ────────
create or replace function public.upsert_workspace_expense(
  target_ledger_id text,
  target_open_period_id uuid,
  expense_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  expense_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
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
  result_id uuid;
  locked_period_id uuid;
  is_new boolean := expense_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can record expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112 pattern): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight expense write and a close
  -- serialize here — either this entry commits first and the close's recompute sees
  -- it, or the close commits first and this check finds no open period and fails.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    -- A brand-new expense must be paid by an ACTIVE member (GV-208). Edits keep the
    -- looser membership gate above so a payer deactivated after the fact is tolerated.
    if paid_by_value is not null
       and not public.member_is_active_in_ledger(paid_by_value, target_ledger_id) then
      raise exception 'Payer must be an active member of this ledger' using errcode = '22023';
    end if;

    insert into public.workspace_expenses (
      ledger_id, period_id, category, description, amount_dkk, expense_date,
      split_rule, split_config, paid_by_member_id, created_by_member_id
    ) values (
      target_ledger_id,
      target_open_period_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(expense_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'expense_added';
  else
    -- Only the creator or an admin may edit (the RLS update policy enforces this
    -- too; re-checked here for a clear error). period_id is intentionally NOT
    -- updated — an edit never moves an expense to a different period.
    if not exists (
      select 1 from public.workspace_expenses e
      where e.id = expense_id_value
        and e.ledger_id = target_ledger_id
        and e.deleted_at is null
        and (public.is_ledger_admin(target_ledger_id)
             or e.created_by_member_id = actor_member_id)
    ) then
      raise exception 'Only the expense creator or a ledger admin can edit this expense' using errcode = '42501';
    end if;

    update public.workspace_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      expense_date      = coalesce(expense_date_value, expense_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      updated_at        = now()
    where id = expense_id_value
      and ledger_id = target_ledger_id;
    result_id := expense_id_value;
    normalized_event_type := 'expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

-- ── upsert_recurring_expense (075 body + active-payer gate on INSERT) ────────
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
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
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'semiannual', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  if is_new then
    -- A brand-new template must be paid by an ACTIVE member (GV-208) — its payer
    -- drives every future generated expense. Edits keep the looser membership gate.
    if paid_by_value is not null
       and not public.member_is_active_in_ledger(paid_by_value, target_ledger_id) then
      raise exception 'Payer must be an active member of this ledger' using errcode = '22023';
    end if;

    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      coalesce(amount_value, 0),
      coalesce(nullif(cadence_value, ''), 'monthly'),
      coalesce(next_due_date_value, current_date),
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

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
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('077_active_member_expense_writes',
        'Require an active payer on new expense / recurring writes via member_is_active_in_ledger (GV-208).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 078: route the last raw client-table writes through SECURITY DEFINER RPCs (GVM-210).
-- ── insert_repair: a member logs a maintenance/repair cost ──────────────────────
-- Mirrors the "Creators and admins can insert repairs" RLS policy: any active member
-- may log a repair, always attributed to themselves (created_by = the caller).
create or replace function public.insert_repair(
  target_ledger_id text,
  repair_date_value date,
  description_value text,
  cost_dkk_value numeric,
  odo_km_value integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can log repairs' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if nullif(description_value, '') is null then
    raise exception 'Repair description is required' using errcode = '22023';
  end if;

  insert into public.vehicle_repairs (
    ledger_id, repair_date, description, cost_dkk, odo_km, created_by_member_id
  ) values (
    target_ledger_id,
    coalesce(repair_date_value, current_date),
    description_value,
    coalesce(cost_dkk_value, 0),
    odo_km_value,
    actor_member_id
  )
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

grant execute on function public.insert_repair(text, date, text, numeric, integer) to authenticated;

-- ── update_ledger_settings: admin-only workspace settings write ─────────────────
-- Replaces the direct ledgers.update for the three columns the app actually patches:
-- settlement_mode, expense_split_defaults, and a silent vehicle_info refresh. Only the
-- provided values are written (coalesce keeps the rest). Admin-gated, matching the
-- "Ledger admins can update ledgers" RLS policy. Intentionally emits no feed event.
create or replace function public.update_ledger_settings(
  target_ledger_id text,
  settlement_mode_value text default null,
  expense_split_defaults_value jsonb default null,
  vehicle_info_value jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update workspace settings' using errcode = '42501';
  end if;

  if settlement_mode_value is not null
     and settlement_mode_value not in ('monthly', 'running') then
    raise exception 'Invalid settlement mode' using errcode = '22023';
  end if;

  update public.ledgers set
    settlement_mode        = coalesce(settlement_mode_value, settlement_mode),
    expense_split_defaults = coalesce(expense_split_defaults_value, expense_split_defaults),
    vehicle_info           = coalesce(vehicle_info_value, vehicle_info),
    updated_at             = now()
  where id = target_ledger_id;
end;
$$;

grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb) to authenticated;

-- ── post_message: send a chat message ───────────────────────────────────────────
-- Mirrors the "Members can send messages" RLS policy; sender is the caller.
create or replace function public.post_message(
  target_ledger_id text,
  body_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can send messages' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if nullif(body_value, '') is null then
    raise exception 'Message body is required' using errcode = '22023';
  end if;

  insert into public.messages (ledger_id, sender_member_id, body)
  values (target_ledger_id, actor_member_id, body_value)
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

grant execute on function public.post_message(text, text) to authenticated;

-- ── mark_messages_read: upsert the caller's own read cursor ──────────────────────
-- Mirrors the "Members upsert/update own read-state" RLS policies; member is the caller.
create or replace function public.mark_messages_read(
  target_ledger_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can mark messages read' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  insert into public.message_read_state (ledger_id, member_id, last_read_at)
  values (target_ledger_id, actor_member_id, now())
  on conflict (ledger_id, member_id) do update
  set last_read_at = excluded.last_read_at;
end;
$$;

grant execute on function public.mark_messages_read(text) to authenticated;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('078_rpc_write_pattern',
        'Route repair / ledger-settings / message / read-state writes through SECURITY DEFINER RPCs (GVM-210).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 079: rename a workspace member — self, or any member for admins (GVM-139).
create or replace function public.set_member_name(
  target_ledger_id text,
  target_member_id uuid,
  new_name text,
  event_title text default null,
  event_body text default null
)
returns table (member_id uuid, ledger_id text, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  safe_name text := btrim(coalesce(new_name, ''));
  saved public.ledger_members%rowtype;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not an active member of this workspace.' using errcode = '42501';
  end if;

  -- Self-rename is always allowed; renaming anyone else requires admin.
  if target_member_id <> actor_member_id and not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only an admin can rename other members.' using errcode = '42501';
  end if;

  if safe_name = '' then
    raise exception 'Name is required.' using errcode = '22023';
  end if;
  if length(safe_name) > 60 then
    raise exception 'Name is too long.' using errcode = '22001';
  end if;

  -- Target must be an active member of this ledger.
  if not exists (
    select 1 from public.ledger_members lm
    where lm.id = target_member_id
      and lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ) then
    raise exception 'Member was not found in this workspace.' using errcode = 'P0002';
  end if;

  -- Names are unique per ledger; reject a clash with a DIFFERENT member so the caller
  -- can choose another (an explicit rename shouldn't get silently suffixed).
  if exists (
    select 1 from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.name = safe_name
      and lm.id <> target_member_id
  ) then
    raise exception 'That name is already used in this workspace.' using errcode = '23505';
  end if;

  update public.ledger_members lm
  set name = safe_name,
      updated_at = now()
  where lm.id = target_member_id
    and lm.ledger_id = target_ledger_id
  returning lm.* into saved;

  if saved.id is null then
    raise exception 'Member name could not be updated.' using errcode = 'P0001';
  end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'member_renamed',
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('member_id', target_member_id, 'name', safe_name)
    );
  end if;

  set_member_name.member_id := saved.id;
  set_member_name.ledger_id := saved.ledger_id;
  set_member_name.name := saved.name;
  return next;
end;
$$;

revoke all on function public.set_member_name(text, uuid, text, text, text) from public;
revoke all on function public.set_member_name(text, uuid, text, text, text) from anon;
grant execute on function public.set_member_name(text, uuid, text, text, text) to authenticated;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('079_set_member_name',
        'Rename a workspace member — self, or any member for admins (GVM-139).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 080: scheduled close-period reminder — close_reminder_enabled + claim_due_close_reminders (GVM-60).
alter table public.ledgers
  add column if not exists close_reminder_enabled boolean not null default true;

alter table public.settlement_periods
  add column if not exists last_close_reminder_at timestamptz;

-- ── set_close_reminder_enabled: admin toggles the workspace switch ───────────────
create or replace function public.set_close_reminder_enabled(
  target_ledger_id text,
  enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change reminder settings.' using errcode = '42501';
  end if;

  update public.ledgers l
  set close_reminder_enabled = coalesce(enabled, true),
      updated_at = now()
  where l.id = target_ledger_id;
end;
$$;

revoke all on function public.set_close_reminder_enabled(text, boolean) from public;
revoke all on function public.set_close_reminder_enabled(text, boolean) from anon;
grant execute on function public.set_close_reminder_enabled(text, boolean) to authenticated;

-- ── claim_due_close_reminders: engine op for the scheduled push ──────────────────
-- Atomically claims open periods that are past the ~1-month cadence and either never
-- reminded or last reminded ≥7 days ago, stamping last_close_reminder_at so overlapping
-- runs can't double-send (increment-on-claim → a push failure under-reminds, never
-- spams). Returns each claimed period with its workspace's active admin emails, which
-- the caller resolves to push tokens. Service-role only — not client-callable.
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sp.id
    from public.settlement_periods sp
    join public.ledgers l on l.id = sp.ledger_id
    where sp.status = 'open'
      and l.close_reminder_enabled = true
      and sp.opened_at <= now() - interval '30 days'
      and (sp.last_close_reminder_at is null
           or sp.last_close_reminder_at <= now() - interval '7 days')
    order by sp.opened_at
    limit greatest(coalesce(batch_limit, 200), 0)
  ),
  claimed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('080_close_reminder_push',
        'Scheduled close-period reminder: close_reminder_enabled + claim_due_close_reminders (GVM-60).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 081: payment-reminder engine — reminder_count/last_reminder_at + claim_due_payment_reminders (GVM-5).
alter table public.settlement_requests
  add column if not exists reminder_count integer not null default 0;

alter table public.settlement_requests
  add column if not exists last_reminder_at timestamptz;

-- ── claim_due_payment_reminders: engine op for the scheduled push ─────────────────
-- Atomically claims 'requested' payments that are due (first 3 days after requested_at,
-- then ≥7 days since the last reminder, capped at 3), incrementing reminder_count +
-- stamping last_reminder_at so overlapping runs can't double-send (increment-on-claim →
-- a push failure under-reminds, never spams). Returns each with the debtor's email (to
-- resolve to push tokens), the creditor's name, and the amount. Service-role only.
create or replace function public.claim_due_payment_reminders(
  batch_limit integer default 200
)
returns table (request_id uuid, ledger_id text, debtor_email text, creditor_name text, amount numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sr.id
    from public.settlement_requests sr
    where sr.status = 'requested'
      and sr.reminder_count < 3
      and (
        (sr.reminder_count = 0
          and sr.requested_at is not null
          and sr.requested_at <= now() - interval '3 days')
        or (sr.reminder_count between 1 and 2
          and sr.last_reminder_at is not null
          and sr.last_reminder_at <= now() - interval '7 days')
      )
    order by sr.requested_at
    limit greatest(coalesce(batch_limit, 200), 0)
  ),
  claimed as (
    update public.settlement_requests sr
    set reminder_count = sr.reminder_count + 1,
        last_reminder_at = now(),
        updated_at = now()
    from target t
    where sr.id = t.id
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount
  )
  select c.request_id,
         c.ledger_id,
         lower(debtor.email) as debtor_email,
         creditor.name as creditor_name,
         c.amount
  from claimed c
  left join public.ledger_members debtor on debtor.id = c.debtor_id
  left join public.ledger_members creditor on creditor.id = c.creditor_id;
end;
$$;

revoke all on function public.claim_due_payment_reminders(integer) from public;
revoke all on function public.claim_due_payment_reminders(integer) from anon;
revoke all on function public.claim_due_payment_reminders(integer) from authenticated;
grant execute on function public.claim_due_payment_reminders(integer) to service_role;
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('081_payment_reminders',
        'Payment-reminder engine: reminder_count/last_reminder_at + claim_due_payment_reminders (GVM-5).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 082: reminder-claim concurrency + targeting hardening (GV review).
-- Re-declares both claim RPCs with `for update ... skip locked` so overlapping runs
-- can't double-send, filters payment reminders to active debtors with an email, and
-- revokes the default PUBLIC execute the four migration-078 RPCs shipped with.

-- ── claim_due_close_reminders: skip-locked claim ─────────────────────────────────
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sp.id
    from public.settlement_periods sp
    join public.ledgers l on l.id = sp.ledger_id
    where sp.status = 'open'
      and l.close_reminder_enabled = true
      and sp.opened_at <= now() - interval '30 days'
      and (sp.last_close_reminder_at is null
           or sp.last_close_reminder_at <= now() - interval '7 days')
    order by sp.opened_at
    limit greatest(coalesce(batch_limit, 200), 0)
    for update of sp skip locked
  ),
  claimed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;

-- ── claim_due_payment_reminders: skip-locked claim + active-debtor targeting ──────
create or replace function public.claim_due_payment_reminders(
  batch_limit integer default 200
)
returns table (request_id uuid, ledger_id text, debtor_email text, creditor_name text, amount numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sr.id
    from public.settlement_requests sr
    join public.ledger_members debtor on debtor.id = sr.from_member_id
    where sr.status = 'requested'
      and sr.reminder_count < 3
      and debtor.is_active = true
      and debtor.email is not null
      and (
        (sr.reminder_count = 0
          and sr.requested_at is not null
          and sr.requested_at <= now() - interval '3 days')
        or (sr.reminder_count between 1 and 2
          and sr.last_reminder_at is not null
          and sr.last_reminder_at <= now() - interval '7 days')
      )
    order by sr.requested_at
    limit greatest(coalesce(batch_limit, 200), 0)
    for update of sr skip locked
  ),
  claimed as (
    update public.settlement_requests sr
    set reminder_count = sr.reminder_count + 1,
        last_reminder_at = now(),
        updated_at = now()
    from target t
    where sr.id = t.id
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount
  )
  select c.request_id,
         c.ledger_id,
         lower(debtor.email) as debtor_email,
         creditor.name as creditor_name,
         c.amount
  from claimed c
  left join public.ledger_members debtor on debtor.id = c.debtor_id
  left join public.ledger_members creditor on creditor.id = c.creditor_id;
end;
$$;

revoke all on function public.claim_due_payment_reminders(integer) from public;
revoke all on function public.claim_due_payment_reminders(integer) from anon;
revoke all on function public.claim_due_payment_reminders(integer) from authenticated;
grant execute on function public.claim_due_payment_reminders(integer) to service_role;

-- ── Tighten migration-078 RPC grants: revoke the default PUBLIC execute ───────────
revoke all on function public.insert_repair(text, date, text, numeric, integer) from public;
revoke all on function public.insert_repair(text, date, text, numeric, integer) from anon;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb) from public;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb) from anon;
revoke all on function public.post_message(text, text) from public;
revoke all on function public.post_message(text, text) from anon;
revoke all on function public.mark_messages_read(text) from public;
revoke all on function public.mark_messages_read(text) from anon;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('082_reminder_claim_hardening',
        'Reminder-claim hardening: skip-locked claims + active-debtor targeting + 078 grant revokes (GV review).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 083: revoke EXECUTE from PUBLIC on all SECURITY DEFINER functions (GV-211) ──
-- In Postgres a newly created function grants EXECUTE to PUBLIC by default, so every
-- SECURITY DEFINER RPC shipped executable by anon. Revoke that default across the board
-- and re-grant EXECUTE only to the roles that legitimately need it (authenticated for
-- client RPCs, anon for the invite preflight; trigger/helper/service-role functions get
-- no authenticated grant). Privileges only — no function body is re-declared.
revoke execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from public;
grant execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) to authenticated;
revoke execute on function public.calculate_period_entry_fingerprint(text, uuid) from public;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;
revoke execute on function public.calculate_period_settlement(text, uuid) from public;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;
revoke execute on function public.can_manage_car_booking(uuid) from public;
revoke execute on function public.can_manage_fuel_payment(uuid) from public;
revoke execute on function public.can_manage_trip(uuid) from public;
revoke execute on function public.check_ledger_invite_email(text, text) from public;
grant execute on function public.check_ledger_invite_email(text, text) to authenticated;
grant execute on function public.check_ledger_invite_email(text, text) to anon;
revoke execute on function public.check_owner_rate_limit(text, text, integer, integer) from public;
revoke execute on function public.claim_due_close_reminders(integer) from public;
revoke execute on function public.claim_due_payment_reminders(integer) from public;
revoke execute on function public.close_settlement_period(text, uuid, jsonb) from public;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;
revoke execute on function public.create_ledger_invite(text, text, text, integer, integer) from public;
grant execute on function public.create_ledger_invite(text, text, text, integer, integer) to authenticated;
revoke execute on function public.create_private_ledger_workspace(text, text) from public;
grant execute on function public.create_private_ledger_workspace(text, text) to authenticated;
revoke execute on function public.current_ledger_member_id(text) from public;
revoke execute on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
revoke execute on function public.delete_push_token(text) from public;
grant execute on function public.delete_push_token(text) to authenticated;
revoke execute on function public.emit_inspection_due_event(text) from public;
grant execute on function public.emit_inspection_due_event(text) to authenticated;
revoke execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from public;
grant execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) to authenticated;
revoke execute on function public.enforce_settlement_entry_lock() from public;
revoke execute on function public.enforce_settlement_request_integrity() from public;
revoke execute on function public.fuel_ledger_healthcheck(text) from public;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
revoke execute on function public.generate_due_recurring_expenses(text) from public;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;
revoke execute on function public.generate_workspace_join_code() from public;
revoke execute on function public.get_workspace_join_code(text) from public;
grant execute on function public.get_workspace_join_code(text) to authenticated;
revoke execute on function public.hash_ledger_invite_code(text) from public;
grant execute on function public.hash_ledger_invite_code(text) to authenticated;
revoke execute on function public.insert_repair(text, date, text, numeric, integer) from public;
grant execute on function public.insert_repair(text, date, text, numeric, integer) to authenticated;
revoke execute on function public.is_ledger_admin(text) from public;
revoke execute on function public.is_ledger_bootstrap_open(text) from public;
revoke execute on function public.is_ledger_member(text) from public;
revoke execute on function public.is_operator_context() from public;
grant execute on function public.is_operator_context() to authenticated;
revoke execute on function public.list_my_ledgers() from public;
grant execute on function public.list_my_ledgers() to authenticated;
revoke execute on function public.lock_ledger_bootstrap_when_admin_email_attached() from public;
revoke execute on function public.mark_messages_read(text) from public;
grant execute on function public.mark_messages_read(text) to authenticated;
revoke execute on function public.member_belongs_to_ledger(uuid, text) from public;
revoke execute on function public.member_is_active_in_ledger(uuid, text) from public;
revoke execute on function public.post_message(text, text) from public;
grant execute on function public.post_message(text, text) to authenticated;
revoke execute on function public.prevent_overlapping_car_bookings() from public;
revoke execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
revoke execute on function public.production_activity_reset(text) from public;
grant execute on function public.production_activity_reset(text) to authenticated;
revoke execute on function public.purge_generated_test_rows(text, boolean) from public;
grant execute on function public.purge_generated_test_rows(text, boolean) to authenticated;
revoke execute on function public.redeem_ledger_invite(text, text) from public;
grant execute on function public.redeem_ledger_invite(text, text) to authenticated;
revoke execute on function public.resolve_ledger_invite(text) from public;
grant execute on function public.resolve_ledger_invite(text) to authenticated;
revoke execute on function public.revoke_ledger_invite(text, uuid) from public;
grant execute on function public.revoke_ledger_invite(text, uuid) to authenticated;
revoke execute on function public.rotate_workspace_join_code(text) from public;
grant execute on function public.rotate_workspace_join_code(text) to authenticated;
revoke execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
revoke execute on function public.save_scheduled_reminder_state(text, jsonb) from public;
revoke execute on function public.scheduled_reminder_state(text) from public;
revoke execute on function public.set_close_reminder_enabled(text, boolean) from public;
grant execute on function public.set_close_reminder_enabled(text, boolean) to authenticated;
revoke execute on function public.set_ledger_member_active_admin(text, uuid, boolean) from public;
grant execute on function public.set_ledger_member_active_admin(text, uuid, boolean) to authenticated;
revoke execute on function public.set_member_name(text, uuid, text, text, text) from public;
grant execute on function public.set_member_name(text, uuid, text, text, text) to authenticated;
revoke execute on function public.settlement_entry_is_locked(text, uuid) from public;
revoke execute on function public.soft_delete_car_booking(text, text) from public;
grant execute on function public.soft_delete_car_booking(text, text) to authenticated;
revoke execute on function public.soft_delete_recurring_expense(text, uuid) from public;
grant execute on function public.soft_delete_recurring_expense(text, uuid) to authenticated;
revoke execute on function public.soft_delete_workspace_expense(text, uuid) from public;
grant execute on function public.soft_delete_workspace_expense(text, uuid) to authenticated;
revoke execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) from public;
grant execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) to authenticated;
revoke execute on function public.update_ledger_settings(text, text, jsonb, jsonb) from public;
grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) from public;
grant execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) to authenticated;
revoke execute on function public.update_own_ledger_member_mobilepay(text, text) from public;
grant execute on function public.update_own_ledger_member_mobilepay(text, text) to authenticated;
revoke execute on function public.update_own_ledger_member_profile(text, text, text) from public;
grant execute on function public.update_own_ledger_member_profile(text, text, text) to authenticated;
revoke execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) from public;
grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) to authenticated;
revoke execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) from public;
grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;
revoke execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) from public;
grant execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) to authenticated;
revoke execute on function public.upsert_push_token(text, text) from public;
grant execute on function public.upsert_push_token(text, text) to authenticated;
revoke execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) from public;
grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;
revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;
revoke execute on function public.upsert_test_lab_report(text, text, jsonb) from public;
grant execute on function public.upsert_test_lab_report(text, text, jsonb) to authenticated;
revoke execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) from public;
grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) to authenticated;
revoke execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) from public;
grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('083_revoke_security_definer_public',
        'Revoke EXECUTE from PUBLIC on all SECURITY DEFINER functions + re-grant client RPCs to authenticated (GV-211).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- ── Migration 084: require an existing request before marking a settlement paid (GVM-241) ──
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

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  -- Require an existing, non-cancelled request before marking paid (GVM-241).
  -- Without this the pair upsert's on-conflict misses for a stale/foreign-period
  -- request and INSERTs a fresh row directly at status 'paid', which trips the
  -- 003 trigger guard with the cryptic 'Request the payment before marking it
  -- paid'. Raise a clean, mappable error instead.
  if normalized_status = 'paid' then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
    end if;
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

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('084_require_request_before_paid',
        'Require an existing non-cancelled request before marking a settlement paid; prevents the pair upsert from inserting a fresh row directly at status paid and tripping the 003 trigger guard (GVM-241).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 085: reconcile settlement pair unique index + ON CONFLICT predicate (GVM-241, GV-183)
-- Drifted pair-uniqueness is a CONSTRAINT in prod (owns its index), so drop the
-- constraint; the index drop covers any bare-index environment. Both no-op on fresh installs.
alter table public.settlement_requests drop constraint if exists settlement_requests_period_from_to_unique;
drop index if exists public.settlement_requests_period_from_to_unique;

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

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  -- Require an existing, non-cancelled request before marking paid (GVM-241).
  -- Without this the pair upsert's on-conflict misses for a stale/foreign-period
  -- request and INSERTs a fresh row directly at status 'paid', which trips the
  -- 003 trigger guard with the cryptic 'Request the payment before marking it
  -- paid'. Raise a clean, mappable error instead.
  if normalized_status = 'paid' then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
    end if;
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
  on conflict (period_id, from_member_id, to_member_id) where status <> 'cancelled' do update set
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

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('085_reconcile_settlement_pair_index',
        'Reconcile the settlement pair unique index: drop the drifted full unique index settlement_requests_period_from_to_unique (GV-183), ensure the canonical partial index, and add the WHERE status <> cancelled predicate to the upsert ON CONFLICT so mark-as-paid UPDATEs instead of INSERTing (GVM-241).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();


-- Migration 086: transition settlement status via UPDATE, not INSERT ON CONFLICT (GVM-241)
-- The 003 integrity trigger is BEFORE INSERT OR UPDATE; a BEFORE INSERT trigger fires on an
-- upsert's proposed row before ON CONFLICT resolves to DO UPDATE, so an upsert to status paid
-- tripped the guard. Transition via explicit lookup + UPDATE (fires BEFORE UPDATE); new rows INSERT.
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

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  -- Require an existing, non-cancelled request before marking paid (GVM-241).
  -- Without this the pair upsert's on-conflict misses for a stale/foreign-period
  -- request and INSERTs a fresh row directly at status 'paid', which trips the
  -- 003 trigger guard with the cryptic 'Request the payment before marking it
  -- paid'. Raise a clean, mappable error instead.
  if normalized_status = 'paid' then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
    end if;
  end if;

  if normalized_status = 'requested' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
  elsif normalized_status = 'paid' then
    paid_at_value := now();
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':settlement:' || target_open_period_id::text));

  -- Transition the pair's request via an explicit lookup + UPDATE, NOT
  -- INSERT ... ON CONFLICT. The 003 integrity trigger is BEFORE INSERT OR UPDATE,
  -- and a BEFORE INSERT trigger fires on an upsert's proposed row *before* the
  -- ON CONFLICT resolves to DO UPDATE — so an upsert to status 'paid' trips the
  -- trigger's INSERT-paid guard even when a matching request exists (GVM-241).
  -- An explicit UPDATE fires BEFORE UPDATE, where the guard validates the
  -- requested->paid transition as legal. Genuinely new rows still INSERT.
  select sr.id into saved_request_id
  from public.settlement_requests sr
  where sr.period_id = target_open_period_id
    and sr.from_member_id = payer_member_id
    and sr.to_member_id = recipient_member_id
    and sr.status <> 'cancelled'
  for update;

  if saved_request_id is not null then
    update public.settlement_requests
       set amount = amount_value,
           currency = coalesce(nullif(currency_value, ''), 'DKK'),
           status = normalized_status,
           requested_at = requested_at_value,
           requested_by_member_id = requested_by_value,
           paid_at = paid_at_value,
           updated_at = now()
     where id = saved_request_id;
  else
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
    returning id into saved_request_id;
  end if;

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

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('086_settlement_status_update_not_upsert',
        'Transition settlement status via an explicit lookup + UPDATE instead of INSERT ON CONFLICT DO UPDATE. A BEFORE INSERT trigger fires on an upsert''s proposed row before the ON CONFLICT resolves to DO UPDATE, so an upsert to status paid tripped the 003 integrity guard even with a matching request present; an explicit UPDATE fires BEFORE UPDATE where the requested->paid transition validates as legal (GVM-241).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

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
  server_fingerprint text;
  computed jsonb;
  computed_person jsonb;
  snapshot_person jsonb;
  snapshot_flow numeric;
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

  -- ── Integrity gate (GVM-112) ──────────────────────────────────────────────
  -- (a) Entry set: the snapshot's fingerprint must equal the one recomputed
  -- from the live rows. In-flight writers hold FOR SHARE on the period row, so
  -- by the time this runs the row set is stable for the transaction.
  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  server_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, target_period_id);

  if snapshot_fingerprint is not null and snapshot_fingerprint <> server_fingerprint then
    raise exception 'Entries changed since this close was prepared. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  -- (b) Amounts: per-member figures within 0.02 kr, totals within 0.05 kr.
  computed := public.calculate_period_settlement(target_ledger_id, target_period_id);

  if abs(coalesce((period_snapshot->>'totalKm')::numeric, 0) - (computed->>'totalKm')::numeric) > 0.05
     or abs(coalesce((period_snapshot->>'totalPaid')::numeric, 0) - (computed->>'totalPaid')::numeric) > 0.05 then
    raise exception 'Snapshot totals do not match the server calculation. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  for computed_person in
    select value from jsonb_array_elements(computed->'people')
  loop
    select p.value
      into snapshot_person
      from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb)) as p(value)
      where p.value->>'id' = computed_person->>'id'
      limit 1;

    if abs(coalesce((snapshot_person->>'km')::numeric, 0) - (computed_person->>'km')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'fuelPaid')::numeric, 0) - (computed_person->>'fuelPaid')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'net')::numeric, 0) - (computed_person->>'net')::numeric) > 0.02 then
      raise exception 'Snapshot member amounts do not match the server calculation. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;

    -- (c) The archived settlements must actually move each member's net:
    -- outflow - inflow ~= -net for every member.
    select coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'fromId' = computed_person->>'id'), 0)
         - coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'toId' = computed_person->>'id'), 0)
      into snapshot_flow
      from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb)) as s(value);

    if abs(snapshot_flow + (computed_person->>'net')::numeric) > 0.05 then
      raise exception 'Snapshot settlements do not match the member balances. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;

  -- Snapshot-only members (left the ledger between fetch and close) must carry
  -- no money, otherwise the archive would hide a real balance.
  for snapshot_person in
    select value from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb))
  loop
    if not exists (
      select 1 from jsonb_array_elements(computed->'people') as c(value)
      where c.value->>'id' = snapshot_person->>'id'
    ) and abs(coalesce((snapshot_person->>'net')::numeric, 0)) > 0.02 then
      raise exception 'Snapshot includes a member the server no longer recognizes. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;
  -- ── End integrity gate ────────────────────────────────────────────────────

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

  -- Activity feed + realtime nudge (GVM-247): closing a period writes a
  -- ledger_events row so every other member's client (subscribed to
  -- ledger_events) refetches immediately — otherwise the close only reaches them
  -- on a manual refresh. metadata carries both period ids for the feed/routing.
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, 'period_closed', 'Periode lukket', 'En ny periode er klar.',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object('closed_period_id', closed_period_id, 'open_period_id', new_open_period_id)
  );

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', snapshot_fingerprint
  );
end;
$$;

revoke execute on function public.close_settlement_period(text, uuid, jsonb) from public;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;

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
  event_type_value text;
  event_title_value text;
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

  -- Bound the requested amount (GVM-112): no pair settlement can exceed the
  -- period's total fuel spend. Deliberately an upper bound, not equality —
  -- monthly/running request shapes (GVM-76) vary by design, and a false
  -- rejection would block a legitimate payment request.
  if normalized_status = 'requested' then
    if amount_value is null or amount_value <= 0 then
      raise exception 'Requested amount must be greater than zero' using errcode = '23514';
    end if;
    if amount_value > (
      select coalesce(sum(fp.amount), 0) + 1.0
      from public.fuel_payments fp
      where fp.ledger_id = target_ledger_id
        and fp.period_id = target_open_period_id
        and fp.deleted_at is null
    ) then
      raise exception 'Requested amount is larger than this period''s total fuel spend. Refresh the app and try again.' using errcode = '23514';
    end if;
  end if;

  -- Require an existing, non-cancelled request before marking paid (GVM-241).
  -- Without this the pair upsert's on-conflict misses for a stale/foreign-period
  -- request and INSERTs a fresh row directly at status 'paid', which trips the
  -- 003 trigger guard with the cryptic 'Request the payment before marking it
  -- paid'. Raise a clean, mappable error instead.
  if normalized_status = 'paid' then
    if not exists (
      select 1 from public.settlement_requests sr
      where sr.period_id = target_open_period_id
        and sr.from_member_id = payer_member_id
        and sr.to_member_id = recipient_member_id
        and sr.status <> 'cancelled'
    ) then
      raise exception 'No active payment request to mark as paid — refresh and try again' using errcode = '23514';
    end if;
  end if;

  if normalized_status = 'requested' then
    requested_at_value := now();
    requested_by_value := recipient_member_id;
  elsif normalized_status = 'paid' then
    paid_at_value := now();
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':settlement:' || target_open_period_id::text));

  -- Transition the pair's request via an explicit lookup + UPDATE, NOT
  -- INSERT ... ON CONFLICT. The 003 integrity trigger is BEFORE INSERT OR UPDATE,
  -- and a BEFORE INSERT trigger fires on an upsert's proposed row *before* the
  -- ON CONFLICT resolves to DO UPDATE — so an upsert to status 'paid' trips the
  -- trigger's INSERT-paid guard even when a matching request exists (GVM-241).
  -- An explicit UPDATE fires BEFORE UPDATE, where the guard validates the
  -- requested->paid transition as legal. Genuinely new rows still INSERT.
  select sr.id into saved_request_id
  from public.settlement_requests sr
  where sr.period_id = target_open_period_id
    and sr.from_member_id = payer_member_id
    and sr.to_member_id = recipient_member_id
    and sr.status <> 'cancelled'
  for update;

  if saved_request_id is not null then
    update public.settlement_requests
       set amount = amount_value,
           currency = coalesce(nullif(currency_value, ''), 'DKK'),
           status = normalized_status,
           requested_at = requested_at_value,
           requested_by_member_id = requested_by_value,
           paid_at = paid_at_value,
           updated_at = now()
     where id = saved_request_id;
  else
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
    returning id into saved_request_id;
  end if;

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

  -- Activity feed + realtime nudge (GVM-247): every status change writes a
  -- ledger_events row so the other member's client (subscribed to ledger_events)
  -- refetches immediately, and the change lands in the activity feed.
  -- 'requested' -> payment_requested (the feed's role-aware Pay/Remind CTA keys
  -- on this type + metadata.settlement_request_id); 'paid' -> payment_paid;
  -- reopen/cancel -> settlement_open / settlement_cancelled.
  event_type_value := case normalized_status
    when 'requested' then 'payment_requested'
    when 'paid' then 'payment_paid'
    else 'settlement_' || normalized_status
  end;
  event_title_value := case normalized_status
    when 'requested' then 'Betaling anmodet'
    when 'paid' then 'Betaling markeret som betalt'
    when 'cancelled' then 'Betaling annulleret'
    else 'Betaling genåbnet'
  end;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, event_type_value, event_title_value, '',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object(
      'settlement_request_id', saved_request_id,
      'from_member_id', payer_member_id,
      'to_member_id', recipient_member_id,
      'amount', amount_value
    )
  );

  return jsonb_build_object(
    'settlement_request_id', saved_request_id,
    'ledger_id', target_ledger_id,
    'period_id', target_open_period_id,
    'status', normalized_status,
    'cancelled_stale_count', cancelled_count
  );
end;
$$;

revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('087_settlement_events_for_realtime',
        'Log a ledger_events row on period close (period_closed) and settlement status change (payment_requested / payment_paid / settlement_*), so the realtime ledger_events subscription nudges every other member''s client to refetch — closing a period and marking paid now sync live like trips/fuel already did (GVM-247).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
  v_check_period_id uuid;
  v_period_closed boolean;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments / workspace_expenses
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'workspace_expenses' then
      v_guard := (new.amount_dkk is distinct from old.amount_dkk)
              or (new.paid_by_member_id is distinct from old.paid_by_member_id)
              or (new.split_rule is distinct from old.split_rule)
              or (new.split_config is distinct from old.split_config)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock and covers every attached table. delete_my_account's GDPR scrubs set
  -- the transaction-local govehlo.pii_scrub GUC to opt out — those touch only
  -- non-settlement columns (e.g. trip note) and must succeed on closed rows.
  if coalesce(current_setting('govehlo.pii_scrub', true), '') <> '1' then
    -- trip_participants has no period_id column, so it must use the parent trip's
    -- period resolved above; only the row-owning tables carry old/new.period_id
    -- (dereferencing it on trip_participants raised 'record has no field period_id'
    -- and broke all trip logging/editing — GV-225).
    if tg_table_name = 'trip_participants' then
      v_check_period_id := v_period_id;
    else
      v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    end if;
    if v_check_period_id is not null then
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id;
      if v_period_closed then
        raise exception
          'This settlement period is closed — entries can no longer be added or changed.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('088_fix_trip_participants_period_check',
        'Fix enforce_settlement_entry_lock dereferencing old/new.period_id on trip_participants (no such column) in the GV-199 closed-period block, which raised ''record "old" has no field "period_id"'' and broke logging/editing any trip. Select the closed-period check column per table: v_period_id (parent trip) for trip_participants, old/new.period_id for the row-owning tables (GV-225).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

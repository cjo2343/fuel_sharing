-- Fuel Ledger complete Supabase schema for a fresh project.
-- This creates both the legacy JSON backup table and the normalized table-primary backend.
-- After running, update ledger_members.email for each real user before inviting people.

create extension if not exists pgcrypto;

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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ledgers
  add column if not exists fuel_tank_capacity_l numeric(8,2) not null default 55;

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

  perform pg_advisory_xact_lock(hashtext(target_ledger_id));

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
    from public.ledger_members lm
    where lm.ledger_id = p_ledger_id
      and lm.is_active = true
      and lm.email is not null
      and lm.email <> ''
  );
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

drop policy if exists "Users can read own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can insert own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can update own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can delete own push subscriptions" on public.push_subscriptions;
create policy "Users can read own push subscriptions" on public.push_subscriptions for select to authenticated using (lower(user_email) = public.current_user_email());
create policy "Users can insert own push subscriptions" on public.push_subscriptions for insert to authenticated with check (lower(user_email) = public.current_user_email());
create policy "Users can update own push subscriptions" on public.push_subscriptions for update to authenticated using (lower(user_email) = public.current_user_email()) with check (lower(user_email) = public.current_user_email());
create policy "Users can delete own push subscriptions" on public.push_subscriptions for delete to authenticated using (lower(user_email) = public.current_user_email());


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


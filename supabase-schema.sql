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
  fallback_fuel_price numeric(10,2) not null default 14.50,
  low_fuel_threshold_percent numeric(6,2) not null default 70,
  high_fuel_threshold_percent numeric(6,2) not null default 140,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ledger_members (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  name text not null,
  email text,
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

insert into public.ledgers (id, name, currency, fuel_type, estimated_consumption_l_per_100km, fallback_fuel_price)
values ('main-car', 'Fuel Ledger', 'DKK', 'diesel', 5.3, 14.50)
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

alter table public.car_share_ledgers enable row level security;
alter table public.ledgers enable row level security;
alter table public.ledger_members enable row level security;
alter table public.settlement_periods enable row level security;
alter table public.trips enable row level security;
alter table public.trip_participants enable row level security;
alter table public.fuel_payments enable row level security;
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
drop policy if exists "Ledger members can read ledgers" on public.ledgers;
drop policy if exists "Ledger admins can update ledgers" on public.ledgers;
drop policy if exists "Ledger members can read members" on public.ledger_members;
drop policy if exists "Ledger admins can insert members" on public.ledger_members;
drop policy if exists "Ledger admins can update members" on public.ledger_members;
drop policy if exists "Ledger admins can delete members" on public.ledger_members;
drop policy if exists "Ledger members can read periods" on public.settlement_periods;
drop policy if exists "Ledger members can insert periods" on public.settlement_periods;
drop policy if exists "Ledger members can update periods" on public.settlement_periods;
drop policy if exists "Ledger members can read trips" on public.trips;
drop policy if exists "Ledger members can insert trips" on public.trips;
drop policy if exists "Ledger members can update trips" on public.trips;
drop policy if exists "Ledger members can read trip participants" on public.trip_participants;
drop policy if exists "Ledger members can insert trip participants" on public.trip_participants;
drop policy if exists "Ledger members can update trip participants" on public.trip_participants;
drop policy if exists "Ledger members can delete trip participants" on public.trip_participants;
drop policy if exists "Ledger members can read fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can insert fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can update fuel payments" on public.fuel_payments;
drop policy if exists "Ledger members can read settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can insert settlement requests" on public.settlement_requests;
drop policy if exists "Ledger members can update settlement requests" on public.settlement_requests;

create policy "Ledger members can read JSON ledger" on public.car_share_ledgers for select to authenticated using (public.is_ledger_member(id));
create policy "Ledger members can insert JSON ledger" on public.car_share_ledgers for insert to authenticated with check (public.is_ledger_member(id));
create policy "Ledger members can update JSON ledger" on public.car_share_ledgers for update to authenticated using (public.is_ledger_member(id)) with check (public.is_ledger_member(id));

create policy "Ledger members can read ledgers" on public.ledgers for select to authenticated using (public.is_ledger_member(id));
create policy "Ledger admins can update ledgers" on public.ledgers for update to authenticated using (public.is_ledger_admin(id)) with check (public.is_ledger_admin(id));

create policy "Ledger members can read members" on public.ledger_members for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger admins can insert members" on public.ledger_members for insert to authenticated with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can update members" on public.ledger_members for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can delete members" on public.ledger_members for delete to authenticated using (public.is_ledger_admin(ledger_id));

create policy "Ledger members can read periods" on public.settlement_periods for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert periods" on public.settlement_periods for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger members can update periods" on public.settlement_periods for update to authenticated using (public.is_ledger_member(ledger_id)) with check (public.is_ledger_member(ledger_id));

create policy "Ledger members can read trips" on public.trips for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert trips" on public.trips for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger members can update trips" on public.trips for update to authenticated using (public.is_ledger_member(ledger_id)) with check (public.is_ledger_member(ledger_id));

create policy "Ledger members can read trip participants" on public.trip_participants for select to authenticated using (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));
create policy "Ledger members can insert trip participants" on public.trip_participants for insert to authenticated with check (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));
create policy "Ledger members can update trip participants" on public.trip_participants for update to authenticated using (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id))) with check (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));
create policy "Ledger members can delete trip participants" on public.trip_participants for delete to authenticated using (exists (select 1 from public.trips t where t.id = trip_participants.trip_id and public.is_ledger_member(t.ledger_id)));

create policy "Ledger members can read fuel payments" on public.fuel_payments for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert fuel payments" on public.fuel_payments for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger members can update fuel payments" on public.fuel_payments for update to authenticated using (public.is_ledger_member(ledger_id)) with check (public.is_ledger_member(ledger_id));

create policy "Ledger members can read settlement requests" on public.settlement_requests for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger members can insert settlement requests" on public.settlement_requests for insert to authenticated with check (public.is_ledger_member(ledger_id));
create policy "Ledger members can update settlement requests" on public.settlement_requests for update to authenticated using (public.is_ledger_member(ledger_id)) with check (public.is_ledger_member(ledger_id));

drop policy if exists "Users can read own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can insert own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can update own push subscriptions" on public.push_subscriptions;
drop policy if exists "Users can delete own push subscriptions" on public.push_subscriptions;
create policy "Users can read own push subscriptions" on public.push_subscriptions for select to authenticated using (lower(user_email) = public.current_user_email());
create policy "Users can insert own push subscriptions" on public.push_subscriptions for insert to authenticated with check (lower(user_email) = public.current_user_email());
create policy "Users can update own push subscriptions" on public.push_subscriptions for update to authenticated using (lower(user_email) = public.current_user_email()) with check (lower(user_email) = public.current_user_email());
create policy "Users can delete own push subscriptions" on public.push_subscriptions for delete to authenticated using (lower(user_email) = public.current_user_email());

-- Post-run setup check:
-- select name, email, role, is_active from ledger_members where ledger_id = 'main-car' order by name;

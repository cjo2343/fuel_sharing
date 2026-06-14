-- Migration 002: auth/member helper functions used by RLS policies and write guards.

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

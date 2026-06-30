-- Migration 043: Car maintenance, repair history & insurance (GVM-11).
-- DRAFT — review before applying. Backs the Car profile prototype sections
-- (next maintenance, repair history with costs, insurance card).
--
-- Maintenance + insurance are single-value-per-car, so they live as columns on
-- the ledger row (owner/admin-editable via the existing ledger update policy).
-- Repairs are a list, so they get their own table with member-read / creator-or
-- admin-write RLS, mirroring trips / car_bookings.

-- ── Maintenance + insurance fields on the ledger ──────────────────
alter table public.ledgers
  add column if not exists next_service_date   date,
  add column if not exists next_service_km      integer,
  add column if not exists insurance_provider   text,
  add column if not exists insurance_policy_no  text,
  add column if not exists insurance_renewal    date;

-- ── Repair history ────────────────────────────────────────────────
create table if not exists public.vehicle_repairs (
  id                   uuid primary key default gen_random_uuid(),
  ledger_id            text not null references public.ledgers(id) on delete cascade,
  repair_date          date not null,
  description          text not null,
  cost_dkk             numeric(12, 2) not null default 0,
  odo_km               integer,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists vehicle_repairs_ledger_date_idx
  on public.vehicle_repairs (ledger_id, repair_date desc)
  where deleted_at is null;

alter table public.vehicle_repairs enable row level security;

drop policy if exists "Ledger members can read repairs" on public.vehicle_repairs;
create policy "Ledger members can read repairs" on public.vehicle_repairs
  for select to authenticated
  using (public.is_ledger_member(ledger_id));

drop policy if exists "Creators and admins can insert repairs" on public.vehicle_repairs;
create policy "Creators and admins can insert repairs" on public.vehicle_repairs
  for insert to authenticated
  with check (
    public.is_ledger_member(ledger_id)
    and (public.is_ledger_admin(ledger_id)
         or created_by_member_id = public.current_ledger_member_id(ledger_id))
  );

drop policy if exists "Creators and admins can update repairs" on public.vehicle_repairs;
create policy "Creators and admins can update repairs" on public.vehicle_repairs
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

drop policy if exists "Admins can delete repairs" on public.vehicle_repairs;
create policy "Admins can delete repairs" on public.vehicle_repairs
  for delete to authenticated
  using (public.is_ledger_admin(ledger_id));

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('043_car_maintenance_repairs_insurance',
        'Add maintenance + insurance fields to ledgers and a vehicle_repairs table (GVM-11).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

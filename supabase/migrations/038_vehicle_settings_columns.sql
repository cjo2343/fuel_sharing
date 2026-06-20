-- Migration 038: Store workspace vehicle settings on normalized ledgers.
-- Keeps car/vehicle settings in the backend-owned ledger row so saving car
-- information no longer depends on broad JSON mirror reconciliation.

alter table public.ledgers
  add column if not exists vehicle_plate text not null default '',
  add column if not exists vehicle_info jsonb not null default '{}'::jsonb,
  add column if not exists vehicle_lookup_source text not null default 'manual',
  add column if not exists vehicle_lookup_at timestamptz;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('038_vehicle_settings_columns', 'Store sanitized vehicle settings on normalized ledger rows for backend-owned settings saves.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

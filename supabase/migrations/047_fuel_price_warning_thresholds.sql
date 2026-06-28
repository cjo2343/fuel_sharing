-- Migration 047: Fuel-price warning thresholds + sanity check config on ledgers.
-- Adds per-workspace fuel-price warning bounds (DKK/L) and a real-world
-- consumption sanity tolerance, with sensible global defaults. Read by the
-- native fuel-entry validation (price out of [low, high] is flagged; the
-- consumption sanity check compares real L/100 km vs the car estimate within
-- the threshold percentage). Per-workspace operator override UI is a separate
-- ticket (blocked on cross-workspace write); these defaults apply app-wide.

alter table public.ledgers
  add column if not exists fuel_price_warn_low numeric(10,2) not null default 8.00,
  add column if not exists fuel_price_warn_high numeric(10,2) not null default 25.00,
  add column if not exists fuel_sanity_threshold_pct numeric(6,2) not null default 70;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('047_fuel_price_warning_thresholds', 'Add fuel_price_warn_low/high (DKK/L bounds) and fuel_sanity_threshold_pct (real-world consumption tolerance) to ledgers, with global defaults 8.00 / 25.00 / 70.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

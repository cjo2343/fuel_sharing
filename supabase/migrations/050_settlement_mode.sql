-- Migration 050: Settlement mode (monthly vs running) on ledgers.
-- Lets a workspace owner choose how settlement periods behave:
--   'monthly' (default) — close on a cadence; the monthly close nudge (GVM-60)
--      fires and produces clean per-month snapshots. Matches the v1 prototype.
--   'running' — debts accumulate in the single open period and members settle
--      ad hoc; the monthly nudge stays silent and close becomes a rare manual
--      "archive" action. The data model is unchanged (one open period per
--      ledger, label stamped at close); this flag only drives cadence + the
--      Pay-screen layout (GVM-76). Owner-only writes are enforced by the
--      existing "Ledger admins can update ledgers" RLS policy.

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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('050_settlement_mode', 'Add settlement_mode (monthly|running, default monthly) to ledgers — owner-chosen settlement cadence driving the monthly close nudge and Pay-screen layout.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

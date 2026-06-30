-- Migration 048: Allow console-level (cross-workspace) owner activity log rows.
-- The owner API audits every call into owner_activity_log (GV-148), but the
-- operator console's list endpoints (/api/owner/workspaces, /api/owner/errors)
-- are not scoped to a single workspace and so have no ledger_id. ledger_id was
-- NOT NULL, which blocked auditing exactly those cross-workspace reads — the
-- privacy-sensitive ones (they enumerate every workspace + contact email).
--
-- Make ledger_id nullable: NULL now means "console-level / cross-workspace owner
-- action, not tied to one workspace". The FK (on delete cascade) is unaffected —
-- a nullable FK column is still validated when set. Safe to rerun.

alter table public.owner_activity_log
  alter column ledger_id drop not null;

comment on column public.owner_activity_log.ledger_id is
  'Workspace this action concerned, or NULL for console-level / cross-workspace owner actions (e.g. listing all workspaces).';

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('048_owner_activity_log_nullable_ledger', 'Make owner_activity_log.ledger_id nullable so cross-workspace owner-console reads (workspace/errors lists) can be audited (GV-148).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

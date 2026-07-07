-- Migration 093: grant execute on claim_due_settlement_confirmations to service_role (Codex P1)
--
-- Migration 090 created the auto-confirm sweep and revoked PUBLIC/anon, but — unlike
-- the other scheduled claim RPCs (claim_due_payment_reminders / claim_due_close_reminders,
-- migration 082) — never granted EXECUTE to service_role. The daily scheduler calls it
-- with the service-role key, so without this grant the call leans on Supabase's implicit
-- service_role privileges and is fragile (could break after a permissions change / on a
-- fresh project). Make it explicit, matching every other claim_due_* engine RPC. The
-- GV-211 revoke guard is extended (test-security-definer-revokes.mjs) to require this.

grant execute on function public.claim_due_settlement_confirmations(integer, integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('093_grant_settlement_confirmations_service_role',
        'Grant execute on claim_due_settlement_confirmations to service_role (Codex P1) — matches the other claim_due_* scheduled RPCs; migration 090 revoked PUBLIC but never granted service_role.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

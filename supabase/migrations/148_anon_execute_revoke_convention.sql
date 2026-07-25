-- Migration 148: revoke execute from anon on every remaining security-definer function (GV-380)
--
-- Convention only. No function body, signature, grant to `authenticated` or grant to
-- `service_role` changes here; the sole effect is that the `anon` role loses EXECUTE on
-- the functions that still had it by inheritance.
--
-- WHY THIS IS NOT COSMETIC. The premise on the ticket was that `revoke ... from public`
-- already covers anon in the real Supabase and that only a plain-Postgres replay differs.
-- That is wrong, and it is worth writing down. Supabase's project bootstrap runs
--
--   alter default privileges in schema public grant execute on functions
--     to anon, authenticated, service_role;
--
-- so every function created in `public` gets an EXPLICIT anon entry in its ACL at
-- creation time. `revoke ... from public` removes the PUBLIC entry and leaves that
-- explicit anon grant untouched. tools/test-rls-role-matrix.mjs replays with exactly
-- those default privileges precisely because they are what production has. Verified on
-- a Postgres 17 replay of both paths (all migrations, and supabase-schema.sql — the two
-- produced an identical ACL end state): 36 of 103 functions in `public` were still
-- anon-executable, `upsert_ledger_member_admin` among them. So this is a real production
-- grant being removed, not a replay-fidelity nit.
--
-- Harmless in practice either way — each of these is `security definer` and gates itself
-- (`is_ledger_admin`, an active-member check, or an `auth.uid()` test), so an anon caller
-- was already rejected on the first statement. What changes is that the rejection now
-- comes from the privilege system instead of from the function body.
--
-- WHY IT IS ALSO BEHAVIOUR-NEUTRAL, checked rather than assumed:
--   * Every RLS policy that calls one of these helpers (is_ledger_member,
--     is_ledger_admin, current_ledger_member_id, can_manage_trip) is declared
--     `to authenticated`. anon matches no such policy, so it never evaluates those
--     expressions and never needed EXECUTE on them. The five policies that are not
--     role-scoped (expo_push_tokens, notification_preferences,
--     settlement_request_events, vehicle_incidents, vehicle_incident_photos) either
--     call no public function at all (auth.uid() only) or sit on a table anon has no
--     grant on, where the table-privilege check fires first.
--   * Trigger functions do not re-check EXECUTE when the trigger fires; the check
--     happens once, at CREATE TRIGGER. Migrations 120, 123 and 137 already revoked
--     these from anon AND authenticated while authenticated writes kept firing them
--     green in the role matrix, which is the proof.
--   * Nested calls from inside another `security definer` body run as the owner, not
--     as anon, so in-SQL callers are unaffected.
--
-- DELIBERATELY NOT INCLUDED: public.current_user_email() and
-- public.is_valid_payment_status_transition(text, text). They are the only two
-- functions in `public` that still carry a PUBLIC grant, and they are `security
-- invoker`, not `security definer` — outside this ticket's scope. Revoking anon alone
-- would be a no-op on them anyway (anon would keep EXECUTE through PUBLIC), so a fix
-- means revoking PUBLIC, which is a behaviour change and belongs in its own ticket.

revoke execute on function public.add_incident_photo(uuid, text) from anon;
revoke execute on function public.can_manage_car_booking(uuid) from anon;
revoke execute on function public.can_manage_fuel_payment(uuid) from anon;
revoke execute on function public.can_manage_trip(uuid) from anon;
revoke execute on function public.current_ledger_member_id(text) from anon;
revoke execute on function public.delete_incident_photo(uuid) from anon;
revoke execute on function public.delete_push_token(text) from anon;
revoke execute on function public.emit_inspection_due_event(text) from anon;
revoke execute on function public.enforce_identity_reassignment() from anon;
revoke execute on function public.enforce_settlement_request_integrity() from anon;
revoke execute on function public.get_notification_preferences() from anon;
revoke execute on function public.is_ledger_admin(text) from anon;
revoke execute on function public.is_ledger_member(text) from anon;
revoke execute on function public.lock_ledger_bootstrap_when_admin_email_attached() from anon;
revoke execute on function public.log_vehicle_incident(text, date, text, text, uuid, uuid, uuid, integer, text, text, text, text) from anon;
revoke execute on function public.member_belongs_to_ledger(uuid, text) from anon;
revoke execute on function public.member_is_active_in_ledger(uuid, text) from anon;
revoke execute on function public.prevent_overlapping_car_bookings() from anon;
revoke execute on function public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint, boolean) from anon;
revoke execute on function public.settlement_entry_is_locked(text, uuid) from anon;
revoke execute on function public.soft_delete_car_booking(text, text) from anon;
revoke execute on function public.soft_delete_recurring_expense(text, uuid) from anon;
revoke execute on function public.soft_delete_workspace_expense(text, uuid) from anon;
revoke execute on function public.touch_member_presence(text) from anon;
revoke execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) from anon;
revoke execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) from anon;
revoke execute on function public.update_vehicle_incident(uuid, text, text, text, text, uuid, date, integer, text, text) from anon;
revoke execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) from anon;
revoke execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) from anon;
revoke execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) from anon;
revoke execute on function public.upsert_push_token(text, text) from anon;
revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[], text) from anon;
revoke execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) from anon;
revoke execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) from anon;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '148_anon_execute_revoke_convention',
  'GV-380: applies the explicit anon-revoke convention (migrations 114/144/146) backwards to the 34 security-definer functions in public that still carried EXECUTE for anon. Nothing else changes -- no body, no signature, no authenticated or service_role grant. The ticket assumed "revoke from public" already covered anon in production and that only a plain-Postgres replay differed; that is wrong. Supabase''s bootstrap sets ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role in schema public, so every function is created with an explicit anon ACL entry that a PUBLIC revoke does not touch -- which is exactly why tools/test-rls-role-matrix.mjs installs those same default privileges. Verified against a replayed Postgres 17 catalog rather than migration text (later migrations revoke as well as grant, so the corpus is not the end state): both replay paths -- all migration files, and supabase-schema.sql -- produced an identical ACL end state in which 36 of 103 public functions were still anon-executable. Behaviour-neutral, checked three ways: every policy referencing one of these helpers is declared "to authenticated" so anon never evaluates it (the five policies without a role scope call only auth.uid(), or sit on tables anon has no grant on, where the table check fires first); trigger functions check EXECUTE at CREATE TRIGGER, not at fire time, which migrations 120/123/137 already relied on; and nested calls from inside another security-definer body run as the owner. current_user_email() and is_valid_payment_status_transition() are deliberately left alone -- they are security invoker and the only two functions still holding a PUBLIC grant, so revoking anon would be a no-op and revoking PUBLIC is a different, behaviour-changing ticket.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

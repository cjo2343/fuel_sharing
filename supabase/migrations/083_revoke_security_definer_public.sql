-- Migration 083: revoke EXECUTE from PUBLIC on all SECURITY DEFINER functions (GV-211)
--
-- In Postgres a newly created function grants EXECUTE to PUBLIC by default. Every
-- SECURITY DEFINER RPC in this schema therefore shipped executable by any role,
-- including anon — the internal is_ledger_* / RLS gates reject unauthorized callers,
-- but relying on that alone is not defence in depth. This migration standardises the
-- explicit revoke that later migrations (078/082) already started, across every
-- SECURITY DEFINER function, and re-grants EXECUTE to the roles that legitimately
-- need it:
--   * client-callable RPCs -> authenticated (matches their existing grants; the one
--     exception is close_settlement_period, which the mobile client calls via
--     supabase.rpc() but was only reachable through the default PUBLIC grant — it is
--     granted to authenticated here so period-close keeps working after the revoke).
--   * check_ledger_invite_email is also re-granted to anon (pre-auth invite preflight).
--   * trigger functions, RLS/auth helpers, and service-role-only RPCs get NO
--     authenticated grant — they run inside SECURITY DEFINER bodies / as service_role,
--     which retain EXECUTE as owner.
--
-- This changes only privileges; no function body is re-declared. tools/test-security-
-- definer-revokes.mjs guards against any future SECURITY DEFINER function shipping
-- without a matching revoke.

revoke execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from public;
grant execute on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) to authenticated;
revoke execute on function public.calculate_period_entry_fingerprint(text, uuid) from public;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;
revoke execute on function public.calculate_period_settlement(text, uuid) from public;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;
revoke execute on function public.can_manage_car_booking(uuid) from public;
revoke execute on function public.can_manage_fuel_payment(uuid) from public;
revoke execute on function public.can_manage_trip(uuid) from public;
revoke execute on function public.check_ledger_invite_email(text, text) from public;
grant execute on function public.check_ledger_invite_email(text, text) to authenticated;
grant execute on function public.check_ledger_invite_email(text, text) to anon;
revoke execute on function public.check_owner_rate_limit(text, text, integer, integer) from public;
revoke execute on function public.claim_due_close_reminders(integer) from public;
revoke execute on function public.claim_due_payment_reminders(integer) from public;
revoke execute on function public.close_settlement_period(text, uuid, jsonb) from public;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;
revoke execute on function public.create_ledger_invite(text, text, text, integer, integer) from public;
grant execute on function public.create_ledger_invite(text, text, text, integer, integer) to authenticated;
revoke execute on function public.create_private_ledger_workspace(text, text) from public;
grant execute on function public.create_private_ledger_workspace(text, text) to authenticated;
revoke execute on function public.current_ledger_member_id(text) from public;
revoke execute on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
revoke execute on function public.delete_push_token(text) from public;
grant execute on function public.delete_push_token(text) to authenticated;
revoke execute on function public.emit_inspection_due_event(text) from public;
grant execute on function public.emit_inspection_due_event(text) to authenticated;
revoke execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from public;
grant execute on function public.enforce_onboarding_rate_limit(text, text, integer, integer) to authenticated;
revoke execute on function public.enforce_settlement_entry_lock() from public;
revoke execute on function public.enforce_settlement_request_integrity() from public;
revoke execute on function public.fuel_ledger_healthcheck(text) from public;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;
revoke execute on function public.generate_due_recurring_expenses(text) from public;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;
revoke execute on function public.generate_workspace_join_code() from public;
revoke execute on function public.get_workspace_join_code(text) from public;
grant execute on function public.get_workspace_join_code(text) to authenticated;
revoke execute on function public.hash_ledger_invite_code(text) from public;
grant execute on function public.hash_ledger_invite_code(text) to authenticated;
revoke execute on function public.insert_repair(text, date, text, numeric, integer) from public;
grant execute on function public.insert_repair(text, date, text, numeric, integer) to authenticated;
revoke execute on function public.is_ledger_admin(text) from public;
revoke execute on function public.is_ledger_bootstrap_open(text) from public;
revoke execute on function public.is_ledger_member(text) from public;
revoke execute on function public.is_operator_context() from public;
grant execute on function public.is_operator_context() to authenticated;
revoke execute on function public.list_my_ledgers() from public;
grant execute on function public.list_my_ledgers() to authenticated;
revoke execute on function public.lock_ledger_bootstrap_when_admin_email_attached() from public;
revoke execute on function public.mark_messages_read(text) from public;
grant execute on function public.mark_messages_read(text) to authenticated;
revoke execute on function public.member_belongs_to_ledger(uuid, text) from public;
revoke execute on function public.member_is_active_in_ledger(uuid, text) from public;
revoke execute on function public.post_message(text, text) from public;
grant execute on function public.post_message(text, text) to authenticated;
revoke execute on function public.prevent_overlapping_car_bookings() from public;
revoke execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
revoke execute on function public.production_activity_reset(text) from public;
grant execute on function public.production_activity_reset(text) to authenticated;
revoke execute on function public.purge_generated_test_rows(text, boolean) from public;
grant execute on function public.purge_generated_test_rows(text, boolean) to authenticated;
revoke execute on function public.redeem_ledger_invite(text, text) from public;
grant execute on function public.redeem_ledger_invite(text, text) to authenticated;
revoke execute on function public.resolve_ledger_invite(text) from public;
grant execute on function public.resolve_ledger_invite(text) to authenticated;
revoke execute on function public.revoke_ledger_invite(text, uuid) from public;
grant execute on function public.revoke_ledger_invite(text, uuid) to authenticated;
revoke execute on function public.rotate_workspace_join_code(text) from public;
grant execute on function public.rotate_workspace_join_code(text) to authenticated;
revoke execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
revoke execute on function public.save_scheduled_reminder_state(text, jsonb) from public;
revoke execute on function public.scheduled_reminder_state(text) from public;
revoke execute on function public.set_close_reminder_enabled(text, boolean) from public;
grant execute on function public.set_close_reminder_enabled(text, boolean) to authenticated;
revoke execute on function public.set_ledger_member_active_admin(text, uuid, boolean) from public;
grant execute on function public.set_ledger_member_active_admin(text, uuid, boolean) to authenticated;
revoke execute on function public.set_member_name(text, uuid, text, text, text) from public;
grant execute on function public.set_member_name(text, uuid, text, text, text) to authenticated;
revoke execute on function public.settlement_entry_is_locked(text, uuid) from public;
revoke execute on function public.soft_delete_car_booking(text, text) from public;
grant execute on function public.soft_delete_car_booking(text, text) to authenticated;
revoke execute on function public.soft_delete_recurring_expense(text, uuid) from public;
grant execute on function public.soft_delete_recurring_expense(text, uuid) to authenticated;
revoke execute on function public.soft_delete_workspace_expense(text, uuid) from public;
grant execute on function public.soft_delete_workspace_expense(text, uuid) to authenticated;
revoke execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) from public;
grant execute on function public.update_ledger_insurance(text, text, text, text, date, numeric, numeric, text, text) to authenticated;
revoke execute on function public.update_ledger_settings(text, text, jsonb, jsonb) from public;
grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb) to authenticated;
revoke execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) from public;
grant execute on function public.update_ledger_vehicle(text, text, jsonb, text, timestamptz, text, numeric, numeric, text, text, text) to authenticated;
revoke execute on function public.update_own_ledger_member_mobilepay(text, text) from public;
grant execute on function public.update_own_ledger_member_mobilepay(text, text) to authenticated;
revoke execute on function public.update_own_ledger_member_profile(text, text, text) from public;
grant execute on function public.update_own_ledger_member_profile(text, text, text) to authenticated;
revoke execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) from public;
grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) to authenticated;
revoke execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) from public;
grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean, text, text) to authenticated;
revoke execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) from public;
grant execute on function public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean) to authenticated;
revoke execute on function public.upsert_push_token(text, text) from public;
grant execute on function public.upsert_push_token(text, text) to authenticated;
revoke execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) from public;
grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;
revoke execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) from public;
grant execute on function public.upsert_settlement_request_status(text, uuid, uuid, uuid, numeric, text, text, text[]) to authenticated;
revoke execute on function public.upsert_test_lab_report(text, text, jsonb) from public;
grant execute on function public.upsert_test_lab_report(text, text, jsonb) to authenticated;
revoke execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) from public;
grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], text, text) to authenticated;
revoke execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) from public;
grant execute on function public.upsert_workspace_expense(text, uuid, uuid, text, text, numeric, date, text, jsonb, uuid, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('083_revoke_security_definer_public',
        'Revoke EXECUTE from PUBLIC on all SECURITY DEFINER functions + re-grant client RPCs to authenticated (GV-211).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

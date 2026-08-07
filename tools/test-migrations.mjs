import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { trackerInsertedIds } from "./lib/tracker-insert-scan.mjs";

const migrationDir = "supabase/migrations";
assert.ok(existsSync(migrationDir), "supabase/migrations directory must exist");

const files = readdirSync(migrationDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const expected = [
  "001_initial_schema.sql",
  "002_auth_helpers.sql",
  "003_payment_booking_guards.sql",
  "004_period_close_and_admin_rpcs.sql",
  "005_rls_policies.sql",
  "006_realtime_ledger_events.sql",
  "007_security_health_rpc.sql",
  "008_scheduled_reminder_rpcs.sql",
  "009_retention_privacy_cleanup.sql",
  "010_trip_transaction_rpc.sql",
  "011_booking_transaction_rpcs.sql",
  "012_admin_tools_guardrails.sql",
  "013_fuel_payment_rpc.sql",
  "014_rpc_health_visibility.sql",
  "015_test_lab_report_store.sql",
  "016_realtime_publication_health.sql",
  "017_healthcheck_rpc_detection_fix.sql",
  "018_realtime_publication_cleanup.sql",
  "019_immutable_test_lab_report_history.sql",
  "020_bootstrap_lock.sql",
  "021_cloud_test_lab_report_retention.sql",
  "022_settlement_request_transaction_rpc.sql",
  "023_schema_migration_tracking.sql",
  "024_schema_drift_healthcheck.sql",
  "025_workspace_foundation.sql",
  "026_invite_onboarding_foundation.sql",
  "027_invite_code_generation_pgcrypto_fix.sql",
  "028_invite_code_hash_pgcrypto_fix.sql",
  "029_invite_redeem_return_ambiguity_fix.sql",
  "030_onboarding_abuse_rate_limits.sql",
  "031_payment_status_action_rpc.sql",
  "032_security_health_current_migration_expectations.sql",
  "033_onboarding_rate_limit_scope_key_alignment.sql",
  "034_invite_rate_limit_actor_email_ambiguity_fix.sql",
  "035_sql_ambiguity_guardrail.sql",
  "036_invite_profile_setup.sql",
  "037_invite_email_preflight.sql",
  "038_vehicle_settings_columns.sql",
  "039_list_my_ledgers_dedup.sql",
  "040_workspace_identity_hardening.sql",
  "041_owner_activity_log.sql",
  "042_member_invite_only_creation_lockdown.sql",
  "043_car_maintenance_repairs_insurance.sql",
  "044_messages_chat.sql",
  "045_invite_short_codes_and_resolve.sql",
  "046_settlement_safety_rails.sql",
  "047_fuel_price_warning_thresholds.sql",
  "048_owner_activity_log_nullable_ledger.sql",
  "049_owner_api_rate_limit.sql",
  "050_settlement_mode.sql",
  "051_activity_events_for_trip_fuel_booking.sql",
  "052_activity_events_for_workspace_and_vehicle.sql",
  "053_seed_open_period_on_workspace_create.sql",
  "054_settlement_integrity_rails.sql",
  "055_integrity_function_gates.sql",
  "056_delete_my_account.sql",
  "057_expo_push_tokens.sql",
  "058_resolve_invite_volatile_fix.sql",
  "059_member_joined_event.sql",
  "060_allow_cancel_open_request.sql",
  "061_redeem_invite_display_name.sql",
  "062_drop_user_gps_from_fuel.sql",
  "063_booking_fuel_stop.sql",
  "064_insurance_details.sql",
  "065_workspace_expenses.sql",
  "066_expense_paid_by.sql",
  "067_expense_period.sql",
  "068_settlement_expenses.sql",
  "069_recurring_expenses.sql",
  "070_restore_integrity_gates.sql",
  "071_drop_fuel_gps_columns.sql",
  "072_review_hardening.sql",
  "073_recurring_semiannual_cadence.sql",
  "074_inspection_due_event.sql",
  "075_restore_recurring_and_expense_gates.sql",
  "076_member_mobilepay_self_update.sql",
  "077_active_member_expense_writes.sql",
  "078_rpc_write_pattern.sql",
  "079_set_member_name.sql",
  "080_close_reminder_push.sql",
  "081_payment_reminders.sql",
  "082_reminder_claim_hardening.sql",
  "083_revoke_security_definer_public.sql",
  "084_require_request_before_paid.sql",
  "085_reconcile_settlement_pair_index.sql",
  "086_settlement_status_update_not_upsert.sql",
  "087_settlement_events_for_realtime.sql",
  "088_fix_trip_participants_period_check.sql",
  "089_settlement_status_on_closed_period.sql",
  "090_settlement_paid_pending.sql",
  "091_reminder_activity_events.sql",
  "092_tank_baseline.sql",
  "093_grant_settlement_confirmations_service_role.sql",
  "094_app_announcements.sql",
  "095_notification_preferences.sql",
  "096_purge_notification_preferences_on_delete.sql",
  "097_tighten_trips_read_policy.sql",
  "098_settlement_rule_overrides.sql",
  "099_rls_security_fixes.sql",
  "100_fix_rate_limit_ambiguity.sql",
  "101_reassignment_and_close_invariants.sql",
  "102_reminder_claim_confirm.sql",
  "103_security_hardening.sql",
  "104_settlement_amount_integrity.sql",
  "105_repair_workshop.sql",
  "106_reminder_outcomes_claim_token.sql",
  "107_repairs_split_mode.sql",
  "108_repair_payer_and_lr_splits.sql",
  "109_notification_snooze_quiet_hours.sql",
  "110_generate_recurring_scheduler.sql",
  "111_member_last_seen.sql",
  "112_release_blockers_remediation.sql",
  "113_close_reminder_running_mode.sql",
  "114_repair_period_binding_and_deactivation.sql",
  "115_payment_evidence_notes.sql",
  "116_recurring_generation_lock_skip.sql",
  "117_settlement_integrity_hardening.sql",
  "118_confirm_receipt_reminders.sql",
  "119_settings_change_events.sql",
  "120_settlement_immutability_and_close_lock.sql",
  "121_settlement_period_boundary.sql",
  "122_settlement_transition_commands.sql",
  "123_booking_trip_link.sql",
  "124_booking_completion_reminders.sql",
  "125_ledger_fuel_settings_boundary.sql",
  "126_atomic_app_announcements.sql",
  "127_owner_settlement_integrity_batch.sql",
  "128_allow_retiring_linked_trips.sql",
  "129_owner_workspace_overview.sql",
  "130_operational_retention.sql",
  "131_gdpr_retention_policy.sql",
  "132_workspace_lifecycle.sql",
  "133_workspace_lifecycle_hardening.sql",
  "134_decommissioned_workspace_notices.sql",
  "135_workspace_decommission_attestation.sql",
  "136_atomic_booking_fuel_completion.sql",
  "137_settlement_event_history.sql",
  "138_vehicle_incidents.sql",
  "139_incident_photo_storage_hardening.sql",
  "140_late_entry_carryover.sql",
  "141_close_guard_retention_and_period_lockdown.sql",
  "142_recurring_generation_carryover.sql",
  "143_drop_production_reset_and_sweep_visibility.sql",
  "144_close_deferred_booking_fuel.sql",
  "145_member_upsert_recurring_suspension.sql",
  "146_acknowledge_inspection_booking.sql",
  "147_retire_dead_rpcs_and_legacy_push_subscriptions.sql",
  "148_anon_execute_revoke_convention.sql",
  "149_rate_limit_actor_pseudonymisation.sql",
  "150_push_target_rpcs.sql",
  "151_drop_fuel_station_coordinates.sql",
  "152_booking_future_cap.sql",
  "153_weekly_registration_digest.sql",
  "154_booking_fuel_stop_reminders.sql",
  "155_tank_state_atomicity_and_tombstones.sql",
  "156_tank_model_revision.sql",
  "157_trip_crossing_cost.sql",
  "158_crossing_provided_contract.sql",
  "159_booking_day_and_horizon_caps.sql",
  "160_conflict_preconditions.sql",
  "161_newsletter_subscribers.sql",
  "162_booking_cap_lock_and_duration.sql",
  "163_newsletter_subscriber_counts.sql",
  "164_booking_handovers.sql",
  "165_newsletter_pending_purge_in_retention.sql",
  "166_incident_damage_kind_and_repair_link.sql",
  "167_vehicle_current_location.sql",
  "168_parking_pin.sql",
  "169_fuel_payment_receipts.sql",
  "170_handover_parking_pin.sql",
  "171_receipt_rpc_locking.sql",
  "172_handover_stale_location_guard.sql",
  "173_newsletter_send_tokens.sql",
  "174_handover_mirror_race_free.sql",
  "175_per_send_unsubscribe_tokens.sql",
  "176_send_log_retention.sql",
  "177_receipt_upload_quota.sql",
  "178_incident_photo_upload_quota.sql",
  "179_batched_newsletter_send.sql",
  "180_newsletter_send_job_status.sql",
  "181_harden_newsletter_send_job.sql",
  "182_handover_observed_at.sql",
  "184_upload_quota_atomic.sql",
];

assert.deepEqual(files, expected, "migration files must be present and ordered");

files.forEach((file, index) => {
  const expectedPrefix = String(index + 1).padStart(3, "0");
  assert.ok(file.startsWith(`${expectedPrefix}_`), `${file} should start with ${expectedPrefix}_`);
  const content = readFileSync(join(migrationDir, file), "utf8");
  assert.ok(content.trim().length > 0, `${file} must not be empty`);
  // CLAUDE.md and the /new-migration skill both say the header must be the FIRST
  // line. This used to test with the `m` flag, so a header on line 40 passed just
  // as happily — the doc was stricter than the guard (GV-393). All 147 migrations
  // already complied, so the guard now enforces the documented rule instead.
  const firstLine = content.split("\n")[0];
  assert.ok(
    /^-- Migration \d{3}:/.test(firstLine),
    `${file}: the first line must be "-- Migration ${file.slice(0, 3)}: <description>" ` +
      `(found: ${JSON.stringify(firstLine.slice(0, 60))})`,
  );
  assert.ok(
    firstLine.startsWith(`-- Migration ${file.slice(0, 3)}:`),
    `${file}: the header names a different migration number than the filename (${JSON.stringify(firstLine.slice(0, 60))})`,
  );
});

// Each migration must actually INSERT its own id into the tracker — not merely
// mention it. `content.includes(migrationId)` used to be the test, and a migration id
// is a plausible substring of a dozen innocent things: a `-- see migration 033`
// comment, a tracker description narrating an earlier migration, or (the case that
// bit us) fuel_ledger_healthcheck's own `expected_schema_migrations` VALUES list,
// which several migrations in the 023–037 range carry inside a dollar-quoted body.
// trackerInsertedIds() reads real INSERT statements, so none of those count (GV-392).
files.forEach((file) => {
  const migrationNumber = Number(file.slice(0, 3));
  if (migrationNumber >= 23) {
    const content = readFileSync(join(migrationDir, file), "utf8");
    const migrationId = file.replace(/\.sql$/, "").replace(/^0*(\d+)_/, (match, number) => `${number.padStart(3, "0")}_`);
    assert.ok(
      content.includes("public.fuel_ledger_schema_migrations"),
      `${file} should update the Fuel Ledger schema migration tracker`,
    );
    assert.ok(
      trackerInsertedIds(content).has(migrationId),
      `${file} should insert its own migration id (${migrationId}) into the tracker — ` +
        `mentioning it in a comment, a description or a healthcheck expectation list does not count`,
    );
  }
});

// Every `create policy` must be preceded by a matching `drop policy if exists`
// so the migration set replays cleanly on an empty DB (Supabase Preview CI
// replays all migrations from scratch). A bare create is not idempotent and
// fails with SQLSTATE 42710 on replay (GVM-68: 043/044 lacked these guards).
files.forEach((file) => {
  const content = readFileSync(join(migrationDir, file), "utf8");
  const creates = [...content.matchAll(/create policy\s+"([^"]+)"\s+on\s+(\S+)/gi)];
  const drops = new Set(
    [...content.matchAll(/drop policy if exists\s+"([^"]+)"\s+on\s+([^\s;]+)/gi)].map(
      (m) => `${m[1]}::${m[2]}`,
    ),
  );
  creates.forEach((m) => {
    const key = `${m[1]}::${m[2].replace(/;$/, "")}`;
    assert.ok(
      drops.has(key),
      `${file}: policy "${m[1]}" on ${m[2]} needs a "drop policy if exists" before its create (idempotent replay)`,
    );
  });
});

const migrationText = files.map((file) => readFileSync(join(migrationDir, file), "utf8")).join("\n");
const consolidatedSchema = readFileSync("supabase-schema.sql", "utf8");

assert.doesNotMatch(
  migrationText,
  /auth_user_id/,
  "migrations must not reference ledger_members.auth_user_id; live member auth is email-based",
);
assert.doesNotMatch(
  consolidatedSchema,
  /auth_user_id/,
  "consolidated schema must not reference ledger_members.auth_user_id; live member auth is email-based",
);

for (const marker of [
  "create table if not exists public.ledger_events",
  "create or replace function public.close_settlement_period(",
  "pg_try_advisory_xact_lock(hashtext(target_ledger_id))",
  "create or replace function public.fuel_ledger_healthcheck",
  "alter publication supabase_realtime add table public.ledger_events",
  "grant execute on function public.save_scheduled_reminder_state(text, jsonb) to service_role",
  "create or replace function public.preview_retention_cleanup",
  "create or replace function public.run_retention_cleanup",
  "create or replace function public.upsert_trip_with_participants",
  "grant execute on function public.upsert_trip_with_participants",
  "create or replace function public.upsert_car_booking",
  "create or replace function public.soft_delete_car_booking",
  "grant execute on function public.upsert_car_booking",
  "grant execute on function public.soft_delete_car_booking",
  "create or replace function public.upsert_fuel_payment",
  "grant execute on function public.upsert_fuel_payment",
  "critical_rpcs",
  "to_regprocedure('public.upsert_fuel_payment",
  "create table if not exists public.test_lab_reports",
  "create or replace function public.upsert_test_lab_report",
  "grant execute on function public.upsert_test_lab_report",
  "immutable_history",
  "to_regprocedure('public.upsert_test_lab_report",
  "realtime_publication",
  "recommended_tables",
  "ledger_events_enabled",
  "create or replace function public.upsert_ledger_member_admin",
  "create or replace function public.set_ledger_member_active_admin",
  "create or replace function public.purge_generated_test_rows",
  "grant execute on function public.upsert_ledger_member_admin",
  "critical_rpc_names",
  "from pg_proc p",
  "p.proname = rpc_name",
  "push_subscription_scope",
  "alter publication supabase_realtime drop table public.car_share_ledgers",
  "alter publication supabase_realtime add table public.ledger_events",
  "bootstrap_locked_at",
  "create or replace function public.lock_ledger_bootstrap_when_admin_email_attached",
  "create trigger lock_ledger_bootstrap_on_admin_email",
  "cloud Test Lab report history in retention cleanup",
  "test_lab_report_days",
  "keep_latest_test_lab_reports",
  "grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer)",
  "create or replace function public.upsert_settlement_request_status",
  "grant execute on function public.upsert_settlement_request_status",
  "upsert_settlement_request_status",
  "create table if not exists public.fuel_ledger_schema_migrations",
  "grant select on public.fuel_ledger_schema_migrations to authenticated",
  "'023_schema_migration_tracking'",
  "'schema_migrations'",
  "missing_migrations",
  "latest_expected",
  "'024_schema_drift_healthcheck'",
  "'schema_drift', jsonb_build_object",
  "expected_tables(table_name) as",
  "expected_columns(table_name, column_name) as",
  "expected_policies(table_name, policy_name) as",
  "missing_tables",
  "missing_columns",
  "missing_policies",
  "fuel_ledger_schema_migrations_admin_select",
  "027_invite_code_generation_pgcrypto_fix",
  "extensions.gen_random_bytes",
  "028_invite_code_hash_pgcrypto_fix",
  "extensions.digest",
  "029_invite_redeem_return_ambiguity_fix",
  "redeem_ledger_invite.ledger_id := redeemed_ledger_id",
  "030_onboarding_abuse_rate_limits",
  "create table if not exists public.ledger_onboarding_rate_limits",
  "create or replace function public.enforce_onboarding_rate_limit",
  "perform public.enforce_onboarding_rate_limit('create_private_workspace'",
  "perform public.enforce_onboarding_rate_limit('create_ledger_invite'",
  "perform public.enforce_onboarding_rate_limit('redeem_ledger_invite'",
  "abuse_rate_limit_ready",
  "031_payment_status_action_rpc",
  "create or replace function public.apply_payment_status_action",
  "grant execute on function public.apply_payment_status_action",
  "backend_action', 'apply_payment_status_action",
  "032_security_health_current_migration_expectations",
  "033_onboarding_rate_limit_scope_key_alignment",
  "034_invite_rate_limit_actor_email_ambiguity_fix",
  "035_sql_ambiguity_guardrail",
  "036_invite_profile_setup",
  "037_invite_email_preflight",
  "038_vehicle_settings_columns",
  "039_list_my_ledgers_dedup",
  "040_workspace_identity_hardening",
  "041_owner_activity_log",
  "create table if not exists public.owner_activity_log",
  "owner_activity_log_ledger_created_at_idx",
  "ledger_members_one_active_email_per_workspace_idx",
  "with ranked_members as",
  "bool_or(lm.role = 'admin')",
  "vehicle_plate",
  "vehicle_info",
  "create or replace function public.update_own_ledger_member_profile",
  "grant execute on function public.update_own_ledger_member_profile",
  "create or replace function public.check_ledger_invite_email",
  "grant execute on function public.check_ledger_invite_email(text, text) to anon",
  "safe_actor_email text := public.current_user_email()",
  "lower(safe_actor_email)",
  "safe_actor_email text := lower(coalesce(auth.jwt() ->> 'email', ''))",
  "apply_payment_status_action",
  "latest_expected', migration_status.latest_expected",
  "scope_key",
  "ledger_onboarding_rate_limits_scope_key_window_idx",
  "042_member_invite_only_creation_lockdown",
  "New members join by redeeming a workspace invite; member management can only update existing members",
  "046_settlement_safety_rails",
  "create or replace function public.settlement_entry_is_locked(",
  "create or replace function public.enforce_settlement_entry_lock()",
  "create trigger enforce_settlement_entry_lock_trips",
  "before insert or update or delete on public.trips",
  "047_fuel_price_warning_thresholds",
  "fuel_price_warn_low",
  "fuel_price_warn_high",
  "fuel_sanity_threshold_pct",
]) {
  assert.ok(migrationText.includes(marker), `migrations should include marker: ${marker}`);
  assert.ok(consolidatedSchema.includes(marker), `consolidated schema should include marker: ${marker}`);
}

assert.ok(
  !migrationText.includes("fuel_ledger_schema_migrations (migration_id, notes)"),
  "migrations should write schema migration tracking notes into the existing description column, not a non-existent notes column"
);
assert.ok(
  !consolidatedSchema.includes("fuel_ledger_schema_migrations (migration_id, notes)"),
  "consolidated schema should not reference a non-existent schema migration notes column"
);

// Every migration must be reflected in the consolidated supabase-schema.sql, at
// minimum by its tracker id (GV-157). This catches migrations that were applied
// + added to supabase/migrations/ but never mirrored into the consolidated
// fresh-DB schema (e.g. 048's ledger_id nullability change slipped through).
//
// This was `consolidatedSchema.includes(migrationId)` — a bare substring test — and
// GV-392 is what that cost. 024_schema_drift_healthcheck,
// 033_onboarding_rate_limit_scope_key_alignment and 036_invite_profile_setup each
// insert their own id in their own migration file, but supabase-schema.sql had no
// INSERT for any of them: replaying the migrations gave 146 tracker rows, replaying
// the consolidated schema gave 143, and a fresh install booted reporting three
// missing migrations against itself.
//
// The guard stayed green because those ids DO appear in supabase-schema.sql — inside
// fuel_ledger_healthcheck's `expected_schema_migrations` VALUES list. The substring
// satisfying this check was the expectation list of the drift detector that would
// have reported the failure. check-schema-equivalence.mjs could not catch it either:
// tracker rows are data and it dumps schema-only, deliberately.
//
// So the check now demands a real INSERT into public.fuel_ledger_schema_migrations
// carrying the id as a value. A mention inside a dollar-quoted function body, a
// comment or a description string no longer satisfies it.
const mirroredIds = trackerInsertedIds(consolidatedSchema);
files.forEach((file) => {
  const migrationId = file.replace(/\.sql$/, "");
  assert.ok(
    mirroredIds.has(migrationId),
    `${file} must be mirrored into supabase-schema.sql with a real tracker INSERT ` +
      `(no "insert into public.fuel_ledger_schema_migrations … '${migrationId}' …" found). ` +
      `Naming the id in a comment, a description, or fuel_ledger_healthcheck's ` +
      `expected_schema_migrations list does not mirror the migration — that is exactly ` +
      `how GV-392 hid three missing tracker rows.`,
  );
});

// The marker list above is a FROZEN spot-check of migrations 023–047, not coverage.
// It was written when 047 was the newest migration and was never extended; 100 later
// migrations (048–147) have no marker at all. That is fine — markers are a crude
// substring test and check-schema-equivalence.mjs does the real job, replaying both
// paths into Postgres and diffing all 513 objects including function bodies — but the
// success line used to claim the markers "cover critical schema markers", which reads
// like whole-schema coverage this file has never provided (GV-393). Say what it is.
console.log(
  "ok - migration files are present, ordered, headed, tracker-inserted, and mirrored " +
    "into supabase-schema.sql (+ a frozen 023–047 marker spot-check; whole-schema " +
    "equivalence is check-schema-equivalence.mjs's job, not this file's)",
);

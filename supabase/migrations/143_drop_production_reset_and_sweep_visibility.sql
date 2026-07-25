-- Migration 143: drop production_activity_reset, revoke unused client grants, count the recurring sweep's no-open-period ledgers (GV-361, GV-362)
--
-- Ancestry (the GV-359 lesson — always state it):
--   * fuel_ledger_healthcheck is re-declared off migration 037
--     (037_invite_email_preflight.sql), its newest prior definition. 014/017/024/032
--     declared earlier versions; nothing between 038 and 142 touches it. The body
--     below is 037 VERBATIM with exactly one line deleted — the
--     ('production_activity_reset') entry in critical_rpc_names.
--   * generate_all_due_recurring_expenses is re-declared off migration 142
--     (142_recurring_generation_carryover.sql), its newest prior definition
--     (110/112/114/116/142). The body below is 142 VERBATIM plus one counter.
--   * Nothing else here touches a function body — the rest is grants only.
--
-- ── GV-361 (a): production_activity_reset must go ───────────────────────────────
--
-- production_activity_reset(text) DELETEs every settlement_request, trip_participant,
-- trip, fuel_payment, car_booking and settlement_period belonging to a ledger, then
-- rewrites car_share_ledgers.state and opens a fresh period. Its only gate is
-- is_ledger_admin — no confirmation token, no dry run, no undo. That is a larger blast
-- radius than anything the product itself exposes to anyone.
--
-- It is also already broken, and already incomplete:
--   * Broken. Migrations 120/121 attached enforce_settlement_entry_lock and
--     assert_settlement_period_boundary to trips, fuel_payments and car_bookings.
--     Deleting an entry that belongs to a closed or entry-locked period is rejected
--     with 42501, so this function raises for any ledger that has ever closed a
--     period — i.e. every real ledger. Nothing has called it since.
--   * Incomplete. It never clears workspace_expenses or vehicle_repairs. Both carry
--     money, both post-date the function, and both are period-scoped, so a call that
--     got part-way would leave financial rows pointing at settlement_periods that no
--     longer exist.
--
-- No code in either client repo calls it. Verified read-only across govehlo-mobile and
-- govehlo-web: the only occurrences are in the vendored generated DB types, which are
-- type declarations, not call sites. Repairing it would mean designing a destructive
-- workspace-wipe feature nobody asked for; removing it is the correct move. Scoped,
-- audited deletion already exists — delete_my_account for a member, the migration
-- 132/133/135 workspace-lifecycle RPCs for a workspace.
--
-- Dropping it has one visible consequence, and this migration handles it:
-- fuel_ledger_healthcheck enumerates 'production_activity_reset' in critical_rpc_names,
-- so the diagnostic would report a deliberately removed RPC as a MISSING critical RPC —
-- a permanent false alarm for the operator, in the very SQL Editor session where this
-- migration gets applied. Migration 130 hit the same coupling and deferred its drops
-- for exactly this reason. So the healthcheck is re-declared here without that entry,
-- and the drop follows it.
--
-- ── GV-361 (b): `grant execute … to authenticated` with no caller ───────────────
--
-- Thirteen more functions carry the authenticated grant with no caller in either
-- client. Eleven are revoked here; the other two are left alone for reasons spelled
-- out at the end of this section. Each was verified twice before being revoked:
--   1. grep of govehlo-mobile and govehlo-web for the function name, discounting only
--      the vendored generated type files (govehlo-web/types/database.ts,
--      govehlo-mobile/src/types/database.ts and .../database.generated.ts) — those
--      declare every RPC in the schema and are never call sites; and
--   2. grep of supabase/migrations/ + supabase-schema.sql for in-SQL callers, plus a
--      check that every caller found is SECURITY DEFINER (it therefore runs as the
--      function owner and never consults the authenticated grant) and that no RLS
--      policy references the function.
--
-- Helpers whose only callers are SECURITY DEFINER bodies:
--   hash_ledger_invite_code(text) — called by create_ledger_invite,
--     redeem_ledger_invite, resolve_ledger_invite and check_ledger_invite_email. The
--     most real of the set: the grant let any signed-in client compute invite-code
--     hashes offline and match them against ledger_invites.invite_code_hash without
--     ever calling redeem — i.e. brute-force a short join code with no rate limit.
--   normalize_ledger_slug(text) — called by create_private_ledger_workspace.
--   enforce_onboarding_rate_limit(text, text, integer, integer) — called by
--     create_private_ledger_workspace, create_ledger_invite, redeem_ledger_invite,
--     resolve_ledger_invite and rotate_workspace_join_code. The grant let a client
--     burn any scope key's onboarding budget directly.
--
-- Functions with no caller at all, in SQL or in either client:
--   apply_payment_status_action(...) — superseded by upsert_settlement_request_status
--     and transition_settlement_request(s)_status.
--   check_ledger_invite_email(text, text) — revoked from anon as well as
--     authenticated; an unauthenticated invite-code + email probe with no consumer.
--   create_ledger_invite(text, text, text, integer, integer) and
--     revoke_ledger_invite(text, uuid) — the email-restricted invite path. Live
--     joining runs on get_workspace_join_code / rotate_workspace_join_code plus
--     resolve_ledger_invite / redeem_ledger_invite, all of which keep their grants.
--   update_own_ledger_member_profile(text, text, text) — superseded by set_member_name
--     and update_own_ledger_member_mobilepay, which are the ones the app calls.
--   upsert_test_lab_report(text, text, jsonb) and
--     purge_generated_test_rows(text, boolean) — legacy PWA test-lab tooling
--     (migrations 015/012), orphaned when the legacy runtime was archived in GV-266.
--   fuel_ledger_healthcheck(text) — an operator diagnostic. It is run in the SQL
--     Editor as the owner, which owns the function and is unaffected by this revoke.
--
-- Every one of these functions stays DEFINED. This only removes EXECUTE from anon and
-- authenticated, so restoring any of them is a one-line grant if a client ever wires
-- it up.
--
-- Deliberately NOT revoked, even though they too have no client caller:
--   is_operator_context() — only SECURITY DEFINER callers, but it is a zero-argument
--     boolean predicate of exactly the shape used in RLS `using ()` clauses, and this
--     repo has a documented history of production RLS policies drifting from the
--     migration files (the 103 / PR #117 lesson, restated by migration 141's dynamic
--     pg_policies sweep). A prod-only policy referencing it would begin failing for
--     every authenticated read, and the grant leaks nothing — the function reports
--     whether the caller's own request carries a user JWT.
--   calculate_period_entry_fingerprint(text, uuid) — called in SQL only by
--     close_settlement_period, close_settlement_period_unlocked and
--     owner_settlement_integrity_batch, and by no client (govehlo-mobile computes the
--     fingerprint locally in src/lib/period-snapshot.ts; govehlo-web's owner endpoint
--     goes through the batch RPC and test/owner-scale.test.mjs asserts the handler
--     does NOT call this one). But this repo's own RLS role-matrix guard,
--     tools/test-rls-role-matrix.mjs, calls it AS `authenticated` in five cases to
--     build the snapshot it feeds to close_settlement_period — revoking turned those
--     cases red. The function has carried a member/operator gate since migration 055
--     (restored in 078), so the grant buys a member the ability to fingerprint a
--     period in their own workspace and nothing else. Rewriting a 166-case security
--     guard to remove that is the wrong trade.
--   set_ledger_member_active_admin(text, uuid, boolean) — same shape. No client caller
--     (both clients deactivate through upsert_ledger_member_admin's is_active
--     parameter), but the role matrix exercises it as an authenticated admin to assert
--     GV-277's payer-deactivation recurring suspension. It is admin-gated and strictly
--     weaker than upsert_ledger_member_admin, which keeps its grant, so revoking it
--     would remove no capability an admin does not already have.
--
-- ── GV-362: the recurring sweep's silent path ───────────────────────────────────
--
-- generate_all_due_recurring_expenses re-reads the ledger's open period under FOR
-- SHARE after the candidate scan has already required one to exist, so reaching
-- `open_period_id is null` means a close committed in the gap. That branch does a bare
-- `continue` and increments nothing — the pattern dates to migration 116 and survived
-- 142 — so the sweep's own totals cannot distinguish "nothing was due for this ledger"
-- from "we walked away from this ledger".
--
-- Since 142 deleted the entry-lock short-circuits that used to feed ledgers_skipped,
-- that key is now purely the per-ledger failure counter; folding the no-open-period
-- case into it would re-create the same ambiguity one level down. So this adds a
-- distinct key instead: ledgers_no_open_period. Every existing key — generated,
-- ledgers_touched, ledgers_scanned, ledgers_skipped, first_error — keeps its exact
-- meaning, so /api/hooks/recurring-generate in govehlo-web reads today what it read
-- yesterday.
--
-- ── Outstanding follow-ups this migration deliberately does NOT do ──────────────
--
-- Both live in client repos that other work owns right now, and both must land before
-- the cross-repo check goes green:
--   * govehlo-web functions/api/owner/migrations.js — bump EXPECTED_LATEST_MIGRATION
--     to 143, or the admin Health page under-reports drift.
--   * re-vendor this repo's regenerated types/database.ts into govehlo-mobile and
--     govehlo-web.

-- ── fuel_ledger_healthcheck — stop enumerating a function this migration removes ─
-- Re-declared off migration 037 (its newest prior definition). The body is 037
-- VERBATIM apart from a single deleted line: the ('production_activity_reset') entry
-- in critical_rpc_names. Without this, the diagnostic would report the RPC dropped
-- below as a missing critical RPC forever. The grant is tightened afterwards — the
-- healthcheck has no client caller and is run by the owner in the SQL Editor.
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('update_own_ledger_member_profile'),
      ('check_ledger_invite_email'),
      ('purge_generated_test_rows'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite'),
      ('apply_payment_status_action')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix'),
      ('035_sql_ambiguity_guardrail'),
      ('036_invite_profile_setup'),
      ('037_invite_email_preflight')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('push_subscriptions', 'user_email'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'check_ledger_invite_email'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;

-- `create or replace` preserves the existing ACL, so the 083 grant survives it and has
-- to be removed explicitly. No client calls this RPC; the owner runs it in the SQL
-- Editor and owns the function, so owner access is unaffected.
revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
revoke all on function public.fuel_ledger_healthcheck(text) from authenticated;

-- ── Drop production_activity_reset ───────────────────────────────────────────────
-- Admin-gated whole-ledger wipe with no confirmation token, already unusable since
-- migrations 120/121 (the entry-lock trigger rejects its DELETEs on any ledger with a
-- closed period) and never complete anyway (it ignores workspace_expenses and
-- vehicle_repairs). No client calls it. `if exists` so the statement is idempotent on
-- replay and on a database where it was already removed by hand.
drop function if exists public.production_activity_reset(text);

-- ── Revoke `execute … to authenticated` where nothing calls it ───────────────────
-- Helpers reached only from SECURITY DEFINER bodies (which run as the function owner,
-- so this revoke changes nothing for them).
revoke all on function public.hash_ledger_invite_code(text) from anon;
revoke all on function public.hash_ledger_invite_code(text) from authenticated;
revoke all on function public.normalize_ledger_slug(text) from anon;
revoke all on function public.normalize_ledger_slug(text) from authenticated;
revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.enforce_onboarding_rate_limit(text, text, integer, integer) from authenticated;

-- RPCs with no caller anywhere: superseded, or orphaned with the legacy runtime.
revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from anon;
revoke all on function public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]) from authenticated;
revoke all on function public.check_ledger_invite_email(text, text) from anon;
revoke all on function public.check_ledger_invite_email(text, text) from authenticated;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from anon;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from authenticated;
revoke all on function public.revoke_ledger_invite(text, uuid) from anon;
revoke all on function public.revoke_ledger_invite(text, uuid) from authenticated;
revoke all on function public.update_own_ledger_member_profile(text, text, text) from anon;
revoke all on function public.update_own_ledger_member_profile(text, text, text) from authenticated;
revoke all on function public.upsert_test_lab_report(text, text, jsonb) from anon;
revoke all on function public.upsert_test_lab_report(text, text, jsonb) from authenticated;
revoke all on function public.purge_generated_test_rows(text, boolean) from anon;
revoke all on function public.purge_generated_test_rows(text, boolean) from authenticated;

-- ── generate_all_due_recurring_expenses — count the no-open-period ledgers ──────
-- Re-declared off migration 142 (its newest prior definition; 110/112/114/116 came
-- before it). The body is 142 VERBATIM plus one counter: the previously silent bare
-- `continue` now increments ledgers_no_open_period, and that key joins the returned
-- JSON. Everything else is untouched — the candidate scan, the per-ledger
-- BEGIN/EXCEPTION subtransaction, the 24-occurrence catch-up cap, the SQLSTATE-only
-- first_error (GDPR), the GV-360 carry-over behaviour, and every existing return key
-- including ledgers_skipped, which stays purely the per-ledger failure counter.
-- Service-role only (grants restated).
create or replace function public.generate_all_due_recurring_expenses(
  batch_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  due_ledger record;
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  occurrences integer;
  ledger_generated integer;
  total_generated integer := 0;
  ledgers_touched integer := 0;
  ledgers_scanned integer := 0;
  -- Ledgers rolled back on an unexpected error; first_error_code holds the FIRST
  -- failure's SQLSTATE only. GV-281 also counted entry-locked ledgers here; GV-360
  -- removed that deferral, so this is now purely the per-ledger failure counter. The
  -- key stays in the return contract either way — /api/hooks/recurring-generate in
  -- govehlo-web reads it.
  ledgers_skipped integer := 0;
  -- GV-362: ledgers walked away from because their open period vanished between the
  -- candidate scan (which already requires one to exist) and the FOR SHARE re-read —
  -- a close that committed in the gap. Kept apart from ledgers_skipped, which since
  -- GV-360 means "rolled back on an error" and nothing else; merging the two would
  -- leave the sweep unable to tell a quiet run from a run that silently skipped work.
  -- Before GV-362 the branch below incremented nothing at all (the bare `continue`
  -- dates to migration 116 and survived 142).
  ledgers_no_open_period integer := 0;
  first_error_code text := null;
  -- Same per-template catch-up bound as generate_due_recurring_expenses (GV-274).
  max_catchup_occurrences constant integer := 24;
begin
  for due_ledger in
    -- Only ledgers with a due active template (with an active payer, GV-277) AND an
    -- open period to receive it, oldest debt first, so no-open-period ledgers never
    -- occupy a batch slot and the most overdue ledger is caught up first under
    -- batch_limit (GV-274). Entry-locked ledgers are neither excluded here nor skipped
    -- in the loop any more (GV-360): their occurrences are materialised, and the
    -- period-boundary trigger rebinds them into the queued carry-over period.
    select r.ledger_id
    from public.recurring_expenses r
    where r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
      and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
      and exists (
        select 1
        from public.settlement_periods sp
        where sp.ledger_id = r.ledger_id
          and sp.status = 'open'
          and sp.closed_at is null
      )
    group by r.ledger_id
    order by min(r.next_due_date) asc, r.ledger_id
    limit greatest(coalesce(batch_limit, 200), 0)
  loop
    ledgers_scanned := ledgers_scanned + 1;

    -- GV-281: isolate each ledger in its own subtransaction so one bad ledger (a lock
    -- race, an unexpected constraint) can never abort the whole sweep again. On error
    -- we roll THIS ledger back (the exception block does this automatically), count it
    -- in ledgers_skipped, remember the first SQLSTATE (code only — no row values, GDPR),
    -- and CONTINUE with the next ledger.
    begin
      -- Materialise into the ledger's open period. If none is open (a period close
      -- briefly precedes the next open), skip this ledger this run; the next tick catches
      -- up. FOR SHARE serializes against a concurrent close (which exclusively locks the
      -- period row).
      select sp.id into open_period_id
      from public.settlement_periods sp
      where sp.ledger_id = due_ledger.ledger_id
        and sp.status = 'open'
        and sp.closed_at is null
      order by sp.opened_at desc
      limit 1
      for share of sp;

      if open_period_id is null then
        -- GV-362: count it instead of leaving the run silent. The candidate scan
        -- above requires an open period, so landing here means a close beat us to it;
        -- the next tick catches this ledger up.
        ledgers_no_open_period := ledgers_no_open_period + 1;
        open_period_id := null;
        continue;
      end if;

      -- GV-360: no entry-lock deferral here either. The insert below targets the open
      -- period; when that period is entry-locked, migration 121's
      -- assert_settlement_period_boundary_expenses trigger rebinds the row into the
      -- queued carry-over period (migration 140) before the entry-lock trigger runs, so
      -- the 42501 GV-281 defended against can no longer be raised on this path.

      ledger_generated := 0;

      for tmpl in
        select *
        from public.recurring_expenses r
        where r.ledger_id = due_ledger.ledger_id
          and r.is_active
          and r.deleted_at is null
          and r.next_due_date <= current_date
          and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
        order by r.next_due_date
        for update skip locked
      loop
        due_date := tmpl.next_due_date;
        template_count := 0;
        occurrences := 0;

        while due_date <= current_date and occurrences < max_catchup_occurrences loop
          insert into public.workspace_expenses (
            ledger_id, period_id, category, description, amount_dkk, expense_date,
            split_rule, split_config, paid_by_member_id, created_by_member_id,
            recurring_expense_id, occurrence_date
          ) values (
            due_ledger.ledger_id,
            open_period_id,
            tmpl.category,
            tmpl.description,
            tmpl.amount_dkk,
            due_date,
            tmpl.split_rule,
            tmpl.split_config,
            tmpl.paid_by_member_id,
            tmpl.created_by_member_id,
            tmpl.id,
            due_date
          )
          on conflict (recurring_expense_id, occurrence_date)
            where recurring_expense_id is not null do nothing
          returning id into inserted_id;

          if inserted_id is not null then
            template_count := template_count + 1;
          end if;
          inserted_id := null;
          occurrences := occurrences + 1;

          due_date := (case tmpl.cadence
            when 'monthly' then due_date + interval '1 month'
            when 'quarterly' then due_date + interval '3 months'
            when 'semiannual' then due_date + interval '6 months'
            when 'yearly' then due_date + interval '1 year'
            else due_date + interval '1 month'
          end)::date;
        end loop;

        update public.recurring_expenses
          set next_due_date = due_date, last_generated_at = now(), updated_at = now()
        where id = tmpl.id;

        if template_count > 0 then
          insert into public.ledger_events (
            ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
          ) values (
            due_ledger.ledger_id,
            'expense_recurring_added',
            'Fast udgift tilføjet',
            coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
              || ' blev automatisk tilføjet og delt.',
            null,
            null,
            jsonb_build_object(
              'category', tmpl.category,
              'recurring_expense_id', tmpl.id,
              'count', template_count
            )
          );
          ledger_generated := ledger_generated + template_count;
        end if;
      end loop;

      if ledger_generated > 0 then
        ledgers_touched := ledgers_touched + 1;
        total_generated := total_generated + ledger_generated;
      end if;

      open_period_id := null;
    exception when others then
      -- Roll this ledger back (the subtransaction does this automatically) and keep
      -- sweeping. Record the first failure's SQLSTATE only — never message text or row
      -- values (GDPR).
      ledgers_skipped := ledgers_skipped + 1;
      if first_error_code is null then
        get stacked diagnostics first_error_code = returned_sqlstate;
      end if;
      open_period_id := null;
    end;
  end loop;

  return jsonb_build_object(
    'generated', total_generated,
    'ledgers_touched', ledgers_touched,
    'ledgers_scanned', ledgers_scanned,
    'ledgers_skipped', ledgers_skipped,
    'ledgers_no_open_period', ledgers_no_open_period,
    'first_error', first_error_code
  );
end;
$$;

revoke execute on function public.generate_all_due_recurring_expenses(integer) from public;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from anon;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from authenticated;
grant execute on function public.generate_all_due_recurring_expenses(integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('143_drop_production_reset_and_sweep_visibility',
        'GV-361: production_activity_reset(text) is dropped. It deleted every settlement_request, trip_participant, trip, fuel_payment, car_booking and settlement_period for a ledger behind nothing but is_ledger_admin — no confirmation token, no undo — and had been unusable since migrations 120/121 made enforce_settlement_entry_lock reject its DELETEs on any ledger with a closed period, while never clearing workspace_expenses or vehicle_repairs. No client calls it. fuel_ledger_healthcheck is re-declared off migration 037 (its newest prior definition), byte-identical except for the deleted (''production_activity_reset'') entry in critical_rpc_names, so the diagnostic does not report the removed RPC as missing; its own grant is revoked from anon and authenticated (owner-only, SQL Editor). EXECUTE is also revoked from anon and authenticated on eleven more functions with no caller in either client, each verified against govehlo-mobile and govehlo-web (discounting the vendored generated types) and against the SQL for in-body callers: the SECURITY DEFINER-only helpers hash_ledger_invite_code, normalize_ledger_slug and enforce_onboarding_rate_limit, and the uncalled RPCs apply_payment_status_action, check_ledger_invite_email, create_ledger_invite, revoke_ledger_invite, update_own_ledger_member_profile, upsert_test_lab_report, purge_generated_test_rows and fuel_ledger_healthcheck. All stay defined. Three verified-unused functions deliberately keep their grant: is_operator_context (an RLS-shaped predicate, and prod policies are known to drift from these files), and calculate_period_entry_fingerprint and set_ledger_member_active_admin (both are called as authenticated by this repo''s own RLS role-matrix guard, both are already gated — member/operator and admin respectively — and both are strictly weaker than an RPC that keeps its grant). GV-362: generate_all_due_recurring_expenses re-declared off migration 142 (its newest prior definition), 142 verbatim plus a ledgers_no_open_period counter on the previously silent bare-continue branch, and that key added to the returned JSON. ledgers_skipped stays purely the per-ledger failure counter it became in 142, and every pre-existing key keeps its meaning for /api/hooks/recurring-generate.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

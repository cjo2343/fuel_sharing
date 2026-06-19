-- Migration 037: Invite email preflight guard
-- Blocks restricted invite links from sending login codes to the wrong email before account/session creation continues.

create or replace function public.check_ledger_invite_email(
  invite_code text,
  login_email text
)
returns table (
  allowed boolean,
  result_code text,
  message text,
  restricted boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_login_email text := lower(btrim(coalesce(login_email, '')));
  matched_invite public.ledger_invites%rowtype;
begin
  if btrim(coalesce(invite_code, '')) = '' then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_CODE_MISSING';
    check_ledger_invite_email.message := 'Enter a workspace invite code before requesting an email login code.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  if safe_login_email = '' then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_EMAIL_MISSING';
    check_ledger_invite_email.message := 'Enter the email address that should join this workspace before requesting a login code.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  select * into matched_invite
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1;

  if matched_invite.id is null then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_INVALID';
    check_ledger_invite_email.message := 'Invite code is invalid, expired, revoked, or already used. Ask the workspace admin for a fresh invite.';
    check_ledger_invite_email.restricted := false;
    return next;
    return;
  end if;

  if matched_invite.invited_email is not null and lower(matched_invite.invited_email) <> safe_login_email then
    check_ledger_invite_email.allowed := false;
    check_ledger_invite_email.result_code := 'INVITE_EMAIL_MISMATCH';
    check_ledger_invite_email.message := 'This invite is restricted to a different email address. Enter the email address the admin invited, or ask the admin for a new invite.';
    check_ledger_invite_email.restricted := true;
    return next;
    return;
  end if;

  check_ledger_invite_email.allowed := true;
  check_ledger_invite_email.result_code := case when matched_invite.invited_email is null then 'INVITE_EMAIL_ALLOWED_OPEN' else 'INVITE_EMAIL_ALLOWED_RESTRICTED' end;
  check_ledger_invite_email.message := case when matched_invite.invited_email is null then 'Invite can be redeemed by this email after login verification.' else 'Restricted invite email matches. Continue with the email login code.' end;
  check_ledger_invite_email.restricted := matched_invite.invited_email is not null;
  return next;
end;
$$;

revoke all on function public.check_ledger_invite_email(text, text) from public;
grant execute on function public.check_ledger_invite_email(text, text) to anon;
grant execute on function public.check_ledger_invite_email(text, text) to authenticated;

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
      ('production_activity_reset'),
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



insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('037_invite_email_preflight', 'Adds invite/email preflight so restricted invite links block the wrong email before sending a login code.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

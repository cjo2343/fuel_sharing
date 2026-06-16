-- Migration 023: Track applied Fuel Ledger schema migrations.
-- Adds an idempotent migration ledger so Security Health can report whether the
-- live Supabase schema has all expected Fuel Ledger migrations applied.

create table if not exists public.fuel_ledger_schema_migrations (
  migration_id text primary key,
  description text not null default '',
  applied_at timestamptz not null default now()
);

comment on table public.fuel_ledger_schema_migrations is
  'Tracks Fuel Ledger Supabase migrations that have been applied to this project.';

alter table public.fuel_ledger_schema_migrations enable row level security;

revoke all on public.fuel_ledger_schema_migrations from public;
revoke all on public.fuel_ledger_schema_migrations from anon;
grant select on public.fuel_ledger_schema_migrations to authenticated;

drop policy if exists fuel_ledger_schema_migrations_admin_select on public.fuel_ledger_schema_migrations;

create policy fuel_ledger_schema_migrations_admin_select
  on public.fuel_ledger_schema_migrations
  for select
  to authenticated
  using (exists (
    select 1
    from public.ledger_members lm
    where lm.is_active = true
      and lm.role = 'admin'
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  ));

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values
    ('001_initial_schema', 'Core tables, indexes, seed ledger/member records, push subscriptions, and ledger events.'),
    ('002_auth_helpers', 'Auth/member helper functions used by RLS and write guards.'),
    ('003_payment_booking_guards', 'Payment status/integrity triggers and booking overlap guard.'),
    ('004_period_close_and_admin_rpcs', 'Period-close RPC and admin production reset RPC.'),
    ('005_rls_policies', 'RLS enablement plus member/admin policies.'),
    ('006_realtime_ledger_events', 'Narrow ledger events Realtime stream.'),
    ('007_security_health_rpc', 'Lightweight Security Health RPC.'),
    ('008_scheduled_reminder_rpcs', 'Service-role scheduled reminder RPCs.'),
    ('009_retention_privacy_cleanup', 'Retention/privacy cleanup RPCs.'),
    ('010_trip_transaction_rpc', 'Trip plus participant transaction RPC.'),
    ('011_booking_transaction_rpcs', 'Booking upsert/delete transaction RPCs.'),
    ('012_admin_tools_guardrails', 'Admin guardrail RPCs.'),
    ('013_fuel_payment_rpc', 'Fuel/payment transaction RPC.'),
    ('014_rpc_health_visibility', 'Critical RPC health visibility.'),
    ('015_test_lab_report_store', 'Cloud Test Lab report store.'),
    ('016_realtime_publication_health', 'Realtime publication health details.'),
    ('017_healthcheck_rpc_detection_fix', 'Healthcheck RPC detection fix.'),
    ('018_realtime_publication_cleanup', 'Realtime publication cleanup.'),
    ('019_immutable_test_lab_report_history', 'Immutable Test Lab report history.'),
    ('020_bootstrap_lock', 'Bootstrap lock guard.'),
    ('021_cloud_test_lab_report_retention', 'Cloud Test Lab report retention cleanup.'),
    ('022_settlement_request_transaction_rpc', 'Settlement request status transaction RPC.'),
    ('023_schema_migration_tracking', 'Schema migration tracking table and healthcheck drift detection.')
on conflict (migration_id) do update set
  description = excluded.description;

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
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
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
      ('023_schema_migration_tracking')
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
  from critical_rpc_status, migration_status;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

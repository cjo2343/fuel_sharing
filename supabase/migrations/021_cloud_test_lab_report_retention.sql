-- Migration 021: include cloud Test Lab report history in retention cleanup.
--
-- Test Lab reports are useful diagnostics, but they can contain environment metadata and
-- should not accumulate forever. Retention cleanup now prunes old cloud report history
-- while always keeping the newest reports for recent audit/debug context.

drop function if exists public.preview_retention_cleanup(text, integer, integer);
drop function if exists public.run_retention_cleanup(text, integer, integer);

create or replace function public.preview_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
  kept_report_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can preview retention cleanup';
  end if;

  select count(*) into event_count
  from public.ledger_events
  where ledger_id = target_ledger_id
    and (
      expires_at < now()
      or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
    );

  select count(*) into push_count
  from public.push_subscriptions
  where updated_at < now() - make_interval(days => greatest(stale_push_days, 30));

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), removable_reports as (
    select id
    from ranked_reports
    where newest_rank > greatest(keep_latest_test_lab_reports, 1)
       or retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
  )
  select count(*) into report_count from removable_reports;

  select count(*) into kept_report_count
  from public.test_lab_reports
  where ledger_id = target_ledger_id;
  kept_report_count := greatest(kept_report_count - report_count, 0);

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'kept_test_lab_reports', kept_report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

create or replace function public.run_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run retention cleanup';
  end if;

  with deleted_events as (
    delete from public.ledger_events
    where ledger_id = target_ledger_id
      and (
        expires_at < now()
        or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
      )
    returning 1
  )
  select count(*) into event_count from deleted_events;

  with deleted_push as (
    delete from public.push_subscriptions
    where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
    returning 1
  )
  select count(*) into push_count from deleted_push;

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), deleted_reports as (
    delete from public.test_lab_reports reports
    using ranked_reports ranked
    where reports.id = ranked.id
      and (
        ranked.newest_rank > greatest(keep_latest_test_lab_reports, 1)
        or ranked.retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
      )
    returning 1
  )
  select count(*) into report_count from deleted_reports;

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'global_user_device_records'
  );
end;
$$;

revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from anon;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;

create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  realtime_tables text[] := array[]::text[];
  extra_realtime_tables text[] := array[]::text[];
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run health checks';
  end if;

  select coalesce(array_agg(schemaname || '.' || tablename order by schemaname, tablename), array[]::text[])
  into realtime_tables
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and schemaname = 'public';

  select coalesce(array_agg(table_name order by table_name), array[]::text[])
  into extra_realtime_tables
  from unnest(realtime_tables) as table_name
  where table_name <> 'public.ledger_events';

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'checked_at', now(),
    'is_admin', true,
    'current_member_id', public.current_ledger_member_id(target_ledger_id),
    'critical_rpcs', jsonb_object_agg(rpc_name, exists_flag),
    'realtime_publication', jsonb_build_object(
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'published_tables', to_jsonb(realtime_tables),
      'extra_tables', to_jsonb(extra_realtime_tables),
      'has_extra_tables', cardinality(extra_realtime_tables) > 0,
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    )
  )
  from (
    values
      ('close_current_period'),
      ('upsert_trip_transaction'),
      ('upsert_booking_transaction'),
      ('mark_booking_logged_transaction'),
      ('cancel_booking_transaction'),
      ('upsert_fuel_payment'),
      ('upsert_ledger_member_admin'),
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report')
  ) rpc_names(rpc_name)
  cross join lateral (
    select case rpc_name
      when 'preview_retention_cleanup' then to_regprocedure('public.preview_retention_cleanup(text, integer, integer, integer, integer)') is not null
      when 'run_retention_cleanup' then to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer, integer)') is not null
      else exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
    end as exists_flag
  ) rpc_exists;
end;
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

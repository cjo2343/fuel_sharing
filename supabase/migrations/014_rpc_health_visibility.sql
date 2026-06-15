-- Migration 014: expand frontend healthcheck with critical RPC availability.

-- This keeps the healthcheck read-only while making Admin diagnostics show whether
-- the RPC-backed write paths are available before direct-table fallbacks are removed.
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
    'critical_rpcs', jsonb_build_object(
      'close_settlement_period',
        to_regprocedure('public.close_settlement_period(text, uuid, jsonb)') is not null,
      'upsert_trip_with_participants',
        to_regprocedure('public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[])') is not null,
      'upsert_fuel_payment',
        to_regprocedure('public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, boolean)') is not null,
      'upsert_car_booking',
        to_regprocedure('public.upsert_car_booking(text, text, uuid, timestamp with time zone, timestamp with time zone, text)') is not null,
      'soft_delete_car_booking',
        to_regprocedure('public.soft_delete_car_booking(text, text)') is not null,
      'upsert_ledger_member_admin',
        to_regprocedure('public.upsert_ledger_member_admin(text, uuid, text, text, text, text, boolean)') is not null,
      'set_ledger_member_active_admin',
        to_regprocedure('public.set_ledger_member_active_admin(text, uuid, boolean)') is not null,
      'purge_generated_test_rows',
        to_regprocedure('public.purge_generated_test_rows(text, boolean)') is not null,
      'production_activity_reset',
        to_regprocedure('public.production_activity_reset(text)') is not null,
      'preview_retention_cleanup',
        to_regprocedure('public.preview_retention_cleanup(text, integer, integer, integer)') is not null,
      'run_retention_cleanup',
        to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer)') is not null
    ),
    'checked_at', now()
  );
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

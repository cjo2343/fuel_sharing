-- Migration 007: lightweight Security Health RPC. Must not call close_settlement_period.

-- Lightweight read-only healthcheck for frontend Security Health.
-- Important: this must not call close_settlement_period because that RPC takes an advisory lock.
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
    'checked_at', now()
  );
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

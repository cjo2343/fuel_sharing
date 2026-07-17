-- Migration 127: batch owner settlement-integrity recomputation.
--
-- The operator endpoint previously issued two HTTP RPC requests per closed period.
-- Besides being slow, 500 periods could consume 1,000 Worker subrequests. Keep the
-- existing audited calculators as the source of truth, but invoke them inside one
-- bounded, service-role-only database command. A malformed historical period is
-- isolated to its own result instead of aborting the complete report.

create or replace function public.owner_settlement_integrity_batch(
  max_periods integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  period_row record;
  result_rows jsonb := '[]'::jsonb;
  live_fingerprint text;
  live_settlement jsonb;
  recompute_error boolean;
  closed_period_count bigint;
begin
  if max_periods is null or max_periods < 1 or max_periods > 500 then
    raise exception 'max_periods must be between 1 and 500' using errcode = '22023';
  end if;

  select count(*) into closed_period_count
  from public.settlement_periods
  where status = 'closed';

  for period_row in
    select sp.id,
           sp.ledger_id,
           coalesce(l.name, sp.ledger_id) as workspace_label,
           sp.label,
           sp.opened_at,
           sp.closed_at,
           sp.snapshot_json
    from public.settlement_periods sp
    left join public.ledgers l on l.id = sp.ledger_id
    where sp.status = 'closed'
    order by sp.closed_at desc nulls last, sp.id
    limit max_periods
  loop
    live_fingerprint := null;
    live_settlement := null;
    recompute_error := false;

    if period_row.snapshot_json is not null then
      begin
        live_fingerprint := public.calculate_period_entry_fingerprint(
          period_row.ledger_id,
          period_row.id
        );
        live_settlement := public.calculate_period_settlement(
          period_row.ledger_id,
          period_row.id
        );
      exception when others then
        recompute_error := true;
      end;
    end if;

    result_rows := result_rows || jsonb_build_array(jsonb_build_object(
      'periodId', period_row.id,
      'ledgerId', period_row.ledger_id,
      'workspaceLabel', period_row.workspace_label,
      'label', coalesce(period_row.label, 'Closed period'),
      'openedAt', period_row.opened_at,
      'closedAt', period_row.closed_at,
      'snapshot', period_row.snapshot_json,
      'liveFingerprint', live_fingerprint,
      'liveSettlement', live_settlement,
      'recomputeError', recompute_error
    ));
  end loop;

  return jsonb_build_object(
    'total', closed_period_count,
    'truncated', closed_period_count > max_periods,
    'periods', result_rows
  );
end;
$$;

revoke all on function public.owner_settlement_integrity_batch(integer) from public;
revoke all on function public.owner_settlement_integrity_batch(integer) from anon;
revoke all on function public.owner_settlement_integrity_batch(integer) from authenticated;
grant execute on function public.owner_settlement_integrity_batch(integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '127_owner_settlement_integrity_batch',
  'Add one bounded service-role-only settlement-integrity batch command, preserving the existing calculators while eliminating per-period HTTP RPC fan-out and isolating historical recompute failures.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 019: make cloud-saved Test Lab reports immutable history rows.
--
-- Earlier versions upserted by (ledger_id, report_id), so a fresh cloud save could
-- overwrite the previous row when the redacted report id normalized to the same
-- value. Keep each save as its own audit/history row instead.

alter table public.test_lab_reports
  drop constraint if exists test_lab_reports_ledger_id_report_id_key;

create index if not exists test_lab_reports_ledger_report_id_idx
on public.test_lab_reports (ledger_id, report_id);

create or replace function public.upsert_test_lab_report(
  target_ledger_id text,
  report_id_value text,
  report_payload_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  normalized_report_id text := nullif(trim(coalesce(report_id_value, '')), '');
  saved_row public.test_lab_reports%rowtype;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can save Test Lab reports';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not an active ledger member';
  end if;

  if normalized_report_id is null then
    raise exception 'Test Lab report id is required';
  end if;

  if report_payload_value is null or jsonb_typeof(report_payload_value) <> 'object' then
    raise exception 'Test Lab report payload must be a JSON object';
  end if;

  -- Intentionally insert a new row for every cloud save. The function name stays
  -- as upsert_test_lab_report for backward compatibility with deployed clients.
  insert into public.test_lab_reports (ledger_id, report_id, report_payload, created_by_member_id, synced_at)
  values (
    target_ledger_id,
    normalized_report_id,
    report_payload_value,
    actor_member_id,
    now()
  )
  returning * into saved_row;

  return jsonb_build_object(
    'id', saved_row.id,
    'ledger_id', saved_row.ledger_id,
    'report_id', saved_row.report_id,
    'synced_at', saved_row.synced_at,
    'created_at', saved_row.created_at,
    'immutable_history', true
  );
end;
$$;

revoke all on function public.upsert_test_lab_report(text, text, jsonb) from public;
revoke all on function public.upsert_test_lab_report(text, text, jsonb) from anon;
grant execute on function public.upsert_test_lab_report(text, text, jsonb) to authenticated;

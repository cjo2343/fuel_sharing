-- Migration 015: store Test Lab reports outside the full JSON ledger mirror.

-- Cloud-saved diagnostic reports are operational/debug records, not ledger state.
-- Keep them in a small normalized table so saving a report does not upsert the
-- full car_share_ledgers JSON mirror.
create table if not exists public.test_lab_reports (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  report_id text not null,
  report_payload jsonb not null,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (ledger_id, report_id)
);

create index if not exists test_lab_reports_ledger_synced_idx
on public.test_lab_reports (ledger_id, synced_at desc);

alter table public.test_lab_reports enable row level security;

drop policy if exists "Ledger members can read test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can insert test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can update test lab reports" on public.test_lab_reports;
drop policy if exists "Ledger admins can delete test lab reports" on public.test_lab_reports;
create policy "Ledger members can read test lab reports" on public.test_lab_reports
  for select to authenticated using (public.is_ledger_member(ledger_id));
create policy "Ledger admins can insert test lab reports" on public.test_lab_reports
  for insert to authenticated with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can update test lab reports" on public.test_lab_reports
  for update to authenticated using (public.is_ledger_admin(ledger_id)) with check (public.is_ledger_admin(ledger_id));
create policy "Ledger admins can delete test lab reports" on public.test_lab_reports
  for delete to authenticated using (public.is_ledger_admin(ledger_id));

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

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':test-lab-report:' || normalized_report_id));

  insert into public.test_lab_reports (ledger_id, report_id, report_payload, created_by_member_id, synced_at)
  values (
    target_ledger_id,
    normalized_report_id,
    report_payload_value,
    actor_member_id,
    now()
  )
  on conflict (ledger_id, report_id) do update
    set report_payload = excluded.report_payload,
        created_by_member_id = excluded.created_by_member_id,
        synced_at = excluded.synced_at
  returning * into saved_row;

  return jsonb_build_object(
    'id', saved_row.id,
    'ledger_id', saved_row.ledger_id,
    'report_id', saved_row.report_id,
    'synced_at', saved_row.synced_at
  );
end;
$$;

revoke all on function public.upsert_test_lab_report(text, text, jsonb) from public;
revoke all on function public.upsert_test_lab_report(text, text, jsonb) from anon;
grant execute on function public.upsert_test_lab_report(text, text, jsonb) to authenticated;

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
        to_regprocedure('public.run_retention_cleanup(text, integer, integer, integer)') is not null,
      'upsert_test_lab_report',
        to_regprocedure('public.upsert_test_lab_report(text, text, jsonb)') is not null
    ),
    'checked_at', now()
  );
$$;

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

-- Migration 131: enforce the approved GDPR retention policy (GV-309 follow-up).
--
-- Migration 130 established a safe daily operational sweep. This migration
-- extends that same service-role-only function with the policy decisions
-- recorded in docs/gdpr/retention.md:
--   * deleted chat, bookings and recurring templates: 90 days;
--   * deleted financial/accounting rows: five complete accounting years;
--   * owner_activity_log: 24 months.
--
-- Workspaces are deliberately NOT deleted because they are inactive. The
-- existing delete_my_account() path already cascades a workspace immediately
-- when its final active member leaves; anomalous orphaned workspaces require
-- operator review rather than a blind age-based sweep.

-- The live-list indexes intentionally exclude tombstones, so add small partial
-- indexes for the scheduled cleanup. They also make dry-run counts predictable
-- as the data set grows.
create index if not exists messages_deleted_at_idx
  on public.messages (deleted_at)
  where deleted_at is not null;
create index if not exists car_bookings_deleted_at_idx
  on public.car_bookings (deleted_at)
  where deleted_at is not null;
create index if not exists recurring_expenses_deleted_at_idx
  on public.recurring_expenses (deleted_at)
  where deleted_at is not null;
create index if not exists trips_deleted_at_idx
  on public.trips (deleted_at)
  where deleted_at is not null;
create index if not exists fuel_payments_deleted_at_idx
  on public.fuel_payments (deleted_at)
  where deleted_at is not null;
create index if not exists workspace_expenses_deleted_at_idx
  on public.workspace_expenses (deleted_at)
  where deleted_at is not null;
create index if not exists vehicle_repairs_deleted_at_idx
  on public.vehicle_repairs (deleted_at)
  where deleted_at is not null;

-- Migration 112 freezes repairs that belong to closed periods, including hard
-- DELETE. Keep that invariant for the full accounting window, then permit only
-- an already-soft-deleted tombstone outside the approved window to be purged.
-- This rule is intrinsic to the row age, so it cannot be bypassed by setting a
-- session flag; ordinary closed-period edits and deletes remain rejected.
create or replace function public.enforce_repair_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE'
     and old.deleted_at is not null
     and old.deleted_at < date_trunc('year', now()) - interval '5 years' then
    return old;
  end if;

  if exists (
    select 1
    from public.settlement_periods sp
    where sp.ledger_id = old.ledger_id
      and sp.closed_at is not null
      and (
        sp.id = old.period_id
        or (
          old.period_id is null
          and old.created_at >= sp.opened_at
          and old.created_at < sp.closed_at
        )
      )
  ) then
    raise exception
      'This repair belongs to a closed settlement period and can no longer be edited or deleted.'
      using errcode = '22023';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.run_operational_retention(
  p_stale_push_days integer default 180,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_tokens integer := 0;
  v_expired_events integer := 0;
  v_deleted_messages integer := 0;
  v_deleted_bookings integer := 0;
  v_deleted_recurring_templates integer := 0;
  v_deleted_trips integer := 0;
  v_deleted_fuel_payments integer := 0;
  v_deleted_workspace_expenses integer := 0;
  v_deleted_vehicle_repairs integer := 0;
  v_deleted_owner_activity integer := 0;
  v_short_cutoff timestamptz := now() - interval '90 days';
  v_financial_cutoff timestamptz := date_trunc('year', now()) - interval '5 years';
  v_audit_cutoff timestamptz := now() - interval '24 months';
begin
  if p_stale_push_days is null or p_stale_push_days < 30 or p_stale_push_days > 3650 then
    raise exception 'p_stale_push_days must be between 30 and 3650' using errcode = '22023';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run must not be null' using errcode = '22023';
  end if;

  if p_dry_run then
    select count(*) into v_stale_tokens from public.expo_push_tokens
    where updated_at < now() - make_interval(days => p_stale_push_days);
    select count(*) into v_expired_events from public.ledger_events
    where expires_at is not null and expires_at < now();
    select count(*) into v_deleted_messages from public.messages where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_bookings from public.car_bookings where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_recurring_templates from public.recurring_expenses where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_trips from public.trips where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_fuel_payments from public.fuel_payments where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_workspace_expenses from public.workspace_expenses where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_vehicle_repairs from public.vehicle_repairs where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_owner_activity from public.owner_activity_log where created_at < v_audit_cutoff;
  else
    with purged as (delete from public.expo_push_tokens where updated_at < now() - make_interval(days => p_stale_push_days) returning 1)
      select count(*) into v_stale_tokens from purged;
    with purged as (delete from public.ledger_events where expires_at is not null and expires_at < now() returning 1)
      select count(*) into v_expired_events from purged;
    with purged as (delete from public.messages where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_messages from purged;
    with purged as (delete from public.car_bookings where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_bookings from purged;
    with purged as (delete from public.recurring_expenses where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_recurring_templates from purged;

    -- Closed-period entry triggers deliberately freeze accounting history. The
    -- account-deletion path already uses this transaction-local gate for GDPR
    -- scrubs; enable it only inside this service-role-only function and only
    -- around tombstones that have outlived the accounting retention window.
    perform set_config('govehlo.pii_scrub', '1', true);
    with purged as (delete from public.trips where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_trips from purged;
    with purged as (delete from public.fuel_payments where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_fuel_payments from purged;
    with purged as (delete from public.workspace_expenses where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_workspace_expenses from purged;
    with purged as (delete from public.vehicle_repairs where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_vehicle_repairs from purged;
    perform set_config('govehlo.pii_scrub', '', true);
    with purged as (delete from public.owner_activity_log where created_at < v_audit_cutoff returning 1)
      select count(*) into v_deleted_owner_activity from purged;
  end if;

  return jsonb_build_object(
    'staleExpoPushTokens', v_stale_tokens,
    'expiredLedgerEvents', v_expired_events,
    'deletedMessages', v_deleted_messages,
    'deletedBookings', v_deleted_bookings,
    'deletedRecurringTemplates', v_deleted_recurring_templates,
    'deletedTrips', v_deleted_trips,
    'deletedFuelPayments', v_deleted_fuel_payments,
    'deletedWorkspaceExpenses', v_deleted_workspace_expenses,
    'deletedVehicleRepairs', v_deleted_vehicle_repairs,
    'deletedOwnerActivity', v_deleted_owner_activity,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'ranAt', now()
  );
end;
$$;

revoke all on function public.run_operational_retention(integer, boolean) from public;
revoke all on function public.run_operational_retention(integer, boolean) from anon;
revoke all on function public.run_operational_retention(integer, boolean) from authenticated;
grant execute on function public.run_operational_retention(integer, boolean) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '131_gdpr_retention_policy',
  'Enforce GDPR retention decisions: 90-day purge for deleted chat/bookings/recurring templates, five accounting years for deleted financial rows, and 24 months for owner activity audit. Inactivity never auto-deletes a workspace.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

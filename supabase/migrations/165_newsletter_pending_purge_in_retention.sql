-- Migration 165: the newsletter's seven-day deletion must be guaranteed, not opportunistic (GV-433)
--
-- Migration 161 sweeps expired PENDING signups only inside
-- newsletter_request_subscription: every new signup purges every expired pending row.
-- With no new signups, nothing runs — an abandoned address sits indefinitely while
-- /nyhedsbrev and /privatliv promise automatic deletion after 7 days (external review
-- P1, confirmed). 161's own tracker text anticipated the fix: "a line in
-- run_operational_retention is the right move if volume ever makes that matter."
--
-- run_operational_retention is re-declared off its NEWEST prior definition (migration
-- 149 — the GV-202 lesson) with exactly that line added, in both halves of the
-- dry-run split: the daily retention cron (migration 130's
-- /api/hooks/retention-cleanup, RETENTION_CLEANUP_KEY, 03:30 UTC) now enforces the
-- promise every day, and the opportunistic signup-time sweep stays as a bonus.
-- Confirmed subscribers are never touched by this line — they leave the list only by
-- unsubscribing, which hard-deletes (161). The cutoff is 168 hours, the same
-- PENDING_TTL_HOURS the web Functions send and the window 161's confirm refuses past.
--
-- The consent guard (tools/test-newsletter-consent-contract.mjs) allowlists this
-- function as the deliberate decision its ALLOWED_FUNCTIONS list exists to force: it
-- deletes expired pending rows and counts them; it cannot read an address out.
-- Signature unchanged, so create-or-replace suffices and no client is stranded.

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
  v_purged_workspaces integer := 0;
  v_deleted_rate_limit_counters integer := 0;
  v_purged_newsletter_pending integer := 0;
  v_short_cutoff timestamptz := now() - interval '90 days';
  v_financial_cutoff timestamptz := date_trunc('year', now()) - interval '5 years';
  v_audit_cutoff timestamptz := now() - interval '24 months';
  v_workspace_cutoff timestamptz := now() - interval '90 days';
  -- GV-385: throttle counters are working state, not history. The longest window any
  -- caller configures is a day, and the two admin readers (owner/ocr-telemetry and
  -- owner/external-usage) both look back 7 days, so 30 days is already generous.
  v_rate_limit_cutoff timestamptz := now() - interval '30 days';
  -- GV-433: the double-opt-in window /nyhedsbrev and /privatliv promise. 168 hours =
  -- PENDING_TTL_HOURS in the web Functions and the interval migration 161's confirm
  -- refuses past — three copies of one number, each pinned by its own guard.
  v_newsletter_pending_cutoff timestamptz := now() - interval '168 hours';
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
    select count(*) into v_deleted_rate_limit_counters from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff;
    select count(*) into v_purged_newsletter_pending from public.newsletter_subscribers
    where confirmed_at is null and requested_at < v_newsletter_pending_cutoff;
    select count(*) into v_purged_workspaces from public.ledgers where deleted_at < v_workspace_cutoff;
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

    -- GV-316: purge workspaces whose operator decommission tombstone has
    -- outlived the 90-day grace window. On delete cascade removes every child
    -- row; the closed-period locks stand aside for a whole-workspace teardown
    -- (settlement_periods delete first). Kept inside the pii_scrub gate for
    -- parity with the financial-row purges above.
    with purged as (delete from public.ledgers where deleted_at < v_workspace_cutoff returning 1)
      select count(*) into v_purged_workspaces from purged;
    perform set_config('govehlo.pii_scrub', '', true);
    with purged as (delete from public.owner_activity_log where created_at < v_audit_cutoff returning 1)
      select count(*) into v_deleted_owner_activity from purged;
    with purged as (delete from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff returning 1)
      select count(*) into v_deleted_rate_limit_counters from purged;
    -- GV-433: migration 161 swept expired pending signups only inside
    -- newsletter_request_subscription — opportunistic, so with no new signups an
    -- abandoned address sat forever while the privacy page promised seven days. Its
    -- tracker text already named this line as the right move. Confirmed rows are
    -- NEVER touched here: they leave only by unsubscribe (hard delete, migration 161).
    with purged as (delete from public.newsletter_subscribers
      where confirmed_at is null and requested_at < v_newsletter_pending_cutoff returning 1)
      select count(*) into v_purged_newsletter_pending from purged;
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
    'purgedWorkspaces', v_purged_workspaces,
    'deletedRateLimitCounters', v_deleted_rate_limit_counters,
    'purgedNewsletterPending', v_purged_newsletter_pending,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'workspaceGraceDays', 90,
    'rateLimitRetentionDays', 30,
    'newsletterPendingTtlHours', 168,
    'ranAt', now()
  );
end;
$$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '165_newsletter_pending_purge_in_retention',
  'Guaranteed seven-day deletion of expired pending newsletter signups (GV-433). Migration 161 purged expired pending rows only opportunistically — inside newsletter_request_subscription, so with no new signups an abandoned address sat indefinitely while /nyhedsbrev and /privatliv promise automatic deletion after 7 days; 161''s own tracker named this line as the right move. run_operational_retention is re-declared off its newest prior definition (149) with the purge added to both halves of the dry-run split: delete from newsletter_subscribers where confirmed_at is null and requested_at < now() - interval ''168 hours'' — the same PENDING_TTL_HOURS the web Functions send and the window confirm refuses past. The daily retention cron (migration 130''s hook, 03:30 UTC) now enforces the promise every day; the signup-time sweep stays as a bonus. Confirmed subscribers are never touched — they leave only by unsubscribing (hard delete, 161). Counted as purgedNewsletterPending in the returned jsonb, with newsletterPendingTtlHours = 168 alongside the other retention constants. The consent guard''s ALLOWED_FUNCTIONS gains run_operational_retention as the deliberate decision that allowlist exists to force: this function deletes expired pending rows and counts them, and can never read an address out. Signature unchanged, so create-or-replace suffices.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

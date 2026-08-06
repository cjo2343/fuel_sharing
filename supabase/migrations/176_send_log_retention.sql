-- Migration 176: newsletter_send_log 24-month retention (GV-445)
--
-- The send log (migration 173) stores who-sent-what-when as a counts-only audit trail.
-- It contains the operator's email address (staff, not subscriber), so it is personal
-- data with a finite purpose. 24-month TTL aligns with owner_activity_log.
--
-- ── Ancestry (the GV-202 rule) ────────────────────────────────────────────────────
-- public.run_operational_retention below is migration 169's body VERBATIM -- 169 is its
-- NEWEST prior definition (chain 130 → 131 → 132 → 141 → 147 → 149 → 165 → 169) --
-- with exactly one sweep added to both halves of the dry-run split, one counter, and
-- two jsonb keys (purgedNewsletterSendLog + newsletterSendLogRetentionMonths).
-- Signature unchanged, so create-or-replace suffices and no caller is stranded.
--
-- The send log's v_audit_cutoff (24 months) is the SAME variable owner_activity_log
-- already uses -- deliberately, because the two tables answer the same question at the
-- same altitude ("who did what on the operator console, when, and to how many").

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
  v_purged_fuel_receipts integer := 0;
  v_purged_receipt_paths text[] := '{}';
  v_purged_send_log integer := 0;
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
    -- GVM-537: same predicate as the real half below, so the dry run a human reads in
    -- the SQL editor reports exactly what the cron would destroy tonight.
    select count(*) into v_purged_fuel_receipts from public.fuel_payment_receipts fpr
    where exists (
      select 1
      from public.fuel_payments fp
      join public.settlement_periods sp on sp.id = fp.period_id
      where fp.id = fpr.fuel_payment_id
        and sp.status = 'closed'
        and not exists (
          select 1
          from public.settlement_requests sr
          where sr.period_id = sp.id
            and sr.status not in ('paid', 'cancelled')
        )
    );
    -- GV-445: newsletter send log — 24-month retention, same window as owner_activity_log.
    select count(*) into v_purged_send_log
    from public.newsletter_send_log
    where created_at < v_audit_cutoff;
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

    -- GVM-537: opt-in receipt photos die with the settlement they documented. Period
    -- 'closed' AND nothing in flight (no settlement_request outside paid/cancelled);
    -- a paid_pending claim is NOT settled here, because the creditor can still dispute
    -- it back to 'requested' and the receipt is what that argument needs. Placed ahead
    -- of the fuel_payments tombstone purge so this sweep sees, counts and deletes the
    -- objects of every receipt it is responsible for before any cascade can remove the
    -- rows silently, and its paths are collected for the storage delete that follows.
    with purged as (
      delete from public.fuel_payment_receipts fpr
      where exists (
        select 1
        from public.fuel_payments fp
        join public.settlement_periods sp on sp.id = fp.period_id
        where fp.id = fpr.fuel_payment_id
          and sp.status = 'closed'
          and not exists (
            select 1
            from public.settlement_requests sr
            where sr.period_id = sp.id
              and sr.status not in ('paid', 'cancelled')
          )
      )
      returning fpr.storage_path
    )
    select count(*), coalesce(array_agg(storage_path), '{}'::text[])
      into v_purged_fuel_receipts, v_purged_receipt_paths
      from purged;

    -- The ONE place the platform deletes a storage object from SQL. Everywhere else
    -- (migration 138/139 and the detach RPC above) the client owns that half, but a
    -- nightly cron has no client, and a receipt row deleted while its object survives
    -- would leave the photo readable to every workspace member — the opposite of the
    -- promise. Dynamic EXECUTE inside the storage-schema guard so a plain-Postgres
    -- replay never even parses a reference to storage.objects.
    --
    -- Honest limitation, not solved here and not new: a CASCADE (a workspace purge, or
    -- the fuel_payments tombstone purge below removing a receipt's parent) still drops
    -- receipt ROWS without anyone deleting their objects — exactly the condition
    -- incident photos have lived with since migration 138. Documented in
    -- docs/gdpr/deletion-limitations.md; a Storage-API cleanup pass in the retention
    -- hook is the fix, and it belongs in govehlo-web, not in this migration.
    if v_purged_fuel_receipts > 0
       and exists (select 1 from information_schema.schemata where schema_name = 'storage') then
      execute 'delete from storage.objects where bucket_id = ''fuel-receipts'' and name = any($1)'
        using v_purged_receipt_paths;
    end if;

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
    -- GV-445: newsletter send log — 24-month retention, same window as owner_activity_log.
    -- The table holds operator_email (staff PII, not subscriber), headline, recipient
    -- count and timestamp. No subscriber address, no link to the list — but the operator
    -- email is still personal data with a finite audit purpose.
    with purged as (delete from public.newsletter_send_log
      where created_at < v_audit_cutoff returning 1)
      select count(*) into v_purged_send_log from purged;
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
    'purgedFuelReceipts', v_purged_fuel_receipts,
    'purgedNewsletterSendLog', v_purged_send_log,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'workspaceGraceDays', 90,
    'rateLimitRetentionDays', 30,
    'newsletterPendingTtlHours', 168,
    'fuelReceiptRetentionRule', 'closed_and_fully_paid',
    'newsletterSendLogRetentionMonths', 24,
    'ranAt', now()
  );
end;
$$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '176_send_log_retention',
  'GV-445: newsletter_send_log 24-month retention. The send log (migration 173) stores operator_email, headline, recipient_count and timestamp as a counts-only audit trail of marketing sends. It contains the operator''s email address (staff, not subscriber), which is personal data with a finite purpose — "who triggered a marketing send, when, and to how many" — and no address, name or link to the subscriber list. 24-month TTL aligns with owner_activity_log, the other operator-audit table, so the two answer the same question at the same altitude for the same window. run_operational_retention is re-declared off its newest prior definition, migration 169 (chain 130 → 131 → 132 → 141 → 147 → 149 → 165 → 169 — the GV-202 rule), byte-identical apart from one sweep added to BOTH halves of the dry-run split (delete from newsletter_send_log where created_at < v_audit_cutoff, the same 24-month cutoff variable owner_activity_log already uses), one counter (v_purged_send_log) and two returned jsonb keys (purgedNewsletterSendLog for the count, newsletterSendLogRetentionMonths = 24 alongside the other retention constants). Signature unchanged, so create-or-replace suffices. No new event_type, no RPC signature change, no new table, no grant change. Documented in docs/gdpr/retention.md and docs/gdpr/ropa.md (A5).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

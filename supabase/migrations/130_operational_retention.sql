-- Migration 130: operational retention cleanup (GV-309)
--
-- Migration 009 created preview_retention_cleanup / run_retention_cleanup. They
-- have ZERO callers anywhere (no pg_cron, no scheduler hook, no admin UI), and
-- their default semantics (delete ledger_events older than 30 days) would today
-- destroy the activity feed — since GVM-83 that is the merged chat+activity
-- surface and the live-sync backbone. Separately, public.push_subscriptions is a
-- DEAD legacy table (web-push from the retired PWA; zero live readers/writers —
-- only delete_my_account still deletes from it, by email) holding stale personal
-- data (endpoints, keys, emails). The live push table is expo_push_tokens, whose
-- updated_at is refreshed on every app launch during token registration.
--
-- We do NOT drop the legacy functions or table here: the fuel_ledger_healthcheck
-- / security-health expectation lists (migrations 014/017/024/032) enumerate the
-- table and both RPCs, and delete_my_account references the table. The drop is
-- deferred to GV-311. This migration:
--   1. Defensively revokes all privileges on the legacy 009 functions so no
--      client role can invoke their dangerous defaults.
--   2. Truncates the dead legacy push_subscriptions table (GDPR minimisation).
--   3. Adds a safe, service-role-only run_operational_retention() job that only
--      prunes stale expo_push_tokens (devices re-register on next launch) and
--      already-expired ledger_events — never events by age, so the activity feed
--      is never touched.

-- 1. Defensive revokes on the legacy, unreferenced migration-009 retention
--    functions. Their newest definitions live in migration 072 with signature
--    (text, integer, integer, integer, integer); migration 083 only touched
--    their grants. Revoking again is idempotent and harmless. They are kept only
--    because the fuel_ledger_healthcheck / security-health expectation lists
--    (migrations 014/017/024/032) enumerate them and delete_my_account
--    references push_subscriptions — dropping them is deferred to GV-311.
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from authenticated;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from authenticated;

-- 2. Purge the dead legacy PWA web-push data (endpoints, keys, emails) for GDPR
--    data minimisation. The table stays because delete_my_account and the
--    healthcheck expectation lists reference it (drop deferred to GV-311).
truncate table public.push_subscriptions;

-- 3. Safe operational retention job. Service-role-only (this is a cross-workspace
--    operator job, not member-visible activity); it writes NO ledger_events row.
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
begin
  if p_stale_push_days is null or p_stale_push_days < 30 or p_stale_push_days > 3650 then
    raise exception 'p_stale_push_days must be between 30 and 3650' using errcode = '22023';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run must not be null' using errcode = '22023';
  end if;

  if p_dry_run then
    -- Dry run: count only, never mutate.
    select count(*) into v_stale_tokens
    from public.expo_push_tokens
    where expo_push_tokens.updated_at < now() - make_interval(days => p_stale_push_days);

    select count(*) into v_expired_events
    from public.ledger_events
    where ledger_events.expires_at is not null
      and ledger_events.expires_at < now();
  else
    -- Target 1: stale devices. Tokens re-register on the next app launch, so
    -- deleting a stale row is safe — the device simply re-inserts it.
    with deleted_tokens as (
      delete from public.expo_push_tokens
      where expo_push_tokens.updated_at < now() - make_interval(days => p_stale_push_days)
      returning 1
    )
    select count(*) into v_stale_tokens from deleted_tokens;

    -- Target 2: explicitly-expiring events only. NEVER delete by age/created_at
    -- — the GVM-83 activity feed must not be touched.
    with deleted_events as (
      delete from public.ledger_events
      where ledger_events.expires_at is not null
        and ledger_events.expires_at < now()
      returning 1
    )
    select count(*) into v_expired_events from deleted_events;
  end if;

  return jsonb_build_object(
    'staleExpoPushTokens', v_stale_tokens,
    'expiredLedgerEvents', v_expired_events,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
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
  '130_operational_retention',
  'Operational retention cleanup (GV-309): defensively revoke the unreferenced legacy 009 retention RPCs, truncate the dead legacy push_subscriptions table (GDPR data minimisation), and add a service-role-only run_operational_retention() that prunes only stale expo_push_tokens and already-expired ledger_events — never the activity feed. Legacy drop deferred to GV-311.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

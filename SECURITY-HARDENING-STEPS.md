# Security hardening notes

For a fresh Supabase project, run `supabase-schema.sql`. It creates the normalized tables, helper functions, and member-restricted RLS policies used by the table-primary app.

For an existing Supabase project, run the current `supabase-schema.sql` in the SQL Editor before deploying matching app files. If Postgres reports that it cannot remove parameter defaults from `production_activity_reset(text)`, run:

```sql
drop function if exists public.production_activity_reset(text);
```

Then rerun the full schema.

## What the hardened RLS is intended to enforce

- Only active ledger members can read ledger data.
- Only ledger admins can manage members, roles, group settings, and settlement periods.
- Trips can be inserted/updated by admins, the trip creator, or the driver.
- Trip participants can be changed by admins or users who can manage the parent trip.
- Fuel payments can be inserted/updated by admins, the fuel-log creator, or the payer.
- Settlement requests can be inserted/updated by admins or the involved payer/receiver.
- Push subscriptions are scoped to the signed-in user.

## Checks before relying on real users

1. Every active real member has the correct login email in `ledger_members.email`.
2. At least one active member has `role = 'admin'`.
3. Test/generated members are inactive or removed.
4. Non-admin users can add their own trips/fuel but cannot access Admin tools.
5. Normal users cannot edit another member's trip/fuel log through the UI.
6. Settlement request, paid status, and period closing still work after refresh.
7. Browser console and Supabase logs show no RLS errors during normal flows.

Useful check:

```sql
select name, email, role, is_active
from ledger_members
where ledger_id = 'main-car'
order by is_active desc, role, name;
```

## Production JSON API guard

Hosted deployments must configure `FUEL_LEDGER_API_SECRET`. Render automatically enables protection for `/api/state` and `/api/payment-action`; if the secret is missing, those endpoints fail closed with `503 Service Unavailable`. Local development and Playwright remain open by default unless `FUEL_LEDGER_REQUIRE_API_AUTH=1` is set.

For maintenance calls, send either:

```txt
X-Ledger-Api-Secret: <same value as FUEL_LEDGER_API_SECRET>
```

or:

```txt
Authorization: Bearer <same value as FUEL_LEDGER_API_SECRET>
```

The frontend must not know this secret; production app data should use Supabase/RLS, not the JSON fallback API.

## Known remaining limitation

`car_share_ledgers` remains a compatibility JSON state table for backups/fallback reads, but it should not be published through Supabase Realtime. Migration `018_realtime_publication_cleanup.sql` narrows the Realtime publication to `ledger_events` so lightweight sync remains available without streaming broad JSON table changes.


### Request-before-close settlement rule

Closing a settlement period now requires every calculated final payment to be requested first. Payments do not need to be marked paid before close; requested-but-unpaid payments remain visible in Payments and can be marked paid after the period is archived.


### Secure scheduled reminder endpoint

The `/api/run-reminders` endpoint now fails closed. `REMINDER_CRON_SECRET` must be configured for HTTP cron calls. If it is missing, the endpoint returns `503 Service Unavailable`; if the header/token is missing or wrong, it returns `401 Unauthorized`. Local CLI runs such as `npm run reminders:dry-run` continue to work without the HTTP secret.

Required production headers for cron calls:

```txt
X-Reminder-Secret: <same value as REMINDER_CRON_SECRET>
```

Never commit the cron secret or Supabase service role key. Store them only in Render and the cron provider.


## 2026-06-12 - Stable closed payment reminder identity

- Version `2026.06.12.21` / cache `fuel-ledger-v58` / build `booking-calendar-actions`.
- Closed-period reminders now prefer the preserved settlement `paymentKey` before generating a closed-period fallback key.
- Requested payments that are reminded while the period is open keep their repeat-window metadata after the period is closed, preventing an immediate duplicate reminder.
- Closed-period requested/unpaid payments remain eligible for future reminders after the configured repeat window.

## Completed: reducing full-state JSON writes

The app now treats normalized Supabase tables as the primary write path and keeps the full JSON state mirror as a periodic/manual safety backup. This reduces write volume, event noise, and the chance of sync feedback loops while preserving recovery/export fallback behavior.


## Completed: destructive admin safety backups

Destructive admin actions must export a local backup and, when signed in to Supabase, force a JSON mirror safety backup before changing/removing important ledger data. The protected reasons are listed in `requiredAdminSafetyBackupReasons` in `app.js` and covered by `tools/test-supabase-schema-hardening.mjs`. This currently covers current-period reset, full local reset, backup import, period close, production activity reset, generated test-data cleanup/purge, and unused test-user removal. If a future patch adds another destructive admin action, add the backup call and extend the test at the same time.

Retention/privacy cleanup is intentionally separate: it only removes temporary notification events, stale push subscriptions, old cloud/local Test Lab reports, and local load-monitor events, not trips, fuel logs, bookings, settlements, closed periods, or audit-critical history.


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old cloud `test_lab_reports` while keeping the newest reports, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migrations `009_retention_privacy_cleanup.sql` and `021_cloud_test_lab_report_retention.sql` before using the cloud cleanup buttons.


## 2026-06-15 final hardening state

The current target state is:

- Normalized tables are the primary write/read path for trips, bookings, fuel payments, members, settlements, and report history.
- Critical write/admin actions are protected by RPCs and surfaced through `fuel_ledger_healthcheck('main-car')`.
- Supabase Realtime is narrowed to `public.ledger_events` only. The broad JSON table `public.car_share_ledgers` remains as backup/fallback storage but should not be in the Realtime publication.
- Cloud-saved Test Lab/Security Health reports are immutable rows in `public.test_lab_reports`; old saved reports are historical audit records and should not be treated as current health.
- Generated Test Data buttons that write/remove live ledger rows require the advanced admin/test unlock plus typed confirmation. Cleanup uses strict `auto-test-` id matching instead of marker-only note/station matching.

Use this SQL as the quick health gate:

```sql
select public.fuel_ledger_healthcheck('main-car');
```

The result should have `ok: true`, all values under `critical_rpcs` set to `true`, and `realtime_publication.extra_tables` as an empty array.


## CSP inline style cleanup

- Inline style CSP allowance has been removed: `style-src 'self'` is now used in static, Vercel, and local server headers.
- Runtime helper positioning uses CSS classes instead of inline style mutations where practical.
- `tools/test-security-headers.mjs` fails if `unsafe-inline` or inline markup styles return.

### Diagnostic redaction hardening

- Debug/Test Lab reports must redact emails, phone numbers, coordinates, session/token fields, API keys, cookies, passwords, JWT-like strings, Authorization header values, and sensitive URL query parameters before download or cloud storage.
- Build metadata such as app versions and ISO timestamps should remain readable; phone redaction must not turn release versions or dates into false phone matches.
- Validation should fail if these diagnostic redaction markers or checks are removed.

## Release-readiness companion checks

The release-readiness companion checks enforce security-hardening hygiene before deploys. runtime file changes must update both `build-info.js` and `service-worker.js`; migration changes must update schema, migration docs, tests, and the deployment checklist; security header/CSP changes must update header tests and this hardening guide; CI/pre-push changes must update the CI guardrail checker, release-readiness guardrail tests, and maintenance notes.


- Settlement request status updates now prefer `upsert_settlement_request_status`, keeping the payment status row and stale-payment-line cleanup in one database transaction; keep the regression tests wired into validation.

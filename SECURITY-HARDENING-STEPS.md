# Security hardening notes

For a fresh Supabase project, run `supabase-schema.sql`. It creates the normalized tables, helper functions, and member-restricted RLS policies used by the table-primary app.

For an existing Supabase project, run the current `supabase-schema.sql` in the SQL Editor before deploying matching app files. If Postgres reports that it cannot remove parameter defaults from `production_activity_reset(text)`, run:

```sql
drop function if exists public.production_activity_reset(text);
```

Then rerun the full schema.


## 2026-06-15 hardening consolidation status

The main security hardening roadmap is complete for the current architecture. Deployed guardrails now include:

- Supabase/RLS hardening and transactional RPCs for settlement closing, trips with participants, booking save/delete, member administration, generated-test purge, production reset, retention cleanup, and scheduled reminder state.
- CSP and security-header parity across Vercel, static `_headers`, and the local Python server.
- Admin/Test Lab protections: typed confirmations, local-only default test reports, advanced tool unlocks, admin-only backend probes, RPC-backed purge/member actions, and backup-before-destructive-action safeguards.
- Admin reconciliation safety: normalized-table freshness gate plus forced backup before soft-deleting table rows from JSON reconciliation.
- Reduced full-state JSON mirror writes: normalized tables are the primary path; JSON remains a periodic/manual recovery mirror and forced backup surface for dangerous flows.
- Diagnostic/privacy redaction for downloaded and cloud-synced Test Lab/Supabase diagnostic reports.
- CI, pre-push, and release-readiness guardrails covering validation, migration coverage, runtime/cache metadata, header parity, and Playwright smoke tests.

### Remaining non-urgent hardening opportunities

- Retire or further restrict `car_share_ledgers` once all reads/writes are fully normalized-table primary.
- Add more database-level constraints for business invariants that are currently enforced mostly in app logic, such as fuel odometer/capacity sanity and stricter booking lifecycle transitions.
- Continue reducing Realtime/list_changes noise by keeping Realtime opt-in/manual and monitoring JSON mirror write frequency after larger releases.
- Add a small release-history/admin diagnostics panel that shows the active build label, expected service-worker cache, last release check, and migration level.
- Consider a staging Supabase project for full migration drills before large schema/RPC changes.

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

`car_share_ledgers` is still a compatibility JSON state table. It is broader than the normalized table RLS because the current app still relies on it for shared state/backups. The safest long-term hardening step is to complete the move to normalized-table-primary reads/writes and then restrict or retire broad JSON updates.


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


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migration `009_retention_privacy_cleanup.sql` before using the cloud cleanup buttons.

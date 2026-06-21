- 2026-06-21 10:35 UTC: v367 workspace resolution visibility exports URL/user memory/linked workspaces/decision details in load reports and prefers a non-owner user's single non-default workspace over the configured default.
- 2026-06-21 10:20 UTC: v366 stability overhaul pass 1 scopes remembered workspace selection per signed-in user, avoids false Settings/vehicle lookup blocked failures during startup loading, clears stale lock text after workspace load, and adds a visible Workspace session debug card.
- 2026-06-21 09:15 UTC: v362 filters Latest Data I/O diagnostics the same way as operation status, keeps optional owner/workspace panel failures inside their sections, disables Owner Activity refresh while loading, and suppresses duplicate owner-activity skip rows.
- 2026-06-19: v233 separates workspace-admin scope from primary app-admin tools. Admins of secondary/private workspaces can manage only their workspace settings, members, and invites; global Data tools, Security Health, Render admin health, diagnostics, backups/imports, and Test Lab stay hidden outside the primary app-admin workspace.
- 2026-06-19 v229: Member-facing onboarding actions now have their own Admin Data I/O flight-recorder group with stable result codes for workspace refresh, create, switch, invite redeem, and profile setup so beta-user failures are visible without DevTools.
- 2026-06-19 v217: Normal foreground writes for trips, fuel, bookings, booking deletes, payment-status actions, and ledger-directory sync now fail closed through Render instead of falling back to browser Supabase RPC/direct-table writes.

## Continuous integration

Before pushing, run locally:

```bash
npm run validate
npm run test:e2e
```

The Playwright suite includes persistence, payment-request locking, period-aware audit, build-info, and permission UX smoke tests. Treat any failure as a blocker before deployment.

After pushing, check the GitHub Actions CI result. Deploy or trust Render auto-deploy only after the CI run is green.

# Deployment checklist

## Current release target

These values are checked by `npm run release:check`. When a runtime release changes `build-info.js` or `service-worker.js`, update this block in the same patch so the deployment checklist cannot drift from the app version shown in Admin -> Version & update status.

- Version: `2026.06.18.257`
- Service-worker cache: `fuel-ledger-v367`
- Updated at: `2026-06-21T10:35:00.000Z`
- Top release note: Workspace resolution is now exported in load reports and the resolver explains why it picked main-car or another workspace; non-owner users with one joined non-default workspace are preferred into that workspace instead of drifting to the default.
## Invite beta readiness: member action Data I/O

- Admin diagnostics now groups Data I/O into Admin actions, Member actions, Sync/load/write actions, and Background diagnostics.
- Member-facing invite-beta flows record stable result codes for workspace refresh, workspace creation, workspace switch, invite redemption, restricted-invite email preflight, and profile setup.
- Use the Member actions group before DevTools when a beta user reports onboarding trouble.


## Invite beta readiness: Account tab and update handoff

- Signed-in members now have an Account tab for their own profile, workspace switching/creation, invite redemption, and current-workspace invite creation when they are admin for that workspace.
- Regular members can create their own new private workspace; they become admin there before creating invite links for it.
- Existing admin-only diagnostics remain in Admin; Account only exposes member/workspace onboarding tools.
- Service-worker updates now request immediate activation and perform one safe reload when no local changes/foreground writes are pending.

## Invite beta readiness: regular-member state load

- Regular invited members must be able to load their workspace via Render `/api/state/load` immediately after invite redemption and profile setup.
- The backend verifies the Supabase user is an active member of the requested workspace before using service-side reads for the full workspace state view.
- Cross-workspace state loads still fail closed before any state rows are returned.

## Invite beta readiness: regular-member write scope

- Confirm invite beta testing includes a non-admin user session, not only the workspace admin.
- Normal trip, fuel, booking, booking delete, and payment-status write routes verify the signed-in user is an active member of the target workspace before calling Supabase RPCs.
- Non-admin users can write only their own trip/fuel/booking rows. Admins can write for other active members. Cross-workspace member IDs fail closed before RPC execution.

## Required release gate

Before pushing or deploying a release candidate, run:

```bash
npm run release:check
```

This runs the static/unit validation suite and the release-readiness checker. For app behavior changes, also run the browser smoke suite if it was not already included in your local pre-push run:

```bash
npm run test:e2e
```

Install the local Git hook once per checkout so pushes run the same gate automatically:

```bash
npm run hooks:install
```

Run database migrations before deploying app files. When a patch adds files under `supabase/migrations`, apply the new migration or the consolidated `supabase-schema.sql` first, then deploy the matching frontend/server files.

Bootstrap-lock releases need the database migration before the app is served. Confirm `ledgers.bootstrap_locked_at` exists, `is_ledger_bootstrap_open(...)` returns false for locked ledgers, and the bootstrap lock trigger has run after the first active admin member with an email is attached. If these checks fail, stop the deployment and apply the latest `supabase/migrations` or the matching `supabase-schema.sql` again.


Use this checklist when applying database or app changes to an existing Fuel Sharing deployment.

## Before deploying

1. Download a Supabase database backup or create a staging project with a copy of production data.
2. Confirm you are using matching files from the same release/ZIP, especially `app.js` and `supabase-schema.sql`.
3. Confirm the frontend `supabase-config.js` contains only the public Supabase URL and anon key. Never put service-role keys in frontend files.
4. Confirm Render/server environment variables are configured only in the hosting dashboard.

## Database update

Run `supabase-schema.sql` in the Supabase SQL Editor before deploying the updated app files. This release installs/updates the `close_settlement_period` RPC used for transactional period closing; deploy the schema first so the frontend does not need to use its compatibility fallback.

The schema is designed to be re-runnable with `create table if not exists`, `create or replace function`, and `drop policy if exists` statements.

### Existing `production_activity_reset` function

If Supabase shows this error:

```text
ERROR: 42P13: cannot remove parameter defaults from existing function
HINT: Use DROP FUNCTION production_activity_reset(text) first.
```

Run this once, then rerun the full schema:

```sql
drop function if exists public.production_activity_reset(text);
```

Only use `cascade` if Supabase reports dependency errors and you understand what will be dropped.

## App deployment

After the SQL update succeeds, deploy the matching app files:

- `index.html`
- `app.js`
- `styles.css`
- `server.py`
- `utils.js`
- `supabase-helpers.js`
- `data-store.js`
- `settlement-calculations.js`
- `permission-helpers.js`
- `ui-messages.js`
- `sync-status-helpers.js`
- `location-privacy-helpers.js`
- `ledger-model.js`
- `period-closing-helpers.js`
- `audit-log.js`
- `notifications.js`
- `admin-tools.js`
- `build-info.js`
- `service-worker.js`
- `manifest.json`
- icons
- `requirements.txt`


### Data retention/privacy cleanup verification

- Confirm saved Test Lab/Security Health reports are privacy-pruned before local/cloud storage.
- Confirm retention cleanup takes a fresh safety backup and still excludes trips, fuel logs, bookings, settlements, closed periods, and audit-critical ledger history.
- Confirm Supabase load report exports still redact browser, session, token, email, phone, location, and authorization fields before download.

## Validation

Before deploying app files, run:

```bash
npm run validate
```

For browser-level coverage before larger changes, also run:

```bash
npm run test:e2e
```


## Runtime module/cache consistency

### Build metadata and service-worker rule

If any runtime file changes, update both `build-info.js` and `service-worker.js` in the same patch. Keep `BUILD_INFO.expectedServiceWorkerCache` equal to the service worker `CACHE_NAME`, and keep cached runtime assets aligned with scripts loaded by `index.html`. Test-only and documentation-only changes do not need this bump.


Before deployment, `node tools/check-app-references.mjs` must pass. It now checks all three of these stay aligned:

- runtime script order in `index.html`
- cached app-shell files in `service-worker.js`
- extracted helper files scanned for missing references

If you add a new browser module, update all three places in the same commit.

## Smoke test

After deployment, test with an admin account and a normal member account:

1. Sign in as admin.
2. Open the System health/admin panels.
3. Create a trip.
4. Add/edit participants.
5. Add a fuel payment.
6. Create or request a settlement payment if you use that flow.
7. Close a settlement period if needed.
8. Sign in as a normal member.
9. Confirm the member can create their own trip and fuel payment.
10. Confirm the member cannot edit another member's trip/fuel payment.
11. Refresh the page and confirm the data still loads from Supabase.
12. After creating a trip/fuel log, check the browser console for `Normalized table dual-write failed`. Treat that warning as a failed deployment test.
13. On a phone/home-screen install, fully close and reopen the app, then confirm the new trip/fuel log is still visible after refresh.

## Rollback

If the app breaks after deployment:

1. Redeploy the previous app files.
2. Restore the Supabase backup if the database state was changed incorrectly.
3. Check browser console errors and Supabase SQL/RLS errors before retrying.

## Home-screen / PWA deployment check

After changing `app.js`, `utils.js`, `supabase-helpers.js`, `data-store.js`, `settlement-calculations.js`, `permission-helpers.js`, `ui-messages.js`, `sync-status-helpers.js`, `location-privacy-helpers.js`, `ledger-model.js`, `period-closing-helpers.js`, `audit-log.js`, `notifications.js`, `admin-tools.js`, `styles.css`, icons, `manifest.json`, or `index.html`:

1. Confirm the changed files are listed in `service-worker.js` under `CORE_ASSETS`.
2. Bump the `CACHE_NAME` value in `service-worker.js`.
3. Deploy `service-worker.js` together with the changed app files.
4. On a phone, fully close and reopen the installed home-screen app.
5. If an old version is still visible, open the site in the browser once, refresh, then reopen the home-screen app.

## Payment request locking smoke test

After deploying a build that touches trips, fuel logs, settlements, or payment request status:

1. Create a trip and confirm a success message appears.
2. Create a fuel log and confirm a success message appears.
3. Request a settlement payment and confirm a success message appears.
4. Try to add/edit/delete a trip or fuel log while the payment is requested; the app should block it and explain that the payment must be reopened first.
5. Reopen the payment, make the correction, and request it again.
6. Refresh/reopen the home-screen app and confirm the corrected data persists.

## Optional browser smoke test before deployment

For larger app changes, especially changes touching trips, fuel logs, payments, persistence, service workers, or module loading, run:

```bash
npm install
npx playwright install
npm run test:e2e
```

The smoke test verifies the local fallback flow: create trip, create fuel log, refresh, and confirm both entries remain visible.


### Audit/change log

Money-related actions are recorded in `state.auditLog` and rendered in the History tab. The runtime module `audit-log.js` normalizes entries and labels actions such as trip/fuel changes, payment requests, payment reopening, and settlement close events.


### Audit log persistence and edit details

Audit entries for trip/fuel/payment/settlement changes are mirrored to the ledger backup immediately when they change, so the change log survives refresh even when normalized tables are the primary data source. Edit entries include concise before/after details for important changed fields.

- Hotfix: current-period reset no longer references an undefined `period` variable. Current-period reset also clears the current audit log because those entries belonged to the deleted open period.


### Period-aware audit log

Audit history is now period-aware. Current/open-period audit entries live in `state.auditLog`. When a settlement period is closed, the current audit entries are copied into `closedPeriod.auditLog` together with the settlement-close event, then the new open period starts with an empty audit log. Resetting/deleting the current open period clears its audit entries as well. Closed period cards include a Change log subsection for the frozen period history.

### Period-aware audit smoke test

The automated Playwright suite verifies that current-period audit entries clear on reset/close and that completed settlement periods keep a frozen Change log. Run `npm run test:e2e` before deploying audit or settlement-period changes.

## PWA version check

After deployment, open Admin -> Version & update status and verify the app version/build label and service-worker cache match the expected release. On phones/home-screen installs, fully close and reopen the app if the service-worker cache is stale.
\n- Added a user-visible About tab with read-only app version and PWA cache status so non-admin members can report their running build.

## Completed-period archive smoke check

After deploying archive/history changes:

1. Close at least one test settlement period.
2. Open History -> Closed periods.
3. Search for a trip note, station, or member from the closed period.
4. Confirm the archive summary and results update.
5. Clear filters and confirm the completed period card shows its frozen Change log.

## Completed-period CSV export check

After deploying the completed-period CSV export patch, open History -> Closed periods, expand a completed period, and verify the card shows Export CSV and Export change log CSV. The old Markdown Download report action should no longer appear. Export both CSV files once from a non-production test period or a safe archived period.

### CSV download smoke test

After deploying CSV export changes, test at least one completed period in Safari/PWA:

1. Open History -> Closed periods.
2. Click Export CSV.
3. Click Export change log CSV.
4. In Chrome, confirm files download. In Safari or a home-screen PWA, confirm the in-app CSV export panel appears and Copy CSV works.
5. If testing a home-screen PWA, also verify About -> App version shows the expected cache.

### Payment audit details

Payment audit entries now include clearer summaries and before/after status details, for example `Status: Not requested -> Requested` together with payer, recipient, amount, and currency metadata. The completed-period change-log CSV export includes these payment metadata columns so frozen payment history is easier to audit.

### Permission UX smoke check

- Sign in as a normal member and open another member's trip/fuel entry in History.
- Confirm edit/delete controls are absent and a permission note explains who can change the entry. This is also covered by `npm run test:e2e`.
- Try a payment action for the wrong side of a settlement and confirm the app explains who must request, reopen, or mark it paid.


## Repo cleanup after applying this patch

If your repository already tracks generated files, run this once locally before committing:

```bash
git rm -r --cached node_modules __pycache__ app.js.bak 2>/dev/null || true
git status
```

Then run:

```bash
npm run validate
npm run test:e2e
```

The browser tests now use `server.py`, not a static file server, and write local test state to `.playwright-ledger-data.json`. That file is ignored by Git.

## Repository hygiene before pushing

Run the validation suite before every push:

```bash
npm run validate
npm run test:e2e
```

The validation suite includes a tracked-artifact guard. It fails if generated files such as `node_modules/`, `__pycache__/`, `*.bak`, Playwright reports/results, `.playwright-ledger-data.json`, or `.DS_Store` are accidentally committed.


- In Admin → Group settings, confirm the low/high fuel-price warning range saves, valid fuel logs save, missing liters are blocked, and outside-range DKK/L values are blocked with a clear message.

### Member and role management UX

Admin member management now shows clearer role/access descriptions for each member row. Role changes that promote a member to admin or demote an admin now require confirmation, protected admin rows explain why they are locked, and save/add/deactivate messages include the affected member and role.

Manual check: Admin -> Member management, verify Member/Admin descriptions, try promoting/demoting a test member, and confirm at least one active admin remains protected.


### Playwright state isolation

Before committing test changes, run `npm run test:e2e`. The suite should reset its isolated `.playwright-ledger-data.json` state automatically before each test. If local state ever looks suspicious, remove it manually with `rm -f .playwright-ledger-data.json` and rerun the tests.

## Payment reminder smoke check

After deploying the payment-reminders build:

1. Request a payment.
2. Click **Send reminder** on the requested payment.
3. Confirm History -> Change log shows **Payment reminder sent**.
4. On a device with notifications enabled for the payer, confirm a mobile/PWA notification is received.
5. On devices without notification subscriptions, confirm the app explains that the reminder was recorded but no active subscription was found.


### Automatic payment reminders

Build `automatic-payment-reminders` adds configurable app-open payment reminders. Admins can enable/disable reminders and set the first reminder delay, repeat interval, and maximum automatic reminder count in **Admin → Group settings**. Requested payments are checked in both the current settlement and closed settlements when the app opens. Closed settlement amounts stay frozen, but requested payments can still be marked paid from the closed-period detail view, with the payment status change recorded in that period's frozen change log.


## Backend payment action helper

Payment status changes and payment reminders now use `/api/payment-action` in server-backed/local mode. The endpoint applies the payment status update and the matching audit entry in one server-side state mutation, which keeps `/api/state`, local browser mirrors, and audit history aligned during Playwright and non-Supabase deployments. Supabase deployments continue to use the existing normalized-table/RLS path until the same action contract is moved into Supabase RPC functions.

### Backend payment action test stability

Payment status clicks are now awaited in the shared click handler, and the Playwright helper waits for server-backed payment actions to finish before closing a period. The manual payment reminder assertion is optional in the locking smoke test because automatic reminders may be the primary reminder path in this build.



- Backend payment action state sync: payment actions now flush current local state to `server.py` and cancel stale debounced saves before applying server-authoritative payment status/audit updates.

### Closed-period paid-status check
- After closing a period with a requested payment, open History -> Closed periods.
- Confirm the unpaid payment clearly shows `Mark paid` and explains that it only updates payment status/change log.
- Mark it paid and confirm the closed-period change log records the update.

### Closed-period payment persistence and layout

Closed-period final payment cards use a stacked layout with payer/receiver, amount/status, action, and explanatory text separated for readability. Marking a closed-period payment paid now forces the JSON mirror/remote state to save immediately and keeps the closed-period card expanded after the UI re-renders, so the paid status survives refresh and the user does not lose their place.

### Unpaid payments smoke check

After deploying, open Payments and confirm requested unpaid payments from both current and closed settlements appear there. Marking a closed-period payment paid should remove the visible Mark paid action, show the paid status, and persist after refresh.

### Closed-period payment card check
- In History → Closed periods, verify the final payment card reads cleanly, amount/status are aligned, and the receiver or payer can mark a requested closed-period payment as paid.


### Closed-period payment persistence check

After deployment, open **History → Closed periods**, mark a requested closed-period payment paid, refresh the app, and confirm the same payment still shows as paid. Also check the **Payments** tab to confirm it no longer appears as unpaid.


### History archive and Payments UX

- The Payments tab is the primary place for unpaid payment follow-up. It gathers requested-but-unpaid payments from both the current settlement and closed periods.
- History -> Closed periods is an archive/reference area for completed settlement evidence, audit logs, exports, and dispute checks.
- Closed-period payment cards can still be inspected from History, but unpaid follow-up should usually start from Payments.
- Unpaid payment cards for closed periods include a “View closed period” shortcut back to the relevant archive card.


## Request-before-close check

Before closing a period, verify that all settlement payments have been requested. The close button stays disabled while any calculated settlement payment is still open, but requested payments may remain unpaid after close.

## Scheduled backend reminders

- Set `REMINDER_CRON_SECRET` in Render/server environment before exposing the cron endpoint.
- Configure a daily cron/scheduler request to `POST /api/run-reminders` with header `X-Reminder-Secret: <secret>`.
- Confirm `npm run reminders:dry-run` works against the intended data file before enabling the live scheduler.
- Push notifications require existing `SUPABASE_URL`, service role/anon key, VAPID keys, and active user push subscriptions; otherwise reminders are still recorded in the audit log.


### Reminder backend diagnostics

Build `reminder-backend-diagnostics` adds detailed `/api/run-reminders` output so cron tests can explain why `dueCount` is zero. The response now includes scanned current/closed payment counts, requested payment counts, due counts, skip reasons, and sample rows with `dueAt`, `lastReminderAt`, and `reminderCount`. This helps distinguish backend scheduled reminders from browser/app-open notifications.

## 2026-06-12 - Cache version alignment

- Updated build info to version `2026.06.12.12` with build label `cache-version-alignment`.
- Aligned the expected service worker cache with the active service worker cache: `fuel-ledger-v49`.
- This fixes the version panel showing a false cache mismatch after the reminder backend diagnostics build.


## Supabase-backed scheduled reminders

For build `supabase-reminder-rpc`:

1. Run the latest `supabase-schema.sql` in Supabase SQL Editor. This installs `scheduled_reminder_state` and `save_scheduled_reminder_state` RPC helpers.
2. In Render, confirm these server-only env vars are configured:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_REMINDER_LEDGER_ID=main-car`
   - `REMINDER_CRON_SECRET`
   - `FUEL_LEDGER_API_SECRET`
3. Keep `REMINDER_DATA_SOURCE` unset for automatic Supabase mode. Set `REMINDER_DATA_SOURCE=local` only for local JSON testing.
4. Deploy, then run the live curl check. Confirm the response shows `backendMode: "supabase"` and non-zero scanned counts when requested/unpaid payments exist in production.
5. Rotate `REMINDER_CRON_SECRET` if it was pasted into logs, screenshots, or chat.

### Closed-period reminder timestamp check

After deploying `closed-period-reminder-timestamps`, run `/api/run-reminders` once and check diagnostics. Legacy requested closed-period payments should no longer be skipped only as `missing-request-time` when the period has a usable closed timestamp.


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
### Production JSON API protection

Before deploying this build to Render, set `FUEL_LEDGER_API_SECRET` to a separate random value. Render-hosted `/api/state` and `/api/payment-action` now fail closed if this secret is missing, and return `401` unless maintenance requests include `X-Ledger-Api-Secret` or `Authorization: Bearer ...`. Do not expose this secret to frontend JavaScript.



### Test Lab scenario matrix

The Test Lab now includes a scenario matrix for ledger invariants, payment lifecycle checks, permission boundaries, backup/import validation, location privacy, booking edge checks, synced report storage, and runtime/PWA metadata. Cloud-saved reports are stored in the normalized `test_lab_reports` history table as immutable rows. The legacy JSON report list is retained only as a local/fallback view.


### Sync clarity update

Supabase Realtime is off by default. Use **Sync now** to refresh shared data on demand. Critical actions such as closing periods or updating payment status warn and offer a refresh when the local copy may be stale.

### Sync recovery UX deployment note

- After deploying `2026.06.14.54 / sync-recovery-ux`, reload once so the active service worker cache is `fuel-ledger-v153`.
- If a device still shows the old red `Local only` startup timeout, clear site data or remove/reinstall the PWA to force the new runtime.
- Confirm that a successful `Sync now` clears `Cloud delayed` and returns the badge to `Database`/`Cloud`.

### Test Lab inspect edit prefill deployment note

- After deploying `2026.06.14.55 / testlab-inspect-edit-prefill`, reload once so the active service worker cache is `fuel-ledger-v154`.
- Verify a Test Lab fuel odometer failure button opens the referenced fuel log in edit mode with the odometer/date fields pre-filled.

## Fuel correction math explainer deployment note
- Deploy build `2026.06.14.58 / fuel-correction-math-explainer` with service-worker cache `fuel-ledger-v157`.
- After deployment, reload the PWA once and confirm the overfill panel shows the "Why these suggestions?" calculation block.

## JSON mirror write reduction check

After deployment, make one small trip/fuel/booking edit and verify the Supabase load monitor shows normalized table activity without repeated `JSON mirror saves`. A JSON mirror save may still occur when the backup interval has elapsed or an audit-critical flow forces a snapshot.

## Destructive admin backup check

Before deploying a patch that adds or changes destructive admin actions, verify `npm run validate` includes `testDestructiveActionBackupsExist`. The action should call `await exportAdminSafetyBackup("...")` before it resets, imports over, closes/archives, purges, or removes important ledger data. Cloud backup failure should block the destructive action instead of continuing.

## Admin/Test Lab protection verification

- Confirm Safe Test Lab is visible to admins and remains local-only.
- Confirm Security Health is labeled cloud-touching and requires typed confirmation.
- Confirm Advanced stress tools are hidden until “Unlock advanced admin tools” is confirmed.
- Confirm generated test trip/fuel creation and generated-data removal require the advanced admin/test unlock plus typed confirmation.
- Confirm generated-data cleanup only removes strict `auto-test-` entries and leaves real rows with ordinary notes/stations untouched.
- Confirm non-admin members cannot access Admin/Test Lab tools.


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old cloud `test_lab_reports` while keeping the newest reports, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migrations `009_retention_privacy_cleanup.sql` and `021_cloud_test_lab_report_retention.sql` before using the cloud cleanup buttons.


## Final hardening baseline deploy verification

After applying migrations through `019_immutable_test_lab_report_history.sql` and deploying the current app files, verify:

1. About/Admin build metadata shows `2026.06.15.97`, build `immutable-test-lab-report-history`, cache `fuel-ledger-v196` or newer.
2. Admin -> Security Health passes with no failed checks.
3. Admin diagnostics show RPC availability healthy and Realtime publication narrow.
4. SQL `select public.fuel_ledger_healthcheck('main-car');` returns `ok: true`, all `critical_rpcs` values `true`, and `realtime_publication.extra_tables: []`.
5. Supabase Realtime publication includes only `public.ledger_events`.
6. Saving a Security Health/Test Lab report to cloud creates a new `public.test_lab_reports` row instead of updating the previous row.
7. Historical saved reports are collapsed/marked historical and do not replace the latest live run in the Admin panel.
8. `npm run validate`, `npm run test:e2e`, and `npm run release:check` pass before pushing.

Post-deploy performance check: after 15-30 minutes of normal use, review Supabase Top Queries and compare `realtime.list_changes` against the pre-cleanup baseline.

## Release-readiness companion checks

Before pushing a release, run `npm run release:check`. The release-readiness companion checks are intentionally strict:

- Runtime app file changes must include both `build-info.js` and `service-worker.js` so the deployed app and PWA cache report the same version.
- Supabase migration changes must include `supabase-schema.sql`, `supabase/MIGRATIONS.md`, migration tests, and this deployment checklist.
- Security header/CSP changes must update `tools/test-security-headers.mjs` and `SECURITY-HARDENING-STEPS.md`.
- CI/pre-push/release guardrail changes must update `tools/check-ci-guardrails.mjs`, `tools/test-release-readiness-guardrails.mjs`, and `MAINTENANCE-NOTES.md`.


- Apply migration `022_settlement_request_transaction_rpc.sql` before deploying runtime assets that call `upsert_settlement_request_status`; Security Health should show the settlement request transaction RPC in the critical RPC list.

### Schema migration tracking check

- Apply `supabase/migrations/023_schema_migration_tracking.sql` after `022_settlement_request_transaction_rpc.sql`.
- Run Security Health after deployment and verify schema migrations show the latest expected migration with no missing migration IDs.
- For future migrations, confirm the migration inserts its own ID into `public.fuel_ledger_schema_migrations` and that `npm run validate` passes.

### Migration tracking deployment note
- When applying `023_schema_migration_tracking.sql`, confirm the migration policy references `ledger_members.email` / `current_user_email()` and does not reference a non-existent `ledger_members.auth_user_id` column.

- Apply `supabase/migrations/024_schema_drift_healthcheck.sql` after `023_schema_migration_tracking.sql`; then run Security Health and confirm migration tracking plus schema drift both report OK.


### Workspace foundation / public launch readiness

- Apply `supabase/migrations/025_workspace_foundation.sql` before deploying builds that expect workspace readiness diagnostics.
- Confirm Security Health stays green and reports no missing migrations/schema drift after applying the migration.
- Public signup remains disabled by default; do not advertise broadly until invite onboarding, per-workspace UI, and rate limits are complete.

## Migration 026 invite onboarding foundation
- Apply `supabase/migrations/026_invite_onboarding_foundation.sql` after `025_workspace_foundation.sql`.
- Confirm Security Health shows migration `026_invite_onboarding_foundation` applied and schema drift OK.
- Keep public signup disabled. Invite RPCs are groundwork only until the workspace selection/join UI and abuse controls are complete.

- Apply `027_invite_code_generation_pgcrypto_fix.sql` and `028_invite_code_hash_pgcrypto_fix.sql` after invite onboarding so Admin invite creation can generate and hash one-time codes.

### Invite redemption migration 029 tracking column check

- Before applying `029_invite_redeem_return_ambiguity_fix.sql`, confirm the SQL writes to `public.fuel_ledger_schema_migrations (migration_id, description)` only. Existing deployed migration-tracking tables do not have a `notes` column, so release SQL must not use `(migration_id, notes)`.
- After applying migration 029, verify Security Health shows latest expected/applied migration `029_invite_redeem_return_ambiguity_fix` before retrying invite auto-redemption.


### 2026-06-16 onboarding abuse/rate-limit foundation

- Migration `030_onboarding_abuse_rate_limits.sql` adds `public.ledger_onboarding_rate_limits` and `enforce_onboarding_rate_limit(...)` for private workspace creation, invite creation, and invite redemption.
- Security Health reports `workspace_readiness.abuse_rate_limit_ready` after the migration is applied.
- This is a server-side foundation, not a public launch switch: keep public signup disabled until real-user invite testing, monitoring review, and abuse/rate-limit operations are complete.
- Confirm Render has `SUPABASE_URL` and `SUPABASE_ANON_KEY` configured before relying on `/api/payments/status-action`; payment actions should still fall back to direct Supabase RPC if the Render endpoint is unavailable during rollout.
- After sync/save debugging patches, verify Admin diagnostics shows the latest Data I/O source/route/table or RPC for any failed write instead of only a generic Saving/Syncing status.
- After service-worker updates, verify the App version panel shows either Current or Update ready; build-info.js must be network-first and mixed page/cache states should resolve after one close/reopen.
- After sync-status source-gate changes, verify background focus/realtime/admin diagnostics do not make the top bar show Saving/Syncing during normal idle use.


### v302 Render admin health endpoint

Admin diagnostics now includes a Render admin health check (`POST /api/admin/health`) that verifies the signed-in session, workspace admin permission, open settlement period, Supabase connectivity, and mounted backend safety routes before dangerous admin work.


## 2026-06-19 Security Health migration expectation cleanup

- Security Health migration reporting now expects the full shipped Supabase migration set through 032, includes the payment-status action RPC in critical RPC checks, and labels current migrations as current instead of showing later applied IDs as confusing extras.
- Apply `supabase/migrations/033_onboarding_rate_limit_scope_key_alignment.sql` after deploying the app runtime.
- Verify Security Health reports migrations current through `033_onboarding_rate_limit_scope_key_alignment` and includes `apply_payment_status_action` in critical RPC coverage.


- v218: Debug/report redaction now covers auth headers, cookies, Supabase key spellings, camelCase token fields, and credential containers before export or cloud/local storage.

### Invite actor_email ambiguity hotfix
- Apply `supabase/migrations/034_invite_rate_limit_actor_email_ambiguity_fix.sql` after deploying v222 if invite creation shows `column reference actor_email is ambiguous`.
- Verify invite creation reports Data I/O code `INVITE_CREATED` and Security Health reports migrations current through `034_invite_rate_limit_actor_email_ambiguity_fix`.

- 2026-06-19 v232: Workspace settings isolation fix: Render state-load carries the active ledger row so new workspaces do not inherit another workspace car/fuel settings, and signed-in one-member workspaces can save vehicle settings without the legacy two-person manual list blocker.

- 2026.06.18.234 / fuel-ledger-v334: Vehicle lookup now treats missing/unavailable providers as safe lookup outcomes with stable result codes instead of browser-visible 5xx responses; manual fuel settings remain the fallback.

## Release readiness metadata
- Top release note: Render backend auth now verifies Supabase ECC/P-256 access tokens locally through the project JWKS/public keys with rotation-aware caching, keeping the Supabase Auth network check as an explicit emergency fallback instead of the normal path.
- Top release note: `Settings save now verifies the canonical saved ledger row before reporting success: vehicle columns must exist, vehicle plate/details are read back after write, missing migration 038 fails with SETTINGS_SCHEMA_MISSING, and Data I/O shows which settings actually persisted.`

- Render API calls now use a shared frontend helper for fresh Supabase tokens, Authorization headers, timeouts, JSON parsing, and settings-save request handling instead of hand-rolled/stale token fetch code.

- 2026-06-21 09:00 UTC — Optional admin panel noise patch: workspace/invite refresh and owner-audit refresh no longer auto-run on Admin open or dominate Latest Data I/O; skipped rows are counted separately from failures; runtime cache `fuel-ledger-v361`.

- 2026-06-21 09:45 UTC — Settings workspace-lock diagnostics patch: settings/vehicle lookup lock now records selected-vs-loaded WORKSPACE_NOT_LOADED rows from the render path, prefers canonical active workspace over stale selector DOM, retries stale loading locks, and runtime cache is `fuel-ledger-v364`.

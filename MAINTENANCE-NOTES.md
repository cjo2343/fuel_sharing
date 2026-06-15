# Maintenance notes

## Current architecture

The app is mostly frontend-driven and uses Supabase for authentication, storage, realtime sync, and row-level security. `server.py` serves static files and handles push-notification endpoints that require server-side secrets.

`app.js` still contains most application behavior and event wiring, but high-risk reusable logic has been extracted into focused helper modules. Formatting/date/number helpers live in `utils.js`; persistence helpers in `data-store.js`; settlement/balance/rounding logic in `settlement-calculations.js`; permission rules in `permission-helpers.js`; toast/confirmation helpers in `ui-messages.js`; sync status copy in `sync-status-helpers.js`; fuel-location privacy logic in `location-privacy-helpers.js`; data-shape helpers and JSDoc typedefs in `ledger-model.js`; period-close readiness/fingerprint logic in `period-closing-helpers.js`; push helpers in `notifications.js`; audit normalization in `audit-log.js`; and admin diagnostics in `admin-tools.js`. Keep those helper files focused and avoid moving sensitive event wiring unnecessarily.

## Security model

- Supabase Auth identifies the signed-in user.
- `ledger_members.email` maps an auth email to a ledger member.
- RLS policies use helper functions such as `is_ledger_member`, `is_ledger_admin`, `can_manage_trip`, and `can_manage_fuel_payment`.
- Admins can manage the ledger broadly.
- Normal members can read ledger data but should only write records they are allowed to manage.

## Known legacy compromise

`car_share_ledgers` remains a broad JSON backup/state table. Ledger members can update it for compatibility with the current app architecture. The normalized tables now have stricter RLS than this legacy JSON state.

Long-term goal: move fully to normalized tables and either remove `car_share_ledgers` writes from normal app flows or make that table admin-only. For payment requests, frontend rules are mirrored by database trigger/RLS hardening in `supabase-schema.sql`; keep frontend permission helpers and SQL transition guards aligned. Period closing now prefers the `close_settlement_period` Supabase RPC, which closes the current period, writes the frozen snapshot, records the closing admin, and opens the next period in one database transaction; the frontend keeps a guarded table-update fallback only for databases that have not run the latest schema yet.

## Safe refactor order

The first extraction pass is complete. Current extracted modules:

1. `utils.js` — pure formatting/date/escaping helpers.
2. `supabase-helpers.js` — Supabase config/client/session/open-period helpers.
3. `data-store.js` — local persistence, backup validation, and remote-save queue helpers.
4. `settlement-calculations.js` — settlement/fuel-estimate calculations and balanced money rounding.
5. `permission-helpers.js` — trip/fuel/booking/payment permission rules and admin protection summaries.
6. `ui-messages.js` — toast/save-message/error/warning/confirmation helpers.
7. `sync-status-helpers.js` — sync badge labels and unsynced local-change details.
8. `location-privacy-helpers.js` — fuel-location privacy modes and coordinate payload shaping.
9. `ledger-model.js` — JSDoc typedefs and safe state-shape helpers.
10. `period-closing-helpers.js` — period-close readiness, open-payment checks, busy-state checks, and snapshot fingerprints.
11. `audit-log.js` — audit entry normalization and display metadata.
12. `notifications.js` — push-notification helper logic.
13. `admin-tools.js` — diagnostics and settlement-request cleanup helpers.

Next refactors should stay small and target cohesive sections such as trip rendering, fuel rendering, payment action handlers, or settings/admin event wiring. Leave destructive production-reset confirmation flow easy to audit.

After each step, run:

```sh
npm run validate
```

For larger changes or UI/write-path changes, also run:

```sh
npm run test:e2e
```

## Files that should not be committed

- `__pycache__/`
- `*.pyc`
- `.env`
- service-role keys
- private VAPID keys
- one-off local backup files


## Refactor progress

- `utils.js` contains pure formatting/date/escaping helpers.
- `supabase-helpers.js` contains Supabase client/config/session helpers and the open settlement period helper. Keep UI rendering and app state orchestration in `app.js` until each extraction can be validated independently.

## PWA update maintenance

The home-screen app is controlled by `service-worker.js`. Whenever deployable JavaScript, CSS, icons, or the app shell changes, bump `CACHE_NAME` and keep `CORE_ASSETS` in sync with the files loaded by `index.html`.

Current app-shell files include:

- `index.html`
- `styles.css`
- `supabase-config.js`
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
- `app.js`
- `manifest.json`
- `icon-192.png`
- `icon-512.png`

The app registration now calls `registration.update()` and reloads once when a newly activated service worker takes control, so installed PWA users should receive fresh deployments more reliably after closing and reopening the app.


## Data store refactor

`data-store.js` contains browser-local persistence helpers, local state writes, client id creation, and the remote-save queue wrapper. Keep UI rendering and Supabase table queries in `app.js`/`supabase-helpers.js` until they can be extracted in small validated steps.

## 2026-06-10 hotfix: normalized dual-write context

Fixed a regression where `syncNormalizedTablesFromJson()` referenced an undefined `context.currentMemberId` during full JSON-to-table reconciliation. The function now resolves the current ledger member id locally before upserting normalized trip and fuel rows.

The normalized table loader also falls back to the JSON mirror if both normalized trips and fuel rows are empty while the JSON mirror still contains activity. This prevents a partial/failed dual-write from making the current settlement period appear empty after refresh.


## Stability guard added after context hotfix

`tools/check-app-references.mjs` now includes a targeted regression guard for `syncNormalizedTablesFromJson()`. If that function contains a bare `context.*` reference again, validation fails before deployment.

Manual regression test for every refactor touching persistence/sync:

1. Create a trip.
2. Create a fuel log.
3. Confirm the console does not show `Normalized table dual-write failed`.
4. Refresh the app.
5. Confirm the current settlement period still contains the new trip and fuel log.


## Safety-net validation for critical writes

`tools/check-app-references.mjs` now performs a broader undeclared-identifier scan inside the critical normalized write functions:

- `saveTripToNormalizedTablesFirst()`
- `saveFuelToNormalizedTablesFirst()`
- `syncNormalizedTablesFromJson()`

This is intentionally narrower than a full JavaScript linter, but it is designed to catch the class of regressions that caused `context` and `currentMemberId` runtime errors during trip/fuel saves. Keep this guard passing before every deployment.

## Payment request locking and user feedback

- The current/open period is now locked for trip/fuel edits, deletes, and new trip/fuel logs when any settlement payment is `requested` or `paid`.
- To change settlement-affecting amounts after a request has been sent, reopen the active payment request first, make the correction, and request the payment again.
- The app now shows toast-style feedback for common successful changes: trip saved/updated/deleted, fuel log saved/updated/deleted, payment requested/paid/reopened, amount copied, and period closed.
- Keep the manual smoke test after every deployment: create trip -> create fuel log -> request payment -> confirm edit is blocked -> reopen payment -> edit -> refresh.


## Settlement calculations extraction

`settlement-calculations.js` now owns `calculateLedger()`, `calculateHistoricalFuelStats()`, `calculateFuelEstimate()`, `buildSettlements()`, and `getTripParticipants()`. Keep future settlement math changes there where possible, but leave UI rendering and payment-request actions in `app.js`.


## UI message helper extraction

`ui-messages.js` now owns `showAppMessage()` and `showSaveMessage()`. Keep lightweight feedback/toast helpers there; leave business rules and UI rendering in `app.js`.

`notifications.js` now owns push-support checks, PWA notification UI decisions, subscription setup, and payment-request push delivery. Keep service-worker registration and install-prompt wiring in `app.js`.

## Admin tools extraction

`admin-tools.js` now owns reusable database diagnostics and settlement-request cleanup helpers. Keep the admin button wiring and production reset confirmation flow in `app.js`, so destructive actions remain easy to audit.


## Runtime module/cache guard

`tools/check-app-references.mjs` now validates that `index.html` loads the runtime modules in the expected order and that `service-worker.js` caches the same runtime assets. This catches the common PWA mistake where a new module is added to the page but not to the home-screen cache.

## Browser smoke tests

A Playwright smoke-test setup was added to catch regressions that only appear in a real browser. The first test disables Supabase with a local test config, creates a trip, creates a fuel log, refreshes the page, and verifies both entries are still visible from local persistence.

Run once on a machine with Node.js:

```bash
npm install
npx playwright install
npm run test:e2e
```

Keep the existing validation command as the fast pre-deploy check, and use `npm run test:e2e` before larger refactors or write-path changes.


### GitHub Actions CI

CI is configured in `.github/workflows/ci.yml` to run on pushes and pull requests to `main`. It installs Node/Python, installs Chromium for Playwright, then runs:

```bash
npm run validate
npm run test:e2e
```

Keep local validation passing before pushing so GitHub and Render do not receive broken refactors.

### Payment-lock browser smoke test

The Playwright suite now includes a regression test for the settlement locking rule: create trip/fuel data, request a payment, confirm trip/fuel inputs are locked, reopen the payment request, and confirm trip/fuel inputs are editable again. This protects the rule that requested payments must not be silently recalculated by later trip/fuel edits.


### Audit/change log

Money-related actions are recorded in `state.auditLog` and rendered in the History tab. The runtime module `audit-log.js` normalizes entries and labels actions such as trip/fuel changes, payment requests, payment reopening, and settlement close events.


### Audit log persistence and edit details

Audit entries for trip/fuel/payment/settlement changes are mirrored to the ledger backup immediately when they change, so the change log survives refresh even when normalized tables are the primary data source. Edit entries include concise before/after details for important changed fields.

- Hotfix: current-period reset no longer references an undefined `period` variable. Current-period reset also clears the current audit log because those entries belonged to the deleted open period.


### Period-aware audit log

Audit history is now period-aware. Current/open-period audit entries live in `state.auditLog`. When a settlement period is closed, the current audit entries are copied into `closedPeriod.auditLog` together with the settlement-close event, then the new open period starts with an empty audit log. Resetting/deleting the current open period clears its audit entries as well. Closed period cards include a Change log subsection for the frozen period history.

### Period-aware audit browser smoke test

The Playwright suite now includes a regression test for period-aware audit behavior: create trip/fuel data, confirm current audit entries, reset the current period and confirm the current log clears, then create a new period, close it, and confirm the completed period keeps its frozen Change log.

## Version/build info panel

`build-info.js` exposes `window.FuelBuildInfo` and renders the Admin -> Version & update status panel. Update `BUILD_INFO.version`, `BUILD_INFO.buildLabel`, `BUILD_INFO.updatedAt`, and the expected service-worker cache whenever shipping a user-visible deployment. Keep `service-worker.js` `CACHE_NAME` in sync with `BUILD_INFO.expectedServiceWorkerCache`.
\n- Added a user-visible About tab with read-only app version and PWA cache status so non-admin members can report their running build.

## Completed-period archive search

The History archive now has search/filter/sort controls for `state.closedPeriods`. Filtering is client-side and uses period labels, members, trips, fuel logs, settlements, and frozen audit-log text. Keep the Playwright period-aware audit test updated when changing the closed-period card markup or archive controls.

## Completed-period CSV exports

Completed period cards now include two CSV exports: a summary CSV covering period totals, people, settlements, trips, and fuel logs, and a separate change-log CSV for the frozen audit entries saved with that period. The export buttons are intentionally attached to completed periods only so current/open settlement data is not mistaken for finalized archive data.

### Safari/PWA download stability

Completed-period CSV export uses a delayed Blob URL cleanup so Safari and installed PWA windows have time to start downloads before the temporary object URL is revoked. Filenames are normalized to ASCII-safe names to reduce platform-specific download issues.


### Safari CSV fallback

Completed-period exports now keep only CSV actions. Safari/iOS/home-screen PWAs use an in-app CSV export panel with Copy CSV and Try download instead of relying only on direct Blob downloads. The old Markdown Download report action was removed.

### Payment audit details

Payment audit entries now include clearer summaries and before/after status details, for example `Status: Not requested -> Requested` together with payer, recipient, amount, and currency metadata. The completed-period change-log CSV export includes these payment metadata columns so frozen payment history is easier to audit.

## Permission UX messages

The app now shows clearer messages when users are blocked from editing or deleting another member's trip/fuel log, or from changing a payment status they do not own. Non-editable History cards also show a small permission note so members understand why edit/delete controls are missing. The Playwright suite includes a Supabase-authenticated non-admin smoke test that verifies these notes appear and edit/delete controls are hidden for entries owned by another member.


## Repo cleanup + real server smoke tests

Codex review found that generated artifacts could be tracked and that Playwright was using a static file server. This patch adds `.gitignore` coverage for `node_modules/`, Python caches, backup files, Playwright reports, and local test data. If those files are already tracked, remove them with `git rm -r --cached ...` before committing.

Playwright now starts `server.py` with `PORT=4173` and `FUEL_LEDGER_DATA_FILE=.playwright-ledger-data.json`, which keeps local browser tests isolated while still covering app API routes.

Fuel-price warning thresholds are configurable in Group settings (`fuelPriceWarningMinDkkPerLiter` / `fuelPriceWarningMaxDkkPerLiter`) with 8–25 DKK/L defaults. The warning helper reads the saved state range, so future markets/prices do not require code changes.

## Tracked artifact guard

`npm run validate` now runs `tools/check-tracked-artifacts.mjs`. The guard fails when generated or machine-local files are tracked by Git, including `node_modules/`, `__pycache__/`, `*.bak`, Playwright reports/results, `.playwright-ledger-data.json`, and `.DS_Store`.

If it fails after a local install or test run, remove the generated files from Git tracking without deleting your working copies where appropriate:

```bash
git rm -r --cached node_modules __pycache__ playwright-report test-results .playwright-ledger-data.json 2>/dev/null || true
git rm --cached app.js.bak 2>/dev/null || true
```

Then run:

```bash
npm run validate
```


### Configurable fuel-price warning range

Admins can adjust the low/high DKK/L anomaly range in Group settings. Keep Playwright and manual checks focused on valid fuel logs saving, missing liters being blocked, and outside-range DKK/L being blocked with a clear message.

### Member and role management UX

Admin member management now shows clearer role/access descriptions for each member row. Role changes that promote a member to admin or demote an admin now require confirmation, protected admin rows explain why they are locked, and save/add/deactivate messages include the affected member and role.

Manual check: Admin -> Member management, verify Member/Admin descriptions, try promoting/demoting a test member, and confirm at least one active admin remains protected.


## Playwright state isolation

The browser smoke tests run against `server.py` with `FUEL_LEDGER_DATA_FILE=.playwright-ledger-data.json`. The test suite now resets `/api/state` before each test, so trips, fuel logs, payment statuses, audit entries, and closed periods from one smoke test cannot leak into another.

## Payment reminders

Requested payments now include a **Send reminder** action for the payment requester/admin. The reminder is always recorded in the current period audit log. When the payer has an active push subscription, the server also sends a mobile/PWA notification; otherwise the app shows a non-fatal message explaining that the reminder was recorded but no active notification subscription was reached.


### Automatic payment reminders

Build `automatic-payment-reminders` adds configurable app-open payment reminders. Admins can enable/disable reminders and set the first reminder delay, repeat interval, and maximum automatic reminder count in **Admin → Group settings**. Requested payments are checked in both the current settlement and closed settlements when the app opens. Closed settlement amounts stay frozen, but requested payments can still be marked paid from the closed-period detail view, with the payment status change recorded in that period's frozen change log.


## Backend payment action helper

Payment status changes and payment reminders now use `/api/payment-action` in server-backed/local mode. The endpoint applies the payment status update and the matching audit entry in one server-side state mutation, which keeps `/api/state`, local browser mirrors, and audit history aligned during Playwright and non-Supabase deployments. Supabase deployments continue to use the existing normalized-table/RLS path until the same action contract is moved into Supabase RPC functions.

### Backend payment action test stability

Payment status clicks are now awaited in the shared click handler, and the Playwright helper waits for server-backed payment actions to finish before closing a period. The manual payment reminder assertion is optional in the locking smoke test because automatic reminders may be the primary reminder path in this build.



- Backend payment action state sync: payment actions now flush current local state to `server.py` and cancel stale debounced saves before applying server-authoritative payment status/audit updates.

### Closed-period payment action polish
- Closed completed-period cards now show unpaid requested payments as dedicated payment cards.
- The `Mark paid` action is shown directly inside the closed-period payment row when the signed-in user is allowed to use it.
- Marking paid after close remains status-only: it does not reopen or recalculate the settlement, and it writes to the closed period change log.

### Closed-period payment persistence and layout

Closed-period final payment cards use a stacked layout with payer/receiver, amount/status, action, and explanatory text separated for readability. Marking a closed-period payment paid now forces the JSON mirror/remote state to save immediately and keeps the closed-period card expanded after the UI re-renders, so the paid status survives refresh and the user does not lose their place.

### Unpaid payments view

Added a Payments tab with an unpaid payments dashboard. It collects requested-but-unpaid payments from the current settlement and closed periods, highlights what the current user owes, and allows eligible users to mark closed-period payments paid without reopening or recalculating the settlement.

### Closed-period payment card permission/layout fix
- Closed-period payment cards now use a wider, responsive layout so labels such as “Testman 5 pays Christian” do not wrap word-by-word.
- Closed-period Mark paid permissions now allow the payer, receiver, or an admin to mark a closed settlement payment as paid.


### Closed-period payment status persistence

Build `closed-payment-history-persistence` keeps closed-period payment status updates robust in Supabase/table-primary mode. Closed settlement snapshots still come from normalized settlement-period snapshots, but post-close payment status changes and audit entries are stored in the JSON mirror. When loading from normalized tables, the app now merges closed-period payment statuses and frozen audit logs from the JSON mirror back into the table snapshots. This prevents a closed-period payment marked paid from reverting to requested after refresh.


### History archive and Payments UX

- The Payments tab is the primary place for unpaid payment follow-up. It gathers requested-but-unpaid payments from both the current settlement and closed periods.
- History -> Closed periods is an archive/reference area for completed settlement evidence, audit logs, exports, and dispute checks.
- Closed-period payment cards can still be inspected from History, but unpaid follow-up should usually start from Payments.
- Unpaid payment cards for closed periods include a “View closed period” shortcut back to the relevant archive card.


## Request-before-close check

Before closing a period, verify that all settlement payments have been requested. The close button stays disabled while any calculated settlement payment is still open, but requested payments may remain unpaid after close.

## Member-scoped history

Normal members now see only closed periods that involve them through a trip, fuel log, or final payment. Admin users continue to see the full closed-period archive.

### Scheduled backend reminders

Phase 2B adds a server-side reminder runner for server-backed deployments. The runner checks requested-but-unpaid payments in both the current period and closed periods, uses existing audit entries to calculate due dates, records scheduled reminder audit entries, and attempts push delivery when VAPID/Supabase push subscription configuration is available.

Operational notes:
- `npm run reminders:dry-run` previews due reminders.
- `npm run reminders:run` records due reminders.
- Hosted schedulers should call `POST /api/run-reminders` with `REMINDER_CRON_SECRET` configured.
- The browser app-open reminder remains as a fallback, and max-count/repeat settings prevent duplicate reminder spam.


### Reminder backend diagnostics

Build `reminder-backend-diagnostics` adds detailed `/api/run-reminders` output so cron tests can explain why `dueCount` is zero. The response now includes scanned current/closed payment counts, requested payment counts, due counts, skip reasons, and sample rows with `dueAt`, `lastReminderAt`, and `reminderCount`. This helps distinguish backend scheduled reminders from browser/app-open notifications.

## 2026-06-12 - Cache version alignment

- Updated build info to version `2026.06.12.12` with build label `cache-version-alignment`.
- Aligned the expected service worker cache with the active service worker cache: `fuel-ledger-v49`.
- This fixes the version panel showing a false cache mismatch after the reminder backend diagnostics build.


### Supabase-backed scheduled reminders

Build `supabase-reminder-rpc` changes `/api/run-reminders` from local-server-only state scanning to production Supabase state scanning when service credentials are available. The server calls Supabase RPC helpers to load and save the `car_share_ledgers.state` JSON mirror, runs the existing reminder eligibility logic, records due reminder audit entries, and still attempts push delivery through the existing server-side push subscription path.

The endpoint response now includes `backendMode` and `dataSource`, making it clear whether a cron run used Supabase production state or local `ledger-data.json`.

Required server env vars for production mode:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_REMINDER_LEDGER_ID` (defaults to `main-car`)
- `REMINDER_CRON_SECRET`

Set `REMINDER_DATA_SOURCE=local` only when intentionally testing against the local JSON file.

## 2026-06-12 — Closed-period reminder timestamps

- Legacy closed-period payments with status `requested` and no `requestedAt` are now still eligible for scheduled reminders by inferring the request time from the closed period timestamp.
- Future closed periods preserve current payment reminder metadata (`requestedAt`, `lastReminderAt`, `reminderCount`, and original `paymentKey`) when the period is archived.
- `/api/run-reminders` diagnostics include `inferredRequestedAt: true` for legacy closed payments that use the fallback timestamp.

### Reminder notification deduplication

Build `dedupe-reminder-notifications` keeps scheduled backend reminders as the single automatic notification sender for Supabase production ledgers. The app-open automatic reminder scan now remains a local JSON fallback, which prevents duplicate mobile/browser notifications when a cron run and an open app inspect the same requested unpaid payment. Backend reminder copy now matches the in-app reminder wording.



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


## Recent hardening summary

The current maintenance baseline includes these safety improvements:

- Settlement math tests cover participant filtering, malformed imported values, unknown payers, historical statistics, and balanced cent allocation so rounded member costs sum back to total fuel paid.
- Backup import validation rejects malformed core collections and dangerous trip/fuel values before state replacement, while warning on recoverable unknown-member cases.
- Permission helpers and tests lock down who can edit trips, fuel logs, bookings, payment requests, and paid status transitions.
- UI feedback is centralized through toast/message helpers and confirmation wrappers. Browser tests should assert app messages instead of native `alert()` dialogs.
- Sync feedback tracks pending local changes and makes failed/deferred cloud saves visible to users.
- Fuel-location privacy defaults to station coordinates only. Saving the user's own GPS coordinates requires explicit opt-in.
- `ledger-model.js` documents the core state shape and provides lightweight validation helpers without converting the app to TypeScript.
- Supabase settlement-request triggers enforce transition rules and party/ledger integrity on the database side.
- Period closing uses snapshot fingerprints, duplicate-close checks, and busy-state protection. Smoke tests should await the async close helper instead of assuming a synchronous button click.

## Deployment metadata rule

When any runtime/app-shell file changes, update both of these together:

- `build-info.js` — bump the version/build label/updated timestamp and expected service-worker cache.
- `service-worker.js` — bump `CACHE_NAME` and keep `CORE_ASSETS` aligned with scripts loaded by `index.html`.

This rule applies to `app.js`, helper modules, CSS, icons, `index.html`, `manifest.json`, and the service worker itself. Documentation-only or test-only changes do not require a cache/build metadata bump.


### Test Lab scenario matrix

The Test Lab now includes a scenario matrix for ledger invariants, payment lifecycle checks, permission boundaries, backup/import validation, location privacy, booking edge checks, synced report storage, and runtime/PWA metadata. Cloud-saved reports are stored in the normalized `test_lab_reports` history table as immutable rows. The legacy JSON report list is retained only as a local/fallback view.


### Sync clarity update

Supabase Realtime is off by default. Use **Sync now** to refresh shared data on demand. Critical actions such as closing periods or updating payment status warn and offer a refresh when the local copy may be stale.

### Sync recovery UX pass — 2026-06-14

- Increased the startup Supabase load timeout to 15 seconds to avoid premature local-only fallback during cold or recovering Supabase sessions.
- Startup cloud timeouts now show a recoverable `Cloud delayed` status instead of a red/sticky local-only error.
- Successful background or manual cloud sync clears the delayed warning and removes the local/degraded state automatically.
- The sync badge now shows retry timing so operators can distinguish a temporary delayed startup from true unsaved local changes.

## 2026-06-14 - Test Lab inspect edit prefill

- Test Lab inspect buttons now open the matching current-period fuel/trip/booking entry in edit mode when the user has permission.
- Fuel odometer failure links load the exact fuel log into the fuel form so date, amount, liters, odometer, station, location privacy, and full-tank fields can be corrected directly.
- Build metadata bumped to `2026.06.14.55 / testlab-inspect-edit-prefill` with cache `fuel-ledger-v154`.

## 2026-06-14 - Fuel date and odometer validation

- Fuel receipt date inputs no longer set a browser max date from the current day or booking context. This keeps later-dated receipts editable when correcting real odometer data.
- Fuel save now blocks odometer values that go backwards compared with earlier/later fuel logs by receipt date, excluding the log currently being edited.
- Build metadata bumped to `2026.06.14.57 / fuel-date-odometer-validation` with cache `fuel-ledger-v156`.


### 2026-06-14.57 — Fuel overfill guided corrections
- Added inline correction actions when a fuel log would overfill the configured tank.
- Users can keep the current odometer and set liters to the maximum allowed value, or keep liters and set a minimum plausible odometer based on configured consumption.

### 2026-06-14.58 — Fuel correction math explainer
- Expanded the fuel overfill correction panel with the underlying math: previous full-tank odometer, distance driven, expected liters from odometer, expected kilometers/odometer from entered liters, and the liter difference.
- Kept the one-click correction actions for setting safe liters or a plausible odometer.
- Added smoke coverage that the overfill panel renders the explanation text.
- Build metadata bumped to `2026.06.14.58 / fuel-correction-math-explainer` with cache `fuel-ledger-v157`.

## JSON mirror write reduction

Normal Supabase saves now synchronize normalized tables first and defer the large `car_share_ledgers.state` JSON mirror. The mirror remains available for fallback recovery, exports, reminders, and audit-history durability, but routine trip/fuel/booking edits should not cause a full-state JSON write every time. Watch the Supabase load monitor for `JSON mirror saves`; frequent mirror writes should be treated as a regression unless they come from explicit backup/audit flows.

## Admin/Test Lab protection notes

- Safe Test Lab remains local-only and visible to admins without unlocking advanced tools.
- Cloud-touching Security Health is separated from routine Test Lab and protected by typed confirmation plus a cooldown.
- Advanced stress/debug tools are hidden behind an explicit admin unlock and require typed confirmation before running.
- Generated test trip/fuel creation and generated-data removal also require the advanced admin/test unlock plus typed confirmation because they touch live ledger state.
- Generated data cleanup uses strict `auto-test-` id matching so a real row is not removed only because a note/station contains the test marker text.


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old cloud `test_lab_reports` while keeping the newest reports, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migrations `009_retention_privacy_cleanup.sql` and `021_cloud_test_lab_report_retention.sql` before using the cloud cleanup buttons.


## 2026-06-15 - Production hardening consolidation baseline

Final known-good baseline after the security/performance/reporting work:

- Runtime baseline: `2026.06.15.97` / `fuel-ledger-v196` / `immutable-test-lab-report-history`.
- Apply migrations through `019_immutable_test_lab_report_history.sql`.
- Security Health is expected to be green with all critical RPCs installed.
- Realtime publication is intentionally narrow: only `public.ledger_events` should be published. If `public.car_share_ledgers` reappears in `supabase_realtime`, run/check migration `018_realtime_publication_cleanup.sql`.
- The normalized report store is the source of cloud-saved Test Lab/Security Health history. `test_lab_reports` should append immutable rows; matching `created_at` and `synced_at` on new saves confirms this.
- If Admin cards show `Not checked yet` after running Security Health, verify the deployed app is at least build `admin-diagnostics-health-propagation` / cache `fuel-ledger-v194`; newer builds include the formatter fix and immutable report history.

Operational watch item: after normal use, inspect Supabase Query Performance. `realtime.list_changes` should be materially lower than the earlier broad-publication baseline where it dominated query time.

### Diagnostic report privacy notes

Debug and Test Lab reports are operational records. Keep redaction broad for secrets and precise personal data, but avoid over-redacting build versions and timestamps because they are needed to debug deployments.

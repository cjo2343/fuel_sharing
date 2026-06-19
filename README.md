# Fuel Sharing

A lightweight car-sharing fuel ledger for friends.

## Features

- Log trips with start and end odometer values.
- Split trip distance between only the people who joined that trip.
- Log fuel payments.
- Calculate each person's fuel share from actual fuel paid divided by shared kilometers.
- Track payment requests and close settlement periods.
- Archive closed periods.
- Supabase email-code login.
- Logged-in users are locked to their assigned member profile.
- Admins can change group settings and delete/fix entries.
- Supabase Realtime reloads the ledger when another user changes it.

## Local Development

```sh
python3 server.py
```

Open `http://localhost:4175/`.

If that port is busy:

```sh
PORT=4176 python3 server.py
```


## Deployment checklist

For production or existing Supabase projects, see [`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) before running SQL or deploying app files. It includes the required order, smoke tests, rollback notes, and the fix for the `production_activity_reset(text)` function-default error.

## Maintenance notes

For architecture notes, the current RLS/security model, known legacy compromises, and the safest refactor order, see [`MAINTENANCE-NOTES.md`](MAINTENANCE-NOTES.md).


## Hardening helpers and validation

The app now has several small helper modules that keep high-risk logic testable outside the UI:

- `settlement-calculations.js` — ledger, settlement, fuel-estimate, historical statistics, and balanced money rounding.
- `permission-helpers.js` — trip/fuel/booking/payment permission checks and last-admin protection summaries.
- `ui-messages.js` — toast-style feedback, warnings, errors, and centralized confirmation prompts.
- `sync-status-helpers.js` — user-visible save/sync status text, including unsynced local-change feedback.
- `location-privacy-helpers.js` — fuel-location privacy mode normalization and saved coordinate payloads.
- `ledger-model.js` — JSDoc ledger data shapes plus safe state-shape helpers.
- `period-closing-helpers.js` — close-period readiness checks, duplicate snapshot detection, and period fingerprints.
- `audit-log.js` — normalized current and closed-period change-log entries.

Run the fast validation suite before every deploy:

```sh
npm run validate
```

For larger changes, especially anything touching trips, fuel, payments, period closing, persistence, service workers, or permissions, also run:

```sh
npm run test:e2e
```

When runtime files change, update both `build-info.js` and `service-worker.js` in the same patch. The validation checks intentionally fail if cached runtime assets, build metadata, or app-shell script references drift out of sync.

## Supabase Setup

1. Create a Supabase project.
2. Run `supabase-schema.sql` in the Supabase SQL editor.
3. Update `supabase-config.js` with your project URL and anon key.
4. Set `enabled: true`.
5. In Authentication -> URL Configuration, add your deployed URL and localhost redirect URL.
6. In Authentication -> Email Templates -> Magic Link, use a combined link + code template. Supabase uses the same Magic Link template for new and existing passwordless users, so the practical setup is to include both `{{ .ConfirmationURL }}` and `{{ .Token }}`. Existing/returning users can click the link. New users can enter the code if needed, and the app will auto-add their email to People after login.

Recommended Magic Link email template:

```html
<h2>Your Fuel Ledger sign-in</h2>

<p>If you already use Fuel Ledger, click here:</p>
<p>
  <a href="{{ .ConfirmationURL }}">
    Sign in to Fuel Ledger
  </a>
</p>

<p>If the link does not work, open Fuel Ledger here:</p>
<p>
  <a href="https://YOUR-RENDER-URL.onrender.com?login=1">
    Open Fuel Ledger
  </a>
</p>

<p>Then enter this code in the app:</p>
<h1 style="font-size: 32px; letter-spacing: 4px;">{{ .Token }}</h1>

<p>This code expires soon and can only be used once.</p>
<p>If you did not request this, you can ignore this email.</p>
```

## Member and Admin Setup

The group settings textarea supports this format, one member per line:

```text
Christian | christian@example.com | admin
Marie | marie@example.com
Jonas | jonas@example.com
```

- The first signed-in user can bootstrap the setup if no member emails are configured yet.
- After emails are configured, each logged-in user is locked to their matching member name.
- Add `| admin` to users who should be allowed to edit settings, reset data, close periods, and delete entries.

## Deployment on Render

Use a Web Service.

```text
Build command: echo "No build needed"
Start command: python3 server.py
```

No Resend API key is needed in Render when Resend is connected through Supabase SMTP.

## Returning users

Supabase stores a login session in the browser after the first successful code login. Returning users on the same device should be taken straight into the app without entering a new code. A new code is only needed after signing out, clearing browser data, using a new device/browser, or when the Supabase session expires.

## Automatic member creation

When a logged-in email is not already assigned to a member, the app now adds it automatically:

- If no member emails are configured yet, the first logged-in user claims the first member and becomes admin.
- If the email name appears to match an existing member without an email, that member gets the email attached.
- Otherwise a new member is added using a name inferred from the email address.

Admins can later rename the member or adjust the email/role in Group settings.

## PWA and push notifications

This version can be installed on phones and can send browser push notifications when a payment request is made.

### Files added

- `manifest.json` makes the app installable.
- `settlement-calculations.js` contains settlement, fuel-estimate, and ledger-balance calculations.
- `ui-messages.js` contains toast-style app feedback helpers.
- `notifications.js` contains push-notification support, subscription, and payment-request push helpers.
- `admin-tools.js` contains admin diagnostics and database-health helper logic.
- `service-worker.js` handles offline basics and receives push notifications.
- `icon-192.png` and `icon-512.png` are app icons.
- `requirements.txt` installs `pywebpush` for server-side push delivery.

### Supabase table for push subscriptions

Run the latest `supabase-schema.sql` in the Supabase SQL editor. It adds a `push_subscriptions` table.

### Render environment variables

Add these environment variables to the Render web service:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
VAPID_PUBLIC_KEY=YOUR_PUBLIC_VAPID_KEY
VAPID_PRIVATE_KEY=YOUR_PRIVATE_VAPID_KEY
VAPID_SUBJECT=mailto:login@chrjohn.dk
FUEL_LEDGER_API_SECRET=<separate random secret for /api/state and /api/payment-action>
```

Keep `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PRIVATE_KEY`, and `FUEL_LEDGER_API_SECRET` secret. Do not put them in frontend files. The JSON state API is intended for local/server maintenance fallback only; production Render requests to `/api/state` and `/api/payment-action` fail closed unless this secret is configured and supplied as `X-Ledger-Api-Secret` or `Authorization: Bearer ...`.

You can generate VAPID keys locally with:

```sh
npx web-push generate-vapid-keys
```

or any other VAPID key generator. Copy the public key to `VAPID_PUBLIC_KEY` and the private key to `VAPID_PRIVATE_KEY`.

### Phone behavior

- Android/Chrome: users can usually enable notifications from the app after signing in.
- iPhone/Safari: users generally need to add the app to the Home Screen first, then open it from the Home Screen and enable notifications.

Push notifications are sent when someone marks a settlement as `Requested`. The notification goes to the person who owes the payment, if they have enabled notifications on at least one device.


## Fuel cost sanity check

The app still settles based on actual fuel payments entered by the group. It now also estimates whether fuel payments look incomplete using trip distance, configured fuel consumption, and Danish fuel prices.

Admins can configure fuel type, estimated consumption, fallback DKK/L price, and the warning threshold in Group settings. When possible, the backend fetches a Danish reference price from the public Circle K/INGO fuel price API and falls back to the manual price if that API is unavailable.

If logged fuel payments are below the configured threshold of expected fuel cost, the settlement panel warns users and asks for confirmation before marking a payment request as requested.

Default fuel sanity-check settings for this car:

- Fuel type: Diesel
- Official consumption: 18.9 km/L
- App consumption setting: 5.3 L/100 km (`100 / 18.9 = 5.29`)
- Fallback fuel price: 14.50 DKK/L
- Warning threshold: 70%

The fuel estimate is only a sanity check. Settlements are still based on the fuel receipts logged in the app.

## Fuel liters and consumption statistics

Fuel payments can include optional liters added. Entering liters lets the app show receipt-based statistics such as average DKK/L, logged liters, estimated L/100 km, and km/L for the current settlement period. These statistics are informational; settlements still use the actual fuel amounts paid.


## Fuel statistics / ML-ready data

Fuel payments can store optional liters, odometer, station/place, and whether the tank was filled to full. The app still settles costs from real logged payments, but these fields make future statistics possible, including receipt DKK/L, real-world L/100 km, km/L, and eventually trip-cost prediction based on historical data.

For best future estimates, enter every refuel receipt with amount, liters, and odometer. Full-tank entries are especially useful for calculating real consumption between fills.


## Step 1 reliability update

This version makes cloud saving more explicit. The top bar now shows both the sync state and a short detail such as "Saving changes...", "Saved to cloud 14:05", or "Not saved to cloud". New auto-added members are saved to Supabase immediately after login; if saving fails, the UI shows a warning instead of silently falling back to local-only data.


## Nearby fuel station picker

In **Log fuel payment -> More fuel details**, users can tap **Find nearby stations**. The app asks for the phone's location, looks up nearby `amenity=fuel` stations from OpenStreetMap via Overpass, and lets the user pick the correct station. The manual Station/place field remains available because map data can be incomplete or inaccurate.

The fuel log stores the selected station name and brand/operator when available. By default it stores selected station coordinates only; users can choose station-name-only or explicitly opt in to saving their own GPS coordinates for that receipt.

## Settlement validation

Before a payment request can be marked as requested, Fuel Ledger checks whether logged fuel receipts look unusually low for the distance in the current period. If fuel looks incomplete, the app shows a confirmation with:

- trip kilometers in the period
- fuel amount logged
- estimated expected fuel cost
- coverage percentage
- configured warning threshold

This does not block legitimate edge cases, but it makes users confirm that all fuel receipts have been added before requesting payment. Admin manual period closing uses the same validation.


## Fuel sanity validation

The app warns before settlement requests if logged fuel looks too low or too high for the trip distance, if large payments are missing liters, if DKK/L looks unrealistic, or if receipt-based consumption is outside a plausible range. These warnings do not block valid edge cases, but they require confirmation before requesting or closing settlements.

Fuel receipt dates stay editable for corrections, including later-dated receipts. When saving a fuel log with an odometer, Fuel Ledger checks nearby fuel logs by date and blocks obvious backwards odometer values so a later receipt cannot be saved below a previous receipt's odometer.


## Editing current-period entries

Admins can edit current-period trips and fuel payments from the History section.
Use **Edit** to load the entry back into the form, correct the values, and save.
Closed periods stay archived; edit the current period before closing it.


## Admin system health

Admins have a **System health** panel that checks for common data quality problems before bigger changes or settlement requests:

- users without attached emails
- missing or failed cloud saves
- missing admin users
- large fuel logs without liters
- suspicious DKK/L values
- unusual trip distances
- open-period fuel sanity warnings
- local push notification status
- whether closed periods exist

Use this panel before cleaning test data, requesting settlements, or starting larger refactors.

## Current database setup

This repo is now table-primary. A fresh Supabase project should start by running `supabase-schema.sql`, which creates the normalized tables, seeds the default ledger, and installs member-restricted RLS policies.

The older `phase2*.sql` files are kept for historical/upgrading installs. Do not rerun them on a live database unless you are intentionally repairing that specific phase.

The app now reads and writes the normalized tables first. `car_share_ledgers.state` is kept only as a backup snapshot/fallback, not as the main operational backend.

## Phase 2H: Database diagnostics

This build adds an admin-only **Database diagnostics** panel below System health. It reads the live Supabase tables and shows:

- normalized read mode status
- active/open settlement period id
- active members and admin/email readiness
- open-period trip and fuel table counts
- settlement request row matching
- JSON backup mirror counts
- latest normalized table write vs JSON mirror save time

Use this panel before reducing or removing the JSON fallback mirror.

## Phase 2I: JSON backup snapshot mode

The normalized Supabase tables are now the primary backend for trips, fuel logs, settlement periods, and payment request rows. The legacy `car_share_ledgers.state` JSON blob is kept only as a safety backup/fallback snapshot.

In this version:

- Normal app saves sync normalized tables first.
- The legacy JSON backup is no longer overwritten on every save.
- The JSON backup is refreshed periodically, at most every 30 minutes during normal use.
- Admins can force a JSON backup snapshot from **Admin → Database diagnostics → Save JSON backup**.
- Database diagnostics labels this as a backup snapshot rather than the primary mirror.

Keep the JSON table for now as a rollback/export safety net. Do not delete it until the app has run table-primary in daily use for a while.

## Phase 2K repo hardening cleanup

This repo now includes the normalized Supabase tables in `supabase-schema.sql` so a fresh project can create the same table-primary backend the app uses in production. The older phase migration SQL files remain checked in for historical/upgrading installs, but new installs should start with `supabase-schema.sql`.

Server-side push endpoints now trust only Supabase-verified JWTs. They no longer fall back to locally decoded JWT payloads. Push sending also verifies that both the sender and requested target email are active members of the same ledger before sending.

Generated backup/build artifacts such as `app.js.bak` and `__pycache__/` are intentionally not included in the ZIP. `.gitignore` also ignores them going forward.

### Phase 2M settlement visibility and save label

Non-admin users now only see final payment lines that involve their own member profile. Admins still see all final payments for the period. The “Why this payment?” explanation is collapsed by default to keep settlement cards compact. The top save badge now shows “Database” when normalized tables are the primary backend, instead of showing a legacy cloud JSON save label.

### Phase 2N: Member-facing action card

This version polishes the non-admin experience by adding a concise “What do I need to do?” card in the settlement area. Regular members see only the action relevant to their visible payments, while admins see a period-wide closing summary.


### Fuel intelligence

The app includes a lightweight fuel-intelligence dashboard. It uses normalized trip and fuel tables to show historical DKK/km, DKK/L, L/100 km, confidence, and the estimate source currently used by the trip estimator. This is intentionally statistics-first rather than a black-box ML model; it gives useful predictions and data-quality notes while the dataset is still small.

### Phase 2P — safer trip planning from fuel intelligence

The Fuel intelligence card now treats historical averages as advisory until they look realistic. If historical receipt data implies an unusual consumption value, the trip planner avoids the inflated historical DKK/km figure and instead estimates from the car setting (`L/100 km`) plus the best available fuel price.

For this diesel car, the default planning fallback remains 5.3 L/100 km. Historical DKK/km is preferred only when there is enough data and the inferred L/100 km is within a realistic range.


### Paid settlement period lock

Once any final payment in the current open period is marked `Paid`, the current period is treated as locked for new trip/fuel entries. This prevents a paid settlement from changing underneath users after someone has already paid in MobilePay. Admins should close the period to start a fresh one, or reopen the paid payment if the period needs corrections before closing.


### Production activity reset

After testing/stress testing, admins can start with clean production activity while keeping members, roles, emails, MobilePay numbers, and ledger settings.

1. Run `phase2ah-production-activity-reset.sql` once in Supabase SQL Editor.
2. Deploy the app.
3. Open **Admin → Database diagnostics**.
4. Click **Reset production activity**.
5. Type `RESET PRODUCTION` to confirm.

This deletes bookings, trips, fuel logs, settlement requests, and settlement periods, creates one fresh empty open period, and refreshes the JSON backup snapshot. Use it only after downloading/keeping a backup.


### Monthly member summaries

The Insights tab includes monthly member summaries built from normalized trip and fuel tables. Each month shows trip count, fuel logs, distance share, fuel paid, estimated fuel share, and monthly net per member. This is an explainable statistics layer, not a black-box ML model, and is most useful after production reset removes stress-test data.

## Pre-deploy validation

Before packaging or deploying changes, run these checks from the repository root:

```bash
node --check utils.js
node --check supabase-helpers.js
node --check data-store.js
node --check settlement-calculations.js
node --check ui-messages.js
node --check notifications.js
node --check admin-tools.js
node --check app.js
node --check service-worker.js
python3 -m py_compile server.py
python3 -m json.tool ledger-data.json
node tools/check-app-references.mjs
```

`tools/check-app-references.mjs` is a lightweight guard for the browser JavaScript files. It scans `app.js` and the extracted helper files (`utils.js`, `supabase-helpers.js`, `data-store.js`, `settlement-calculations.js`, `ui-messages.js`, `notifications.js`, and `admin-tools.js`) for likely calls to helper functions that are not defined. It is not a full type checker, but it should catch common patch mistakes such as calling `getActivePeriodId()` or `normalizeParticipants()` when those helpers do not exist in the current app version. It also checks that `index.html` loads the runtime modules in the expected order and that `service-worker.js` caches those same runtime files. Finally, it includes targeted regression guards for the normalized write paths so `syncNormalizedTablesFromJson()` cannot accidentally reference an undefined `context.*` variable again, and related current-member write regressions.

If the checker reports an intentional browser/CDN global, add that name to the allowlist in the script. If it reports an app helper, either define the helper or change the code to use an existing helper.



## Runtime module map

The browser runtime files are loaded in this order:

1. `supabase-config.js`
2. `utils.js`
3. `supabase-helpers.js`
4. `data-store.js`
5. `settlement-calculations.js`
6. `ui-messages.js`
7. `notifications.js`
8. `admin-tools.js`
9. `app.js`

Keep `index.html`, `service-worker.js`, and `tools/check-app-references.mjs` in sync whenever adding or renaming a runtime module.

### Phase 2AU — route-aware refuel planning helper

The trip estimator now supports optional Start / Destination fields. When both are filled, Fuel Ledger creates a driving-route link in Google Maps and combines it with the existing refuel estimate and logged-station suggestions.

This is still not full route optimization. Station suggestions are based on stations previously logged in Fuel Ledger, not every station along the route. A true along-route station finder would require a routing/maps API integration later.


`tools/check-app-references.mjs` includes targeted guards plus a narrower undeclared-identifier scan for normalized write regressions.


## Payment request locking

When a settlement payment is requested or marked paid, the current period is locked against settlement-affecting trip/fuel changes. Reopen the payment request first, correct the trip/fuel data, then request the payment again. The app also shows toast messages for common save/payment actions so users get clearer feedback after changes.

### Browser smoke tests

This repo includes a lightweight Playwright smoke test setup for regression-prone browser flows. Run it before larger refactors or persistence changes:

```bash
npm install
npx playwright install
npm run test:e2e
```

The smoke tests cover local persistence, runtime module loading, build info visibility, payment-request locking, period-aware audit history, and permission notes for non-admin members viewing entries owned by someone else.



### GitHub Actions CI

The repository includes `.github/workflows/ci.yml`, which runs the same validation and Playwright smoke tests on pushes and pull requests to `main`:

```bash
npm run validate
npm run test:e2e
```

If CI fails, open the failed GitHub Actions run and inspect the Playwright trace/report artifact details before deploying the change.

The browser smoke-test suite also covers the payment-request locking rule: once a payment is requested, settlement-affecting trip/fuel inputs lock until the payment request is reopened.


### Audit/change log

Money-related actions are recorded in `state.auditLog` and rendered in the History tab. The runtime module `audit-log.js` normalizes entries and labels actions such as trip/fuel changes, payment requests, payment reopening, and settlement close events.


### Audit log persistence and edit details

Audit entries for trip/fuel/payment/settlement changes are mirrored to the ledger backup immediately when they change, so the change log survives refresh even when normalized tables are the primary data source. Edit entries include concise before/after details for important changed fields.

- Hotfix: current-period reset no longer references an undefined `period` variable. Current-period reset also clears the current audit log because those entries belonged to the deleted open period.


### Period-aware audit log

Audit history is now period-aware. Current/open-period audit entries live in `state.auditLog`. When a settlement period is closed, the current audit entries are copied into `closedPeriod.auditLog` together with the settlement-close event, then the new open period starts with an empty audit log. Resetting/deleting the current open period clears its audit entries as well. Closed period cards include a Change log subsection for the frozen period history.

The browser smoke-test suite also covers the period-aware audit rule: resetting the current period clears current-period audit entries, and closing a period freezes that period's audit history into the completed period card.

### Version and PWA update status

Admins can open **Admin -> Version & update status** to confirm the deployed app version, build label, expected service-worker cache, and whether the current browser/PWA page is controlled by the service worker. This is useful when a home-screen install appears stale after a deployment.
\n- Added a user-visible About tab with read-only app version and PWA cache status so non-admin members can report their running build.

### Completed-period archive search

History -> Closed periods now includes search, payment-status filtering, sorting, and a live archive summary. Use it to find archived settlement periods by member, note, station, payment status, or audit-log text. Closed period cards still keep their frozen Change log, trips, fuel logs, activity-by-person, and final-payment details.

### Completed-period CSV exports

Closed period archive cards can export a period summary CSV and a frozen change-log CSV. The summary CSV includes period totals, people, final settlements, trips, and fuel logs. The change-log CSV includes the audit entries that were frozen when the period was closed.


### CSV export download behavior

Completed-period CSV downloads keep their temporary Blob URLs alive briefly and use ASCII-safe filenames so Safari and installed PWA windows can complete downloads reliably.


### Safari CSV fallback

Completed-period exports now keep only CSV actions. Safari/iOS/home-screen PWAs use an in-app CSV export panel with Copy CSV and Try download instead of relying only on direct Blob downloads. The old Markdown Download report action was removed.

### Permission UX messages

Blocked trip, fuel, and payment actions now explain who can make the change and which signed-in member is currently using the app. This mirrors the database ownership rules: admins can manage everything, trip drivers/creators can manage their trip logs, fuel payers/creators can manage their fuel logs, and payment request/paid/reopen actions are limited to the correct payer/receiver unless an admin is allowed.


### Repo hygiene and test server

The repo should not track generated dependencies or machine-local artifacts. `.gitignore` ignores `node_modules/`, `__pycache__/`, `*.bak`, Playwright reports, and local test data. If any of those files were previously committed, remove them from Git tracking with:

```bash
git rm -r --cached node_modules __pycache__ app.js.bak 2>/dev/null || true
git add .gitignore
```

Playwright smoke tests now run against `server.py` instead of a static `python3 -m http.server` process, so `/api/state` and `/api/fuel-price` are exercised during browser tests. Test data is isolated through `FUEL_LEDGER_DATA_FILE=.playwright-ledger-data.json`.

Fuel price anomaly bounds are configurable in Admin → Group settings as low/high DKK/L warning values. Defaults remain 8–25 DKK/L for Denmark, but admins can adjust them if prices or markets change.


### Configurable fuel-price warnings

Admins can tune the low/high DKK/L warning range in Group settings. Liters are now required on new/edited fuel logs. The configured low/high DKK/L range blocks obviously invalid saves and tells the user to correct amount/liters or adjust the range in Admin settings.

### Member and role management UX

Admin member management now shows clearer role/access descriptions for each member row. Role changes that promote a member to admin or demote an admin now require confirmation, protected admin rows explain why they are locked, and save/add/deactivate messages include the affected member and role.

Manual check: Admin -> Member management, verify Member/Admin descriptions, try promoting/demoting a test member, and confirm at least one active admin remains protected.


### Smoke test state isolation

Playwright runs against the local `server.py` with `FUEL_LEDGER_DATA_FILE=.playwright-ledger-data.json`. Each test resets `/api/state` before opening the app so smoke-test trips, fuel logs, payments, audit entries, and closed periods do not leak between tests.

### Payment reminders

Requested payments include a **Send reminder** action. Reminders are recorded in the period audit log and, when the payer has enabled PWA push notifications on a device, are also sent as mobile/home-screen notifications. If the payer has no active notification subscription, the reminder is still recorded and the app explains that no mobile notification was reached.


### Automatic payment reminders

Build `automatic-payment-reminders` adds configurable app-open payment reminders. Admins can enable/disable reminders and set the first reminder delay, repeat interval, and maximum automatic reminder count in **Admin → Group settings**. Requested payments are checked in both the current settlement and closed settlements when the app opens. Closed settlement amounts stay frozen, but requested payments can still be marked paid from the closed-period detail view, with the payment status change recorded in that period's frozen change log.

### Backend payment action test stability

Payment status clicks are now awaited in the shared click handler, and the Playwright helper waits for server-backed payment actions to finish before closing a period. The manual payment reminder assertion is optional in the locking smoke test because automatic reminders may be the primary reminder path in this build.



- Backend payment action state sync: payment actions now flush current local state to `server.py` and cancel stale debounced saves before applying server-authoritative payment status/audit updates.


### Closed-period payment status
Closed settlement amounts stay frozen, but requested payments can still be marked paid directly from the completed-period card. This updates only the payment status and the closed-period change log; it does not reopen or recalculate the settlement.

### Closed-period payment persistence and layout

Closed-period final payment cards use a stacked layout with payer/receiver, amount/status, action, and explanatory text separated for readability. Marking a closed-period payment paid now forces the JSON mirror/remote state to save immediately and keeps the closed-period card expanded after the UI re-renders, so the paid status survives refresh and the user does not lose their place.

### Unpaid payments dashboard

The Payments tab shows requested payments that are not marked paid yet, including payments from closed settlement periods. This gives members a single place to see what they owe and mark eligible payments as paid without opening each historical settlement.


### Closed-period payment status persistence

Closed settlement amounts stay frozen, but payment status can change after close. The app preserves those post-close status changes across refreshes, including in Supabase/table-primary mode, by merging JSON-mirror payment status/audit updates back into closed-period snapshots when the app loads.


### History archive and Payments UX

- The Payments tab is the primary place for unpaid payment follow-up. It gathers requested-but-unpaid payments from both the current settlement and closed periods.
- History -> Closed periods is an archive/reference area for completed settlement evidence, audit logs, exports, and dispute checks.
- Closed-period payment cards can still be inspected from History, but unpaid follow-up should usually start from Payments.
- Unpaid payment cards for closed periods include a “View closed period” shortcut back to the relevant archive card.


### Request-before-close settlement rule

Closing a settlement period now requires every calculated final payment to be requested first. Payments do not need to be marked paid before close; requested-but-unpaid payments remain visible in Payments and can be marked paid after the period is archived.

### Scheduled backend payment reminders

Build `scheduled-backend-reminders` adds a Phase 2B backend reminder runner. App-open reminders still run as a fallback, but the server can now scan requested-but-unpaid current and closed-period payments without a browser session and write `payment_reminder_sent` audit entries when a reminder is due.

Run once locally:

```bash
npm run reminders:run
```

Preview without writing audit entries:

```bash
npm run reminders:dry-run
```

For a hosted cron, call `POST /api/run-reminders`. Set `REMINDER_CRON_SECRET` in the server environment and send the same value as `X-Reminder-Secret` or `Authorization: Bearer ...` from the scheduler. The job respects the existing Admin reminder settings: enabled/disabled, first reminder delay, repeat interval, and maximum reminder count.


### Reminder backend diagnostics

Build `reminder-backend-diagnostics` adds detailed `/api/run-reminders` output so cron tests can explain why `dueCount` is zero. The response now includes scanned current/closed payment counts, requested payment counts, due counts, skip reasons, and sample rows with `dueAt`, `lastReminderAt`, and `reminderCount`. This helps distinguish backend scheduled reminders from browser/app-open notifications.

## 2026-06-12 - Cache version alignment

- Updated build info to version `2026.06.12.12` with build label `cache-version-alignment`.
- Aligned the expected service worker cache with the active service worker cache: `fuel-ledger-v49`.
- This fixes the version panel showing a false cache mismatch after the reminder backend diagnostics build.


### Supabase-backed scheduled reminders

Build `supabase-reminder-rpc` makes `/api/run-reminders` use Supabase production state when the server has Supabase service credentials. The endpoint now chooses its data source automatically:

- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present: scan/update the Supabase `car_share_ledgers.state` mirror through the scheduled-reminder RPC helpers.
- Service credentials missing or `REMINDER_DATA_SOURCE=local`: scan the local `ledger-data.json` file for local development and Playwright tests.

Run the latest `supabase-schema.sql` in Supabase SQL Editor before enabling this mode. It adds:

- `public.scheduled_reminder_state(p_ledger_id text)`
- `public.save_scheduled_reminder_state(p_ledger_id text, p_state jsonb)`

Render environment variables for production reminders:

```txt
SUPABASE_URL=<your Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
SUPABASE_REMINDER_LEDGER_ID=main-car
REMINDER_CRON_SECRET=<secret used by cron-job.org>
```

Never put the service-role key in frontend JavaScript or GitHub. Keep it only in Render/server environment variables.

After deploy, test the live cron endpoint:

```bash
curl -i -X POST "https://fuel-sharing.onrender.com/api/run-reminders" \
  -H "X-Reminder-Secret: YOUR_SECRET"
```

The JSON response should include:

```json
{
  "ok": true,
  "backendMode": "supabase",
  "dataSource": { "ledgerId": "main-car" }
}
```

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


### Test Lab scenario matrix

The Test Lab now includes a scenario matrix for ledger invariants, payment lifecycle checks, permission boundaries, backup/import validation, location privacy, booking edge checks, synced report storage, and runtime/PWA metadata. Cloud-saved reports are stored in the normalized `test_lab_reports` history table as immutable rows. The legacy JSON report list is retained only as a local/fallback view.


### Sync clarity update

Supabase Realtime is off by default. Use **Sync now** to refresh shared data on demand. Critical actions such as closing periods or updating payment status warn and offer a refresh when the local copy may be stale.

### Sync recovery behavior

The app uses cached local data if the initial Supabase load is slow, but this is now treated as a recoverable delayed-cloud state. The startup timeout is 15 seconds, background retry continues, and a successful background or manual sync clears the warning automatically.

### Test Lab inspect links

Test Lab failure buttons open matching current-period entries directly in edit mode when the signed-in user has permission. Fuel odometer failures now load the exact fuel log into the fuel form so the saved date, odometer, liters, station, and full-tank values can be corrected without searching manually.


#### Fuel overfill guided corrections
When a fuel receipt would overfill the configured tank, the app now offers one-click correction suggestions for liters or odometer instead of only blocking the save.

### Fuel correction math explainer
When a fuel receipt would overfill the configured tank, the app now shows the math behind the suggested correction. It compares the current odometer with the previous full-tank odometer, estimates liters used from the configured L/100 km value, and shows the odometer that would match the entered liters.

### JSON mirror write reduction

Normalized Supabase tables are now the primary persistence path for normal app edits. The legacy `car_share_ledgers.state` JSON mirror is retained as a backup/export/fallback snapshot, but it is no longer overwritten on every small save. The app refreshes normalized tables immediately, then writes the JSON mirror only on a scheduled backup interval or when audit-history durability requires a forced backup. The Supabase load monitor reports `JSON mirror saves` and the latest JSON mirror timestamp so high write volume can be diagnosed quickly.

### Admin/Test Lab protections

Routine Test Lab checks are local-only by default. Live Security Health is separated as a cloud-touching admin action with confirmation and cooldown. Stress/debug tools stay locked behind an explicit admin unlock so normal users cannot accidentally create Supabase load.


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migration `009_retention_privacy_cleanup.sql` before using the cloud cleanup buttons.


## Current production baseline - 2026-06-15

Known-good release after the hardening consolidation:

- App version `2026.06.15.97`, cache `fuel-ledger-v196`, build label `immutable-test-lab-report-history`.
- Supabase Security Health should pass with 12/12 critical RPCs available.
- Supabase Realtime publication should contain only `public.ledger_events`; `public.car_share_ledgers` must not be published.
- Normal app edits write normalized tables first. The legacy `car_share_ledgers.state` JSON mirror remains a fallback/backup snapshot, not the routine write path.
- Cloud-saved Security Health/Test Lab reports are stored as immutable rows in `public.test_lab_reports`; each save gets a unique report id and preserves `sourceReportId` for traceability.
- Admin diagnostics cards should update immediately after a live Security Health run. Historical saved reports are collapsed and marked as historical so old failures do not look current.

Quick SQL verification after deploy:

```sql
select public.fuel_ledger_healthcheck('main-car');

select schemaname || '.' || tablename as published_table
from pg_publication_tables
where pubname = 'supabase_realtime'
order by 1;

select report_id, synced_at, created_at, report_payload->>'ok' as ok, report_payload->'buildInfo'->>'buildLabel' as build_label
from public.test_lab_reports
where ledger_id = 'main-car'
order by synced_at desc
limit 5;
```

Expected highlights: `fuel_ledger_healthcheck.ok = true`, all `critical_rpcs` values are `true`, Realtime publishes only `public.ledger_events`, and new cloud report saves create fresh `test_lab_reports` rows.

### Supabase Preview status check note

GitHub may show a separate **Supabase Preview** status created by the Supabase GitHub App. That check is separate from this repo's **Validate Fuel Ledger** workflow. If Validate Fuel Ledger passes but Supabase Preview fails immediately with `Failed to create Preview Branch: unexpected status 502`, review the Supabase GitHub integration/preview-branch settings before changing app code. The expected working directory is `.` when the repo root contains the `supabase/` folder.
- Payment request/paid/reopen actions now prefer the existing Render backend API (`/api/payments/status-action`), which verifies the signed-in Supabase session and calls the backend payment action RPC before falling back to direct browser RPC during migration.
- Admin diagnostics include a Data I/O flight recorder for recent normalized reads/writes, showing whether an action used Render API, Supabase RPC, direct table fallback, or JSON fallback.
- Version checks distinguish the loaded page build, latest deployed build, and active service-worker cache so update handoffs ask users to close/reopen instead of showing random cache mismatches.
- Sync status is source-gated so background diagnostics, focus refreshes, realtime hints, and service-worker checks stay in Admin diagnostics instead of taking over the main top-bar status.


### v302 Render admin health endpoint

Admin diagnostics now includes a Render admin health check (`POST /api/admin/health`) that verifies the signed-in session, workspace admin permission, open settlement period, Supabase connectivity, and mounted backend safety routes before dangerous admin work.

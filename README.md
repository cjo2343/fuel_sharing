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
- `service-worker.js` handles offline basics and push notifications.
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
```

Keep `SUPABASE_SERVICE_ROLE_KEY` and `VAPID_PRIVATE_KEY` secret. Do not put them in frontend files.

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

The fuel log stores the selected station name, brand/operator when available, station coordinates, and the user's GPS location for that fuel log.

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

## Phase 2A: normalized table read/compare mode

This version keeps the existing JSON ledger (`car_share_ledgers.state`) as the app's source of truth, but reads the new normalized tables after cloud load/save and shows a System Health check comparing table counts against the active app state.

This is an intentional safety step before switching the app to normalized table reads/writes.

What to verify:

1. Deploy this version.
2. Log in as admin.
3. Open System health.
4. Check the “Normalized database tables” item.

If it says the normalized tables match, Phase 1 data migration is consistent.
If it reports differences, keep JSON as source of truth and rerun/sync the Phase 1 migration before moving to Phase 2B.

Next phase will be dual-write: every app save updates both JSON and normalized tables.

## Phase 2B normalized dual-write

This build keeps the JSON ledger as the source of truth, but after every successful cloud save it also syncs the current members, open trips, trip participants, and fuel payments into the normalized Supabase tables.

Before deploying this build, run `phase2b-dual-write-policies.sql` once in Supabase SQL Editor. Those policies allow the browser app to write to the normalized tables during this bridge phase. They are intentionally broad and should be tightened in the later normalized-source-of-truth phase.

After deployment, add or edit one test trip/fuel log, then open System health. The "Normalized database tables" check should mention that dual-write sync is active and that normalized counts match JSON.

### Phase 2B console cleanup

If the browser console shows normalized dual-write access errors or ON CONFLICT errors, run `phase2b-dual-write-repair.sql` in Supabase SQL Editor.

This build also makes `/api/fuel-price` return a fallback JSON response instead of a 502 when the external fuel price API is temporarily unavailable.

## Phase 2C: normalized read-first mode

This version reads the normalized Supabase tables first after login, while keeping the old `car_share_ledgers.state` JSON as a fallback and backup.

What changes:

- On load, the app tries to rebuild the active ledger from `ledgers`, `ledger_members`, `settlement_periods`, `trips`, `trip_participants`, and `fuel_payments`.
- If table reads fail, the app falls back to the existing JSON state.
- Saves still write JSON first and then dual-write to the normalized tables.
- System health reports whether the app is reading from normalized tables and whether table counts match JSON counts.

Recommended test:

1. Deploy this version.
2. Sign in as admin.
3. Check System health.
4. Add a generated test trip.
5. Add a generated test fuel log.
6. Remove generated test data.
7. Confirm System health stays green and the console has no red errors.

Do not remove `car_share_ledgers.state` yet. It is still the fallback/backup during this phase.

## Phase 2D: table-primary trip/fuel writes

This build keeps normalized tables as the primary read source and starts writing new trip and fuel changes to normalized tables first.

- Add/edit trip writes to `trips` and `trip_participants` first, then mirrors JSON as backup.
- Add/edit fuel writes to `fuel_payments` first, then mirrors JSON as backup.
- Admin delete soft-deletes the normalized row first, then mirrors JSON as backup.
- Other app settings and period actions still use the JSON mirror and dual-write bridge for now.

This is still a migration bridge: do not remove `car_share_ledgers.state` yet.

## Phase 2E — settlement request rows

Before deploying this version, run `phase2e-settlement-request-policies.sql` in Supabase SQL Editor.

This version writes settlement request status changes to the normalized `settlement_requests` table first. The JSON state is still updated afterwards as a backup mirror.

Test flow:

1. Add test trip/fuel.
2. Click `Requested` on a settlement.
3. Refresh on the same device or another device.
4. Confirm the request status survives reload.
5. Click `Reopen` and confirm it also syncs.
6. Check System health.

## Phase 2E responsiveness patch

Settlement request/reopen buttons now show an immediate busy state while the normalized `settlement_requests` row is saved. Push notifications are sent in the background after the request status is visible, so the UI should no longer feel stuck while waiting on notification delivery.

## Codex review cleanup

This build addresses the immediate low-risk findings from the Codex review:

- `supabase-schema.sql` now seeds the same default people as `ledger-data.json`: Christian, Emilie, Jonas, Marie.
- The in-app reset/default state now uses Christian, Emilie, Jonas, Marie instead of Christian, Alex, Sam.
- Settlement rendering no longer calls `saveState()` just because old payment status keys are present. Rendering is read-only.
- Date defaults now use the browser's local date instead of UTC `toISOString().slice(0, 10)`, so Denmark users do not get yesterday/tomorrow edge cases around midnight.

The SQL file `phase2e-security-hardening-template.sql` is included as a starting point for production RLS hardening. Do not run it until every real member has the correct login email in `ledger_members.email`.

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

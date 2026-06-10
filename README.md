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

This deletes trips, fuel logs, settlement requests, and settlement periods, creates one fresh empty open period, and refreshes the JSON backup snapshot. Use it only after downloading/keeping a backup.

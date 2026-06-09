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

# Fuel Sharing

A lightweight car-sharing fuel ledger for friends.

## Features

- Log trips with start and end odometer values.
- Split trip distance between only the people who joined that trip.
- Log fuel payments.
- Calculate each person's fuel share from actual fuel paid divided by shared kilometers.
- Track payment requests and close settlement periods.
- Archive closed periods.
- Run locally with a small Python backend.
- Optional Supabase configuration for cloud sync and email login.

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



## Supabase email code login

This app uses Supabase Auth email OTP codes. In Supabase, set the auth email template to include the token, for example:

```html
<h2>Your Fuel Ledger login code</h2>
<p>Enter this code in the app:</p>
<h1>{{ .Token }}</h1>
<p>This code expires soon.</p>
```

Users enter their email in the app, receive the code, then enter it in the Login code field.

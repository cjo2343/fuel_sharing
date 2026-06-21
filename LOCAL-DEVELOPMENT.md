# Local Development

This app can run locally in two modes:

1. **Local/server-backed mode** using `server.py` and `ledger-data.json`.
2. **Supabase-enabled mode** using the frontend `supabase-config.js` plus optional server-side Supabase environment variables.

For most UI work, use local/server-backed mode. It is faster, does not need Supabase secrets, and is what the Playwright smoke tests use.

## Quick start

```sh
npm install
python3 server.py
```

Open:

```text
http://localhost:4175/
```

Or use the npm start script:

```sh
npm start
```

If the port is busy:

```sh
PORT=4176 npm start
```

## Local data file

By default, `server.py` uses:

```text
ledger-data.json
```

To test without touching that file, set:

```sh
FUEL_LEDGER_DATA_FILE=ledger-data.local.json npm start
```

Playwright already uses an isolated file:

```text
.playwright-ledger-data.json
```

## Supabase disabled / local-only mode

For local-only development, edit `supabase-config.js` and set:

```js
window.CAR_SHARE_SUPABASE = {
  enabled: false,
  url: "",
  anonKey: "",
  ledgerId: "main-car"
};
```

Then run `npm start` as usual. The app will use the local `/api/state` endpoint instead of Supabase login/table sync.

Do **not** commit a production `supabase-config.js` change that disables Supabase unless that is the intended deployment behavior.

## Supabase-enabled local mode

To test real Supabase auth/sync locally:

1. Keep `enabled: true` in `supabase-config.js`.
2. Add your local URL to Supabase Auth redirect URLs:
   ```text
   http://localhost:4175/
   ```
3. Run the current schema/migrations in Supabase before testing new RPC-backed features.
4. Use `npm run test:e2e` for local server smoke tests; do not point smoke tests at production data.

The frontend Supabase URL and anon key live in `supabase-config.js` because this is a static PWA. The anon key is public by design, so RLS and RPC policies are the real security boundary.

## Environment variables

Use `.env.example` as the reference list for server/Render variables.

`server.py` reads environment variables from the shell/host. It does **not** automatically load `.env`, so either export variables in your shell, use Render environment settings, or run with inline variables:

```sh
FUEL_LEDGER_DATA_FILE=ledger-data.local.json PORT=4176 npm start
```

Important production secrets:

```text
SUPABASE_SERVICE_ROLE_KEY
VAPID_PRIVATE_KEY
FUEL_LEDGER_API_SECRET
REMINDER_CRON_SECRET
```

Never place these in frontend JavaScript files.

## Validation before push/deploy

Normal local check:

```sh
npm run release:check
```

Full smoke test:

```sh
npm run test:e2e
```

On a fresh machine or clean CI-like checkout, install the Playwright browser once before running e2e tests:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The local pre-push hook runs validation and e2e automatically once installed:

```sh
npm run hooks:install
```

## Render notes

Render should run the app as a web service.

Recommended commands:

```text
Build command: npm ci
Start command: npm start
```

or:

```text
Build command: echo "No build needed"
Start command: python3 server.py
```

`server.py` binds to Render's `$PORT` automatically and falls back to `4175` locally.

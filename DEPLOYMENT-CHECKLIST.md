# Deployment checklist

Use this checklist when applying database or app changes to an existing Fuel Sharing deployment.

## Before deploying

1. Download a Supabase database backup or create a staging project with a copy of production data.
2. Confirm you are using matching files from the same release/ZIP, especially `app.js` and `supabase-schema.sql`.
3. Confirm the frontend `supabase-config.js` contains only the public Supabase URL and anon key. Never put service-role keys in frontend files.
4. Confirm Render/server environment variables are configured only in the hosting dashboard.

## Database update

Run `supabase-schema.sql` in the Supabase SQL Editor before deploying the updated app files.

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
- `service-worker.js`
- `manifest.json`
- icons
- `requirements.txt`

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

After changing `app.js`, `utils.js`, `supabase-helpers.js`, `styles.css`, icons, or `index.html`:

1. Confirm the changed files are listed in `service-worker.js` under `CORE_ASSETS`.
2. Bump the `CACHE_NAME` value in `service-worker.js`.
3. Deploy `service-worker.js` together with the changed app files.
4. On a phone, fully close and reopen the installed home-screen app.
5. If an old version is still visible, open the site in the browser once, refresh, then reopen the home-screen app.

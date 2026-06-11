
## Continuous integration

Before pushing, run locally:

```bash
npm run validate
npm run test:e2e
```

The Playwright suite includes persistence, payment-request locking, period-aware audit, build-info, and permission UX smoke tests. Treat any failure as a blocker before deployment.

After pushing, check the GitHub Actions CI result. Deploy or trust Render auto-deploy only after the CI run is green.

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
- `utils.js`
- `supabase-helpers.js`
- `data-store.js`
- `settlement-calculations.js`
- `ui-messages.js`
- `notifications.js`
- `admin-tools.js`
- `service-worker.js`
- `manifest.json`
- icons
- `requirements.txt`

## Validation

Before deploying app files, run:

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
node --check tools/check-app-references.mjs
python3 -m py_compile server.py
python3 -m json.tool ledger-data.json
node tools/check-app-references.mjs
```


## Runtime module/cache consistency

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

After changing `app.js`, `utils.js`, `supabase-helpers.js`, `data-store.js`, `settlement-calculations.js`, `ui-messages.js`, `notifications.js`, `admin-tools.js`, `styles.css`, icons, or `index.html`:

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


- In Admin → Group settings, confirm the low/high fuel-price warning range saves and still allows valid fuel logs.

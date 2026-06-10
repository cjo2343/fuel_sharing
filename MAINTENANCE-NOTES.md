# Maintenance notes

## Current architecture

The app is mostly frontend-driven and uses Supabase for authentication, storage, realtime sync, and row-level security. `server.py` serves static files and handles push-notification endpoints that require server-side secrets.

`app.js` still contains most application behavior. Pure formatting/date/number helpers have been extracted to `utils.js`; keep that file free of DOM, Supabase, and application state dependencies.

## Security model

- Supabase Auth identifies the signed-in user.
- `ledger_members.email` maps an auth email to a ledger member.
- RLS policies use helper functions such as `is_ledger_member`, `is_ledger_admin`, `can_manage_trip`, and `can_manage_fuel_payment`.
- Admins can manage the ledger broadly.
- Normal members can read ledger data but should only write records they are allowed to manage.

## Known legacy compromise

`car_share_ledgers` remains a broad JSON backup/state table. Ledger members can update it for compatibility with the current app architecture. The normalized tables now have stricter RLS than this legacy JSON state.

Long-term goal: move fully to normalized tables and either remove `car_share_ledgers` writes from normal app flows or make that table admin-only.

## Safe refactor order

Refactor in small commits with validation after each step:

1. Extract constants/config helpers.
2. Continue extracting pure formatting/date/money helpers into `utils.js` as small, behavior-preserving moves.
3. Extract Supabase read/write helpers.
4. Extract trip form/render logic.
5. Extract fuel form/render logic.
6. Extract settlement logic.
7. Extract admin/diagnostics logic.
8. Extract notification helpers.

After each step, run:

```sh
node --check utils.js
node --check app.js
node --check service-worker.js
node --check tools/check-app-references.mjs
python3 -m py_compile server.py
python3 -m json.tool ledger-data.json
node tools/check-app-references.mjs
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


## Hotfix: table-primary member id guard

After the data-store refactor, table-primary trip/fuel writes must use `context.currentMemberId` from `getNormalizedWriteContext()`. The validation script now guards against bare `currentMemberId` references in `saveTripToNormalizedTablesFirst()` and `saveFuelToNormalizedTablesFirst()`.

# Maintenance notes

## Current architecture

The app is mostly frontend-driven and uses Supabase for authentication, storage, realtime sync, and row-level security. `server.py` serves static files and handles push-notification endpoints that require server-side secrets.

`app.js` still contains most application behavior. Pure formatting/date/number helpers have been extracted to `utils.js`, persistence helpers to `data-store.js`, settlement/balance calculations to `settlement-calculations.js`, toast-style feedback helpers to `ui-messages.js`, push helpers to `notifications.js`, and admin diagnostics helpers to `admin-tools.js`. Keep those helper files focused and avoid moving sensitive event wiring unnecessarily.

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

The first extraction pass is complete. Current extracted modules:

1. `utils.js` — pure formatting/date/escaping helpers.
2. `supabase-helpers.js` — Supabase config/client/session/open-period helpers.
3. `data-store.js` — local persistence and remote-save queue helpers.
4. `settlement-calculations.js` — settlement/fuel-estimate calculations.
5. `ui-messages.js` — toast/save-message helpers.
6. `notifications.js` — push-notification helper logic.
7. `admin-tools.js` — diagnostics and settlement-request cleanup helpers.

Next refactors should stay small and target cohesive sections such as trip rendering, fuel rendering, payment action handlers, or settings/admin event wiring. Leave destructive production-reset confirmation flow easy to audit.

After each step, run:

```sh
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
- `ui-messages.js`
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

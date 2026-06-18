# Render backend migration path

This app is moving toward a backend-owned architecture:

```text
Browser UI -> Render API -> Supabase Auth/RPC/tables
```

Supabase remains the database, auth provider, realtime source, and RLS safety layer. Render becomes the app backend that validates requests, checks workspace permissions through the signed-in Supabase JWT, calls database RPCs, records predictable diagnostics, and returns one clear success/error response to the browser.

## Current Render-owned routes

| Area | Browser endpoint | Server action | Supabase operation | Status |
| --- | --- | --- | --- | --- |
| Trips | `POST /api/trips/upsert` | `upsert_trip_backend` | `upsert_trip_with_participants` RPC as user | Primary path, browser RPC/table fallback still present |
| Fuel | `POST /api/fuel/upsert` | `upsert_fuel_backend` | `upsert_fuel_payment` RPC as user | Primary path, browser RPC/table fallback still present |
| Payments | `POST /api/payments/status-action` | `apply_payment_status_action_backend` | `apply_payment_status_action` RPC as user | Primary path, browser RPC/table fallback still present |
| Bookings | `POST /api/bookings/upsert` | `upsert_booking_backend` | `upsert_car_booking` RPC as user | Primary path, browser RPC/table fallback still present |
| Booking delete | `POST /api/bookings/delete` | `delete_booking_backend` | `soft_delete_car_booking` RPC as user | Primary path, browser RPC/table fallback still present |

Legacy/local-support routes that are not yet part of the final production API shape:

| Area | Endpoint | Notes |
| --- | --- | --- |
| JSON state | `GET/PUT /api/state` | Local/development JSON state route; keep out of the production primary write path. |
| Legacy payment JSON action | `POST /api/payment-action` | Local JSON action route; replace with normalized Render payment routes before removing browser fallbacks. |
| Notifications | `/api/push-*`, `/api/send-push` | Already backend-owned because VAPID/server credentials must not live in the browser. |
| Fuel price | `GET /api/fuel-price` | Backend proxy/timeout wrapper for public fuel-price lookups. |

## Target route map

### State and session

- `GET /api/session/me`
- `GET /api/state/load`
- `GET /api/state/health`
- `GET /api/state/sync-summary`

### User writes

- `POST /api/trips/upsert`
- `POST /api/trips/delete`
- `POST /api/fuel/upsert`
- `POST /api/fuel/delete`
- `POST /api/bookings/upsert`
- `POST /api/bookings/delete`
- `POST /api/bookings/convert-to-trip`

### Payment actions

- `POST /api/payments/request`
- `POST /api/payments/mark-paid`
- `POST /api/payments/reopen`
- `POST /api/payments/status-action`

### Members and workspace access

- `GET /api/workspaces`
- `POST /api/workspaces/create`
- `POST /api/invites/create`
- `POST /api/invites/redeem`
- `POST /api/invites/revoke`
- `POST /api/members/upsert`
- `POST /api/members/archive`
- `POST /api/members/change-role`

### Admin and safety

- `GET /api/admin/security-health`
- `GET /api/admin/load-monitor`
- `POST /api/admin/backup`
- `POST /api/admin/period-close`
- `POST /api/admin/test-data/create`
- `POST /api/admin/test-data/cleanup`

## Migration passes

1. **Route inventory and guardrails.** Keep this document current, and add validation tests whenever a browser-owned write path moves to Render.
2. **Finish user write routes.** Trips, fuel, payments, and bookings should prefer Render first, with browser Supabase fallback only while rollout is incomplete.
3. **Add delete routes for trips/fuel.** Booking delete is now Render-first; trip/fuel deletes should follow so browser table updates are no longer needed.
4. **Move booking-to-trip conversion.** Conversion should be one Render request that validates booking ownership, creates the trip, soft-deletes/links the booking, and writes audit entries together.
5. **Move state load to Render.** Replace browser fan-out reads with `GET /api/state/load`, returning one normalized state envelope plus permissions and health.
6. **Move member/workspace/admin actions.** Admin unlock, typed confirmation, rate limits, backups, and permissions belong on Render before touching Supabase.
7. **Disable browser write fallbacks.** Once load reports show Render routes are stable, browser direct Supabase writes should become development-only or removed.
8. **Retire JSON pressure.** Keep JSON only for manual/safety/audit backup cadence, not as a normal foreground save fallback.

## Per-route contract

Every production Render route should:

1. Require a Supabase bearer token from the signed-in browser session.
2. Verify the token through Supabase Auth, not by locally trusting decoded JWT claims.
3. Pass the user's token to Supabase RPCs so RLS remains active.
4. Validate required payload fields before any write.
5. Return `{ "ok": true, "backend": "render" }` on success.
6. Return clear `400`, `401`, `403`, `409`, `429`, or `5xx` errors on failure.
7. Have a browser timeout and a matched Data I/O start/finish diagnostic.
8. Have a validation test that blocks accidental reversion to browser-owned writes.

## Browser fallback removal rule

Do not remove a browser fallback until all of these are true:

- The Render route exists in `server.py`.
- The browser calls the Render route first.
- Admin/Data I/O diagnostics show start and finish rows for the route.
- The route works on mobile PWA and desktop browser.
- `npm run validate` passes.
- At least one fresh load monitor report shows no repeated timeout/fallback pattern for that route.

## Pass: Render write context route

Target build: `render-write-context-route` / `fuel-ledger-v282`.

Trip, fuel, booking, and payment write setup now tries `POST /api/context/write` before the browser falls back to direct Supabase context reads. The endpoint verifies the Supabase user token, confirms the signed-in user is an active member of the workspace, returns the open settlement period, and provides the member-name to member-id map needed by the existing save routes.

Rollout rule: keep the browser direct-table fallback until load reports show the Render context route is stable. Do not reintroduce the v280 browser-side context shortcut; move more setup work into Render instead.

## Pass: Booking Render no-RPC fanout

Target build: `booking-render-no-rpc-fanout` / `fuel-ledger-v283`.

Booking saves still prefer `POST /api/context/write` followed by `POST /api/bookings/upsert`. After a successful Render booking save, the browser no longer pre-records or reports `upsert_car_booking` browser RPC diagnostics; that RPC path is only diagnosed when the Render route fails and the fallback actually runs.

Rollout rule: keep the browser RPC fallback available until booking save/delete Render reports are consistently healthy, but do not count or display RPC fallback activity after successful Render saves.


## Pass: Admin tool Data I/O status

Build target: `admin-tool-dataio-status` / cache `fuel-ledger-v291`.

Every admin tool that starts meaningful cloud work now records a paired Data I/O operation using the `admin-tool:*` source namespace. This makes the Supabase load monitor show user-facing status rows for generated test tools, Test Lab scenarios, Security Health, cloud report saves, JSON backups, member/workspace invite tools, and admin diagnostics instead of only exposing lower-level backend routes.

Expected diagnostics:

- `admin-tool:<tool-name> -> admin-tool -> ok` for successful tools.
- `admin-tool:<tool-name> -> admin-tool -> failed` when a tool throws.
- Lower-level Render rows such as `/api/state/load` or `/api/backups/json-mirror` remain visible underneath.

## Pass: Disable browser full-state save after Render backup

Target build: `disable-browser-full-state-after-render-backup` / `fuel-ledger-v290`.

Generated-test cleanup and similar Render-backed backup flows now avoid waking the old browser `saveSupabaseState` / `saveRemoteState` full-state queue after the Render JSON mirror backup has already saved the safety snapshot. The cleaned local state is saved locally, a fresh Render JSON mirror backup is written, and the browser records `browser-full-state-save-skip` instead of leaving a foreground `saveSupabaseState` operation to be cleared by the stale-saving failsafe.

Rollout rule: this is the first fallback-removal step. It removes only the redundant generic full-state browser write after a successful Render backup; user write route fallbacks for trip, fuel, booking, payment, state-load, ledger-directory, and JSON mirror direct-table fallback remain available until their load reports are repeatedly clean.


## Pass: Normalized Test Lab cleanup

Target build: `normalized-test-data-cleanup` / `fuel-ledger-v293`.

Clean generated Test Lab data now removes the generated entries from the local/JSON state and soft-deletes matching generated rows in normalized Supabase tables (`trips`, `fuel_payments`, and `car_bookings`) before saving the Render JSON mirror backup. This closes the gap where app state was clean but normalized health still counted old generated trip/fuel rows.

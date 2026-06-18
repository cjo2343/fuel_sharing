# Backend Path Simplification Audit

This audit is the source-of-truth map for normal app data paths while Fuel Ledger is being moved from browser-owned Supabase writes to Render-owned backend routes.

## Rule

Normal user/admin actions should use exactly one primary owner:

- **Render primary**: the browser calls a Render route, and Render verifies the signed-in Supabase user plus workspace permission before touching Supabase.
- **Browser read-only**: the browser may read diagnostics or cached state, but it must not own dangerous writes.
- **Emergency fallback only**: old browser direct writes may exist only as documented fallback while a Render route is being proven; they should not be expanded.

## Current path ownership

| Area | Current owner | Primary route/RPC | Browser fallback status | Next simplification |
| --- | --- | --- | --- | --- |
| Startup normalized state load | Render primary | `POST /api/state/load` | Read fallback only | Keep Render primary; remove obsolete JSON-first startup branches after more deploy history. |
| Write context | Render primary | `POST /api/context/write` | Browser lookup fallback kept | Keep while trip/fuel/booking/payment paths finish migration. |
| Trip save | Render primary | `POST /api/trips/upsert` | Browser RPC fallback kept | Remove direct RPC fallback after transaction wrapper pass. |
| Fuel save | Render primary | `POST /api/fuel/upsert` | Browser RPC fallback kept | Remove direct RPC fallback after transaction wrapper pass. |
| Booking save/delete | Render primary | `POST /api/bookings/upsert`, `POST /api/bookings/delete` | Browser RPC fallback kept | Remove fallback after booking smoke history is stable. |
| Payment status action | Render primary | `POST /api/payments/status-action` | Browser RPC fallback kept | Remove fallback after settlement transaction wrapper pass. |
| JSON mirror backup | Render primary | `POST /api/backups/json-mirror` | Browser direct-table fallback kept | Keep only as emergency backup/export fallback. |
| Ledger directory sync | Render primary | `POST /api/ledgers/sync` | Browser direct-table fallback kept | Remove browser upsert once workspace admin tools are Render-owned. |
| Generated Test Lab create | Render primary | `POST /api/admin/test-data/create` | Legacy fallback should not be used for normal admin flow | Remove remaining direct generated-row paths after admin route coverage. |
| Generated Test Lab cleanup | Render primary | `POST /api/admin/test-data/cleanup` | Legacy fallback should not be used for normal admin flow | Keep only emergency cleanup fallback. |
| Retention preview/cleanup | Render primary | `POST /api/admin/retention/preview`, `POST /api/admin/retention/cleanup` | RPC fallback kept only if Render route is unavailable | Remove direct RPC fallback once Render deploy history is stable. |
| Admin health | Render primary | `POST /api/admin/health` | No fallback | Keep as preflight for dangerous admin work. |
| Test Lab report save | Render primary | `POST /api/admin/reports/save` | Browser report RPC removed | Render verifies workspace admin permission and calls `upsert_test_lab_report` server-side. |

## Centralized tracking rule

Admin buttons that touch cloud state should use `traceAdminToolOperation(...)`. The wrapped action should return one of:

- `{ ok: true }` for success.
- `{ ok: false, skipped: true }` for user-cancelled or intentionally skipped work.
- `{ ok: false, error }` for a real failure.

The tracker converts `{ ok: false, error }` into a matched Data I/O error row. This prevents UI code from swallowing backend failures and turning them into misleading `ok` rows.

## v307 Render admin report save route

- Test Lab/Security Health report save now uses `POST /api/admin/reports/save`.
- Browser-owned `upsert_test_lab_report` calls were removed from the normal report-save path.
- Report save is now part of the Render-owned admin route set and appears in Render admin health.

## v306 remove proven browser fallbacks pass 1

- Retention preview/cleanup, generated test-data create/cleanup, and report-save fallback now fail closed through Render instead of using browser direct writes/RPCs.

## v305 cleanup applied

- Report-save success clears stale `lastSyncError` through `markRemoteSaveSucceeded(...)`.
- Report-save timeout was lengthened to reduce false timeout/error memory at the exact 15-second boundary.
- Report-save failures now return `{ ok: false, error }` so the shared admin-tool tracker records an error instead of a misleading success.
- This audit file now blocks undocumented growth of browser direct-write fallback paths.

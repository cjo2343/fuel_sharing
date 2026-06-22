# Architecture review and stabilization notes

## Executive summary

This codebase has several good safety ideas already in place: write-scope guards, backend app-context hydration, a service-worker update toast, and many regression guardrails. The main instability comes from too many partially overlapping control paths. The app currently has multiple competing authorities for workspace, update lifecycle, admin visibility, and state freshness.

The most urgent problems found in this pass were:

1. `build-info.js` could activate a new service worker and reload the page automatically, even though `app.js` and the UI now promise a manual update toast.
2. Workspace identity resolution was too exact. Slug/case/URL-safe alias differences could make a valid non-default workspace look unlinked, causing the backend app context to fall back to `main-car`.
3. Backend app-context responses could arrive late and overwrite the currently selected workspace. That is dangerous during workspace switches and matches the "refresh works, then stops working" symptom.
4. `app.js` is over 22,000 lines. It currently mixes app state, rendering, authentication, workspace routing, admin tools, action writes, service-worker lifecycle, and diagnostics. This makes hotfixes easy to add and hard to remove.
5. Admin/owner tooling is too noisy because owner-only diagnostics, workspace-admin operations, test/cleanup tools, and ordinary member state are all presented from the same runtime surface.

## Changes made in this patch

### Manual update lifecycle

`build-info.js` now checks build/service-worker status without auto-activating updates. It no longer sends `SKIP_WAITING` from the polling lane, and it no longer reloads the app from `controllerchange`. The bottom-right update toast in `app.js` remains the owner of update activation. That means the app should only reload after the user clicks **Update now**.

Guardrails strengthened:

- `tools/test-update-prompt-workspace-visibility-lane.mjs` now asserts that build-info polling uses `activateUpdates: false`.
- It also asserts that the build-info refresh path does not auto-call service-worker activation or page reload.

### Workspace authority and non-default workspaces

Frontend workspace identity lookups now index raw, normalized, and URL-safe aliases. Backend app-context workspace lookup now does the same. This reduces accidental fallback to `main-car` when a valid workspace is referred to by slug, URL parameter, mixed case, or an encoded form.

Backend app-context application is now request-scoped. A late response for a workspace the user has already left is ignored instead of switching the active workspace back. If the backend returns a default/fallback workspace while the selected workspace is still linked, the frontend records a stale-context diagnostic instead of snapping back to `main-car`.

Guardrails strengthened:

- `tools/test-workspace-identity-hardening.mjs` now checks frontend and backend normalized alias handling.
- `tools/test-backend-app-context-pass3.mjs` now checks request-scoped app-context preferences and stale-context protection.


### Workspace session module extraction started

The first architecture-cleanup slice is now in place. `workspace-session.js` owns pure workspace-session logic for identity alias lookup, workspace row normalization/deduplication, selected-vs-loaded session snapshots, and write-scope alignment checks. `app.js` still keeps compatibility wrapper names for existing guardrails and call sites, but those wrappers now delegate to the focused module. This makes the next extraction safer because workspace authority can be tested without loading the full 22k-line app controller.

This also fixes a subtle duplicate-workspace edge case in the extracted normalizer: when two rows share the same ledger id but different slug aliases, all old and new alias keys are now remapped to the merged strongest-role row, instead of leaving one stale duplicate object in the returned workspace list.

### Render API client extraction started

The second architecture-cleanup slice is now in place. `render-api-client.js` owns the frontend/backend endpoint directory plus the shared JSON request primitives: auth-header merging, object-body serialization, timeout/abort handling, and response text/JSON parsing. `app.js` now binds those endpoints from the module and routes the main Render-owned paths through a compatibility wrapper instead of repeating fetch/AbortController/JSON parsing in each action.

The first migrated paths are the ones that most often affect workspace stability and user actions: Render state load, Render write context, trip upsert, fuel upsert, booking upsert, and booking delete. The older `callRenderJson` helper remains as the compatibility entry point for settings/admin/owner/vehicle calls, but it now delegates through the shared Render JSON wrapper.

Guardrails added:

- `tools/test-render-api-client-module-extraction.mjs` verifies the module export, endpoint ownership, script/cache loading, runtime request behavior, and app.js delegation.
- `tools/check-runtime-assets.mjs` and `tools/check-build-info.mjs` now treat `render-api-client.js` as a required runtime asset.

## Critical remaining recommendations

### 1. Create a single workspace session owner

Right now workspace state is spread across URL params, localStorage, `activeLedgerId`, `lastConfirmedWorkspaceLedgerId`, `workspaceInviteStatus`, backend app context, state-load scope, and write-scope guards. Replace this with one `WorkspaceSession` controller that owns:

- selected workspace
- loaded workspace
- confirmed workspace
- backend-context workspace
- switch transaction id
- stale response rejection
- permission/member profile for the active workspace

All action writes should ask this controller for a verified write scope. No rendering or admin code should mutate workspace directly.

### 2. Split `app.js` into modules

Recommended first extraction order:

1. `workspace-session.js` — workspace selection, URL scope, local persistence, context hydration, stale-response protection.
2. `render-api-client.js` — `fetch` wrappers, auth headers, timeouts, result-code diagnostics.
3. `action-pipeline.js` — trip/fuel/booking/payment writes, write-scope verification, retry policy.
4. `app-update-controller.js` — service-worker registration, waiting-worker tracking, update toast lifecycle.
5. `admin/workspace-admin.js` — invite/member/settings tools for the active workspace.
6. `admin/owner-tools.js` — app-owner-only global diagnostics and maintenance tools.
7. `diagnostics.js` — shared event logging, load reports, user-safe debug export.

Do not do a big-bang rewrite. Move one slice at a time with regression tests around each extracted module.

### 3. Split `server.py`

The backend should be split into route handlers and focused services:

- `auth.py` — JWT/user resolution, role checks, owner checks.
- `workspace_service.py` — workspace listing, identity normalization, context selection.
- `state_service.py` — normalized state load/write and backup/mirror policy.
- `admin_routes.py` — owner-only and workspace-admin endpoints.
- `render_routes.py` — API routing only.

This will make it much easier to see which endpoints require app-owner rights versus workspace-admin rights.

### 4. Clean the admin area by role and task

Separate admin UI into three levels:

- **Member tools:** account, sync status, current workspace, current member profile.
- **Workspace admin:** invites, members, car/settings, workspace-scoped backup/export, workspace health.
- **App owner:** global workspace directory, global diagnostics, cleanup/test lab, retention, emergency reports.

Owner diagnostics should default to collapsed summaries. Anything that is optional, noisy, slow, or global should not render as a failure in the normal member/admin flow.

### 5. Replace static grep tests with a few runtime tests

Many guardrails are string-based, which catches accidental deletion but not behavior. Add browser/integration tests for:

- switch from `main-car` to another workspace and immediately create a trip/fuel entry
- switch between two non-default workspaces without refresh
- late backend app-context response does not change the selected workspace
- deployed service worker appears as waiting, toast appears, no reload before click
- click **Update now**, then reload happens exactly once

### 6. Move owner identity out of frontend authority

The frontend currently has a hard-coded app-owner email. This is acceptable only as a UI hint. Server-side permission checks must remain authoritative, and the frontend should prefer backend-provided `permissions.isAppOwner` for owner UI visibility.

## Suggested verification after deploy

1. Open as `chrjohn94@gmail.com`.
2. Switch from `main-car` to a non-default workspace.
3. Without refreshing, add a small test action.
4. Switch away and back; confirm the action persists in the intended workspace only.
5. Deploy a new build while the app is open.
6. Confirm the bottom-right update toast appears and the page does not reload by itself.
7. Click **Update now** and confirm one controlled reload.
8. Open admin as an ordinary workspace admin and confirm owner-only global panels are hidden or collapsed.


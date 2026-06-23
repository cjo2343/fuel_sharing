# Architecture

This document captures the runtime lanes that are easy to get subtly wrong. It is a
companion to `ARCHITECTURE_REVIEW.md` (recommendations) and `MAINTENANCE-NOTES.md`
(operational detail).

## Load / sync lane

The app boots from local cache first, then reconciles with the Render-backed cloud state:

1. `initApp()` (app.js) hydrates `state` from this device's IndexedDB/local snapshot via
   `loadState()` and renders immediately, so the workspace is usable offline / before any
   network call.
2. `ensureAppStartupWakeGate()` runs the ordered startup gate: wake Render → hydrate
   backend app context → load workspace state. The gate's phase is tracked in
   `appStartupGateState` (`idle → starting → waking-backend → hydrating-context →
   loading-state → ready | failed`).
3. `loadSupabaseState()` is the shared state-load path used by the gate, background sync,
   focus sync, realtime refresh, manual "Sync now"/Retry, and admin diagnostics. On
   success it stamps `lastCloudSyncAt`/`lastCloudSaveAt`, clears `lastSyncError`, and
   confirms the active workspace.

### Sync-health banner severity (cold-start vs genuine failure)

`buildSyncHealthBannerState()` chooses the banner. Severity is deliberate:

- **Render free tier spins down after idle** (cold start, ~30–50s wake). On return the
  startup gate or state load can fail/time out *while the cached workspace is still shown*.
  This is benign, so the banner is a **calm amber "Reconnecting"** message — not a red
  error. The discriminator is `isColdStartReconnecting()`:
  - `hasUsableCachedWorkspaceState()` — cached/local state actually has content to show
    (trips/bookings/fuel/closed periods/audit log, a prior healthy sync, or a restored
    `updatedAt` snapshot), **and**
  - `isBackendWakeOrRetryInFlight()` — a wake/retry is active (startup gate promise,
    in-flight load, queued workspace-switch retry, or a retry stamped within
    `coldStartReconnectWindowMs`).
  Both the `appStartupGateState.phase === "failed"` branch and the `lastSyncError`
  branch defer to this and render the amber banner instead of the red
  "Backend startup delayed" / "Sync delayed" cards.

- **RED is reserved for genuine failure**: the backend truly never loads and there is **no
  usable cached data** to fall back on (e.g. a brand-new signed-in user). In that case
  `isColdStartReconnecting()` is false, so the red "Backend startup delayed" / "Sync
  delayed" banner still shows. We must never mask a real failure behind the calm amber.

### Clearing on successful retry (no refocus required)

A later successful load must drop the banner and the "Cloud delayed" badge immediately,
without waiting for a refocus re-render. `recoverStartupGateAfterSuccessfulLoad()` is
called from every load-success site (`loadSupabaseState` success and the admin Render
load). It transitions `appStartupGateState` out of a stale `"failed"` into `"ready"`,
calls `clearSyncDelay()`, restores the healthy sync status, and re-renders the banner. It
is a no-op when the gate is already ready (avoids flicker) and yields to the startup
gate's own in-flight run so it does not pre-empt the gate's own ready-transition.

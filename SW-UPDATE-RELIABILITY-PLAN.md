# Plan: reliable service-worker update handoff (fix Safari "stranded on old version")

## Problem
After idle + a cold Render start, the app can stay controlled by a very old
service worker (observed: `fuel-ledger-v406` active while `v429` is deployed and
waiting). The user then runs pre-fix `app.js`, so already-fixed bugs (idle
deadlock, cold-start stalls) reappear, and the app "keeps loading".

The newer worker is installed but **waiting**, and the in-app "Update now" prompt
never appears — especially on Safari/iOS.

## Root cause
`renderAppUpdateToast()` (app.js, ~line 19199) shows the prompt only when
`appUpdateReady && appUpdateWaitingWorker` are both set:

```js
const show = Boolean(appUpdateReady && appUpdateWaitingWorker);
```

`appUpdateWaitingWorker` is only set by `markAppUpdateReady(worker, …)`, which is
only called when `registration.waiting` (or `registration.installing` →
`installed`) is observed. **Safari does not reliably expose `registration.waiting`
to the page**, so the prompt is gated behind a signal that never fires there.

Meanwhile `build-info.js` already detects a newer deploy cross-browser via the
network-first `build-info.js?version-check=…` poll (this is what makes the About
panel show "Handoff — a newer cache is ready") and **already dispatches a
`window` event** `fuel-ledger-build-update-available`. app.js already listens for
it (app.js ~line 19236):

```js
window.addEventListener("fuel-ledger-build-update-available", (event) => {
  checkForReadyAppUpdate(event?.detail?.reason || "build-info-newer-deploy");
});
```

But that handler only calls `checkForReadyAppUpdate`, which dead-ends on Safari
because it needs `registration.waiting`. So the cross-browser signal arrives but
never produces a visible prompt or an activation. This event is the hook to use.

Key existing anchors in app.js:
- `renderAppUpdateToast()` (~19199): `const show = Boolean(appUpdateReady && appUpdateWaitingWorker);`
- `activateReadyAppUpdate(reason)` (~19217): early-returns when `!appUpdateWaitingWorker`; already has a correct pending-writes guard (`hasForegroundWriteInFlight() || state.pendingLocalChanges || pendingLocalChanges`).
- `markAppUpdateReady(worker, …)` (~19206): sets `appUpdateWaitingWorker`; requires a worker object.
- module flags near ~19206: `appUpdateRegistration`, `appUpdateWaitingWorker`, `appUpdateReady`, `appUpdateInstalling`.

## Goal
Drive the update prompt and activation from the **version comparison** (which works
in every browser), not from `registration.waiting` alone, and make activation
degrade gracefully when no waiting-worker object is available.

## Changes

### 1. Show the prompt from a deploy-version mismatch, not just a waiting worker
- Add a module flag `let appUpdateDeployMismatch = false;` near the other
  `appUpdate*` flags.
- In the `fuel-ledger-build-update-available` handler (~19236): set
  `appUpdateDeployMismatch = true`, then `renderAppUpdateToast("build-info-newer-deploy")`
  (still call `checkForReadyAppUpdate` too, so the normal waiting-worker path works
  where the browser supports it).
- In `renderAppUpdateToast()` change the show condition to:
  `const show = Boolean((appUpdateReady && appUpdateWaitingWorker) || appUpdateDeployMismatch);`
- On successful activation/dismiss, reset `appUpdateDeployMismatch = false`.

(If you want the mismatch to also clear when build-info later reports active===deployed,
have the build-info lane dispatch the event only while they differ; optional.)

### 2. Make "Update now" work without a waiting-worker object
Rewrite `activateReadyAppUpdate(reason)` so the early `!appUpdateWaitingWorker`
return becomes a tiered activation. Keep the existing pending-writes guard FIRST
(do not activate mid-save). Then:
1. If `appUpdateWaitingWorker` exists → `appUpdateWaitingWorker.postMessage({ type: "SKIP_WAITING" })`
   (current behaviour; reload already happens on `controllerchange` — verify a
   `controllerchange` listener triggers `location.reload()` once).
2. Else get the registration (`appUpdateRegistration || await navigator.serviceWorker.getRegistration("/")`),
   `await registration.update()`, and if `registration.waiting` now exists →
   `registration.waiting.postMessage({ type: "SKIP_WAITING" })`.
3. Else (Safari, no waiting worker exposed) → `await registration.unregister()` then
   `location.reload()`. This drops the stale controller so the reload fetches the
   freshly-deployed assets — the key Safari escape hatch.
- Guard the whole thing with a one-shot `appUpdateActivationInFlight` flag so a
  double-tap can't loop reloads.
- Confirm there is a `navigator.serviceWorker.addEventListener("controllerchange", …)`
  that reloads once; if not, add one (guarded so it fires a single reload).

### 3. One safe auto-activation when the controller is clearly stale
In the `fuel-ledger-build-update-available` handler, after setting the flag: if
there are no pending writes (`!hasForegroundWriteInFlight() && !state.pendingLocalChanges && !pendingLocalChanges`)
and a one-shot `appUpdateAutoActivatedThisLoad` flag is still false, set that flag
and call `activateReadyAppUpdate("auto-stale-controller")`. This rescues users who
never tap the prompt. Never auto-activate while a write/save is in flight (the guard
in #2 already enforces this; the extra check just avoids a pointless attempt).

### 4. Tighten the build-info version-check cadence (minor, optional)
The HAR shows ~1585 `build-info.js?version-check` polls over 23h. Confirm the poll
backs off when the tab is hidden and isn't also firing on every focus + interval. A
~5-minute cadence while visible is plenty. (Low priority; not the bug.)

## Files
- `app.js`: `renderAppUpdateToast`, `activateReadyAppUpdate`, the build-info update
  lane that sets the mismatch flag, plus the new module flags.
- `build-info.js`: ensure the version-check lane exposes the deployed-vs-active
  mismatch to app.js (event or shared status) so #1/#3 can read it.
- `styles.css`: only if the prompt needs a more prominent/persistent treatment.

## Tests / validation
- Add a guard in `tools/` (or extend an update-lifecycle test) asserting:
  - the update toast `show` condition includes the deploy-mismatch path, and
  - `activateReadyAppUpdate` has an `unregister()` + reload fallback.
- `npm run validate`, `node tools/check-release-readiness.mjs`, `npm run test:e2e`.
- Manual: on Safari, load an old SW, deploy a new build, confirm the prompt appears
  and "Update now" lands on the new version (and the unregister fallback works when
  `registration.waiting` is null).

## Version bump
Runtime files change → bump `build-info.js` + `service-worker.js` + the
`DEPLOYMENT-CHECKLIST.md` "Current release target" block (version, cache, updatedAt,
and the exact top release note — no embedded double-quotes in the note, or the
readiness regex truncates it).

## Risk
Touches the SW update path — test the activation tiers carefully so a bad state
can't cause a reload loop (the one-shot guards cover this). The `unregister()`
fallback is safe: worst case the next load re-registers the current worker.

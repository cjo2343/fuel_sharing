# Launch backlog (categorized)

Working model: a task is handed in → Opus investigates + writes a plan → tagged
**Sonnet** (well-specified/mechanical) or **Opus** (diagnosis-driven / SW / CSP /
auth / security-sensitive). Sonnet implements from the `*-PLAN.md`; Opus does the
sensitive ones directly.

**Architecture upkeep:** every task that changes wiring (a route, load/sync path,
panel, auth step, or a removed/added subsystem) must update `ARCHITECTURE.md` in the
same PR — refresh the relevant Mermaid diagram + the "where to look" table. Cheap
incremental edits are fine for Haiku/Sonnet; keep it accurate over pretty.

**Version sequencing for parallel work:** runtime changes require a version bump
(build-info + service-worker + checklist), so two PRs branched off the same base will
collide / risk the downgrade guard. Branch each worker off the latest `origin/main`
and merge PRs in order; prefer one worker per theme cluster (one PR, one bump).

## Progress (2026-06-23) — main at v433, branch at v434

**Done & merged:** #1 SW handoff (PR #19) · #3 cold-start banners (#21) · #11/#13/#14
admin observability (#22) · #7/#9/#17 settings layout + release-notes-3 + booking
card removal (#23). Plus docs/ARCHITECTURE (#18, #20).

**Done (this branch, awaiting PR):** #15 workspace health observability — `info`
severity level for neutral setup states (push/no-bookings/no-closed-periods no longer
amber warnings), summary-first layout grouping anomalies by Access/Data integrity/
Bookings/Maintenance, passing + info checks collapsed behind `<details>` (v434). · #16
Render health real probes — real timeout-bounded Supabase reachability probe (latency +
error class), cached vehicle-provider row (no live provider call), consolidated 20
always-green route rows into one dependency-gated row, runtime signals (uptime/version/
latency), client card leads with issues + collapses passing (v435).

**Done (this branch, awaiting PR):** #5 invite-only membership (v436) — removed the
direct add-member form (UI), and now `upsert_member_as_user` (Render) + the
`upsert_ledger_member_admin` SQL RPC (migration 042) reject creating brand-new
members for everyone incl. the app owner; `redeem_ledger_invite` is the single
onboarding path. Member management keeps edit/deactivate for existing members.

**Done (this branch, awaiting PR):** #4 predictions rules audit (v437) — A/B/C/F all
landed. C: `calculateHistoricalFuelStats` measures L/100km full-tank-to-full-tank
(`computeFullTankConsumption`), falling back to rough total/total with
`consumptionMethod` labelling. B: split `consumptionLooksRealistic` (planning gate)
from `consumptionConfirmedRealistic` (confidence credit + "looks plausible" copy);
no-liters now reads "not enough liters logged yet". A: `estimateSource` price label
mirrors `calculateTripCostEstimate` (receipt→live→fallback). F: trusted
full-tank-measured consumption feeds the tank-range display
(`buildRefuelPlanning`/`estimateTankStateAtOdometer({consumption})`); overfill
save-guard stays on the car setting.

**Done (this branch, awaiting PR):** #2 sign-in flow review (v438) — (1) corrected six
stale "ask an admin to add your email" messages (form guards + auth panel + trip/fuel
edit-permission text) to invite-only wording; (2) tightened login-card copy to
distinguish the workspace invite code (permission to join) from the emailed login code
(proof of address ownership), keeping the restricted-invite preflight note; (3) signed-out
URL hygiene — `isConfirmedSignedOut()` (gated on `initialSupabaseSessionResolved`) drives
`removeWorkspaceScopeFromCurrentUrl` / a guard in `writeActiveWorkspaceToCurrentUrl` so a
logged-out visitor's URL drops `?workspace=<slug>`; membership restores it after sign-in.
Decisions taken with the user: strip slug when signed out · keep the blurred shell · tighten
copy.

**Pending:** #12 flaky e2e (Sonnet, test-only — still reproduces: `server-save`
ageMs≈10 counted as foreground op in `no-refresh action chain`).

**To resume:** read this file + the relevant `*-PLAN.md`; dispatch one worker per
item/cluster off the latest `origin/main`; merge each PR before starting the next.

| # | Task | Category | Status | Plan |
|---|------|----------|--------|------|
| 1 | Reliable service-worker update handoff (Safari stranded on old version) | **Sonnet** | Plan ready, awaiting implementation | [SW-UPDATE-RELIABILITY-PLAN.md](SW-UPDATE-RELIABILITY-PLAN.md) |
| 2 | Sign-in / sign-up flow review (incl. logged-out URL already on a workspace) | **Opus** | Done (v438, awaiting PR) | inline notes below |
| 3 | Cold-Render-after-idle banners too alarming / can go stale (startup-gate **and** sync-delay "Cloud delayed" paths) | **Opus** | Plan ready + repro confirmed — see notes | inline below |
| 4 | Smart-predictions rules audit (odometer/tank/consumption/price) | **Mixed**: A,B → Sonnet · C,F → Opus | Done (v437, awaiting PR) | [PREDICTIONS-RULES-AUDIT.md](PREDICTIONS-RULES-AUDIT.md) |
| 5 | Members join via invites, not direct add-by-email | **Mixed**: UI → Sonnet · server lockdown → Opus | Done (v436, awaiting PR) | [MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md](MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md) |
| 6 | Owner-gate "Version & update status" panel; trim public About | **Sonnet** | Plan ready | [ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md](ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md) |
| 7 | Group settings horizontal layout (+ general "go wide" principle) | **Sonnet** | Plan ready | [SETTINGS-HORIZONTAL-LAYOUT-PLAN.md](SETTINGS-HORIZONTAL-LAYOUT-PLAN.md) |
| 8 | "Workspace admin" overview honest per role (hide owner zones for normal admins) | **Sonnet** | Plan ready | [ADMIN-HOME-OVERVIEW-PLAN.md](ADMIN-HOME-OVERVIEW-PLAN.md) |

| 9 | Release notes: show only the last 3 updates | **Sonnet** | Plan ready — see notes | inline below |
| 10 | Workspaces & invites overhaul (active/used split, go horizontal, trim copy) | **Sonnet** (mockup optional) | Plan ready | [WORKSPACE-INVITES-OVERHAUL-PLAN.md](WORKSPACE-INVITES-OVERHAUL-PLAN.md) |
| 11 | Owner Diagnostics Lab → observability view (group, freshness stamps, one refresh, trim) | **Sonnet** | Plan ready | [OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md](OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md) |
| 12 | Harden flaky e2e "no-refresh action chain" (idle assertion races a just-started save) | **Sonnet** (test-only) | Plan ready — see notes | inline below |
| 13 | Clean up Diagnostics Lab *tools* drawer (group by risk, trim copy, compact report tile) | **Sonnet** | Plan ready | [OWNER-DIAGNOSTICS-LAB-TOOLS-CLEANUP-PLAN.md](OWNER-DIAGNOSTICS-LAB-TOOLS-CLEANUP-PLAN.md) |
| 14 | Fix cramped "App-owner global diagnostics" (full-width span + stop mid-word wrap) | **Sonnet** | Plan ready | [OWNER-GLOBAL-DIAGNOSTICS-WIDTH-PLAN.md](OWNER-GLOBAL-DIAGNOSTICS-WIDTH-PLAN.md) |
| 15 | Workspace health → observability (fix mis-severity "cries wolf"; summary-first, collapse passing, group) | **Sonnet** | Done (v434, awaiting PR) | [WORKSPACE-HEALTH-OBSERVABILITY-PLAN.md](WORKSPACE-HEALTH-OBSERVABILITY-PLAN.md) |
| 16 | Render health report is mostly fake-green (20/28 hardcoded) — add real probes + runtime signals | **Mixed**: server probes → Opus · presentation → Sonnet | Done (v435, awaiting PR) | [RENDER-HEALTH-REPORT-PLAN.md](RENDER-HEALTH-REPORT-PLAN.md) |
| 17 | Remove "Who and shortcuts" booking card; book for the signed-in user | **Sonnet** | Plan ready (decision: book-for-self) | [BOOKING-WHO-SHORTCUTS-REMOVAL-PLAN.md](BOOKING-WHO-SHORTCUTS-REMOVAL-PLAN.md) |

> **Theme cluster — Admin role separation:** #5 + #6 + #8 are one coherent Sonnet pass ("normal workspace admins see only workspace tools; owner/diagnostics UI is app-owner-only"). Hand them together for consistent gating.

> **Theme cluster — Owner diagnostics cleanup:** #11 (health/status tiles) + #13 (Diagnostics Lab tools drawer) + #14 (cramped global-diagnostics width) are the same owner panel; do together and reuse the v427 metric-tile styling.

> **Design principle — "Admin observability" (applies to #11/#13/#14/#15 and future Admin panels):** the recurring complaint is "so much information." Apply the Supabase-observability pattern everywhere in Admin: (1) **summary first**, then **surface only anomalies** by default and **collapse the healthy/passing baseline** behind an expander; (2) **honest severity** — never badge a neutral/informational/setup state as a warning/error (no crying wolf); add an `info` level where needed; (3) **group by domain** with clear section headers; (4) **trim copy** to one line + tooltip/details; (5) **go wide, not tall/narrow** (ties to #7); (6) make the few non-OK items **actionable**. Default to calm; make problems loud.

### #9 — Release notes: last 3 only
The "Latest notes" list renders the entire `BUILD_INFO.releaseNotes` array (build-info.js
`renderBuildInfoPanel`, ~line 521) — it grows by one every release, so it's endless.
- Fix (one line): `const releaseNotes = (BUILD_INFO.releaseNotes || []).slice(0, 3).map(...)`.
  New notes are prepended (newest first), so `slice(0, 3)` = the 3 most recent.
- Optional: append a muted "+N earlier updates" line, or nothing.
- Coordinate with #6: per #6 the public About panel should not show release notes at
  all; this last-3 limit then applies only to the owner-gated panel. If #6 is done
  first, this is just the slice on the owner panel.
- Optional hygiene (separate, not required): the stored `releaseNotes` array in
  build-info.js also grows unboundedly (every bump prepends one), making the file
  larger over time. Could cap the stored array to ~10 in the version-bump step. Not
  needed for the display fix.
- Validation: `npm run validate`, `npm run test:e2e`; the "build info is visible" test
  asserts the version/label/cache, not the note count, so the slice is safe. Runtime
  file change → version bump.
- Category: **Sonnet** (trivial, well-specified).

### #12 — Harden flaky e2e "no-refresh action chain"
`tests/smoke.spec.js:1325` ("no-refresh action chain keeps buttons usable…") asserts
`debug.foregroundOperationCount === 0` (line ~1308) immediately after the vehicle-lookup
guard step. It intermittently fails in CI because a `server-save` operation that just
fired (observed ageMs ≈ 24) is still counted as a foreground op — a timing race, not a
product bug (the surrounding commits pass; it passed on re-run).
- Fix: before the idle assertions, wait for foreground ops to drain — e.g.
  `await expect.poll(() => page.evaluate(() => window.FuelLedgerApp.getNoRefreshActionDebugState().foregroundOperationCount)).toBe(0)` with a short timeout, instead of a single-shot `expect(...).toBe(0)`. Apply to the same block's
  `activeDataIoOperationCount` / `visibleSavingActive` checks.
- Test-only change; no runtime files, so no version bump.
- Category: **Sonnet**.

## Notes

### #2 — RESOLVED (v438)
Walked the flow. Shipped: (1) **stale invite-only copy** — six messages told users to
"ask an admin to add your email," which contradicts #5 (admins can no longer add members);
all now point to requesting + redeeming an invite. (2) **login-card copy tightened** —
crisper new-vs-returning framing and an explicit invite-code (permission to join) vs
emailed login-code (proof of address) distinction; restricted-invite preflight note kept.
(3) **signed-out URL hygiene** — the logged-out URL no longer carries `?workspace=<slug>`
(`isConfirmedSignedOut()` gates the strip on `initialSupabaseSessionResolved` so it never
fires before the initial `getSession()` resolves, preserving member deep-links); after
sign-in the workspace is restored from membership. **Decisions (with user):** strip slug
when signed out (accepted tradeoff: a member following a workspace deep-link lands on their
default/remembered workspace, not the deep-linked one) · keep the blurred app-shell gate ·
tighten copy. The data-exposure characterization below was re-confirmed: still not a data
leak; this was UX/clarity + low-severity slug hygiene.

### #2 — Sign-in / sign-up flow (deferred, broader review)
Observed: when logged out, the URL can already be on a workspace
(`/?workspace=test1`) with the app shell blurred behind the login card.

Characterization (verified): **not a data exposure.** All 53 workspace-data load
paths gate on `currentSession`, so a logged-out visitor loads no workspace data;
the URL param only sets the *intended* active workspace, and signed-out handling
repairs an unlinked workspace back to the configured default (app.js:800). Post-
login, RLS still blocks non-members. Only minor issue: the workspace slug is visible
in the URL (reveals that a workspace by that name exists) — low severity.

To consider in the broader sign-in review:
- Whether a logged-out visitor on `?workspace=<slug>` should be told *which* workspace
  they're being invited to, or whether the slug should be hidden until authenticated.
- The invite-code vs email-login-code distinction in the login card copy.
- Whether the blurred app shell behind the login gate should be shown at all when
  logged out.
- Tagged **Opus** because it's auth/flow-sensitive and the fix will emerge from
  walking the flow, not from a fully-known spec.

### #3 — Stale "Backend startup delayed" banner after cold-Render recovery
Observed (test user, after the tab sat idle): red banner "Backend startup delayed —
Workspace state did not load during startup gate" with a Retry button, while the
sync details right beside it show `load-success — Loaded from normalized tables`.
On refocus the app "refreshes" (re-renders) and the banner goes away.

Root cause: `ensureAppStartupWakeGate()` (app.js ~1536) runs wake → hydrate → load
state with a 15s timeout. On a cold Render (free-tier spin-down, 30–50s wake) the
load times out and it throws, so the catch (app.js ~1604) sets
`setAppStartupGatePhase("failed")` and shows the banner (rendered while
`appStartupGateState.phase === "failed"`, app.js ~10815). A subsequent successful
load — the background retry / focus sync / manual Retry — loads the data but **never
transitions the gate out of "failed"**, so the banner is stale. The "refresh on
focus" is just the focus-triggered re-render/sync finally surfacing the recovery.

Fix:
1. In `loadSupabaseState`'s success path (the `recordSyncDiagnostic("load-success", …)`
   site, ~app.js 21953, near `markActiveWorkspaceConfirmed`): if
   `appStartupGateState.phase !== "ready"`, call
   `setAppStartupGatePhase("ready", "Workspace state loaded after a delayed startup; banner cleared.")`,
   then `clearSyncDelay(...)`, `setSyncStatus(getHealthySyncStatusLabel())`, reset
   `lastSyncError = ""`, and `renderSyncHealthBanner()`. This makes ANY successful
   load (background, focus, manual Retry) clear the banner immediately — without
   waiting for the user to refocus.
2. Soften the cold-start state (optional but recommended, ties to the free-tier
   cold-start UX): while a wake/retry is in flight, show an amber "Waking the backend,
   retrying…" state rather than a hard red error. Only show the red "delayed" banner
   if retries are exhausted AND there's no recent healthy sync.
3. Verify the fix does NOT mask a genuine failure: if the backend truly never loads,
   the banner must still appear. The guard in #1 is "clear only on actual load-success,"
   so a real failure leaves it shown — good.

Validation: `npm run validate`, release-readiness, `npm run test:e2e`; manual: sign
in, let the tab idle until Render spins down, return, confirm the banner clears on
its own once the retry loads (no manual refresh) and never contradicts a
`load-success`.

Category: **Opus** because it edits the startup-gate state machine and sync lane
(subtle; must not mask real failures or cause banner flicker). Borderline — the fix
above is specific enough that Sonnet could do it with the manual cold-start
verification; promote to a standalone `*-PLAN.md` if you want to hand it over.

#### Repro confirmed (2026-06-23) — the *sync-delay* banner, a second path in the same family
Screenshot after a long idle: a red **"Sync delayed — Render state load is required
before loading workspace data. Changes are kept on this device and will be retried."**
banner + a **"Cloud delayed"** badge, while the workspace is fully visible (settings,
odometer 1.679 km, vehicle info all rendered from local cache). Repeated
`interactive-action-controls-recovered` diagnostics show the watchdog recovering the UI.

Mechanism (distinct from the startup-gate banner above, same UX problem): on a cold
Render after idle, `loadSupabaseState` → `getRenderNormalizedStateRows()` returns null
(Render still spinning up), so the code records `RENDER_STATE_LOAD_REQUIRED` and
**throws** "Render state load is required before loading workspace data." (app.js
~22102). That becomes `lastSyncError`, which `renderSyncHealthBanner` (app.js ~10871)
renders as the red "Sync delayed" card (message built ~10843) plus the "Cloud delayed"
badge. The visible data is the local cached state, so the app is usable — the red
banner overstates severity.

Add to the #3 fix (treat both banners together):
1. **Calm the cold-start case.** When the Render state load fails BUT cached/local
   state is present and shown AND a retry is in flight, render a calm amber
   "Reconnecting — the backend is waking (free tier, ~30–50s). Your data is shown from
   this device and will sync." instead of the red "Render state load is required"
   engineering message. Reserve red for retries exhausted over a longer window with no
   usable cached data.
2. **Confirm the successful retry clears it.** `clearSyncDelay` is called on
   load-success (app.js ~22167) and admin-render-load-success (~22023); verify the
   cold-Render retry/focus path actually reaches one of those once Render wakes, and
   that `renderSyncHealthBanner` re-runs — the "Cloud delayed" badge + banner must drop
   the moment a retry loads, without a manual "Sync now".
3. Keep "Changes are kept on this device and will be retried" as the reassurance, but
   lead with the calm wording, not the throw text.
Verification: idle until Render spins down, return, confirm an amber waking state (not
red) while cached data stays usable, and that it clears on its own when Render wakes.

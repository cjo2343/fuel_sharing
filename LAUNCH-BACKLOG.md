# Launch backlog (categorized)

Working model: a task is handed in → Opus investigates + writes a plan → tagged
**Sonnet** (well-specified/mechanical) or **Opus** (diagnosis-driven / SW / CSP /
auth / security-sensitive). Sonnet implements from the `*-PLAN.md`; Opus does the
sensitive ones directly.

| # | Task | Category | Status | Plan |
|---|------|----------|--------|------|
| 1 | Reliable service-worker update handoff (Safari stranded on old version) | **Sonnet** | Plan ready, awaiting implementation | [SW-UPDATE-RELIABILITY-PLAN.md](SW-UPDATE-RELIABILITY-PLAN.md) |
| 2 | Sign-in / sign-up flow review (incl. logged-out URL already on a workspace) | **Opus** | Deferred — see notes | (to be written when we tackle it) |
| 3 | Stale "Backend startup delayed" banner after a cold-Render recovery | **Opus** (borderline Sonnet) | Plan ready — see notes | inline below |
| 4 | Smart-predictions rules audit (odometer/tank/consumption/price) | **Mixed**: A,B → Sonnet · C → Opus | Audited; fixes planned | [PREDICTIONS-RULES-AUDIT.md](PREDICTIONS-RULES-AUDIT.md) |
| 5 | Members join via invites, not direct add-by-email | **Mixed**: UI → Sonnet · server lockdown → Opus | Plan ready | [MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md](MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md) |
| 6 | Owner-gate "Version & update status" panel; trim public About | **Sonnet** | Plan ready | [ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md](ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md) |
| 7 | Group settings horizontal layout (+ general "go wide" principle) | **Sonnet** | Plan ready | [SETTINGS-HORIZONTAL-LAYOUT-PLAN.md](SETTINGS-HORIZONTAL-LAYOUT-PLAN.md) |
| 8 | "Workspace admin" overview honest per role (hide owner zones for normal admins) | **Sonnet** | Plan ready | [ADMIN-HOME-OVERVIEW-PLAN.md](ADMIN-HOME-OVERVIEW-PLAN.md) |

| 9 | Release notes: show only the last 3 updates | **Sonnet** | Plan ready — see notes | inline below |
| 10 | Workspaces & invites overhaul (active/used split, go horizontal, trim copy) | **Sonnet** (mockup optional) | Plan ready | [WORKSPACE-INVITES-OVERHAUL-PLAN.md](WORKSPACE-INVITES-OVERHAUL-PLAN.md) |
| 11 | Owner Diagnostics Lab → observability view (group, freshness stamps, one refresh, trim) | **Sonnet** | Plan ready | [OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md](OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md) |

> **Theme cluster — Admin role separation:** #5 + #6 + #8 are one coherent Sonnet pass ("normal workspace admins see only workspace tools; owner/diagnostics UI is app-owner-only"). Hand them together for consistent gating.

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

## Notes

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

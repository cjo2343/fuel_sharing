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

## Progress (2026-06-24) — main at v438

**Done & merged:** #1 SW handoff (PR #19) · #3 cold-start banners (#21) · #11/#13/#14
admin observability (#22) · #7/#9/#17 settings layout + release-notes-3 + booking
card removal (#23). Plus docs/ARCHITECTURE (#18, #20). **Now also merged (PRs #24–#28):**
#15 workspace health (v434) · #16 Render health probes (v435) · #5 invite-only membership
(v436) · #4 predictions audit (v437) · #2 sign-in flow review (v438) · #12 flaky-e2e harden.
Detail records for those six are kept below.

**New feedback batch (2026-06-24) triaged into items #18–#30** — Members/roles, onboarding,
trip logging, plan-trip, booking calendar, settlement. See the second table + notes.

**Done & merged (PR #25):** #15 workspace health observability — `info`
severity level for neutral setup states (push/no-bookings/no-closed-periods no longer
amber warnings), summary-first layout grouping anomalies by Access/Data integrity/
Bookings/Maintenance, passing + info checks collapsed behind `<details>` (v434). · #16
Render health real probes — real timeout-bounded Supabase reachability probe (latency +
error class), cached vehicle-provider row (no live provider call), consolidated 20
always-green route rows into one dependency-gated row, runtime signals (uptime/version/
latency), client card leads with issues + collapses passing (v435).

**Done & merged (PR #25):** #5 invite-only membership (v436) — removed the
direct add-member form (UI), and now `upsert_member_as_user` (Render) + the
`upsert_ledger_member_admin` SQL RPC (migration 042) reject creating brand-new
members for everyone incl. the app owner; `redeem_ledger_invite` is the single
onboarding path. Member management keeps edit/deactivate for existing members.

**Done & merged (PR #26):** #4 predictions rules audit (v437) — A/B/C/F all
landed. C: `calculateHistoricalFuelStats` measures L/100km full-tank-to-full-tank
(`computeFullTankConsumption`), falling back to rough total/total with
`consumptionMethod` labelling. B: split `consumptionLooksRealistic` (planning gate)
from `consumptionConfirmedRealistic` (confidence credit + "looks plausible" copy);
no-liters now reads "not enough liters logged yet". A: `estimateSource` price label
mirrors `calculateTripCostEstimate` (receipt→live→fallback). F: trusted
full-tank-measured consumption feeds the tank-range display
(`buildRefuelPlanning`/`estimateTankStateAtOdometer({consumption})`); overfill
save-guard stays on the car setting.

**Done & merged (PR #27):** #2 sign-in flow review (v438) — (1) corrected six
stale "ask an admin to add your email" messages (form guards + auth panel + trip/fuel
edit-permission text) to invite-only wording; (2) tightened login-card copy to
distinguish the workspace invite code (permission to join) from the emailed login code
(proof of address ownership), keeping the restricted-invite preflight note; (3) signed-out
URL hygiene — `isConfirmedSignedOut()` (gated on `initialSupabaseSessionResolved`) drives
`removeWorkspaceScopeFromCurrentUrl` / a guard in `writeActiveWorkspaceToCurrentUrl` so a
logged-out visitor's URL drops `?workspace=<slug>`; membership restores it after sign-in.
Decisions taken with the user: strip slug when signed out · keep the blurred shell · tighten
copy.

**Done & merged (PR #28):** #12 flaky e2e (Sonnet, test-only) — `expectNoStaleActionLatch`
now uses `expect.poll()` for `foregroundOperationCount`, `activeDataIoOperationCount`, and
`visibleSavingActive` so a just-fired `server-save` can drain before the assertion fires;
`supabaseLoadInFlight` and `workspaceMismatch` remain single-shot (they don't race).

**To resume:** read this file + the relevant `*-PLAN.md`; dispatch one worker per
item/cluster off the latest `origin/main`; merge each PR before starting the next.

| # | Task | Category | Status | Plan |
|---|------|----------|--------|------|
| 1 | Reliable service-worker update handoff (Safari stranded on old version) | **Sonnet** | Done & merged (PR #19) | [SW-UPDATE-RELIABILITY-PLAN.md](SW-UPDATE-RELIABILITY-PLAN.md) |
| 2 | Sign-in / sign-up flow review (incl. logged-out URL already on a workspace) | **Opus** | Done & merged (v438, PR #27) | inline notes below |
| 3 | Cold-Render-after-idle banners too alarming / can go stale (startup-gate **and** sync-delay "Cloud delayed" paths) | **Opus** | Plan ready + repro confirmed — see notes | inline below |
| 4 | Smart-predictions rules audit (odometer/tank/consumption/price) | **Mixed**: A,B → Sonnet · C,F → Opus | Done & merged (v437, PR #26) | [PREDICTIONS-RULES-AUDIT.md](PREDICTIONS-RULES-AUDIT.md) |
| 5 | Members join via invites, not direct add-by-email | **Mixed**: UI → Sonnet · server lockdown → Opus | Done & merged (v436, PR #25) | [MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md](MEMBER-MANAGEMENT-INVITE-ONLY-PLAN.md) |
| 6 | Owner-gate "Version & update status" panel; trim public About | **Sonnet** | Plan ready | [ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md](ADMIN-VERSION-PANEL-OWNER-ONLY-PLAN.md) |
| 7 | Group settings horizontal layout (+ general "go wide" principle) | **Sonnet** | Plan ready | [SETTINGS-HORIZONTAL-LAYOUT-PLAN.md](SETTINGS-HORIZONTAL-LAYOUT-PLAN.md) |
| 8 | "Workspace admin" overview honest per role (hide owner zones for normal admins) | **Sonnet** | Plan ready | [ADMIN-HOME-OVERVIEW-PLAN.md](ADMIN-HOME-OVERVIEW-PLAN.md) |

| 9 | Release notes: show only the last 3 updates | **Sonnet** | Plan ready — see notes | inline below |
| 10 | Workspaces & invites overhaul (active/used split, go horizontal, trim copy) | **Sonnet** (mockup optional) | Plan ready | [WORKSPACE-INVITES-OVERHAUL-PLAN.md](WORKSPACE-INVITES-OVERHAUL-PLAN.md) |
| 11 | Owner Diagnostics Lab → observability view (group, freshness stamps, one refresh, trim) | **Sonnet** | Plan ready | [OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md](OWNER-DIAGNOSTICS-OBSERVABILITY-PLAN.md) |
| 12 | Harden flaky e2e "no-refresh action chain" (idle assertion races a just-started save) | **Sonnet** (test-only) | Done & merged (PR #28) | inline below |
| 13 | Clean up Diagnostics Lab *tools* drawer (group by risk, trim copy, compact report tile) | **Sonnet** | Plan ready | [OWNER-DIAGNOSTICS-LAB-TOOLS-CLEANUP-PLAN.md](OWNER-DIAGNOSTICS-LAB-TOOLS-CLEANUP-PLAN.md) |
| 14 | Fix cramped "App-owner global diagnostics" (full-width span + stop mid-word wrap) | **Sonnet** | Plan ready | [OWNER-GLOBAL-DIAGNOSTICS-WIDTH-PLAN.md](OWNER-GLOBAL-DIAGNOSTICS-WIDTH-PLAN.md) |
| 15 | Workspace health → observability (fix mis-severity "cries wolf"; summary-first, collapse passing, group) | **Sonnet** | Done & merged (v434, PR #25) | [WORKSPACE-HEALTH-OBSERVABILITY-PLAN.md](WORKSPACE-HEALTH-OBSERVABILITY-PLAN.md) |
| 16 | Render health report is mostly fake-green (20/28 hardcoded) — add real probes + runtime signals | **Mixed**: server probes → Opus · presentation → Sonnet | Done & merged (v435, PR #25) | [RENDER-HEALTH-REPORT-PLAN.md](RENDER-HEALTH-REPORT-PLAN.md) |
| 17 | Remove "Who and shortcuts" booking card; book for the signed-in user | **Sonnet** | Plan ready (decision: book-for-self) | [BOOKING-WHO-SHORTCUTS-REMOVAL-PLAN.md](BOOKING-WHO-SHORTCUTS-REMOVAL-PLAN.md) |

> **Theme cluster — Admin role separation:** #5 + #6 + #8 are one coherent Sonnet pass ("normal workspace admins see only workspace tools; owner/diagnostics UI is app-owner-only"). Hand them together for consistent gating.

> **Theme cluster — Owner diagnostics cleanup:** #11 (health/status tiles) + #13 (Diagnostics Lab tools drawer) + #14 (cramped global-diagnostics width) are the same owner panel; do together and reuse the v427 metric-tile styling.

> **Design principle — "Admin observability" (applies to #11/#13/#14/#15 and future Admin panels):** the recurring complaint is "so much information." Apply the Supabase-observability pattern everywhere in Admin: (1) **summary first**, then **surface only anomalies** by default and **collapse the healthy/passing baseline** behind an expander; (2) **honest severity** — never badge a neutral/informational/setup state as a warning/error (no crying wolf); add an `info` level where needed; (3) **group by domain** with clear section headers; (4) **trim copy** to one line + tooltip/details; (5) **go wide, not tall/narrow** (ties to #7); (6) make the few non-OK items **actionable**. Default to calm; make problems loud.

## Round 2 (2026-06-24) — feedback batch (Members, onboarding, trips, plan-trip, calendar, settlement)

Handed in as `tasks.md` + 3 screenshots. Triaged below. Several are **smaller than they look**
(already partly built); two need an external routing API and are **deferred** pending a cost
decision. "Send trip to Google Maps" was already implemented (`TripActions.buildRouteMapUrl`,
trip-actions.js:37, surfaced as "Open driving route in maps" app.js ~10946) — folded into #26.

| # | Task | Category | Status | Plan |
|---|------|----------|--------|------|
| 18 | Gate "Automatic payment reminders" panel to **app-owner only** | **Sonnet** | Plan ready — see notes | inline below |
| 19 | Member-management card shows users beyond this workspace — **diagnose & scope** | **Opus** | Needs repro/diagnosis first — see notes | [MEMBER-CARD-SCOPE-PLAN.md](MEMBER-CARD-SCOPE-PLAN.md) |
| 20 | Remove legacy **"People" textarea** (redundant with Member management) | **Sonnet** | Plan ready — see notes | inline below |
| 21 | First-run onboarding: **require display name**, then lock name (admin-only edits) | **Sonnet** | Plan ready (decision: name only) — see notes | inline below |
| 22 | Trip logging: **lock driver to signed-in user** (no switching to others) | **Sonnet** | Plan ready — see notes | inline below |
| 23 | Odometer **shared workspace baseline** for new members — verify + tighten | **Sonnet** (verify-first) | Plan ready — see notes | inline below |
| 24 | **Smart odometer-at-refuel prefill** (extend existing partial prefill) | **Sonnet** | Plan ready — see notes | inline below |
| 25 | Hide **open bookings with a pending trip log** from other members | **Opus** | Plan ready — see notes | [BOOKING-PENDING-LOG-VISIBILITY-PLAN.md](BOOKING-PENDING-LOG-VISIBILITY-PLAN.md) |
| 26 | Plan-trip clarity: explain **Full-tank range**; keep/relabel **Tank capacity** | **Sonnet** | Plan ready — see notes | inline below |
| 27 | **Booking calendar UI** — decramp the month view | **Sonnet** | Plan ready — see notes | inline below |
| 28 | **Settlement audit** — field relevance, calc correctness, UX sharpening | **Mixed**: calc → Opus · UX → Sonnet | Needs audit — see notes | [SETTLEMENT-AUDIT-PLAN.md](SETTLEMENT-AUDIT-PLAN.md) |
| 29 | **Distance from start/end** via routing API | **Opus** | **Deferred** — routing-API decision pending | inline below |
| 30 | **Route-aware station** "where to fill up" | **Opus** | **Deferred** — depends on #29 | inline below |
| 31 | **Begin refactoring the monolith** (`app.js` is 23k lines) — carve into modules | **Opus** (incremental) | Ongoing — see notes | [REFACTOR-APPJS-PLAN.md](REFACTOR-APPJS-PLAN.md) |

> **Theme cluster — Members/roles cutover:** #18 (owner-only reminders) + #19 (member-card scope)
> + #20 (kill legacy People textarea) + #21 (onboarding/lock name) are one membership pass and
> overlap the existing #5/#6/#8 admin-role-separation cluster. #19 and #20 especially: the legacy
> textarea is a likely cause of #19, so diagnose them together.

> **Theme cluster — Trip/booking flow:** #22 (lock driver) + #23 (odometer baseline) + #24 (refuel
> prefill) + #25 (hide pending bookings) are the trip-logging surface; #22/#24 reuse existing flags
> (`lockToLoggedInUser`) and estimators, do as one Sonnet pass with #25 (Opus) layered on for visibility.

### #18 — Payment-reminders panel → app-owner only
Panel `#paymentRemindersEnabled` + after-days/repeat/max ([index.html:415](index.html)), gated
today only by `canManageSettings()` in `renderSettings()` (app.js ~10845). Reuse the existing
owner helper **`canUseGlobalAdminTools()`** (app.js ~18966) — same pattern as the owner-diagnostics
cards (app.js ~6822) — to hide the whole block for non-owner admins. Runtime change → version bump.
Hand together with the #5/#6/#8 admin-role-separation cluster for consistent gating. **Sonnet.**

### #19 — Member-management card shows users beyond this workspace (DIAGNOSE FIRST)
Screenshot shows every app user (Christian/Emilie/Jonas/Marie/Per/Testman2) in one workspace.
But the backend query `list_members_as_user(ledgerId)` already filters `ledger_id=eq.{ledgerId}`
(server.py ~2774), gated by `assert_user_can_admin_ledger` — so on paper it's scoped. **Resolve
the contradiction before changing anything:** either those rows are genuinely all members of this
test workspace, or `renderMemberManagementPanel()` (app.js ~16268) / `refreshMemberManagement()`
(~16385) falls back to legacy `state.members` (populated by the #20 textarea) when the Render list
is empty/slow. Confirm which, then scope. Likely intertwined with #20. **Opus** (data-scoping/auth
with a "maybe already correct" branch). → `MEMBER-CARD-SCOPE-PLAN.md`.

### #20 — Remove legacy "People" textarea
Element `#members` ([index.html:434](index.html)), parsed by `parseMemberSettings()` (app.js
~19079), writes `state.members` + `state.memberProfiles` in the `settingsForm` submit (app.js
~4039), reloaded in `renderSettings()` (~10885). It's a **dual source of truth** beside the
invite/Member-management system. Removal must drop the field + parse/save/load wiring AND confirm
member dropdowns (`renderPeopleSelectors`) and trip/fuel filtering now source names from the Render
members list, not the textarea. Coordinate with #19 (probable shared root cause). Runtime → version
bump. **Sonnet.**

### #21 — First-run onboarding (name only) + lock name after save
Profile panel already exists (`#memberProfileSetupPanel`, [index.html:115](index.html)) with email
**already `readonly`**; `update_own_ledger_member_profile` RPC has no email param (supabase-schema.sql
~6099) so users already can't change email. Remaining work: (a) make the name prompt **mandatory**
on first run — gate via `shouldShowMemberProfileSetup()` (app.js ~17148), block app use until a real
name is saved; (b) **drop MobilePay from onboarding** (decision: name only); (c) **lock the name
field after first save** (add a "name confirmed" flag; render read-only thereafter) — admins still
edit via `upsert_ledger_member_admin`. Runtime + possible migration → version bump. **Sonnet.**

### #22 — Lock trip driver to signed-in user
Selector `#tripDriver` (app.js ~3003/3475). `renderPeopleSelectors()` (app.js ~10816) **already
supports a `lockToLoggedInUser` flag** that disables the dropdown and pins it to `currentUser`. Set
it for normal trip creation (mirror the booking-context lock at app.js ~15717 and
`canCreateTripFromBooking`, ~15738). Ties to #17 (book-for-self). Default to locked. Runtime →
version bump. **Sonnet.**

### #23 — Odometer shared workspace baseline (VERIFY-FIRST)
`state.lastOdometer` is already **per-workspace**, derived by `getLatestOdometer()` (app.js ~22604)
from the highest trip/fuel odometer and prefilled into `#startKm`/`#fuelOdometer`. A new member
should already inherit the baseline. Task = verify (multi-user) that a brand-new member in an
existing workspace sees the admin's baseline and post-trip values with no per-user reset, then
tighten any gap. Likely small; may be verification-only. **Sonnet.**

### #24 — Smart odometer-at-refuel prefill
Partial prefill exists (app.js ~22621: fill `#fuelOdometer` from `state.lastOdometer` when
empty/unfocused). Strengthen with existing estimators — `getLatestOdometer()` /
`getLatestRangeOdometer()` and the trip-end capture in `buildFuelContextFromTrip`
(planner-booking-bridge.js ~66, sets `odometer: trip.endKm`). Goal: default the field to the
best-known current odometer (last trip end > last fuel odometer > baseline) while staying editable.
Runtime → version bump. **Sonnet.**

### #25 — Hide open bookings with a pending trip log from other members
`renderBookings()` ([booking-calendar.js:30](booking-calendar.js)) renders `getState().bookings`
with **no per-member filter**. "Pending" = booking ended/active with no linked trip — derivable via
`findTripForBooking()` / `getBookingStatusInfo()` (booking-calendar.js ~526). Add a rule: a booking
with a pending (unlogged) trip is visible only to its own member. **Opus, because the filter must
NOT touch conflict detection** (`findBookingConflict`, ~474) — other members still need the slot
blocked even when it's hidden from their list. Separate *display* visibility from *scheduling*
visibility. Runtime → version bump. → `BOOKING-PENDING-LOG-VISIBILITY-PLAN.md`.

### #26 — Plan-trip clarity (Full-tank range + Tank capacity)
Answers to the user's questions as small UI/copy fixes. **Full-tank range = tankCapacity ÷
consumption × 100** (`getFuelTankCapacity` app.js ~11299; `state.fuelConsumption`; computed ~11789)
— add a one-line tooltip/explainer. **Tank capacity is load-bearing** (used by
`estimateTankStateAtOdometer`, `buildRefuelPlanning`, overfill/validation) — **keep it**; option to
relabel or tuck under "advanced," do not remove. Also confirm the "Open driving route in maps" link
is discoverable (the already-built #Plan-5). Trivial/copy. Runtime → version bump. **Sonnet.**

### #27 — Booking calendar de-cramp (month view)
Tight spots: `.booking-month-day` `min-height:150px`, `grid-template-columns: repeat(7,
minmax(120px,1fr))`, chip `font-size .78rem` (styles.css ~3545–3715); renderers
`renderBookingMonthGrid` / `renderBookingMonthChip` (booking-calendar.js ~106/269). Apply the "go
wide, breathe" polish — taller cells, larger chips, better overflow than "+N more". UI-only but a
runtime file → version bump. **Sonnet.**

### #28 — Settlement audit
Render `renderSettlements()` (app.js ~12663); engine `calculateLedger()` + `buildSettlements()`
([settlement-calculations.js:4](settlement-calculations.js)). Audit each field (payment ref, status
chip, route, payment story, evidence summary, math details, linked trips/fuel) for relevance +
correctness. Known smells to verify: "fuel share" label actually means distance-weighted fuel
**cost** (math right, wording confusing); **charged-km vs actual-km** can diverge in display while
settlement uses `person.km`; rounding handled by `allocateRoundedMoney`. **Mixed**: Opus verifies
the money calculations, Sonnet sharpens UX/copy per the Admin-observability "summary-first, honest,
trim" principle. → `SETTLEMENT-AUDIT-PLAN.md`.

### #29 — (DEFERRED) Distance from start/end addresses
Inputs `#tripEstimateStart` / `#tripEstimateDestination` exist ([index.html:209](index.html)) and
feed a Maps dir URL, but **no distance is computed** — user still types km manually. Real driving
distance needs a routing API (Google Directions or OpenRouteService = key + per-call cost).
**Parked pending the user's API/cost decision.** When picked up: fetch distance once both fields are
filled, feed `renderTripEstimate()` (app.js ~10929) instead of the manual input.

### #30 — (DEFERRED) Route-aware station recommendation
`buildStationInsights()` (app.js ~11196) is purely **historical** today (cheapest past receipts),
not wired to current tank state or route. A forward-looking "fill up here on this trip" needs #29's
routing data + current tank estimate (`estimateTankStateAtOdometer`). **Parked with #29.**

### #31 — Begin refactoring the monolith (`app.js`)
`app.js` is **23,153 lines** (the next-biggest module is 742) — every feature in this backlog has
to navigate it by `~line` anchors, which is slow and error-prone, and the version-bump-per-runtime-
change rule means near-everything collides in one file. Start an **incremental, behaviour-preserving**
extraction into ES modules along the seams the codebase already uses (it has `booking-calendar.js`,
`settlement-calculations.js`, `trip-actions.js`, `planner-booking-bridge.js`, `admin-tools.js`,
`notifications.js`, `build-info.js` — proof the pattern works). Candidate first carve-outs, each a
self-contained PR with no behaviour change:
- **member/profile + admin gating** (`canManageSettings`, `canUseGlobalAdminTools`, member-management
  render/refresh, profile setup) — also unblocks #18–#21.
- **fuel/tank estimation** (`estimateTankStateAtOdometer`, `buildRefuelPlanning`,
  `calculateTripCostEstimate`, `buildStationInsights`, `getFuelTankCapacity`) — unblocks #24/#26/#29/#30.
- **sync/state lane** (`loadSupabaseState`, sync-health banners, startup gate) — the #3 territory.
Rules: **one cohesive area per PR**, keep public function names/call sites stable (re-export from
`app.js` if needed), `npm run validate` + `npm run test:e2e` green before/after each carve, update
`ARCHITECTURE.md`'s "where to look" table each time. No big-bang rewrite. **Opus**, done as a slow
background track interleaved with feature work (extract the area a feature touches *as part of* that
feature where it's cheap). → `REFACTOR-APPJS-PLAN.md` (write the seam map before the first carve).

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

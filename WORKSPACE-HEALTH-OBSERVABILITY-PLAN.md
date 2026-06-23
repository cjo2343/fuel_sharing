# Plan: Workspace health → observability-style (stop crying wolf, hide the green wall)

Panel: `renderSystemHealth(ledger)` (app.js ~15960) + `buildSystemHealthChecks(ledger)`
(app.js ~17804). Visible to workspace admins (not owner-only). Today it renders a
3-tile summary (Needs attention / Warnings / Looks good) **plus all 14 checks as a flat
vertical list** — "so much information."

## Two real problems
1. **Mis-severity (cries wolf).** Neutral/setup states are coded `level: "warning"` and
   shown as amber "CHECK": "Push not enabled on this device," "No upcoming bookings,"
   "No closed periods yet." A healthy new workspace always shows "Warnings: 3." These
   are *informational*, not warnings.
2. **No drill-down.** All 14 rows show at once, including the 11 passing — the opposite
   of observability, where you surface anomalies and collapse the healthy baseline.

## Changes

### A. Fix the severity model (logic — buildSystemHealthChecks)
- Add an **`info`** level (alongside `ok` / `warning` / `issue`). Reclassify the
  neutral/setup checks to `info`: push-not-enabled-on-this-device, no-upcoming-bookings,
  no-closed-periods-yet (and any similar "nothing wrong, just FYI" state).
- Keep `warning` for things genuinely worth a look (e.g. large fuel logs missing liters,
  suspicious DKK/L, implausible trip distance) and `issue` for real failures
  (unreadable tables, booking overlaps, settlement fuel impossible vs distance).
- Summary becomes: **Needs attention (issue)** · **Warnings (warning)** · **Looks good
  (ok)**, with `info` shown as a quiet "+N info" rather than inflating Warnings. A
  freshly-set-up healthy workspace should read 0 / 0 / all-good.

### B. Observability layout (presentation — renderSystemHealth)
- **Summary first, anomalies only by default.** Render the 3 (or 4) summary tiles, then
  by default only the `issue` + `warning` rows. Collapse the passing rows behind
  "Show all N checks" / a "✓ 11 looking good" expander (and the `info` items behind a
  small "N informational" disclosure). When everything is OK, show a single calm
  "All checks passing" state instead of 14 rows.
- **Group by category** like an observability board: Access (Auth, Admin users, People),
  Data integrity (Database tables, Normalized tables, Fuel liters, Receipt price, Trip
  distance, Settlement sanity), Bookings (date integrity, overlaps, upcoming),
  Maintenance (archive history, push). Headers per group.
- **Trim copy** to one line each; move the long explanations (Database tables /
  Normalized tables) into a tooltip or the expanded detail.
- **Make non-OK actionable** where cheap: Push → an "Enable push" affordance; Archive
  history → point to close-period. (Optional; presentation-first is fine.)

## Validation
`npm run validate`, `npm run test:e2e`; manual: a healthy workspace shows 0 needs-
attention / 0 warnings (the 3 former "CHECK" items now read as info, collapsed); the
list defaults to anomalies + an expander for the passing checks; an injected real
problem (e.g. a booking overlap) surfaces at the top as needs-attention. Runtime files
change → version bump (build-info + service-worker + checklist; no embedded double-
quotes in the top release note).

## Category
**Sonnet** — well-specified: a small severity-bucket change in
`buildSystemHealthChecks` + a presentation rework in `renderSystemHealth` (collapse
passing, group, trim). Reuses the metric-tile aesthetic. Shares the "Admin: so much
information → observability" theme with #11/#13/#14, but this panel is workspace-admin
scope (broadly visible), so it's the highest-value of the cleanup set.

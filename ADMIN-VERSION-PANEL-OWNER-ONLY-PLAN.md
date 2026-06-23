# Plan: owner-gate the "Version & update status" panel + trim the public About panel

## Intent
The Admin "App owner · Version & update status" panel (`#buildInfoPanel`) is labelled
"App owner" but is shown to **any workspace admin** (it's only gated by the Admin tab =
`canManageSettings()`). It also renders the internal engineering "Latest notes"
(release notes). Normal workspace admins should not see this owner panel. They keep the
public, read-only **About → App version** panel (`#aboutBuildInfoPanel`), which should
show only version/update status — not the internal release notes.

## Current behaviour
- `build-info.js renderBuildInfo()` (~568) renders **identical** content into BOTH
  `#buildInfoPanel` (Admin) and `#aboutBuildInfoPanel` (About), including the
  `release-note-card` with "Latest notes" (`renderBuildInfoPanel`, ~525–562).
- `#buildInfoPanel` lives in the Admin tab; the Admin tab shows for any admin
  (`canManageSettings()`, app.js ~3913/3920). No app-owner gate.
- Owner-only tools elsewhere already gate on `canUseGlobalAdminTools()` /
  `isConfiguredAppOwnerEmail()` (e.g. dataToolsPanel at app.js ~9474, owner cards at
  ~6683). Reuse that gate for consistency.
- The user-facing update prompt is the separate `#appUpdateToast` (all users) — NOT
  this panel — so owner-gating this panel does not remove anyone's ability to update.

## Changes (Sonnet)

### 1. Owner-gate the Admin version panel
- In `index.html`, the "App owner / Version & update status" section wrapping
  `#buildInfoPanel` (~968–976): give the section wrapper a stable id/class.
- In app.js, alongside the other owner-tool visibility toggles (~9474), toggle that
  section `hidden` unless `canUseGlobalAdminTools()` (configured app owner). Normal
  workspace admins no longer see it.

### 2. Keep About public but trim it to non-internal info
- In `build-info.js renderBuildInfoPanel(target, …)`, when the target is the public
  About panel (`target.id === "aboutBuildInfoPanel"` or it has `compact-build-info`),
  render only: App version, Updated, and Update status (Current/Handoff/Updating +
  the "Update now" button if an update is pending). Omit the internal **Latest notes**
  card and the owner-debug cards (Build label, Loaded page cache, Latest deployed,
  Service worker cache). Confirm whether `compact-build-info` CSS already hides
  `release-note-card`; even if it does, stop emitting it into the public panel so
  internal notes aren't in the DOM for normal users.
- Keep the full content (incl. Latest notes + SW/cache debug) for `#buildInfoPanel`
  (owner only, per #1).

### 3. Keep the update path for everyone
- Do not touch `#appUpdateToast` / `activateReadyAppUpdate`. Normal users still get the
  "Update now" prompt (and, once backlog #1 lands, the reliable handoff). The About
  panel's "Update now" button (when an update is pending) can stay as a convenience.

## Validation
`npm run validate` (incl. the security/runtime guards), release-readiness,
`npm run test:e2e`. Note: the e2e test "build info is visible to all users in About
and admin panels" (tests/smoke.spec.js) asserts version/buildLabel/cache appear in
BOTH panels — it will need updating, since the About panel will no longer show the
build label / cache. Adjust that test to assert version in About and the full set in
the owner-gated admin panel (and that the admin panel is gated). Runtime files change
→ version bump (build-info + service-worker + checklist; no embedded double-quotes in
the top release note).

## Notes
- Same theme as backlog #5 (normal workspace admins shouldn't see owner-only tools);
  could be implemented together.

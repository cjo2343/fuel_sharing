# Plan: Workspaces & invites — UI/UX overhaul + go horizontal

This is the primary onboarding surface (see backlog #5). Two problems: a misleading/
cluttered invites list ("seems buggy") and a tall, narrow layout.

## Current
- Markup: `.workspace-invites-grid` (index.html ~886) with 4 `.data-tool-card`s:
  Create new workspace, Create invite, Your workspaces, Active invites — each with
  long paragraph copy.
- `renderWorkspaceInvitesPanel()` (app.js ~17282): `#inviteList` renders **all**
  invites (app.js ~17338) with an Active/Inactive pill, **no sort, no limit, no
  active/inactive split** — so the "Active invites" card is full of inactive/used
  codes.

## Fixes

### A. Invite list — make "Active invites" actually active (render logic)
- Sort newest-first.
- Split into **Active** (revocable: not revoked, not expired, uses < max) shown by
  default, and **Used / expired / revoked** collapsed behind a `<details>` summary
  ("Show N used or expired invites"). Keep the existing per-row markup + Revoke (still
  disabled for inactive).
- Cap the active list to a sensible number with a "+N more" affordance if it ever
  grows; the collapsed used/expired group keeps history without dominating.
- Rename the card "Invites" (it now contains both groups), keep the one-line intro.

### B. Layout — horizontal, not tall/narrow (CSS)
- `.workspace-invites-grid`: make it width-aware. Suggested structure:
  - Row 1: the two creation forms side by side — "Create new workspace" and "Create
    invite for current workspace" (`grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`).
  - Row 2 (full width): "Your workspaces" — render rows horizontally (label · scope ·
    role · Use button) and, if multiple, as an auto-fit grid rather than a tall stack.
  - Row 3 (full width): "Invites" — render as a wide list/table using the full
    container width (email · expiry · status · role/uses · Revoke in one row), or a
    2-column auto-fit grid of invite rows, so it's short and wide instead of a long
    column.
- Apply the same `repeat(auto-fit, minmax(...))` horizontal principle as backlog #7.

### C. Copy — trim the walls of text (CSS/markup)
- The form cards have multi-paragraph descriptions (esp. "Create invite"). Reduce to
  one short line each; move the rest into `entry-meta`/a small "?" tooltip. This alone
  removes much of the vertical bulk.

## Validation
`npm run validate`, `npm run test:e2e` (the supabase-mock permission test exercises
invites indirectly; invite create/revoke smoke flows read DOM by ids — keep ids
`#inviteList`, `#workspaceList`, the form ids). Manual: create an invite (appears under
Active), use/expire one (moves to the collapsed group), revoke an active one. Confirm
the section is wide/short at desktop and collapses cleanly on mobile. Runtime files
change → version bump (build-info + service-worker + checklist; no embedded double-
quotes in the top release note).

## Category
**Sonnet** — CSS/layout + a well-specified render change (sort/split/collapse the
invite list). Design-subjective enough that a mockup first (Opus) would help anchor
the column structure if desired.

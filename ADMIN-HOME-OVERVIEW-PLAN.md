# Plan: make the "Workspace admin" overview honest per role

## What it is
`.admin-home-panel` (index.html ~672) is a static legend at the top of the Admin tab:
an intro paragraph + three cards (Workspace / Owner tools / Diagnostics Lab). It is
informational only — it describes the page's zones; it doesn't link or act.

## Problem
It renders for every workspace admin (admin-tab gated, no owner gate), but the
"Owner tools" and "Diagnostics Lab" zones it describes live in `#dataToolsPanel`
(index.html ~699), which is `hidden` + owner-only (`canUseGlobalAdminTools()`, app.js
~9474). So a normal workspace admin sees a legend for two sections they don't have →
confusing and pointless.

## Changes (Sonnet)
For a **normal workspace admin**:
- Hide the "Owner tools" and "Diagnostics Lab" cards.
- Replace the intro paragraph with a short, accurate line, e.g. "Manage your
  workspace: members, invites, and group settings." (Drop the "App-owner maintenance
  and raw troubleshooting are collapsed below" sentence — there is nothing collapsed
  below for them.)
- Optionally drop the legend entirely for normal admins and let the Member management
  + invites + settings panels stand on their own (they are self-explanatory). Either
  is fine; trimming to a one-liner is the lighter touch.

For the **app owner** (`canUseGlobalAdminTools()` / `isConfiguredAppOwnerEmail()`):
- Keep the full three-card overview + the current intro — it accurately maps the page
  (Workspace above, Owner tools & Diagnostics Lab below).

Implementation: gate the owner-only cards + the owner sentence behind the same
`canUseGlobalAdminTools()` check used for `#dataToolsPanel`. Add a small render hook
(or two pre-rendered variants toggled by a class) so the legend matches the user's
role. Keep it CSS/markup + one visibility check — no new logic.

## Validation
`npm run validate`, `npm run test:e2e`; manual: as a normal workspace admin the Admin
tab shows only workspace tools and an accurate one-line intro; as the app owner the
full three-zone overview + the owner/diagnostics panel appear. Runtime files change →
version bump (build-info + service-worker + checklist; no embedded double-quotes in
the top release note).

## Theme
Same role-separation theme as backlog #5 (invite-only membership) and #6 (owner-gate
the version panel). #5 + #6 + #8 are one coherent pass — "normal workspace admins see
only workspace tools; owner/diagnostics UI is app-owner-only" — and are best handed to
Sonnet together so the gating is applied consistently in one go.

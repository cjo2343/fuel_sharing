# Plan: clean up the Diagnostics Lab *tools* drawer

The owner-only `details.diagnostics-lab-group` drawer (index.html ~736), distinct from
#11 (the `renderAdminGuardrailOverview` status tiles). This drawer holds **action
tools**, not metrics: Clean test users (#removeTestUsers ~745), Test data (add/remove
test trip/fuel, purge soft-deleted ~748), Test Lab (#runFullTestLab + cloud-touching
details + Unlock advanced ~758-792), Data retention & privacy cleanup (#runRetentionCleanup
~803), plus the report cards rendered by `renderTestLabReport` (app.js ~5134) into
`#testLabReport`, and the "Data I/O & backend monitor" below.

## What's wrong
- Walls of explanatory copy on every card.
- Actions (buttons) and result displays (report cards) are visually mixed, so it reads
  as "so much information."
- "Are they auto-updated / what do they check?" is unanswerable from the UI because
  it doesn't distinguish *do-something* buttons from *shows-last-run* reports.

## Direction (these are ACTIONS, so "observability" = clarity + result display)
1. **Two clear zones inside the drawer:**
   - **Maintenance actions** — Clean test users, Test data, Retention cleanup. Group by
     risk with the existing badges (Safe / Local-only / Admin-only / Destructive /
     Cloud-touching), trim each card to a one-line description + the button(s); move the
     long policy/explanation text into a tooltip or a collapsed "Details".
   - **Self-tests & reports** — Test Lab run controls + the report cards.
2. **Make the report cards observability-style:** instead of paragraph blobs, show a
   compact result tile — status pill (passed/failed) + build version + timestamp +
   "Run again to refresh". Surface the **stale-report warning** compactly (e.g. a
   "Stale — saved on v320, current build v430" pill) rather than a sentence. This is
   the one genuinely observability-like part.
3. **Trim copy everywhere**; keep destructive buttons clearly styled (danger) and
   confirmation-gated (they already are — don't weaken that).
4. Keep "Targeted checks" / "Cloud-touching checks" / "advanced admin tools" collapsed
   (already are). No change to what any action does — presentation/grouping only.

## Validation
`npm run validate`, `npm run test:e2e`; manual as app owner: every tool still triggers
its existing handler (ids unchanged: #removeTestUsers, #runFullTestLab,
#runRetentionCleanup, #unlockAdvancedAdminTools, etc.), destructive actions still
confirm, report cards render the last run with a clear timestamp + stale warning.
Non-owners never see it (owner-gated). Runtime files change → version bump (build-info
+ service-worker + checklist; no embedded double-quotes in the top release note).

## Category & pairing
**Sonnet** — presentation/grouping/copy + a compact report tile; no behavior/logic
change (keep all ids + confirmations). Do together with **#11** (same Diagnostics Lab
area) and reuse the #427 tile styling for the report card.

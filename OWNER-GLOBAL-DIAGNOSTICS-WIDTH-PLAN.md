# Plan: fix the cramped "App-owner global diagnostics" card (narrow column + mid-word wrap)

A concrete instance of the recurring tall/narrow problem — here caused by a real
layout bug, not just preference.

## Root cause
`renderSupabaseLoadMonitor` builds the outer `.admin-diagnostics-dashboard` grid
(`auto-fit, minmax(212px, 1fr)`, app.js ~6661). `renderOwnerGlobalDiagnosticsCard()`
(app.js ~6117-6136) returns an `<article>` **plus** a `<details class="admin-diagnostics-section">`
that contains its **own nested** `.admin-diagnostics-dashboard` with 3 cards
(Global workspaces / Recent vehicle lookups / Recent global activity). That `<details>`
lands as a **single ~212px grid cell** of the outer grid, so the nested 3-card grid
only has one column → cards stack vertically and stay ~250px wide. Then
`.readable-activity-list { overflow-wrap: anywhere }` breaks emails/codes mid-character
("chrjohn.d k", "VEHICLE_LOOKUP_OK", "main- car").

## Fix (Sonnet — CSS/markup)
1. **Span the section full width.** Make the owner-global `<details class="admin-diagnostics-section">`
   (and the matching one from `renderOwnerActivityCard()`, app.js ~6684, if it has the
   same shape) span the full outer grid row: `.admin-diagnostics-section { grid-column: 1 / -1; }`.
   Then its nested `.admin-diagnostics-dashboard` gets full width and lays the 3 cards
   out horizontally (auto-fit already handles it). This alone fixes the squeeze.
2. **Stop mid-word breaking.** For the activity lists, change
   `.readable-activity-list` from `overflow-wrap: anywhere` to
   `overflow-wrap: break-word; word-break: normal;` so emails/result codes wrap at
   spaces/separators, not mid-character. Optionally render each `<li>` as a flex row
   (status chip + text) so the OK/Issue chip aligns left and the text flows beside it.
3. Sanity-check other consumers of `.admin-diagnostics-section` / `.readable-activity-list`
   so the change doesn't regress a place that intentionally relied on `anywhere`.

## Validation
`npm run validate`, `npm run test:e2e`; manual as app owner: open Admin → the
App-owner global diagnostics section spans full width with the 3 cards side by side at
desktop width, emails/codes wrap cleanly (no mid-character breaks), and it collapses to
one readable column on mobile. Runtime files change → version bump (build-info +
service-worker + checklist; no embedded double-quotes in the top release note).

## Category & pairing
**Sonnet** — layout/CSS only. Part of the **owner diagnostics cleanup cluster** with
#11 (status tiles) and #13 (tools drawer); do together. Reinforces the #7 "go wide"
principle.

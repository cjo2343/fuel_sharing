# Plan: horizontal Group settings (and a general "go wide" layout principle)

## Intent
The Group settings form reads as a tall, narrow card because `.settings-form` is a
fixed 2-column grid. The app container is 1100px wide, so use that width: flow the
short fields into 3–4 columns so the form is wide and short. Apply the same principle
to other tall stacked card/forms going forward.

## Current
- `index.html` `#settingsForm.settings-form`: a flat list of `<label>` fields, with
  `.wide` on full-width items (Lookup button row, vehicle summary + credit, People
  textarea, Save) and `.setting-toggle` on the reminders checkbox row.
- `styles.css:339`: `.settings-form { grid-template-columns: minmax(118px, 0.55fr) minmax(0, 1fr); }`
  → 2 columns, tall.
- Narrow-screen media queries (~1066, ~700, ~560) already relax grids to 1 column.

## Changes (Sonnet — CSS only)
1. `.settings-form` → responsive multi-column:
   `grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); align-items: end;`
   Most fields are short (currency, numbers, selects) → 3–4 per row at full width,
   collapsing automatically as width shrinks.
2. Span the full-width items across all columns:
   `.settings-form .wide { grid-column: 1 / -1; }`
   (Lookup row, vehicle summary/credit, People textarea, Save button.)
3. The reminders toggle has a long description — give it room so it doesn't get
   crushed in a 4-col row: `.settings-form .setting-toggle { grid-column: span 2; }`
   (or `1 / -1` if span 2 still looks cramped — implementer's judgment at 170px cols).
4. Confirm the existing narrow media queries still collapse `.settings-form` to a
   single column on phones (auto-fit already does this, but verify the ~700/560
   overrides don't fight it; simplify if they hardcode 2 columns).
5. Keep the People textarea full-width and tall (it lists members one per line).

Net: a wide, ~3–4-row settings block instead of a ~7-row narrow column.

## General principle (apply incrementally, not all at once)
Prefer `repeat(auto-fit, minmax(<min>, 1fr))` horizontal grids over fixed narrow
columns for settings/diagnostics/forms. The Admin diagnostics dashboard already does
this (`.admin-diagnostics-dashboard`, minmax(212px,1fr)). Candidates to revisit later:
the `.form-grid` forms (booking/trip/fuel — currently fixed 2-col) and any other
stacked panels. Do these as separate small passes so each can be eyeballed.

## Validation
`npm run validate`, `npm run test:e2e` — the settings e2e tests fill fields by id
(`#fuelConsumption`, `#fuelTankCapacity`, …) and submit, so a pure CSS grid change
won't break them; just confirm fields remain visible/enabled. Manual: open Group
settings at desktop width (should be wide/short), and at phone width (should collapse
to one column, no overflow). Runtime files change → version bump (build-info +
service-worker + checklist; no embedded double-quotes in the top release note).

## Category
**Sonnet** — pure CSS/layout, well-specified, low risk. Optionally preview a mockup
first if the column grouping wants tuning.

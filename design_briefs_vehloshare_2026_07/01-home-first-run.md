# Brief 01 — Home: first-run vs dashboard orchestration

**App:** VehloShare — shared-car expense tracking for small Danish groups (households,
friend groups sharing one car). **Screen:** Home ("Hjem" tab), the app's landing surface.

## The problem

Home currently decides "what leads the screen" through three overlapping, independently
evolved gates (`leadWithGetStarted`, `showGetStarted`, `carConfigured`), and the seams
show. Observed on device (2026-07-09, a fresh workspace with 2 members and no car):

1. **Duplicate call-to-action.** "Tilføj din bil" renders TWICE, stacked: as step 1 of
   the "Kom godt i gang" checklist card AND as a separate dashed empty-state card
   directly beneath it. Two competing affordances for the same action on one screen.
2. **Competing hierarchies.** In the same first-run state the screen also shows an
   "I er kvit" balance card between the checklist and the dashed CTA — a money status
   for a workspace that cannot have money movements yet (no car, no trips).
3. Once the workspace matures, the same layout flexes into a dashboard (balance card →
   car-status banner → group avatars → recent trips → "Mere" link list) — that mature
   state works well and is NOT the redesign target; the transition into it is.

## Current structure (for reference)

- First-run: greeting header (Godmorgen/God aften, {name}) with chat + gear icons →
  "Kom godt i gang" checklist (3 steps: Tilføj din bil / Inviter din gruppe / Log din
  første tur, with progress bar, per-step done states, "Skjul" dismiss) → "I er kvit"
  card → dashed "Tilføj din bil" card → "Jeres gruppe" avatar row → (empty) Seneste ture.
- Mature: balance card ("Du skylder 100,00 kr til mobil2" amber / "Du får…" leaf) →
  car banner ("I brug af Dianna · Indtil 18.00" + Book) → group → Seneste ture (3) →
  Mere (Historik / Indsigt / Udgifter).

## Design task

Rethink Home as **one explicit state model** with a clear owner of the screen's lead
position per state, e.g.:

- **State A — setting up** (no car OR no members OR no first trip): onboarding leads.
  ONE source of truth for next actions (the checklist). No duplicate CTA, no money
  card before money can exist. Consider what earns the remaining space (invite code?
  what happens next explainer? nothing?).
- **State B — running** (car + activity): dashboard leads (today's balance, car
  status, latest activity). Checklist gone forever.
- **The handover moment**: how does A become B? Celebrate the first trip? Collapse
  the checklist automatically when all three steps complete (today it lingers until
  manually hidden)?

Also worth a designer's eye while in there:
- The header's two glyph buttons (chat bubble → Aktivitet, gear → Bilprofil) sit close
  and the gear's destination is being re-thought separately (brief 03) — leave the
  gear as "settings entry" conceptually.
- "Se alle" on Seneste ture and the Mere list partially overlap in purpose (both lead
  to Historik-ish surfaces).

## Out of scope

Bottom tab bar, the individual destination screens, the checklist's three steps
themselves (their content is right; their orchestration is the problem).

## Success criteria

- Zero duplicated affordances in any state.
- A screenshot of any Home state answers "what should I do next?" in one glance.
- State transitions definable as a tiny decision table an engineer can implement
  directly (please include that table in the handoff).

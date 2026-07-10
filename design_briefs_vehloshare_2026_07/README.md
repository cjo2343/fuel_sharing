# VehloShare — Claude Design briefs (July 2026)

Three redesign briefs from the full as-is audit (2026-07-09/10: design-system code
sweep + screen-by-screen visual pass on a populated workspace). Each brief is
self-contained: hand the single file to Claude Design as-is.

| Brief | Screen | Problem class |
|---|---|---|
| [01-home-first-run.md](01-home-first-run.md) | Home | Onboarding-vs-dashboard state orchestration |
| [02-activity-sparse-state.md](02-activity-sparse-state.md) | Aktivitet | Inverted chat layout fails when nearly empty |
| [03-bilprofil-ia.md](03-bilprofil-ia.md) | Bilprofil | Car profile and app settings conflated behind one gear |

A fourth audit candidate — BookingDetail — is **not** a design brief: it already
has its approved design (design_handoff_govehlo_v1 · BookingDetail 1a); the
implementation drifted off-token and is being rebuilt as an engineering task.

## Shared constraints (apply to all three briefs)

- **Design system v1 is law**: tokens in `design_handoff_govehlo_v1/design-system/`
  (colors, Nunito display + Inter body, Courier New mono for numbers, 4px grid,
  radius 16 cards / 12 buttons, 44×44 min touch targets, 16px screen padding,
  64px bottom nav, 72px header).
- **Amber #F4A261 = money values only** — never decorative. Direction: owe = amber,
  owed/incoming = leaf, settled/zero = muted. Blue #355d9c = "Anmodet" status only.
- **Danish UI**, sentence case, second person + first names ("Du skylder Lars 52 kr").
  Friendly, transparent about money, never clinical. Lucide icons; no emoji.
- Deliverable format: a self-contained prototype HTML (like BookingDetail 1a) plus
  redlines/annotations is ideal; the implementation lands in React Native
  (govehlo-mobile), so component boundaries beat pixel perfection.
- Locked product decisions (do not redesign against them): Afregn = reconcile,
  Betal = pay; gross balances + "I er kvit"; manual period close + nudge; the
  chat-style merged activity feed as a concept.

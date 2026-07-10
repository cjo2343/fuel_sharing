# Brief 03 — Bilprofil: untangle car profile from app settings

**Screen:** "Bilprofil", opened from the GEAR icon in Home's header (accessibility
label: "Indstillinger"). The information-architecture problem was flagged
independently by two audits and confirmed on device.

## The problem

One screen is simultaneously two products:

1. **The car's profile** — car card (name "Johnsen", plate BK32190), big mono odometer
   (96.500 km), stats (Ture 6 · Tankninger 5 · Brændstof i alt 1.400,00 kr), and the
   sub-pages Bilen (syn, forsikring, ejerafgift) / Afregning (settlement mode, split
   defaults) / Gruppe (members + invite code).
2. **The app's settings** — Notifikationer / Data & privatliv / Konto (MobilePay
   number, log ud, slet konto).

The affordance triangle is broken: a **gear** icon (universally "settings"), labeled
**"Indstillinger"** for screen readers, opens a screen titled **"Bilprofil"** that
leads with a car card. Users hunting for "log ud" must think "car profile"; users
tapping the gear for the odometer get lucky. In the add-car flow the same gear opens
the add-car empty state — so the settings entry point disappears entirely for a
car-less workspace.

## Design task

Decide and design the IA split. Directions to evaluate (not prescriptive):

- **A — Two destinations.** Gear → "Indstillinger" (Notifikationer, Data & privatliv,
  Konto, app info). The car gets its own natural home — e.g. tapping the car banner /
  car card on Home opens "Bilen" (profile + odometer + stats + Bilen/Afregning/Gruppe).
  Cleanest mental model; costs one more navigation entry point.
- **B — One hub, honest naming.** Keep one screen but title it "Indstillinger",
  demote the car to the first section ("Jeres bil") among clearly grouped sections
  (Bil · Afregning · Gruppe · App · Konto). Cheapest change; keeps the two-in-one.
- **C — Your better idea.**

Whatever the direction, resolve:
- Where does a car-less workspace's "add car" live, and does the settings entry
  survive it?
- Workspace-scoped vs account-scoped separation (Afregning/Gruppe are per-workspace;
  Notifikationer/Konto are per-user — today they sit in one flat list; the ledger
  switcher for multi-workspace users must stay reachable).
- The Home header: if the gear becomes pure settings, does the car need a glyph, or
  is the existing car-status banner the entry?

## Out of scope

The CONTENT of the sub-pages (Bilen, Notifikationer, Konto etc. are fine) — this is
about the front door and the grouping, not the rooms.

## Success criteria

- "Hvor logger jeg ud?" and "hvad står kilometertælleren på?" both answered on the
  first tap by a first-time user.
- Icon, accessibility label, and destination title agree with each other in every state.
- Deliver as navigation map + the hub screen(s) prototype.

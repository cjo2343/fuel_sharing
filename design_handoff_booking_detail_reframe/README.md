# Handoff: BookingDetailScreen — availability-first reframe (Option 1a)

## Overview
Reframe of `BookingDetailScreen` in the **govehlo-mobile** app. The old screen stamped the booking window's timestamps onto the route endpoints, so a short round-trip drive read as a multi-day crawl to the destination. This design fixes the framing: the screen now **leads with availability** — "when is the car free again" — and demotes the route to a clearly-secondary planning aid.

The chosen direction is **Option 1a: the availability headline band.**

### The confirmed model (do not re-question)
- The booking is a **round trip**. `end_at` = the car is **back home and free again** — it is **NOT** arrival at the destination.
- The destination is only the trip's **turnaround point** ("Vendepunkt"). It must **never** be labelled "Aflevering" and must **never** show `end_at`.

## About the design files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to ship directly. The task is to **recreate this design in govehlo-mobile's existing environment** using its established components and patterns (AppHeader, StatusChip, StatTile, the timeline stop nodes, the action bar). Map each block to the existing component named below; only the availability band may be new.

Two files are included:
- **`GoVehlo BookingDetail 1a.dc.html`** — the clean, implementation-ready 1a screen. Covers both states (has-route / no-route) and all three booking statuses via toggles. **This is the source of truth for measurements and copy.**
- **`GoVehlo Booking Detail — Reframe Mock (all options, annotated).dc.html`** — the full annotated exploration (options 1a/1b/1c side by side, numbered component-mapping pins, copy reference). Context only — 1a is what ships.

Both are `.dc.html` design-component prototypes and reference the GoVehlo design-system bundle. Read them for visual reference; do not copy the HTML into the app.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, copy, and layout. Recreate pixel-accurately using the codebase's existing GoVehlo components and design tokens.

## Screens / Views

### BookingDetailScreen (reframed)
**Purpose:** A member opens this sheet to see a car booking. For anyone who isn't the booker, the primary question is "when is the car free again" — answered at the top. The booker can also review/open the planned route.

**Layout (top → bottom), 16px horizontal screen padding, 12–13px vertical gap between blocks:**

1. **Status bar** (platform) — Forest `#2D6A4F` background.
2. **AppHeader** — Forest `#2D6A4F`. Left: back chevron (`chevron-left`) + title "Booking" (Nunito 800, 20px, white). Right: two 34×34 circular buttons (`rgba(255,255,255,.15)` fill) — edit (`pencil`) and close (`x`). Component: **AppHeader (reuse)**.
3. **Availability band** — the lead element (see below). Component: **new** (see "New component" section).
4. **Facts grid** — 2 columns, 10px gap. Two **StatTile** cards: "Booket" (date range) and "Varighed". Component: **StatTile / facts grid (reuse)**. Note: distance & drive time are **not** here — they moved into the route section, because they describe the plan, not availability.
5. **Planlagt rute** — secondary route section (see below). Component: **StopNode / TimelineStop (reuse), restyled subordinate**. When the booking has no route, this is replaced by the empty state.
6. **Action bar** — pinned bottom, `#F7F9F8` with 1px top border `#E2EDE8`. Component: **action bar (reuse)**.

---

#### Availability band (block 3) — the lead
- Container: background `#D8F3DC` (Mist), radius 18px, padding 17px.
- Top row (space-between):
  - Eyebrow: 11px / weight 700 / letter-spacing .09em / color `#2D6A4F`. Text depends on status:
    - `kommende` → **"LEDIG IGEN"**
    - `i gang` → **"BILEN ER UDE — LEDIG IGEN"**
    - `afsluttet` → **"VAR LEDIG IGEN"**
  - StatusChip: white pill, 5px dot + label (11.5px/600, `#1A2E1F`). Dot color: kommende `#2D6A4F`, i gang `#52B788` (leaf), afsluttet `#8AA396`. Component: **StatusChip (reuse)**.
- Headline value: Nunito **900**, 26px, color `#1A2E1F`, line-height 1.08. Format: `{weekday} {d}. {mon}, {HH.mm}` — e.g. **"tirsdag 7. jul, 18.00"**. The date is plain text; the **time is monospace** (Courier New) weight 700. This value is derived from **`end_at`**.
- Subline: 13px, color `#3F6B52`. Format: **"{Booker} bookede bilen til {purpose}"** — e.g. "Rikke bookede bilen til weekendtur". (Second person / first-name voice; purpose lowercased.)

#### Planlagt rute (block 5) — subordinate
Deliberately quieter than the availability band: plain white surface `#FFFFFF`, radius 18px, 1px border `#EEF3F0`, flat shadow `0 1px 2px rgba(26,46,31,.05)`. No colored fill.
- Header row (space-between): left — `route` icon (15px, `#6B8F7A`) + "Planlagt rute" (Nunito 700, 14px, `#1A2E1F`); right — route summary, monospace 11.5px `#8AA396`, format `"{distanceKm} km · {driveTime}"` e.g. "187 km · 2t 5m". This is where distance & drive time live now.
- Timeline stops (vertical, 14px gap between icon column and content; dotted connector `repeating-linear-gradient(#C7DDD0 0 4px, transparent 4px 8px)`, 2px wide):
  1. **Start** — `circle-dot` icon (20px, `#2D6A4F`). Title = `from.label` (Nunito 700, 15px). Sub: "Start · hjemadresse" (11.5px, `#8AA396`). **No timestamp.**
  2. **Fuel stop** (optional, only if `route.fuel` exists) — `fuel` icon (18px, `#6B8F7A`). Title = station brand (Nunito 700, 15px). Right: **price pill** — monospace 12.5px/700, text `#B4611A` on `#FBEAD8`, format `"{pricePerLiter} kr/L"` e.g. "13,29 kr/L". **This is the only Amber/money value on the screen.** Sub: "{kmIn} km inde".
  3. **Turnaround** — `map-pin` icon (19px, `#2D6A4F`). Title = `to.label` (Nunito 700, 15px). Right: **estimated arrival**, monospace 11.5px `#8AA396`, format `"est. ank. ca. {HH.mm}"` where time = `start_at + driveMinutes`. Sub: **"Vendepunkt"** (11.5px, `#8AA396`). **Never "Aflevering", never `end_at`.**
  - Return note: 12px top border `#EEF3F0`, `rotate-ccw` icon (14px) + "Retur til {from.label}" (12px, `#8AA396`). **No time.**

#### No-route empty state (block 5 alternative)
Same white card shell. Centered: 56px circle `#D8F3DC` with `map` icon (26px, `#2D6A4F`); title **"Ingen rute planlagt endnu"** (Nunito 700, 15.5px, `#1A2E1F`); body **"Planlæg ruten, så gruppen kan se hvor bilen skal hen."** (13px, `#6B8F7A`, max-width 240px). Component: **EmptyState (reuse)**.
**Important:** the availability band is unchanged in this state — availability comes from `end_at` and never depends on whether a route exists.

#### Action bar (block 6)
- Primary button (flex:1, height 50px, radius 14px, Forest `#2D6A4F`, white Nunito 700 16px, shadow `0 2px 8px rgba(45,106,79,.28)`):
  - has-route → `navigation` icon + **"Åbn rute"**
  - no-route → `plus` icon + **"Planlæg rute"**
- Edit button: 50×50, white, 1.5px border `#D6E4DC`, radius 14px, `pencil` icon (`#2D6A4F`).
- Destructive text button below: **"Aflys booking"** (weight 600, 14px, `#B4453A`), transparent, full width.

## Interactions & Behavior
- Header edit → edit booking; header/close X → dismiss sheet.
- "Åbn rute" → open route in maps (has-route). "Planlæg rute" → route planner (no-route).
- "Rediger" (pencil) → edit booking. "Aflys booking" → cancel flow (confirm).
- Follow the GoVehlo motion tokens: spring `cubic-bezier(0.34,1.56,0.64,1)` for button press (scale .97) / sheet enter; standard `cubic-bezier(0.4,0,0.2,1)` for color/opacity. Durations 80/140/220/340ms. No looping decorative animation.
- Min touch target 44×44px (buttons here are 50px / 34px header — bump header hit area to 44px).

## State Management
Inputs from a booking record:
- `start_at`, `end_at`, `status` ("kommende" | "i gang" | "afsluttet")
- `booker.name`, `purpose`
- optional `route`: `from.label`, `to.label`, `distanceKm`, `driveMinutes`, optional `fuel` { `brand`, `pricePerLiter`, `kmIn` }

Derived values:
- **Availability headline** ← `end_at` formatted `"{weekday} {d}. {mon}, {HH.mm}"`.
- **Route summary** ← `"{distanceKm} km · {fmtDuration(driveMinutes)}"`.
- **Estimated arrival** ← `fmtTime(start_at + driveMinutes)`, shown only at the turnaround.
- **Eyebrow text** ← switch on `status`.
- `hasRoute = route != null` toggles route section vs. empty state, and primary button label/icon/action.
- `hasFuel = route?.fuel != null` toggles the fuel stop node.

No `end_at` and no `start_at` may be rendered anywhere inside the route section — the only permitted route time is the derived estimated arrival.

## Design Tokens (GoVehlo DS — use the codebase's existing tokens)
Colors:
- Deep forest `#1A2E1F` · Forest `#2D6A4F` · Leaf `#52B788` · Mist `#D8F3DC` · Amber `#F4A261` (money only) · Warm white `#F7F9F8` · Surface `#FFFFFF`
- Screen-local neutrals used above: muted text `#6B8F7A` / `#8AA396`, subtle border `#E2EDE8` / `#EEF3F0`, subline green `#3F6B52`, dotted connector `#C7DDD0`, edit-button border `#D6E4DC`, destructive `#B4453A`.
- Amber for the fuel price is rendered as text `#B4611A` on tint `#FBEAD8` for AA legibility — the app should use its real Amber money treatment / AmountDisplay equivalent.

Typography: **Nunito** (700/800/900) for brand/headings & numbers; **Inter** (400/500/600) for body/labels; **Courier New (mono)** for times, rates, and the route summary. Type scale used: 26px headline (Nunito 900), 20px header title (800), 17/15px titles (800/700), 13px body, 11–11.5px labels/captions.

Radius: 18px cards, 14px tiles & buttons, 999px chips/pills, 34–44px phone shell. Spacing on a 4px grid; 16px screen padding; 12–13px block gap. Shadows: green-tinted `rgba(26,46,31,…)` per DS card/elevated levels.

## Assets
- **Icons: Lucide** (2px stroke). Names used: `chevron-left`, `pencil`, `x`, `route`, `circle-dot`, `fuel`, `map-pin`, `rotate-ccw`, `map`, `navigation`, `plus`. Use the app's existing icon set/wrapper.
- No images or custom illustrations. No emoji.

## New component
Only one block is genuinely new: the **availability band** (block 3). It can be built as a thin variant of the existing **SummaryBand** (dark stat-tile band) recolored to Mist, or a promoted **StatTile**. Everything else maps to existing components (AppHeader, StatusChip, StatTile, StopNode/TimelineStop, EmptyState, action bar). If you prefer zero new components, option **1c** in the annotated mock reorders the existing StatTile grid instead — but 1a was chosen for the strongest at-a-glance hierarchy.

## Files
- `GoVehlo BookingDetail 1a.dc.html` — implementation-ready 1a screen (both states + all statuses via toggles). Source of truth.
- `GoVehlo Booking Detail — Reframe Mock (all options, annotated).dc.html` — annotated exploration with component-mapping pins and copy reference (context).

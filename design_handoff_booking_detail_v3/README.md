# Handoff: GoVehlo — Booking Detail page

## Overview
The **Booking detail** screen shows a single car booking in the GoVehlo PWA: who booked it, the dates/duration, and — when a route has been planned — the planned journey (pickup → optional fuel stop → drop-off) with distance/drive-time facts and a shortcut to open the route in a maps app. It also supports editing and cancelling the booking, and an empty state for bookings with no route yet.

This is the "all criteria met" layout: **facts grid + journey timeline**.

## About the Design Files
The file in this bundle (`GoVehlo Booking Detail.dc.html`) is a **design reference created in HTML** — a prototype showing the intended look and behavior. It is **not production code to copy directly**. It renders through an internal "Design Component" runtime (`support.js`, the `<x-dc>` wrapper, `sc-if` control-flow tags, `{{ }}` bindings) that you should **not** reproduce.

Your task is to **recreate this design in the GoVehlo app's existing environment** (the app is a React PWA) using its established components, design tokens, and patterns. If a component from the GoVehlo design system already exists (Avatar, Card, Badge/StatusChip, Button, AmountDisplay, EmptyState, AppHeader), use it rather than rebuilding from these inline styles. If no equivalent exists, build it to match the values documented below.

Icons in the prototype use **Lucide** (the design system's chosen icon set) — use the same names in the app.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, and interactions. Recreate pixel-accurately using GoVehlo's existing libraries and tokens. The one exception is the map: this page currently has **no map** (see "Map / route visual" note) — the earlier map variant was dropped in favor of the timeline. If a map is wanted later, use a real static-map/tile provider, not a hand-drawn one.

## Screens / Views

### Booking detail (single screen, scrollable)
- **Purpose**: View a booking's who/when/where and planned route; open the route in maps; edit or cancel.
- **Container**: mobile screen, 390px design width. Vertical stack: fixed **header** (top) → scrollable **body** (middle) → fixed **action bar** (bottom). A transient **toast** overlays the bottom.
- **Screen background**: `#F7F9F8` (Warm White). Cards are `#FFFFFF` (Surface).

#### 1. Header (fixed)
- Background `#2D6A4F` (Forest). Padding `14px 20px 16px`. Flex row, space-between, vertically centered.
- Left: title **"Booking"** — Nunito 800, 21px, `#FFFFFF`, letter-spacing -0.01em.
- Right: two 34×34 circular buttons, `background: rgba(255,255,255,.14)`, white icons, gap 8px:
  - **Edit** — Lucide `pencil` (17px, stroke 2). Opens booking edit.
  - **Close** — Lucide `x` (20px, stroke 2). Dismisses the screen.

#### 2. Booker + status row (body)
- Flex row, gap 11px, vertically centered.
- **Avatar**: 46×46 circle, `background: #1A2E1F` (Deep Forest), initials in Nunito 800, 16px, white. Initials = first letters of name; for a single-word name use its first two letters (e.g. "Jonas" → "JO").
- **Middle** (flex:1): 
  - Line 1 = booking **purpose/title**: Nunito 800, 19px, `#1A2E1F`, line-height 1.15. (e.g. "Weekendtur")
  - Line 2: Inter 400, 13px, `#6B8F7A` — "`{bookerName}` bookede bilen" (e.g. "Jonas bookede bilen").
- **Status chip** (right): pill, padding `5px 11px`, radius 999px, with a 6px dot + label (Inter 600, 11.5px). Three states:
  - `aktiv` → label "Aktiv nu", bg `#D8F3DC`, dot `#52B788`, text `#1A2E1F`
  - `kommende` → label "Kommende", bg `#D8F3DC`, dot `#2D6A4F`, text `#1A2E1F`
  - `afsluttet` → label "Afsluttet", bg `#EDEFED`, dot `#8AA396`, text `#5B6B60`

#### 3. Facts grid (body)
- CSS grid, 2 columns, gap 10px. Four tiles.
- **Tile**: bg `#FFFFFF`, radius 14px, padding `13px 14px`, shadow `0 1px 3px rgba(26,46,31,.06)`.
  - Label: Inter 500, 11px, `#6B8F7A`, uppercase, letter-spacing 0.05em, margin-bottom 4px.
  - Value: Nunito 800, 17px, `#1A2E1F`.
- Tiles (in order): **Datoer** "6.–7. jul" · **Varighed** "2 dage" · **Distance** "187 km" · **Køretid** "2t 5m".
- When no route is planned, **Distance** and **Køretid** values show "—".

#### 4. Rejseplan (journey timeline) — shown when a route is planned (body)
- Card: bg `#FFFFFF`, radius 18px, padding `18px 18px 6px`, shadow `0 1px 3px rgba(26,46,31,.07), 0 6px 18px rgba(26,46,31,.05)`.
- Section header: **"REJSEPLAN"** — Nunito 700, 13px, `#6B8F7A`, uppercase, letter-spacing 0.07em, margin-bottom 18px.
- Vertical timeline: each stop is a flex row, gap 15px — a left **node column** (34×34 circular icon marker + a dashed connector line below it) and a **content column**.
  - **Connector line**: 2px wide, `repeating-linear-gradient(#C7DDD0 0 4px, transparent 4px 8px)`, vertical, min-height 30px, margin `4px 0`. Present under every node except the last.
  - **Node markers** (34×34 circle, centered icon):
    - Pickup — bg `#D8F3DC`, icon Lucide `circle-dot` (18px, `#2D6A4F`).
    - Fuel stop — bg `#FFFFFF`, `2px solid #E2EDE8` border, icon Lucide `fuel` (17px, `#2D6A4F`).
    - Drop-off — bg `#1A2E1F`, icon Lucide `flag` (16px, white).
  - **Content column** per stop:
    - Eyebrow: Inter 400, 11.5px, `#6B8F7A`, uppercase, letter-spacing 0.04em. ("Afhentning" / "Tankstop" / "Aflevering")
    - Main row: flex, space-between, `white-space: nowrap`, margin-top 2px:
      - Place: Nunito 700, 16px, `#1A2E1F` ("Aarhus" / "Circle K" / "Skagen")
      - Meta (monospace): Courier New, 700, 13.5px. Times are `#2D6A4F` ("man 09.00" / "tir 18.00"). **Fuel rate is `#E08A3C` (amber, money)**: "13,29 kr/L".
    - Leg distance (all but last stop): Inter 400, 11.5px, `#8AA396`, margin-top 8px, inline-block — "118 km ↓", "69 km ↓". With no fuel stop, the single leg reads "187 km ↓".
- **Two variants**:
  - With fuel stop: Pickup (Aarhus, man 09.00) → 118 km → Fuel (Circle K, 13,29 kr/L) → 69 km → Drop-off (Skagen, tir 18.00).
  - Without fuel stop: Pickup (Aarhus, man 09.00) → 187 km → Drop-off (Skagen, tir 18.00).

#### 5. Route empty state — shown when NO route is planned (body)
- Card (same surface/radius/shadow as timeline), centered column, padding `26px 16px 22px`.
- Icon badge: 56×56 circle, bg `#D8F3DC`, Lucide `map` (26px, `#2D6A4F`), margin-bottom 12px.
- Title: Nunito 700, 15.5px, `#1A2E1F` — "Ingen rute planlagt endnu".
- Body: Inter 400, 13px, line-height 1.5, `#6B8F7A`, max-width 240px — "Planlæg ruten, så gruppen kan se hvor bilen skal hen."
- CTA button (outline): margin-top 16px, bg white, `1.5px solid #2D6A4F`, radius 12px, padding `10px 20px`, Nunito 700, 14px, `#2D6A4F`, with Lucide `plus` (16px). Label "Planlæg rute".

#### 6. Action bar (fixed, bottom)
- bg `#F7F9F8`, top border `1px solid #E2EDE8`, padding `12px 16px 16px`, vertical stack.
- **Primary button** (52px tall, radius 14px, Nunito 700, 16px, white, bg `#2D6A4F`, shadow `0 2px 8px rgba(45,106,79,.28)`, centered icon+label):
  - Route planned → Lucide `navigation` + "Åbn rute i" (opens the route in a maps app).
  - No route → Lucide `plus` + "Planlæg rute".
- **Cancel** (42px tall, text button, no bg): Inter 600, 14px, color `#B4453A` — "Aflys booking".

#### 7. Toast (transient overlay)
- Absolutely positioned, centered horizontally, 96px from bottom. Auto-dismiss after ~2.6s.
- Pill: bg `#1A2E1F`, white text, padding `12px 18px`, radius 14px, shadow `0 12px 34px rgba(26,46,31,.4)`. Lucide `check-circle` (18px, `#52B788`) + message (Inter 500, 13.5px).
- Enter animation `gvToastIn` 0.28s spring `cubic-bezier(.34,1.56,.64,1)`.

## Interactions & Behavior
- **Edit** (header pencil): open the booking edit flow.
- **Close** (header x): dismiss/navigate back.
- **Åbn rute i** (primary, route planned): open the route in the device's maps app (e.g. hand off Aarhus→Skagen to Apple/Google Maps).
- **Planlæg rute** (primary or empty-state CTA, no route): open route-planning; in the prototype this flips the screen to the planned state and toasts "Rute tilføjet."
- **Aflys booking**: cancel the booking (should confirm before destructive action in production).
- **Toasts**: every discrete action shows a confirmation toast (per the design system's feedback decision tree — Toast for completed discrete actions).
- **Card entrance**: subtle `gvFadeIn` (8px rise + fade, 0.3s) staggered by ~40ms per section. Optional.
- **Scroll**: body scrolls between the fixed header and fixed action bar.

## State Management
- `bookingStatus`: `'aktiv' | 'kommende' | 'afsluttet'` — drives the status chip.
- `routePlanned`: boolean — timeline vs. empty state; also toggles Distance/Køretid values and the primary action.
- `showFuelStop`: boolean — 3-stop (with fuel) vs 2-stop timeline.
- `toast`: current toast message (string | null), auto-cleared on a timer.
- Booking data (from API): booker name + initials, purpose/title, dates, duration, from/to cities, drive distance & time, and the fuel stop (station name, rate in kr/L, km-in / per-leg distances).

## Design Tokens
Colors:
- `--color-deep-forest #1A2E1F` — avatar fill, headings, drop-off node, toast bg
- `--color-forest #2D6A4F` — header, primary button, icons, links
- `--color-leaf #52B788` — positive dot, toast check
- `--color-mist #D8F3DC` — chip/pill fills, pickup node, icon badges
- `--color-amber #F4A261` — money accent (rendered slightly darker `#E08A3C` for legible small text on light bg) — **money only** (the kr/L rate)
- `--color-warm-white #F7F9F8` — screen + action bar bg
- `--color-surface #FFFFFF` — cards
- Text: primary `#1A2E1F`, secondary/muted `#6B8F7A`, faint `#8AA396`, subtle `#5B6B60`
- Borders/lines: `#E2EDE8` (card border/divider), `#C7DDD0` (dashed connector), `#EDEFED` (afsluttet chip bg)
- Destructive text: `#B4453A`

Typography:
- **Nunito** (700/800) — titles, place names, values, buttons
- **Inter** (400/500/600) — body, labels, captions
- **Courier New** monospace — times and the fuel rate

Radii: 14px (small tiles/buttons), 16px, 18px (timeline card), 999px (pills), 50% (avatars/nodes).
Shadows: card `0 1px 3px rgba(26,46,31,.06–.07)` (+ optional `0 6px 18px rgba(26,46,31,.05)`); primary button `0 2px 8px rgba(45,106,79,.28)`; toast `0 12px 34px rgba(26,46,31,.4)`.
Motion: enter/spring `cubic-bezier(.34,1.56,.64,1)`; durations 220–340ms.

Number formatting (Danish): decimal comma ("13,29"), thousands period, currency "kr" after the number.

## Map / route visual
This version intentionally has **no map** — the route is communicated through the timeline. An earlier variant included a stylized map; it was dropped. If product wants a map back, use a real static-map image or tile SDK (Mapbox/Google/Apple), never a hand-drawn SVG.

## Assets
- **Icons**: Lucide — `pencil`, `x`, `circle-dot`, `fuel`, `flag`, `map`, `plus`, `navigation`, `check-circle`, `message-circle`. Use the codebase's existing Lucide integration.
- No raster images or logos are used on this screen.

## Files
- `GoVehlo Booking Detail.dc.html` — the hifi design reference (open in a browser to view; requires internet for the Lucide CDN and the bundled `_ds` design-system tokens when run standalone).
- `screenshots/booking-detail-full.png` — populated state (route + fuel stop planned).
- `screenshots/booking-detail-empty-route.png` — no route planned (empty state; Distance/Køretid show "—", primary action becomes "Planlæg rute").

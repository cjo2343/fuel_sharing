# Handoff: Settle screen — empty & zero-data states

## Overview
The **Settle** tab in the GoVehlo PWA previously rendered a poor experience when a group had no financial activity: it showed `0,00 kr/km` / `0,00 kr` stat cards, an unearned "Settled" success block, and a prominent **Close period & start fresh** button that a brand-new user has no data to act on.

This handoff covers a redesign of that tab for **two distinct zero-outstanding scenarios**, plus the unchanged **populated** state:

1. **New group** — no trips or fuel logged yet (nothing has ever happened).
2. **All settled** — activity happened this period and every balance is now square.

Primary intent for both: **reassure, don't nag**. There is no push-CTA in either empty state — the goal is to make the user feel the app is working and calm, not to demand an action.

## About the Design Files
The file in this bundle — `GoVehlo Prototype v2.dc.html` — is a **design reference created in HTML**, not production code to copy directly. It is an interactive prototype demonstrating intended look and behavior of the whole GoVehlo app; the Settle-tab changes described here are the relevant part.

The task is to **recreate these designs in the target codebase's existing environment** (the GoVehlo PWA — React/whatever the app uses) using its established components and patterns. GoVehlo already has a design system with `Button`, `Card`, `EmptyState`, `SummaryBand`, `Avatar`, `AmountDisplay`, etc. — **prefer those components** over re-implementing raw markup. The HTML here inlines styles only because the prototype tool requires it; production should use the design-system components and tokens.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy, and interactions are final. Recreate pixel-accurately using the codebase's existing GoVehlo design-system components and tokens (values below map 1:1 to the design-system tokens).

---

## The switcher (prototype-only — DO NOT ship)
At the top of the Settle tab the prototype has a **"Preview state"** segmented control (Populated / New group / All settled). This exists **only** so reviewers can flip between states. It is **not** part of the product — in the real app the state is derived from data:

- `hasActivity` = the group has ≥1 trip or fuel entry ever.
- `hasOutstanding` = any non-zero balance is owed in either direction for the current period.

State selection:
- `!hasActivity` → **New group** empty state
- `hasActivity && !hasOutstanding` → **All settled** state
- `hasActivity && hasOutstanding` → **Populated** state (existing settlement list)

Remove the switcher and its `settleDemo` state entirely on implementation.

---

## Screens / Views

### 1. New group (no activity yet)
**Purpose:** First-run reassurance + teach how settling works. No stat cards (they'd be zeros), **no Close-period button** (nothing to close).

**Layout:** Single column, 16px horizontal screen padding, content stacked with 16px vertical rhythm. Top-aligned (not centered).

**Components (top → bottom):**

1. **"Caught up" banner**
   - Container: full-width, background `--color-mist` `#D8F3DC`, border-radius **16px**, padding `14px 16px`. Flex row, `gap:12px`, vertically centered.
   - Leading icon: 40×40 circle, background `#FFFFFF`, containing a Lucide `check` (20px, stroke `--color-forest` `#2D6A4F`, stroke-width 2.5).
   - Title: "You're all caught up" — Nunito 700, 15px, `--color-deep-forest` `#1A2E1F`.
   - Subtitle: "Nothing to settle yet — here's how it'll work." — Inter 400, 12px, color `#3F6350`.

2. **"How GoVehlo settles up" card**
   - Container: background `#FFFFFF`, border-radius **16px**, `--shadow-card`, horizontal padding 16px.
   - Card title: "How GoVehlo settles up" — Nunito 800, 16px, `#1A2E1F`, padding `14px 0 6px`.
   - Three step rows, each separated by a `1px` top border `#EEF3F0`, padding `12px 0`, flex row `gap:13px`, top-aligned:
     - Number badge: 30×30 circle, background `#D8F3DC`, Nunito 800, 14px, `#2D6A4F`.
     - Step title: Nunito 700, 14px, `#1A2E1F`. Body: Inter 400, 13px, `#6B8F7A`, line-height 1.45.
     - **Step 1 — "Log your trips"** / "Everyone records the km they drive."
     - **Step 2 — "Log the fuel"** / "Whoever fills up records the kr they spent."
     - **Step 3 — "We split by distance"** / "Costs divide by how far each person drove — automatically."

3. **Worked-example strip**
   - Container: background `--color-warm-white` `#F7F9F8`, `1px` border `#E2EDE8`, border-radius **14px**, padding `13px 16px`, centered text, margin-top 12px.
   - Eyebrow: "For example" — Inter 600, 11px, uppercase, letter-spacing `.06em`, `#6B8F7A`.
   - Formula: mono (Courier New) 14px, 700 — `87 km × 2,47 kr/km = ` in `#1A2E1F`, then `214,89 kr` in `--color-amber` `#F4A261` (money = amber).

### 2. All settled (activity exists, everyone square)
**Purpose:** Celebrate + confirm the period, show useful recap numbers instead of zeros. Close-period is present but **demoted** to a quiet secondary link (there IS activity, so closing is legitimate — just not the hero action).

**Layout:** Single column, 16px screen padding. Recap band, then centered celebration hero, then demoted close-period link.

**Components (top → bottom):**

1. **Period recap band** (replaces the `0,00` stat cards with real values)
   - Container: background `--color-mist` `#D8F3DC`, border-radius **12px**, margin-top 12px, padding `10px 0`, flex row of 3 equal cells divided by `1px rgba(45,106,79,.15)` right-borders.
   - Each cell centered: label Inter 600, 10px, uppercase, `#6B8F7A`; value mono 14px, 600, `#1A2E1F`, margin-top 3px.
   - Cells: **Rate** `2,47 kr/km` · **Trips** `1.357 kr` · **Fuel** `1.358 kr`. (Wire to real period totals.)

2. **Celebration hero** (centered column, padding-top 40px, text-align center)
   - Icon disc: 96×96 circle, background `#D8F3DC`, containing a Lucide `check` (46px, stroke `#2D6A4F`, stroke-width 2.5). Entry animation: `popIn` (spring, see Motion).
   - Title: "You're all square" — Nunito 900, 24px, `#1A2E1F`, letter-spacing `-.02em`, margin-bottom 10px.
   - Body: "Everyone's paid up for June. Nice work — no requests waiting." — Inter 400, 14px, `#6B8F7A`, line-height 1.55, max-width 280px.
   - **Stacked avatar row** (overlapping): four 38×38 initials avatars, `2px` border `--color-warm-white` `#F7F9F8`, `-8px` horizontal overlap. Nunito 700, 13px, white text. Backgrounds are the group's deterministic avatar colors — here `LN #2D6A4F`, `ST #52B788`, `MA #6B8F7A`, `ES #1A2E1F`.
   - Caption: "4 people settled this period" — Inter 400, 12px, `#6B8F7A`.
   - Substitute "June" and the count with the actual period label and settled-member count.

3. **Demoted Close-period link**
   - A borderless full-width text button, margin-top 40px, padding 10px, flex-centered, `gap:7px`.
   - Lucide `archive` icon (15px, stroke `#6B8F7A`, stroke-width 2) + label "Close June & start fresh" — Inter 600, 13px, `#6B8F7A`.
   - Tap → confirm closing the period and starting fresh. (Prototype shows a toast "June closed. Fresh period started.")

### 3. Populated (unchanged — for reference)
Existing settlement list: recap band, "You owe" card (amber amount + Request button), "Owed to you" card with expandable Calculation disclosure and Mark-paid flow, and a muted "Settled" list. No changes in this handoff.

---

## Interactions & Behavior
- **State is data-derived** (see switcher note) — no manual toggle in production.
- **Mark-paid / Request** flows belong to the populated state (unchanged).
- **Close period** (all-settled only): secondary action, should open a confirmation before wiping the period. Never shown in the new-group state.
- **Entry animations:** each state's root uses a `tabIn` fade/slide-in (~0.3–0.35s ease). The all-settled check disc uses `popIn` (spring).
- No hover states required for touch; buttons use `-webkit-tap-highlight-color:transparent` and press feedback per design-system Button.

## State Management
Needed inputs for the Settle view:
- `hasActivity: boolean` — any trip/fuel ever logged for the group.
- `hasOutstanding: boolean` — any non-zero current-period balance.
- `periodLabel: string` (e.g. "June").
- `recap: { rate, tripsTotal, fuelTotal, distance }` — for the recap band.
- `settledMembers: Member[]` — for the avatar row + count.

Derived view = `!hasActivity ? 'new' : !hasOutstanding ? 'settled' : 'populated'`.

## Design Tokens
Colors (map to `var(--ds-color-*)`):
- `--color-deep-forest` `#1A2E1F` — headings, dark text
- `--color-forest` `#2D6A4F` — primary, icon strokes, active pill
- `--color-leaf` `#52B788` — positive/settled accents
- `--color-mist` `#D8F3DC` — tinted card / disc fills
- `--color-amber` `#F4A261` — **money only** (the example amount)
- `--color-warm-white` `#F7F9F8` — app background, avatar borders
- `--color-surface` `#FFFFFF` — card surfaces
- Muted text `#6B8F7A`; hairlines `#E2EDE8` / `#EEF3F0`; banner subtitle `#3F6350`

Typography:
- Nunito — 900 (display 24px), 800 (title 16px), 700 (heading 14–15px)
- Inter — 600 (labels/eyebrows), 500, 400 (body 12–14px)
- Courier New — mono 14px for figures (rate/amount)

Radius: cards **16px**, bands/strips **12–14px**, pills 9999px.
Shadow: `--shadow-card` = `0 1px 3px rgba(26,46,31,.07), 0 2px 8px rgba(26,46,31,.04)`.

Motion (from design system):
- Spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)` — `popIn`.
- Standard easing `cubic-bezier(0.4, 0, 0.2, 1)`.
- Durations: 80 / 140 / 220 / 340 ms.

## Assets
- **Screenshots** (in `screenshots/`): `new-group.png` (guided empty state) and `all-settled.png` (settled recap). Note the "Preview state" switcher visible at the top is the review-only affordance — not part of the product.
- Icons: **Lucide** (`check`, `archive`, `route`) — 2px stroke, already the app's icon set. No custom SVGs required.
- No images. Avatars are initials on solid brand fills (no photos).

## Files
- `GoVehlo Prototype v2.dc.html` — full app prototype. The Settle-tab logic lives in the `class Component extends DCLogic` script (`settleDemo` state, `showEmptyNew` / `showEmptySettled` / `showPopulated` flags, `onCloseJune`) and the `<!-- SETTLE -->` block in the template (search for `EMPTY: NEW GROUP` and `EMPTY: ALL SETTLED`).

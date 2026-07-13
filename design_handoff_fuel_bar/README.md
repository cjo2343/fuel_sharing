# Handoff: Log page — Fuel status bar redesign

## Overview
Redesign of the fuel-status element at the top of the GoVehlo **Log** screen (the trip/tank
logging page). The old element was a flat, thin progress bar with a floating red dot and a
`~0% · 0 L · ~0 km` readout — visually weak and, in its larger form, tall enough to push the
logging form below the fold.

The redesign replaces it with a **compact dial-gauge strip** (~66px tall) that stays resident
at the top of the Log page and can be **tapped to expand** into a full instrument-cluster gauge.
It leads with **range in km**, keeps %/liters as quiet support, and uses a proper needle gauge
instead of the floating dot.

**Chosen direction: `2b` — "Slim strip with mini-dial".** This is the spec below.

## About the design files
The files in this bundle are **design references created in HTML** (GoVehlo Design Component
prototypes). They show the intended look, states, and behavior — they are **not production code
to copy directly**. The task is to **recreate this design in the target codebase's existing
environment** (the GoVehlo PWA — React) using its established components, tokens, and patterns.
If a given primitive already exists in the app (Card, Badge, icon set), use it rather than
re-deriving from the HTML.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, gauge geometry, copy, and the
expand/collapse interaction are all specified. Recreate the UI pixel-accurately using the
codebase's existing libraries; map the raw hex values below onto the app's design tokens.

---

## Screens / Views

### View: Log — fuel status strip (collapsed, default)
- **Purpose:** Give the user an at-a-glance read of tank level + remaining range without leaving
  the trip-logging flow. Secondary context, not the hero of the screen.
- **Placement:** First element inside the Log page content area, directly under the forest-green
  `Log` header, above the `Tur / Tank` segmented toggle.
- **Container:** full content width. `background #FFFFFF`, `border-radius 14px`,
  `box-shadow: 0 1px 3px rgba(26,46,31,.07), 0 2px 8px rgba(26,46,31,.04)`.
  `padding: 9px 13px 9px 8px`. `display:flex; align-items:center; gap:9px`. Whole card is the tap
  target (`cursor:pointer`). Hover: raise shadow to
  `0 2px 5px rgba(26,46,31,.10), 0 6px 16px rgba(26,46,31,.07)`.
- **Children, left → right:**
  1. **Mini dial** — inline SVG, `50×31` (see *Dial geometry*). `flex-shrink:0`.
  2. **Readout block** (`flex:1; min-width:0`):
     - Label — `Inter 600 10px`, `letter-spacing .06em`, `text-transform:uppercase`,
       color `#6B8F7A`. Text: `Tank nu` (Tank tab) or `Tank efter turen` (Tur tab).
     - Value + stats **stacked in a column** (`display:flex; flex-direction:column; align-items:flex-start`):
       - **Range (km) — leads.** `Nunito 800 17px`, `letter-spacing -.01em`, `white-space:nowrap`.
         Color `#1A2E1F` normally, `#D95050` when low. e.g. `~770 km`.
       - **Stats — secondary.** `Courier New 11px`, color `#6B8F7A`, `white-space:nowrap`,
         `margin-top:1px`. e.g. `68% · 37 L`.
  3. **Status hint** — `Inter 11px`, right-aligned, `line-height 1.3`, `max-width ~82px`.
     Positive: weight `500`, color `#3D5C48`. Low: weight `500`, color `#C0392B`. Action variant
     (near-empty): weight `600`, color `#2D6A4F`, `white-space:nowrap`, e.g. `Log tankning ›`.
  4. **Chevron-down** (collapsed only) — Lucide `chevron-down`, `16px`, stroke `#C0CCC5`,
     `flex-shrink:0`.

### View: Log — fuel status (expanded, after tap)
Replaces the strip **in place** (same slot in the form flow).
- **Container:** `#FFFFFF`, `border-radius 16px`, same card shadow, `overflow:hidden`.
- **Top section:** `padding 13px 16px 12px`, `text-align:center`, `cursor:pointer` (tap to
  collapse). Collapse affordance: Lucide `chevron-up`, `16px`, stroke `#C0CCC5`, absolutely
  positioned `top:13px; right:14px`.
  - Label — `Inter 600 11px .08em` uppercase `#6B8F7A`.
  - **Range hero** — `Nunito 900 30px`, `letter-spacing -.02em`, `line-height 1`; unit `km` inline
    at `17px 800` color `#6B8F7A`. Color `#1A2E1F` normal / `#D95050` low.
  - Stats — `Courier New 12px` `#6B8F7A`, `margin-top 4px`.
  - **Wide dial** — inline SVG `152×94` (same geometry, thinner strokes; see below), centered.
  - **E / F scale row** — `width 132px`, `margin-top:-8px`, `display:flex; justify-content:space-between`;
    labels `Inter 700 10px` `#C0CCC5` (`E` left, `F` right).
- **Footer strip:** full width, `padding 11px 16px`, `display:flex; align-items:center;
  justify-content:center; gap:8px`. Positive: `background #EAF4EE`, icon Lucide `check` stroke
  `#52B788`, text `Inter 600 12.5px` `#3D5C48`. Low: `background #FDEDED`, icon Lucide `fuel`
  stroke `#D95050`, text `Inter 600 12.5px` `#C0392B`.

---

## Dial geometry (the gauge)
A 180° semicircular gauge, empty (left) → full (right), with a needle to the current level.

- **SVG viewBox:** `0 0 120 74`. **Center:** `(60, 60)`. **Track radius:** `46`.
- **Track arc (background):** `path d="M14 60 A46 46 0 0 1 106 60"`, `stroke #EAF0ED`, round caps.
- **Fill arc (level):** `path d="M14 60 A46 46 0 0 1 {tipX} {tipY}"` over the same top arc, round caps.
- **Needle:** `line` from `(60,60)` to a point on radius `40`. **Hub:** `circle r=5` fill `#1A2E1F`.
- **Stroke widths:** strip (50×31) → track/fill `11`, needle `4`. Expanded (152×94) → track/fill `9`,
  needle `3`.
- **Color rule:** level ≤ ~15% → fill **and** needle `#D95050`. Otherwise fill `#52B788`,
  needle `#1A2E1F`.

**Computing a level point** for fraction `f` (0=empty…1=full):
`θ = (180 − 180·f)°`, `x = 60 + r·cos θ`, `y = 60 − r·sin θ` (fill uses `r=46`, needle `r=40`).

Precomputed tips used in the mocks:

| Level | Fill tip (r46) | Needle tip (r40) |
|---|---|---|
| 6%  | 14.82, 51.38 | 20.71, 52.50 |
| 68% | 84.65, 21.16 | 81.43, 26.23 |
| 100%| 106, 60      | 100, 60      |
| ~2% (after-trip) | 14.09, 57.11 | 20.08, 57.49 |

**"Tank efter turen" (projected) extra:** draw a **dashed ghost needle** at the *current* level
behind the solid projected needle — `stroke #C6D3CC`, `stroke-width 4` (strip) / `2.5` (expanded),
`stroke-dasharray "4 4"`. In the mock the ghost is at 18% → tip `26.2, 38.61`.

---

## Interactions & behavior
- **Expand / collapse:** tapping the collapsed strip expands it; tapping the expanded card's
  header (chevron-up) collapses it. Single boolean state.
- **Recommended transition (not yet in mock):** animate max-height + opacity, `~220ms`, standard
  easing `cubic-bezier(0.4, 0, 0.2, 1)` (GoVehlo `--duration-normal` / standard easing tokens).
  The mock toggles instantly.
- **Tab coupling:**
  - `Tank` tab → label `Tank nu`, shows the **current** level.
  - `Tur` tab → label `Tank efter turen`, shows the **projected** level after the trip being
    logged (uses Slut-km − Start-km), with the dashed ghost needle for "now".
- **Low-tank state:** when level ≤ ~15%, gauge + range turn `#D95050`, status line becomes the
  warning copy, and (near-empty, current) an inline `Log tankning ›` action appears.
- **Touch target:** entire card is tappable; keep ≥ 44px effective height.

## State management
Inputs the component needs (from the trip/vehicle model):
- `tankSizeL` (e.g. 55) — from the car profile ("Bilen").
- `fuelNowL` (or `fuelNowPct`) — current tank reading.
- `consumptionLper100` (e.g. 4.8) — from the car profile.
- `tripDistanceKm` — `slutKm − startKm` for the projection (Tur tab).
- `expanded: boolean` — UI state.

Derived:
- `percent = fuelNowL / tankSizeL`
- `rangeKm = fuelNowL / consumptionLper100 * 100`
- `afterFuelL = max(0, fuelNowL − tripDistanceKm * consumptionLper100 / 100)`, then recompute
  `afterPercent` / `afterRangeKm`
- `isLow = percent ≤ 0.15`

## Number & copy formatting (Danish — GoVehlo voice)
- Decimal separator **comma**; thousands separator **period** → `1.145 km`, `4,8 L/100km`.
- Units: `km`, `L`, `%`. **No `kr`** — fuel is not money, so it must **never** use Amber.
- Sentence case, warm and short. Exact strings used:
  - Labels: `Tank nu`, `Tank efter turen`
  - Range: `~770 km` (hero) with `68% · 37 L` beneath
  - Healthy strip status: `Godt et par uger` · full: `Fyldt helt op`
  - Near-empty strip status/action: `Log tankning ›`
  - Projected strip status: `Tømmer næsten tanken`
  - Expanded healthy footer: `God for et par uger endnu · rækkevidde ~770 km`

## Design tokens
Map these onto the existing GoVehlo token set
(`_ds/govehlo-design-system-.../tokens/*.css`). Raw values used:

**Colors**
- `#1A2E1F` deep-forest — needle, primary text, normal range value
- `#2D6A4F` forest — header, `Log tankning` action, focused-field border
- `#52B788` leaf — gauge fill (healthy/full), check icon
- `#D95050` error — gauge fill + needle + range value when low (`--color-error`)
- `#C0392B` — low-state status text (darker error for contrast on white)
- `#EAF0ED` — gauge track
- `#EAF4EE` — expanded footer (positive) background
- `#FDEDED` — expanded footer (low) / icon-tile background (`--color-error-light`)
- `#C6D3CC` — dashed ghost needle
- `#6B8F7A` text-muted — labels, stats
- `#5B8A70` — section labels (`REGISTRER DISTANCE`, `DELES MELLEM`)
- `#3D5C48` text-secondary — positive status text
- `#C0CCC5` — chevrons, E/F scale labels
- `#9DB3A8` — km-delta (`300 km`)
- `#E2EDE8` border — input-field card borders
- `#F7F9F8` warm-white — app background · `#FFFFFF` surface — cards · `#D8F3DC` mist — toggle track

**Typography**
- Nunito — 800 (values), 900 (hero) — brand/headings
- Inter — 500 / 600 / 700 — labels, status, body
- Courier New — mono — %/L stats and km-field values

**Radii / shadow**
- Card radius: strip `14px`, expanded `16px` (brand spec is 16px; strip uses 14 for the slimmer element)
- Card shadow: `0 1px 3px rgba(26,46,31,.07), 0 2px 8px rgba(26,46,31,.04)`

## Assets / icons
No image assets. Icons are **Lucide** (2px stroke), matching the design system's CDN substitution:
`fuel`, `check`, `chevron-down`, `chevron-up`. Replace with the app's icon set if it has
equivalents.

## Files in this bundle
- **`GoVehlo Fuel Bar 2b.dc.html`** — the chosen design. Live/interactive: collapsed strip on the
  Log page, tap to expand, plus the full state gallery (near-empty · healthy · full · projected).
  **Implement from this file.**
- `GoVehlo Fuel Bar.dc.html` — the original exploration (four options: compact `2a`/`2b` and the
  taller gauges `1a`/`1b`, reframed as the expanded view). Reference only.
- `support.js` — GoVehlo Design Component runtime used to preview the HTML. **Not needed** in the
  target codebase.

> The `.dc.html` files reference the GoVehlo design-system bundle via relative `../_ds/...` paths;
> those tokens/fonts are the source of truth for the values above.

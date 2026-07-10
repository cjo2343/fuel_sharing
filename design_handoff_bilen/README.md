# Handoff: Car Profile ("Bilen")

## Overview
The **Bilen** ("The car") screen is GoVehlo's car-detail page, redesigned around a single idea: a Danish licence-plate (nummerplade) lookup can pre-fill most of a car's facts, but four things only the owner knows must still be completed. The redesign turns a flat detail page into a **guided profile** that clearly separates auto-filled data (**Fra registret** — "from the registry") from **needs-input** tasks (**Skal udfyldes** — "must be completed").

The four owner-supplied items are:
1. **Tankstørrelse** — fuel-tank size (not reliable in the registry)
2. **Forsikringsdetaljer** — insurance coverage, renewal, premium, deductible
3. **Ejerafgift som fast udgift** — turning the ownership tax into a recurring shared expense
4. **Tankstatus** — current fuel level + odometer reading (seeds the range/consumption estimate)

## About the Design Files
The file in this bundle (`GoVehlo Bilen.dc.html`) is a **design reference created in HTML** — a prototype that shows the intended look, content, and behaviour. It is **not production code to copy directly**. It is authored as a "Design Component" and depends on a proprietary runtime (`support.js`) and design-system stylesheets that will not be present in your codebase.

The task is to **recreate these designs in the GoVehlo app's existing environment** (its React/Vue/native stack) using its established components, tokens, and patterns — the GoVehlo design system already defines Button, Card, Input, Select, Badge, Avatar, Odometer, StatusChip, etc. Compose from those. If no environment exists yet, choose the most appropriate framework for the project and implement there.

## Fidelity
**High-fidelity (hifi).** Colours, typography, spacing, radii, and copy are final and should be matched pixel-for-pixel using the codebase's existing GoVehlo design-system primitives. All copy is Danish and is final — do not translate or paraphrase.

## Layout note — the HTML canvas vs. the actual screen
The HTML is a **presentation canvas** on a dark green background showing several 320px-wide phone mockups side by side. **Only the phone contents are the product.** The dark canvas, the section intro headings ("Two tracks…", "The four things you complete"), the B1/B2/S1–S4 badges, and the spec table at the bottom are documentation scaffolding — **do not build them**. Build:

- **The Bilen screen** in two states (after-lookup with tasks pending, and complete) — this is the chosen **split-tracks** design.
- **Four bottom sheets** that open from the task affordances.

An earlier explored direction ("Direction A — guided completion") exists in the source but is set `display:none` and is **archived/rejected — ignore it**. The chosen direction is **split tracks**.

---

## Screens / Views

### 1. Bilen — main screen (state: after lookup, tasks pending) · ref `B1`
**Purpose:** Immediately after a plate lookup, the owner reviews auto-filled data and sees exactly what they still need to do.

**Layout (top → bottom), inside a mobile screen:**
- **Status bar** — Forest green (`#2D6A4F`), 34px tall, time left ("9.41"), signal + battery glyphs right.
- **Header** — Forest green, title **"Bilen"** (Nunito 800, 22px, white) left, a close (×) icon right. 12px top / 16px bottom padding, 16px sides.
- **Body** — Warm-white (`#F7F9F8`) background, 16px padding, vertical stack with **18px gap** between sections.
  1. **Two-track band** — two equal cards side by side (10px gap). Left card "Fra registret" with a leaf checkmark + count "3 felter". Right card "Skal udfyldes" outlined in Forest (`1.5px solid #2D6A4F`) with a hollow-circle glyph + "4 mangler". Each: white, 14px radius, 13×14px padding, card shadow.
  2. **"Skal udfyldes af dig" card** — section title (Nunito 800, 16px), then a white 16px-radius card containing **4 task rows**, each a full-width button: 36×36px mist (`#D8F3DC`) icon tile (10px radius) + title (Nunito 700, 13.5px) + sub-line (Inter, 11.5px, `#6B8F7A`) + chevron-right. Rows separated by `1px solid #EEF3F0`.
     - Row copy: "Vælg tankstørrelse / Vi kan ikke slå den præcise størrelse op." · "Tilføj forsikringsdetaljer / Dækning, fornyelse, præmie, selvrisiko." · "Opret ejerafgift som fast udgift / 460 kr halvårligt fra registret." · "Angiv tankstatus / Benzin i tanken nu + km-tæller."
  3. **"Fra registret" group** — section title + small "Automatisk" badge (leaf check, `#E3F0E8` bg, `#2D6A4F` text). White card, rows: "Mærke/model → VW T-Roc", "Brændstof · forbrug → Benzin · 4,8", "Næste syn → 27. jan 2028", "Ejerafgift → 460 kr/halvår" (value in **amber mono**). Each row: 18px muted icon + label (`#6B8F7A`) + value (`#1A2E1F`, 600). Rows separated by `1px solid #EEF3F0`.
  4. **Muted incomplete card** — one white card listing not-yet-filled fields with italic muted-grey (`#C0CCC5`) values: "Tankstørrelse → Ikke angivet", "Tankstatus → Ikke angivet", "Forsikringsdetaljer → Kun navn". Calm, no shouting CTA per row (the CTAs live only in the task card at top).

### 2. Bilen — main screen (state: complete) · ref `B2`
**Purpose:** Every field filled; the profile reads calm and confirmed.

Same shell as B1. Differences:
- **Two-track band** — both cards now show a leaf checkmark: "Fra registret · 3 felter" and "Tilføjet af dig · 4 felter" (the right card loses its outline).
- **Bildetaljer card** — full readable list: Brændstoftype → Benzin, Forbrug → 4,8 L/100km, Tankstørrelse → 55 L, Årgang → 2020. "Rediger" link top-right.
- **Tankstatus card** — "Anslået niveau nu" 68% · 37 L, green progress bar at 68%, "Rækkevidde ~770 km", and a caption "Opdateret i dag ved 96.500 km" (km value in mono). "Opdater" link.
- **Forsikring card** — header row with shield tile, "Tryg Forsikring A/S / Kasko + ansvar", green "Aktiv" pill; then a 2×2 grid: Fornyelse 1. jan 2027, Præmie **485 kr/md** (amber mono), Selvrisiko **5.412 kr** (amber mono), Dækning Kasko. Uppercase 10px labels.
- **Ejerafgift card** — receipt tile + "460 kr halvårligt" (amber mono) + "Grøn ejerafgift · fra registret"; row "Næste betaling → 12. juli 2026"; a leaf-check confirmation line "Oprettet som fast udgift".

### 3. Edit sheet — Tankstørrelse · ref `S1`
Bottom sheet: 24px top radius, white, grab-handle (`38×4px #D9E4DE`). Title "Vælg tankstørrelse" (Nunito 800, 19px), helper "Find den i instruktionsbogen eller på tankdækslet. Vi bruger den til rækkevidde." Then a **3-column chip grid**: 45 L, 50 L, **55 L (selected)**, 60 L, 65 L, "Anden". Selected chip: `2px solid #2D6A4F`, `#EAF4EE` bg, text `#1A5138`, corner check. Unselected: `1.5px solid #E2EDE8`. Forest **"Gem"** button (full width, 48px, 13px radius) at bottom.

### 4. Edit sheet — Forsikringsdetaljer · ref `S2`
Title "Forsikringsdetaljer". A locked-context chip at top: `#F2F7F4` bg, shield icon, "Tryg Forsikring A/S · Aktiv" with "fra registret" tag — read-only. Then fields the user fills: **Dækning** (select, "Kasko + ansvar"), **Fornyelsesdato** (date field, "1. jan 2027"), and a two-column row **Præmie** ("485 kr/md") + **Selvrisiko** ("5.412 kr") — both money values in mono. Forest **"Gem detaljer"** button.

### 5. Edit sheet — Tankstatus · ref `S3`
Title "Angiv tankstatus", helper "Bilen har kørt siden sidste syn — fortæl os, hvor den står nu." A **fuel-level slider**: label "Benzin i tanken" + value "≈ 37 L · 68%", a 12px track (green fill to 68%, white 22px knob with leaf border), "Tom"/"Fuld" end labels. Then **"Kilometertæller nu"** input, Forest-outlined, value "96.500" in mono + "km" suffix. Forest **"Gem"** button.

### 6. Edit sheet — Ejerafgift → fast udgift · ref `S4`
Title "Opret som fast udgift", helper "Vi lægger ejerafgiften i budgettet, så den deles automatisk hver periode." An **amber-tinted amount card** (`#FEF7F0` bg, `#F6D9BC` border): "460 kr" (amber mono, 20px) + "Grøn ejerafgift · fra registret" (`#A0522D`). **Interval** segmented control: Månedligt / **Halvårligt (selected)** / Årligt. Row "Næste betaling → 12. juli 2026". **This is the one money-action button** — it uses the **amber** variant (`#F4A261` bg, Deep-Forest `#1A2E1F` text): "Opret fast udgift".

---

## Interactions & Behavior
- **Task rows (B1 "Skal udfyldes" card)** open the matching bottom sheet: Tankstørrelse→S1, Forsikring→S2, Ejerafgift→S4, Tankstatus→S3.
- **"Rediger" / "Opdater"** links on filled sections re-open the corresponding sheet pre-populated.
- **Bottom sheets** slide up from the bottom; use spring easing `cubic-bezier(0.34, 1.56, 0.64, 1)` for the enter, ~340ms. Grab-handle + tap-outside/swipe-down to dismiss.
- **Saving a sheet** dismisses it and updates the corresponding section on the Bilen screen; the two-track band counts update, and once all four tasks are done the screen transitions from the B1 state to the B2 (complete) state.
- **Buttons** — press = `scale(0.97)` spring; hover/press = darken bg ~10%. Amber save button (S4) only.
- **Cards** — resting card shadow; hover lift 1px + stronger shadow (desktop/hover-capable only).
- **Fuel slider (S3)** — dragging updates both the "≈ N L · N%" readout and, on the profile, the "Rækkevidde" estimate.

## State Management
Per-car profile object with two provenance groups:
- **`fromRegistry`** (read-only, editable-if-wrong): make/model, year, fuelType, consumption, nextInspection (`næste syn`), ownershipTax amount.
- **`ownerSupplied`** (the four tasks): `tankSize` (L), `insurance {coverage, renewalDate, premium, deductible}`, `ownershipTaxRecurring {interval, nextPayment, created:bool}`, `fuelStatus {levelPct, litersEstimate, odometerNow, updatedAt}`.
- **Derived:** `completedTaskCount` / total (drives the two-track band and the B1↔B2 state), fuel `range` estimate (from tankSize × levelPct × consumption), and running fuel level (each logged trip decrements from the last `fuelStatus` reading).
- A boolean `isComplete` = all four owner tasks done → renders the B2 layout and the "Alt er sat op" style confirmation.

**Why tankstatus is manual:** the car has been driven since the last inspection, so neither the registry nor the odometer-at-inspection reflects current fuel. The owner's one-time reading seeds the running estimate that each trip then decrements.

## Design Tokens
Colours (GoVehlo palette):
- `--color-deep-forest #1A2E1F` — headings, primary text on light
- `--color-forest #2D6A4F` — header, primary CTAs, links, action affordances, status bar
- `--color-leaf #52B788` — positive/complete (checks, progress fill)
- `--color-mist #D8F3DC` — icon tiles, avatar fills
- `--color-amber #F4A261` — **money only** (præmie, selvrisiko, ejerafgift amounts; the S4 button). Never for navigation/decoration.
- `--color-warm-white #F7F9F8` — screen background
- `--color-surface #FFFFFF` — cards
- Supporting greys used in the mock: `#6B8F7A` (muted label/subtext), `#C0CCC5` (disabled/"Ikke angivet"), `#EEF3F0` (row dividers), `#E2EDE8`/`#E3F0E8` (chip borders / badge bg), `#D1F5E3`+`#1A7A47` ("Aktiv" pill), `#EAF4EE`+`#1A5138` (selected chip), `#FEF7F0`+`#F6D9BC`+`#A0522D` (amber-tint amount card).

Typography:
- **Nunito** — brand/headings. Display 900/32px, Title 800/22px, Heading 700/17px. (Screen title 22/800; section titles 16/800; card titles 13.5–15/700.)
- **Inter** — body/labels. Body 400/15px, Label 500/13px, Caption 400/11px. (Sub-lines 11.5–12.5px `#6B8F7A`; uppercase field labels 10px 600.)
- **Mono (Courier New, 12–16px)** — all monetary amounts and odometer/km values.

Spacing & shape: 16px screen padding, 12–16px card padding, **16px** card radius (14px on the small two-track cards, 24px on bottom sheets, 10–13px on tiles/chips/buttons). Section gap 18px. Min touch target 44px.

Shadows: green-tinted (`rgba(26,46,31,…)`). Cards: `0 1px 3px rgba(26,46,31,.07), 0 2px 8px rgba(26,46,31,.04)`. Buttons carry a coloured glow (Forest `rgba(45,106,79,.28)`, amber `rgba(244,162,97,.32)`).

Motion: spring `cubic-bezier(0.34,1.56,0.64,1)` for interactive/enter; standard `cubic-bezier(0.4,0,0.2,1)` for colour/opacity. Durations 80/140/220/340ms.

## Assets
- **Icons:** Lucide (2px stroke) — the mock inlines equivalents: `fuel`, `shield`, `file-text`/receipt, `calendar`, `droplet`, `gauge`, `chevron-right`, `chevron-down`, `check`, `x`. Use the codebase's existing icon set (Lucide names above) rather than the inline SVGs here.
- **No photographic or brand imagery** is used on this screen.

## Files
- `GoVehlo Bilen.dc.html` — the design reference (canvas with B1, B2, S1–S4, plus a rejected Direction-A and a spec table). Build only the phone contents described above.
- `screenshots/01-overview.png` — the chosen split-tracks screen, B1 (left) + B2 (right), top.
- `screenshots/04-tracks-lower.png` — lower portions of B1 (Fra registret + muted incomplete) and B2 (Tankstatus + Forsikring).
- `screenshots/02-sheets.png` — edit sheets S1 (Tankstørrelse) + S2 (Forsikring), top.
- `screenshots/05-sheets-2.png` — edit sheets S3 (Tankstatus) + S4 (Ejerafgift).
- `screenshots/03-spec.png` — field-provenance spec table (documentation reference, not a screen to build).

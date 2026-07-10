# Handoff: GoVehlo — Hjem / Aktivitet / Bilprofil reframes

## Overview
Three independent reframes for the GoVehlo PWA (fuel-ledger / shared-car app for small Danish groups — DKK, MobilePay):

1. **Brief 01 — Hjem (Home):** collapse the Home screen's overlapping "what leads the screen" logic into **one explicit two-state model** with a defined handover.
2. **Brief 02 — Aktivitet:** fix the merged activity-feed's **sparse state** (1–~8 items), which currently pins content to the bottom of a blank screen and reads as broken.
3. **Brief 03 — Bilprofil:** an **information-architecture split** so the gear icon, its accessibility label, and the destination title finally agree.

Each brief is delivered as side-by-side option mockups plus an implementable decision/spec table.

## About the design files
The HTML in this bundle is a **design reference**, not production code. It is a single-page "options canvas" showing intended look and behaviour. **Recreate these screens in GoVehlo's existing environment** (React / React Native / whatever the app uses), following its established components, design tokens, and icon set. Pull exact values from this README; use the HTML to see the intended result.

Open **`GoVehlo Reframe Options (standalone).html`** in any browser — it is fully self-contained (fonts + styles inlined), no build step. It's a pan/zoom canvas: scroll/drag to move, pinch/ctrl-scroll to zoom. `GoVehlo Reframe Options.dc.html` is the editable source (a proprietary streaming-HTML format — don't run it directly).

Copy is in **Danish** to match the strings observed on device. The current shipping prototype is in English; align to whichever the team ships.

## Fidelity
**High-fidelity.** Final colours, typography, spacing, copy, and interaction intent. Layout dimensions in the mockups are shown at ~300px phone width (a scaled reference); use the design tokens below and the app's real device metrics, not the raw px in the canvas.

Reference options by badge: **1a 1b 1c 1d** (Brief 01), **2a 2b 2c** (Brief 02), **3a 3b 3c** (Brief 03).

---

## BRIEF 01 — Hjem: one state model

### The problem being fixed
Three overlapping gates (`leadWithGetStarted`, `showGetStarted`, `carConfigured`) decide the lead. In first-run this produces: **"Tilføj din bil" twice** (checklist step 1 + a separate dashed empty-state card), and an **"I er kvit" balance card** before any money can exist.

### Options
- **1a — Tjeklisten ejer skærmen (recommended default):** one `Kom godt i gang` checklist card owns every next-action. The remaining space is earned by a calm **"Sådan bliver benzin fair"** explainer (3 static points) — *not* a second CTA. No money card. Solo group row.
- **1b — Spotlight på ét trin:** only the current step is a full action card; steps 2–3 render as muted, non-interactive "Derefter" preview rows. Strongest single answer to "what now?", weaker at showing the whole path.
- **1c — Overgangen (the handover):** when the 3rd step completes, a one-time full-screen celebration ("I er klar!") fires, then the checklist is **gone forever** — no manual "Skjul".
- **1d — State B (running):** the mature dashboard, unchanged target, shown deduped: balance → car banner → group → Seneste ture → Mere. This is what A hands over to.

### State decision table (replaces the three flags — evaluate top-down, first match wins)
| State | Condition | Lead / owns screen | Money card |
|---|---|---|---|
| **A — setting up** | `!hasCar \|\| members <= 1 \|\| trips === 0` | `Kom godt i gang` checklist (single). Primary CTA = first incomplete step. | Hidden |
| **Handover** | 3rd step transitions `done → true` this session | One-time celebration, then falls through to B | Hidden |
| **B — running** | `hasCar && members >= 2 && trips >= 1` | Balance → car status → group → Seneste ture → Mere. Checklist gone forever. | Shown |

Per-step done: step 1 = `hasCar`; step 2 = `members >= 2`; step 3 = `trips >= 1`. Progress fill = `doneCount / 3`.

**Rules baked in (confirm with team):**
- Manual **"Skjul"** is removed in State A — the checklist is dismissed only by completion, so it can never linger.
- The dashed **"Tilføj din bil"** empty-state card is **deleted**; step 1 is the sole affordance.
- **"Se alle"** (Seneste ture) and **Mere → Historik** overlap — keep `Mere → Historik` as the canonical entry, drop the redundant "Se alle" link.

---

## BRIEF 02 — Aktivitet: the sparse feed

### The problem being fixed
The mature feed is chat-style **inverted** (newest at the bottom). Locked (GVM-83) and unchanged. At 1–~8 items the inverted list pins the items to the bottom of a blank screen — a large dead void above that reads as a rendering bug.

### Options
- **2c — Zero:** centered welcome hero ("Sig hej til hinanden" + what will appear here). Input stays reachable at the bottom.
- **2a — Sparse, header fills the void (recommended):** upright, **top-anchored** list. A slim `#D8F3DC` welcome header holds the top; the two events keep their normal card language under the "I dag" divider. No dead space.
- **2b — Sparse, chat-first warmth:** a GoVehlo intro bubble opens the thread and lonely system events adopt the chat rhythm (avatar + inline bubble), so two items read as a living conversation. The payment request keeps its amber action treatment.

### Capacity-state & flip spec (drive by measured height, never raw item count)
| State | Enter when | Layout | Scroll anchor |
|---|---|---|---|
| **Zero** | `items.length === 0` | Centered welcome hero + input | — (no scroll) |
| **Sparse** | `content.scrollHeight <= viewport.clientHeight` | Upright, welcome header on top, items grow downward | Top (`flex-start`) |
| **Full** | `content.scrollHeight > viewport.clientHeight` | Inverted, newest at bottom, older faded (unchanged) | Bottom (pinned) |

**The flip (no visible jump):** re-measure after mount and after every append (`ResizeObserver` on the content wrapper). Sparse is already top-anchored, so the newest item sits at the fold; when it first overflows, switch to bottom-pinned in the same frame and set `scrollTop = scrollHeight` — the last card doesn't move. Add ~24px hysteresis so a card sitting exactly at the threshold can't flicker between modes.

**Amber check:** the "Betaling anmodet" card uses the money-amber tint (`#FEF3E0` fill, `#F6D9BC` border) with a **forest** primary action button ("Betal 100,00 kr →") so it reads as *action available*, not *warning*, even when it's one of only two items.

---

## BRIEF 03 — Bilprofil: honest front door

### The problem being fixed
A **gear** icon, a11y label **"Indstillinger"**, opens a screen titled **"Bilprofil"** that leads with a car card. Icon / label / title disagree. "Log ud" hides under "car profile"; in a car-less workspace the gear opens the add-car empty state, so the settings entry disappears entirely.

### Options
- **3a — A, two destinations:** gear → pure **"Indstillinger"** (App: Notifikationer, Data & privatliv; Konto: MobilePay-nummer, Log ud, Slet konto). The car lives entirely at **"Bilen"**, reached from its Home banner. Cleanest mental model; one extra entry point.
- **3b — B, one honest hub:** keep one screen, retitle **"Indstillinger"**, demote the car to the first section ("Jeres bil"), then Afregning · Gruppe · Notifikationer · Konto · Log ud. Cheapest change; scope boundary stays implicit.
- **3c — C, scoped hub (recommended):** title **"Indstillinger"**, ledger switcher on top, then two labelled groups — **Denne bil** (Bilen · Afregning · Gruppe, workspace-scoped) and **Din konto** (Notifikationer · Konto & MobilePay · Log ud, account-scoped). The "Bilen" row deep-links to the full car profile.

### Front-door decision table (icon / label / title always agree)
| Entry | a11y label | Destination title | Contains |
|---|---|---|---|
| **Gear (header)** | "Indstillinger" | "Indstillinger" | Ledger switcher · Denne bil (Bilen · Afregning · Gruppe) · Din konto (Notifikationer · Konto · Log ud · Slet konto) |
| **Car banner (Home)** | "Åbn bilen" | "Bilen" | Car card · odometer (96.500 km) · stats (Ture 6 · Tankninger 5 · Brændstof 1.400,00 kr) · Bilen/Afregning/Gruppe sub-pages |
| **Car-less workspace** | gear: "Indstillinger" | "Indstillinger" (unchanged) | Gear still opens settings. "Denne bil" group collapses to a single **"Tilføj din bil"** row → add-car flow. Settings never disappear. |

**Scope rule:** workspace-scoped items (Afregning, Gruppe, the car) sit under the active ledger shown by the top switcher; account-scoped items (Notifikationer, Konto) are shared across ledgers. The ledger switcher stays reachable in every state, including car-less, for multi-workspace users.

**Out of scope:** the *content* of the sub-pages (Bilen, Notifikationer, Konto…) — this reframe is about the front door and grouping only.

---

## Design tokens (GoVehlo Design System)

**Colours**
| Token | Hex | Use |
|---|---|---|
| Deep Forest | `#1A2E1F` | headings, dark hero/celebration bg, "You" avatar |
| Forest | `#2D6A4F` | header, primary CTAs, active step ring, icon strokes, links |
| Leaf | `#52B788` | progress fill, presence dot, completed / recommended |
| Light leaf | `#7EE0AB` / `#7EC8A4` | on-dark accents, eyebrows |
| Mist | `#D8F3DC` | tinted cards, icon tiles, chips |
| Mist-2 | `#D1F5E3` | secondary tints |
| Amber | `#F4A261` | **money only** — amounts owed, requests, fuel totals |
| Amber tint / border | `#FEF3E0` / `#F6D9BC` | money-action card fill / border |
| Amber text-on-tint | `#A0522D` / `#B4610F` | money metadata / emphasis on amber |
| Warm White | `#F7F9F8` | app background |
| Surface | `#FFFFFF` | cards |
| Muted text | `#6B8F7A` · caption `#3D5C48` · hairline `#EEF3F0` · card border `#E2EDE8` · inactive ring `#C4D9CD` · placeholder `#C0CCC5` |
| Danger | `#C0392B` | "Slet konto" |

**Typography** — Nunito (700/800/900) for brand, headings, step titles, amounts; Inter (400/500/600) for body, labels, captions; Courier New for odometer / km / rate mono values. Sentence case throughout. Numbers: comma decimals, period thousands, "kr" after the number ("100,00 kr", "96.500 km").

**Spacing / radius / shadow** — 4px grid; screen padding 16px; stack gap 14px; cards radius 16px (12–15px on nested); buttons 12–14px; markers/avatars 50%. `--shadow-card` = `0 1px 3px rgba(26,46,31,.07), 0 2px 8px rgba(26,46,31,.04)`; primary button `0 4px 16px rgba(45,106,79,.28)`.

**Motion** — spring `cubic-bezier(0.34,1.56,0.64,1)` for press / celebration pop; standard `cubic-bezier(0.4,0,0.2,1)` for colour/opacity; durations 80/140/220/340ms. `tabIn` = fade + 6px rise (~.3s). Min touch target 44×44px.

## Assets
- **Icons:** Lucide (2px stroke) — `message-square`, `settings`(gear), `car`, `chevron-right/left`, `chevron-down`, `check`, `plus`, `zap`, `send`, `bell`, `shield`, `credit-card`, `log-out`(→ used for Log ud), `trash-2`, `users`, `divide`. Placeholders in the DS; use the codebase's icon set if it differs.
- **Avatars:** initials-based, deterministic colour (DS `Avatar`).
- No raster assets required.

## Files
- `GoVehlo Reframe Options (standalone).html` — self-contained, open in a browser to view all three briefs.
- `GoVehlo Reframe Options.dc.html` — editable design source (streaming-HTML format; don't run directly).
- `README.md` — this document (self-sufficient spec).
- `screenshots/` — reference renders of every brief:
  - `brief1-01-stateA-1a-1b.png`, `brief1-02-handover-1c-1d.png`, `brief1-03-decision-table.png`
  - `brief2-01-sparse-2c-2a.png`, `brief2-02-sparse-2b.png`, `brief2-03-flip-table.png`
  - `brief3-01-navigation-map.png`, `brief3-02-hub-3a-3b.png`, `brief3-03-hub-3c.png`, `brief3-04-decision-table.png`

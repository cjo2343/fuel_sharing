# GoVehlo landing — welcome intro + scroll motion (handoff)

Prototype: `GoVehlo Landing v2.dc.html` (options 1a / 1b, replay buttons, DA/EN toggle).
Target repo: `cjo2343/govehlo-web` — `index.html`, `landing.css`, `landing.js`. No new dependencies; everything below is CSS keyframes + the existing rAF loop in `landing.js` + one IntersectionObserver.

## Option 1a — "Staged arrival" (content leads) — NOT CHOSEN, reference only

Hero elements are hidden by `animation: … both` and rise in sequence (24px rise + fade). Road draws in behind the content; stats count up.

| t (ms) | What | Spec |
|---|---|---|
| 50 | Eyebrow | `gvRise` 500ms, standard ease `cubic-bezier(.4,0,.2,1)` |
| 160 / 270 | H1 line 1 / line 2 | `gvRise` 600ms, mild overshoot `cubic-bezier(.33,1.3,.62,1)` — wrap each line in a `span` (affects `hero.title` i18n key: split into `hero.t1` / `hero.t2`) |
| 400 | Description | `gvRise` 550ms standard |
| 550 | Buttons row | `gvPop` 500ms spring `cubic-bezier(.34,1.56,.64,1)` |
| 720 | Stats row | `gvRise` 550ms standard |
| 850 | Stat count-up | rAF, 900ms easeOutCubic; `5` (0 dec), `2,47` (2 dec, comma), the `0` does not count |
| 350–1300 | Road draw-in | `strokeDasharray = strokeDashoffset = path.getTotalLength()`, tween offset → 0, easeOutCubic; then clear dasharray |
| 1250 | Dashed centreline | opacity 0 → 1, 600ms ease |
| 1350 | Amber dot | starts the existing ambient cruise from `t=0` (enters from the left edge naturally) |

## Option 1b — "Drive-in" (road leads) — ✅ CHOSEN, implement this one

Road first, then the car arrives and content follows it in with spring easing.

| t (ms) | What | Spec |
|---|---|---|
| 100–950 | Road draw-in | as above |
| 900 | Centreline fade | as above |
| 950–2850 | Dot drive-in | progress −0.03 → 0.55 over 1900ms, easeInOutCubic; then hand off to the ambient loop (`startTime = now − invEase(0.55) × 10000` so velocity is continuous) |
| 1000 | Eyebrow | `gvRise` 550ms spring `cubic-bezier(.34,1.4,.64,1)` |
| 1200 / 1340 | H1 lines | `gvRise` 650ms spring |
| 1520 | Description | `gvRise` 600ms spring |
| 1740 | Buttons | `gvPop` 550ms spring `cubic-bezier(.34,1.56,.64,1)` |
| 2000 | Stats row | `gvRise` 600ms; count-up at 2150 |

## Keyframes

```css
@keyframes gvRise { from { opacity:0; transform:translateY(24px) } to { opacity:1; transform:none } }
@keyframes gvPop  { 0% { opacity:0; transform:scale(.92) } 60% { opacity:1; transform:scale(1.02) } 100% { opacity:1; transform:scale(1) } }
```

Use `animation-fill-mode: both` so elements sit in their `from` state during the delay. Because the hidden state comes from the animation itself, a global reduced-motion kill switch degrades to fully visible content:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration:.01ms !important; animation-delay:0ms !important; transition-duration:.01ms !important }
}
```
In JS (road draw, dot intro, count-ups): check `matchMedia('(prefers-reduced-motion: reduce)')` and jump to end states.

## Scroll reveals (both options, below the fold)

One IntersectionObserver, threshold 0.18, unobserve after firing.

- Feature section header + cards: hide via JS at init (`opacity:0; translateY(20px)`), reveal with 600ms standard-ease transition; cards stagger `transition-delay` 0/70/140/210ms. Hiding in JS (not CSS) keeps a no-JS page fully visible.
- How-it-works: steps stagger 0/90/180ms; the steps road **draws itself** when the section enters (same dashoffset technique, 1000ms), dashes fade in 500ms later.
- CTA + coming-soon blocks: single reveal each.

## Design fixes included (production bugs)

1. `cta-btn` is Forest-on-Forest in `landing.css` (invisible button surface). Fixed: white bg, Forest text, hover → Mist.
2. Amber "Get started" nav CTA from the older prototype stays Forest — amber is money-only.

## i18n note

Splitting the H1 into two spans replaces the `hero.title` key with `hero.t1`/`hero.t2` in the EN dictionary in `landing.js`. All other keys unchanged; the toggle/`localStorage` mechanism is untouched.

## Play-once

Play the intro once per session (`sessionStorage.govehlo-intro-played`); back-navigation should land on the finished state — same policy as the app's WelcomeScreen `hasPlayed` flag.

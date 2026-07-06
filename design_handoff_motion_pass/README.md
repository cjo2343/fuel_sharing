# Handoff: GoVehlo motion pass — landing welcome intro + mobile motion polish

## Overview

A design/animation optimization pass across both GoVehlo repos:

1. **`cjo2343/govehlo-web`** — a choreographed welcome intro for the landing page hero (two options), scroll-triggered section reveals, and two small production design fixes.
2. **`cjo2343/govehlo-mobile`** — eight motion moments that upgrade currently-flat interactions, extending the existing GVM-129 motion pack.

## About the design files

The two `.dc.html` files in this bundle are **design references created in HTML** — interactive prototypes showing intended look, timing, and behavior. They are **not production code to copy**. The task is to recreate the specified motion in each target codebase's existing environment:

- **govehlo-web**: vanilla HTML/CSS/JS (`index.html`, `landing.css`, `landing.js`) — the specs map 1:1 onto that stack (CSS keyframes, the existing rAF loop, one IntersectionObserver). No new dependencies.
- **govehlo-mobile**: React Native / Expo — implement with the built-in `Animated` API only, reusing `springIn`, `easings`, `timings`, `tweenValue`, and `useReducedMotion` from `src/lib/motion.ts`. No reanimated, no lottie.

Note: the `.dc.html` prototypes reference project-local stylesheets/scripts and may not render standalone outside the design project. They are included for code reference (exact inline styles, keyframes, timing values); the specs below are the authoritative documents.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, and copy match the GoVehlo design system and the production Danish copy exactly. Timings and easings in the specs are final intent (tune ±10% by feel on device).

## Specs

- **`landing-motion-spec.md`** — full timeline tables for intro options 1a (Staged arrival) and 1b (Drive-in), keyframes, road draw-in technique, scroll reveals, reduced-motion strategy, play-once policy, and the i18n key change (`hero.title` → `hero.t1`/`hero.t2`).
- **`mobile-motion-spec.md`** — eight moments:
  - 1a Home arrival (skeleton → cascade + balance count-up; replaces the full-screen Spinner)
  - 1b Mark as paid (check draw + chip pop + toast)
  - 1c Branded pull-to-refresh (road-and-dot)
  - 1d Request payment (press → spinner → blue "Anmodet" chip with one-shot pulse)
  - 2a Log live cost preview (spring-in card, roll-forward toast copy)
  - 2b Insights arrival (tile cascade + count-ups)
  - 2c Offline sync reconciliation (banner collapse, Afventer → Sender… → Synkroniseret chip)
  - 2d Sub-tab sliding pill indicator + tabIn content

**Decision: ship option 1b (Drive-in).** Option 1a in the spec/prototype is kept for reference only — do not implement it.

## Design tokens used

| Token | Value | Use |
|---|---|---|
| deep-forest | `#1A2E1F` | hero/nav/footer bg, headings, dark toast |
| forest | `#2D6A4F` | CTAs, headers, links |
| leaf | `#52B788` | positive amounts, stats, success |
| mist | `#D8F3DC` | tinted cards, cost preview, road stroke |
| amber | `#F4A261` | money only — amounts owed, hero dot, fuel totals |
| warm-white | `#F7F9F8` | screen bg |
| blue / blue-soft | `#355d9c` / `#e9f0fb` | "Anmodet" status only |
| disabled bg/border/text | `#F1F3F2` / `#DDE3E0` / `#7A8983` | pending chip, disabled button |

Easings: spring `cubic-bezier(.34,1.56,.64,1)` · mild spring `cubic-bezier(.34,1.3,.64,1)` / `(.33,1.3,.62,1)` · standard `cubic-bezier(.4,0,.2,1)` · numeric tweens easeOutCubic.
Durations: instant 80 / fast 140 / normal 220 / slow 340 ms (plus per-moment timelines in the specs).
Type: Nunito 700/800/900 (display), Inter 400/500/600 (body), Courier New (odometer/rates). Currency `52 kr`, decimal comma, thousands period.

**Amber rule:** amber is money-only — never navigation, decoration, or status. Blue is the requested-payment status only.

## Accessibility

- Every animation gates on reduced motion (`prefers-reduced-motion` on web, `useReducedMotion()` on mobile) and snaps to the end state.
- Web hero content is hidden by `animation-fill-mode: both` only, so a no-JS or reduced-motion page is fully visible; scroll-reveal hiding happens in JS, not CSS.
- Never loop decorative animations on content screens; the "Anmodet" pulse is one-shot.

## Production fixes included (web)

1. `landing.css` `.cta-btn` is Forest-on-Forest (invisible surface) → white bg, Forest text, hover Mist.
2. Nav "Kom i gang" CTA must stay Forest, not amber (amber is money-only).

## Files

- `landing-motion-spec.md` — landing intro + scroll motion spec (authoritative)
- `mobile-motion-spec.md` — mobile motion pack spec (authoritative)
- `GoVehlo Landing v2.dc.html` — landing prototype, options 1a/1b (reference)
- `GoVehlo Mobile Motion.dc.html` — mobile moments 1a–1d, 2a–2d (reference)

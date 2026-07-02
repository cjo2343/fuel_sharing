# Handoff: GoVehlo Prototype v2 — Motion & Animations

> Covers the welcome launch animation **and** the in-app motion added across Settle, Pay, Activity, and Car profile. The welcome animation is documented first (below); app-wide motion is in the **"Motion across the app"** section near the end.

## Overview

The first screen a new user sees when opening GoVehlo. A Forest-green splash with the GoVehlo wordmark, tagline ("Fill up. Drive fair."), a "Get started" CTA, and a **play-once launch animation** built around the brand icon: a car drives out along the winding road, picks up the crew, drives back, and everyone hops out and walks away — then the branding settles in.

## About the Design Files

`GoVehlo Prototype v2.dc.html` is a design reference created in HTML — an interactive prototype showing intended look and behavior. It is **not** production code. Recreate this screen in the GoVehlo codebase (Next.js + Supabase PWA) using its established components and the GoVehlo design tokens. The animation is the focus of this handoff.

To see it: open the prototype — it lands on the welcome screen (onboarding step 0) and the animation plays automatically once.

## Fidelity

**High-fidelity.** Final colors, typography, layout, and motion timing. The animation timings below are exact and tuned — match them.

---

## Screen Layout

- **Background:** full-screen Forest green (`#2D6A4F`)
- **Vertical composition, centered:** animation stage → wordmark → tagline → (spacer) → "Get started" button → micro-tagline
- **Padding:** `40px 32px 48px`

| Element | Spec |
|---|---|
| Animation stage | 264×170px card, `border-radius: 28px`, background Deep Forest (`#1A2E1F`), `box-shadow: 0 14px 44px rgba(0,0,0,.38)`, `overflow: hidden`. Fades in over 0.45s. |
| Wordmark "GoVehlo" | Nunito 900, 38px, white, `letter-spacing: -.02em` |
| Tagline "Fill up. Drive fair." | Inter 400, 17px, `rgba(255,255,255,.7)` |
| "Get started" button | Full-width, 54px tall, Amber (`#F4A261`) bg, `border-radius: 16px`, Nunito 700, 18px, Deep Forest text, `box-shadow: 0 4px 20px rgba(244,162,97,.45)` |
| Micro-tagline "No spreadsheets. Just fair miles." | Inter 400, 12px, `rgba(255,255,255,.35)` |

---

## The Animation

Plays **once** on mount. Total runtime ~6.5s. Everything lives inside a single inline SVG (`viewBox="0 0 280 170"`) in the stage card. The motion is implemented with **SVG SMIL** (`<animate>`, `<animateMotion>`, `<animateTransform>`) so the car can follow the exact curved road path; the wordmark/tagline/button entrances are plain CSS keyframes with delays.

### The scene elements

- **Road** — a winding S-curve path, the brand's signature shape:
  `d="M22 70 C80 20 118 22 140 76 C162 130 204 134 258 98"`
  - Solid stroke: Mist (`#D8F3DC`), `stroke-width: 26`, round caps — this is the "road."
  - Dashed centerline overlay: `rgba(255,255,255,.45)`, `stroke-width: 3.5`, `stroke-dasharray: "1 17"` — the lane dots.
  - Path start ≈ (22, 70) [top-left]; path end ≈ (258, 98) [bottom-right].
- **Car** — amber rounded body (`#F4A261`, 38×15, radius 7) + dark window slot + two Deep Forest wheels + a shadow ellipse. Carries avatar heads (see riders).
- **Avatars** — small initials circles with white stroke. Brand colors: CJ = Forest (`#2D6A4F`), LN = Leaf (`#52B788`), SA = light leaf (`#7EC8A4`). White Nunito 800 initials.
- **Walkers** — 3 little figures (head circle + capsule body) in the same three colors.

### Timeline (all times from animation start)

| Time | Event | How |
|---|---|---|
| 0.15–1.05s | **Road draws itself in** | `stroke-dashoffset` 100→0 on the solid road (`pathLength="100"`), spline ease |
| 0.5s, 0.66s | **LN then SA pop in** at the road's end (the waiting crew) | scale 0→1.15→1 with spring keySplines, staggered |
| 0.85–2.6s | **Car drives out** — start → end of road, carrying driver CJ | `<animateMotion>` following the road path, spline ease; car opacity 0→1 at 0.86s |
| 2.55s, 2.7s | **LN & SA hop into the car** — waiting avatars shrink + fade (absorbed) | scale→0 + opacity→0 |
| 2.7s, 2.85s | **LN & SA appear aboard** the car (now full: CJ + LN + SA) | in-car passenger avatars opacity 0→1 |
| 3.15–4.75s | **Full car drives back** — end → start of road | second `<animateMotion>` with `keyPoints="1;0"` (reverse), spline ease |
| 4.85s | **Car parks & fades** at the start | car group opacity 1→0 |
| 4.8–6.2s | **Everyone gets out & walks away** — 3 walkers emerge at the start and stroll down-left off the card, fading | per-walker `<animateTransform type="translate">` (e.g. `0 0` → `-34 40`) + opacity `0;1;1;0`, staggered begins 4.8 / 4.95 / 5.1s |
| 5.4s | Wordmark "GoVehlo" rises in | CSS `slideUp .5s ease-out 5.4s both` |
| 5.6s | Tagline rises in | CSS `slideUp .5s ease-out 5.6s both` |
| 5.8s | "Get started" springs in | CSS `popIn .5s cubic-bezier(.34,1.56,.64,1) 5.8s both` |
| 6.1s | Micro-tagline fades in | CSS `fadeIn .5s ease 6.1s both` |

### CSS keyframes used for the text/button entrances
```css
@keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes fadeIn  { from { opacity: 0; } to { opacity: 1; } }
@keyframes popIn   { 0% { transform: scale(.94); opacity: 0; } 60% { transform: scale(1.02); } 100% { transform: scale(1); opacity: 1; } }
```

---

## Implementation Notes for Claude Code

- **The exact SVG + SMIL markup is in the prototype** — search `GoVehlo Prototype v2.dc.html` for `<!-- Animated stage:` (onboarding step 0). Lift the SVG wholesale; it is self-contained and framework-agnostic.
- **SMIL `<mpath>` requires `xlink:href`** (not just `href`) to resolve reliably across browsers — the prototype sets both, and the `<svg>` declares `xmlns:xlink`. Keep both.
- **`fill="freeze"`** on each animation is what makes it play once and hold its end state (no loop). Do not add `repeatCount`.
- **The car follows the road via `<animateMotion><mpath href="#gvRoad"/></animateMotion>`.** The return trip is a second `<animateMotion>` on the same group with `keyPoints="1;0" keyTimes="0;1"` to traverse the path in reverse.
- **Motion easing:** spline `cubic-bezier(0.45, 0, 0.2, 1)` for the drives; spring `cubic-bezier(0.34, 1.56, 0.64, 1)` for the avatar pops and the button — these map to the design system's motion tokens (standard + spring).
- **Reduced motion:** please gate the animation behind `@media (prefers-reduced-motion: reduce)` — for those users, skip straight to the static end state (icon shown, wordmark/tagline/button visible, no motion). Not built in the prototype; add it in production.
- **Play-once scope:** the animation should run on first paint of the welcome screen. If the user navigates back to it within a session, replaying is optional — product call.
- **If SMIL is undesirable** in the target stack (it's deprecated-but-supported), the same result can be rebuilt with the Web Animations API or GSAP driving `offset-path`/`motion-path` for the car and transforms for the rest. The path data and timeline above are the source of truth either way.

---

## Design Tokens

| Token | Value | Use here |
|---|---|---|
| Forest | `#2D6A4F` | Screen background; CJ avatar; walker |
| Deep Forest | `#1A2E1F` | Stage card bg; wheels; button text |
| Mist | `#D8F3DC` | Road (solid stroke) |
| Leaf | `#52B788` | LN avatar; walker |
| Light leaf | `#7EC8A4` | SA avatar; walker |
| Amber | `#F4A261` | Car body; "Get started" button (money/primary gateway) |
| White | `#FFFFFF` | Wordmark, avatar initials + strokes |

**Typography:** Nunito (wordmark 900, avatar initials 800), Inter (tagline/micro-tagline 400)

**Note on the emoji:** the prototype deliberately does **not** use the fuel-pump emoji from earlier mockups — the design system forbids emoji in UI, and the brand icon (winding road + amber car) is the correct asset. The animation is that icon brought to life.

---

## Motion across the app

Beyond the welcome splash, the prototype adds purposeful motion to the moments that matter. All of it uses the design system's motion tokens: **spring** `cubic-bezier(0.34, 1.56, 0.64, 1)` for arrivals/confirmations, **standard** `cubic-bezier(0.4, 0, 0.2, 1)` (ease) for fades/transitions. Shared keyframes live in the `<helmet>` block: `slideUp`, `fadeIn`, `popIn`, `toastIn`, `tabIn`, `pulseAmber`.

### 1. Settlement confirmed (Settle tab → "Owed to you" card)
The signature moment — money made un-awkward. Tapping **Mark paid** on Sara's card:
- **Counts the amount down** from `120,50` → `0,00` over ~0.8s using an `easeOutCubic` tween driven by `requestAnimationFrame` in the logic class (`onMarkSaraPaid`), updating a `saraAmount` state value each frame. The amount uses `font-variant-numeric: tabular-nums` so digits don't jitter.
- On completion, a **Leaf check springs in** (`popIn`, spring easing) where the button was, and the label flips to "Settled with Sara".
- **Implementation:** the amount is bound to `{{ saraAmountText }}` (state-driven); the button/check swap via `saraSettled` / `saraNotSettled` flags. In production, drive the count-down from the real settled amount and fire it when the payment is confirmed.

### 2. Calculation reveal (Settle tab → "Calculation" disclosure)
Tapping **Calculation** expands the breakdown; the explanation line and each row (distance share → fuel share → already paid → **still owes**) **slide up in sequence** — `slideUp` with staggered `animation-delay` (0, .05s, .1s, .15s, .24s). The divider fades in at .2s. This turns a table of numbers into a step-by-step story so the split feels auditable, not arbitrary. Rows mount on expand (conditional render), so the CSS animation runs each time it opens.

### 3. Payment requested (Settle tab → "You owe" card)
Tapping **Request** swaps the button for a **"Requested" chip that springs in** (`popIn`, spring easing) — the state-machine transition reads as intentional rather than a hard cut.

### 4. Activity feed (Activity tab)
- The whole feed **cross-fades in** on tab open (`tabIn`).
- The **payment-request card pulses amber** twice on entry (`pulseAmber`, an expanding `box-shadow` ring) to draw the eye to the one item that needs action — money, so amber, per the system's amber-for-money rule.

### 5. Odometer roll (Car profile)
When the car profile opens (or a car is first added), the **odometer rolls up** to `45.571 km` — an `easeOutCubic` `requestAnimationFrame` tween (`_rollOdo` in the logic class) formatted with `toLocaleString('da-DK')` for the Danish `45.571` grouping. Triggered from `componentDidUpdate` (on entering the profile tab) and from `onAddCar`. Mirrors the design system's dark **Odometer** instrument component — in production, roll from the previous reading to the new one after a trip is logged.

### 6. Toast (global)
Every action toast **springs up** from the bottom (`toastIn` — translateY + slight scale, spring easing), then auto-dismisses. Confirmation feedback should always feel like it "pops" in.

### 7. Tab transitions (global)
Switching bottom-nav tabs **cross-fades the content** (`tabIn` — a 6px rise + fade over 0.3s), applied to each tab's content root so it re-runs on mount.

### Reduced motion
None of the app-wide motion is gated yet. In production, wrap it in `@media (prefers-reduced-motion: reduce)` and fall back to the static end state (final amounts, no count-downs/rolls, instant tab swaps) — same as the welcome animation.

---

## Files

- `GoVehlo Prototype v2.dc.html` — full interactive prototype. Welcome animation = onboarding step 0 (plays on load). App motion: Settle tab (mark paid, calculation, request), Activity tab (feed + pulse), Car profile (odometer), and every toast.

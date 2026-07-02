# GoVehlo Design System

GoVehlo is a fuel ledger and car-sharing companion for small groups of friends in Denmark. It tracks trips by odometer, splits fuel costs proportionally by km driven, and makes settlement requests clear and frictionless.

**Platform:** Progressive Web App (iOS + Android home-screen install)  
**Market:** Denmark (DKK, MobilePay)  
**Tagline:** Fill up. Drive fair.

---

## Sources

All materials provided June 2026:

- `uploads/govehlo-brand-guidelines.docx` — Brand Guidelines v1.0 (9 sections; **authoritative source**)
- `uploads/govehlo-design-handoff.md` — Engineering design handoff (use brand guidelines when values conflict)
- `uploads/govehlo-icon.svg` — Master icon SVG (editable source)
- `uploads/icon-192.png`, `uploads/icon-512.png` — PWA manifest icons
- `uploads/icon-preview-a6.png` — Icon preview image

No Figma designs or GitHub codebase were provided at the time of authoring.

---

## Content Fundamentals

GoVehlo speaks like **a trustworthy friend who is good at maths** — warm and direct, never corporate. Money conversations are only awkward when they are vague; GoVehlo removes the vagueness.

### Voice
- **Person:** Second person "you" + first-name personalisation. "You owe Lars" not "Outstanding balance: DKK 52.00"
- **Casing:** Sentence case for all UI copy. "Book car" not "Book Car". Brand name always "GoVehlo" (capital G and V only)
- **Tone:** Friendly and encouraging. Celebrate settlements. Acknowledge contributions. Never clinical.
- **Length:** Short. Danish users scan. One idea per label.

### Numbers & Currency
- Decimal separator: **comma** — "52,00 kr" not "52.00 kr"
- Thousands separator: **period** — "1.234 km" not "1,234 km"
- Currency: always **"kr"** after the number — "52 kr" not "DKK 52" not "kr 52"

### Approved Taglines
- **Fill up. Drive fair.** — primary, use for App Store and onboarding
- No spreadsheets. Just fair miles.
- The car is shared. The math isn't.
- Your car. Your crew. Fair costs.

### Do / Don't
| ✓ Do | ✗ Don't |
|---|---|
| "You owe Lars 52 kr." | "Outstanding balance: DKK 52.00" |
| "Good morning, Christian." | "Hello, User #4." |
| "87 km × 2,47 kr/km = 214,89 kr" | "Calculated automatically." |
| "Mark as paid." | "Confirm payment receipt acknowledgment." |
| "Sara requested 52 kr. Tap to view." | "You have received a payment request notification." |

### Emoji
No emoji in UI copy. The app icon is a visual brand asset, not a UI element.

---

## Visual Foundations

### Colour System
Green palette rooted in nature — warm, not clinical. Amber is the sole accent, reserved exclusively for monetary context.

| Token | Value | Use |
|---|---|---|
| `--color-deep-forest` | `#1A2E1F` | Headings, heavy text on light backgrounds |
| `--color-forest` | `#2D6A4F` | Primary — CTAs, logo, header, links |
| `--color-leaf` | `#52B788` | Positive states — paid, settled, confirmed |
| `--color-mist` | `#D8F3DC` | Background tints — card fills, avatar fills |
| `--color-amber` | `#F4A261` | **Money only** — amounts owed, requests, fuel totals |
| `--color-warm-white` | `#F7F9F8` | App background |
| `--color-surface` | `#FFFFFF` | Card surfaces |

**Amber rule:** Never use Amber for navigation, decoration, or status indicators. If it's not about money, it's not Amber.

### Typography
Two-family system: Nunito for brand/headings (rounded, warm, authoritative) and Inter for data/body (neutral, legible).

- **Display** — Nunito 900 · 32px · screen titles, onboarding
- **Title** — Nunito 800 · 22px · section headers, card titles
- **Heading** — Nunito 700 · 17px · list headers, tab labels
- **Body** — Inter 400 · 15px · descriptions, content
- **Label** — Inter 500 · 13px · metadata, captions, chips
- **Caption** — Inter 400 · 11px · timestamps, secondary info
- **Mono** — Courier New · 12px · odometer values, fuel amounts, rates

Both fonts are Google Fonts: fonts.google.com/specimen/Nunito and fonts.google.com/specimen/Inter

### Layout
- Card-based; **16px** border radius on all content containers (brand spec)
- **16px** horizontal screen padding
- **12px** internal card padding
- Tab navigation at the bottom: Home · Trips · Fuel · Settlement · History
- App header in Forest green with personalised greeting

### Data Hierarchy
Lead with the number. "52 kr" is the most prominent element on a settlement card — not the person's name. Use Nunito Black (900) at large sizes for amounts.

### Shadows
Green-tinted using Deep Forest rgba. Three levels:
- `--shadow-card` — resting cards
- `--shadow-card-hover` — hover state (+1px lift)
- `--shadow-elevated` — modals, toasts, bottom sheets

### Motion
- **Spring easing** `cubic-bezier(0.34, 1.56, 0.64, 1)` for interactive elements (button press, modal enter, toast pop)
- **Standard easing** `cubic-bezier(0.4, 0, 0.2, 1)` for color/opacity transitions
- **Durations:** 80ms instant, 140ms fast, 220ms normal, 340ms slow
- Playful but not excessive — never loop decorative animations on content screens

### Hover / Press States
- Cards: lift 1px + stronger shadow
- Buttons: darken background color by ~10%
- Button press: scale(0.97) with spring easing
- No opacity tricks for hover

### Backgrounds
Warm White (#F7F9F8) for screen background. Pure white for cards. Mist for tinted/secondary cards. No gradients, textures, or patterns defined.

### Accessibility
- Forest (#2D6A4F) on white: **5.8:1** — passes WCAG AA
- Deep Forest (#1A2E1F) on white: **14.3:1** — passes WCAG AAA
- Amber backgrounds require Deep Forest text to meet contrast requirements
- Minimum touch target: 44×44px

---

## Iconography

No proprietary GoVehlo icon system exists yet.

**CDN Substitution in use:** Lucide icons — 2px stroke, minimal, clean — fits the GoVehlo aesthetic. Load from `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`.

Key nav icons (Lucide names): `home`, `map-pin`, `fuel`, `arrow-up-down`, `history`  
Key action icons: `plus`, `check`, `x`, `chevron-right`, `check-circle`

If GoVehlo develops a custom icon set, replace all Lucide references.

**App Icon:** Winding S-curve road on Forest green, amber dot (car) at midpoint. Rounded-square canvas (Apple superellipse). Minimum icon-only size: 24px. Never place on busy photographic backgrounds.

---

## File Index

```
styles.css                          Root CSS entry — @import only
tokens/
  fonts.css                         Google Fonts @import (Nunito, Inter)
  colors.css                        All color custom properties + semantic aliases
  typography.css                    Font families, weights, type scale tokens
  spacing.css                       Space scale (4px grid) + layout metrics
  borders.css                       Border radius + border color tokens
  shadows.css                       Shadow system (card, elevated, button, nav)
  motion.css                        Duration + easing tokens
assets/
  govehlo-icon.svg                  Master app icon (editable SVG)
  icon-192.png                      PWA icon 192×192
  icon-512.png                      PWA icon 512×512
  icon-preview-a6.png               Icon preview image
guidelines/
  colors-greens.card.html           Brand green swatches
  colors-accent.card.html           Amber accent + money rule
  colors-surfaces.card.html         Surfaces, borders, text hierarchy
  colors-semantic.card.html         Success / money / error treatments
  states-loading.card.html          Loading patterns — Skeleton + Spinner
  states-error.card.html            Error & offline patterns — ErrorBanner + Input validation
  states-empty.card.html            Empty state patterns — EmptyState in context
  type-display.card.html            Nunito display specimens
  type-body.card.html               Inter body specimens
  type-mono.card.html               Monospace specimens
  type-scale.card.html              Full type scale reference
  spacing-scale.card.html           Space token visual ruler
  spacing-layout.card.html          Layout metric tokens
  borders-radius.card.html          Border radius tokens
  shadows.card.html                 Shadow elevation system
  brand-icon.card.html              App icon in sizes
  brand-wordmark.card.html          Wordmark treatment + rules
  brand-voice.card.html             Voice & tone examples
  motion.card.html                  Motion tokens
ui_kits/
  app/index.html                    Interactive GoVehlo PWA prototype (5 screens)
readme.md                           This file
SKILL.md                            Agent skill manifest
```

**Component source** lives at the project root under `components/` (not in this handoff folder — to avoid compile-time name collisions):

```
components/
  core/         Button · Badge · Avatar · Tag · Card · Odometer
  forms/        Input · Select · Checkbox · ParticipantSelector
  navigation/   TabNav · BottomNav · AppHeader
  feedback/     Toast · Skeleton · Spinner · EmptyState · ErrorBanner
  data/         AmountDisplay · TripCard · FuelCard · SettlementCard · StatusChip · SummaryBand
```

Each component has a `.jsx` (source), `.d.ts` (type declaration), and `.prompt.md` (usage guidance). Read the `.prompt.md` for API, voice guidelines, and examples.

---

## Components

| Component | Directory | Purpose |
|---|---|---|
| Button | core/ | Primary interactive control. `variant="amber"` for money actions ONLY. |
| Badge | core/ | Status pills — success (leaf), money (amber), pending, error. |
| Avatar | core/ | Initials-based with deterministic brand colour assignment. |
| Tag | core/ | Dismissible category chip. |
| Card | core/ | Base surface container (16px radius, green-tinted shadow). |
| Odometer | core/ | Dark instrument-panel km counter. App header distance display. |
| Input | forms/ | Text field with label, prefix/suffix, hint, error. |
| Select | forms/ | Dropdown field — same visual language as Input. |
| Checkbox | forms/ | Single labeled binary toggle. 44px touch target. |
| ParticipantSelector | forms/ | Checkbox grid for trip/booking participant selection. |
| Toast | feedback/ | Short feedback message. Payment actions always show toast. |
| Skeleton | feedback/ | Shimmer loading placeholder. Mist-green palette, composable primitives. |
| Spinner | feedback/ | Circular loading indicator with optional label. |
| EmptyState | feedback/ | Zero-data placeholder with encouraging copy and optional CTA. |
| ErrorBanner | feedback/ | Persistent inline banner — error, warning, or offline. |
| TabNav | navigation/ | Horizontal scrollable pill-tab navigation (primary app nav pattern). |
| BottomNav | navigation/ | 5-tab bottom navigation (mobile shortcut). |
| AppHeader | navigation/ | Forest-green header with greeting + sync status. |
| AmountDisplay | data/ | Prominent monetary amount (amber/leaf/muted by direction). |
| TripCard | data/ | Trip list row — odometer in monospace, cost in amber. |
| FuelCard | data/ | Fuel receipt row — liters, kr/L rate, station, full-tank badge. |
| SettlementCard | data/ | Settlement balance row with Request / Mark paid CTA. |
| StatusChip | data/ | Settlement payment status pill — open / requested / paid. |
| SummaryBand | data/ | Row of dark stat tiles for Settle screen period totals. |

---

---

## Token additions (from app repo)

| Token | Value | Use |
|---|---|---|
| `--color-blue` | `#355d9c` | **Requested payment status ONLY** — `StatusChip status="requested"` |
| `--color-blue-soft` | `#e9f0fb` | Background tint for requested-status chips |

Blue exists solely for the payment-requested state. Do not use it for navigation, decoration, or any other purpose.

---

---

## State Patterns

GoVehlo is PWA-first — loading, error, empty, and offline states are first-class design concerns, not afterthoughts.

### Loading
- **Skeleton** — shimmer placeholder using the Mist green palette. Compose card-shaped loading states from `variant` primitives (line, title, circle, card, button).
- **Spinner** — circular indicator for discrete actions (save, sync, request). Always pair with a `label`. Replace button text with a Spinner during submission.

### Error & Offline
- **ErrorBanner** — persistent inline banner that stays visible until the condition clears. Three variants:
  - `error` (red) — failed actions, network errors. "Couldn't load trips."
  - `warning` (amber) — data conflicts, stale data. "Sara's odometer overlaps."
  - `offline` (muted green) — offline/queued mode. "Connection lost. Changes saved locally."
- **Input `error` prop** — field-level validation. Explain the problem and guide the fix: "Must be higher than start (45 318 km)" not "Invalid value."
- **Toast `error` variant** — transient error feedback for failed discrete actions.

### Empty States
- **EmptyState** — zero-data placeholder with encouraging copy and optional CTA.
- Voice: "No trips yet" not "No data available." "Log your first trip" not "Create new entry."
- Use `compact` mode when inline inside a card.

### Feedback Component Decision Tree
| Situation | Component |
|---|---|
| Action just completed (success or failure) | Toast — auto-dismisses |
| Condition persists until resolved (offline, sync) | ErrorBanner — stays visible |
| Section has zero data | EmptyState — encourage first action |
| Content is loading | Skeleton — shimmer placeholder |
| Discrete action in progress | Spinner — with label |

---

## Admin Templates

Three admin templates share `templates/admin-shared/AdminLayout.jsx` for consistent chrome (sidebar, top bar, avatar):

- **Admin Dashboard** — stat tiles, health strip, activity feed
- **Admin Audit Log** — filterable event log with severity, actor, entity columns
- **Admin System Health** — status cards for Supabase, Render, DB, and app health

Each admin template is a separate `.dc.html` entry. Navigation between them is not wired within a single template — each previews independently. In a production build, the consuming project would wire sidebar nav to route between views.

---

## Known Gaps

- **Icon set is temporary.** Lucide icons are a placeholder. When GoVehlo develops a custom icon set, replace all Lucide references and the CDN import.
- **Admin nav is template-scoped.** Sidebar nav items highlight the active page but don't navigate between admin templates (by design — each is an independent DC).

---

*GoVehlo Design System v1.2 · June 2026 · claude@chrjohn.dk*

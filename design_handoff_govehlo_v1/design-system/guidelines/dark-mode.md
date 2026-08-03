# Dark Mode Tokens (GV-86)

Documents the dark-mode colour mapping for the v1 design system. **Tokens and
rationale only** — no client wires this up yet. See [Implementation note](#implementation-note).

Source: [`tokens/colors-dark.css`](../tokens/colors-dark.css), an override layer for
[`tokens/colors.css`](../tokens/colors.css). Every custom property in the dark file
overrides the same-named token from the light file; nothing in `colors.css` was
edited to produce it.

## Mapping philosophy

**Dark surfaces are not the light surfaces inverted.** Negating `--color-warm-white`
(`#F7F9F8`, ~97% lightness) gives ~3% lightness with no green in it — generic
app-chrome black, not a GoVehlo surface. Every dark value in this file instead
starts from `--color-deep-forest`'s own hue/saturation family (H135°/S28% — the
same neighbourhood `--text-muted` already occupies at H150°/S15%) and moves along
**lightness only**:

- **Surfaces move darker.** App background, card, and the new raised tier sit at
  roughly 7%, 14%, and 18% lightness, in the same hue family as the brand green
  rather than a neutral grey ramp.
- **Text and status tones move lighter.** A tone that has to sit ON a dark surface
  needs the opposite lightness move from its light-mode counterpart, at the *same*
  hue and saturation — the same one-axis technique `colors.css` already uses to
  derive `--text-tertiary` and `--color-error-text` from their fills, just run in
  the other direction because the background it has to clear moved from ~97% down
  to ~7-18%.

This mirrors a role-inversion the codebase already has on record.
`badge-contrast.test.ts` documents that on `--color-deep-forest` (light mode's one
existing dark surface, used behind `StatBand`), amber's fill and text tone **swap
which one is readable**: the fill clears AA there (7.00:1) and the light-mode text
tone does not (2.18:1). Full dark mode is that same surface family made the
default instead of a single band, so the same swap applies everywhere, and several
tokens below turn out to need no new value at all because of it — see the next
section.

### Surface tiers

| Token | Value | Role |
|---|---|---|
| `--color-warm-white` | `#0D1610` | App background |
| `--color-surface` | `#1A2E1F` (= `--color-deep-forest`) | Card surface |
| `--color-surface-raised` | `#243A2A` | Modals, sheets, dropdown menus — new tier, no light-mode equivalent |
| `--color-surface-band` | `#132016` | Full-bleed banded section |
| `--color-chip-neutral` | `#2E4233` | No-status badge/chip fill |

`--color-surface` reuses `--color-deep-forest`'s own hex rather than inventing a
new one — the darkest brand green already in the palette becomes the resting card
surface once the theme's baseline lightness drops below it.
`--color-surface-raised` reuses a value that already shipped in this design
system: the admin WorkspaceSwitcher's dark dropdown panel, documented in
`readme.md` as `#243A2A`. Both are the same "reuse before you invent" move.

### Text ramp

Same four-step ramp and split as `colors.css` (`--text-tertiary` is the default
for body text a user reads; `--text-muted` is non-text — icons, spinners,
separators — plus text at the WCAG large-text threshold). Checked against all
three surfaces above; `--text-tertiary` is the lightest value that clears 4.5:1 on
all of them, the same method `colors.css`'s own comment describes for the light
value:

| Token | Value | `--color-warm-white` | `--color-surface` | `--color-surface-raised` |
|---|---|---|---|---|
| `--text-primary` | `#F0F4F1` | 16.60:1 | 13.00:1 | 11.04:1 |
| `--text-secondary` | `#BECFC1` | 11.31:1 | 8.86:1 | 7.52:1 |
| `--text-tertiary` | `#8AA88F` | 7.09:1 | 5.55:1 | **4.71:1** |
| `--text-muted` | `#64876A` | 4.58:1 | 3.59:1 | **3.04:1** |

`--text-tertiary`'s worst case (4.71:1 on the brightest dark surface,
`--color-surface-raised`) is the binding one, same shape as the light file's own
"the binding surfaces are the last two" note for `--color-amber-text`.
`--text-muted` clears the 3:1 non-text bar on all three and stays below 4.5:1 on
two of them — it is not guaranteed to be legible body text, same as in light mode.

## Money, "Requested", and status colours

Per `CLAUDE.md`: Amber (`#F4A261`) stays money-only, Blue (`#355d9c`) stays
"Requested" payment status only, and the owe=amber / owed-or-incoming=leaf /
settled=muted money-direction rule keeps working. Dark mode does not loosen any of
these — it only changes which *value* plays each role.

| Purpose | Light value | Dark value | Worst-case contrast (dark) |
|---|---|---|---|
| Money text (amber) | `--color-amber-text` `#865013` | `--color-amber-text` `#F6B079` | 5.53:1 on `--color-amber-light`, 6.66:1 on `--color-surface-raised` |
| Money fill (amber) | `--color-amber` `#F4A261` | unchanged | 5.94:1 on `--color-surface-raised` — no new value needed |
| "Requested" (blue) | `--color-blue` `#355d9c` | `--color-blue` `#8DAAD8` | 5.18:1 on `--color-surface-raised`, 5.34:1 on `--color-blue-soft` |
| Incoming/positive (leaf) | `--color-leaf` `#52B788` | `--color-leaf` `#7EE0AB` | 7.67:1 on `--color-surface-raised` |
| Non-money warning (attention) | `--color-attention-text` `#7A3A1E` | `--color-attention-text` `#DBA38A` | 5.45:1 on `--color-attention-light`, 5.61:1 on `--color-surface-raised` |
| Error text | `--color-error-text` `#A82424` | `--color-error-text` `#E79292` | 5.21:1 on both `--color-error-light` and `--color-surface-raised` |

Two things worth calling out explicitly:

- **Amber is the one accent that does not need a new fill value.** `--color-amber`
  itself already clears 4.5:1 against every dark surface in this file (5.94:1
  worst case) — the same role-inversion `badge-contrast.test.ts` documents for
  amber on `--color-deep-forest`, just now true everywhere instead of one band.
  `--color-amber-text` is still minted and still used for money text, for visual
  distinction and headroom rather than because AA requires it — see the file
  comment in `colors-dark.css`.
- **Leaf already had its dark-mode value on the shelf.** `--color-light-leaf`
  (`#7EE0AB`) exists in `colors.css` today specifically because "`#52B788` fails
  contrast" on dark surfaces (GV-378's own comment). Dark mode's `--color-leaf`
  override is that exact value — not a new derivation, just the token this was
  already built for becoming the default.
- **Blue is the one token that changes shape, not just value.** Light mode never
  needed a separate blue fill/text pair — `#355d9c` is dark enough to read as text
  on its own light tint unaided. On a dark surface that stops being true (2.81:1
  at best), so `--color-blue` itself is overridden rather than adding a
  `--color-blue-text`, keeping it the single token it has always been.

## Tokens that deliberately do not change

- **`--color-amber`** (see above) — already legible as dark-surface text.
- **`--color-forest`** — stays a *button fill* with white text on top
  (`--text-on-forest`, 6.39:1, a property of the fill/text pair itself, not the
  surrounding theme). As bare text or an icon colour directly on a dark surface it
  is only 1.9-2.9:1; `--color-leaf` takes that role in dark mode instead.
- **`--text-on-forest` (`#FFFFFF`) and `--text-on-amber` (`--color-deep-forest`)**
  — both pair against a FILL colour, not an app surface, so neither depends on
  which theme is active.
- **`--color-light-leaf`** — already is the value `--color-leaf` now resolves to.
  Kept defined so call sites that reference it by name still get a value.
- **`--color-attention` and `--color-error`** (as fills) — both still clear the
  3:1 non-text bar on the tightest dark surface (3.12:1 and 3.04:1 respectively)
  and were left as icon/border colours, same as in light mode. Only their `-text`
  companions needed new values.

One alias is worth a warning rather than a "no change": **`--color-primary-dark`**
resolves to `--color-deep-forest`, whose hex does not change — but its *role*
does. In light mode it is a text tone (`--text-primary`'s source). In dark mode
`--color-deep-forest` is reused as the card surface, so `--color-primary-dark`
is no longer safe to paint text with once dark mode is active, even though
nothing about the alias itself changed.

## Shadows

`tokens/shadows.css`'s green-tinted shadows (`rgba(26,46,31,…)`, i.e.
`--color-deep-forest` at low opacity) work by *darkening* against a light
background. On a dark surface a dark shadow is close to invisible — there is no
lightness gap left to create. This file does not ship a `shadows-dark.css`: doing
that properly means picking between a lightened/glow-style elevation cue and
leaning on the new `--color-border` / `--color-surface-raised` tiers for
separation instead of shadow, and that's a real design decision, not a mechanical
value flip. Flagged here as a known gap for whoever picks up dark-mode shadows,
not solved by this ticket.

## Implementation note

This ticket is documentation and token definition only. It does **not** wire dark
mode into either client:

- **govehlo-mobile** has no CSS custom properties — React Native reads
  `src/theme/colors.ts`, a plain object, not this file. Bringing dark mode to the
  app means a parallel dark `colors` object (or a `useColorScheme`-driven
  resolver) built from the values in `colors-dark.css`, wired through React
  Native's `Appearance` API. That is mobile app code, belongs on a GVM ticket, and
  is out of scope here.
- **govehlo-web** (landing page, admin console) does use real CSS, so
  `colors-dark.css` is closer to drop-in there: import it after `colors.css` and
  set `data-theme="dark"` on `<html>` from whatever theme state the app decides
  on. An explicit attribute was chosen over a bare `@media (prefers-color-scheme:
  dark)` query so the theme can be user-controlled and tested deterministically,
  the same way `data-theme="light"`/`"dark"` toggles are commonly implemented; a
  media-query fallback can be layered on top of the attribute selector later by
  whoever builds the toggle, without touching the token values themselves.

Until one of those lands, `colors-dark.css` is reference material: the mapping a
future implementation should match, not something either product currently loads.

# VehloShare — Logo Handoff

The "Ride together" mark: two friends sharing a car. Built entirely from GoVehlo design tokens.

## Files (`assets/`)
| File | Use |
|---|---|
| vehloshare-lockup.svg | Primary horizontal lockup (icon + wordmark) |
| vehloshare-icon.svg | Icon only, full colour, transparent bg |
| vehloshare-icon-mono.svg | Single-colour (Deep Forest) icon |
| vehloshare-appicon.svg | Rounded-square app tile, vector |
| appicon-512.png / appicon-192.png | PWA manifest icons |
| apple-touch-icon-180.png | iOS home-screen icon (square, no rounding) |
| favicon-48/32/16.png | Browser favicons |

Also included: `site.webmanifest` (PWA), `Logo.jsx` (drop-in React component, no external assets).

## Colours
| Role | Hex |
|---|---|
| Deep Forest (features / wheels) | #1A2E1F |
| Forest (car body) | #2D6A4F |
| Leaf (friend one) | #52B788 |
| Mist / White (friend two) | #D8F3DC / #FFFFFF |
| Amber (headlight spark — the ONLY decorative amber allowed) | #F4A261 |

## Wordmark
Nunito Black (900), tracking ~-2%. "Vehlo" in Deep Forest #1A2E1F, "Share" in Forest #2D6A4F.
On dark/forest backgrounds the wordmark goes white, with "Share" in Leaf on very dark surfaces.
Use the SVGs as drawn — never re-space or re-outline.

## Rules
- Clear space: ≥ one friend-head height on all sides.
- Min size: lockup 120px wide; icon 24px.
- On forest/dark surfaces use the reversed treatment (white car body, white second friend).
- Do not recolour outside this palette. Amber stays on the headlight only.

## HTML head snippet
```html
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon-180.png">
<link rel="manifest" href="/site.webmanifest">
```

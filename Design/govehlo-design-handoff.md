# GoVehlo — Design Handoff

**App:** GoVehlo — shared car fuel tracking for small friend groups  
**Market:** Denmark (DKK, MobilePay)  
**Platform:** PWA (iOS + Android home screen install)  
**Status:** Live on Render + Supabase; currently rebranding from "Fuel Ledger"

---

## Brand in one sentence

Friendly, fair, frictionless — like splitting the bill with your best friends, but for fuel.

---

## Colours

| Role          | Name        | Hex       | Usage                              |
|---------------|-------------|-----------|-------------------------------------|
| Primary       | Forest      | `#27AE60` | CTAs, icon background, theme colour |
| Dark          | Deep Forest | `#1A2E1F` | Dark mode bg, heavy text on light   |
| Accent        | Leaf        | `#52B788` | Secondary actions, tags, highlights |
| Background    | Mist        | `#D8F3DC` | App background, card fills          |
| Highlight     | Amber       | `#FBBF24` | Car dot icon, active states, badges |

---

## Typography

| Role        | Family  | Weight | Size (mobile) |
|-------------|---------|--------|---------------|
| Display/Logo | Nunito | 900    | 28–36px       |
| Headings    | Nunito  | 700    | 20–24px       |
| Body        | Inter   | 400    | 15–16px       |
| Labels/UI   | Inter   | 600    | 13–14px       |

Both fonts are available on Google Fonts.

---

## Icon

**Concept:** A winding road (top-left → bottom-right S-curve) with a yellow dot (the car) at the midpoint. Road has centre-line dashes for realism. Friendly, abstract, instantly readable.

| File                 | Size     | Format | Purpose                  |
|----------------------|----------|--------|--------------------------|
| `govehlo-icon.svg`   | —        | SVG    | Master source (editable) |
| `icon-192.png`       | 192×192  | PNG    | PWA manifest (small)     |
| `icon-512.png`       | 512×512  | PNG    | PWA manifest (large)     |

**Icon spec (from SVG source):**
- Canvas: 512×512, corner radius 112 (Apple-style superellipse)
- Background: `#27AE60`
- Road: stroke `#D8F3DC`, width 44, path `M 0 140 C 140 80 380 420 512 385`
- Road dashes: stroke `rgba(255,255,255,0.40)`, width 5, dasharray `30 38`
- Car dot: circle at (259, 253), radius 26, fill `#FBBF24`
- Car highlight: circle at (251, 245), radius 10, fill `rgba(255,255,255,0.45)`

---

## PWA Manifest (updated)

```json
{
  "name": "GoVehlo",
  "short_name": "GoVehlo",
  "theme_color": "#27AE60",
  "background_color": "#D8F3DC"
}
```

---

## Voice & Tone

- **Friendly, not corporate.** "You owe Lars 42 kr" not "Outstanding balance: DKK 42.00"
- **Transparent.** Always show how costs were calculated (km × rate).
- **Encouraging.** Celebrate settlements, acknowledge contributions.
- **Concise.** Danish users scan; keep UI copy short.

---

## File inventory

| File                            | Description                        |
|---------------------------------|------------------------------------|
| `govehlo-icon.svg`              | Master icon (editable SVG)         |
| `icon-192.png`                  | PWA icon 192×192                   |
| `icon-512.png`                  | PWA icon 512×512                   |
| `govehlo-brand-guidelines.docx` | Full brand guidelines (9 sections) |
| `manifest.json`                 | Updated PWA manifest               |

---

## What's not yet designed

- App screens (booking calendar, trip log, fuel entry, settlement flow)
- Email / MobilePay request templates
- Landing page / onboarding screens
- Wordmark / logotype (text treatment of "GoVehlo")
- Dark mode palette

---

*Prepared June 2026. Contact: claude@chrjohn.dk*

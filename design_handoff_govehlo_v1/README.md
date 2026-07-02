# Handoff: GoVehlo v1 — Mobile App + Desktop Admin

## Overview

GoVehlo is a fuel ledger and car-sharing companion for small groups of friends in Denmark. This handoff covers the complete v1 prototype set: a **mobile PWA** (progressive web app) and a **desktop admin panel**, plus a **landing page**.

The existing codebase lives at `github.com/cjo2343/fuel_sharing` — a vanilla JS PWA with a Python server, Supabase backend, and service worker. The prototypes here represent the target UI for v1, designed to replace/extend the current UI.

## About the Design Files

The files in this bundle are **design references created in HTML** — interactive prototypes showing intended look, layout, and behavior. They are NOT production code to copy directly. The task is to **recreate these designs in the existing codebase** (`fuel_sharing` repo) using its established patterns (vanilla JS, Supabase, PWA), or to migrate to a framework if appropriate.

The prototypes use the **GoVehlo Design System** for all visual decisions. The design system source is at `/projects/c5fd4e92-ba46-4353-a077-9affb6732f67/` and is bundled in `_ds/` in this project.

## Fidelity

**High-fidelity.** These prototypes use final colors, typography, spacing, border radii, shadows, and interaction patterns from the GoVehlo Design System. The developer should match them closely using the design tokens documented below.

---

## Design System Summary

### Colors
| Token | Hex | Use |
|---|---|---|
| Deep Forest | `#1A2E1F` | Headings, heavy text |
| Forest | `#2D6A4F` | Primary CTAs, header, links |
| Leaf | `#52B788` | Positive states (paid, settled) |
| Mist | `#D8F3DC` | Background tints, card fills |
| Amber | `#F4A261` | **Money only** — amounts owed, fuel totals |
| Warm White | `#F7F9F8` | App background |
| Surface | `#FFFFFF` | Card surfaces |
| Blue | `#355d9c` | Requested payment status only |
| Blue Soft | `#e9f0fb` | Requested status chip background |

### Typography
| Style | Font | Weight | Size |
|---|---|---|---|
| Display | Nunito | 900 | 32px |
| Title | Nunito | 800 | 22px |
| Heading | Nunito | 700 | 17px |
| Body | Inter | 400 | 15px |
| Label | Inter | 500 | 13px |
| Caption | Inter | 400 | 11px |
| Mono | Courier New | — | 12px |

### Layout
- Card border-radius: **16px**
- Screen horizontal padding: **16px**
- Internal card padding: **12px**
- Min touch target: **44×44px**
- Shadows: green-tinted (`rgba(26,46,31,...)`)

### Motion
- Spring easing: `cubic-bezier(0.34, 1.56, 0.64, 1)` for interactive elements
- Standard easing: `cubic-bezier(0.4, 0, 0.2, 1)` for color/opacity
- Durations: 80ms instant, 140ms fast, 220ms normal, 340ms slow

### Number Formatting (Danish)
- Decimal: **comma** — `52,00 kr`
- Thousands: **period** — `1.234 km`
- Currency: **kr after number** — `52 kr` (never "DKK 52")

### Icons
Lucide icons (2px stroke). CDN: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`

---

## Mobile App Prototype

**File:** `GoVehlo Prototype.dc.html`

### Screen Map

The app has a 5-tab bottom navigation + secondary screens:

```
Bottom Nav:  Home | Log | Book | Settle | Pay

Secondary:   Activity (from Home header)
             Profile / Car (from Home header)
             History (from Home → Owner tools)
             Insights (from Home → Owner tools)
```

### 1. Onboarding Flow (3 steps)

**Step 0 — Welcome**
- Full-screen Forest green background
- GoVehlo icon (100×100px, Deep Forest bg, road SVG + amber dot)
- "GoVehlo" title (Nunito 900, 38px, white)
- "Fill up. Drive fair." subtitle
- Amber CTA "Get started" (full-width, 54px height, 16px radius)

**Step 1 — Your name**
- Progress dots (3 segments, first active)
- "What's your name?" heading (Nunito 800, 28px)
- Pre-filled input showing "Christian"
- Forest green "Continue" CTA

**Step 2 — Your crew**
- Member list (4 members with avatars, names, roles, Active badges)
- Amber "Enter GoVehlo" CTA

### 2. Home Screen
- **Header:** Forest green, "Good morning, Christian." greeting, sync status, chat + profile buttons
- **Balance card:** Split view — "You owe" (52,00 kr in amber to Lars) | "Owed to you" (120,50 kr in leaf from Sara)
- **Car status:** Green card "Car is free / Available now" with Book button. Empty state: dashed border "Add your car" card linking to Profile
- **Group:** Avatar row (5 members + Add button with dashed circle)
- **Recent trips:** 3 trip cards (avatar, odometer range in monospace, cost in amber, date)
- **Owner tools:** 2-column grid with History and Insights cards (owner badge)

### 3. Log Screen (2 sub-tabs: Trip / Fuel)
- **Trip form:** Driver, Date, Start/End km (monospace), cost summary in mist card (showing `87 km × 2,47 kr/km = 214,89 kr`), participant selector chips, "Add trip" CTA
- **Fuel form:** Paid by, Date, Amount (kr), Liters (L), Station, Full tank toggle, "Add fuel" CTA

### 4. Book Screen (2 sub-tabs: Book / Plan)
- **Book:** Car availability card, weekly calendar grid (M–S, color-coded days), legend, upcoming booking card, "Book car for today" CTA
- **Plan:** Trip cost estimator — From/To fields, Distance (km), People joining chips, estimated cost card (large amber amount with math breakdown), return trip toggle, "Save estimate" CTA

### 5. Settle Screen
- **Summary band:** Rate (2,47 kr/km), Trips total, Fuel total — monospace in mist strip
- **You owe section:** Lars 52,00 kr (amber) with Request/Requested state toggle
- **Owed to you section:** Sara 120,50 kr (leaf) with Mark paid/✓ Paid state
- **Settled section:** Mikkel 34,00 kr, Emma 18,50 kr (dimmed, ✓ Settled)

### 6. Payments Screen
- **Unpaid requests section:** Cards showing requested-but-unpaid payments
  - Lars 52,00 kr (current period, Jun 2026) — blue "Requested" chip, amber "Mark paid" button
  - Mikkel 89,00 kr (closed period, May 2026) — blue "Requested" chip, amber "Mark paid" button, "View closed period →" link
- **Settled section:** Emma 18,50 kr (dimmed, ✓ Paid)

### 7. Activity Screen (secondary, from header)
- Back button → Home
- **Today:** Activity feed cards (trip logged, payment requested with amber highlight)
- **Messages:** Chat bubbles (Danish text), sent/received styling
- **Yesterday:** Activity cards
- Message input bar

### 8. Profile / Car Screen (secondary, from header)
- Back button → Home
- **Empty state:** Car icon, "No car added yet", "Add car" CTA
- **Car profile:** Identity card (VW Golf, 2019, plate AB 12 345), odometer (45.571 km), next maintenance, repair history (3 entries with costs in amber), insurance card (Tryg, policy details), owner info

### 9. History Screen (Owner only, 3 sub-tabs)
- **Trips:** All trip cards (same format as Home)
- **Fuel:** Fuel receipt cards (L, kr/L, station, amount, Full tank badge)
- **Closed:** Period archive cards (month, trips, distance, total in amber, 4-column stat grid, ✓ Fully settled)

### 10. Insights Screen (Owner only)
- **Fuel intelligence:** 2×2 stat grid (DKK/km, DKK/L, L/100km, Confidence)
- **Monthly summary:** Dark band with Distance, Your share (amber), Trips
- **Station insights:** Ranked list (Circle K best price badge, Shell, Q8)

### Interactions & State
| Action | Result |
|---|---|
| Tap onboarding steps | Progress through 3 steps |
| Tap bottom nav | Switch active screen |
| Tap Log sub-tabs | Switch Trip / Fuel forms |
| Tap Book sub-tabs | Switch Book / Plan views |
| Tap "Request" on Lars | Changes to "Requested" chip + toast |
| Tap "Mark paid" on Sara | Changes to "✓ Paid" + toast |
| Tap "Mark paid" in Payments | Toast confirmation |
| Tap "Add car" (empty state) | Reveals full car profile + toast |
| Tap Owner tools cards | Navigate to History / Insights |
| Tap Activity/Chat button | Navigate to Activity screen |
| Tap Profile button | Navigate to Car profile |
| All CTAs | Toast feedback message |

---

## Desktop Admin Prototype

**File:** `GoVehlo Admin.dc.html`

### Layout
- **Sidebar** (240px): Deep Forest background, GoVehlo logo + "Admin" label, 5 nav items, user footer
- **Top bar** (56px): Search input, notification bell (with count badge), user avatar
- **Content area:** Warm White background, page title + subtitle, scrollable content

### 1. Dashboard
- **Stat tiles:** 3×2 grid — Active users (5), Trips this period (47), Fuel entries (12), Pending settlements (3), Errors 24h (0), Warnings 24h (2)
- **Health strip:** 3 mini cards — Supabase (Connected, 42ms), Render (Running, v452), Database (Matched)
- **Activity table:** 15 rows — Time, Actor (avatar + name), Action (badge), Entity, Detail columns

### 2. Members
- **Summary strip:** Total members (5), Admins (1), Missing email (0), Missing MobilePay (1)
- **Invite panel:** Email input + Send invite button (collapsible)
- **Member table:** Name + email, Role badge (Admin/Member), Status (Active), MobilePay, Joined date, Promote/Demote action (last admin protected)

### 3. Settings
- **Vehicle card:** Fuel type select, Consumption (L/100km), Tank capacity (L), Fallback fuel price (kr/L)
- **Fuel price warnings card:** Low/High DKK/L thresholds, Sanity threshold %
- **Settlement rules card:** Lock period after payment toggle, Require all requests before close toggle
- **Payment reminders card:** Enable toggle, First reminder delay, Repeat interval, Max reminders — all with selects
- Save / Reset buttons

### 4. Audit Log
- **Filter bar:** Type dropdown, Actor dropdown, Date range pickers, Search input
- **Audit table:** 20 rows — Timestamp, Actor (full name + avatar), Action (colored badge), Entity, ID (monospace short hash), Detail, Severity dot
- **Pagination:** Showing 1–20 of 247 events, Previous/Next buttons
- Filters are interactive (type and actor dropdowns filter the table)

### 5. System Health
- **Summary strip:** Services (3/3 healthy), Warnings (2 active), Errors (0), Uptime (99.8%)
- **Health cards:** 3×3 grid — Each card has colored left border, icon, title, status dot + label, large value, detail text, optional action button (Clean stale requests / Purge test rows)

---

## Landing Page

**File:** `GoVehlo Landing.dc.html`

- Hero with full-bleed animated road SVG (amber dot travels along S-curve)
- Feature cards section
- "How it works" with S-curve road and 3 numbered steps
- CTA section with GoVehlo wordmark lockup
- Footer

---

## Files in This Bundle

### Mobile App
- `GoVehlo Prototype.dc.html` — Complete interactive mobile prototype

### Desktop Admin
- `GoVehlo Admin.dc.html` — Entry point (unified admin)
- `GoVehloAdmin.js` — Navigation wrapper
- `admin-shared/AdminLayout.jsx` — Shared sidebar + top bar layout
- `admin-dashboard/AdminDashboard.jsx` — Dashboard content
- `admin-audit/AdminAudit.jsx` — Audit log content
- `admin-health/AdminHealth.jsx` — System health content
- `AdminMembers.jsx` — Member management content
- `AdminSettings.jsx` — Settings content

### Landing Page
- `GoVehlo Landing.dc.html` — Animated landing page

### Design System
- `_ds/govehlo-design-system-c5fd4e92-ba46-4353-a077-9affb6732f67/` — Full design system bundle (tokens, components, styles)

---

## Mapping to Existing Codebase

The `fuel_sharing` repo already implements most of the backend logic. Here's how the prototype screens map to existing code:

| Prototype Screen | Existing Code |
|---|---|
| Log (Trip/Fuel) | Trip/fuel forms in `app.js` |
| Settle | Settlement calculations in `settlement-calculations.js` |
| Payments | Unpaid payment dashboard in `app.js` |
| Book | `booking-calendar.js` |
| History | Audit log + closed periods in `audit-log.js` |
| Insights | Fuel intelligence in `fuel-price-helpers.js` |
| Admin Health | `admin-tools.js` diagnostics |
| Activity | `audit-log.js` normalized entries |

The prototype adds **new UI patterns** not in the current codebase:
- Onboarding flow (currently handled by Supabase auth + auto-member creation)
- Owner tools section (History/Insights gated to workspace owner)
- Desktop admin panel (currently admin features are inline in the mobile app)
- Landing page (no current equivalent)

---

## Notes for Implementation

1. **The app is a PWA** — maintain `manifest.json`, service worker, and installability
2. **Supabase is the backend** — all data flows through Supabase tables with RLS
3. **Danish locale** — all numbers use comma decimals, period thousands, "kr" suffix
4. **Amber = money only** — never use `#F4A261` for non-monetary UI
5. **Blue = requested status only** — `#355d9c` is exclusively for the "Requested" payment chip
6. **Toast feedback** — every action should show a toast (see `ui-messages.js`)
7. **Touch targets** — minimum 44×44px on all interactive elements

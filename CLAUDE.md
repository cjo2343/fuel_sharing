# GoVehlo — Fuel Sharing Ledger (legacy repo)

Shared-car fuel tracking and cost splitting for small groups in Denmark.

## ⚠️ Repo status: runtime retired

The web app in this repo is **no longer deployed anywhere**. Render hosting was
decommissioned (GV-103) and the PWA's service worker is kill-switched from govehlo-web.
The live products are:

- **govehlo-mobile** — the React Native app (App Store target)
- **govehlo-web** — Cloudflare Pages: landing page, admin console (admin.govehlo.dk), `/api/*` Functions

What this repo is still **load-bearing** for:

| Asset | Role |
|---|---|
| `supabase/migrations/` | **Single source of truth for the shared Supabase schema** — both live products run on this database |
| `supabase-schema.sql` | Consolidated fresh-install schema (must mirror every migration) |
| `tools/test-migrations.mjs`, `tools/test-sql-ambiguity-guard.mjs` | CI guards for the above |
| `design_handoff_govehlo_v1/` | Design-system source of truth (referenced by both live repos) |
| `Design/` | Brand source assets (icon SVG, brand guidelines) |

Everything else (`app.js`, `server.py`, the PWA files, most of `tools/`) is **frozen
legacy code**. Do not extend it, "fix" it, or spend effort on its 140-test validation
suite beyond keeping `npm run validate` green when you touch migrations. It remains
useful only as a reference implementation (e.g. `settlement-calculations.js` is the
tested original of the mobile app's `settlement-calc.ts`).

## Database migrations — the contract

Migrations are applied **MANUALLY in the Supabase SQL Editor**. Merging a PR does
**not** apply anything. The user applies the SQL and confirms; do not assume a merged
migration is live in the database.

Checklist for a new migration `NNN_name.sql` in `supabase/migrations/`:

1. First line must be `-- Migration NNN: <description>`.
2. The file must insert its own id into `public.fuel_ledger_schema_migrations`.
3. Append the filename to the hardcoded `expected` array in `tools/test-migrations.mjs`.
4. Mirror the change in `supabase-schema.sql`: append a create-or-replace block plus the
   tracker insert at the end (last definition wins on replay — the consolidated schema
   must produce the same end state as a fresh install running every migration).
5. Run `npm run validate` — it enforces 1–4.
6. RPCs that write domain events follow the migration 051/052 pattern: trailing
   `event_title` / `event_body` params, insert into `ledger_events`, actor via
   `public.current_ledger_member_id()`, email via `auth.jwt() ->> 'email'`.
7. New RPCs called by clients need `grant execute ... to authenticated`.

Use the `/new-migration` skill — it scaffolds all of this.

```sh
npm run validate       # migration + module checks — run before every commit
```

## Design system (v1)

Source of truth: `design_handoff_govehlo_v1/design-system/`

### Branding rules (non-negotiable)
- **Amber (#F4A261)** — money values only. Never decorative.
  - Approved exceptions: InlineMessage's warning variant (GVM-26); amount-color
    direction is owe=amber, owed/incoming=leaf, settled=muted (GVM-74).
- **Blue (#355d9c)** — "Requested" payment status only. No other uses.
- **Monospace (Courier New)** — odometer, fuel amounts, rates, hex codes
- **Danish locale** — comma decimals (`52,00 kr`), period thousands (`1.234 km`), "kr" suffix
- **Icons** — Lucide (the design-system set); no emoji in UI

### Token files
- Colors: `tokens/colors.css`
- Typography: Nunito (display/headings) + Inter (body) — `tokens/typography.css`, `tokens/fonts.css`
- Spacing: 4px grid — `tokens/spacing.css`
- Borders: 16px card radius, 12px buttons — `tokens/borders.css`
- Shadows: green-tinted from Deep Forest — `tokens/shadows.css`
- Motion: spring easing for interactive, standard for transitions — `tokens/motion.css`

### Key constraints
- Minimum touch target: 44×44px
- Screen padding: 16px horizontal
- Bottom nav: 64px height
- App header: 72px height
- Card internal padding: 12px

## Voice & tone

- Second person + first names: "You owe Lars 52 kr"
- Sentence case everywhere
- Friendly, transparent about money
- Never clinical or corporate

## GDPR (applies to all GoVehlo repos)

- Data minimisation; processing stays in the EU (Supabase EU project, Sentry EU region).
- No PII in logs or URL query strings (number plates are personal data — POST bodies only).
- Honour deletion requests.

## Workflow

- One ticket at a time. Branch → PR (the user merges) → sync main → move the Jira ticket.
- Jira: govehlo.atlassian.net — **GV** (web/infra, this repo + govehlo-web) and
  **GVM** (mobile). Use the `/ship` skill for the PR + Jira mechanics.
- `gh` must run as `env -u GH_TOKEN -u GITHUB_TOKEN gh …`.

## Legacy runtime (frozen — reference only)

Vanilla JS modules (no framework/build step) + Python `server.py`; formerly Render-hosted
PWA. `app.js` (22k lines) was mid-modularization: `workspace-session.js`,
`render-api-client.js` extracted; helpers `settlement-calculations.js`,
`permission-helpers.js`, `fuel-price-helpers.js`, `audit-log.js`, `booking-calendar.js`,
`trip-actions.js`, `trip-rendering.js`, `fuel-rendering.js`. Runs locally via
`npm start` (→ http://localhost:4175/) with data in `ledger-data.json` if you ever need
to compare behavior against the original.

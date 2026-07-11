# GoVehlo — platform repo (shared schema + design source of truth)

Shared-car fuel tracking and cost splitting for small groups in Denmark.

## Repo status: platform repo

This repo is **not a deployed application**. It is the platform backbone the two
live GoVehlo products share — both run on **one shared Supabase database**, and this
repo is the single source of truth for its schema and for the canonical design system.

- **govehlo-mobile** — the React Native app (App Store target)
- **govehlo-web** — Cloudflare Pages: landing page, admin console (admin.vehloshare.app), `/api/*` Functions

What this repo is **load-bearing** for:

| Asset | Role |
|---|---|
| `supabase/migrations/` | **Single source of truth for the shared Supabase schema** — both live products run on this database |
| `supabase-schema.sql` | Consolidated fresh-install schema (must mirror every migration) |
| `types/database.ts` | Canonical generated DB/RPC types (GV-223) — vendored byte-identically by both client repos; regenerate with `npm run gen:db-types` |
| `tools/` | CI guards: `test-migrations.mjs`, `test-sql-ambiguity-guard.mjs`, `check-schema-equivalence.mjs`, `check-token-drift.mjs`, `generate-db-types.mjs`, `test-functional-smoke.sh` |
| `design_handoff_*/`, `design_briefs_*/` | Design-system source of truth (referenced by both live repos) |
| `Design/` | Brand source assets (icon SVG, brand guidelines) |
| `RENAME-VEHLOSHARE-RUNBOOK.md` | Active GoVehlo → VehloShare rename runbook |

There is no runtime, build step, or app code to extend here. The only work is
migrations, the schema mirror, design tokens, and the CI guards that protect them.

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
5. Regenerate the shared DB types: `npm run gen:db-types` (Docker) and commit the
   refreshed `types/database.ts` — CI's `check:db-types` fails when it is stale.
6. Run `npm run validate` — it enforces 1–4.
7. RPCs that write domain events follow the migration 051/052 pattern: trailing
   `event_title` / `event_body` params, insert into `ledger_events`, actor via
   `public.current_ledger_member_id()`, email via `auth.jwt() ->> 'email'`.
8. New RPCs called by clients need `grant execute ... to authenticated`.

Use the `/new-migration` skill — it scaffolds all of this.

```sh
npm run validate                 # fast: migration guard + SQL ambiguity guard + token drift (run before every commit)
npm run check:schema-equivalence # Docker: replays migrations vs consolidated schema and diffs
npm run gen:db-types             # Docker: regenerates types/database.ts from the consolidated schema (GV-223)
npm run check:db-types           # Docker: fails if the committed types/database.ts is stale
npm run test:functional-smoke    # Docker: runs delete_my_account / push-token RPCs and asserts scrubs
```

`npm run validate` is dependency-free (three Node checks, no Python or Docker). It
runs in CI and, if you enable the hook with `npm run hooks:install`, on every push.
The Docker-backed checks run as their own CI jobs.

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

## Legacy runtime (archived at a tag)

The retired legacy PWA runtime (`app.js`, `server.py`, the PWA files, and the
~140-test legacy validation suite) was removed from `main` in GV-266 and archived at
the git tag **`legacy-runtime-final`**. `git checkout legacy-runtime-final` if you ever
need the original reference implementation — e.g. `settlement-calculations.js`, the
tested original of the mobile app's `settlement-calc.ts`.

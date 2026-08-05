# VehloShare — platform repo (shared schema + design source of truth)

Shared-car fuel tracking and cost splitting for small groups in Denmark.

## Repo status: platform repo

This repo is **not a deployed application**. It is the platform backbone the two
live VehloShare products share — both run on **one shared Supabase database**, and this
repo is the single source of truth for its schema and for the canonical design system.

- **vehloshare-mobile** — the React Native app (App Store target)
- **vehloshare-web** — Cloudflare Pages: landing page, admin console (admin.vehloshare.app), `/api/*` Functions

> **Repo names vs directory names (GV-230, 2026-08-06).** The GitHub repos were renamed
> `govehlo-web` → **`vehloshare-web`** and `govehlo-mobile` → **`vehloshare-mobile`**
> (GitHub redirects the old names; `fuel_sharing` was not renamed). The **local sibling
> directories are still `../govehlo-web` and `../govehlo-mobile`** and were deliberately
> left that way — every cross-repo tool resolves them by that path
> (`tools/vendor-db-types.mjs`, `check-hotpath-mirror.mjs`,
> `check-ledger-event-classification.mjs`). Filesystem paths below therefore keep the
> old names on purpose; do not "fix" them.

What this repo is **load-bearing** for:

| Asset | Role |
|---|---|
| `supabase/migrations/` | **Single source of truth for the shared Supabase schema** — both live products run on this database |
| `supabase-schema.sql` | Consolidated fresh-install schema (must mirror every migration) |
| `types/database.ts` | Canonical generated DB/RPC types (GV-223) — vendored byte-identically by both client repos; regenerate with `npm run gen:db-types` |
| `tools/` | ~28 CI guards. The load-bearing ones: `test-migrations.mjs`, `test-sql-ambiguity-guard.mjs`, `check-schema-equivalence.mjs`, `check-token-drift.mjs`, `generate-db-types.mjs`, `test-rls-role-matrix.mjs` (own CI job), `check-hotpath-mirror.mjs`, plus six functional `*.sh` suites. `tools/run-validations.mjs`'s `scripts` array is the authoritative list — read it rather than this row |
| `design_handoff_govehlo_v1/` | **The** design-system source of truth — the one referenced by both live repos |
| `design_handoff_fuel_bar/` | Referenced by vehloshare-mobile |
| other `design_handoff_*/`, `design_briefs_*/` | Historical handoffs, nine of them with zero inbound references from any repo. Kept as design history; do NOT treat them as current spec |
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
6. **Fan those types out to both clients: `npm run vendor:db-types`** (needs the
   sibling repos checked out). It writes `../govehlo-web/types/database.ts` and
   `../govehlo-mobile/src/types/database.generated.ts` — **local directory names, which
   the rename deliberately left alone** (see the note at the top) — each is a separate
   repo (`vehloshare-web` / `vehloshare-mobile` on GitHub) and a
   separate PR. Skipping this is what put vehloshare-web three migrations behind and the
   umbrella workflow red for 18 runs (GV-391); the umbrella is the only CI that can
   see these copies at all.
7. Run `npm run validate` — it enforces 1, 2, 3 and the *tracker* half of 4 (that the
   migration id is INSERTed into `supabase-schema.sql`). It does **not** check that the
   DDL itself was mirrored — only `npm run check:schema-equivalence` (Docker) does, by
   replaying both paths and diffing every object, function bodies and in-body comments
   included. Run it before opening a migration PR.
8. RPCs that write domain events follow the migration 051/052 pattern: trailing
   `event_title` / `event_body` params, insert into `ledger_events`, actor via
   `public.current_ledger_member_id()`, email via `auth.jwt() ->> 'email'`.
9. New RPCs called by clients need `grant execute ... to authenticated`.
10. A **new `event_type` written into `ledger_events` must be classified** — feed or
    audit. The mobile Activity feed has no allow-list: it renders whatever the database
    writes, with the row's own title, so a new type is visible to every member with no
    client change. Put it in `FEED_VISIBLE_EVENT_TYPES`
    (`tools/ledger-event-visibility.mjs`) if it belongs in the feed, or in
    `EVENT_TYPE_EXCLUDE` (`tools/load-rehearsal/lib/hotpaths.mjs` **and** the mobile
    gateway's `.not('event_type','in',(…))` filter, same order, both repos) if it is an
    internal audit row. `npm run validate` fails until you choose (GV-413).

Use the `/new-migration` skill — it scaffolds all of this.

**Before applying a migration to production, read
[`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md).** It is the most precise migration
document in the repo and the checklist above deliberately does not duplicate it: the
storage-schema guard, re-declaring off the *newest* prior definition, the dynamic
`pg_policies` sweep for prod policy-name drift, and the role-matrix step all live
there. It had no inbound link from anywhere until GV-393, so agents read this shorter
list and missed all four.

The ones you will actually reach for (`npm run` with no args lists all 28 — the
count was already three stale before GV-422 added two; trust `npm run`, not this line):

```sh
npm run validate                 # fast gate, run before every commit (see below)
npm run check:schema-equivalence # Docker: replays migrations vs consolidated schema and diffs
npm run gen:db-types             # Docker: regenerates types/database.ts from the consolidated schema (GV-223)
npm run check:db-types           # Docker: fails if the committed types/database.ts is stale
npm run vendor:db-types          # copies types/database.ts into both client repos (GV-391)
npm run check:vendored-db-types  # reports a stale client copy without writing anything
npm run check:role-matrix        # Docker: RLS role matrix, 173 cases (own CI job)
npm run test:functional-smoke    # Docker: runs delete_my_account / push-token RPCs and asserts scrubs
npm run drill:restore            # GDPR restore drill — needs a FRESH prod dump (docs/gdpr/backup-restore.md)
npm run check:release-gates      # the known launch blockers as code (GV-422); --strict in the umbrella
```

The remainder are per-feature SQL contract tests (`test:booking-*`, `test:deferred-fuel-close`,
`test:member-recurring-suspension`, `test:syn-acknowledgement`, `test:retired-rpcs`,
`test:drill-*`, `test:load-rehearsal`, `test:release-gates`), the load-rehearsal drivers
(`load:schema`, `load:seed`, `load:run`) and `hooks:install`. Most already run inside
`npm run validate`.

**Before a release** (not before a commit): `npm run check:release-gates`. It fails on the
launch blockers we already know about — the unfilled `[DATAANSVARLIG …]` placeholder on the
live privacy page, the Free-plan backup posture (GV-313), a restore drill too far behind the
schema, and the two items nothing in any repo can observe (app-link secrets, Sentry source
maps), which are attested in `docs/release-attestations.json`. It is deliberately NOT in
`npm run validate` — it judges the product, not the commit — and it is red today on purpose.

`npm run validate` is dependency-free (no Python, no Docker) and runs in CI, plus on
every push if you enable the hook with `npm run hooks:install`. It is **not** three
checks — `tools/run-validations.mjs`'s `scripts` array is the authoritative list (16
and growing), so read that rather than any prose count. The Docker-backed checks run
as their own CI jobs; the cross-repo ones only ever do real work in
`.github/workflows/umbrella.yml`, which is the only workflow that checks out all three
repos (`check-token-drift`, `check-hotpath-mirror`, `vendor-db-types`, the role-matrix
coverage half — each warns and passes locally when a sibling is absent).

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

## GDPR (applies to all VehloShare repos)

- Data minimisation; processing stays in the EU (Supabase EU project, Sentry EU region).
- No PII in logs or URL query strings (number plates are personal data — POST bodies only).
- Honour deletion requests.

## Workflow

- One ticket at a time. Branch → PR (the user merges) → sync main → move the Jira ticket.
- Jira: govehlo.atlassian.net (host unchanged) — **GV** (web/infra, this repo + vehloshare-web) and
  **GVM** (mobile). Use the `/ship` skill for the PR + Jira mechanics.
- `gh` must run as `env -u GH_TOKEN -u GITHUB_TOKEN gh …`.

## Legacy runtime (archived at a tag)

The retired legacy PWA runtime (`app.js`, `server.py`, the PWA files, and the
~140-test legacy validation suite) was removed from `main` in GV-266 and archived at
the git tag **`legacy-runtime-final`**. `git checkout legacy-runtime-final` if you ever
need the original reference implementation — e.g. `settlement-calculations.js`, the
tested original of the mobile app's `settlement-calc.ts`.

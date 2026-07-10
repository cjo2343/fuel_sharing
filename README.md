# GoVehlo — platform repo (shared schema + design source of truth)

This repo is **not a deployed application**. It is the platform backbone the two
live GoVehlo products share:

- **govehlo-mobile** — the React Native app (App Store target)
- **govehlo-web** — Cloudflare Pages: landing page, admin console, `/api/*` Functions

Both live products run on **one shared Supabase database**, and this repo is the
single source of truth for its schema and for the canonical design system.

## What lives here

| Asset | Role |
|---|---|
| `supabase/migrations/` | Source of truth for the shared Supabase schema. Applied **manually** in the Supabase SQL Editor. |
| `supabase-schema.sql` | Consolidated fresh-install schema — must reproduce the end state of replaying every migration. |
| `tools/` | CI guards: `test-migrations.mjs`, `test-sql-ambiguity-guard.mjs`, `check-schema-equivalence.mjs`, `check-token-drift.mjs`, `test-functional-smoke.sh`. |
| `design_handoff_*/`, `design_briefs_*/`, `Design/` | Design-system + brand source of truth, referenced by both live repos. |
| `RENAME-VEHLOSHARE-RUNBOOK.md` | Active GoVehlo → VehloShare rename runbook. |

The retired legacy PWA runtime (`app.js`, `server.py`, the PWA files, and the
~140-test legacy validation suite) was archived at the git tag
**`legacy-runtime-final`**. Check it out if you need the original reference
implementation (e.g. `settlement-calculations.js`).

## Working with migrations

Migrations are the contract. See [`CLAUDE.md`](CLAUDE.md) for the full checklist,
and use the `/new-migration` skill to scaffold one with every guard satisfied.

```sh
npm run validate                 # fast: migration guard + SQL ambiguity guard + token drift
npm run check:schema-equivalence # Docker: replays migrations vs consolidated schema and diffs
npm run test:functional-smoke    # Docker: runs delete_my_account / push-token RPCs and asserts scrubs
```

`npm run validate` runs on every commit (and, if you enable the hook with
`npm run hooks:install`, on every push). The two Docker-backed checks and the
fast validate all run in CI (`.github/workflows/validate.yml`).

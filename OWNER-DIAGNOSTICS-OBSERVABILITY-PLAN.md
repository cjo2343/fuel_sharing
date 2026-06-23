# Plan: clean up owner "Diagnostics Lab" into a Supabase-style observability view

Panel: `renderAdminGuardrailOverview()` (app.js ~7017), rendered into
`#adminGuardrailOverview` inside the owner-only `#dataToolsPanel`. Owner-gated already.

## Problems
- ~11 tiles with long paragraph copy and no grouping → wall of info.
- No clear "last checked" or single refresh; mix of on-demand vs cached tiles is
  invisible, so the owner can't tell what is fresh.
- Most tiles need a manual **Run Security Health** (2-min cooldown,
  `securityHealthCooldownMs`); only Release/Sync state/Backup guardrails/Launch
  readiness are cached/static.

## Target: observability layout (reuse the #427 metric-tile + status-dot styling)
1. **Header control bar:** one line — "On-demand checks (not auto-refreshed, to protect
   Supabase CPU)." + a single **Run Security Health** button showing "Last run: HH:MM"
   or "Never", plus the existing cooldown note. One refresh, not per-tile guessing.
2. **Group the tiles** into clear sections:
   - **Health (Security Health checks):** Overall health, Table health, RPC
     availability, Migrations, Schema shape, Realtime publication. Each tile = status
     dot + short value + "Checked HH:MM" (or "Not checked — run Security Health").
   - **Status (live/cached):** Release, Realtime, Sync state, Backup guardrails. These
     update without Security Health; label them "Live".
   - **Launch readiness:** the long static checklist → collapse behind a `<details>`
     ("Launch readiness checklist"), since it's reference text, not a live metric.
3. **Trim copy:** each tile shows a one-line value; move the multi-sentence
   explanations into a tooltip / the collapsed detail. The "Public launch readiness"
   wall especially.
4. **Per-tile freshness:** add a "Checked HH:MM" / "Live" stamp so the owner knows
   what's current vs stale. (The security status already records a checkedAt; surface
   it.)
5. Keep the Owner tools (Backup / Restore / CSV export) section below as-is.

## Validation
`npm run validate`, `npm run test:e2e`; manual: as app owner, the panel shows grouped
tiles with status dots + freshness; Run Security Health refreshes the Health group and
stamps the time; non-owners still never see this panel (owner-gated). Runtime files
change → version bump (build-info + service-worker + checklist; no embedded double-
quotes in the top release note).

## Category
**Sonnet** — presentation/grouping/copy + surfacing existing `checkedAt` timestamps;
the underlying checks already exist. Reuses the Admin dashboard tile styling. Mockup
optional if the grouping wants tuning. Pairs with the Admin role-separation cluster
(#6/#8) and the #427 dashboard aesthetic.

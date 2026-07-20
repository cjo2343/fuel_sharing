# Deploy checklist — schema migrations (GV-338)

The one end-to-end path from "we need a schema change" to "everything agrees it is
live". Every step exists because skipping it has bitten us at least once; the
lesson is cited where that happened. Copy the checklist into the PR or working
notes and tick it off in order.

**The one rule that frames everything: merging a PR applies NOTHING. Migrations
run manually in the Supabase SQL Editor, and only the owner's confirmation makes
a migration "live".**

## 1. Author (this repo)

- [ ] Use `/new-migration` — it scaffolds the contract below.
- [ ] First line is exactly `-- Migration NNN: <description> (<JIRA-KEY>)` and the
      ticket key is the *right* ticket (137 initially cited a closed one).
- [ ] File inserts its own id into `public.fuel_ledger_schema_migrations`.
- [ ] Filename appended to the `expected` array in `tools/test-migrations.mjs`.
- [ ] Mirror block appended to `supabase-schema.sql` — **byte-identical, including
      in-body SQL comments** (GV-175: the equivalence diff compares function
      bodies verbatim). Placement: at end of file, directly after the previous
      migration's tracker insert, and including the `-- Migration NNN:` header
      comment — copy how the previous migration's block sits (138 lesson).
- [ ] Anything touching **Supabase Storage** (`storage.buckets` rows,
      `storage.objects` policies): the CI guards replay in plain Postgres with
      NO `storage` schema, so wrap every storage statement in a
      `do $$ … if exists (select 1 from information_schema.schemata where
      schema_name = 'storage') …` guard, and state in the migration AND the PR
      that the storage half only takes effect in the real SQL Editor (138 lesson).
- [ ] Re-declared functions are based on the **newest prior definition**, not an
      intermediate migration's copy (GV-202: the equivalence check cannot catch
      drift from re-declaring off a stale version).
- [ ] Column references in RPC bodies are table-qualified; no parameter named
      like a column feeding `ON CONFLICT` (the 42702 shadowing bug hid a dead
      rate limiter from migration 049 to 100).
- [ ] New client-callable RPCs: `grant execute … to authenticated`. Security
      definer RPCs gate access themselves and `set search_path = public`.
- [ ] Write-RPCs that other clients must see live insert a `ledger_events` row —
      no event, no realtime push (close/settlement were silent until 087).
- [ ] Dropping/renaming RLS policies: pair by-name drops with a dynamic
      `pg_policies` sweep — prod policy names can differ from the files (the
      103/PR #117 lesson).
- [ ] `npm run validate` green (migration guard + ambiguity guard + token drift).
- [ ] Docker checks green: `npm run check:schema-equivalence`, and
      `npm run gen:db-types` with the refreshed `types/database.ts` committed
      (`check:db-types` fails CI when stale). These (and the role matrix) need
      the Docker daemon — start Docker Desktop first; there is no non-Docker
      fallback, only CI (138 lesson).
- [ ] RLS/grant changes: extend `tools/test-rls-role-matrix.mjs`, including a
      negative case proving the role *cannot* do the thing. Run it locally with
      `node tools/test-rls-role-matrix.mjs` (Docker-backed).
- [ ] Touching `delete_my_account` or any other smoke-covered RPC: run
      `npm run test:functional-smoke` (Docker) — `validate` does not cover it,
      and a broken scrub fails silently otherwise (138 lesson).

## 2. Ship

- [ ] One migration per PR, branched **off main** — never off another migration
      PR's branch (GitHub does not retarget on merge; the second PR silently
      merges into the stale branch).
- [ ] PR mechanics (title convention, ready-not-draft, commit trailer, the
      `env -u GH_TOKEN -u GITHUB_TOKEN gh` invocation) live in CLAUDE.md and the
      `/ship` skill — follow those; this checklist doesn't repeat them.
- [ ] PR body states: **"SQL must be applied manually in the Supabase SQL Editor
      after merge."**
- [ ] After the merge: no further pushes to the merged branch (they strand
      silently).

## 3. Apply (owner, manual)

- [ ] Owner runs the migration file's SQL in the Supabase SQL Editor (prod) and
      confirms in chat. Until then the migration is **not live** — dependent
      features must degrade gracefully, and nothing below this line starts.
- [ ] Sanity: `select * from fuel_ledger_schema_migrations order by applied_at
      desc limit 3;` shows the new id.

## 4. Contract sync (both client repos, after apply)

The umbrella "Cross-repo consistency" job goes **red at the moment the platform
PR merges** — that is the drift alarm working, not a failure to fix in place.

- [ ] govehlo-web PR: bump `EXPECTED_LATEST_MIGRATION` in
      `functions/api/owner/migrations.js` + byte-copy `types/database.ts` from
      this repo. Verify with `npx wrangler pages functions build` (`node --check`
      misses esbuild-level errors). Watch for `APP_VERSION`/`version.json`
      collisions if other web PRs are in flight — assign explicit versions or
      sequence.
- [ ] govehlo-mobile PR: byte-copy to `src/types/database.generated.ts`; tsc +
      suite green (the two known local `PUSH_ENABLED` failures are expected on
      the owner machine only).
- [ ] Both merged; a **fresh** umbrella run (created after the last merge —
      gate on the run timestamp, stale runs give stale verdicts) is green.

## 5. Aftercare

- [ ] Admin console Health page: the drift check shows the new migration as
      applied (that is what the `EXPECTED_LATEST_MIGRATION` bump feeds).
- [ ] New/changed Cloudflare Pages secrets or env vars only take effect after a
      **redeploy** — setting them is not enough (booking-reminder lesson).
- [ ] Jira: close the ticket with the evidence chain (merge commits, "applied and
      confirmed", sync PRs, umbrella run).
- [ ] Backups: if the change is structurally significant, refresh the restore
      dump before relying on it (GV-325 drill; dump predating the migration
      restores a pre-migration schema).

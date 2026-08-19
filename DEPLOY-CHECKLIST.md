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
- [ ] Migrations that UPDATE existing rows in a guarded table (`trips`,
      `fuel_payments`, `trip_participants`, `workspace_expenses`, `repairs`):
      the settlement triggers veto ANY change to rows in locked/closed periods,
      and every CI replay runs against an EMPTY database, so the failure only
      appears on the production apply (192 lesson — 22023 on first apply). For a
      metadata-only backfill, wrap it in `alter table … disable trigger user` /
      `enable trigger user` (FK triggers stay active), and rehearse the apply on
      a POPULATED database: replay migrations through N−1, seed closed-period
      rows under `session_replication_role = replica`, then apply migration N
      with triggers live.
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

> **Manual apply is the ONLY apply path — the Supabase GitHub integration must stay
> disabled (GV-495, 2026-08-19).** It was found connected to the production project
> with "Deploy to production" ON for `main`, working directory `.`. Supabase's CLI
> history table in prod (`supabase_migrations.schema_migrations`) stops at **102**, so
> from migration 103 onward every push to `main` made the integration attempt
> `db push` of 103→latest against PRODUCTION; it failed on 103's first statement (an
> unconditional `drop function` of something 103 had already dropped by hand) and
> therefore applied nothing — but it was one `IF EXISTS` away from replaying a hundred
> migrations over live data. The integration was disabled on 2026-08-19. That history
> table is deliberately NOT maintained (it is the CLI's, not ours —
> `public.fuel_ledger_schema_migrations` is the tracker); do not "repair" it unless the
> whole train in this checklist is consciously redesigned around auto-apply. If a
> "Supabase Preview" check ever reappears on a commit, the integration has been
> re-enabled: turn it off before merging anything under `supabase/`.

## 4. Contract sync (both client repos, after apply)

The umbrella "Cross-repo consistency" job goes **red at the moment the platform
PR merges** — that is the drift alarm working, not a failure to fix in place.

- [ ] vehloshare-web PR: bump `EXPECTED_LATEST_MIGRATION` in
      `functions/api/owner/migrations.js` + byte-copy `types/database.ts` from
      this repo. Verify with `npx wrangler pages functions build` (`node --check`
      misses esbuild-level errors). Watch for `APP_VERSION`/`version.json`
      collisions if other web PRs are in flight — assign explicit versions or
      sequence.
- [ ] vehloshare-mobile PR: byte-copy to `src/types/database.generated.ts`; tsc +
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
      restores a pre-migration schema). After a drill, update the machine-read
      `Seneste drill: migration NNN (YYYY-MM-DD)` line in
      [`docs/gdpr/backup-restore.md`](docs/gdpr/backup-restore.md) — the release
      gate below reads that line, not the prose around it.

## 6. Before a public release (not per migration)

`npm run check:release-gates` (GV-422) is the machine-readable half of this
document and of GV-104's go-live gates: it fails while a known launch blocker is
present, so "are we ready?" is a command rather than a re-read. It is not part of
`npm run validate` — it judges the product, not the commit — and the umbrella
workflow runs it `--strict`.

- [ ] `npm run check:release-gates` with **vehloshare-web checked out alongside**
      (the sibling **directory** is still `../govehlo-web` — the GV-230 rename changed
      the GitHub repo name, not the local checkout path). Without the sibling, gate 1
      reports `UNAVAILABLE` and certifies nothing.
- [ ] Every `BLOCKED` line cleared: privacy-page placeholder (GV-177), Supabase
      plan off Free (GV-313), restore drill within 15 migrations of HEAD.
- [ ] `docs/release-attestations.json` signed and dated for every item no repo can
      observe — app-link secrets, Sentry source maps, and the Realtime public-access
      switch (below). Read that file's `_README` for what "verified" has to mean;
      attestations expire after 30 days.

### 6a. Realtime is private-only (GV-490 / GVM-575)

`presence-<ledgerId>` and `ledger-changes-<ledgerId>` carry workspace data — who
has the app open, and which rows just changed. Migrations 202/205/206 put RLS
policies on `realtime.messages` and the mobile client opens both topics with
`private: true`, but **policies only bind private channels**: while the project
setting **Realtime → "Allow public access to channels"** is ON, anyone logged in
who knows a workspace id can open the same topic as a public one and the policies
are never consulted. The switch was turned off on 2026-08-12; no migration writes
it, no query reads it, and nothing in any repo can tell you it is still off — so
it is re-checked here and attested, not remembered.

```sh
SUPABASE_URL=https://<prod-ref>.supabase.co \
SUPABASE_ANON_KEY=<anon key> \
npm run probe:realtime-public-access
```

The probe joins `presence-<id>` **without** `private: true` and exits **0 only if
the join is refused** ("PrivateOnly"); exit 1 means the hole is open, exit 2 means
it learned nothing (bad URL/key, no network) — which is never a pass. Add
`SUPABASE_ACCESS_TOKEN=<a member's JWT>` and `LEDGER_ID=<their workspace>` for
phase 2: the same topic joined **with** `private: true` must still reach
`SUBSCRIBED`, i.e. the switch closed the hole without taking presence and live
sync down with it. The probe needs the network and a live project, so it is
deliberately outside `npm run validate`; it is also the one tool here that is
meant to point at production. It reads and writes nothing, and never prints
presence payloads (they are member ids).

- [ ] Probe run against **production** and green, and the client half confirmed:
      every mobile build in the field opens both topics with `private: true`
      (pre-launch, with nothing released, no other build exists — that is the
      answer, and saying so is the check).
- [ ] `realtime_public_access_closed` in `docs/release-attestations.json` signed
      and dated by the person who ran it.

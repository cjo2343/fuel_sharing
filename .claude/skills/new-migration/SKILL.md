---
name: new-migration
description: >
  Scaffold a new Supabase migration for the GoVehlo shared database with every
  guard satisfied (header, tracker insert, test-migrations expected array,
  supabase-schema.sql mirror). Use when the user asks for a schema change, a new
  RPC, a new column/table, or runs /new-migration.
user-invocable: true
---

# New Supabase migration

Migrations in this repo are the single source of truth for the database that
**govehlo-mobile** and **govehlo-web** run on. They are applied **manually in the
Supabase SQL Editor** — merging does NOT apply them. `npm run validate` enforces the
file contract below; skipping a step fails CI.

## Steps

1. **Pick the id.** `ls supabase/migrations/ | tail -1` → next `NNN` (zero-padded).
   Name: `NNN_short_snake_description.sql`.

2. **Write the file** with this skeleton:

   ```sql
   -- Migration NNN: <one-line description> (<JIRA-KEY>)
   --
   -- <Why this change exists; what breaks without it.>

   <DDL / create or replace function ...>;

   insert into public.fuel_ledger_schema_migrations (migration_id, description)
   values ('NNN_short_snake_description', '<one-line description (JIRA-KEY)>')
   on conflict (migration_id) do update
   set description = excluded.description,
       applied_at = now();
   ```

   - The first line MUST match `-- Migration NNN:` exactly (validated).
   - Re-declare a function completely when changing it (`create or replace` with the
     FULL body — migrations 052/053 show the pattern of re-creating
     `create_private_ledger_workspace` wholesale).
   - RPCs that should appear in activity feeds follow the migration 051/052 event
     pattern: trailing `event_title text default null, event_body text default null`
     params; insert into `ledger_events (ledger_id, event_type, title, body,
     actor_member_id, actor_email, metadata)`; actor via
     `public.current_ledger_member_id()`, email via `auth.jwt() ->> 'email'`.
   - Client-callable RPCs need `grant execute on function ... to authenticated;`.
   - `security definer` RPCs must gate access themselves (e.g. `is_ledger_admin`).
   - Qualify columns in RPC bodies (`tablename.column`) — the SQL ambiguity guard
     rejects names that collide with parameters.

3. **Register it** in `tools/test-migrations.mjs`: append the filename to the
   hardcoded `expected` array.

4. **Mirror it** in `supabase-schema.sql`: append a block with the same DDL /
   create-or-replace statements plus the tracker insert, so a fresh install replaying
   the consolidated schema ends in the same state (last definition wins).

5. **Regenerate the shared DB types (GV-223):** `npm run gen:db-types` (needs
   Docker) rewrites `types/database.ts` from the consolidated schema — commit it
   together with the migration. CI's `check:db-types` fails the PR when the
   committed types are stale.

6. **Validate:** `npm run validate` must pass. Then run
   `npm run check:schema-equivalence` (needs Docker) — it replays the migrations
   and the consolidated schema into disposable Postgres databases and diffs the
   results, catching what the grep guard can't (wrong columns, drifted function
   bodies, missing mirrors). CI runs it on every PR either way.

7. **Sync govehlo-web — BOTH artifacts, one commit (GV-172 + GV-223):**
   a. Set `EXPECTED_LATEST_MIGRATION` in `functions/api/owner/migrations.js` to this
      migration's number. The admin Health page compares it against what's actually
      applied in prod, so the console shows "not applied" the moment a migration
      merges but hasn't been run in the SQL Editor. Skipping this bump makes the
      drift check silently under-report.
   b. Re-vendor the generated types: run `npm run vendor:db-types` in fuel_sharing
      (with the sibling repos checked out) and commit the refreshed
      `types/database.ts` in **govehlo-web** and `src/types/database.generated.ts`
      in **govehlo-mobile**.

   **(b) is the step that goes missing.** Migrations 144/145/146 each shipped the
   govehlo-web commit for (a) and dropped (b) — because this checklist named only the
   constant — leaving web's types three migrations stale and the umbrella workflow red
   for 18 consecutive runs (GV-391). Mobile drifts less only by luck: mobile tickets
   call the new RPCs, so its copy gets refreshed by work that wouldn't compile
   otherwise. Web calls almost none of them, so nothing but this line pushes back.
   The umbrella workflow is the only CI that can see either copy.

8. **Ship:** branch + PR via `/ship`. In the PR body and to the user, state explicitly:
   **"SQL must be applied manually in the Supabase SQL Editor after merge."**

9. **After the user merges:** do not treat the migration as live until the user
   confirms they applied it. Features that depend on it should fail gracefully until
   then.

# Supabase migrations

This folder contains ordered database migrations for the Fuel Ledger Supabase backend.

The root `supabase-schema.sql` file remains the consolidated reference for fresh projects and quick review. New schema changes should be added as a new numbered migration in this folder first, then folded into `supabase-schema.sql` so both paths stay aligned.

## Current migration order

| File | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Core tables, indexes, seed ledger/member records, push subscriptions, and `ledger_events`. |
| `002_auth_helpers.sql` | Auth/member helper functions used by RLS and write guards. |
| `003_payment_booking_guards.sql` | Payment status/integrity triggers and booking overlap guard. |
| `004_period_close_and_admin_rpcs.sql` | Period-close RPC with fast guard behavior and admin production reset RPC. |
| `005_rls_policies.sql` | RLS enablement plus member/admin policies. |
| `006_realtime_ledger_events.sql` | Adds only `ledger_events` to Supabase Realtime for narrow in-app notifications. |
| `007_security_health_rpc.sql` | Lightweight read-only Security Health RPC. |
| `008_scheduled_reminder_rpcs.sql` | Service-role scheduled reminder RPCs. |

## Applying migrations manually

For an existing Supabase project, run only migrations that have not already been applied. The current files are intentionally idempotent where possible, but they still change policies/functions and should be reviewed before running.

Recommended manual process:

1. Back up the project or export current schema/data.
2. Open Supabase SQL Editor.
3. Run migrations in numeric order.
4. After running, verify:
   ```sql
   select name, email, role, is_active
   from ledger_members
   where ledger_id = 'main-car'
   order by name;
   ```
5. Run the app's Safe Test Lab.
6. Check Supabase stats for unexpected `close_settlement_period`, Realtime, or PostgREST spikes.

## Adding a new migration

1. Create the next numbered file, for example `009_some_change.sql`.
2. Keep it narrowly scoped and idempotent when possible.
3. Add comments at the top explaining what it changes and whether it is safe to rerun.
4. Update this table.
5. Fold the same change into the root `supabase-schema.sql` consolidated schema.
6. Run:
   ```bash
   npm run validate
   ```

## Important safety notes

- Do not use Security Health probes that call `close_settlement_period`; use `fuel_ledger_healthcheck`.
- Keep broad Supabase table Realtime off. Realtime should use the narrow `ledger_events` stream only.
- Reminder RPCs are for the backend service role only and should not be executable by `anon` or `authenticated`.


### Data retention/privacy cleanup

Admins can preview and run retention cleanup from Admin -> Data retention & privacy cleanup. The cleanup removes only temporary/privacy-sensitive records: expired/old `ledger_events`, stale push subscriptions, old local Test Lab reports, and old browser-local load-monitor entries. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history. Apply migration `009_retention_privacy_cleanup.sql` before using the cloud cleanup buttons.

### 018_realtime_publication_cleanup.sql

Narrows the Supabase Realtime publication to the lightweight `public.ledger_events` table by removing the broad legacy `public.car_share_ledgers` table when it is present. The migration is defensive: it only runs when the `supabase_realtime` publication exists, only drops `car_share_ledgers` if published, and ensures `ledger_events` remains published.


- `022_settlement_request_transaction_rpc.sql` adds `upsert_settlement_request_status` so settlement payment status updates and stale request cancellation happen atomically, and adds the RPC to Security Health critical checks.

- `023_schema_migration_tracking.sql` adds `public.fuel_ledger_schema_migrations`, backfills known migrations `001` through `023`, and extends Security Health with `schema_migrations` drift detection so admins can see missing migration IDs instead of manually guessing which SQL files were run.

- `024_schema_drift_healthcheck.sql` extends `fuel_ledger_healthcheck` with `schema_drift` checks for expected tables, key columns, and critical RLS policies. It also records `024_schema_drift_healthcheck` in `fuel_ledger_schema_migrations`.


### 025_workspace_foundation.sql

Adds private workspace/ledger isolation foundation for future public launch readiness: ledger slugs, invite/public-signup flags defaulting private, membership lookup indexes, and safe list/create workspace RPCs. This does not enable public self-serve onboarding.

### 026_invite_onboarding_foundation
Adds private invite onboarding foundation for future public workspace joins. Admins can create/revoke hashed invite codes and signed-in users can redeem them into a ledger. Public signup remains disabled; this is groundwork for invite-only onboarding, not a public launch switch.

- `027_invite_code_generation_pgcrypto_fix.sql` schema-qualifies pgcrypto random-byte generation for invite codes and records itself in migration tracking.
- `028_invite_code_hash_pgcrypto_fix.sql` schema-qualifies pgcrypto hashing for invite code storage and records itself in migration tracking.
- `029_invite_redeem_return_ambiguity_fix.sql` fixes ambiguous `ledger_id`/`role` return-column references in `redeem_ledger_invite`, so invite redemption works from the login auto-redeem flow and the signed-in dashboard join form.

### 030_onboarding_abuse_rate_limits

Adds server-side onboarding abuse monitoring/rate-limit storage and enforces throttles on private workspace creation, invite creation, and invite redemption. Public signup remains disabled.

- `033_onboarding_rate_limit_scope_key_alignment.sql` formalizes `ledger_onboarding_rate_limits.scope_key`, backfills existing rows safely, updates the onboarding rate-limit RPC to write `scope_key`, and moves Security Health migration expectations to 033.

- `034_invite_rate_limit_actor_email_ambiguity_fix.sql` renames the onboarding rate-limit RPC local actor email variable so invite creation no longer fails with an ambiguous `actor_email` column reference, and moves Security Health migration expectations to 034.

- `035_sql_ambiguity_guardrail.sql` hardens SQL naming after the invite `actor_email` ambiguity: the payment-status RPC now uses `safe_actor_email`, Security Health expects migration 035, and release validation includes `tools/test-sql-ambiguity-guard.mjs` to block future high-risk PL/pgSQL local variable names that collide with common table columns.

- 039_list_my_ledgers_dedup.sql - de-duplicates workspace selector rows returned by list_my_ledgers, preferring admin role when duplicate active member rows exist for the same signed-in email/workspace.

- `042_member_invite_only_creation_lockdown.sql` locks member onboarding to the invite flow: `upsert_ledger_member_admin` now updates or deactivates existing members only and rejects creating a brand-new member row (null `target_member_id`) for everyone, including the app owner. New members must redeem a workspace invite (`redeem_ledger_invite`). The Render `/api/members/manage` route enforces the same rule for defense-in-depth.

- `121_settlement_period_boundary.sql` completes migration 120's direct-write hardening by enforcing request/period ownership, checking and locking both old and new entry periods, binding null-period direct inserts, and covering settlement-bearing repairs.
- `137_settlement_event_history.sql` adds a privacy-minimised, append-only settlement lifecycle/reminder history. Active workspace members can read it, clients cannot mutate it, and a database trigger covers every current and future settlement write path.

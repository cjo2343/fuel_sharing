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

-- Migration 190: index trips by (ledger_id, trip_date desc) for the workspace read (GV-438)
--
-- Load exercise 2 (GV-438, docs/operations/load-rehearsal-evidence.md, 2026-08-08) aged
-- one workspace to 2.400 trips and measured every unbounded read. The activity feed is
-- index-served and FLAT (1,31 ms p95); the read that degrades is TRIPS — 2,66 → 34,14 ms,
-- linear in workspace history, because the fetch plans as a Seq Scan + top-N sort. A
-- client-side LIMIT does not help: Postgres still scans and sorts everything before
-- applying it.
--
-- This index is the measured cure: (ledger_id, trip_date desc) with the same
-- `deleted_at is null` predicate every live read carries, so the workspace fetch becomes
-- an index range scan in the order the client wants. Measured in the GV-438 harness:
-- 27,93 → 6,08 ms on the full aged fetch, and 1,66 ms once a fetch cap exists (GVM-535).
--
-- Partial on purpose: soft-deleted trips are invisible to every hot path (the mobile
-- gateway filters deleted_at, matching trips_deleted_at_idx's precedent), so they have
-- no business occupying the index.
--
-- No RPC, no table, no column, no RLS change — types/database.ts moves only its header
-- stamp. No ledger_event, nothing for GV-413. GDPR: an index stores no new data.

create index if not exists trips_ledger_trip_date_idx
  on public.trips (ledger_id, trip_date desc)
  where deleted_at is null;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '190_trips_ledger_trip_date_idx',
  'Index trips by (ledger_id, trip_date desc) where deleted_at is null (GV-438). Load exercise 2 aged a workspace to 2.400 trips and showed the trips read degrading linearly (2,66 -> 34,14 ms, Seq Scan + top-N sort; a LIMIT does not help because the sort happens first) while the feed stayed index-served and flat. This partial index makes the workspace trips fetch an index range scan in client order: measured 27,93 -> 6,08 ms on the full aged fetch and 1,66 ms with a fetch cap (GVM-535). Partial because every hot path filters deleted_at is null (trips_deleted_at_idx precedent). No RPC/table/column/RLS change, header-stamp-only for types; no ledger_event, nothing for GV-413; GDPR: an index stores no new data. Evidence: docs/operations/load-rehearsal-evidence.md, load exercise 2.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

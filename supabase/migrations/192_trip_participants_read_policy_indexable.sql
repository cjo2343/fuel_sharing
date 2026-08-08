-- Migration 192: trip_participants read policy answers from the row itself (GV-465)
--
-- Load exercise 2 (GV-438, evidence in docs/operations/load-rehearsal-evidence.md)
-- measured the workspace load's trip_participants read at ~60 ms p95 — the single
-- most expensive read — and the plan explains why: the policy's
--   exists (select 1 from trips t where t.id = trip_participants.trip_id
--           and is_ledger_member(t.ledger_id))
-- is DE-CORRELATED by the planner into a hashed SubPlan that Seq Scans the WHOLE
-- trips table, evaluating is_ledger_member once per trip across every workspace on
-- the platform (72,461 shared buffers at 2,425 platform trips). Its cost therefore
-- grows with the PLATFORM's trips, not this workspace's, and neither an index nor a
-- shorter id list helps (703 ids → 60.66 ms, 353 ids → 61.04 ms).
--
-- Two shapes were measured with the GV-438 aged harness before choosing:
--   1. a can_manage_trip-style helper, can_read_trip(trip_id) — kills the platform
--      scan (61 → 27.7 ms on the 353-id probe) but keeps ~80 µs/row of function
--      overhead (trips pkey probe + nested is_ledger_member + JWT parse per row),
--      leaving the 703-row read at 58 ms;
--   2. DENORMALIZE ledger_id ONTO THE ROW — the pattern migrations 138 and 169
--      established for incident photos and fuel receipts precisely "so the policy
--      answers without joining out". The policy becomes
--      is_ledger_member(trip_participants.ledger_id), the same per-row cost the
--      trips read itself pays (~12 µs/row).
-- This migration ships shape 2.
--
-- The column is stamped by a BEFORE INSERT OR UPDATE trigger from the trip row —
-- authoritative, so no writer changes (upsert_trip_with_participants keeps its
-- (trip_id, member_id) insert) and a direct UPDATE cannot point a row at a foreign
-- ledger: the trigger re-derives ledger_id from trips on every write. Backfill
-- updates every existing row before NOT NULL is applied.
--
-- WHO SEES WHAT DOES NOT CHANGE: a trip's ledger_id never changes after creation
-- (no reassignment path exists), so is_ledger_member(tp.ledger_id) is pointwise
-- identical to the old EXISTS over trips. Same policy name (pinned by the
-- schema-drift healthcheck), same to-authenticated scope; the write policies keep
-- can_manage_trip. The SELECT policies are dropped via a dynamic pg_policies sweep
-- rather than by name only, in case production's policy names have drifted (the
-- migration 103 lesson), then the canonical policy is recreated and the migration
-- asserts exactly one SELECT policy remains.

alter table public.trip_participants
  add column if not exists ledger_id text references public.ledgers(id) on delete cascade;

update public.trip_participants
   set ledger_id = t.ledger_id
  from public.trips t
 where t.id = trip_participants.trip_id
   and trip_participants.ledger_id is distinct from t.ledger_id;

alter table public.trip_participants
  alter column ledger_id set not null;

create or replace function public.set_trip_participant_ledger_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select t.ledger_id into new.ledger_id
    from public.trips t
   where t.id = new.trip_id;
  if new.ledger_id is null then
    raise exception 'Trip not found for participant row' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.set_trip_participant_ledger_id() from public;
revoke execute on function public.set_trip_participant_ledger_id() from anon;

drop trigger if exists set_trip_participant_ledger_id_trg on public.trip_participants;
create trigger set_trip_participant_ledger_id_trg
  before insert or update on public.trip_participants
  for each row
  execute function public.set_trip_participant_ledger_id();

do $$
declare
  v_policy record;
begin
  for v_policy in
    select pol.policyname
      from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'trip_participants'
       and pol.cmd = 'SELECT'
  loop
    execute format('drop policy %I on public.trip_participants', v_policy.policyname);
  end loop;
end;
$$;

drop policy if exists "Ledger members can read trip participants" on public.trip_participants;
create policy "Ledger members can read trip participants" on public.trip_participants
  for select to authenticated
  using (public.is_ledger_member(trip_participants.ledger_id));

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_policies pol
   where pol.schemaname = 'public'
     and pol.tablename = 'trip_participants'
     and pol.cmd = 'SELECT';
  if v_count <> 1 then
    raise exception 'expected exactly 1 SELECT policy on trip_participants, found %', v_count;
  end if;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '192_trip_participants_read_policy_indexable',
  'trip_participants read policy answers from the row itself (GV-465, measured in GV-438''s load exercise 2). The old policy''s EXISTS over trips was de-correlated by the planner into a hashed SubPlan that Seq Scanned the WHOLE trips table evaluating is_ledger_member per row — ~60 ms p95 at 2,425 platform trips, scaling with the PLATFORM''s trips rather than the workspace''s, unaffected by indexes or shorter id lists. Fix = the migration 138/169 pattern: ledger_id denormalized onto trip_participants so the policy is is_ledger_member(trip_participants.ledger_id) — the same per-row cost the trips read pays, no join, no platform coupling. A helper-function shape (can_manage_trip style) was measured first and rejected: it killed the platform scan but kept ~80 us/row of function overhead, leaving the 703-row read at 58 ms. The column is stamped by BEFORE INSERT OR UPDATE trigger set_trip_participant_ledger_id() (SECURITY DEFINER, execute revoked from public/anon) that re-derives ledger_id from trips on every write — writers unchanged (upsert_trip_with_participants still inserts (trip_id, member_id)), direct UPDATEs cannot point a row at a foreign ledger, and existing rows are backfilled before NOT NULL. WHO SEES WHAT IS UNCHANGED: a trip''s ledger never changes, so the new predicate is pointwise identical to the old EXISTS; same policy name (pinned by the schema-drift healthcheck), same to-authenticated scope; write policies keep can_manage_trip. SELECT policies dropped via a dynamic pg_policies sweep (migration 103 lesson) before the canonical recreate, then the migration asserts exactly one SELECT policy remains. Measured with the GV-438 aged harness: read:participants p95 58.49 ms before; after in the PR. No new event_type (nothing for GV-413); no client-callable RPC; GDPR-neutral (ledger_id is a workspace identifier already present on every sibling table).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

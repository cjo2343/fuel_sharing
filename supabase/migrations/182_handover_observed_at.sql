-- Migration 182: order handovers by when the car was OBSERVED, not when the row uploaded (GVM-552)
--
-- ── THE BUG ──────────────────────────────────────────────────────────────────
-- latestHandoverQuery (govehlo-mobile src/lib/handover.ts) picks the workspace's
-- "newest" handover with `order by created_at desc, id desc`, and that row is what
-- Bilen and the booking screen show as the car's CURRENT key/parking/condition. But
-- created_at is the moment the row was INSERTED, not the moment the handover was
-- filled in. Handovers queue in the mobile outbox and flush whenever the phone next
-- has a network, so a handover written on Monday while offline can arrive — and get
-- created_at — on the following Monday, AFTER a colleague's Tuesday online handover.
-- created_at then ranks the stale Monday reading first, and the group sees a week-old
-- parking spot / key location as the car's current state.
--
-- This is the same "confident wrong answer beats no answer" harm the location mirror
-- guards against (migrations 168/172/174) — arriving here through ORDERING instead of
-- through the mirror. The mirror protects ledgers.parking_location; nothing protected
-- the "latest handover" query itself.
--
-- ── THE FIX: an authoritative observation time ───────────────────────────────
-- A handover is the account of a booking that has ended, so the moment it describes is
-- the booking's END — car_bookings.end_at. We denormalise that onto the handover row as
-- `observed_at` and order by it. end_at is chosen (not "filled-in time") because it is
-- the single fact every party already agrees on, it cannot be gamed by a late upload,
-- and it is what a reader means by "most recently handed-over".
--
-- WHY A TRIGGER, NOT THE RPC. upsert_booking_handover (migration 174) is the only write
-- path today, but observed_at is a property of the booking, not of one RPC's arguments,
-- so it belongs at the table: a BEFORE INSERT OR UPDATE trigger derives it from the
-- booking every write, whatever the caller. That also keeps this migration off the
-- 300-line RPC body entirely — no byte-identical re-declaration, nothing for the
-- equivalence check to diff on the function.
--
-- WHY RE-ORDER ON UPDATE TOO. booking_id is the unique key and never changes, but a
-- booking's end_at can be corrected after the fact; recomputing observed_at on every
-- write keeps it true to the booking rather than freezing the first reading.
--
-- ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
-- It does NOT touch the handover's own history — the row, its fields and its
-- handover_created feed event are unchanged (HISTORY IS HISTORY, migration 174). It
-- only fixes which row is called "latest". It writes no ledger_event and adds no new
-- event_type, so there is nothing for GV-413 to classify. GDPR: no new category of
-- data (end_at is already stored on the booking), no new recipient, no new retention
-- question — observed_at is a copy of a timestamp the workspace already holds.
--
-- ── PREREQUISITE FOR GVM-553 ─────────────────────────────────────────────────
-- The handover↔fuel-model re-anchor (GVM-553) may only adopt "the latest handover" as a
-- tank anchor once "latest" means observation time — otherwise a late offline upload
-- would re-anchor the fuel model BACKWARDS. This migration is that safety rail.

-- The observation time: the booking's end. Added NOT NULL with a now() default so the
-- column exists on every row immediately; the backfill below then sets the true value
-- and the trigger keeps it true from here on.
alter table public.booking_handovers
  add column if not exists observed_at timestamptz not null default now();

comment on column public.booking_handovers.observed_at is
  'When the car was actually handed over — the booking''s end_at, denormalised here so '
  '"latest handover" can be ordered by OBSERVATION time rather than created_at (row '
  'insert time). Fixes a late offline-outbox flush ranking a stale handover as current '
  '(GVM-552). Maintained by trigger set_handover_observed_at_trg; do not write it directly.';

-- Backfill existing rows from the booking they describe. booking_id is NOT NULL and FK
-- to car_bookings, so the join always matches; coalesce guards the impossible-in-schema
-- (end_at is NOT NULL) case anyway.
update public.booking_handovers bh
set observed_at = coalesce(cb.end_at, bh.created_at)
from public.car_bookings cb
where bh.booking_id = cb.id;

-- Derive observed_at from the booking on every insert/update. Column-qualified
-- throughout so the SQL ambiguity guard has nothing to flag.
create or replace function public.set_handover_observed_at()
returns trigger
language plpgsql
as $$
begin
  new.observed_at := coalesce(
    (select cb.end_at from public.car_bookings cb where cb.id = new.booking_id),
    new.created_at,
    now()
  );
  return new;
end;
$$;

drop trigger if exists set_handover_observed_at_trg on public.booking_handovers;
create trigger set_handover_observed_at_trg
  before insert or update on public.booking_handovers
  for each row execute function public.set_handover_observed_at();

-- Re-point the "recent handover" index at observed_at. Migration 164 built
-- booking_handovers_ledger_recent_idx as (ledger_id, created_at desc, id) for exactly
-- this single-row scan; the replacement carries observed_at so the fast path and the
-- ordering agree. Named afresh (…_observed_idx) so a stale definition can never linger.
drop index if exists public.booking_handovers_ledger_recent_idx;
create index if not exists booking_handovers_ledger_observed_idx
  on public.booking_handovers (ledger_id, observed_at desc, id);

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '182_handover_observed_at',
  'Order handovers by when the car was OBSERVED, not when the row uploaded (GVM-552). latestHandoverQuery ranked the workspace''s "newest" handover by created_at (row INSERT time), but handovers queue in the mobile outbox and flush whenever the phone next has a network, so a handover filled in on Monday while offline can arrive — and get created_at — the following Monday, AFTER a colleague''s Tuesday online handover, and the stale Monday parking/keys/condition then shows as the car''s current state. Fix: denormalise the booking''s end_at onto the handover row as observed_at (NOT NULL, default now(), backfilled from car_bookings.end_at) and order by it; a BEFORE INSERT OR UPDATE trigger set_handover_observed_at_trg keeps it derived from the booking on every write, so the value belongs to the booking rather than to one RPC''s arguments and upsert_booking_handover is not touched. The index booking_handovers_ledger_recent_idx (ledger_id, created_at desc, id) from migration 164 is dropped and replaced by booking_handovers_ledger_observed_idx (ledger_id, observed_at desc, id) so the fast single-row scan and the ordering agree. Recomputed on UPDATE too because a booking''s end_at can be corrected after the handover is written. The handover row, its fields and its handover_created feed event are unchanged (HISTORY IS HISTORY) — only which row is called "latest" changes; no new event_type, nothing for GV-413. GDPR: observed_at is a copy of a timestamp the workspace already holds on the booking, so no new category of data, recipient or retention question. Prerequisite for GVM-553 (handover->fuel-model re-anchor), which may only adopt the latest handover as a tank anchor once latest means observation time.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

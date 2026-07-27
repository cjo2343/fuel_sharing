-- Migration 156: a server-derived tank model revision replaces the client-chosen watermark (GV-415)
--
-- Migrations 154 and 155 are ALREADY APPLIED in production, so both are left untouched
-- and everything here is re-declared off 155's definitions — the newest prior ones.
--
-- ── What was wrong ──────────────────────────────────────────────────────────────
-- The stamped tank state (migration 154) carries a freshness proof the CLIENT chooses:
-- `as_of`, the newest greatest(created_at, updated_at) across the trips and fuel rows it
-- loaded. Migration 155 documented two residuals of that design and an external review
-- then found exactly the same two independently (GV-415, findings 3 and 4):
--
--   1. An EQUAL watermark could overwrite with DIFFERENT numbers. 155's condition is
--      `tank_state_as_of <= as_of_value`, and `<=` is deliberate — a re-sent write from
--      the offline outbox must stay idempotent. But it also lets a second device, an
--      older app version or a hand-rolled client send its own plausible result under the
--      same watermark, and the last writer wins. The contract test covered "same data in,
--      same numbers out"; it did not cover "same watermark, different numbers".
--
--   2. The watermark only covers trips and fuel_payments. Changing the car's consumption
--      or tank capacity (update_ledger_fuel_settings, migration 125) or its tank baseline
--      (set_tank_baseline, migration 092) changes what the model computes but moves NO
--      watermark, so an old and a new basis share one.
--
--   3. A deletion does not invalidate the stamp. 155 made the freshness gate ignore
--      tombstones because a tombstone is permanently newer than any watermark the client
--      can produce (ledger-data-gateway.ts loads both tables with `deleted_at is null`),
--      which had killed pre-departure reminders outright. The honest cost, written into
--      155 line ~44: between an admin correction and the next tank-changing write the
--      server may still be counting a trip that has been removed.
--
-- All three are the same defect wearing three hats: the freshness proof is derived from
-- what the CLIENT can see, and the client cannot see settings, baselines or tombstones.
--
-- ── What replaces it: ledgers.tank_model_revision ───────────────────────────────
-- A plain counter on the workspace, bumped by every write path that changes an input of
-- the tank model, and a second column recording which revision the stored stamp was
-- computed from:
--
--   tank_model_revision  — the server's count of model-input changes. Never decreases.
--   tank_state_revision  — the revision the stored stamp belongs to.
--
-- The freshness gate is then an equality (`tank_state_revision = tank_model_revision`)
-- rather than a timestamp comparison, and finding 3 stops being a special case: the
-- delete path bumps the counter like every other write, so a tombstone marks the stamp
-- stale as a CONSEQUENCE of the general rule rather than as an exception to it.
--
-- A counter rather than a digest, deliberately. A digest over the model inputs would be
-- self-verifying — the client could prove its basis matched — but it must be recomputed
-- over every trip and fuel row on each read, it is exactly as strong as the columns
-- someone remembered to hash, and it cannot be compared for ORDER, which is what tells a
-- late offline flush from a fresh write. A counter is O(1), monotonic, orderable, and its
-- coverage is a list of triggers a reviewer can read.
--
-- ── Where the bump lives: TRIGGERS, not the RPCs ────────────────────────────────
-- Explicit bumps inside each write RPC would miss the writes that do not go through one,
-- and the most important invalidating write in the system is exactly that:
-- govehlo-web/functions/api/owner/workspace/[id]/soft-delete.js PATCHes `deleted_at`
-- straight onto trips and fuel_payments with the service role. That admin correction is
-- the very scenario finding 3 is about. Triggers also cover any future RPC for free,
-- which is the failure mode this repo keeps hitting from the other side (a write path
-- that forgets to log a ledger_event does not push to other members, migration 087).
--
-- The trips/fuel_payments triggers are STATEMENT-level with transition tables, so the
-- set-based soft-delete above costs one bump for the whole PATCH rather than one per row.
--
-- Which UPDATEs count is decided by comparing the two transition rows as jsonb minus an
-- EXCLUDE list, not by a column list on the trigger — partly because Postgres refuses to
-- combine a column list with transition tables at all, but mostly because the exclude list
-- is the safe direction. An include list ("bump for start_km, end_km, trip_date…") fails
-- OPEN: add a column the model reads and forget to list it, and stamps silently stop being
-- invalidated with nothing to notice. An exclude list fails CLOSED — an unlisted column
-- invalidates a stamp that maybe did not need invalidating, and the client re-stamps.
--
-- Two columns are excluded, both pure bookkeeping the tank model cannot see:
--   • period_id — promote_settlement_carryover_on_open (migration 140) re-points it across
--     a whole queued period on every period open. Bumping there would invalidate the stamp
--     for a change that alters no number, and the client would NOT re-stamp for it: its
--     recomputed payload is byte-identical and the mobile service dedupes on the payload,
--     so the reminders would simply stay off.
--   • updated_at — a touch that carries no other change is not a change.
--
-- The ledgers trigger is BEFORE UPDATE on the row itself and only bumps when a model
-- input genuinely changed (`is distinct from`), so a no-op settings save or a re-recorded
-- identical baseline does not invalidate anything.
--
-- SECURITY DEFINER on the statement trigger is load-bearing, not decoration: migration
-- 125 revoked UPDATE on public.ledgers from authenticated, and RLS would filter the bump
-- to zero rows without an error. A silent no-op there would leave the counter frozen and
-- every stamp permanently "fresh" — the whole mechanism dead with nothing failing.
--
-- ── The write path, and how the mobile client keeps working ─────────────────────
-- set_tank_state gains a SEVENTH parameter, `expected_model_revision`: the revision the
-- client read BEFORE computing, sent back with the result. The server applies the stamp
-- only if the workspace is still at that revision, and within one revision only the FIRST
-- stamp wins — a second one carrying different numbers is refused rather than allowed to
-- overwrite (finding 1). An identical re-send stays a quiet success, so the offline
-- outbox is unaffected.
--
-- The six-argument signature STAYS, as an overload, and keeps its own body. govehlo-mobile
-- (GVM-480: src/lib/tank-state-stamp.ts, src/store/ledger-tank-state-service.ts) calls it
-- with six named arguments today and must keep working unchanged until the mobile
-- follow-up ships; PostgREST resolves an RPC by the set of argument NAMES in the body, so
-- six named arguments reach the legacy overload and seven reach the new one, with no
-- ambiguity (the seventh parameter deliberately has NO default — a default would make the
-- six-argument call ambiguous and every existing stamp would start failing).
--
-- The legacy overload is not merely tolerated, it is HARDENED:
--   • it gets finding 1's fix in full — an equal watermark now only applies when the
--     numbers are identical, and differing numbers under the same watermark are refused;
--   • it records tank_state_revision = the workspace's revision at write time, so
--     findings 2 and 3 are fixed for it too, for every bump that happens AFTER its write.
--
-- What it cannot have is the read-compute-write window: a bump landing between the
-- client's read and its write is credited to the stamp. That is why 155's `as_of` gate is
-- KEPT ALONGSIDE the revision gate in claim_due_booking_fuel_reminders rather than
-- replaced by it — for a six-argument caller the as_of comparison is the only thing that
-- still catches a trip or fuel row written inside that window, and dropping it would have
-- made this migration a regression for the only client that exists today. The two gates
-- are complementary: as_of catches what the client could see, the revision catches what
-- it could not.
--
-- Delegating the legacy overload to the new one was considered and rejected: the wrapper
-- would have to read the current revision and pass it, which is precisely the "credit the
-- client with a revision it never saw" move — a device flushing a stale offline write
-- would then have its numbers accepted as fresh, which 155's as_of check refuses today.
--
-- The transition is expand/contract. 156 expands; the mobile follow-up reads
-- ledgers.tank_model_revision, sends it as expected_model_revision, and includes it in
-- tankStampKey's dedupe identity; a later migration contracts by retiring the six-argument
-- overload (migration 147's pattern). Until that lands, one narrow residual exists and is
-- stated rather than hidden: if a soft delete changes the modelled numbers not at all, the
-- mobile service's payload dedupe suppresses the re-stamp, tank_state_revision stays
-- behind and that workspace's pre-departure reminders go quiet until the next real change
-- or the next cold start. That is fail-CLOSED (no nudge) where 155 was fail-open (a nudge
-- computed on a deleted trip), and it disappears entirely once the revision is part of the
-- dedupe key.

-- ── Columns ─────────────────────────────────────────────────────────────────────

alter table public.ledgers
  add column if not exists tank_model_revision bigint not null default 0;

alter table public.ledgers
  add column if not exists tank_state_revision bigint;

comment on column public.ledgers.tank_model_revision is
  'Server-derived revision of the tank model INPUTS: bumped by every write that changes a trip, a fuel payment, the car''s consumption/capacity settings or its tank baseline, including soft deletes and including writes that never touch an RPC (the admin console PATCHes deleted_at directly). Monotonic, never reset. Replaces the client-chosen ledgers.tank_state_as_of watermark as the authoritative freshness proof (GV-415): the client cannot see settings changes, baseline changes or tombstones, so a proof derived from the rows it loaded can never cover them.';

comment on column public.ledgers.tank_state_revision is
  'The tank_model_revision the stored stamp (tank_state_liters and friends) was computed from. The stamp is FRESH exactly while this equals tank_model_revision. Written by set_tank_state: from the client''s own expected_model_revision on the seven-argument signature, or — on the legacy six-argument overload govehlo-mobile still calls — from the workspace''s revision at write time, which cannot account for a bump landing between the client''s read and its write. NULL means a stamp older than migration 156 that was never re-written; migration 156 backfills 0 for the stamps that existed when it ran, so they stay fresh until the first real model change.';

comment on column public.ledgers.tank_state_as_of is
  'Data watermark of the stamped tank state: the newest greatest(created_at, updated_at) across the trips and fuel_payments the client consumed when it computed tank_state_liters. NOT a wall-clock write time. Since GV-415 this is the SECONDARY freshness proof — tank_state_revision is the primary one — and it is kept because it is the only thing that catches a trip or fuel row written between a legacy six-argument caller''s read and its write, a window the server-side revision stamp cannot see. It also still orders two legacy stamps: a client that has seen less data carries an older watermark and cannot overwrite a fresher one.';

-- Every stamp that exists when this migration runs was computed against revision 0 by
-- definition — nothing has bumped the counter yet. Without this backfill the new gate
-- would read every stored stamp as stale the moment 156 is applied and pre-departure
-- reminders would stop for every workspace until each one's app was next opened.
update public.ledgers l
   set tank_state_revision = 0
 where l.tank_state_as_of is not null
   and l.tank_state_revision is null;

-- ── The bump ────────────────────────────────────────────────────────────────────

-- Statement-level, with transition tables, so one PATCH over a whole workspace costs one
-- bump. TG_OP branches because a transition table only exists for the operation its
-- trigger was declared for: PL/pgSQL prepares each SQL statement on first execution of
-- the branch containing it, so the `old_rows` branch is never planned in an INSERT
-- trigger. All three paths are exercised by tools/test-fuel-stop-verdict-contract.mjs
-- (insert, soft delete, hard delete) precisely because that is a property of when
-- statements are planned rather than of the code being read.
--
-- The UPDATE branch is table-agnostic on purpose: trips and fuel_payments share this one
-- function, so the change test is a whole-row jsonb comparison minus the bookkeeping keys
-- rather than a per-table column list. `values (n.ledger_id), (o.ledger_id)` bumps BOTH
-- workspaces when a row moves between them, which is the only way for one statement to
-- change two models at once.
create or replace function public.bump_tank_model_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.ledgers l
       set tank_model_revision = l.tank_model_revision + 1
     where l.id in (select r.ledger_id from new_rows r);
  elsif tg_op = 'DELETE' then
    update public.ledgers l
       set tank_model_revision = l.tank_model_revision + 1
     where l.id in (select r.ledger_id from old_rows r);
  else
    update public.ledgers l
       set tank_model_revision = l.tank_model_revision + 1
     where l.id in (
       select touched.ledger_id
       from new_rows n
       join old_rows o on o.id = n.id
       cross join lateral (values (n.ledger_id), (o.ledger_id)) as touched(ledger_id)
       where (to_jsonb(n) - 'updated_at' - 'period_id')
             is distinct from (to_jsonb(o) - 'updated_at' - 'period_id')
     );
  end if;
  return null;
end;
$$;

revoke all on function public.bump_tank_model_revision() from public;
revoke all on function public.bump_tank_model_revision() from anon;
revoke all on function public.bump_tank_model_revision() from authenticated;

-- Six triggers rather than two: transition tables may only be declared for a trigger with
-- a SINGLE event, so insert, update and delete each need their own.
drop trigger if exists bump_tank_model_revision_trips_insert on public.trips;
create trigger bump_tank_model_revision_trips_insert
after insert on public.trips
referencing new table as new_rows
for each statement execute function public.bump_tank_model_revision();

drop trigger if exists bump_tank_model_revision_trips_update on public.trips;
create trigger bump_tank_model_revision_trips_update
after update on public.trips
referencing old table as old_rows new table as new_rows
for each statement execute function public.bump_tank_model_revision();

drop trigger if exists bump_tank_model_revision_trips_delete on public.trips;
create trigger bump_tank_model_revision_trips_delete
after delete on public.trips
referencing old table as old_rows
for each statement execute function public.bump_tank_model_revision();

drop trigger if exists bump_tank_model_revision_fuel_insert on public.fuel_payments;
create trigger bump_tank_model_revision_fuel_insert
after insert on public.fuel_payments
referencing new table as new_rows
for each statement execute function public.bump_tank_model_revision();

drop trigger if exists bump_tank_model_revision_fuel_update on public.fuel_payments;
create trigger bump_tank_model_revision_fuel_update
after update on public.fuel_payments
referencing old table as old_rows new table as new_rows
for each statement execute function public.bump_tank_model_revision();

drop trigger if exists bump_tank_model_revision_fuel_delete on public.fuel_payments;
create trigger bump_tank_model_revision_fuel_delete
after delete on public.fuel_payments
referencing old table as old_rows
for each statement execute function public.bump_tank_model_revision();

-- The other half of finding 2: the car's own settings. BEFORE UPDATE on the row itself,
-- so the bump rides on the same tuple version as the change and no second write is
-- needed — which also means it cannot recurse when the statement triggers above update
-- this table (they touch no model column, so `is distinct from` is false throughout).
--
-- tank_baseline_recorded_at is deliberately NOT in the list. set_tank_baseline rewrites
-- it on every call, but re-recording the same odometer and fraction changes nothing the
-- model computes, and an invalidation the client will not re-stamp for is a reminder
-- switched off for no reason.
create or replace function public.bump_tank_model_revision_on_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.estimated_consumption_l_per_100km is distinct from old.estimated_consumption_l_per_100km
     or new.fuel_tank_capacity_l is distinct from old.fuel_tank_capacity_l
     or new.tank_baseline_odometer is distinct from old.tank_baseline_odometer
     or new.tank_baseline_fraction is distinct from old.tank_baseline_fraction then
    new.tank_model_revision := coalesce(old.tank_model_revision, 0) + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_tank_model_revision_on_ledger() from public;
revoke all on function public.bump_tank_model_revision_on_ledger() from anon;
revoke all on function public.bump_tank_model_revision_on_ledger() from authenticated;

drop trigger if exists bump_tank_model_revision_ledger on public.ledgers;
create trigger bump_tank_model_revision_ledger
before update of estimated_consumption_l_per_100km, fuel_tank_capacity_l,
                 tank_baseline_odometer, tank_baseline_fraction
on public.ledgers
for each row execute function public.bump_tank_model_revision_on_ledger();

-- ── Shared input validation ─────────────────────────────────────────────────────

-- Migration 155's bounds, extracted so the two set_tank_state overloads cannot drift
-- apart while both exist. Returns the normalised spread rather than a boolean, because
-- the normalisation and the ceiling that applies to it are the same rule: safeConsumption
-- in govehlo-mobile/src/lib/refuel-plan.ts is consumption + (spread > 0 ? spread : 0), and
-- that sum is the burn the verdict actually plans on.
--
-- The envelope is migration 125's update_ledger_fuel_settings range on the very settings
-- columns these numbers derive from (consumption 0.1–100 L/100 km, capacity 1–500 L),
-- upper half only, so no honest client output and no pre-125 legacy setting is newly
-- refused. Rejections RAISE rather than clamp: a silent clamp would store numbers the
-- client never computed and then nudge the whole workspace on them.
create or replace function public.validated_tank_state_spread(
  liters_value numeric,
  consumption_value numeric,
  spread_value numeric,
  capacity_value numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_spread numeric;
begin
  if liters_value is null or liters_value < 0 then
    raise exception 'Tank state litres must be zero or greater' using errcode = '23514';
  end if;

  if consumption_value is null or consumption_value <= 0 then
    raise exception 'Tank state consumption must be greater than zero' using errcode = '23514';
  end if;

  if capacity_value is null or capacity_value <= 0 then
    raise exception 'Tank state capacity must be greater than zero' using errcode = '23514';
  end if;

  if liters_value > capacity_value then
    raise exception 'Tank state litres cannot exceed the tank capacity' using errcode = '23514';
  end if;

  if capacity_value > 500 then
    raise exception 'Tank state capacity must be 500 litres or less' using errcode = '23514';
  end if;

  if consumption_value > 100 then
    raise exception 'Tank state consumption must be 100 per 100 km or less' using errcode = '23514';
  end if;

  -- Mirrors safeConsumption's tolerance: a non-positive or absent spread collapses to
  -- zero rather than being rejected.
  normalized_spread := case when spread_value is not null and spread_value > 0 then spread_value else 0 end;

  if consumption_value + normalized_spread > 100 then
    raise exception 'Tank state consumption plus spread must be 100 per 100 km or less' using errcode = '23514';
  end if;

  return normalized_spread;
end;
$$;

revoke all on function public.validated_tank_state_spread(numeric, numeric, numeric, numeric) from public;
revoke all on function public.validated_tank_state_spread(numeric, numeric, numeric, numeric) from anon;
revoke all on function public.validated_tank_state_spread(numeric, numeric, numeric, numeric) from authenticated;

-- ── set_tank_state: the revision-carrying signature ─────────────────────────────

-- The client reads ledgers.tank_model_revision, computes its model from the rows it holds
-- at that revision, and sends the revision back with the result. The server then decides
-- what the numbers are worth instead of taking the client's word for it.
--
-- Three outcomes, all of them a plain return rather than an exception, because losing is
-- NORMAL — a queued offline write flushing late is computed from data the server has
-- moved past, and govehlo-mobile treats `applied: false` as a quiet no-op it never
-- retries:
--
--   applied            the stamp is stored;
--   stale_revision     the workspace moved on; recompute and stamp again;
--   value_conflict     someone already stamped THIS revision with different numbers.
--
-- value_conflict is finding 1. Within one revision the model inputs are identical, so two
-- different answers cannot both be right and there is nothing in the data to choose
-- between them — the first stamp at a revision was computed from a complete view of that
-- revision, so first writer wins and the second is refused rather than allowed to
-- overwrite. An IDENTICAL re-send is not a conflict and applies quietly, which is what
-- keeps the offline outbox idempotent.
--
-- The condition rides ON the update, one statement, as migration 155 established: a plain
-- select takes no row lock, so two devices could both pass a separate check and the loser
-- commit last. Under READ COMMITTED a loser blocked on the winner's row lock re-evaluates
-- this WHERE against the row version the winner committed and matches nothing.
--
-- as_of is still stored and still validated, but it is NOT a gate here: after a soft
-- delete the client's watermark can legitimately move BACKWARDS (the newest row it could
-- see is gone), and refusing that would leave the stamp frozen at the deleted row's
-- timestamp forever. The revision orders these writes; as_of only describes them.
create or replace function public.set_tank_state(
  target_ledger_id text,
  liters_value numeric,
  as_of_value timestamptz,
  consumption_value numeric,
  spread_value numeric,
  capacity_value numeric,
  expected_model_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_as_of timestamptz;
  normalized_spread numeric;
  stored_model_revision bigint;
  stored_state_revision bigint;
begin
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only an active workspace member can record tank state' using errcode = '42501';
  end if;

  if as_of_value is null then
    raise exception 'Tank state needs an as-of watermark' using errcode = '23514';
  end if;

  -- A watermark from the future would make every later staleness check pass forever and
  -- could lock out every subsequent stamp. It can only come from a client bug, so it
  -- raises rather than no-ops. One minute of slack absorbs ordinary clock skew.
  if as_of_value > now() + interval '1 minute' then
    raise exception 'Tank state as-of cannot be in the future' using errcode = '23514';
  end if;

  if expected_model_revision is null then
    raise exception 'Tank state needs the model revision it was computed from' using errcode = '23514';
  end if;

  normalized_spread := public.validated_tank_state_spread(
    liters_value, consumption_value, spread_value, capacity_value
  );

  update public.ledgers l
     set tank_state_liters = liters_value,
         tank_state_as_of = as_of_value,
         tank_state_consumption = consumption_value,
         tank_state_consumption_spread = normalized_spread,
         tank_state_capacity = capacity_value,
         tank_state_revision = expected_model_revision,
         updated_at = now()
   where l.id = target_ledger_id
     and l.tank_model_revision = expected_model_revision
     and (
       l.tank_state_revision is null
       or l.tank_state_revision < expected_model_revision
       or (
         l.tank_state_revision = expected_model_revision
         and l.tank_state_liters is not distinct from liters_value
         and l.tank_state_consumption is not distinct from consumption_value
         and coalesce(l.tank_state_consumption_spread, 0) is not distinct from normalized_spread
         and l.tank_state_capacity is not distinct from capacity_value
       )
     )
  returning l.tank_state_as_of into saved_as_of;

  if found then
    return jsonb_build_object(
      'ledger_id', target_ledger_id,
      'applied', true,
      'tank_state_liters', liters_value,
      'tank_state_as_of', saved_as_of,
      'tank_state_revision', expected_model_revision,
      'tank_model_revision', expected_model_revision
    );
  end if;

  -- Nothing was updated, which is three different situations: the workspace does not
  -- exist, the workspace has moved past this revision, or this revision is already
  -- stamped with different numbers. Read it back to tell them apart.
  select l.tank_model_revision, l.tank_state_revision, l.tank_state_as_of
    into stored_model_revision, stored_state_revision, saved_as_of
  from public.ledgers l
  where l.id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;

  -- tank_model_revision only ever increases, so a client cannot honestly hold one that is
  -- ahead of the server's. This is a fabricated call, a revision read off a different
  -- workspace, or a database restored behind its clients — none of them a losing race, so
  -- it raises like the future-watermark check above rather than passing as a quiet no-op.
  if expected_model_revision > stored_model_revision then
    raise exception 'Tank state model revision is ahead of the workspace' using errcode = '23514';
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'applied', false,
    'reason', case when expected_model_revision < stored_model_revision
                   then 'stale_revision' else 'value_conflict' end,
    'stored_as_of', saved_as_of,
    'stored_revision', stored_state_revision,
    'tank_model_revision', stored_model_revision
  );
end;
$$;

revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric, bigint) from public;
revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric, bigint) from anon;
grant execute on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric, bigint) to authenticated;

-- ── set_tank_state: the legacy six-argument overload ────────────────────────────

-- The signature govehlo-mobile calls today (GVM-480). It stays, unchanged in shape and in
-- return contract, until the mobile follow-up ships — a breaking signature with no caller
-- updated is how a working feature goes dark.
--
-- It is hardened rather than frozen:
--   • finding 1 is fixed in full. 155's `tank_state_as_of <= as_of_value` is split into
--     "strictly newer" OR "equal AND identical numbers", so a re-send is still idempotent
--     but a second device cannot slip different numbers under the same watermark. The
--     refusal reason for that case is `value_conflict`, the same word the seven-argument
--     signature uses for the same event; a genuinely older watermark keeps `stale_as_of`,
--     which the mobile client and tools/test-rls-role-matrix.mjs both name.
--   • it records tank_state_revision, so findings 2 and 3 hold for it as well from the
--     moment of the write onwards.
--
-- What it cannot do is prove which revision the client actually computed from: it is told
-- a watermark, not a revision, so it credits the stamp with the workspace's revision AT
-- WRITE TIME. A bump landing between the client's read and its write is therefore
-- mis-credited — which is exactly why claim_due_booking_fuel_reminders keeps 155's as_of
-- comparison beside the new revision equality. For a six-argument caller the as_of gate is
-- the only thing that still catches a trip or fuel row written inside that window.
create or replace function public.set_tank_state(
  target_ledger_id text,
  liters_value numeric,
  as_of_value timestamptz,
  consumption_value numeric,
  spread_value numeric,
  capacity_value numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_as_of timestamptz;
  saved_revision bigint;
  normalized_spread numeric;
  stored_model_revision bigint;
  stored_state_revision bigint;
begin
  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only an active workspace member can record tank state' using errcode = '42501';
  end if;

  if as_of_value is null then
    raise exception 'Tank state needs an as-of watermark' using errcode = '23514';
  end if;

  if as_of_value > now() + interval '1 minute' then
    raise exception 'Tank state as-of cannot be in the future' using errcode = '23514';
  end if;

  normalized_spread := public.validated_tank_state_spread(
    liters_value, consumption_value, spread_value, capacity_value
  );

  -- Monotonic on as_of, in ONE statement (migration 155), now with finding 1's fix folded
  -- into the equality branch: an equal watermark applies only when it carries the same
  -- numbers. tank_state_revision is read off the row being updated, so it is the revision
  -- this write lands on rather than one read a statement earlier.
  update public.ledgers l
     set tank_state_liters = liters_value,
         tank_state_as_of = as_of_value,
         tank_state_consumption = consumption_value,
         tank_state_consumption_spread = normalized_spread,
         tank_state_capacity = capacity_value,
         tank_state_revision = l.tank_model_revision,
         updated_at = now()
   where l.id = target_ledger_id
     and (
       l.tank_state_as_of is null
       or l.tank_state_as_of < as_of_value
       or (
         l.tank_state_as_of = as_of_value
         and l.tank_state_liters is not distinct from liters_value
         and l.tank_state_consumption is not distinct from consumption_value
         and coalesce(l.tank_state_consumption_spread, 0) is not distinct from normalized_spread
         and l.tank_state_capacity is not distinct from capacity_value
       )
     )
  returning l.tank_state_as_of, l.tank_state_revision into saved_as_of, saved_revision;

  if found then
    return jsonb_build_object(
      'ledger_id', target_ledger_id,
      'applied', true,
      'tank_state_liters', liters_value,
      'tank_state_as_of', saved_as_of,
      'tank_state_revision', saved_revision,
      'tank_model_revision', saved_revision
    );
  end if;

  -- Nothing was updated: the workspace does not exist, a fresher watermark is already
  -- stored, or this exact watermark is stored with different numbers. The refusal is a
  -- no-op return rather than an exception because a losing race is normal; callers read
  -- `applied` to tell the two apart.
  select l.tank_model_revision, l.tank_state_revision, l.tank_state_as_of
    into stored_model_revision, stored_state_revision, saved_as_of
  from public.ledgers l
  where l.id = target_ledger_id;

  if not found then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'applied', false,
    'reason', case when saved_as_of = as_of_value then 'value_conflict' else 'stale_as_of' end,
    'stored_as_of', saved_as_of,
    'stored_revision', stored_state_revision,
    'tank_model_revision', stored_model_revision
  );
end;
$$;

revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from public;
revoke all on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) from anon;
grant execute on function public.set_tank_state(text, numeric, timestamptz, numeric, numeric, numeric) to authenticated;

-- ── The freshness gate ──────────────────────────────────────────────────────────

-- Lease the bookings that need a pre-departure fuel-stop push, newest lease wins for
-- 15 minutes. Due-ness is decided HERE rather than in the caller so the endpoint
-- (GV-406) cannot accidentally relax it, and so the whole predicate is one thing to
-- test.
--
-- A booking is due when ALL of these hold:
--   • it starts within the next 3 hours and has not started yet;
--   • it is neither soft-deleted nor cancelled — car_bookings has no status column, so
--     cancellation IS the soft delete (deleted_at), which is what cancel_booking writes;
--   • its workspace is not itself soft-deleted (migration 132) — a decommissioned car
--     must go quiet, and the RLS-side helpers all check this, but this RPC runs as
--     service_role and would otherwise never see it;
--   • the booked member is still active and reachable by email;
--   • it has never been reminded and carries no live lease;
--   • its fuel_stop is an object with a usable numeric distanceKm;
--   • the car has a complete stamped tank state;
--   • NOTHING has happened to the car since that stamp — see below;
--   • and the verdict over the CURRENT tank state is not 'holds'.
--
-- The staleness gate is TWO comparisons since GV-415, and they are complementary rather
-- than redundant:
--
--   1. tank_state_revision = tank_model_revision. The server's own count of model-input
--      changes, bumped by triggers on trips, fuel_payments and the car's settings and
--      baseline columns. This is the authoritative half: it covers what the client cannot
--      see at all — a soft-deleted trip or fuel row, a consumption or capacity change, a
--      re-recorded baseline, and any write that never goes through an RPC (the admin
--      console PATCHes deleted_at directly). Migration 155 had to exclude tombstones from
--      the comparison below because a tombstone is permanently newer than any watermark
--      the client can produce, and counting one silenced a whole workspace's reminders for
--      good; with a server-side revision a deletion invalidates the stamp as an ordinary
--      consequence, and it is undone by the client simply re-stamping.
--
--   2. 155's as_of comparison, unchanged, tombstones still excluded. It stays because the
--      six-argument set_tank_state overload — which is what govehlo-mobile still calls —
--      cannot tell the server which revision the client computed from and credits the
--      stamp with the revision at WRITE time. A trip or fuel row written between that
--      client's read and its write is therefore invisible to (1) and caught only here.
--      Dropping it would have made this migration a regression for the only live client.
--
-- greatest(created_at, updated_at) rather than created_at alone because an EDIT to an old
-- trip invalidates the stamp exactly as a new row does.
create or replace function public.claim_due_booking_fuel_reminders(
  p_limit integer default 200
)
returns table (
  booking_id uuid,
  ledger_id text,
  member_id uuid,
  member_email text,
  verdict text,
  reserve_km numeric,
  stored_stop_km numeric,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select cb.id as target_booking_id,
           public.fuel_stop_revalidation_verdict(
             cb.fuel_stop,
             l.tank_state_liters,
             l.tank_state_consumption,
             coalesce(l.tank_state_consumption_spread, 0),
             l.tank_state_capacity,
             -- DEFAULT_REVALIDATION_DEADBAND_KM = 10 in
             -- govehlo-mobile/src/lib/fuel-stop-revalidation.ts. Only flag when the
             -- stored stop is at least this far past the new reserve crossing, so
             -- small between-planning drift does not nag.
             10
           ) as target_verdict
    from public.car_bookings cb
    join public.ledger_members lm
      on lm.id = cb.member_id
     and lm.ledger_id = cb.ledger_id
    join public.ledgers l
      on l.id = cb.ledger_id
    where cb.deleted_at is null
      and l.deleted_at is null
      and cb.start_at > now()
      and cb.start_at <= now() + interval '3 hours'
      and cb.fuel_reminded_at is null
      and (cb.fuel_reminder_claimed_at is null
           or cb.fuel_reminder_claimed_at <= now() - interval '15 minutes')
      and lm.is_active = true
      and lm.email is not null
      and jsonb_typeof(cb.fuel_stop) = 'object'
      and jsonb_typeof(cb.fuel_stop -> 'distanceKm') = 'number'
      and (cb.fuel_stop ->> 'distanceKm')::numeric > 0
      and l.tank_state_as_of is not null
      and l.tank_state_liters is not null
      and l.tank_state_consumption is not null
      and l.tank_state_capacity is not null
      and l.tank_state_revision is not null
      and l.tank_state_revision = l.tank_model_revision
      and not exists (
        select 1
        from public.trips t
        where t.ledger_id = cb.ledger_id
          and t.deleted_at is null
          and greatest(t.created_at, t.updated_at) > l.tank_state_as_of
      )
      and not exists (
        select 1
        from public.fuel_payments fp
        where fp.ledger_id = cb.ledger_id
          and fp.deleted_at is null
          and greatest(fp.created_at, fp.updated_at) > l.tank_state_as_of
      )
      and public.fuel_stop_revalidation_verdict(
            cb.fuel_stop,
            l.tank_state_liters,
            l.tank_state_consumption,
            coalesce(l.tank_state_consumption_spread, 0),
            l.tank_state_capacity,
            10
          ) ->> 'verdict' <> 'holds'
    order by cb.start_at
    limit greatest(coalesce(p_limit, 200), 0)
    for update of cb skip locked
  ),
  claimed as (
    update public.car_bookings cb
    set fuel_reminder_claimed_at = now(),
        fuel_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where cb.id = t.target_booking_id
    returning cb.id as booking_id,
              cb.ledger_id as ledger_id,
              cb.member_id as member_id,
              cb.fuel_reminder_claim_token as claim_token,
              t.target_verdict as target_verdict
  )
  select c.booking_id,
         c.ledger_id,
         c.member_id,
         lower(lm.email) as member_email,
         c.target_verdict ->> 'verdict' as verdict,
         case when jsonb_typeof(c.target_verdict -> 'reserveKm') = 'number'
              then (c.target_verdict ->> 'reserveKm')::numeric end as reserve_km,
         case when jsonb_typeof(c.target_verdict -> 'storedStopKm') = 'number'
              then (c.target_verdict ->> 'storedStopKm')::numeric end as stored_stop_km,
         c.claim_token
  from claimed c
  join public.ledger_members lm
    on lm.id = c.member_id
   and lm.ledger_id = c.ledger_id;
end;
$$;

revoke all on function public.claim_due_booking_fuel_reminders(integer) from public;
revoke all on function public.claim_due_booking_fuel_reminders(integer) from anon;
revoke all on function public.claim_due_booking_fuel_reminders(integer) from authenticated;
grant execute on function public.claim_due_booking_fuel_reminders(integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '156_tank_model_revision',
  'GV-415: replaces the client-chosen tank-state watermark with a server-derived model revision. Migrations 154 and 155 stay untouched because both are already applied in production. Adds ledgers.tank_model_revision (a monotonic counter of model-input changes) and ledgers.tank_state_revision (the revision the stored stamp was computed from), backfilling 0 for the stamps that already exist so none of them is read as stale the moment this is applied. The counter is bumped by TRIGGERS rather than by explicit calls inside each RPC: statement-level triggers with transition tables on trips and fuel_payments for insert, delete and any update whose whole-row jsonb differs once period_id and updated_at are removed, plus a BEFORE UPDATE row trigger on ledgers for consumption, tank capacity and the tank baseline. The update test is an EXCLUDE list rather than a column list because an include list fails open — a new column the model reads and nobody listed would silently stop invalidating stamps — while an exclude list fails closed, and because Postgres refuses a column list on a trigger that declares transition tables at all. Triggers are what catch the writes that never touch an RPC — the admin console PATCHes deleted_at straight onto trips and fuel_payments with the service role, which is precisely the admin correction migration 155 could not invalidate a stamp for — and the statement trigger is security definer because migration 125 revoked UPDATE on ledgers from authenticated and RLS would otherwise filter the bump to zero rows with no error at all. set_tank_state gains a seventh parameter, expected_model_revision: the revision the client read before computing, sent back with the result. The server applies the stamp only while the workspace is still at that revision, and within one revision only the first stamp wins — a second one carrying different numbers is refused as value_conflict instead of overwriting, while an identical re-send still applies quietly so the offline outbox stays idempotent. The six-argument signature govehlo-mobile calls today stays as an overload with its own body and its own return contract (applied / stale_as_of / stored_as_of, GVM-480) so nothing goes dark before the mobile follow-up ships; it is hardened rather than frozen — migration 155''s tank_state_as_of <= as_of_value is split into strictly-newer OR equal-and-identical, so an equal watermark can no longer carry different numbers, and it records tank_state_revision at write time. claim_due_booking_fuel_reminders now gates on tank_state_revision = tank_model_revision AND migration 155''s tombstone-excluding as_of comparison: the revision covers everything the client cannot see (deletions, settings changes, baseline changes, non-RPC writes) and the as_of comparison covers the read-compute-write window a six-argument caller cannot report, so dropping either one would leave a live gap. Input bounds move to the shared public.validated_tank_state_spread helper so the two overloads cannot drift apart.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

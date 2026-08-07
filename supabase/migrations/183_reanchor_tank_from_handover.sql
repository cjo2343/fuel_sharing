-- Migration 183: a handover re-anchors the running fuel-level model, by confidence (GVM-553)
--
-- ── THE ORPHAN THIS CLOSES ───────────────────────────────────────────────────
-- booking_handovers.fuel_fraction — the "Tankniveau" the driver sets at overdragelse
-- — was RECORD-ONLY (GVM-529): shown on the handover card, fed into nothing. Meanwhile
-- the running fuel-level model (ledgers.tank_baseline_*, seeded by set_tank_baseline at
-- car setup and drained per trip on the client) drifts between full-tank fills, and the
-- refuel planner nags the driver to re-confirm the level (GVM-155) because it does not
-- trust its own estimate. Two gauges, disconnected.
--
-- The unlock: a handover captures a fresh eyes-on-gauge reading (fuel_fraction) AT a
-- known odometer (end_odometer) AND a known moment (observed_at — the booking's end,
-- migration 182). That is EXACTLY the shape set_tank_baseline ingests. So a handover is
-- not "an eyeballed number floating free" — it is a candidate ANCHOR for the model.
--
-- ── WHY NOT JUST LET IT WRITE THE BASELINE ───────────────────────────────────
-- The reason fuel_fraction was kept out (supabase-schema.sql:41514) is real: a free-hand
-- reading must not corrupt a litre-accurate balance. So this does NOT adopt every
-- handover. It adopts a handover's reading as the new baseline ONLY when it is the best
-- anchor available — a CONFIDENCE rule, not a blind write:
--
--   full-tank fill (=1.0, exact)  >  explicit set_tank_baseline  >  handover reading
--   >  the decrement chain since the last anchor (derived, degrades with distance).
--
-- ── THE ADOPTION RULE (all three must hold) ──────────────────────────────────
--   1. The handover HAS a reading and a place: fuel_fraction, end_odometer and
--      observed_at are all non-null. No reading → nothing to anchor from.
--   2. FORWARD-ONLY, by odometer — the physical truth. end_odometer must be >= the
--      current baseline odometer. A late offline upload of a STALE handover has a lower
--      odometer than the current anchor and is refused here; this is the whole reason
--      GVM-553 waited on GVM-552 (define "latest" by odometer/observation, not upload
--      time). Equal odometer re-anchors — a corrected reading at the same point.
--   3. DON'T DOWNGRADE A PRECISE FILL. If the tank was filled to FULL between the
--      current anchor and this handover, the model is already litre-accurate up to here
--      (that fill re-anchors the client replay to 1.0, then decrements by known km), so
--      an eyeballed fraction would only add noise. A fill AFTER this handover (higher
--      odometer) does NOT block: the client replays it and re-anchors to full on its
--      own, so moving the baseline back to this handover loses nothing.
--
-- When all three hold, the handover's reading is the freshest trustworthy anchor and the
-- baseline moves to it. Otherwise the model is left exactly as it was.
--
-- ── WHY A TRIGGER, NOT THE RPC ───────────────────────────────────────────────
-- Same choice as migration 182's observed_at: the re-anchor is a property of the
-- handover row against the ledger, not of one RPC's arguments, so it lives at the table
-- as an AFTER INSERT OR UPDATE trigger and upsert_booking_handover (the 300-line
-- function, migration 174) is not touched. AFTER, not BEFORE, so observed_at is already
-- set by set_handover_observed_at_trg (182) when this reads it.
--
-- ── RACE-FREE, migration 174's pattern ───────────────────────────────────────
-- The whole adoption rule lives in the UPDATE's own WHERE clause, so the statement locks
-- the ledger row it is deciding about and READ COMMITTED re-evaluates the forward-only
-- guard against whatever a concurrent handover committed while it waited. Two handovers
-- for two different bookings cannot both move the baseline backwards past each other.
--
-- ── TRANSPARENCY (tank_baseline_source) ──────────────────────────────────────
-- A new ledgers.tank_baseline_source records WHERE the live baseline came from —
-- 'manual' (set_tank_baseline / car setup) or 'handover' (this trigger) — so the client
-- can show "aflæst ved overdragelse d. X" (recorded_at = observed_at) rather than two
-- disconnected numbers. set_tank_baseline is re-declared to stamp 'manual'.
--
-- ── GDPR / GV-413 ────────────────────────────────────────────────────────────
-- No new category of data (fraction, odometer and the booking's end already exist), no
-- new recipient, no new retention question. The trigger writes NO ledger_event — the
-- handover_created event already notifies the group — so there is nothing to classify.

-- Where the live baseline came from, for honest client copy. Null on legacy rows and
-- backfilled to 'manual' for any baseline that already exists (all of which were set by
-- set_tank_baseline). 'handover' means the trigger below adopted a handover reading.
alter table public.ledgers
  add column if not exists tank_baseline_source text;

comment on column public.ledgers.tank_baseline_source is
  'Provenance of the live tank baseline: ''manual'' (set_tank_baseline / car setup) or '
  '''handover'' (auto-adopted from a booking handover by reanchor_tank_from_handover_trg, '
  'GVM-553). Lets the client label the running fuel level''s source; null = legacy/unset.';

update public.ledgers
   set tank_baseline_source = 'manual'
 where tank_baseline_odometer is not null
   and tank_baseline_source is null;

-- set_tank_baseline re-declared off its migration 092 definition (its only prior one),
-- byte-identical except that it now stamps tank_baseline_source = 'manual' alongside the
-- baseline it writes, so a deliberate car-setup reading is distinguishable from an
-- auto-adopted handover.
create or replace function public.set_tank_baseline(
  target_ledger_id text,
  odometer_value numeric,
  fraction_value numeric,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only a workspace admin can set the tank baseline' using errcode = '42501';
  end if;

  if odometer_value is null or odometer_value < 0 then
    raise exception 'Odometer must be zero or greater' using errcode = '23514';
  end if;

  if fraction_value is null or fraction_value < 0 or fraction_value > 1 then
    raise exception 'Tank fraction must be between 0 and 1' using errcode = '23514';
  end if;

  update public.ledgers
     set tank_baseline_odometer = odometer_value,
         tank_baseline_fraction = fraction_value,
         tank_baseline_recorded_at = now(),
         tank_baseline_source = 'manual',
         updated_at = now()
   where id = target_ledger_id;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);

  if event_title is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'vehicle_updated', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object(
        'tank_baseline_odometer', odometer_value,
        'tank_baseline_fraction', fraction_value
      )
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'tank_baseline_odometer', odometer_value,
    'tank_baseline_fraction', fraction_value
  );
end;
$$;

revoke all on function public.set_tank_baseline(text, numeric, numeric, text, text) from public;
revoke all on function public.set_tank_baseline(text, numeric, numeric, text, text) from anon;
grant execute on function public.set_tank_baseline(text, numeric, numeric, text, text) to authenticated;

-- Adopt a handover's gauge reading as the running-model baseline, by the confidence rule
-- in the header. security definer so it can read fuel_payments and write ledgers as the
-- owner regardless of the caller (it only ever fires from upsert_booking_handover, itself
-- security definer). Columns fully qualified for the SQL ambiguity guard.
create or replace function public.reanchor_tank_from_handover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.fuel_fraction is null or new.end_odometer is null or new.observed_at is null then
    return new;  -- no reading / no place / no time — nothing to anchor from
  end if;

  update public.ledgers l
     set tank_baseline_odometer = new.end_odometer,
         tank_baseline_fraction = new.fuel_fraction,
         tank_baseline_recorded_at = new.observed_at,
         tank_baseline_source = 'handover',
         updated_at = now()
   where l.id = new.ledger_id
     -- forward-only, by odometer (the physical truth); depends on GVM-552.
     and (l.tank_baseline_odometer is null or new.end_odometer >= l.tank_baseline_odometer)
     -- don't overwrite a precise fill: no full-tank fill sits between the current anchor
     -- and this handover (a fill AFTER it re-anchors the client replay on its own).
     and not exists (
       select 1
         from public.fuel_payments fp
        where fp.ledger_id = new.ledger_id
          and fp.full_tank
          and fp.deleted_at is null
          and fp.odometer is not null
          and fp.odometer > coalesce(l.tank_baseline_odometer, -1)
          and fp.odometer <= new.end_odometer
     );

  return new;
end;
$$;

drop trigger if exists reanchor_tank_from_handover_trg on public.booking_handovers;
create trigger reanchor_tank_from_handover_trg
  after insert or update on public.booking_handovers
  for each row execute function public.reanchor_tank_from_handover();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '183_reanchor_tank_from_handover',
  'A booking handover re-anchors the running fuel-level model, by confidence (GVM-553). booking_handovers.fuel_fraction (the "Tankniveau" set at overdragelse) was RECORD-ONLY (GVM-529) — shown, fed into nothing — while ledgers.tank_baseline_* (seeded by set_tank_baseline at car setup, drained per trip on the client) drifts between full-tank fills and the refuel planner nags for a re-confirm (GVM-155). A handover captures fraction AT a known odometer (end_odometer) AND moment (observed_at, the booking end, migration 182), which is exactly the shape set_tank_baseline ingests, so a handover is a candidate ANCHOR. It is adopted only when it is the best anchor available (confidence order: full-tank fill > explicit set_tank_baseline > handover reading > the decrement chain): an AFTER INSERT OR UPDATE trigger reanchor_tank_from_handover_trg on booking_handovers moves the baseline to (end_odometer, fuel_fraction, observed_at) ONLY when (1) fraction, end_odometer and observed_at are all non-null, (2) end_odometer >= the current baseline odometer — FORWARD-ONLY by odometer so a late offline upload of a stale handover cannot re-anchor backwards (the reason GVM-553 waited on GVM-552), and (3) NO full-tank fuel_payment sits in (current baseline odometer, end_odometer] — a recent fill already makes the model litre-accurate up to here, so an eyeballed fraction would only add noise; a fill at a HIGHER odometer does not block because the client replays it and re-anchors to full on its own. The whole rule lives in the UPDATE WHERE clause, so the statement locks the ledger row and READ COMMITTED re-evaluates the forward guard against a concurrent handover (migration 174 pattern) — two bookings cannot move the baseline backwards past each other. A trigger, not a re-declared upsert_booking_handover, so the 300-line RPC is untouched (migration 182 pattern); AFTER not BEFORE so observed_at is already set by set_handover_observed_at_trg. New ledgers.tank_baseline_source records provenance (''manual'' = set_tank_baseline/car setup, backfilled onto every existing baseline; ''handover'' = this trigger) so the client can show "aflæst ved overdragelse d. X"; set_tank_baseline re-declared off migration 092 (byte-identical bar stamping ''manual''). No ledger_event written (handover_created already notifies), nothing for GV-413. GDPR: no new category of data, recipient or retention question — fraction, odometer and the booking end already exist. Prerequisite: GVM-552 (observed_at).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

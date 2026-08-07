-- Migration 187: a handover may only LOWER the modelled fuel level (GVM-554)
--
-- ── THE GAP (raised by the owner, 2026-08-07) ────────────────────────────────
-- The handover re-anchor (migration 183, latest-only since 186) still let a handover
-- reading RAISE the modelled tank level. But between two anchor points with no logged
-- fuel purchase, a tank can physically only go DOWN (consumption). So a handover reading
-- ABOVE the last anchor means fuel was ADDED — and a handover carries only a gauge
-- FRACTION, never litres or kroner. Silently re-anchoring the level UP therefore makes
-- the needle look right while quietly swallowing an unlogged refuel whose cost belongs in
-- a fuel_payment — and splitting that cost is the entire point of the app.
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────
-- Re-anchor only when the reading is NOT above the last anchor's fraction. With the
-- no-full-tank-fill-between guard already in place (migration 183), any rise from the
-- anchor is either an unlogged refuel (must be logged, not absorbed) or a logged PARTIAL
-- fill the running model already replays — so in both cases the handover must not move
-- the baseline UP. A reading at or below the anchor is honest consumption and re-anchors
-- as before. Downward-only, by fraction.
--
-- This is the SIMPLE, safe comparison (owner-approved): `new.fuel_fraction <=
-- tank_baseline_fraction`. It catches every reading above the last known anchor. It does
-- NOT catch a small top-up that lands between the anchor and the model's consumption-
-- adjusted estimate — that needs the client's litre model replayed server-side, noted as
-- a future tightening. The client complements this with a "log the tankning" nudge
-- whenever a saved handover reads fuller than the model expects (GVM-554 mobile half).
--
-- A null tank_baseline_fraction means no anchor yet — the first reading seeds it, so the
-- guard passes.
--
-- ── WHAT IS NOT CHANGED ──────────────────────────────────────────────────────
-- Re-declared COMPLETELY off migration 186 (its newest prior definition), byte-identical
-- but for the one added WHERE clause and the comment above it. No column, no new object,
-- no signature change — `returns trigger`, so types/database.ts is untouched. The trigger
-- binding from 183 is unchanged and not re-created. No ledger_event, nothing for GV-413.
-- GDPR: no new data, recipient or retention.

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
     )
     -- ONLY the current handover re-anchors: no other handover in this workspace is newer
     -- by observation time. Editing a historical handover (which has a newer one after it)
     -- must not move the live fuel level (GVM-553 fix, migration 186). Same
     -- (observed_at desc, id desc) order as latestHandoverQuery / migration 182.
     and not exists (
       select 1
         from public.booking_handovers bh2
        where bh2.ledger_id = new.ledger_id
          and bh2.id <> new.id
          and (bh2.observed_at > new.observed_at
               or (bh2.observed_at = new.observed_at and bh2.id > new.id))
     )
     -- DOWNWARD-ONLY (GVM-554): a handover may only LOWER the level (consumption). With no
     -- full-tank fill between (guarded above), a reading ABOVE the last anchor's fraction
     -- means fuel was ADDED — an unlogged refuel whose cost belongs in a fuel_payment, or a
     -- logged partial fill the model already replays. Don't absorb either into the level;
     -- the client nudges to log the tankning. Null baseline fraction = first reading, seed it.
     and (l.tank_baseline_fraction is null or new.fuel_fraction <= l.tank_baseline_fraction);

  return new;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '187_reanchor_downward_only',
  'A handover may only LOWER the modelled fuel level (GVM-554). The re-anchor (183, latest-only since 186) still let a handover reading RAISE the baseline, but between two anchors with no logged fuel purchase a tank can physically only fall (consumption), so a reading ABOVE the last anchor means fuel was ADDED — and a handover carries only a gauge fraction, never litres/kr, so silently re-anchoring UP makes the needle look right while swallowing an unlogged refuel whose cost belongs in a fuel_payment (splitting that cost is the point of the app). Fix: re-declare reanchor_tank_from_handover off 186 (byte-identical bar one added WHERE clause) with a downward-only guard — re-anchor only when new.fuel_fraction <= tank_baseline_fraction (null baseline fraction seeds the first reading). With the no-full-tank-fill-between guard already present, any rise is either an unlogged refuel (must be logged, not absorbed) or a logged partial fill the running model already replays, so in both cases the handover must not move the baseline up; a reading at/below the anchor is honest consumption and re-anchors as before. This is the simple owner-approved comparison; it catches every reading above the last anchor but not a small top-up between the anchor and the consumption-adjusted estimate (future tightening needs the client litre model replayed server-side). The mobile half nudges "Tanken ser fuldere ud end forventet - har nogen tanket? Log tankningen" when a saved handover reads fuller than the model expects. returns trigger, so types/database.ts unchanged (header-stamp-only); no new object, no signature change, 183 trigger binding unchanged; no ledger_event, nothing for GV-413; no GDPR change. Depends on 186 (and 183 / GVM-552).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

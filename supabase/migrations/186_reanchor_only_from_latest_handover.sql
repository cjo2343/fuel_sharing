-- Migration 186: only the CURRENT handover re-anchors the fuel model (GVM-553 fix)
--
-- ── THE BUG (in migration 183) ───────────────────────────────────────────────
-- reanchor_tank_from_handover_trg fires on INSERT *and* UPDATE and adopts a handover's
-- gauge reading as the tank baseline when it is forward of the stored baseline odometer.
-- What it never checked is whether the handover being written is the workspace's CURRENT
-- one. So EDITING a historical booking's handover — one under "Historie" — and changing
-- its fuel reading re-anchored the LIVE fuel level to that reading, as long as the old
-- booking's odometer happened to be >= the (older, lower) stored baseline odometer. The
-- forward-only guard was meant to stop this, but it compares against the baseline's
-- odometer, not against "is there a newer observation", so an edit to history slips
-- through whenever the baseline is stale. Editing the past silently moved the present —
-- surprising and wrong.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- Add a fourth guard: re-anchor ONLY when this handover is the workspace's NEWEST by
-- observation time — i.e. no other handover for the ledger has a later observed_at (the
-- booking's end), with id as the tiebreak, exactly the (observed_at desc, id desc)
-- ordering latestHandoverQuery / migration 182 established. Then:
--   • creating or CORRECTING the current handover still re-anchors — the intended flow;
--   • editing anything in Historie (which by definition has a newer handover after it)
--     does nothing to the fuel level.
-- The guard is an index scan of booking_handovers_ledger_observed_idx (migration 182), so
-- it costs one row. It stays INSIDE the UPDATE's WHERE with the other three guards, so the
-- whole rule remains race-free (a concurrent newer handover committed while this waited
-- makes the NOT EXISTS true against that newer row and the mirror matches nothing).
--
-- ── WHAT IS NOT CHANGED ──────────────────────────────────────────────────────
-- Re-declared COMPLETELY off migration 183 (its only prior definition), byte-identical
-- but for the one added NOT EXISTS clause and the comments narrating it. No column, no
-- table, no new object, no signature change — `returns trigger`, so types/database.ts is
-- untouched. The trigger binding from 183 is unchanged and not re-created here. No
-- ledger_event, nothing for GV-413. GDPR: no new data, recipient or retention.

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
     );

  return new;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '186_reanchor_only_from_latest_handover',
  'Only the CURRENT handover re-anchors the fuel model (GVM-553 fix). Migration 183''s reanchor_tank_from_handover_trg fires on INSERT and UPDATE and adopts a handover reading as the tank baseline when it is forward of the stored baseline odometer, but never checks whether the handover being written is the workspace''s current one — so EDITING a historical booking''s handover (one under "Historie") and changing its fuel reading re-anchored the LIVE fuel level to it whenever the old booking''s odometer was >= the (older) stored baseline. Editing the past moved the present. Fix: re-declare reanchor_tank_from_handover off 183 (byte-identical bar the added clause) with a fourth guard inside the UPDATE WHERE — re-anchor ONLY when no other handover for the ledger has a later observed_at (id tiebreak), the (observed_at desc, id desc) order from latestHandoverQuery / migration 182, backed by booking_handovers_ledger_observed_idx. Creating or correcting the current handover still re-anchors; editing anything in Historie does nothing to the fuel level. Rule stays in the WHERE so it is race-free (a concurrent newer handover makes the NOT EXISTS true against that row). returns trigger, so types/database.ts unchanged (header-stamp-only); no new object, no signature change, the 183 trigger binding is unchanged; no ledger_event, nothing for GV-413; no GDPR change. Depends on GVM-552 (observed_at) and 183.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

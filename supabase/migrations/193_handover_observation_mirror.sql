-- Migration 193: handover observations mirrored onto ledgers (GVM-546)
--
-- The GVM-546 decision of 2026-08-08: the platform does NOT get a general
-- vehicle-observations table — the mobile odometer derivation (GVM-455's
-- max-of-floors in odometer.ts) and the tank re-anchor chain (183/186/187 with
-- 189/191's timing honesty) ARE the observation model. What remains are two
-- concrete gaps, and both have the same root: a handover's readings live only in
-- booking_handovers, which the workspace load never fetches (it is a per-screen
-- lazy read), so the rest of the app is blind to them.
--
--   Gap 1 — booking_handovers.end_odometer feeds NOTHING (the mobile repo says so
--   verbatim in outbox-rows.ts). A member types the car's km at handover and it
--   never reaches Bilen's headline, the Start-km prefill, the service reminder or
--   the OCR plausibility floor.
--
--   Gap 2 — a handover fuel reading ABOVE the model is only a nudge ("log the
--   fill") and is stamped nowhere, so the client cannot even SHOW the newest
--   eyeball next to the model (the migration-187 small-refuel gap's visibility
--   half; the arithmetic half stays exactly as 187 decided — an eyeball never
--   sets measured litres).
--
-- Fix: three mirror columns on ledgers, maintained by ONE recompute trigger on
-- booking_handovers:
--
--   max_handover_odometer        MONOTONE (greatest of every reading ever made;
--                                an odometer only goes up, so an edited-down or
--                                deleted handover does not retract a reading that
--                                was made). The mobile client adds it as a fifth
--                                floor in odometer.ts — trust-wise identical to a
--                                pump-side odometer entry.
--   latest_handover_fraction     the newest eyeball fuel reading, RECOMPUTED (not
--   latest_handover_observed_at  monotone): "latest" must follow observed_at,
--                                which migration 189's restamp trigger can move
--                                when a booking's end time is edited — the
--                                restamp UPDATEs booking_handovers, so it fires
--                                this trigger and the mirror re-derives. Display
--                                only, never an input to the tank arithmetic.
--
-- The recompute reads the whole ledger's handovers (a workspace has few), so the
-- mirror is correct under any edit order rather than fast under none. DELETEs
-- also recompute the fraction pair (a deleted handover's eyeball should not
-- linger as "latest") but deliberately never lower the odometer column.
--
-- The backfill UPDATEs ledgers directly. ledgers carries no settlement guard
-- (those sit on the entry tables — the 192 lesson does not bite here), but the
-- apply was still rehearsed against a populated replay per DEPLOY-CHECKLIST.
-- No new event_type (nothing for GV-413): a handover already writes
-- handover_created, and these columns are derived state, not news.

alter table public.ledgers
  add column if not exists max_handover_odometer integer,
  add column if not exists latest_handover_fraction numeric,
  add column if not exists latest_handover_observed_at timestamptz;

create or replace function public.mirror_handover_observations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text := coalesce(new.ledger_id, old.ledger_id);
  v_max_odometer integer;
  v_fraction numeric;
  v_observed_at timestamptz;
begin
  select max(h.end_odometer)
    into v_max_odometer
    from public.booking_handovers h
   where h.ledger_id = v_ledger_id;

  select h.fuel_fraction, h.observed_at
    into v_fraction, v_observed_at
    from public.booking_handovers h
   where h.ledger_id = v_ledger_id
     and h.fuel_fraction is not null
   order by h.observed_at desc, h.id desc
   limit 1;

  -- MONOTONE for the odometer (greatest of the mirror and the table — a deleted
  -- or edited-down handover does not retract a reading that was made), plain
  -- recompute for the fraction pair. NULL means "never observed": when neither
  -- the mirror nor the table holds a reading, the column stays NULL rather than
  -- becoming a fake 0 km reading.
  update public.ledgers l
     set max_handover_odometer = case
           when v_max_odometer is null and l.max_handover_odometer is null then null
           else greatest(coalesce(l.max_handover_odometer, 0), coalesce(v_max_odometer, 0))
         end,
         latest_handover_fraction = v_fraction,
         latest_handover_observed_at = v_observed_at
   where l.id = v_ledger_id;

  return coalesce(new, old);
end;
$$;

revoke execute on function public.mirror_handover_observations() from public;
revoke execute on function public.mirror_handover_observations() from anon;

drop trigger if exists mirror_handover_observations_trg on public.booking_handovers;
create trigger mirror_handover_observations_trg
  after insert or update or delete on public.booking_handovers
  for each row execute function public.mirror_handover_observations();

-- Backfill every ledger that already holds handover readings.
update public.ledgers l
   set max_handover_odometer = sub.max_odo
  from (
    select h.ledger_id, max(h.end_odometer) as max_odo
      from public.booking_handovers h
     where h.end_odometer is not null
     group by h.ledger_id
  ) sub
 where sub.ledger_id = l.id
   and l.max_handover_odometer is distinct from sub.max_odo;

update public.ledgers l
   set latest_handover_fraction = sub.fuel_fraction,
       latest_handover_observed_at = sub.observed_at
  from (
    select distinct on (h.ledger_id) h.ledger_id, h.fuel_fraction, h.observed_at
      from public.booking_handovers h
     where h.fuel_fraction is not null
     order by h.ledger_id, h.observed_at desc, h.id desc
  ) sub
 where sub.ledger_id = l.id
   and (l.latest_handover_fraction is distinct from sub.fuel_fraction
        or l.latest_handover_observed_at is distinct from sub.observed_at);

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '193_handover_observation_mirror',
  'Handover observations mirrored onto ledgers (GVM-546, decided 2026-08-08: no general observations table — odometer.ts'' max-of-floors plus the 183/186/187/189/191 re-anchor chain ARE the observation model; this closes the two remaining gaps, both rooted in booking_handovers being a per-screen lazy read the workspace load never sees). Three columns on ledgers maintained by ONE recompute trigger on booking_handovers (insert/update/delete): max_handover_odometer is MONOTONE — greatest of every reading ever made, an edited-down or deleted handover does not retract a counter reading — and becomes the mobile client''s fifth odometer floor (trust-identical to a pump-side entry); latest_handover_fraction + latest_handover_observed_at are RECOMPUTED, because ''latest'' follows observed_at and migration 189''s restamp trigger can move observed_at when a booking end is edited (the restamp UPDATEs booking_handovers, so it fires this mirror) — display only, the eyeball never enters the tank arithmetic (187''s rule stands). Recompute reads the whole ledger''s handovers so the mirror is correct under any edit order; a never-observed ledger stays NULL, not 0. Backfill included; ledgers carries no settlement guard (192''s populated-apply lesson checked and rehearsed regardless). No new event_type (GV-413: derived state, not news). SECURITY DEFINER trigger fn, execute revoked from public/anon. Columns readable through the existing ledger member read policy — no policy change.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

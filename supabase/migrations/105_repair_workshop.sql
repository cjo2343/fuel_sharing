-- Migration 105: vehicle_repairs.workshop + insert_repair workshop param (GVM-306)
--
-- Adds an optional free-text "workshop" (where the repair was carried out) to
-- vehicle_repairs and threads it through the insert_repair RPC. The column is
-- nullable and back-fills to null, so existing rows and any client that never
-- sends a workshop are unaffected.
--
-- insert_repair gains a trailing `workshop text default null` parameter (078 had
-- no event_title/event_body params, so it is appended last — the 051/052 event
-- params, when present, would stay last, but there are none here). Adding a
-- parameter changes the argument signature, so `create or replace` would create a
-- SECOND overload rather than replace the old function; we therefore drop the old
-- 5-arg function first (its grants die with it) and recreate + re-grant. Clients
-- calling by named params keep working before AND after apply — old clients simply
-- never send workshop and the new param defaults to null.

alter table public.vehicle_repairs add column if not exists workshop text;

-- ── insert_repair: a member logs a maintenance/repair cost ──────────────────────
-- Mirrors the "Creators and admins can insert repairs" RLS policy: any active member
-- may log a repair, always attributed to themselves (created_by = the caller).
drop function public.insert_repair(text, date, text, numeric, integer);

create or replace function public.insert_repair(
  target_ledger_id text,
  repair_date_value date,
  description_value text,
  cost_dkk_value numeric,
  odo_km_value integer default null,
  workshop text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can log repairs' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if nullif(description_value, '') is null then
    raise exception 'Repair description is required' using errcode = '22023';
  end if;

  insert into public.vehicle_repairs (
    ledger_id, repair_date, description, cost_dkk, odo_km, workshop, created_by_member_id
  ) values (
    target_ledger_id,
    coalesce(repair_date_value, current_date),
    description_value,
    coalesce(cost_dkk_value, 0),
    odo_km_value,
    nullif(btrim(workshop), ''),
    actor_member_id
  )
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

revoke all on function public.insert_repair(text, date, text, numeric, integer, text) from public;
revoke all on function public.insert_repair(text, date, text, numeric, integer, text) from anon;
grant execute on function public.insert_repair(text, date, text, numeric, integer, text) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('105_repair_workshop',
        'Add vehicle_repairs.workshop and thread it through insert_repair (dropped + recreated with a trailing workshop param) (GVM-306).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

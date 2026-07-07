-- Migration 092: tank baseline for the running fuel-level model (GVM-252)
--
-- The fuel-level estimate needs a single honest anchor: "as of odometer O, the
-- tank was F full." Captured once at car setup (current odometer + how full the
-- tank is now), it seeds a continuous running balance the client drains from —
-- instead of the old model that depended on a Fuld-tank entry and, when seeded
-- from the stale Syn odometer, modelled a near-empty tank and warned on every
-- trip. Three nullable columns + a small admin-gated RPC to set them.

alter table public.ledgers
  add column if not exists tank_baseline_odometer numeric;

alter table public.ledgers
  add column if not exists tank_baseline_fraction numeric;

alter table public.ledgers
  add column if not exists tank_baseline_recorded_at timestamptz;

-- Record the car's current odometer + tank fill fraction (0..1). Admin-gated
-- (a car setting), stamps recorded_at server-side, and — like the other vehicle
-- writers (migration 052) — logs a vehicle_updated activity event when the
-- caller passes event copy.
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('092_tank_baseline',
        'Tank baseline for the running fuel-level model (GVM-252): ledgers.tank_baseline_odometer/fraction/recorded_at + admin-gated set_tank_baseline RPC (logs a vehicle_updated event). Seeds the client running-balance anchor captured at car setup.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

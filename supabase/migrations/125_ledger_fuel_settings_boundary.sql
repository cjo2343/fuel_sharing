-- Migration 125: replace broad ledger updates with a validated fuel-settings RPC.
--
-- Workspace admins previously retained table-level UPDATE access to public.ledgers.
-- RLS limited the row, but not the columns, so a modified client could change
-- join codes, ownership/bootstrap fields, rule flags, and other settings without
-- using the invariant-enforcing RPCs. The clients now have no direct UPDATE grant;
-- this command is the narrow write boundary for the Admin fuel-settings form.

create or replace function public.update_ledger_fuel_settings(
  target_ledger_id text,
  fuel_type_value text,
  estimated_consumption_value numeric,
  fuel_tank_capacity_value numeric,
  fallback_fuel_price_value numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_fuel_type text;
  actor_id uuid;
  old_fuel_type text;
  old_consumption numeric;
  old_tank_capacity numeric;
  old_fallback_price numeric;
  changed_keys text[] := array[]::text[];
begin
  if nullif(btrim(target_ledger_id), '') is null then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update fuel settings' using errcode = '42501';
  end if;

  normalized_fuel_type := lower(btrim(coalesce(fuel_type_value, '')));
  if normalized_fuel_type not in ('benzin', 'diesel', 'el', 'hybrid') then
    raise exception 'Invalid fuel type' using errcode = '22023';
  end if;

  if estimated_consumption_value is null
     or estimated_consumption_value < 0.1
     or estimated_consumption_value > 100 then
    raise exception 'Consumption must be between 0.1 and 100 per 100 km' using errcode = '22023';
  end if;

  if fuel_tank_capacity_value is null
     or fuel_tank_capacity_value < 1
     or fuel_tank_capacity_value > 500 then
    raise exception 'Tank capacity must be between 1 and 500' using errcode = '22023';
  end if;

  if fallback_fuel_price_value is null
     or fallback_fuel_price_value < 0.01
     or fallback_fuel_price_value > 100 then
    raise exception 'Fallback fuel price must be between 0.01 and 100' using errcode = '22023';
  end if;

  actor_id := public.current_ledger_member_id(target_ledger_id);
  if actor_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  select fuel_type,
         estimated_consumption_l_per_100km,
         fuel_tank_capacity_l,
         fallback_fuel_price
    into old_fuel_type, old_consumption, old_tank_capacity, old_fallback_price
    from public.ledgers
   where id = target_ledger_id
   for update;

  if not found then
    raise exception 'Workspace not found' using errcode = '22023';
  end if;

  if normalized_fuel_type is distinct from old_fuel_type then
    changed_keys := array_append(changed_keys, 'fuel_type');
  end if;
  if estimated_consumption_value is distinct from old_consumption then
    changed_keys := array_append(changed_keys, 'consumption');
  end if;
  if fuel_tank_capacity_value is distinct from old_tank_capacity then
    changed_keys := array_append(changed_keys, 'tank_capacity');
  end if;
  if fallback_fuel_price_value is distinct from old_fallback_price then
    changed_keys := array_append(changed_keys, 'fallback_price');
  end if;

  if cardinality(changed_keys) > 0 then
    update public.ledgers
       set fuel_type = normalized_fuel_type,
           estimated_consumption_l_per_100km = estimated_consumption_value,
           fuel_tank_capacity_l = fuel_tank_capacity_value,
           fallback_fuel_price = fallback_fuel_price_value,
           updated_at = now()
     where id = target_ledger_id;

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      'Brændstofindstillinger ændret',
      'Bilens brændstofindstillinger er opdateret.',
      actor_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('changed', to_jsonb(changed_keys))
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'changed', to_jsonb(changed_keys)
  );
end;
$$;

revoke all on function public.update_ledger_fuel_settings(text, text, numeric, numeric, numeric) from public;
revoke all on function public.update_ledger_fuel_settings(text, text, numeric, numeric, numeric) from anon;
grant execute on function public.update_ledger_fuel_settings(text, text, numeric, numeric, numeric) to authenticated;

-- Row-level admin membership is not a sufficient boundary for a wide settings
-- table. All authenticated writes must pass through a column-scoped RPC.
drop policy if exists "Ledger admins can update ledgers" on public.ledgers;
revoke update on table public.ledgers from public;
revoke update on table public.ledgers from anon;
revoke update on table public.ledgers from authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '125_ledger_fuel_settings_boundary',
  'Remove broad authenticated UPDATE access to ledgers and add a validated admin-only update_ledger_fuel_settings RPC with canonical fuel types, bounded numeric inputs, no-op suppression, and redacted settings_changed events.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 119: settlement-rule changes log ledger_events (GV-292)
--
-- update_ledger_settings (newest prior body: migration 107) only patched the
-- ledgers row. A monthly↔running switch, or a repairs-split rule change, therefore
-- left NO ledger_events row — so it was invisible in the activity feed and never
-- pushed to other members' clients (migration 087 lesson: a write RPC that logs no
-- event does not live-sync). This re-declares the function COMPLETELY off the 107
-- body (same signature, same grants/revokes) and, for each settlement rule whose
-- STORED value actually changed, inserts one 'settings_changed' feed event.
--
-- No-op suppression is load-bearing: a non-null param equal to the stored value, or
-- a null param, writes nothing new and must NOT emit an event. We snapshot the old
-- values before the coalesce-patch and compare (is distinct from) against the new
-- ones after, so only a REAL change emits. Only settlement_mode and
-- repairs_split_mode are surfaced; the silent vehicle_info refresh and split
-- defaults stay event-free by design (LedgerContext refreshes vehicle_info on every
-- save and must not spam the feed).

create or replace function public.update_ledger_settings(
  target_ledger_id text,
  settlement_mode_value text default null,
  expense_split_defaults_value jsonb default null,
  vehicle_info_value jsonb default null,
  repairs_split_mode_value text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_settlement_mode text;
  old_repairs_split_mode text;
  new_settlement_mode text;
  new_repairs_split_mode text;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can update workspace settings' using errcode = '42501';
  end if;

  if settlement_mode_value is not null
     and settlement_mode_value not in ('monthly', 'running') then
    raise exception 'Invalid settlement mode' using errcode = '22023';
  end if;

  if repairs_split_mode_value is not null
     and repairs_split_mode_value not in ('efter_koersel', 'ligeligt', 'deles_ikke') then
    raise exception 'Invalid repairs split mode' using errcode = '22023';
  end if;

  -- Snapshot the settlement rules BEFORE the patch so a real change can be told
  -- apart from a no-op (equal or null param writes nothing new → no event). GV-292.
  select ledgers.settlement_mode, ledgers.repairs_split_mode
    into old_settlement_mode, old_repairs_split_mode
    from public.ledgers
    where ledgers.id = target_ledger_id;

  update public.ledgers set
    settlement_mode        = coalesce(settlement_mode_value, settlement_mode),
    expense_split_defaults = coalesce(expense_split_defaults_value, expense_split_defaults),
    vehicle_info           = coalesce(vehicle_info_value, vehicle_info),
    repairs_split_mode     = coalesce(repairs_split_mode_value, repairs_split_mode),
    updated_at             = now()
  where id = target_ledger_id;

  -- The patch is a coalesce, so the new value is the param when supplied else the
  -- old one — a null or equal param leaves new = old and emits nothing.
  new_settlement_mode := coalesce(settlement_mode_value, old_settlement_mode);
  new_repairs_split_mode := coalesce(repairs_split_mode_value, old_repairs_split_mode);

  actor_id := public.current_ledger_member_id(target_ledger_id);
  current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

  if new_settlement_mode is distinct from old_settlement_mode then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      'Afregning ændret',
      case new_settlement_mode
        when 'running' then 'Gruppen afregner nu løbende.'
        else 'Gruppen afregner nu månedligt.'
      end,
      actor_id,
      current_actor_email,
      jsonb_build_object(
        'field', 'settlement_mode',
        'old', old_settlement_mode,
        'new', new_settlement_mode
      )
    );
  end if;

  if new_repairs_split_mode is distinct from old_repairs_split_mode then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      'Reparationsdeling ændret',
      case new_repairs_split_mode
        when 'efter_koersel' then 'Reparationer deles nu efter kørsel.'
        when 'ligeligt' then 'Reparationer deles nu ligeligt.'
        else 'Reparationer deles ikke længere.'
      end,
      actor_id,
      current_actor_email,
      jsonb_build_object(
        'field', 'repairs_split_mode',
        'old', old_repairs_split_mode,
        'new', new_repairs_split_mode
      )
    );
  end if;
end;
$$;

revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb, text) from public;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb, text) from anon;
grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('119_settings_change_events',
        'Settlement-rule changes log ledger_events (GV-292). update_ledger_settings re-declared off 107 (same 5-arg signature + grants): snapshots settlement_mode + repairs_split_mode before the coalesce-patch and, for each field whose stored value actually changed (is distinct from — a null or equal param is a no-op and emits nothing), inserts one settings_changed feed event. Danish server copy: settlement_mode → "Afregning ændret" / "Gruppen afregner nu løbende." | "Gruppen afregner nu månedligt."; repairs_split_mode → "Reparationsdeling ændret" / "Reparationer deles nu efter kørsel." | "Reparationer deles nu ligeligt." | "Reparationer deles ikke længere." Actor via current_ledger_member_id(), actor_email via auth.jwt(); metadata {field, old, new}. Makes rule switches visible in the feed and live-sync to other members (migration 087 lesson). vehicle_info + split defaults stay event-free by design.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

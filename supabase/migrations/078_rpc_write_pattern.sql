-- Migration 078: route the last raw client-table writes through SECURITY DEFINER RPCs (GVM-210)
--
-- Codex before-beta review #5: most writes go through SECURITY DEFINER RPCs, but four
-- client calls in the mobile app still hit tables directly (src/lib/supabase-helpers.ts):
-- insertRepair -> vehicle_repairs.insert, updateLedgerSettings -> ledgers.update,
-- insertMessage -> messages.insert, markMessagesRead -> message_read_state upsert.
-- Their RLS policies already bind each write to the caller's identity, but to finish
-- the RPC-write pattern (one uniform path, actor derived server-side, no raw .from()
-- writes left to copy) we wrap each in an RPC. Behaviour is unchanged: the actor /
-- sender / reader is resolved from current_ledger_member_id(target_ledger_id) rather
-- than trusted from the client, and the same membership/admin gates apply.
--
-- No ledger_events are emitted here — chat + read-state are not feed events, and the
-- settings writes (settlement mode, split defaults, silent vehicle_info refresh) are
-- intentionally silent today. A repair-logged feed event is a deliberate follow-up.

-- ── insert_repair: a member logs a maintenance/repair cost ──────────────────────
-- Mirrors the "Creators and admins can insert repairs" RLS policy: any active member
-- may log a repair, always attributed to themselves (created_by = the caller).
create or replace function public.insert_repair(
  target_ledger_id text,
  repair_date_value date,
  description_value text,
  cost_dkk_value numeric,
  odo_km_value integer default null
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
    ledger_id, repair_date, description, cost_dkk, odo_km, created_by_member_id
  ) values (
    target_ledger_id,
    coalesce(repair_date_value, current_date),
    description_value,
    coalesce(cost_dkk_value, 0),
    odo_km_value,
    actor_member_id
  )
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

grant execute on function public.insert_repair(text, date, text, numeric, integer) to authenticated;

-- ── update_ledger_settings: admin-only workspace settings write ─────────────────
-- Replaces the direct ledgers.update for the three columns the app actually patches:
-- settlement_mode, expense_split_defaults, and a silent vehicle_info refresh. Only the
-- provided values are written (coalesce keeps the rest). Admin-gated, matching the
-- "Ledger admins can update ledgers" RLS policy. Intentionally emits no feed event.
create or replace function public.update_ledger_settings(
  target_ledger_id text,
  settlement_mode_value text default null,
  expense_split_defaults_value jsonb default null,
  vehicle_info_value jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  update public.ledgers set
    settlement_mode        = coalesce(settlement_mode_value, settlement_mode),
    expense_split_defaults = coalesce(expense_split_defaults_value, expense_split_defaults),
    vehicle_info           = coalesce(vehicle_info_value, vehicle_info),
    updated_at             = now()
  where id = target_ledger_id;
end;
$$;

grant execute on function public.update_ledger_settings(text, text, jsonb, jsonb) to authenticated;

-- ── post_message: send a chat message ───────────────────────────────────────────
-- Mirrors the "Members can send messages" RLS policy; sender is the caller.
create or replace function public.post_message(
  target_ledger_id text,
  body_value text
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
    raise exception 'Only ledger members can send messages' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if nullif(body_value, '') is null then
    raise exception 'Message body is required' using errcode = '22023';
  end if;

  insert into public.messages (ledger_id, sender_member_id, body)
  values (target_ledger_id, actor_member_id, body_value)
  returning id into result_id;

  return jsonb_build_object('id', result_id);
end;
$$;

grant execute on function public.post_message(text, text) to authenticated;

-- ── mark_messages_read: upsert the caller's own read cursor ──────────────────────
-- Mirrors the "Members upsert/update own read-state" RLS policies; member is the caller.
create or replace function public.mark_messages_read(
  target_ledger_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can mark messages read' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  insert into public.message_read_state (ledger_id, member_id, last_read_at)
  values (target_ledger_id, actor_member_id, now())
  on conflict (ledger_id, member_id) do update
  set last_read_at = excluded.last_read_at;
end;
$$;

grant execute on function public.mark_messages_read(text) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('078_rpc_write_pattern',
        'Route repair / ledger-settings / message / read-state writes through SECURITY DEFINER RPCs (GVM-210).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

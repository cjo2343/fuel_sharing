-- Migration 074: idempotent inspection-due (syn) feed event (GVM-187)
--
-- Phase 3 of the total-cost ledger (epic GVM-167), the syn-reminder slice. The
-- owner records the car's next periodic-inspection (syn) date on the Car profile
-- (stored as vehicle_info->>'next_inspection_date' on public.ledgers — no schema
-- migration needed for storage). Missing a syn deadline gets the car deregistered,
-- so the app nudges before it: a client-computed Home banner, plus this one system
-- event dropped into the Activity feed when the date comes within range.
--
-- Trigger model = CLIENT CATCH-UP (same as generate_due_recurring_expenses,
-- migration 069): any member's client calls this on load; the RPC emits at most one
-- 'inspection_due' event per (ledger, syn date), so it is safe to call every load and
-- across devices. It re-emits only when the owner sets a NEW date — i.e. after the
-- car passes syn and the next deadline rolls forward. No cron, no push required.

create or replace function public.emit_inspection_due_event(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Lead time: nudge once the syn deadline is within this many days (or overdue).
  threshold_days int := 30;
  syn_date date;
  existing_id uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can check inspection status' using errcode = '42501';
  end if;

  -- Owner-entered next-syn date lives in the vehicle metadata jsonb.
  select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
    into syn_date
  from public.ledgers l
  where l.id = target_ledger_id;

  -- Nothing to nudge if it is unset or still comfortably in the future.
  if syn_date is null or syn_date > current_date + threshold_days then
    return jsonb_build_object('emitted', false, 'reason', 'not_due');
  end if;

  -- Idempotent: one feed event per (ledger, syn date). A new date (after the car
  -- passes syn) is a distinct key, so the next deadline nudges afresh.
  select le.id into existing_id
  from public.ledger_events le
  where le.ledger_id = target_ledger_id
    and le.event_type = 'inspection_due'
    and (le.metadata ->> 'inspection_date') = syn_date::text
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('emitted', false, 'reason', 'already_emitted');
  end if;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'inspection_due',
    case when syn_date < current_date then 'Syn er overskredet' else 'Syn forfalder snart' end,
    case when syn_date < current_date
      then 'Bilen skulle have været til syn ' || to_char(syn_date, 'DD-MM-YYYY') || '. Book en tid hurtigst muligt.'
      else 'Bilen skal til syn senest ' || to_char(syn_date, 'DD-MM-YYYY') || '. Husk at booke en tid.'
    end,
    null,
    null,
    jsonb_build_object('inspection_date', syn_date::text)
  );

  return jsonb_build_object('emitted', true, 'inspection_date', syn_date::text);
end;
$$;

grant execute on function public.emit_inspection_due_event(text) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('074_inspection_due_event',
        'Idempotent inspection-due (syn) feed event, client catch-up like recurring generation (GVM-187).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

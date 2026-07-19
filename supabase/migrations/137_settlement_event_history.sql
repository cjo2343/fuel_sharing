-- Migration 137: immutable settlement event history (GV-336)
--
-- ledger_events is a short-lived activity/realtime stream, not an audit log. Keep a
-- narrow, append-only settlement history that survives activity retention and records
-- every lifecycle edge at the database boundary, regardless of which RPC performs it.
-- The table intentionally excludes amounts, evidence notes, emails, push tokens, and
-- arbitrary metadata. Clients can join the canonical request for current details.

create table if not exists public.settlement_request_events (
  id uuid primary key default gen_random_uuid(),
  settlement_request_id uuid not null references public.settlement_requests(id) on delete cascade,
  ledger_id text not null references public.ledgers(id) on delete cascade,
  event_type text not null check (event_type in (
    'calculated',
    'requested',
    'marked_paid',
    'confirmed',
    'disputed',
    'cancelled',
    'reopened',
    'payment_reminder_sent',
    'confirmation_reminder_sent'
  )),
  from_status text check (
    from_status is null or from_status in ('open', 'requested', 'paid_pending', 'paid', 'cancelled')
  ),
  to_status text check (
    to_status is null or to_status in ('open', 'requested', 'paid_pending', 'paid', 'cancelled')
  ),
  actor_member_id uuid references public.ledger_members(id) on delete set null,
  reminder_number integer check (reminder_number is null or reminder_number > 0),
  occurred_at timestamptz not null,
  event_source text not null default 'live' check (event_source in ('live', 'legacy_backfill')),
  recorded_at timestamptz not null default now()
);

create index if not exists settlement_request_events_request_time_idx
  on public.settlement_request_events (settlement_request_id, occurred_at, id);

create index if not exists settlement_request_events_ledger_time_idx
  on public.settlement_request_events (ledger_id, occurred_at desc, id);

alter table public.settlement_request_events enable row level security;

drop policy if exists "Ledger members can read settlement request events"
  on public.settlement_request_events;
create policy "Ledger members can read settlement request events"
  on public.settlement_request_events
  for select
  using (public.is_ledger_member(ledger_id));

revoke all on table public.settlement_request_events from public;
revoke all on table public.settlement_request_events from anon;
revoke all on table public.settlement_request_events from authenticated;
revoke all on table public.settlement_request_events from service_role;
grant select on table public.settlement_request_events to authenticated;
grant select on table public.settlement_request_events to service_role;

-- Preserve only timestamps that the legacy row actually knows. In particular, do
-- not invent a dispute time from updated_at or infer claim/confirmation actors:
-- admins and retired auto-confirm paths mean the party ids are not reliable actors.
insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'calculated', null, 'open', null, sr.created_at, 'legacy_backfill'
from public.settlement_requests sr
where not exists (
  select 1 from public.settlement_request_events e
  where e.settlement_request_id = sr.id and e.event_type = 'calculated'
);

insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'requested', 'open', 'requested',
       sr.requested_by_member_id, sr.requested_at, 'legacy_backfill'
from public.settlement_requests sr
where sr.requested_at is not null
  and not exists (
    select 1 from public.settlement_request_events e
    where e.settlement_request_id = sr.id and e.event_type = 'requested'
  );

insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'marked_paid', 'requested', 'paid_pending',
       null, sr.paid_claimed_at, 'legacy_backfill'
from public.settlement_requests sr
where sr.paid_claimed_at is not null
  and not exists (
    select 1 from public.settlement_request_events e
    where e.settlement_request_id = sr.id and e.event_type = 'marked_paid'
  );

insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'confirmed',
       case when sr.paid_claimed_at is null then 'requested' else 'paid_pending' end,
       'paid',
       null, sr.paid_at, 'legacy_backfill'
from public.settlement_requests sr
where sr.paid_at is not null
  and not exists (
    select 1 from public.settlement_request_events e
    where e.settlement_request_id = sr.id and e.event_type = 'confirmed'
  );

insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, reminder_number, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'payment_reminder_sent', sr.status, sr.status,
       null, sr.reminder_count, sr.last_reminder_at, 'legacy_backfill'
from public.settlement_requests sr
where sr.last_reminder_at is not null
  and sr.reminder_count > 0
  and not exists (
    select 1 from public.settlement_request_events e
    where e.settlement_request_id = sr.id and e.event_type = 'payment_reminder_sent'
  );

insert into public.settlement_request_events (
  settlement_request_id, ledger_id, event_type, from_status, to_status,
  actor_member_id, occurred_at, event_source
)
select sr.id, sr.ledger_id, 'confirmation_reminder_sent', sr.status, sr.status,
       null, sr.last_confirm_reminder_at, 'legacy_backfill'
from public.settlement_requests sr
where sr.last_confirm_reminder_at is not null
  and not exists (
    select 1 from public.settlement_request_events e
    where e.settlement_request_id = sr.id and e.event_type = 'confirmation_reminder_sent'
  );

create or replace function public.record_settlement_request_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_actor_member_id uuid;
begin
  safe_actor_member_id := public.current_ledger_member_id(new.ledger_id);

  if tg_op = 'INSERT' then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'calculated', null, 'open',
      safe_actor_member_id, new.created_at
    );

    if new.status = 'requested' and new.requested_at is not null then
      insert into public.settlement_request_events (
        settlement_request_id, ledger_id, event_type, from_status, to_status,
        actor_member_id, occurred_at
      ) values (
        new.id, new.ledger_id, 'requested', 'open', 'requested',
        coalesce(safe_actor_member_id, new.requested_by_member_id), new.requested_at
      );
    end if;

    return new;
  end if;

  if old.status = 'paid_pending' and new.status = 'requested' then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'disputed', old.status, new.status,
      safe_actor_member_id, now()
    );
  elsif new.status = 'requested'
        and (old.status is distinct from new.status or old.requested_at is distinct from new.requested_at) then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'requested', old.status, new.status,
      coalesce(safe_actor_member_id, new.requested_by_member_id), coalesce(new.requested_at, now())
    );
  elsif old.status is distinct from new.status then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id,
      new.ledger_id,
      case new.status
        when 'paid_pending' then 'marked_paid'
        when 'paid' then 'confirmed'
        when 'cancelled' then 'cancelled'
        when 'open' then 'reopened'
      end,
      old.status,
      new.status,
      safe_actor_member_id,
      case new.status
        when 'paid_pending' then coalesce(new.paid_claimed_at, now())
        when 'paid' then coalesce(new.paid_at, now())
        else now()
      end
    );
  end if;

  if new.reminder_count > old.reminder_count
     and new.last_reminder_at is distinct from old.last_reminder_at then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, reminder_number, occurred_at
    ) values (
      new.id, new.ledger_id, 'payment_reminder_sent', new.status, new.status,
      null, new.reminder_count, coalesce(new.last_reminder_at, now())
    );
  end if;

  if new.last_confirm_reminder_at is distinct from old.last_confirm_reminder_at
     and new.last_confirm_reminder_at is not null then
    insert into public.settlement_request_events (
      settlement_request_id, ledger_id, event_type, from_status, to_status,
      actor_member_id, occurred_at
    ) values (
      new.id, new.ledger_id, 'confirmation_reminder_sent', new.status, new.status,
      null, new.last_confirm_reminder_at
    );
  end if;

  return new;
end;
$$;

revoke all on function public.record_settlement_request_event() from public;
revoke all on function public.record_settlement_request_event() from anon;
revoke all on function public.record_settlement_request_event() from authenticated;
revoke all on function public.record_settlement_request_event() from service_role;

drop trigger if exists record_settlement_request_event_trigger
  on public.settlement_requests;
create trigger record_settlement_request_event_trigger
after insert or update on public.settlement_requests
for each row execute function public.record_settlement_request_event();

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '137_settlement_event_history',
  'Add a privacy-minimised, append-only settlement event history with exact lifecycle/reminder timestamps, workspace-scoped read RLS, and database-triggered capture across every write path.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

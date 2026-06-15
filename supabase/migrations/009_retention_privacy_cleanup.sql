-- Migration 009: data retention/privacy cleanup helpers for temporary notification/debug records.


-- Data retention and privacy cleanup helpers. These functions intentionally delete
-- only temporary/debug records: old in-app notification events and stale push
-- subscriptions. Real trips, fuel logs, bookings, settlements, closed periods,
-- and audit-critical ledger history are not touched.
create or replace function public.preview_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can preview retention cleanup';
  end if;

  select count(*) into event_count
  from public.ledger_events
  where ledger_id = target_ledger_id
    and (
      expires_at < now()
      or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
    );

  select count(*) into push_count
  from public.push_subscriptions
  where updated_at < now() - make_interval(days => greatest(stale_push_days, 30));

  return jsonb_build_object(
    'ledger_events', event_count,
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days
  );
end;
$$;

create or replace function public.run_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run retention cleanup';
  end if;

  with deleted_events as (
    delete from public.ledger_events
    where ledger_id = target_ledger_id
      and (
        expires_at < now()
        or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
      )
    returning 1
  )
  select count(*) into event_count from deleted_events;

  with deleted_push as (
    delete from public.push_subscriptions
    where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
    returning 1
  )
  select count(*) into push_count from deleted_push;

  return jsonb_build_object(
    'ledger_events', event_count,
    'stale_push_subscriptions', push_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days
  );
end;
$$;

grant execute on function public.preview_retention_cleanup(text, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer) to authenticated;

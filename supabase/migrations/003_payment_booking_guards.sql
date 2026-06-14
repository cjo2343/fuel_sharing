-- Migration 003: settlement request transition/integrity guards and booking overlap guard.

create or replace function public.is_valid_payment_status_transition(p_previous_status text, p_next_status text)
returns boolean
language sql
immutable
as $$
  select case coalesce(p_previous_status, 'open')
    when 'open' then coalesce(p_next_status, 'open') in ('open', 'requested')
    when 'requested' then coalesce(p_next_status, 'open') in ('requested', 'paid', 'open', 'cancelled')
    when 'paid' then coalesce(p_next_status, 'open') in ('paid', 'open')
    when 'cancelled' then coalesce(p_next_status, 'open') in ('cancelled', 'requested', 'open')
    else false
  end;
$$;

create or replace function public.enforce_settlement_request_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
begin
  if new.ledger_id is null or new.ledger_id = '' then
    raise exception 'Settlement request is missing a ledger id' using errcode = '23502';
  end if;

  if new.from_member_id is null or new.to_member_id is null then
    raise exception 'Settlement request must include both payer and recipient members' using errcode = '23502';
  end if;

  if new.from_member_id = new.to_member_id then
    raise exception 'Settlement request payer and recipient must be different members' using errcode = '23514';
  end if;

  if not public.member_belongs_to_ledger(new.from_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.to_member_id, new.ledger_id)
     or not public.member_belongs_to_ledger(new.requested_by_member_id, new.ledger_id) then
    raise exception 'Settlement request members must belong to the same ledger' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and not public.is_valid_payment_status_transition(old.status, new.status) then
    raise exception 'Invalid settlement request status transition from % to %', old.status, new.status using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and coalesce(new.status, 'open') = 'paid' then
    raise exception 'Request the payment before marking it paid' using errcode = '23514';
  end if;

  actor_member_id := public.current_ledger_member_id(new.ledger_id);
  if not public.is_ledger_admin(new.ledger_id) then
    if coalesce(new.status, 'open') = 'requested'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'requested')
       and actor_member_id is distinct from new.to_member_id then
      raise exception 'Only the payment recipient can request this payment' using errcode = '42501';
    end if;

    if coalesce(new.status, 'open') = 'paid'
       and (tg_op = 'INSERT' or coalesce(old.status, 'open') <> 'paid')
       and actor_member_id is distinct from new.from_member_id then
      raise exception 'Only the payer can mark this payment paid' using errcode = '42501';
    end if;
  end if;

  if new.status = 'requested' then
    new.requested_at := coalesce(new.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, actor_member_id, new.to_member_id);
    new.paid_at := null;
  elsif new.status = 'paid' then
    new.requested_at := coalesce(new.requested_at, old.requested_at, now());
    new.requested_by_member_id := coalesce(new.requested_by_member_id, old.requested_by_member_id, new.to_member_id);
    new.paid_at := coalesce(new.paid_at, now());
  elsif new.status in ('open', 'cancelled') then
    new.requested_at := null;
    new.requested_by_member_id := null;
    new.paid_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_settlement_request_integrity_trigger on public.settlement_requests;
create trigger enforce_settlement_request_integrity_trigger
before insert or update of ledger_id, period_id, from_member_id, to_member_id, amount, status, requested_at, paid_at, requested_by_member_id
on public.settlement_requests
for each row execute function public.enforce_settlement_request_integrity();

create or replace function public.prevent_overlapping_car_bookings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from public.car_bookings existing
    where existing.ledger_id = new.ledger_id
      and existing.deleted_at is null
      and existing.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and new.start_at < existing.end_at
      and new.end_at > existing.start_at
  ) then
    raise exception 'The car is already booked for that time.' using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_overlapping_car_bookings_trigger on public.car_bookings;
create trigger prevent_overlapping_car_bookings_trigger
before insert or update of ledger_id, start_at, end_at, deleted_at
on public.car_bookings
for each row execute function public.prevent_overlapping_car_bookings();

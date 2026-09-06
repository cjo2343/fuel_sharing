-- Migration 211: Publish booking edits and cancellations to Realtime (GVM-597)
--
-- Two-device QA reproduced successful edits that stayed stale on the other phone:
-- upsert_car_booking only emitted an event on creation, while both clients subscribe
-- to ledger_events rather than car_bookings. Emit booking_updated for material edits
-- (member, dates, note, route/fuel stop or restoration) and booking_created for creates.
-- Cancellations emit booking_deleted once. These events are feed-visible, carry only
-- booking_id metadata, and use server-authored
-- Danish fallback copy when the caller omits optional event text.
--
-- Re-declared from the newest definition, migration 162. Its signature, authorization,
-- per-booking/member locks, duration/day/horizon caps and GV42B check are unchanged.
-- An unchanged call returns the existing id without writing or moving updated_at.
-- Stale expected_updated_at still rejects even an otherwise identical payload; this
-- does not weaken conflict protection or introduce a new operation-id contract.
-- The row and event share one transaction: a failed save or event inserts neither.
--
-- SQL must be applied manually in the Supabase SQL Editor after merge.

create or replace function public.upsert_car_booking(
  target_ledger_id text,
  legacy_booking_id text,
  booking_member_id uuid,
  start_at_value timestamptz,
  end_at_value timestamptz,
  purpose_value text,
  event_title text default null,
  event_body text default null,
  fuel_stop_value jsonb default null,
  expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  actor_first_name text;
  event_type_value text;
  saved_booking_id uuid;
  existing_booking record;
  cap_max_days integer;
  cap_horizon_days integer;
  would_hold_days integer;
  span_days integer;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Missing legacy booking id' using errcode = '22023';
  end if;

  if start_at_value is null or end_at_value is null or end_at_value <= start_at_value then
    raise exception 'Booking end time must be after start time' using errcode = '23514';
  end if;

  -- GV-426: an absolute ceiling on how long one booking may be. Until now `end > start`
  -- was the only length rule, so a booking running to 2031 was a valid booking — stored,
  -- and blocking the car in every conflict check that reads the table.
  --
  -- 92 days is a HARD CONSTANT, not a workspace setting: it is a sanity bound rather
  -- than a policy, so there is nothing here for a group to disagree about. A full
  -- quarter is longer than any real shared-car booking and well above the 30-day top
  -- preset the day cap offers, which is what makes it safe to apply to every existing
  -- workspace without asking anyone.
  --
  -- INCLUSIVE calendar days in Europe/Copenhagen — the same arithmetic
  -- public.booked_days_in_open_period does and the same "N dage" the booking sheet
  -- prints above the form, so the refusal and the number on screen agree. One date
  -- start to end is 1 day; nights or an hours interval would disagree by one.
  span_days := ((end_at_value at time zone 'Europe/Copenhagen')::date
                - (start_at_value at time zone 'Europe/Copenhagen')::date) + 1;
  if span_days > 92 then
    raise exception 'Bookingen varer % dage, og en booking kan højst vare 92 dage', span_days
      using errcode = 'GV46V';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save car bookings' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if booking_member_id is null or not public.member_belongs_to_ledger(booking_member_id, target_ledger_id) then
    raise exception 'Booking member must be an active member of this ledger' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':booking:' || legacy_booking_id));

  select *
    into existing_booking
  from public.car_bookings
  where ledger_id = target_ledger_id
    and legacy_id = legacy_booking_id
  for update;

  if existing_booking.id is not null and not public.can_manage_car_booking(existing_booking.id) then
    raise exception 'Only the booking creator, booked member, or a ledger admin can update this booking' using errcode = '42501';
  end if;

  if existing_booking.id is null
     and not (
       public.is_ledger_admin(target_ledger_id)
       or actor_member_id = booking_member_id
     ) then
    raise exception 'Only the booked member or a ledger admin can create this booking' using errcode = '42501';
  end if;

  -- GV-421: optimistic-concurrency precondition. Null (or absent) means no
  -- precondition, which is every client that has ever shipped and is byte-identical
  -- to the behaviour above this line. A token against a row that does not exist yet
  -- is ignored — a create cannot conflict. Truncated to milliseconds because a token
  -- that has passed through a JavaScript Date has lost its microseconds, and a
  -- microsecond-exact comparison would refuse every edit forever; see the header.
  --
  -- Ahead of the caps below on purpose: a booked-days count that includes a window
  -- this caller has never seen is answering a question nobody asked, and "loftet er
  -- nået" would be the wrong sentence for a row that simply moved.
  if expected_updated_at is not null
     and existing_booking.id is not null
     and date_trunc('milliseconds', existing_booking.updated_at)
         is distinct from date_trunc('milliseconds', expected_updated_at) then
    raise exception 'En anden har ændret bookingen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.'
      using errcode = 'GV42B';
  end if;

  -- ── Booking caps (GVM-463) ───────────────────────────────────────────────────
  -- Both null for every workspace that has not opted in, in which case neither
  -- branch below runs and this function behaves exactly as migration 063 left it.
  select l.booking_max_days_per_member, l.booking_horizon_days
    into cap_max_days, cap_horizon_days
  from public.ledgers l
  where l.id = target_ledger_id;

  -- Horizon: the last permitted START DATE is today + N in Danish local time, so
  -- day N is accepted at any hour and day N + 1 is refused. Forward-only — a start
  -- date in the past is smaller than the bound and can never trip this.
  if cap_horizon_days is not null
     and (start_at_value at time zone 'Europe/Copenhagen')::date
         > ((now() at time zone 'Europe/Copenhagen')::date + cap_horizon_days) then
    raise exception 'Du kan højst booke % dage frem', cap_horizon_days
      using errcode = 'GV46H';
  end if;

  -- Booked days: what the member WOULD hold once this window is saved, with the row
  -- being edited excluded so shrinking a booking is never refused. Sitting exactly
  -- ON the cap is allowed; the booking that would take them past it is not.
  if cap_max_days is not null then
    -- GV-426: serialize the COUNT, which the lock above cannot do. That one is keyed on
    -- this one booking, so two saves for two different legacy ids never wait for each
    -- other — and the number below is about every booking the MEMBER holds. Both
    -- writers read it before either inserts, both see room, and both are saved. This
    -- second lock is keyed on (ledger, member), which is the pair the count is over.
    --
    -- Inside the branch on purpose: a workspace with no day cap must gain no new
    -- contention at all, so the lock is exactly as wide as the rule it protects. Taken
    -- after the per-booking and row locks, so every caller acquires in the same order.
    perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':bookingcap:' || booking_member_id::text));

    would_hold_days := public.booked_days_in_open_period(
      target_ledger_id,
      booking_member_id,
      existing_booking.id,
      start_at_value,
      end_at_value
    );

    if would_hold_days > cap_max_days then
      raise exception 'Bookingen ville give % bookede dage i perioden, og gruppens loft er %',
        would_hold_days, cap_max_days
        using errcode = 'GV46D';
    end if;
  end if;

  if existing_booking.id is null then
    insert into public.car_bookings (
      legacy_id,
      ledger_id,
      member_id,
      start_at,
      end_at,
      purpose,
      fuel_stop,
      created_by_member_id,
      deleted_at,
      updated_at
    ) values (
      legacy_booking_id,
      target_ledger_id,
      booking_member_id,
      start_at_value,
      end_at_value,
      nullif(purpose_value, ''),
      fuel_stop_value,
      actor_member_id,
      null,
      now()
    )
    returning id into saved_booking_id;
    event_type_value := 'booking_created';
  elsif row(existing_booking.member_id, existing_booking.start_at, existing_booking.end_at,
            existing_booking.purpose, existing_booking.fuel_stop, existing_booking.deleted_at)
        is distinct from
        row(booking_member_id, start_at_value, end_at_value,
            nullif(purpose_value, ''), fuel_stop_value, null::timestamptz) then
    update public.car_bookings
    set member_id = booking_member_id,
        start_at = start_at_value,
        end_at = end_at_value,
        purpose = nullif(purpose_value, ''),
        fuel_stop = fuel_stop_value,
        deleted_at = null,
        updated_at = now()
    where id = existing_booking.id
    returning id into saved_booking_id;
    event_type_value := 'booking_updated';
  else
    -- An unchanged replay must not create feed noise or invalidate another editor.
    -- Authorization and the existing optimistic-concurrency check still run first.
    return jsonb_build_object(
      'booking_id', existing_booking.id,
      'legacy_id', legacy_booking_id
    );
  end if;

  -- Other clients subscribe to ledger_events, not car_bookings. Optional copy
  -- must never decide whether a committed write reaches those subscribers.
  select split_part(btrim(lm.name), ' ', 1) into actor_first_name
  from public.ledger_members lm where lm.id = actor_member_id;

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, event_type_value,
    coalesce(nullif(btrim(event_title), ''),
      coalesce(nullif(actor_first_name, ''), 'Nogen') ||
      case when event_type_value = 'booking_created'
        then ' bookede bilen' else ' ændrede en booking' end),
    coalesce(event_body, ''),
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object('booking_id', saved_booking_id)
  );

  return jsonb_build_object(
    'booking_id', saved_booking_id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) from public;
revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) from anon;
grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) to authenticated;


-- Preserve the original cancellation contract (011) and serialize against saves
-- with the same per-booking lock. Repeated cancellation has no second transition.
create or replace function public.soft_delete_car_booking(
  target_ledger_id text,
  legacy_booking_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_booking record;
  actor_member_id uuid;
  actor_first_name text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Missing legacy booking id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can delete car bookings' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':booking:' || legacy_booking_id));

  select *
    into existing_booking
  from public.car_bookings
  where ledger_id = target_ledger_id
    and legacy_id = legacy_booking_id
  for update;

  if existing_booking.id is null then
    return jsonb_build_object(
      'deleted', false,
      'legacy_id', legacy_booking_id,
      'reason', 'not_found'
    );
  end if;

  if not public.can_manage_car_booking(existing_booking.id) then
    raise exception 'Only the booking creator, booked member, or a ledger admin can delete this booking' using errcode = '42501';
  end if;

  if existing_booking.deleted_at is null then
    update public.car_bookings
    set deleted_at = now(),
        updated_at = now()
    where id = existing_booking.id;

    actor_member_id := public.current_ledger_member_id(target_ledger_id);
    select split_part(btrim(lm.name), ' ', 1) into actor_first_name
    from public.ledger_members lm where lm.id = actor_member_id;

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'booking_deleted',
      coalesce(nullif(actor_first_name, ''), 'Nogen') || ' aflyste en booking', '',
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', existing_booking.id)
    );
  end if;

  return jsonb_build_object(
    'deleted', true,
    'booking_id', existing_booking.id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

revoke all on function public.soft_delete_car_booking(text, text) from public;
revoke all on function public.soft_delete_car_booking(text, text) from anon;
grant execute on function public.soft_delete_car_booking(text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('211_booking_edit_realtime_events', 'GVM-597: emit booking_created/booking_updated/booking_deleted for material transitions even without optional copy; unchanged saves and repeated cancellations preserve the row and edit token.')
on conflict (migration_id) do update set description = excluded.description, applied_at = now();

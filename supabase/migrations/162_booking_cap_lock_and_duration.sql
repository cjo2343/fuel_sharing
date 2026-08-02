-- Migration 162: booking cap serialization + an absolute duration ceiling
--
-- GV-426. Two independent holes in public.upsert_car_booking, both left behind by
-- migrations 159 and 160, both closed here. The signature does not move, so
-- create-or-replace is enough: no DROP, no restated ACLs, no PGRST202 merge order,
-- and no client build — old or new — can be stranded by the order this is applied in.
--
-- ── 1. The day cap was never serialized, so it could be walked past ────────────
--
-- Migration 159 counts the member's booked days and refuses the booking that would
-- take them past the cap. Migration 063 had already put an advisory lock in this
-- function, and 159 placed its counting near it, which is what made the gap easy to
-- miss: the existing lock is keyed on
--
--     hashtext(target_ledger_id || ':booking:' || legacy_booking_id)
--
-- — one BOOKING. It serializes two writers editing the SAME booking, which is what it
-- was added for. But the cap counts every booking the MEMBER holds, and two saves for
-- different legacy ids take two different locks and therefore never wait for each
-- other. Both read the count before either has inserted, both see a number under the
-- cap, and both are written: a member with a cap of 5 ends up holding 6 days, in a
-- workspace whose whole reason for setting the cap was that this cannot happen. Two
-- devices, or one device replaying a queued offline write while the sheet saves
-- another, are enough — no unusual timing is required, only overlap.
--
-- The fix is a SECOND advisory lock, scoped to the pair the count is actually about:
--
--     hashtext(target_ledger_id || ':bookingcap:' || booking_member_id::text)
--
-- A distinct infix, so the two key spaces cannot collide: ':booking:' + a legacy id is
-- a different string from ':bookingcap:' + a member uuid, and hashing them separately
-- keeps a booking lock from silently standing in for a member lock or vice versa.
--
-- Taken ONLY inside the `cap_max_days is not null` branch. That is the whole design
-- constraint: every workspace that has not opted in must gain exactly zero new
-- contention, and a member lock taken unconditionally would serialize every concurrent
-- booking for one person in every group in the product to protect a rule almost none
-- of them have turned on. Inside the branch the serialization is exactly as wide as
-- the rule it protects.
--
-- It sits immediately before the count, after the per-booking lock and the row lock, so
-- the acquisition order is the same for every caller (booking → row → member) and no
-- two invocations of this function can form a cycle.
--
-- Correctness of the count once the lock is held is the ordinary read-committed
-- property: the counting statement is a separate statement inside a volatile function,
-- so it takes its snapshot after the wait ends and sees the rows the winner committed.
-- The contract test proves this rather than assuming it — it holds one session open,
-- shows the second is really waiting on a lock, then commits and asserts the second is
-- refused with GV46D.
--
-- ── 2. A booking had no maximum length at all ─────────────────────────────────
--
-- The only window rule was `end > start`. A booking from today to 2031 was a valid
-- booking: it passed every gate, it was stored, and it blocked the car for six years
-- in every conflict check that reads the table. The day cap does not cover this — it
-- is null for almost every workspace, and it is a fairness rule between members rather
-- than a bound on what a booking can be.
--
-- So: at most 92 days, refused with errcode GV46V ('V' for varighed, following the
-- trailing-letter convention 159 started with GV46D/GV46H and 160 continued).
--
-- 92 is a HARD CONSTANT and deliberately not a setting. It is a sanity bound, not a
-- policy: it exists to stop a typo or a runaway client from parking the car for years,
-- not to express anything a group might reasonably disagree about. A setting would
-- imply the number is a decision somebody should make, would need a setter RPC, an
-- admin surface and a migration to change, and would still have to have a ceiling of
-- its own. 92 days is a full quarter — longer than any real shared-car booking, and
-- comfortably above the 30-day upper preset the day cap offers — so no honest booking
-- ever meets it.
--
-- Measured as INCLUSIVE calendar days in Europe/Copenhagen, which is the same
-- arithmetic public.booked_days_in_open_period uses and the same "N dage" the booking
-- sheet has always printed above the form. A booking that starts and ends on one date
-- is 1 day. Any other measure — nights, or an interval in hours — would make the
-- refusal disagree by one with the number on the user's screen, and 159 already made
-- the argument for why that reads as a bug every time it fires.
--
-- The check sits with the other window validation, next to `end > start`, before the
-- membership gates: it judges only the two timestamps the caller sent, so it can be
-- answered without looking anything up, and it leaks nothing about the ledger.
--
-- No new event_type: a refused booking is a write that did not happen.
--
-- MERGE ORDER: this SQL should be applied before the govehlo-mobile companion that
-- classifies GV46V, but the direction is soft — an old client that hits the ceiling
-- simply gets an unknown SQLSTATE with a Danish message, which the companion turns
-- into an immediate, correctly-worded refusal instead of eight retries.

-- ── upsert_car_booking — re-declared off migration 160 ─────────────────────────
-- 160 verbatim (which was 159 verbatim plus the GV-421 conflict guard) apart from the
-- duration check added to the window validation and the member-scoped advisory lock
-- added inside the day-cap branch. The GV-421 guard stays exactly where 160 put it,
-- ahead of the caps.
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
  else
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
  end if;

  -- Activity feed event, on create only (GVM-84).
  if existing_booking.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'booking_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', saved_booking_id)
    );
  end if;

  return jsonb_build_object(
    'booking_id', saved_booking_id,
    'legacy_id', legacy_booking_id
  );
end;
$$;

revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) from public;
revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) from anon;
grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb, timestamptz) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '162_booking_cap_lock_and_duration',
  'GV-426: two write gaps in public.upsert_car_booking, closed without moving the signature (create-or-replace, so no PGRST202 merge order and no client can be stranded). (1) The GVM-463 day cap was counted without serialization. The advisory lock migration 063 added is keyed hashtext(ledger || '':booking:'' || legacy_id) — one BOOKING — so it serializes two writers editing the same booking but not two saves for DIFFERENT legacy ids, which is what the cap is counted across: both read booked_days_in_open_period before either inserts, both see room under the cap, and both are written, leaving a member holding more days than the group''s rule allows. No unusual timing is needed, only overlap — two devices, or one device replaying a queued offline write while the sheet saves another. A SECOND advisory lock keyed hashtext(ledger || '':bookingcap:'' || member_id) now covers the pair the count is actually over; the infix differs so the two key spaces cannot collide. It is taken ONLY inside the `cap_max_days is not null` branch, because a workspace that never opted in must gain exactly zero new contention — an unconditional member lock would serialize one person''s concurrent bookings in every group in the product to protect a rule almost none of them have turned on. Acquisition order is booking lock, row lock, member lock for every caller, so no two invocations can form a cycle, and the count re-reads under read-committed after the wait, so the loser sees the winner''s committed rows. (2) A booking had no maximum length: `end > start` was the only window rule, so a booking running to 2031 was valid, stored, and blocked the car in every conflict check that reads the table — and the day cap does not cover it, being null for almost every workspace and a fairness rule between members rather than a bound on what a booking can be. A booking may now span at most 92 days, refused with errcode GV46V (''V'' for varighed, following the trailing-letter convention of 159''s GV46D/GV46H and 160''s GV42T/GV42F/GV42B). 92 is a HARD CONSTANT and deliberately not a setting: it is a sanity bound rather than a policy, there is nothing in it for a group to disagree about, and a setting would need a setter RPC, an admin surface and a ceiling of its own. A full quarter is longer than any real shared-car booking and well above the 30-day top preset the day cap offers. The span is measured as INCLUSIVE calendar days in Europe/Copenhagen — the same arithmetic booked_days_in_open_period uses and the same "N dage" the booking sheet prints above the form — so the refusal and the number on screen agree; nights or an hours interval would disagree by one. The check sits with the other window validation next to `end > start`, ahead of the membership gates, because it judges only the two timestamps the caller sent and so leaks nothing about the ledger. The GV-421 conflict guard stays exactly where migration 160 put it, before the caps. No new event_type — a refused booking is a write that did not happen. MERGE ORDER: apply this before the govehlo-mobile companion that classifies GV46V, though the direction is soft: an old client that hits the ceiling gets an unknown SQLSTATE carrying a Danish sentence, and the companion only turns that into an immediate correctly-worded refusal instead of eight retries.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

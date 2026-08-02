-- Migration 159: booking caps — booked days per member and how far ahead (GVM-463)
--
-- The SECOND dimension of the booking cap. Migration 152 (GVM-434) added the first,
-- booking_future_cap_per_member, and closed with a promise this migration keeps:
--
--     "COUNT OF BOOKINGS, not booked days — the ticket's open question. […] The
--      days/horizon variant stays available as a later, separate setting."
--
-- It is now two later, separate settings, because the owner decided BOTH halves:
--
--   • booking_max_days_per_member — how much of the period one member may hold
--   • booking_horizon_days        — how far ahead anyone may plant a claim
--
-- Together with 152 they answer three different unfairnesses, which is why they are
-- three columns and not one. A count-based cap catches twelve scattered weekends and
-- is blind to one member booking July. A day-based cap catches July and is blind to
-- somebody quietly reserving next Easter in August. A horizon catches that and is
-- blind to both of the others. Each stands alone; a group may run any subset.
--
-- BOTH ARE NULLABLE AND NULL IS THE DEFAULT, so this migration changes the behaviour
-- of exactly zero existing workspaces. No backfill, no default value, no trigger that
-- fires on data nobody has looked at. A group that has never heard of these settings
-- keeps booking precisely as it did yesterday, and the columns only begin to bite
-- after an admin sets a number. That "off is byte-identical" property is pinned by a
-- test on both sides of the wire, because it is the only promise here that protects
-- live data.
--
-- ── ENFORCED, unlike migration 152 ─────────────────────────────────────────────
--
-- This is the deliberate break from the first dimension, and it is worth being loud
-- about because 152 argued the opposite case well.
--
-- 152 is a NUDGE: the database stores the number and nothing else, and the client
-- shows a heads-up that never blocks. That was right for a count — holding six
-- upcoming bookings is untidy, not broken, and the settled policy is soft warning as
-- the rule with a hard block reserved for the unambiguously broken case (GVM-413
-- warns on another member's window; GVM-417 blocks only DURING a running booking).
--
-- These two are RULES, and the difference is not severity but WHO IS HARMED and
-- whether a client can be trusted to hold the line. A cap that only lives in the
-- booking sheet is enforced by whichever build the member happens to be running: an
-- old binary, a queued offline write replayed weeks later, or anything speaking to
-- PostgREST directly sails straight past it, and the member who obeyed the rule is
-- the only one it applied to. A fairness rule that the honest client alone respects
-- is worse than no rule, because the group now believes it has one.
--
-- So both caps are checked inside public.upsert_car_booking, the single write path for
-- every booking, and a violation is REJECTED with its own errcode:
--
--     GV46D  the booking would take this member past the booked-days cap
--     GV46H  the booking starts beyond the workspace's horizon
--
-- Two codes from one ticket. The repo's convention is the bare ticket number (GV328,
-- GV333 from migrations 133/135), but that gives one code per ticket and the client
-- has to tell these two apart to say anything useful — so the trailing letter names
-- the dimension, D for dage and H for horisont. 'GV464' was the obvious alternative
-- and is rejected on purpose: it would name a ticket that has nothing to do with this
-- and would read as a lie the day GV-464 exists.
--
-- The messages are Danish and readable on their own, so a raw surfacing degrades to
-- something a person can act on; the client maps the codes to fuller copy that also
-- names the member's current count.
--
-- ── What a "day" is ────────────────────────────────────────────────────────────
--
-- A calendar day in Europe/Copenhagen that the booking TOUCHES, counted inclusively
-- from its start date to its end date. Fri 09:00 → Fri 18:00 is 1 day. Fri 22:00 →
-- Sat 06:00 is 2 — it touches two calendar days, and a booking that spans midnight
-- genuinely does take the car out of the group's hands on both of them.
--
-- The inclusive end has one edge worth naming: Fri 09:00 → Sat 00:00 counts 2, even
-- though the car is back before Saturday begins. That is not an oversight. The
-- booking sheet has shown its own "N dage" summary using exactly this arithmetic
-- since long before this cap existed, and a cap that disagrees with the number on the
-- screen directly above it is a bug report every time it fires. Matching the visible
-- summary is worth more than midnight pedantry, and the mobile mirror computes it the
-- same way for the same reason.
--
-- Days are counted DISTINCT, as a union across the member's bookings. Two bookings on
-- the same Friday are one booked day, not two: the question the cap asks is how much
-- of the calendar this member is holding, and a day already held is not held twice.
--
-- ── Which days count: the open settlement period ───────────────────────────────
--
-- Days on or after the date the workspace's OPEN settlement period was opened. The
-- period model has no end date — exactly one period is open per ledger and it runs
-- until someone closes it (the one_open_settlement_period_per_ledger index) — so the
-- window is [opened_at, ∞) and in practice means "since this period began". The
-- useful consequence is that the count RESETS at close: a member who spent all of
-- their allowance in July starts August clear, which is what a group means when it
-- agrees a per-period number.
--
-- A ledger with no open period at all (mid-close, or one that has never opened one)
-- falls back to today's date rather than counting nothing. Counting nothing would
-- make the cap silently inoperative during exactly the window in which someone might
-- notice, and a cap that fails open is the failure mode this whole migration exists
-- to remove.
--
-- ── Where the horizon boundary sits ────────────────────────────────────────────
--
-- Calendar dates, not a timestamp offset, so the rule is one a person can repeat:
-- with a horizon of 30 you may book any day up to and including today + 30, at any
-- time of day, and today + 31 is refused. A timestamp offset would make the same
-- booking legal at 09:00 and illegal at 09:01, which nobody can predict or explain.
--
-- The horizon is FORWARD ONLY. It compares the start date against today + N and says
-- nothing about the past, so backdating stays exactly as permissive as it was — the
-- product deliberately allows logging what already happened, and a horizon that
-- blocked it would break the honest late entry while catching nobody.
--
-- ── Applies to everyone, admins included ───────────────────────────────────────
--
-- Neither cap exempts admins. A fairness rule the person who set it can quietly walk
-- through is not a fairness rule, and an admin who needs the exception already has the
-- honest one: raise the number, or turn the cap off, in front of the whole group —
-- both write a settings_changed row into the feed.

alter table public.ledgers
  add column if not exists booking_max_days_per_member integer,
  add column if not exists booking_horizon_days integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ledgers_booking_max_days_check'
  ) then
    alter table public.ledgers
      add constraint ledgers_booking_max_days_check
      check (booking_max_days_per_member is null
             or (booking_max_days_per_member >= 1 and booking_max_days_per_member <= 365));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'ledgers_booking_horizon_days_check'
  ) then
    alter table public.ledgers
      add constraint ledgers_booking_horizon_days_check
      check (booking_horizon_days is null
             or (booking_horizon_days >= 1 and booking_horizon_days <= 730));
  end if;
end $$;

comment on column public.ledgers.booking_max_days_per_member is
  'GVM-463: optional cap on the DISTINCT calendar days (Europe/Copenhagen) one member may hold in the open settlement period. NULL = off, and off is the default. Enforced in upsert_car_booking (errcode GV46D).';

comment on column public.ledgers.booking_horizon_days is
  'GVM-463: optional cap on how far ahead a booking may START — the last permitted start date is today + N in Europe/Copenhagen. NULL = off, and off is the default. Forward-only, so backdating is unaffected. Enforced in upsert_car_booking (errcode GV46H).';

-- ── booked_days_in_open_period: the day count, in one place ─────────────────────
--
-- One function so the enforcement and anything that later wants to SHOW the number
-- cannot drift apart. `extra_start` / `extra_end` let a caller ask the counterfactual
-- question the booking path actually needs — "how many days would this member hold IF
-- I saved this window?" — without writing anything first.
--
-- `exclude_booking_id` is what makes editing work: the row being updated is already
-- in the table with its OLD window, and counting both it and the replacement would
-- refuse an edit that shrinks the booking.
--
-- Membership-gated like calculate_period_settlement rather than left open, because it
-- is security definer and would otherwise answer questions about any ledger's members.
create or replace function public.booked_days_in_open_period(
  target_ledger_id text,
  target_member_id uuid,
  exclude_booking_id uuid default null,
  extra_start timestamptz default null,
  extra_end timestamptz default null
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  period_start date;
  total integer;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can count booked days' using errcode = '42501';
  end if;

  if target_member_id is null then
    return 0;
  end if;

  select (sp.opened_at at time zone 'Europe/Copenhagen')::date
    into period_start
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
  limit 1;

  -- Fail CLOSED, not open: with no open period the cap still counts from today
  -- rather than reporting zero and waving everything through.
  if period_start is null then
    period_start := (now() at time zone 'Europe/Copenhagen')::date;
  end if;

  with windows as (
    select b.start_at, b.end_at
    from public.car_bookings b
    where b.ledger_id = target_ledger_id
      and b.member_id = target_member_id
      and b.deleted_at is null
      and (exclude_booking_id is null or b.id <> exclude_booking_id)
    union all
    select extra_start, extra_end
    where extra_start is not null
      and extra_end is not null
  ),
  touched as (
    select distinct d::date as day
    from windows w
    cross join lateral generate_series(
      (w.start_at at time zone 'Europe/Copenhagen')::date,
      (w.end_at   at time zone 'Europe/Copenhagen')::date,
      interval '1 day'
    ) as d
  )
  select count(*)::integer
    into total
  from touched
  where touched.day >= period_start;

  return coalesce(total, 0);
end;
$$;

revoke all on function public.booked_days_in_open_period(text, uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function public.booked_days_in_open_period(text, uuid, uuid, timestamptz, timestamptz) from anon;
grant execute on function public.booked_days_in_open_period(text, uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ── set_booking_max_days_per_member / set_booking_horizon_days ──────────────────
--
-- Two NEW admin-gated RPCs, one per setting, rather than parameters on
-- update_ledger_settings. Two independent reasons, and either one alone decides it:
--
--   1. update_ledger_settings coalesce-patches, so a null parameter there means
--      "leave it alone" and there would be no way to express "turn the cap off" —
--      the exact reason migrations 080 and 152 gave their settings their own RPCs.
--      Here null IS the value, and it is the off value.
--   2. A new function has no signature to break. Adding a parameter to an existing
--      RPC means DROP + re-CREATE, restated ACLs, and a merge order where PostgREST
--      rejects the client that ships before the SQL is applied (PGRST202) — the
--      158/157/063 lesson. Nothing here can strand a client, because no existing
--      signature moves.
--
-- Each emits a settings_changed event on a REAL change only (`is distinct from`, so
-- re-saving the same number writes nothing), exactly as 119 and 152 do: that insert IS
-- the cross-client live sync (migration 087 lesson), and a rule about everyone's
-- bookings belongs in everyone's feed. settings_changed is already feed-visible, so no
-- new event_type is introduced. Danish server copy, overridable by the client for app
-- voice.
create or replace function public.set_booking_max_days_per_member(
  target_ledger_id text,
  cap_value integer,
  event_title text default null,
  event_body text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_cap integer;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change the booking day cap.' using errcode = '42501';
  end if;

  -- Rejected up front so an unusable number surfaces as a sentence rather than a
  -- raw 23514 from the check constraint. A year of booked days is not a cap.
  if cap_value is not null and (cap_value < 1 or cap_value > 365) then
    raise exception 'Booking day cap must be between 1 and 365' using errcode = '22023';
  end if;

  select l.booking_max_days_per_member
    into old_cap
    from public.ledgers l
    where l.id = target_ledger_id;

  update public.ledgers l
  set booking_max_days_per_member = cap_value,
      updated_at = now()
  where l.id = target_ledger_id;

  if cap_value is distinct from old_cap then
    actor_id := public.current_ledger_member_id(target_ledger_id);
    current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      coalesce(nullif(btrim(event_title), ''), 'Bookingloft ændret'),
      coalesce(
        nullif(btrim(event_body), ''),
        case
          when cap_value is null then 'Der er ikke længere et loft over bookede dage.'
          when cap_value = 1 then 'Hver person kan nu booke højst 1 dag i perioden.'
          else 'Hver person kan nu booke højst ' || cap_value::text || ' dage i perioden.'
        end
      ),
      actor_id,
      current_actor_email,
      jsonb_build_object(
        'field', 'booking_max_days_per_member',
        'old', old_cap,
        'new', cap_value
      )
    );
  end if;
end;
$$;

revoke all on function public.set_booking_max_days_per_member(text, integer, text, text) from public;
revoke all on function public.set_booking_max_days_per_member(text, integer, text, text) from anon;
grant execute on function public.set_booking_max_days_per_member(text, integer, text, text) to authenticated;

create or replace function public.set_booking_horizon_days(
  target_ledger_id text,
  horizon_value integer,
  event_title text default null,
  event_body text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_horizon integer;
  actor_id uuid;
  current_actor_email text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change the booking horizon.' using errcode = '42501';
  end if;

  -- Two years out is already further than any shared car is planned; beyond that the
  -- horizon is not a rule, it is an off switch spelled the long way.
  if horizon_value is not null and (horizon_value < 1 or horizon_value > 730) then
    raise exception 'Booking horizon must be between 1 and 730 days' using errcode = '22023';
  end if;

  select l.booking_horizon_days
    into old_horizon
    from public.ledgers l
    where l.id = target_ledger_id;

  update public.ledgers l
  set booking_horizon_days = horizon_value,
      updated_at = now()
  where l.id = target_ledger_id;

  if horizon_value is distinct from old_horizon then
    actor_id := public.current_ledger_member_id(target_ledger_id);
    current_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'settings_changed',
      coalesce(nullif(btrim(event_title), ''), 'Bookinghorisont ændret'),
      coalesce(
        nullif(btrim(event_body), ''),
        case
          when horizon_value is null then 'Der er ikke længere en grænse for, hvor langt frem I kan booke.'
          when horizon_value = 1 then 'I kan nu booke højst 1 dag frem.'
          else 'I kan nu booke højst ' || horizon_value::text || ' dage frem.'
        end
      ),
      actor_id,
      current_actor_email,
      jsonb_build_object(
        'field', 'booking_horizon_days',
        'old', old_horizon,
        'new', horizon_value
      )
    );
  end if;
end;
$$;

revoke all on function public.set_booking_horizon_days(text, integer, text, text) from public;
revoke all on function public.set_booking_horizon_days(text, integer, text, text) from anon;
grant execute on function public.set_booking_horizon_days(text, integer, text, text) to authenticated;

-- ── upsert_car_booking: enforce both caps ──────────────────────────────────────
--
-- Re-declared off migration 063, which is its NEWEST prior definition — nothing
-- between 063 and here touches this function (the GV-202 lesson: re-declaring off an
-- intermediate copy is drift the equivalence checker cannot see). The signature is
-- UNCHANGED, so this is a create-or-replace with no drop, no ACL restatement beyond
-- the grant already carried, and no merge-order hazard: a client that predates this
-- migration calls the same nine arguments it always did.
--
-- Everything above and below the new block is byte-identical to 063. The block sits
-- after the manage/create permission checks, so an unauthorised caller still learns
-- nothing about the workspace's rules.
--
-- Honest about what it does NOT do: 063's advisory lock is keyed on the BOOKING, so
-- two different bookings by the same member saved at the same instant take different
-- locks, each counts a table the other has not written yet, and both can pass a
-- day-cap check that their sum would fail. Closing that would mean serialising on the
-- MEMBER, which would make every booking in a busy workspace queue behind every other
-- booking by the same person. Not worth it for this rule: the failure needs two
-- genuinely concurrent writes by one member, it overshoots by one booking rather than
-- unbounded, and the next save is refused because the count is then real. The
-- overlap trigger, which protects a correctness invariant rather than a fairness one,
-- is unaffected and still holds.
--
-- Both reads are one select against the ledgers row, and with both columns null the
-- function does exactly what it did before: no day count runs, no comparison fires,
-- and the write path is untouched. That is the off-by-default guarantee, and it is
-- structural rather than promised.
create or replace function public.upsert_car_booking(
  target_ledger_id text,
  legacy_booking_id text,
  booking_member_id uuid,
  start_at_value timestamptz,
  end_at_value timestamptz,
  purpose_value text,
  event_title text default null,
  event_body text default null,
  fuel_stop_value jsonb default null
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

revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) from public;
revoke all on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) from anon;
grant execute on function public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '159_booking_day_and_horizon_caps',
  'The booking cap''s second dimension (GVM-463), keeping the promise migration 152 made when it chose a count over days and wrote "the days/horizon variant stays available as a later, separate setting". Two new NULLABLE columns on ledgers, both NULL by default so no existing workspace changes behaviour and no backfill is needed: booking_max_days_per_member (check: null or 1..365) caps the DISTINCT calendar days in Europe/Copenhagen that one member may hold within the OPEN settlement period, and booking_horizon_days (check: null or 1..730) caps how far ahead a booking may START. A "day" is any calendar day the booking touches, counted inclusively from start date to end date — Fri 22:00 to Sat 06:00 is 2 — which is deliberately the same arithmetic the booking sheet has always shown as its "N dage" summary, including the Fri 09:00 to Sat 00:00 edge that counts 2; a cap that disagreed with the number on screen above it would read as a bug every time it fired. Days are DISTINCT across the member''s bookings, so two bookings on one Friday are one booked day. The counting window is [open period opened_at, infinity) because the period model has no end date, which means the allowance RESETS at close; a ledger with no open period falls back to today rather than counting nothing, so the cap fails closed. The horizon compares calendar DATES — the last permitted start is today + N at any hour, today + N + 1 is refused — rather than a timestamp offset that would make the same booking legal at 09:00 and illegal at 09:01, and it is FORWARD-ONLY so backdating is untouched. UNLIKE migration 152 these are ENFORCED, not stored: 152''s count is a nudge because holding six bookings is untidy rather than broken, but a cap that lives only in the booking sheet binds only the member running an up-to-date honest client, while an old build, a replayed offline write or a direct PostgREST call walks through it — a fairness rule the honest client alone respects is worse than none. public.upsert_car_booking, the single write path, is therefore re-declared off migration 063 (its newest prior definition) with the two checks placed after the permission gates and before the advisory lock, signature UNCHANGED so create-or-replace suffices and no client can be stranded by merge order. Violations raise distinct errcodes with Danish messages: GV46D past the booked-days cap, GV46H beyond the horizon — two codes from one ticket, the trailing letter naming the dimension, because the bare-ticket-number convention (GV328/GV333) yields only one and ''GV464'' would falsely name an unrelated ticket. New helper public.booked_days_in_open_period(text, uuid, uuid, timestamptz, timestamptz) holds the day arithmetic in one place with exclude_booking_id (so editing a booking does not count its old and new windows together) and extra_start/extra_end (so the write path can ask the counterfactual before writing); membership-gated like calculate_period_settlement since it is security definer. Two NEW admin-gated RPCs set_booking_max_days_per_member(text, integer, text, text) and set_booking_horizon_days(text, integer, text, text) rather than parameters on update_ledger_settings, which coalesce-patches and so could never express "turn it off" (the 080/152 reason) and whose signature could not be widened without a DROP and a PGRST202 merge order (the 158 reason). Each writes a settings_changed ledger_event on a real change only (is distinct from), which is what live-syncs the rule to other members (087 lesson); settings_changed is already feed-visible so no new event_type is introduced. Neither cap exempts admins. All new functions revoke execute from public and anon explicitly (148 convention) and grant authenticated.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

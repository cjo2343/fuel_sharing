-- Migration 160: two devices editing the same entry must not overwrite each other (GV-421)
--
-- Today every financial write is last-write-wins, and it loses silently. Two members
-- open the same booking, one shortens it, the other changes the purpose, and whoever
-- taps Gem second writes the whole row: the first edit is gone, nothing is logged, and
-- neither person is told. The same hole is open on a trip and on a fill-up — the three
-- RPCs below all upsert on (ledger_id, legacy_id) and their ON CONFLICT branches copy
-- every column from `excluded`, so a stale form overwrites a fresh row column by
-- column. The offline outbox widens the window from seconds to days: a queued edit is
-- replayed verbatim whenever the phone next has signal, against whatever the row has
-- become in the meantime.
--
-- This migration adds the smallest thing that turns that silence into a sentence: an
-- OPTIONAL precondition on the row the caller believed it was editing.
--
--     expected_updated_at timestamptz default null
--
-- ── The three semantics, and why the third is not an oversight ──────────────────
--
--   1. NULL or absent  → today's behaviour, byte for byte. No read of updated_at, no
--      comparison, no new failure mode. This is what makes the parameter safe to add
--      and the merge order soft: every client build that has ever shipped keeps
--      working, forever, exactly as it works now. The null case is pinned in the
--      contract test as an EQUALITY against the pre-migration outcome rather than as
--      an absence of errors, because a precondition that silently swallowed a write
--      would also raise nothing.
--
--   2. Present, the target row EXISTS, and its updated_at differs → the write is
--      REJECTED with a distinct errcode per entity and a Danish message, and nothing
--      at all is written. The caller's edit was computed against a version of the row
--      that no longer exists, so applying it is not "saving", it is discarding
--      somebody else's work on the caller's behalf.
--
--   3. Present, and NO row exists yet → IGNORED, and the insert proceeds. A create
--      cannot conflict with a row that is not there. This is deliberate rather than
--      lenient: the alternative, treating a token on a create as an error, would turn
--      a harmless client bug into a lost trip at exactly the moment the write is the
--      only copy of the data. The client side pins the honest half — creates send
--      null, edits send the token — as its own test, which is where a "why is a
--      create carrying a token?" smell belongs.
--
-- ── The errcodes ───────────────────────────────────────────────────────────────
--
--     GV42T  the TRIP moved underneath this edit
--     GV42F  the FUEL payment moved underneath this edit
--     GV42B  the BOOKING moved underneath this edit
--
-- Three codes from one ticket, following migration 159's lettering (GV46D / GV46H)
-- rather than the older bare-ticket-number convention (GV328, GV333): one code per
-- ticket cannot say WHICH entity moved, and the client needs that to name the thing
-- in its copy. 'GV421' is rejected for the same reason 159 rejected 'GV464' — it
-- would read as a lie about a ticket the day another one claims the number.
--
-- The messages are Danish, second person and readable on their own, so a raw
-- surfacing still tells a person what happened and what did NOT happen: the client
-- shows the server's own sentence, and the sentence has to carry "dine ændringer er
-- ikke gemt" or the user will assume the save went through.
--
-- ── The comparison is truncated to MILLISECONDS, on purpose ────────────────────
--
-- PostgreSQL stores timestamptz to the microsecond and PostgREST serialises all six
-- digits ("2026-08-01T09:12:33.123456+00:00"), so a token that travels as a string
-- and comes back as a string round-trips exactly. A token that passes through a
-- JavaScript Date does not: Date holds milliseconds, and the last three digits are
-- gone the moment anything parses and re-serialises the value. That is not a
-- hypothetical on this platform — it is one `new Date(row.updated_at)` away in any
-- client, and the failure it produces is the worst possible one: every edit is
-- refused as a conflict, forever, with a message blaming another member who did
-- nothing.
--
-- So both sides are compared through date_trunc('milliseconds', …). What that gives
-- up is the ability to distinguish two writes landing in the same millisecond, which
-- cannot happen for the case this exists to catch: updated_at is the transaction
-- timestamp, and two members' edits are separated by a network round trip, not by
-- microseconds. Losing an unreachable detection to remove a reachable false positive
-- is the right trade, and the contract test pins BOTH halves — a token differing only
-- in microseconds is accepted, a token differing by a millisecond is refused — so
-- neither can be "tidied" away later without a test failing.
--
-- `is distinct from` rather than `<>`, so a null updated_at on the stored row (which
-- the schema does not allow today, but a restore or a manual fix could) reads as
-- "cannot prove it is unchanged" and refuses, instead of comparing to null and
-- silently passing.
--
-- ── Where the check sits ───────────────────────────────────────────────────────
--
-- In all three functions: AFTER the existing-row lookup and after every permission
-- gate, BEFORE any validation that depends on the row and before every write. After
-- the permission gates because an unauthorised caller must not learn a row's
-- modification time; before the booking caps (159) because a cap evaluated against a
-- row the caller has not seen is answering the wrong question.
--
-- Nothing is logged when a write is rejected. A conflict is a write that did NOT
-- happen, and putting it in the activity feed would tell the whole group about one
-- member's failed tap. No new event_type is introduced.
--
-- ── ARITY CHANGE, not a replacement (the 158 / 157 / 156 / 063 lesson) ─────────
--
-- `create or replace` with a different parameter list creates a NEW OVERLOAD and
-- leaves the old one live; with every added parameter defaulting, PostgREST would
-- find two candidate signatures and refuse to resolve between them. Each exact
-- current signature is therefore DROPped first, and since DROP + CREATE resets the
-- ACL, every grant is restated with anon named explicitly (migration 148).
--
-- Each function is re-declared off its NEWEST prior definition (the GV-202 lesson):
-- upsert_trip_with_participants off 158, upsert_fuel_payment off 151,
-- upsert_car_booking off 159. Apart from the new trailing parameter and the guard
-- block, each body is that definition verbatim.
--
-- The new parameter is LAST in all three — after the trailing event params, exactly
-- where 158 put crossing_provided — so every positional caller is unshifted:
-- upsert_booking_trip_with_participants and complete_booking_trip_with_fuel call the
-- trip and fuel RPCs positionally from inside their own bodies and simply omit the
-- new argument, which is precisely the "no precondition" case. Those two are NOT
-- re-declared here: a booking completion is a create-or-reconcile of a trip the
-- server itself owns the identity of, not a form the user edited off a loaded row,
-- so there is no token for it to hold.
--
-- MERGE ORDER: this SQL must be applied in production BEFORE govehlo-mobile's twin
-- ships. PostgREST resolves an RPC by the NAMES of the arguments in the request body
-- and rejects a body carrying an argument the function does not have (PGRST202), so a
-- build that sends expected_updated_at against an un-migrated database cannot save at
-- all. Applied-first is the only order that works. Nothing in the other direction is
-- at risk: a client that never sends the argument is case 1 above.

-- ── 1. upsert_trip_with_participants — re-declared off migration 158 ────────────
-- 158 verbatim apart from the trailing expected_updated_at parameter and the guard
-- block after the update-permission gate. The crossing contract (the crossing_provided
-- flag, the per-column CASE expressions on ON CONFLICT) is untouched.
drop function if exists public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean);

create or replace function public.upsert_trip_with_participants(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_trip_id text,
  driver_member_id uuid,
  trip_date_value date,
  start_km_value numeric,
  end_km_value numeric,
  note_value text,
  participant_member_ids uuid[],
  crossing_cost_value numeric default null,
  crossing_note_value text default null,
  crossing_paid_by uuid default null,
  event_title text default null,
  event_body text default null,
  crossing_provided boolean default false,
  expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  locked_period_id uuid;
  saved_trip_id uuid;
  unique_participant_ids uuid[];
  existing_trip record;
  resolved_crossing_cost numeric;
  resolved_crossing_note text;
  resolved_crossing_payer uuid;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_trip_id is null or legacy_trip_id = '' then
    raise exception 'Missing legacy trip id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save trips' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if driver_member_id is null or not public.member_belongs_to_ledger(driver_member_id, target_ledger_id) then
    raise exception 'Trip driver must be an active member of this ledger' using errcode = '23514';
  end if;

  select coalesce(array_agg(distinct member_id), array[]::uuid[])
    into unique_participant_ids
  from unnest(coalesce(participant_member_ids, array[]::uuid[])) as member_id
  where public.member_belongs_to_ledger(member_id, target_ledger_id);

  if coalesce(array_length(unique_participant_ids, 1), 0) = 0 then
    raise exception 'Trip must include at least one active ledger participant' using errcode = '23514';
  end if;

  if not driver_member_id = any(unique_participant_ids) then
    unique_participant_ids := array_append(unique_participant_ids, driver_member_id);
  end if;

  if end_km_value <= start_km_value then
    raise exception 'Trip end km must be greater than start km' using errcode = '23514';
  end if;

  -- GVM-415: a bro/faerge crossing (Storebaelt, a ferry) hangs on the TRIP, not on
  -- Udgifter, because it is incurred by that drive and shared by the people in that
  -- car. It is a FLAT per-trip cost: calculate_period_settlement splits it equally
  -- over the trip's assignees (participants, driver fallback), never by km and never
  -- by the workspace Afregning rule. Here we only persist it.
  --
  -- GV-417: everything below runs ONLY when the caller said it is sending a crossing.
  -- crossing_provided false means the three crossing arguments carry no information —
  -- they are the parameter defaults of a client that has never heard of a crossing —
  -- so there is nothing to validate and nothing to normalise, the resolved_* locals
  -- stay null (correct for the INSERT path: a new trip from such a client has no
  -- crossing), and the UPDATE path below preserves whatever is already on the row.
  if crossing_provided then
    -- Null or zero cost means "no crossing", and it clears the note and the payer with
    -- it: an edit that removes the crossing must not leave orphaned metadata behind on
    -- the row (the settlement ignores a null cost, but the trip detail screen would
    -- still show a label for a crossing that no longer exists). A negative cost is
    -- rejected here rather than left to the table CHECK so the client gets a message.
    if crossing_cost_value is not null and crossing_cost_value < 0 then
      raise exception 'Crossing cost cannot be negative' using errcode = '23514';
    end if;

    if crossing_cost_value is null or round(crossing_cost_value, 2) = 0 then
      resolved_crossing_cost := null;
      resolved_crossing_note := null;
      resolved_crossing_payer := null;
    else
      resolved_crossing_cost := round(crossing_cost_value, 2);
      resolved_crossing_note := nullif(btrim(crossing_note_value), '');
      if length(coalesce(resolved_crossing_note, '')) > 120 then
        raise exception 'Crossing note must be 120 characters or fewer' using errcode = '22023';
      end if;
      -- Payer: null means the driver paid. A NAMED payer must be an ACTIVE member of
      -- this workspace, the same rule insert_repair holds a named repair payer to
      -- (108/114) — member_belongs_to_ledger is deliberately NOT used here, because it
      -- only asks whether the row exists in the workspace and would let a departed
      -- member be named as today's payer. That is a different case from the settlement
      -- CREDITING an inactive payer (GV-274), which is about a member who left AFTER
      -- the crossing was logged.
      resolved_crossing_payer := coalesce(crossing_paid_by, driver_member_id);
      if not exists (
        select 1
        from public.ledger_members lm
        where lm.id = resolved_crossing_payer
          and lm.ledger_id = target_ledger_id
          and lm.is_active = true
      ) then
        raise exception 'Crossing payer must be an active member of this workspace' using errcode = '23514';
      end if;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':trip:' || legacy_trip_id));

  select * into existing_trip
  from public.trips t
  where t.ledger_id = target_ledger_id
    and t.legacy_id = legacy_trip_id
  for update;

  if existing_trip.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_trip.created_by_member_id = actor_member_id
    or existing_trip.driver_member_id = actor_member_id
  ) then
    raise exception 'Only the trip creator, driver, or a ledger admin can update this trip' using errcode = '42501';
  end if;

  -- GV-421: optimistic-concurrency precondition. Null (or absent) means no
  -- precondition, which is every client that has ever shipped and is byte-identical
  -- to the behaviour above this line. A token against a row that does not exist yet
  -- is ignored — a create cannot conflict. Truncated to milliseconds because a token
  -- that has passed through a JavaScript Date has lost its microseconds, and a
  -- microsecond-exact comparison would refuse every edit forever; see the header.
  if expected_updated_at is not null
     and existing_trip.id is not null
     and date_trunc('milliseconds', existing_trip.updated_at)
         is distinct from date_trunc('milliseconds', expected_updated_at) then
    raise exception 'En anden har ændret turen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.'
      using errcode = 'GV42T';
  end if;

  insert into public.trips (
    legacy_id, ledger_id, period_id, driver_member_id, trip_date,
    start_km, end_km, note, crossing_cost_dkk, crossing_note,
    crossing_paid_by_member_id, created_by_member_id, deleted_at, updated_at
  ) values (
    legacy_trip_id, target_ledger_id, target_open_period_id, driver_member_id,
    trip_date_value, start_km_value, end_km_value, nullif(note_value, ''),
    resolved_crossing_cost, resolved_crossing_note, resolved_crossing_payer,
    actor_member_id, null, now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    driver_member_id = excluded.driver_member_id,
    trip_date = excluded.trip_date,
    start_km = excluded.start_km,
    end_km = excluded.end_km,
    note = excluded.note,
    -- GV-417: per column, because a crossing-aware caller must still be able to clear
    -- one field without the others, while a caller that sent no crossing at all must
    -- leave all three exactly as it found them.
    crossing_cost_dkk = case when crossing_provided then excluded.crossing_cost_dkk else trips.crossing_cost_dkk end,
    crossing_note = case when crossing_provided then excluded.crossing_note else trips.crossing_note end,
    crossing_paid_by_member_id = case when crossing_provided then excluded.crossing_paid_by_member_id else trips.crossing_paid_by_member_id end,
    deleted_at = null,
    updated_at = now()
  returning id into saved_trip_id;

  delete from public.trip_participants where trip_id = saved_trip_id;

  insert into public.trip_participants (trip_id, member_id)
  select saved_trip_id, member_id
  from unnest(unique_participant_ids) as member_id
  on conflict (trip_id, member_id) do nothing;

  -- Activity feed event, on create only (GVM-84).
  if existing_trip.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'trip_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('trip_id', saved_trip_id)
    );
  end if;

  return jsonb_build_object(
    'trip_id', saved_trip_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_trip_id,
    'participant_count', coalesce(array_length(unique_participant_ids, 1), 0)
  );
end;
$$;

revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean, timestamptz) from public;
revoke all on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean, timestamptz) from anon;
grant execute on function public.upsert_trip_with_participants(text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text, boolean, timestamptz) to authenticated;

-- ── 2. upsert_fuel_payment — re-declared off migration 151 ─────────────────────
-- 151 verbatim apart from the trailing expected_updated_at parameter and the guard
-- block after the create/update permission gates.
drop function if exists public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text);

create or replace function public.upsert_fuel_payment(
  target_ledger_id text,
  target_open_period_id uuid,
  legacy_fuel_id text,
  payer_member_id uuid,
  payment_date_value date,
  amount_value numeric,
  currency_value text,
  liters_value numeric,
  price_per_liter_value numeric,
  odometer_value numeric,
  station_name_value text,
  station_brand_value text,
  full_tank_value boolean,
  event_title text default null,
  event_body text default null,
  expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  locked_period_id uuid;
  saved_fuel_id uuid;
  existing_fuel record;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_open_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if legacy_fuel_id is null or legacy_fuel_id = '' then
    raise exception 'Missing legacy fuel id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can save fuel payments' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Take a SHARED row lock on the open period (GVM-112): close_settlement_period
  -- UPDATEs this row (exclusive row lock), so an in-flight write and a close
  -- serialize here — either this entry commits first and the close's server-side
  -- recompute sees it, or the close commits first and this check finds no open
  -- period and fails cleanly.
  select sp.id
    into locked_period_id
    from public.settlement_periods sp
    where sp.id = target_open_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    for share of sp;

  if locked_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  if payer_member_id is null or not public.member_belongs_to_ledger(payer_member_id, target_ledger_id) then
    raise exception 'Fuel payer must be an active member of this ledger' using errcode = '23514';
  end if;

  if amount_value is null or amount_value < 0 then
    raise exception 'Fuel amount must be zero or greater' using errcode = '23514';
  end if;

  if liters_value is not null and liters_value < 0 then
    raise exception 'Fuel liters must be zero or greater' using errcode = '23514';
  end if;

  if price_per_liter_value is not null and price_per_liter_value < 0 then
    raise exception 'Fuel price per liter must be zero or greater' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':fuel:' || legacy_fuel_id));

  select *
    into existing_fuel
  from public.fuel_payments
  where ledger_id = target_ledger_id
    and legacy_id = legacy_fuel_id
  for update;

  if existing_fuel.id is not null and not (
    public.is_ledger_admin(target_ledger_id)
    or existing_fuel.created_by_member_id = actor_member_id
    or existing_fuel.payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel creator, payer, or a ledger admin can update this fuel payment' using errcode = '42501';
  end if;

  if existing_fuel.id is null and not (
    public.is_ledger_admin(target_ledger_id)
    or payer_member_id = actor_member_id
  ) then
    raise exception 'Only the fuel payer or a ledger admin can create this fuel payment' using errcode = '42501';
  end if;

  -- GV-421: optimistic-concurrency precondition. Null (or absent) means no
  -- precondition, which is every client that has ever shipped and is byte-identical
  -- to the behaviour above this line. A token against a row that does not exist yet
  -- is ignored — a create cannot conflict. Truncated to milliseconds because a token
  -- that has passed through a JavaScript Date has lost its microseconds, and a
  -- microsecond-exact comparison would refuse every edit forever; see the header.
  if expected_updated_at is not null
     and existing_fuel.id is not null
     and date_trunc('milliseconds', existing_fuel.updated_at)
         is distinct from date_trunc('milliseconds', expected_updated_at) then
    raise exception 'En anden har ændret tankningen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.'
      using errcode = 'GV42F';
  end if;

  -- GDPR data minimisation (GV-186 / GV-196 / GV-400): no position is stored with a
  -- refuel any more. The driver's own coordinates went in migration 071 and the
  -- STATION's follow here — migration 062 kept those for a map view that was never
  -- built, so the purpose they were justified by has no implementation. The four
  -- accepted-and-ignored coordinate params are gone from the signature with them;
  -- station_name and station_brand still record WHERE, just not to seven decimals.
  insert into public.fuel_payments (
    legacy_id,
    ledger_id,
    period_id,
    payer_member_id,
    payment_date,
    amount,
    currency,
    liters,
    price_per_liter,
    odometer,
    station_name,
    station_brand,
    full_tank,
    created_by_member_id,
    deleted_at,
    updated_at
  ) values (
    legacy_fuel_id,
    target_ledger_id,
    target_open_period_id,
    payer_member_id,
    payment_date_value,
    amount_value,
    coalesce(nullif(currency_value, ''), 'DKK'),
    liters_value,
    price_per_liter_value,
    odometer_value,
    nullif(station_name_value, ''),
    nullif(station_brand_value, ''),
    coalesce(full_tank_value, false),
    actor_member_id,
    null,
    now()
  )
  on conflict (ledger_id, legacy_id) do update set
    period_id = excluded.period_id,
    payer_member_id = excluded.payer_member_id,
    payment_date = excluded.payment_date,
    amount = excluded.amount,
    currency = excluded.currency,
    liters = excluded.liters,
    price_per_liter = excluded.price_per_liter,
    odometer = excluded.odometer,
    station_name = excluded.station_name,
    station_brand = excluded.station_brand,
    full_tank = excluded.full_tank,
    deleted_at = null,
    updated_at = now()
  returning id into saved_fuel_id;

  -- Activity feed event, on create only (GVM-84).
  if existing_fuel.id is null and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'fuel_created', event_title, coalesce(event_body, ''),
      actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('fuel_id', saved_fuel_id)
    );
  end if;

  return jsonb_build_object(
    'fuel_id', saved_fuel_id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_fuel_id
  );
end;
$$;

-- DROP + CREATE resets the ACL, so both halves are restated: anon and authenticated
-- are named explicitly (migration 148) and only authenticated is granted back.
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz) from public;
revoke all on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz) from anon;
grant execute on function public.upsert_fuel_payment(text, uuid, text, uuid, date, numeric, text, numeric, numeric, numeric, text, text, boolean, text, text, timestamptz) to authenticated;

-- ── 3. upsert_car_booking — re-declared off migration 159 ──────────────────────
-- 159 verbatim apart from the trailing expected_updated_at parameter and the guard
-- block, which sits BEFORE the booking caps: a cap counted against a row the caller
-- has not seen answers a question nobody asked.
drop function if exists public.upsert_car_booking(text, text, uuid, timestamptz, timestamptz, text, text, text, jsonb);

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
  '160_conflict_preconditions',
  'Optimistic-concurrency preconditions on the three financial write RPCs (GV-421), so two devices editing the same entry produce a visible conflict instead of a silent overwrite. Until now every one of these writes was last-write-wins and lost silently: the RPCs upsert on (ledger_id, legacy_id) and their ON CONFLICT branches copy every column from excluded, so whoever saved second overwrote the first edit with no error, no log and no notice — and the offline outbox widened that window from seconds to days, since a queued edit is replayed verbatim against whatever the row has since become. public.upsert_trip_with_participants, public.upsert_fuel_payment and public.upsert_car_booking each gain an OPTIONAL expected_updated_at timestamptz default null as their LAST parameter, after the trailing event params. Three semantics: NULL or absent is today''s behaviour byte for byte — no read of updated_at, no comparison, no new failure mode — which is what makes the parameter safe to add and keeps every client build that has ever shipped working; present with an EXISTING target row whose updated_at differs REJECTS the write with a distinct errcode and writes nothing at all; present on a CREATE is ignored and the insert proceeds, because a create cannot conflict and treating a stray token as an error would turn a client bug into a lost trip. The errcodes are GV42T (trip), GV42F (fuel), GV42B (booking) — three codes from one ticket following migration 159''s lettering (GV46D/GV46H) rather than the bare-ticket-number convention (GV328/GV333), because one code per ticket cannot say WHICH entity moved; ''GV421'' is rejected for the same reason 159 rejected ''GV464''. The Danish messages name the entity and state that the changes were NOT saved, so a raw surfacing still tells a person what did not happen. Both sides of the comparison pass through date_trunc(''milliseconds'', …): PostgreSQL and PostgREST carry microseconds, but a token that passes through a JavaScript Date loses them, and a microsecond-exact comparison would then refuse every edit forever while blaming a member who did nothing — the detection given up (two writes inside one millisecond) is unreachable for the case this exists to catch, since updated_at is the transaction timestamp and two members'' edits are separated by a network round trip. `is distinct from` rather than `<>`, so a null stored updated_at reads as "cannot prove it is unchanged" and refuses. The check sits after the existing-row lookup and after every permission gate (an unauthorised caller must not learn a row''s modification time) and, in upsert_car_booking, BEFORE migration 159''s day/horizon caps, because a cap counted against a window the caller has never seen answers the wrong question. A rejected write logs nothing — a conflict is a write that did NOT happen — so no new event_type is introduced. All three are DROP + CREATE off their newest prior definitions (158 for the trip RPC, 151 for fuel, 159 for booking), not create-or-replace, because a differing parameter list leaves the old overload live and PostgREST cannot resolve between two candidates when every added parameter defaults (the 158/157/156/063 lesson); ACLs are restated with anon named explicitly per 148. upsert_booking_trip_with_participants and complete_booking_trip_with_fuel are deliberately NOT re-declared: they call the trip and fuel RPCs positionally and simply omit the new trailing argument, which is exactly the no-precondition case, and a booking completion is a create-or-reconcile of a trip the server owns the identity of rather than a form edited off a loaded row. MERGE ORDER: this SQL must be applied in production BEFORE the govehlo-mobile twin ships, because PostgREST rejects a body carrying an argument the function does not have (PGRST202).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

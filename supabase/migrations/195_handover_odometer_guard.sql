-- Migration 195: handover odometer plausibility guard + audited admin recompute (GV-475)
--
-- THE BUG (external review 2026-08-09, verified against the shipped schema). Migration
-- 193 mirrors every handover's end_odometer onto ledgers.max_handover_odometer, and it
-- does so MONOTONELY on purpose: an odometer only goes up, so a deleted or edited-down
-- handover must not retract a counter reading that was actually made. That is the right
-- rule for a DELETION and the wrong one for a TYPO. The write path
-- (upsert_booking_handover, newest prior definition migration 191) rejects only a
-- NEGATIVE odometer, so a member who types 1181660 instead of 118166 writes a reading
-- the mirror then keeps FOREVER: every odometer floor derived from it (the mobile
-- max-of-floors in odometer.ts, where 193 made this the fifth floor), every
-- service-interval calculation and every Start-km prefill is poisoned by one keystroke —
-- and because the mirror never retracts, correcting or deleting the offending handover
-- row does not undo it. The only recovery available before this migration is raw SQL
-- against production.
--
-- THE FIX HAS TWO HALVES, and it needs both: stop the bad number getting in, and make
-- the damage recoverable by an admin instead of by a DBA.
--
-- ── 1. A PLAUSIBILITY CEILING IN THE WRITE PATH ───────────────────────────────
-- upsert_booking_handover is re-declared COMPLETELY off its newest prior definition
-- (migration 191, the GVM-561 not-started guard), byte-identical bar one declared
-- variable and two added guards. The signature is unchanged, so create-or-replace
-- suffices and no second candidate signature is left for PostgREST to trip over
-- (PGRST203).
--
--   • THE ABSOLUTE CAP: more than 2.000.000 km is refused whatever the history says. No
--     car on Danish roads has driven it, and a workspace with no history at all still
--     has to be protected from the same extra digit. It judges only what the caller
--     sent, so it sits with the other payload validations at the top of the function,
--     exactly where the negative check it extends already is (migration 162's
--     precedent: those guards need no lookup and leak nothing about the workspace).
--
--   • THE RELATIVE CEILING: anchor + 50.000 km, applied only when the workspace HAS an
--     odometer history.
--
-- THE ANCHOR IS THE GREATEST ODOMETER FACT THE WORKSPACE ROW ALREADY HOLDS:
--
--     greatest(ledgers.max_handover_odometer, ledgers.tank_baseline_odometer)
--
-- and those two are the ONLY odometer anchors ledgers carries — tank_baseline_odometer
-- from migration 092 (set at car setup by set_tank_baseline, the seed of the running
-- fuel-level model) and max_handover_odometer from 193. Postgres' greatest() IGNORES
-- nulls, so the anchor is null only when the workspace holds NEITHER, and in that case
-- NO RELATIVE CEILING APPLIES AT ALL: a genuinely new ledger's first reading of 350000
-- on a well-used car is accepted, bounded by the absolute cap alone. That is also why
-- the anchor cannot be the 193 mirror by itself — a group that set its tank baseline at
-- 300.000 km and has never recorded a handover would otherwise be capped at 50.000 km
-- and unable to enter a true reading at all.
--
-- trips.odometer and vehicle_incidents.odometer were CONSIDERED as further anchors and
-- deliberately left out. They are not on ledgers, so each would cost a scan on every
-- handover write; the case they would cover (a workspace whose trip odometers run far
-- ahead of both ledger anchors) is already covered, because a workspace with no ledger
-- anchor gets no relative ceiling at all, and 50.000 km of headroom is more than three
-- years of average Danish driving on top of whichever anchor does exist.
--
-- WHERE THE RELATIVE CEILING SITS, and why it is not with the payload checks: it reads
-- the workspace row, so it must come after the membership gate — a non-member must not
-- be able to probe a workspace's mileage by bisecting rejections. It is placed one step
-- further still, AFTER the GV-421 stale-token precondition, so a caller editing a
-- version that no longer exists is told THAT first: their number was typed against a
-- handover somebody else has already changed, and answering "your kilometres look
-- wrong" about a payload that is going to be discarded anyway sends them to fix the
-- wrong thing. It is the last check before the write, judging the row that is actually
-- about to be stored.
--
-- BOTH GUARDS RAISE THE SAME DANISH SENTENCE AND THE SAME DISTINCT ERRCODE 'GV475'
-- (the GV328/GV333/GV42O convention for a code a client matches on). One message
-- because the member's remedy is identical in both cases — count the digits — and one
-- code because the client's handling is identical too: keep the sheet open, highlight
-- the odometer field, do not discard what was typed.
--
-- THE ONE LOCKOUT THIS CREATES, AND ITS WAY OUT. The ceiling is relative to what was
-- recorded, so a first reading typed far too LOW (118 for 118166) becomes the anchor
-- and puts the true reading out of reach. The recovery is the correction flow below and
-- it must be done in this order: DELETE the bad handover row (or edit it DOWNWARD,
-- which the ceiling always allows), then recompute — after which the anchor is the true
-- surviving maximum, or null if nothing survives, and the correct reading is accepted.
-- Editing the bad row straight UP to the true value is the one move that does not work,
-- because that edit goes through this very guard.
--
-- ── 2. recompute_handover_mirror(target_ledger_id, event_title, event_body) ────
-- The audited admin correction, and the deliberate, single exception to 193's
-- monotonicity. It recomputes ALL THREE mirror columns from the SURVIVING
-- booking_handovers rows — max_handover_odometer to the true maximum (DOWNWARD if that
-- is what the rows say), and the latest_handover_fraction / latest_handover_observed_at
-- pair by 193's own newest-observation query, so the fraction never disagrees with the
-- odometer it was corrected alongside. A workspace whose handovers are all gone gets
-- all three back to NULL, which is 193's "never observed" state rather than a fake 0 km
-- reading.
--
-- Admin-only (is_ledger_admin), because dropping monotonicity is precisely the
-- authority a plain member does not have: 193's rule protects a recorded fact from
-- being quietly retracted, and the exception has to be somebody accountable saying "the
-- fact was wrong". SECURITY DEFINER with a pinned search_path, granted to authenticated
-- with public and anon revoked (148's convention) — the RPC gates itself, as every
-- admin RPC in this schema does.
--
-- It takes the ledger row FOR UPDATE before recomputing, and that is all the
-- serialisation it needs: 193's mirror trigger updates the same row, so a handover
-- committing concurrently either lands before the recompute reads the table, or blocks
-- on the row lock and then re-applies its own whole-ledger recompute over the corrected
-- value. No advisory lock is taken — this is one read-then-write of one row, not the
-- read-decide-write sequence upsert_booking_handover has to protect.
--
-- ONE ledger_events row, event_type 'handover_odometer_corrected', with a SERVER-AUTHORED
-- Danish title and body: the event pair is accepted for the 051/052 convention and for a
-- future client that wants to name the member, but unlike every create-only event in this
-- schema the row is written whether or not a title was supplied, because a correction
-- nobody can see is exactly the state GV-475 is about. It is written even when the
-- numbers do not move, since "an admin recomputed and nothing changed" is itself the
-- answer somebody was looking for. GV-413: classified FEED-VISIBLE in
-- tools/ledger-event-visibility.mjs — the workspace's odometer is a shared fact, and one
-- member's typo silently corrected by another member is the kind of thing the group
-- should read in the feed rather than infer from a number that moved. The metadata
-- carries the old and new maximum and nothing else; no free text, no member names.
--
-- THE CORRECTION FLOW, END TO END, for a workspace that has already been poisoned:
--   1. The handover's author or an admin opens the handover sheet and DELETES the bad
--      row, or edits the reading DOWN to the true one (both are existing UI, and the new
--      ceiling never blocks a downward edit).
--   2. An admin calls recompute_handover_mirror(ledger_id). The mirror drops to the true
--      surviving maximum and the feed records that it happened.
--   3. The workspace's odometer floors, service reminders and prefills follow the mirror
--      immediately; no client change is needed for the correction to take effect.
-- The mobile affordance for step 2 is a follow-up; until it ships an operator can call
-- the RPC directly, which is still a gated, audited call rather than raw SQL.
--
-- No schema change, no new column, no table, no policy change, no RLS change, and no
-- backfill: the guarded tables' settlement triggers (the 192 lesson) are not touched,
-- because this migration UPDATEs nothing. types/database.ts DOES change — a new RPC
-- appears in it — so the vendored copies in both client repos follow after the merge.
-- GDPR: nothing new is stored; the one new event row holds two integers.

-- ── 1. GV-475: upsert_booking_handover re-declared off migration 191 ──────────
-- Migration 191 verbatim except for one declared variable and the two guards marked
-- GV-475 below. Signature unchanged; see the header for the anchor and the ordering.
create or replace function public.upsert_booking_handover(
  target_ledger_id text,
  target_booking_id uuid,
  end_odometer_value integer default null,
  fuel_fraction_value numeric default null,
  parking_location_value text default null,
  key_location_value text default null,
  condition_ok_value boolean default null,
  condition_note_value text default null,
  note_to_next_value text default null,
  keys_confirmed_value boolean default false,
  parking_lat_value numeric default null,
  parking_lng_value numeric default null,
  location_seen_at timestamptz default null,
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
  v_actor_member_id uuid;
  v_booking public.car_bookings%rowtype;
  v_existing public.booking_handovers%rowtype;
  v_trip_driver_id uuid;
  v_handover_id uuid;
  v_created boolean;
  v_updated_at timestamptz;
  v_parking text;
  v_keys text;
  v_condition_note text;
  v_note_to_next text;
  v_mirror_rows integer;
  v_location_mirrored boolean := false;
  v_odometer_anchor numeric;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_booking_id is null then
    raise exception 'Missing booking id' using errcode = '22023';
  end if;

  -- Payload validation first: these judge only what the caller sent (migration 162's
  -- precedent), so they need no lookup and leak nothing about the workspace.
  if end_odometer_value is not null and end_odometer_value < 0 then
    raise exception 'Kilometerstanden kan ikke være negativ.' using errcode = '22023';
  end if;

  -- GV-475, half one of two: the ABSOLUTE cap. No car on Danish roads has driven two
  -- million kilometres, and a workspace with no odometer history at all still has to be
  -- protected from the same extra digit that migration 193's monotone mirror would then
  -- keep forever. This one judges only the payload, so it belongs here with the checks
  -- above rather than after the gates; the ceiling that needs the workspace row is the
  -- last check before the write, further down.
  if end_odometer_value is not null and end_odometer_value > 2000000 then
    raise exception 'Kilometerstanden ser for høj ud — tjek om du har tastet et ciffer for meget.'
      using errcode = 'GV475';
  end if;

  if fuel_fraction_value is not null and (fuel_fraction_value < 0 or fuel_fraction_value > 1) then
    raise exception 'Brændstofniveauet skal være mellem 0 og 1.' using errcode = '22023';
  end if;

  v_parking := nullif(btrim(parking_location_value), '');
  v_keys := nullif(btrim(key_location_value), '');
  v_condition_note := nullif(btrim(condition_note_value), '');
  v_note_to_next := nullif(btrim(note_to_next_value), '');

  if char_length(coalesce(v_parking, '')) > 200 then
    raise exception 'Parkeringsstedet må højst være 200 tegn.' using errcode = '22023';
  end if;

  if char_length(coalesce(v_keys, '')) > 200 then
    raise exception 'Nøglernes placering må højst være 200 tegn.' using errcode = '22023';
  end if;

  if char_length(coalesce(v_condition_note, '')) > 500 then
    raise exception 'Bemærkningen om bilens stand må højst være 500 tegn.' using errcode = '22023';
  end if;

  if char_length(coalesce(v_note_to_next, '')) > 500 then
    raise exception 'Beskeden til den næste fører må højst være 500 tegn.' using errcode = '22023';
  end if;

  -- GVM-540: the same two shape guards migration 168 put on set_vehicle_location, in
  -- Danish for this function's own convention (see the header). They judge the pair the
  -- caller sent, whether or not a parking text came with it: a malformed pin is
  -- malformed regardless of what the mirror below would have done with it, and half a
  -- pin is a marker on the equator rather than a degraded pin.
  if (parking_lat_value is null) <> (parking_lng_value is null) then
    raise exception 'Parkeringsnålen mangler den ene koordinat.' using errcode = '22023';
  end if;

  if parking_lat_value is not null
     and (parking_lat_value < -90 or parking_lat_value > 90
          or parking_lng_value < -180 or parking_lng_value > 180) then
    raise exception 'Parkeringsnålens koordinater er ugyldige.' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer af dette workspace kan gemme en overdragelse.' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kun aktive medlemmer af dette workspace kan gemme en overdragelse.' using errcode = '42501';
  end if;

  -- One writer per booking. Taken before the booking is read so the whole
  -- read-decide-write sequence below is serialized against a second device.
  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':handover:' || target_booking_id::text));

  select * into v_booking
    from public.car_bookings cb
    where cb.id = target_booking_id;

  if v_booking.id is null or v_booking.ledger_id is distinct from target_ledger_id then
    raise exception 'Bookingen findes ikke i dette workspace.' using errcode = '22023';
  end if;

  -- A cancelled booking is history and takes no handover (GVM-557). The client has
  -- always hidden the affordance for a cancelled booking; this makes the server agree
  -- instead of accepting a write the UI could never have offered.
  if v_booking.deleted_at is not null then
    raise exception 'Bookingen er annulleret og kan ikke få en overdragelse.' using errcode = '22023';
  end if;

  -- A booking that has not STARTED takes no handover either (GVM-561): nothing has been
  -- driven, so there is nothing to hand over — and with migration 189's clamp a premature
  -- handover would carry observed_at = now(), making it the workspace's LATEST and able to
  -- re-anchor the fuel model and move the car's location. The client has hidden this
  -- affordance since GVM-557; the server now agrees instead of trusting the UI.
  if v_booking.start_at > now() then
    raise exception 'Bookingen er ikke startet endnu og kan ikke få en overdragelse.' using errcode = '22023';
  end if;

  -- Migration 123's durable booking→trip link: the trip actually logged against this
  -- booking. `deleted_at is null` matches the partial unique index 123 created
  -- (trips_one_active_per_booking_idx), so this resolves to at most one row.
  select t.driver_member_id
    into v_trip_driver_id
    from public.trips t
    where t.booking_id = target_booking_id
      and t.ledger_id = target_ledger_id
      and t.deleted_at is null
    limit 1;

  if not (
    coalesce(v_booking.member_id = v_actor_member_id, false)
    or coalesce(v_trip_driver_id = v_actor_member_id, false)
    or public.is_ledger_admin(target_ledger_id)
  ) then
    raise exception 'Kun den, der havde bilen, eller en administrator kan gemme overdragelsen.' using errcode = '42501';
  end if;

  select * into v_existing
    from public.booking_handovers bh
    where bh.booking_id = target_booking_id;

  -- GV-421 precondition. After every permission gate, before any write.
  if expected_updated_at is not null
     and v_existing.id is not null
     and date_trunc('milliseconds', v_existing.updated_at)
         is distinct from date_trunc('milliseconds', expected_updated_at) then
    raise exception 'En anden har ændret overdragelsen imens. Dine ændringer er ikke gemt — hent den nyeste version og prøv igen.'
      using errcode = 'GV42O';
  end if;

  -- GV-475, half two of two: the RELATIVE ceiling, and the LAST check before the write —
  -- it judges the row that is actually about to be stored. It reads the workspace row, so
  -- it cannot sit with the payload validations at the top: a non-member must not be able
  -- to probe a workspace's mileage by bisecting rejections. It sits one step further
  -- still, AFTER the GV-421 precondition, so a caller whose view is stale is told THAT
  -- first — their number was typed against a handover somebody else has already changed,
  -- and answering 'your kilometres look wrong' about a payload that is going to be
  -- discarded anyway sends them to fix the wrong thing.
  --
  -- THE ANCHOR IS THE GREATEST ODOMETER FACT THE WORKSPACE ROW ALREADY HOLDS: the 193
  -- handover mirror and migration 092's tank baseline, which are the only two odometer
  -- anchors on ledgers. greatest() ignores nulls, so the anchor is null exactly when the
  -- workspace holds NEITHER — and then no relative ceiling applies at all and a first
  -- reading of 350000 on a used car is accepted under the absolute cap alone. The tank
  -- baseline is in here for the mirror image of that case: a group that recorded its
  -- baseline at 300.000 km must not be capped at 50.000.
  --
  -- 50.000 km of headroom is deliberately generous — more than three years of average
  -- Danish driving — because this guard is aimed at an extra DIGIT, not at a member who
  -- has not logged a handover in a while. A reading typed too LOW is never blocked, which
  -- is also the way out of the one lockout this creates: delete or edit down the bad row,
  -- then call recompute_handover_mirror.
  if end_odometer_value is not null then
    select greatest(l.max_handover_odometer, l.tank_baseline_odometer)
      into v_odometer_anchor
      from public.ledgers l
     where l.id = target_ledger_id;

    if v_odometer_anchor is not null and end_odometer_value > v_odometer_anchor + 50000 then
      raise exception 'Kilometerstanden ser for høj ud — tjek om du har tastet et ciffer for meget.'
        using errcode = 'GV475';
    end if;
  end if;

  v_created := v_existing.id is null;

  -- GVM-540: the pin is NOT among the columns below, and that is deliberate. The
  -- handover row is what THIS driver reported about THIS booking — history — and a
  -- coordinate per handover would accumulate one position per booking, the movement
  -- history migration 168 refused to build. The pin is CURRENT CAR STATE and lives only
  -- on ledgers; the two parameters pass straight through to the mirror below.
  if v_created then
    insert into public.booking_handovers (
      ledger_id, booking_id, author_member_id, end_odometer, fuel_fraction,
      parking_location, key_location, condition_ok, condition_note, note_to_next,
      keys_confirmed
    ) values (
      target_ledger_id, target_booking_id, v_actor_member_id, end_odometer_value,
      fuel_fraction_value, v_parking, v_keys, condition_ok_value, v_condition_note,
      v_note_to_next, coalesce(keys_confirmed_value, false)
    )
    returning id, updated_at into v_handover_id, v_updated_at;
  else
    -- A full REPLACE, not a patch — see the header. author_member_id is rewritten to
    -- the current editor: the row states who last vouched for where the car is, and
    -- a stale author on a corrected fact is worse than none.
    update public.booking_handovers bh
    set author_member_id = v_actor_member_id,
        end_odometer = end_odometer_value,
        fuel_fraction = fuel_fraction_value,
        parking_location = v_parking,
        key_location = v_keys,
        condition_ok = condition_ok_value,
        condition_note = v_condition_note,
        note_to_next = v_note_to_next,
        keys_confirmed = coalesce(keys_confirmed_value, false),
        updated_at = now()
    where bh.id = v_existing.id
    returning bh.id, bh.updated_at into v_handover_id, v_updated_at;
  end if;

  -- ── GVM-520 mirror: the car's CURRENT location on the workspace row ───────────
  -- NULL-PRESERVING, and that asymmetry with the full REPLACE above is the point: a
  -- handover row states what THIS driver reported about THIS booking, so a blank
  -- parking field there means "Bo did not fill it in" and must clear the handover's
  -- own column. The workspace column answers a different question — "where is the car
  -- now?" — and a skipped field on somebody's form is not evidence that the answer
  -- changed. Erasing it would leave the group with nothing where they had a spot.
  --
  -- Runs on CREATE and on EDIT alike, unlike the feed event: a correction from
  -- "niveau 2" to "niveau 3" is precisely the case where the current location must
  -- follow, even though the group does not need a second notification about it.
  --
  -- The stamp moves only when at least one field actually mirrored, so a handover
  -- carrying neither location cannot make a week-old spot look freshly confirmed.
  --
  -- GVM-536/GVM-540: THE PIN BELONGS TO THE TEXT IT WAS SET WITH, and since GVM-540
  -- the handover sheet can supply one, so the rule is symmetric rather than one-way:
  --
  --   • a NEW parking text WITH a fresh pin WRITES the pin — the driver is standing at
  --     the car and tapped "brug min placering", which is the whole feature;
  --   • a NEW parking text WITHOUT one CLEARS it (migration 168's rule, unchanged): the
  --     stored coordinates describe wherever the car used to be, and map-grade
  --     confidence in the wrong street is worse than no pin at all;
  --   • a NULL parking field PRESERVES the text and therefore its pin (migration
  --     167/168's rule, unchanged): nothing was asserted about the parking spot, so
  --     nothing about it changes — which also means a pin sent without a text is
  --     IGNORED rather than stored, because there is no text for it to belong to.
  --
  -- ── GVM-542: THE MIRROR IS SKIPPED WHEN THE CALLER'S VIEW IS STALE ───────────
  -- Handovers queue in the mobile outbox and flush whenever the phone next has a
  -- network, so a handover FILLED IN on Monday can ARRIVE on Wednesday. Until this
  -- guard, arriving was enough: the mirror overwrote Tuesday's correct parking spot
  -- with Monday's and stamped location_updated_at = now(), so the group read a two-day
  -- old spot as freshly confirmed. That is the worst failure available to this column —
  -- not "we have no answer" but "we have a confident wrong one", which is the same harm
  -- migration 168 refused to accept from a stale PIN, arriving here through time
  -- instead of through geography.
  --
  -- location_seen_at is the client's answer to ONE question: which version of the
  -- workspace location was on screen when this sheet was filled in. If the stored stamp
  -- is NEWER than that, somebody has moved the car since, this handover's view of the
  -- current spot is history rather than news, and the mirror is SKIPPED.
  --
  -- THE HANDOVER ROW ITSELF IS NEVER REJECTED, and that asymmetry is the whole design.
  -- HISTORY IS HISTORY: what Bo reported about Bo's booking is true whenever it arrives,
  -- it is the only account of that trip that will ever exist, and refusing the write
  -- would lose it outright — an offline queue that can drop entries is worse than no
  -- queue at all. Only "where is the car RIGHT NOW" must not go backwards, and exactly
  -- one place answers that: the ledgers row. So a stale handover is saved in full,
  -- writes its feed event in full, and simply does not claim to know the car's current
  -- position. Same reasoning as the null-preserving rule above, one step further on: a
  -- handover that CANNOT know the answer must not overwrite it either.
  --
  -- ── GV-444: THE CONDITION LIVES IN THE STATEMENT, SO IT CANNOT BE RACED ──────
  -- Migration 172 wrote the rule as a SELECT of location_updated_at, a PL/pgSQL
  -- comparison and then a separate UPDATE. Between the read and the write another
  -- transaction could COMMIT a newer location — a member tapping "bilen står her",
  -- another booking's handover flushing out of somebody else's outbox — and the write
  -- then overwrote a spot that had appeared after it was read, stamping it as confirmed
  -- just now. That is the guard's own failure case reached through a smaller window,
  -- and the worst kind of small window: invisible in the row it damages, and
  -- unreproducible from the bug report it produces.
  --
  -- So it is ONE statement. The where clause below carries the staleness test itself,
  -- the UPDATE locks the row it is deciding about, and in READ COMMITTED Postgres
  -- re-evaluates that where clause against the version a concurrent writer committed
  -- while this statement waited. A location that moved under the caller therefore fails
  -- the test and the mirror matches NO ROW, rather than being read as current and then
  -- overwritten. There is no read to go stale.
  --
  -- The three disjuncts are 172's condition negated, term for term, and every outcome it
  -- defined is preserved: a NULL location_seen_at always mirrors (every shipped client
  -- omits the parameter, so those rows are byte-identical to today's, and the skip stays
  -- opt-in by a client that can say what it saw); a NULL stored stamp always mirrors,
  -- because there is no current answer for a stale view to overwrite; otherwise the
  -- stored stamp must be no NEWER than what the caller had on screen, equal included.
  -- A client that means "I saw no location at all" sends '-infinity' and blocks the
  -- mirror wherever one exists, since every real timestamp is greater than it.
  --
  -- Both sides go through date_trunc('milliseconds', …) for migration 160's reason: a
  -- timestamp that has passed through a JavaScript Date has lost its microseconds, and a
  -- microsecond-exact comparison would read an UNCHANGED location as newer than the
  -- version the client saw and skip every mirror forever, blaming a member who did
  -- nothing.
  --
  -- 'location_mirrored' is row_count > 0 — true only when the UPDATE actually touched
  -- the workspace row — so the client can tell "your parking note did not become the
  -- car's current location" from "it did" without guessing. It keeps BOTH of its false
  -- cases and their one meaning, "the workspace location did not change": the handover
  -- mentioned neither parking nor keys, so the statement never ran, or the caller's view
  -- was stale, so it matched nothing.
  if v_parking is not null or v_keys is not null then
    update public.ledgers l
       set parking_location = coalesce(v_parking, l.parking_location),
           parking_lat = case when v_parking is null then l.parking_lat else parking_lat_value end,
           parking_lng = case when v_parking is null then l.parking_lng else parking_lng_value end,
           key_location = coalesce(v_keys, l.key_location),
           location_updated_by_member_id = v_actor_member_id,
           location_updated_at = now(),
           updated_at = now()
     where l.id = target_ledger_id
       and (location_seen_at is null
            or l.location_updated_at is null
            or date_trunc('milliseconds', l.location_updated_at)
               <= date_trunc('milliseconds', location_seen_at));

    get diagnostics v_mirror_rows = row_count;
    v_location_mirrored := v_mirror_rows > 0;
  end if;

  -- CREATE only. An edit writes no event; see the header. The metadata is migration
  -- 164's, unchanged: two ids and nothing else. GVM-540 adds no coordinate here and not
  -- even a boolean about one — the handover event is not where a member looks for the
  -- car's position, and the feed is the widest audience a workspace has.
  if v_created and nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'handover_created', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', target_booking_id, 'handover_id', v_handover_id)
    );
  end if;

  return jsonb_build_object(
    'handover_id', v_handover_id,
    'booking_id', target_booking_id,
    'ledger_id', target_ledger_id,
    'created', v_created,
    'updated_at', v_updated_at,
    'location_mirrored', v_location_mirrored
  );
end;
$$;

revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, timestamptz, text, text, timestamptz) from public;
revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, timestamptz, text, text, timestamptz) from anon;
grant execute on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, timestamptz, text, text, timestamptz) to authenticated;

-- ── 2. GV-475: the audited admin recompute ────────────────────────────────────
-- The single, deliberate exception to migration 193's monotone odometer mirror. See
-- the header for why it is admin-only, why it writes an event even when nothing moves,
-- and why a row lock is the whole of its concurrency story.
create or replace function public.recompute_handover_mirror(
  target_ledger_id text,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_previous_max integer;
  v_previous_fraction numeric;
  v_max_odometer integer;
  v_fraction numeric;
  v_observed_at timestamptz;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  -- Admin only. is_ledger_admin is false for a non-member too, so this is also the
  -- workspace boundary: nobody learns another group's odometer by calling this.
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Kun en administrator kan genberegne kilometertællerens aflæsning.' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kun aktive medlemmer af dette workspace kan genberegne kilometertællerens aflæsning.' using errcode = '42501';
  end if;

  -- The row 193's mirror trigger writes. Locking it here is the whole of the
  -- serialisation: a handover committing concurrently either lands before the recompute
  -- reads booking_handovers, or waits on this lock and then re-applies its own
  -- whole-ledger recompute over the corrected value. Both orders end correct.
  select l.max_handover_odometer, l.latest_handover_fraction
    into v_previous_max, v_previous_fraction
    from public.ledgers l
   where l.id = target_ledger_id
     for update;

  -- Both halves are migration 193's own recompute queries, verbatim. The difference is
  -- entirely in what is done with the odometer result below: 193 takes the greatest of
  -- the mirror and the table, this takes the table.
  select max(h.end_odometer)
    into v_max_odometer
    from public.booking_handovers h
   where h.ledger_id = target_ledger_id;

  select h.fuel_fraction, h.observed_at
    into v_fraction, v_observed_at
    from public.booking_handovers h
   where h.ledger_id = target_ledger_id
     and h.fuel_fraction is not null
   order by h.observed_at desc, h.id desc
   limit 1;

  -- MONOTONICITY IS DROPPED HERE, ONCE, ON PURPOSE. Every other write of this column
  -- goes through 193's greatest(); this one assigns the surviving truth, including NULL
  -- when nothing survives (193's "never observed", not a fake 0 km reading).
  update public.ledgers l
     set max_handover_odometer = v_max_odometer,
         latest_handover_fraction = v_fraction,
         latest_handover_observed_at = v_observed_at
   where l.id = target_ledger_id;

  -- Server-authored Danish, and written unconditionally — see the header. A caller may
  -- supply its own wording through the 051/052 event pair, but silence is not an option
  -- the caller has: a correction nobody can see is the state this migration exists to
  -- end. Metadata is two integers; no free text, no names.
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'handover_odometer_corrected',
    coalesce(nullif(btrim(event_title), ''), 'Kilometertæller-aflæsning korrigeret'),
    coalesce(
      nullif(btrim(event_body), ''),
      'Den højeste kilometerstand er genberegnet ud fra de overdragelser, der findes nu.'
    ),
    v_actor_member_id,
    nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object(
      'previous_max_handover_odometer', v_previous_max,
      'max_handover_odometer', v_max_odometer
    )
  );

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'previous_max_handover_odometer', v_previous_max,
    'max_handover_odometer', v_max_odometer,
    'previous_latest_handover_fraction', v_previous_fraction,
    'latest_handover_fraction', v_fraction,
    'latest_handover_observed_at', v_observed_at,
    'lowered', coalesce(v_max_odometer, 0) < coalesce(v_previous_max, 0)
  );
end;
$$;

revoke all on function public.recompute_handover_mirror(text, text, text) from public;
revoke all on function public.recompute_handover_mirror(text, text, text) from anon;
grant execute on function public.recompute_handover_mirror(text, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '195_handover_odometer_guard',
  'Handover odometer plausibility guard + audited admin recompute (GV-475, external review 2026-08-09). THE BUG: migration 193''s ledgers.max_handover_odometer mirror is monotone by design (a deleted or edited-down handover must not retract a reading that was made), and upsert_booking_handover validated only that end_odometer >= 0 — so one extra digit (1181660 for 118166) poisoned the workspace''s odometer floor, its service calculations and every Start-km prefill PERMANENTLY, with raw production SQL the only recovery. (1) upsert_booking_handover re-declared COMPLETELY off its newest prior definition (191, the GVM-561 not-started guard), signature unchanged so create-or-replace suffices and no PGRST203 candidate is left behind; byte-identical bar one declared variable and two guards, both raising the same Danish sentence "Kilometerstanden ser for høj ud — tjek om du har tastet et ciffer for meget." under the same distinct errcode GV475 (the GV328/GV333/GV42O convention) because the member''s remedy and the client''s handling are identical in both cases. An ABSOLUTE cap of 2.000.000 km judges only the payload and sits with the other payload validations at the top of the function (162''s precedent). A RELATIVE ceiling of anchor + 50.000 km applies only where a history exists, where THE ANCHOR IS greatest(ledgers.max_handover_odometer, ledgers.tank_baseline_odometer) — the only two odometer anchors ledgers carries (092 and 193) — and Postgres'' greatest() ignores nulls, so a workspace holding NEITHER gets no relative ceiling at all and a genuinely new ledger''s first reading of 350000 on a used car is accepted under the absolute cap alone; the tank baseline is in the anchor precisely so a group that started at 300.000 km is not capped at 50.000. trips.odometer and vehicle_incidents.odometer were considered and left out: not on ledgers, a scan per write, and the case they cover already falls under the no-anchor carve-out. The relative ceiling sits AFTER the membership gate (a non-member must not probe a workspace''s mileage by bisecting rejections) and after the GV-421 stale-token precondition (a caller editing a version that no longer exists is told that first), making it the last check before the write. Its one lockout — a first reading typed far too LOW becomes the anchor — is recovered by DELETING or editing DOWN the bad row (never blocked) and then recomputing. (2) NEW RPC recompute_handover_mirror(target_ledger_id, event_title, event_body) returns jsonb: the audited admin correction and the single deliberate exception to 193''s monotonicity. Recomputes all THREE mirror columns from the SURVIVING booking_handovers rows using 193''s own queries — max_handover_odometer to the true maximum, downward if that is what the rows say, and the latest_handover_fraction / latest_handover_observed_at pair alongside it so the two cannot disagree — with all three back to NULL when nothing survives (193''s never-observed state, not a fake 0 km). Admin-only via is_ledger_admin, which is also the workspace boundary; SECURITY DEFINER, search_path pinned, columns table-qualified, execute revoked from public and anon and granted to authenticated (148''s convention, the RPC gates itself). Concurrency is one SELECT ... FOR UPDATE of the ledgers row 193''s trigger writes — a concurrent handover either lands first or waits and then re-applies its own whole-ledger recompute — so no advisory lock is taken. Writes exactly ONE ledger_events row, NEW event_type ''handover_odometer_corrected'', server-authored Danish title and body (the 051/052 event pair is accepted but silence is not: an unconditional write, even when the numbers do not move, because a correction nobody can see is the state GV-475 is about), metadata carrying only the previous and new maximum. GV-413: classified FEED-VISIBLE in tools/ledger-event-visibility.mjs — the odometer is a shared fact and one member''s typo corrected by another is feed news, not an audit row. THE CORRECTION FLOW is delete-or-edit-down the bad handover through existing UI, then recompute; the mobile affordance for the second step is a follow-up and an operator can call the RPC directly until it ships. Anti-drift contract in tools/test-handover-odometer-guard-contract.mjs (npm run test:handover-odometer-guard), wired into npm run validate. No schema change, no column, no table, no policy or RLS change and NO backfill, so no guarded-table settlement trigger is in play (the 192 lesson does not bite); types/database.ts changes because the RPC is new, and both client repos vendor the refreshed copy after the merge. GDPR: nothing new stored, two integers in one event row. Depends on 191 (newest upsert_booking_handover), 193 (the mirror it guards and corrects) and 092 (the tank baseline anchor).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

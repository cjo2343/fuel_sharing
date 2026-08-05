-- Migration 174: the handover's location mirror is ONE conditional UPDATE (GV-444)
--
-- Slice 7 of the Vehicle Handover epic (GVM-519), and the same kind of correction
-- migration 171 made to migration 169: the RULE is right, the way it was implemented
-- leaves a window, and the window is closed by moving the condition into the statement
-- that acts on it.
--
-- ── THE FAILURE ──────────────────────────────────────────────────────────────
-- Migration 172 guards the ledgers location-mirror against a stale offline handover, and
-- does it in three steps:
--
--   1. select l.location_updated_at into v_location_updated_at ...   (no lock)
--   2. v_location_is_stale := ... a PL/pgSQL comparison ...
--   3. update public.ledgers ...                                     (a separate write)
--
-- Between step 1 and step 3 another transaction can COMMIT a newer location — a member
-- tapping "bilen står her" in the app, or a second handover flushing out of somebody
-- else's outbox. Step 1 read the older stamp, so step 2 concluded "not stale", and step 3
-- then overwrites a location that appeared after it was read and stamps it
-- location_updated_at = now().
--
-- That is precisely the harm migration 172 exists to prevent — the group reading a
-- superseded parking spot as freshly confirmed — reached through a smaller window rather
-- than a smaller reason. And it is the worst kind of small window: nobody will ever
-- reproduce it from a bug report, it is invisible in the row it damages, and the guard
-- above it looks correct while it happens.
--
-- ── WHAT CHANGES: ONE FUNCTION, ONE STATEMENT, NO SIGNATURE CHANGE ───────────
-- upsert_booking_handover's mirror becomes a SINGLE UPDATE that carries the staleness
-- test in its OWN where clause:
--
--   where l.id = target_ledger_id
--     and (location_seen_at is null
--          or l.location_updated_at is null
--          or date_trunc('milliseconds', l.location_updated_at)
--             <= date_trunc('milliseconds', location_seen_at))
--
-- and location_mirrored becomes "did that statement touch a row?", read back with
-- `get diagnostics ... = row_count`. The UPDATE locks the row it is deciding about, and
-- in READ COMMITTED Postgres re-evaluates the where clause against the version a
-- concurrent writer committed while this statement waited, so a location that moved
-- under the caller now fails the test and the mirror matches no row. There is no read to
-- go stale, so there is no window.
--
-- ── THE RULE IS UNCHANGED, TERM FOR TERM ─────────────────────────────────────
-- The three disjuncts are migration 172's condition negated, one for one, and every
-- outcome it defined is preserved:
--
--   • location_seen_at IS NULL always mirrors. Every shipped client omits the parameter,
--     so it arrives null and the rows produced are byte-identical to today's. The skip
--     stays opt-in by a client that can actually say what it saw.
--   • A NULL stored location_updated_at always mirrors: there is no current answer for a
--     stale view to overwrite.
--   • Otherwise the stored stamp must be no NEWER than the version the caller had on
--     screen. Equal still mirrors, exactly as 172's `>` allowed.
--
-- MILLISECONDS ON BOTH SIDES, still for migration 160's reason: a timestamp that has
-- passed through a JavaScript Date has lost its microseconds, so a client that read
-- location_updated_at, held it and sent it straight back would otherwise look STALE
-- against the very row it came from — and the mirror would then be skipped forever while
-- blaming a member who did nothing.
--
-- A CLIENT WITH NO VIEW AT ALL can say so by sending '-infinity', which naturally means
-- "I saw no location — do not overwrite one if it exists": any real timestamp is greater
-- than -infinity, so the third disjunct is false and the mirror is skipped, while a
-- workspace that genuinely has no stamp still mirrors through the second.
--
-- ── WHAT IS DELIBERATELY NOT TOUCHED ─────────────────────────────────────────
-- The handover row's INSERT/UPDATE and its handover_created feed event stay OUTSIDE and
-- BEFORE all of this, unchanged and unmoved. HISTORY IS HISTORY: a stale handover is
-- still saved in full, because what Bo reported about Bo's booking is true whenever it
-- arrives, it is the only account of that trip that will ever exist, and an outbox entry
-- the server rejects is an outbox entry that is gone. Only "where is the car RIGHT NOW"
-- may be skipped, and the contract test pins that the guard did not creep upwards.
--
-- location_mirrored keeps BOTH of its false cases and their single meaning — "the
-- workspace location did not change". The pre-existing "this handover mentioned neither
-- parking nor keys" case is still the enclosing `if`, which must not run the statement at
-- all; the stale-view case is now the where clause matching zero rows.
--
-- ── CREATE OR REPLACE, not DROP + CREATE ─────────────────────────────────────
-- The parameter LIST is untouched — the same sixteen arguments in the same order, the
-- same defaults, the same return keys in the same order — so there is no second candidate
-- signature for PostgREST to fail to resolve (the PGRST203 hazard 172/170/168/157/156/063
-- each had to handle) and no client change of any kind. govehlo-mobile's GVM-542 half can
-- ship before or after this; both orders are correct.
--
-- Re-declared COMPLETELY off the NEWEST prior definition — migration 172 (164 created it,
-- 167 re-declared it whole, 168 again for the pin-clearing rule, 170 again for the pin the
-- sheet can now carry, 172 again for the stale-view guard; 148 only revoked anon's
-- execute, and 171 and 173 did not touch it). Everything except the two dropped locals,
-- the one added local, the mirror statement itself and the comments that narrate it is
-- byte-identical to 172, in-body comments included, so the equivalence check has nothing
-- to say about it.
--
-- No new column, no new table, no new event_type, no new RPC, no new grant, no change to
-- any check constraint and no RLS change — nothing for GV-413 to classify.
--
-- ── GDPR ─────────────────────────────────────────────────────────────────────
-- No new category of data, no new store, no new recipient and no new retention question.
-- location_seen_at is still read and written nowhere. If anything this tightens migration
-- 172's own minimisation argument rather than changing it: the workspace row records the
-- car's position only when the writer's view of it was current, and now that is true
-- under concurrency as well as in the quiet case.

-- ── upsert_booking_handover, re-declared off its migration 172 definition ─────
-- The header above covers the one thing that changed. Everything below — the write gate,
-- the trip-driver branch, the GV-421 precondition, the full-replace update, the
-- create-only feed event, the two Danish pin guards, the null-preserving mirror and
-- GVM-542's stale-view rule itself — is migration 172's, carried over verbatim, and
-- 164's original explanation is kept with it so the function still explains itself to
-- whoever reads it next.
--
-- ── The two new guards, and why they speak Danish ─────────────────────────────
-- Migration 168's twin guards on set_vehicle_location are ENGLISH, because that function
-- raises English text that govehlo-mobile maps to Danish copy by matching the sentence
-- (lib/vehicle-location.ts). This function is the opposite by deliberate choice, made in
-- 164 and kept ever since: every guard it raises is already a finished Danish sentence,
-- shown to the member as-is, with no mapping table anywhere in the client. Two English
-- sentences here would be the only English a Danish user ever sees in the handover
-- sheet, and would oblige the mobile half to build a mapping layer for a function that
-- has never needed one. So they are Danish, and they are distinct from all eleven guards
-- around them: no existing message opens with "Parkeringsnålen", and neither new
-- sentence is a substring of any other (the client matches on full sentences).
--
-- Create-or-update, keyed on booking_id.
--
-- WHO MAY WRITE. The handover is the account of the person who HAD the car, so the
-- writer must be one of:
--
--   • the booking's own member (car_bookings.member_id) — the normal case;
--   • the DRIVER of the trip logged against that booking, via migration 123's
--     durable booking→trip link (trips.booking_id = this booking, deleted_at is
--     null);
--   • a workspace admin — the same escape hatch GV-253 gives every other identity
--     field, for the "Bo has left the group and nobody can fix the parking spot"
--     case.
--
-- BE HONEST ABOUT WHAT THE TRIP-DRIVER BRANCH IS FOR. It is NOT the general "booked
-- in one name, driven by another" case, and reading it that way would be wrong:
-- migration 123's enforce_trip_booking_scope trigger refuses any trip carrying a
-- booking_id whose driver_member_id is not the booking's member, so a linked trip's
-- driver EQUALS the booking's member at the moment the trip is written, and the
-- first branch already covers them.
--
-- The branch exists because that equality is enforced on the TRIP and not on the
-- BOOKING. The trigger fires on trips (insert, and update of booking_id/ledger_id/
-- driver_member_id/deleted_at); nothing re-validates it when car_bookings.member_id
-- is REASSIGNED, which GV-253 explicitly allows an admin or the booking's creator to
-- do. So after a reassignment the pair drifts apart, and the person who actually
-- drove the car and parked it is no longer the booking's member. Without this branch
-- they would be locked out of writing the handover for the trip they just made —
-- and they are the only person who knows where the car is. Narrow on purpose;
-- the contract test drives exactly that sequence rather than asserting the branch
-- from a case the first branch would have passed anyway.
--
-- Anyone else in the workspace is refused with 42501. Note what that is NOT: it is
-- not a read restriction. Every member READS the handover (that is the feature); the
-- gate is only on who gets to author it.
--
-- An UPDATE REPLACES every field with what the caller sent — it is not a
-- coalesce-leave-unchanged patch. The client posts the whole sheet, and a
-- coalescing update would make it impossible to CLEAR a field: correcting a wrong
-- parking spot to "I do not know" would silently keep the wrong one.
--
-- The advisory lock is per BOOKING, hashtext(ledger || ':handover:' || booking_id),
-- so two devices saving the same handover serialize here instead of racing the
-- unique constraint into a 23505 that says nothing useful. It is its own infix, so
-- the key space cannot collide with migration 063's ':booking:' lock or migration
-- 162's ':bookingcap:' one. Note what it does NOT cover, which is why GV-444 exists:
-- it serializes two writers of the SAME booking, and the workspace's location can be
-- moved by anything — another booking's handover, set_vehicle_location, another
-- member entirely — so the mirror has to defend itself in its own statement.
--
-- ── GV-421 precondition (expected_updated_at, LAST parameter) ──────────────────
-- Identical semantics to migration 160, deliberately, so there is one rule in the
-- product rather than a per-entity dialect:
--
--   1. NULL or absent → no precondition. Last-write-wins, byte for byte.
--   2. Present, the row EXISTS, updated_at differs → REJECTED with errcode 'GV42O'
--      and NOTHING is written.
--   3. Present, NO row yet → IGNORED; the create proceeds. A create cannot conflict.
--
-- 'GV42O' — O for Overdragelse, joining GV42T/GV42F/GV42B from the same family
-- (migration 160) and following 159's trailing-letter convention. One code per
-- entity, because the client has to name the thing that moved in its copy.
--
-- Both sides are compared through date_trunc('milliseconds', …) for migration 160's
-- reason: a token that has passed through a JavaScript Date has lost its
-- microseconds, and a microsecond-exact comparison would then refuse every edit
-- forever while blaming a member who did nothing. `is distinct from` rather than
-- `<>`, so a null stored updated_at reads as "cannot prove it is unchanged" and
-- refuses.
--
-- The guard sits AFTER every permission gate (an unauthorised caller must not learn
-- a row's modification time) and BEFORE the write. A rejected write logs nothing —
-- a conflict is a write that did NOT happen, and the group does not need to hear
-- about one member's failed tap.
--
-- The payload validations (odometer, fuel fraction, the four text lengths, and now
-- the pin's shape) run FIRST, ahead of the membership lookup, following migration
-- 162's duration check: they judge only values the caller themselves sent, so they
-- need no lookup and leak nothing about the workspace.
--
-- The feed event is written on CREATE ONLY. A handover is news — the next driver
-- needs to see it — but the third correction to a parking spot is not, and an
-- edit-storm in the feed is how a useful feed stops being read. 'handover_created'
-- is classified FEED-VISIBLE in tools/ledger-event-visibility.mjs (GV-413).
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '174_handover_mirror_race_free',
  'The handover''s location mirror becomes ONE conditional UPDATE instead of a read-then-check-then-write (GV-444; slice 7 of the GVM-519 handover epic). ONE function changes, public.upsert_booking_handover, and its SIGNATURE DOES NOT: the same sixteen arguments in the same order with the same defaults, the same return keys in the same order, so this is create-or-replace rather than DROP + CREATE, there is no second candidate signature for PostgREST to fail to resolve (the PGRST203 hazard 172/170/168/157/156/063 each had to handle), and no client change of any kind — govehlo-mobile''s GVM-542 half can ship before or after. THE RACE: migration 172 guards the ledgers location-mirror against a stale offline handover, but implements the rule in three steps — `select l.location_updated_at into v_location_updated_at` with NO lock, a PL/pgSQL comparison against location_seen_at, and then a separate `update public.ledgers`. Between step one and step three another transaction can COMMIT a newer location: a member tapping "bilen står her" through set_vehicle_location, or another booking''s handover flushing out of somebody else''s outbox. The read saw the older stamp, the comparison therefore concluded "not stale", and the write overwrote a location that had appeared after it was read AND stamped it location_updated_at = now(). That is exactly the harm migration 172 exists to prevent — the group reading a superseded parking spot as freshly confirmed — reached through a smaller window rather than a smaller reason, and it is the worst kind of small window: invisible in the row it damages, unreproducible from any bug report, and sitting underneath a guard that looks correct while it happens. Note what the per-booking advisory lock does NOT cover, which is why the hole exists at all: it serializes two writers of the SAME booking, while the workspace''s location can be moved by anything — another booking''s handover, set_vehicle_location, another member entirely — so the mirror has to defend itself in its own statement. THE FIX: the mirror is a SINGLE UPDATE carrying the staleness test in its OWN where clause — `where l.id = target_ledger_id and (location_seen_at is null or l.location_updated_at is null or date_trunc(''milliseconds'', l.location_updated_at) <= date_trunc(''milliseconds'', location_seen_at))` — with location_mirrored read back from `get diagnostics ... = row_count`. The UPDATE locks the row it is deciding about, and in READ COMMITTED Postgres re-evaluates the where clause against the version a concurrent writer committed while the statement waited, so a location that moved under the caller fails the test and the mirror matches no row instead of being read as current and then overwritten. There is no read left to go stale, so there is no window. THE RULE IS UNCHANGED, TERM FOR TERM: the three disjuncts are migration 172''s condition negated one for one, and every outcome it defined is preserved — a NULL location_seen_at ALWAYS mirrors (every shipped client omits the parameter, so it arrives null and the rows produced are byte-identical to today''s; the skip stays opt-in by a client that can actually say what it saw), a NULL stored location_updated_at always mirrors (there is no current answer for a stale view to overwrite), and otherwise the stored stamp must be no NEWER than the version the caller had on screen, EQUAL still mirroring exactly as 172''s `>` allowed. Both sides still go through date_trunc(''milliseconds'', …) for migration 160''s reason: a timestamp that has passed through a JavaScript Date has lost its microseconds, so a client that read location_updated_at, held it and sent it straight back would otherwise look stale against the very row it came from and the mirror would be skipped forever while blaming a member who did nothing. A client with no view at all can say so by sending ''-infinity'', which naturally blocks the mirror wherever a location exists (every real timestamp is greater than -infinity) while a workspace that genuinely has no stamp still mirrors through the second disjunct. WHAT IS DELIBERATELY NOT TOUCHED: the handover row''s INSERT/UPDATE and its handover_created feed event stay OUTSIDE and BEFORE all of this, unchanged and unmoved, because HISTORY IS HISTORY — a stale handover is still saved in full, since what Bo reported about Bo''s booking is true whenever it arrives, it is the only account of that trip that will ever exist, and an outbox entry the server rejects is an outbox entry that is gone. Only "where is the car RIGHT NOW" may be skipped. location_mirrored keeps BOTH of its false cases and their single meaning, "the workspace location did not change": the pre-existing "this handover mentioned neither parking nor keys" case is still the enclosing `if`, which does not run the statement at all, and the stale-view case is now the where clause matching zero rows. The function is re-declared COMPLETELY off its NEWEST prior definition, migration 172 (164 created it, 167 re-declared it whole, 168 again for the pin-clearing rule, 170 again for the pin the sheet can now carry, 172 again for the stale-view guard; 148 only revoked anon''s execute, and 171 and 173 did not touch it), byte-identical to it — in-body comments included — apart from two dropped locals (v_location_updated_at, v_location_is_stale), one added local (v_mirror_rows integer), the mirror statement itself and the comments that narrate it. Grants are restated for the unchanged signature exactly as 172 states them: revoke all from public and anon, grant execute to authenticated. No new column, no new table, no new event_type, no new RPC, no new grant, no change to any check constraint, no RLS change, and nothing for GV-413 to classify. GDPR: no new category of data, no new store, no new recipient and no new retention question — location_seen_at is still read and written nowhere (not to a table, not to the feed, not to a log line) — and this tightens migration 172''s own minimisation argument rather than changing it, since the workspace row now records the car''s position only when the writer''s view of it was current under CONCURRENCY as well as in the quiet case. Pinned by tools/test-booking-handover-contract.mjs, statically (the mirror is one UPDATE whose own where clause carries the date_trunc staleness condition, location_mirrored comes from row_count, no unguarded `location_updated_at = now()` write survives outside it, no read-then-check locals remain, and the handover INSERT/UPDATE and its feed event are outside it — in the migration and the consolidated schema alike) and behaviourally against a real Postgres (a stale view skips the mirror while the row and its event still land, a current view mirrors, an equal stamp mirrors, a millisecond-truncated view mirrors, one real millisecond behind is stale, a null location_seen_at is byte-identical to today, ''-infinity'' blocks the mirror where a location exists and mirrors where the stamp is null, and "nothing to mirror" reports false too), and by tools/test-rls-role-matrix.mjs, whose handover cases continue to call the RPC without the parameter. MERGE ORDER: nothing depends on it and it depends on nothing — 172 must already be applied, and no client needs to change.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

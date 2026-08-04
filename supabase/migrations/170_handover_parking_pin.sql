-- Migration 170: the parking pin travels WITH the handover (GVM-540)
--
-- Slice 5 of the Vehicle Handover epic (GVM-519), and the smallest possible correction
-- to migration 168. That migration added ONE optional coordinate pair to the workspace
-- row and bound it to the parking TEXT with a single rule — THE PIN BELONGS TO THE TEXT
-- IT WAS SET WITH — enforced in two places: set_vehicle_location writes it full-set, and
-- the handover mirror CLEARS it whenever it writes a new parking text.
--
-- The clearing half was correct for exactly one reason, stated in 168's own header: "a
-- handover form has no way to drop a pin". Owner decision 2026-08-04 (GVM-540) gives it
-- one. Once the handover sheet can carry a pin, clearing unconditionally stops being the
-- honest outcome and starts being a hole: the driver standing at the car, who is the one
-- person who knows where it is, taps "brug min placering" on the handover form and the
-- database throws the coordinates away.
--
-- ── What changes ─────────────────────────────────────────────────────────────
-- ONE function: upsert_booking_handover gains parking_lat_value / parking_lng_value.
-- Nothing else. No new column, no new table, no new event_type, no new grant, no change
-- to any check constraint — the pin's storage, its constraints, its comments and its
-- GDPR posture are all migration 168's and all unchanged.
--
-- THE HANDOVER ROW STORES NO PIN, and that is a decision rather than an omission.
-- booking_handovers stays free text with no coordinate column (164's rule, pinned by a
-- contract test that scans the catalog for any column name containing lat/lng/geo/coord).
-- The pin is CURRENT CAR STATE, not history: it answers "where is the car right now",
-- which is precisely the question migration 167 moved onto the ledgers row and away from
-- "what did each driver report about their booking". Storing a coordinate per handover
-- would build the one thing 168 refused to build — an accumulating series of positions,
-- one per booking, which is a movement history of a named person. So the two new
-- parameters are PASS-THROUGH: they reach ledgers.parking_lat/parking_lng through the
-- mirror and are written nowhere else.
--
-- ── THE MIRROR RULE, now symmetric ───────────────────────────────────────────
-- The mirror stays NULL-PRESERVING per field, exactly as migration 167 built it and 168
-- left it. Only the "parking text arrived" branch gains a case:
--
--   parking text  | pin params | ledgers.parking_lat/lng
--   --------------+------------+-------------------------------------------------
--   NON-NULL      | NON-NULL   | WRITTEN — the driver dropped a fresh pin (NEW)
--   NON-NULL      | null       | CLEARED — exactly migration 168's behaviour
--   null          | anything   | PRESERVED — exactly migration 167/168's behaviour
--
-- Two of those three rows are today's behaviour, byte for byte, and they are listed here
-- so the diff is read as ONE new case rather than as a rewrite of the rule.
--
-- The third row deserves its own sentence, because it is the case a reader will ask
-- about: a pin sent WITHOUT a parking text is IGNORED, not stored and not an error. The
-- pin rides the text; a handover that says nothing about where the car is parked asserts
-- nothing the pin could belong to, and attaching fresh coordinates to a text somebody
-- else wrote days ago would recreate the stale-pin failure from the other direction. The
-- payload guards below still judge the pair (a lone latitude is refused whether or not a
-- text came with it), because a malformed pin is malformed regardless of what the mirror
-- would have done with it.
--
-- ── AN OLD CLIENT IS UNCHANGED, BYTE FOR BYTE ────────────────────────────────
-- Both new parameters default to null and sit BEFORE the trailing event pair (the 051
-- convention). govehlo-mobile's shipped handover call posts THIRTEEN named keys —
-- target_ledger_id, target_booking_id, end_odometer_value, fuel_fraction_value,
-- parking_location_value, key_location_value, condition_ok_value, condition_note_value,
-- note_to_next_value, keys_confirmed_value, event_title, event_body,
-- expected_updated_at — and never mentions the pin. PostgREST resolves that body against
-- this signature through the two defaults, both coordinates arrive null, and the middle
-- row of the table above applies: a new parking text CLEARS the pin, which is what the
-- app does today. An old client is therefore not merely "still working" but produces the
-- IDENTICAL row it produces now, and the role matrix calls the RPC with only those
-- thirteen named arguments and asserts exactly that.
--
-- ── DROP + CREATE, not create-or-replace ─────────────────────────────────────
-- The parameter LIST changes, so Postgres would otherwise leave the thirteen-argument
-- version alive beside the fifteen-argument one. Two candidate signatures with defaulted
-- parameters is PGRST203: PostgREST cannot resolve between them and EVERY call fails,
-- including the old client this migration is careful to keep working (the 168/157/156/063
-- lesson). The drop names the CURRENT signature explicitly.
--
-- Re-declared COMPLETELY off the NEWEST prior definition — migration 168 (164 created
-- it, 167 re-declared it whole, 168 re-declared it again for the pin-clearing rule, and
-- 148 only revoked anon's execute; 169 did not touch it). Everything except the two
-- parameters, their two guards and the two mirror expressions is byte-identical to 168,
-- in-body comments included, so the equivalence check has nothing to say about it.
--
-- ── GDPR ─────────────────────────────────────────────────────────────────────
-- No new category of data, no new store, no new retention question. The pin is the same
-- single overwritten coordinate pair migration 168 registered in RoPA A2; this migration
-- adds a second RPC that can write it and no new place for it to land. Restated, because
-- a reader arriving at this file first should not have to go and find 168:
--
--   1. STILL USER-INITIATED. The only way a coordinate reaches this function is a member
--      tapping "brug min placering" on the handover sheet before saving. Nothing samples
--      position, here or anywhere.
--   2. STILL ONE POINT, NO HISTORY. Two columns on the workspace row, overwritten in
--      place. This migration deliberately does NOT put the pin on the handover row,
--      where it would accumulate one position per booking (see above).
--   3. STILL NEVER IN THE FEED. handover_created's metadata carries the booking id and
--      the handover id and is untouched by this migration — no coordinates, and not even
--      a boolean, because the handover event is not the place a member looks for the
--      car's position.
--   4. STILL NEVER IN A URL, A QUERY STRING OR A LOG LINE, the standing rule for number
--      plates and for every location field on this platform.
--   5. STILL DIES WITH THE WORKSPACE, and still cannot outlive the text it belongs to —
--      the rule this migration extends rather than relaxes: the pin is replaced when a
--      fresh one arrives with a new text, and cleared when a new text arrives without
--      one.
--
-- docs/gdpr/ropa.md A2 already describes the pin, its user-initiated origin, its
-- single-point/no-history shape and its clearing rule; it needed one clarification, that
-- a handover can now carry a fresh pin rather than only clear one.

-- ── upsert_booking_handover, re-declared off its migration 168 definition ─────
-- The header above covers the three things that changed. Everything below — the write
-- gate, the trip-driver branch, the GV-421 precondition, the full-replace update, the
-- create-only feed event and the null-preserving mirror itself — is migration 168's,
-- carried over verbatim, and 164's original explanation is kept with it so the function
-- still explains itself to whoever reads it next.
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
-- 162's ':bookingcap:' one.
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
drop function if exists public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, text, text, timestamptz);

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
  if v_parking is not null or v_keys is not null then
    update public.ledgers l
       set parking_location = coalesce(v_parking, l.parking_location),
           parking_lat = case when v_parking is null then l.parking_lat else parking_lat_value end,
           parking_lng = case when v_parking is null then l.parking_lng else parking_lng_value end,
           key_location = coalesce(v_keys, l.key_location),
           location_updated_by_member_id = v_actor_member_id,
           location_updated_at = now(),
           updated_at = now()
     where l.id = target_ledger_id;
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
    'updated_at', v_updated_at
  );
end;
$$;

revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, text, text, timestamptz) from public;
revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, text, text, timestamptz) from anon;
grant execute on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, numeric, numeric, text, text, timestamptz) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '170_handover_parking_pin',
  'The parking pin travels WITH the handover (GVM-540, slice 5 of the GVM-519 handover epic). ONE function changes: public.upsert_booking_handover gains parking_lat_value and parking_lng_value, placed BEFORE the trailing event_title/event_body per the 051 convention, and is therefore DROP + CREATE rather than create-or-replace — the parameter list changes, and leaving the thirteen-argument version alive beside the fifteen-argument one is PGRST203, which PostgREST cannot resolve and which would break EVERY call including the old client this migration is careful to keep working (the 168/157/156/063 lesson). Nothing else changes: no new column, no new table, no new event_type, no new grant, no change to any check constraint. THE STORAGE, CONSTRAINTS, COMMENTS AND GDPR POSTURE OF THE PIN ARE ALL MIGRATION 168''S AND ALL UNCHANGED. WHY: migration 168 bound the pin to the parking TEXT with one rule — the pin belongs to the text it was set with — and had the handover mirror CLEAR it whenever it wrote a new parking text, for exactly the reason 168 wrote down, that "a handover form has no way to drop a pin". Owner decision 2026-08-04 (GVM-540) gives it one, and once the sheet can carry a pin, clearing unconditionally stops being the honest outcome and becomes a hole: the driver standing at the car, who is the one person who knows where it is, taps "brug min placering" on the handover form and the database throws the coordinates away. THE MIRROR RULE IS NOW SYMMETRIC, and two of its three cases are today''s behaviour byte for byte, so the diff is ONE new case rather than a rewrite: (a) NON-NULL parking text WITH a non-null pin now WRITES the pin to ledgers.parking_lat/parking_lng — new; (b) NON-NULL parking text with a null pin CLEARS the pin — exactly migration 168''s behaviour, because the stored coordinates then describe wherever the car used to be and map-grade confidence in the wrong street is worse than no pin at all; (c) a NULL parking field PRESERVES the text and therefore the pin — exactly migration 167/168''s behaviour, since nothing was asserted about the parking spot. The mirror stays NULL-PRESERVING per field in every other respect. Case (c) has a consequence stated rather than left to be discovered: a pin sent WITHOUT a parking text is IGNORED, not stored and not an error, because the pin rides the text and there is no text for it to belong to; attaching fresh coordinates to a text somebody else wrote days ago would recreate the stale-pin failure from the other direction. THE HANDOVER ROW STORES NO PIN, deliberately: booking_handovers stays free text with no coordinate column (164''s rule, pinned by a contract test that scans the catalog for any column name containing lat/lng/geo/coord), because the handover row is history — what THIS driver reported about THIS booking — and a coordinate per handover would accumulate one position per booking, which is the movement history of a named person that migration 168 refused to build. The pin is CURRENT CAR STATE and lives only on ledgers; the two new parameters are pass-through to the mirror and are written nowhere else. AN OLD CLIENT IS UNCHANGED BYTE FOR BYTE, not merely "still working": both new parameters default to null, and govehlo-mobile''s shipped handover call posts thirteen named keys (target_ledger_id, target_booking_id, end_odometer_value, fuel_fraction_value, parking_location_value, key_location_value, condition_ok_value, condition_note_value, note_to_next_value, keys_confirmed_value, event_title, event_body, expected_updated_at) and never mentions the pin, so PostgREST resolves it through the defaults, both coordinates arrive null and case (b) applies — precisely what the app does today. The role matrix calls the RPC with only those thirteen named arguments and asserts the pin is gone afterwards. Two new guards, and unlike migration 168''s twins on set_vehicle_location they are DANISH: ''Parkeringsnålen mangler den ene koordinat.'' (22023, exactly both or neither) and ''Parkeringsnålens koordinater er ugyldige.'' (22023, lat -90..90, lng -180..180). That is this function''s own convention, chosen in 164 and kept since — every guard it raises is a finished Danish sentence shown to the member as-is, with no mapping table anywhere in the client, whereas set_vehicle_location raises English that govehlo-mobile maps by matching the sentence. Two English sentences here would be the only English a Danish user ever sees in the handover sheet and would oblige the mobile half to build a mapping layer for a function that has never needed one. Both are distinct from the eleven guards around them (no existing message opens with "Parkeringsnålen", and neither is a substring of any other), and both run with the other payload validations ahead of the membership lookup, so they leak nothing about the workspace and refuse a malformed pin whether or not a parking text came with it. The function is re-declared COMPLETELY off its NEWEST prior definition, migration 168 (164 created it, 167 re-declared it whole, 168 re-declared it again for the pin-clearing rule, 148 only revoked anon''s execute, and 169 did not touch it), byte-identical to it — in-body comments included — apart from the two parameters, their two guards and the two mirror expressions. GDPR: no new category of data, no new store and no new retention question. The pin is the same single overwritten coordinate pair 168 registered in RoPA A2, and this migration adds a second RPC that can write it and no new place for it to land — still USER-INITIATED (the only way a coordinate reaches this function is a member tapping "brug min placering" before saving; nothing samples position), still ONE POINT WITH NO HISTORY (two columns on the workspace row overwritten in place, and deliberately NOT on the handover row where they would accumulate), still NEVER IN THE FEED (handover_created''s metadata carries the booking id and the handover id and is untouched — no coordinates and not even a boolean, because the handover event is not where a member looks for the car''s position), still never in a URL, a query string or a log line, and still dying with the workspace and unable to outlive the text it belongs to, since the rule is extended rather than relaxed: the pin is REPLACED when a fresh one arrives with a new text and CLEARED when a new text arrives without one. docs/gdpr/ropa.md A2 gains one clarification — that a handover can now carry a fresh pin rather than only clear one — and needs nothing else, since the data, its lifetime and its recipients are unchanged. Pinned by tools/test-rls-role-matrix.mjs (the pin lands through a handover, a text-only handover clears it, a null-parking handover preserves it, a lone latitude and an out-of-range pair are 22023, and the old thirteen-key call still clears it) and by tools/test-booking-handover-contract.mjs (the same three mirror properties plus "a pin without a text is ignored" and the unchanged no-coordinate-column shape of booking_handovers). MERGE ORDER: PostgREST rejects a body carrying an argument the function lacks (PGRST202), so this must be applied in production BEFORE govehlo-mobile''s GVM-540 half ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

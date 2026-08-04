-- Migration 168: the parking pin — ONE optional coordinate pair on the workspace (GVM-536)
--
-- Slice 4 of the Vehicle Handover epic (GVM-519). Migration 167 put the car's CURRENT
-- parking and key placement on the workspace row as free text. This adds the one thing
-- free text cannot do: "P-plads bag Netto" is useless to a member who does not already
-- know where Netto is, and the group's newest member is exactly the person most likely
-- to be reading it. A pin the previous driver dropped when they parked answers that,
-- and nothing else does.
--
-- ── THIS REVERSES THE PLATFORM'S NO-COORDINATES POSTURE, for this one field pair ──
-- Say it plainly rather than letting a diff imply it. The platform has written down,
-- repeatedly and on purpose, that it does not store coordinates:
--
--   • migration 062/071 DROPPED user GPS from fuel logs;
--   • migration 151 DROPPED station coordinates;
--   • migration 164 chose free text for the handover's parking field and said "never
--     coordinates" in the column comment;
--   • migration 167 repeated that choice for these very columns, in its header, in its
--     column comments and in its tracker row, and cited 151 and 062/071 while doing it.
--
-- That posture is being overturned for ONE field pair by an owner decision (2026-08-04,
-- GVM-536). It is not being softened generally, and the reasons are recorded here so a
-- later reader does not mistake this for drift:
--
--   1. THE USE CASE IS THE ONE COORDINATES ARE ACTUALLY FOR. Every dropped coordinate
--      above was TELEMETRY: a position collected as a side effect of doing something
--      else (logging a fill-up, listing a station), about a PERSON, that the feature
--      did not need. This one is the opposite in every respect — the member taps a
--      button that says "brug min placering", the point is about a CAR parked in a
--      public street, and it is the entire answer to the question being asked. Data
--      minimisation is a test of necessity, not a ban on a data type; the earlier
--      drops passed that test in the other direction.
--   2. ONE POINT, OVERWRITTEN IN PLACE, NEVER A TRACK. What made the dropped GPS
--      dangerous was accumulation: a row per fuel stop is a movement history of a
--      named person. There is exactly one pin per workspace here. Saving a new one
--      overwrites the old; there is no history table, no per-member column, no
--      background collection, and nothing writes it except a member's own deliberate
--      save. A single overwritten point cannot become a pattern of life.
--   3. IT DIES WITH THE TEXT IT BELONGED TO. A stale pin is worse than none — it sends
--      the next driver confidently to the wrong street, the precise failure migration
--      167 exists to prevent. So the pin is bound to the parking TEXT: any write that
--      changes the text without supplying a fresh pin CLEARS it (see below, twice).
--
-- The pin is OPTIONAL and stays optional. A workspace that never taps the button holds
-- null/null forever, which is the normal state and the honest one.
--
-- ── What this migration adds ──────────────────────────────────────────────────
--   1. public.ledgers.parking_lat / parking_lng — two nullable numerics with three
--      named check constraints (both-or-neither, and a range each).
--   2. set_vehicle_location gains the pair. Its PARAMETER LIST CHANGES, so this is a
--      DROP + CREATE rather than a create-or-replace.
--   3. upsert_booking_handover re-declared off its migration 167 definition with ONE
--      addition: the mirror clears the pin when it writes a new parking text.
--
-- ── THE TWO PLACES A STALE PIN IS KILLED ──────────────────────────────────────
-- Both follow from the same rule — THE PIN BELONGS TO THE TEXT IT WAS SET WITH — and
-- both are pinned by tests, because either one could be "simplified" away in a diff
-- that looks like a tidy-up:
--
--   A. set_vehicle_location is FULL-SET on the pin exactly as it already is on the two
--      text columns: both coordinates are written on EVERY call, and null/null means
--      CLEARED. This has a consequence worth stating out loud rather than discovering
--      in production: an OLD CLIENT (govehlo-mobile #561 posts exactly five named keys
--      — target_ledger_id, parking_location_value, key_location_value, event_title,
--      event_body) resolves against this new signature through the two defaults, and
--      therefore CLEARS THE PIN on every save. That is CORRECT, not a regression: an
--      old client is by definition saving a parking text without a fresh pin, so the
--      stored pin now describes wherever the car used to be. Clearing it is the honest
--      outcome; keeping it would leave a coordinate pointing at a spot the group has
--      just told us the car left. The role matrix calls the RPC with only those five
--      named arguments and asserts the pin is gone afterwards, so this cannot be
--      "fixed" into a coalesce without the guard saying so.
--   B. the handover MIRROR clears it too. Migration 167's mirror is null-preserving per
--      field, and that is unchanged: a handover that says nothing about parking still
--      leaves the workspace's text, its author and its stamp exactly as they were —
--      and now its pin as well. But when the mirror DOES write a new parking text, it
--      nulls the pin in the same statement. A driver typing "Flyttet til P-huset" into
--      a handover form has no way to drop a pin there, and the old pin is now a lie.
--
-- ── GDPR ──────────────────────────────────────────────────────────────────────
-- The honest register entry, not a reassuring one:
--
--   1. WHAT IT IS. A coordinate pair for a parked shared car. It can be a member's home
--      street or their workplace car park, so it is personal data, and it is location
--      data — the class that gets the most careful handling on this platform.
--   2. USER-INITIATED, ALWAYS. There is no background collection anywhere in this
--      migration and none is permitted to be added quietly: the only writer is an RPC
--      a member calls after tapping save. Nothing samples position over time.
--   3. ONE POINT, NO HISTORY. Two columns on the workspace row, overwritten in place.
--      No audit table, no previous-value column, no event carrying the old value.
--   4. NEVER IN THE FEED. The feed event's metadata carries `parking_pin_set` — a
--      BOOLEAN, saying only that a pin now exists. The coordinates never appear in
--      metadata, in a title or in a body. A feed row is the widest audience a workspace
--      has, and the columns are one query away for every member who needs them.
--   5. NEVER IN A URL, A QUERY STRING OR A LOG LINE. Same standing rule as number
--      plates. Clients read it through the workspace row they already load.
--   6. LIFETIME = THE WORKSPACE'S. Columns ON ledgers, so a workspace purge takes them
--      with the row; no cascade to arrange, no age-based sweep. Plus the stale-pin
--      rules above, which are a retention mechanism in practice: a pin cannot outlive
--      the parking text it was dropped for.
--   7. NO NEW DELETION STEP. Nothing here references a member; location_updated_by_
--      member_id (migration 167) still carries attribution and still rides the existing
--      delete_my_account path. The pin is a fact about the shared car, kept for the same
--      reason 164 and 167 keep the text.
--   8. RECORDED IN docs/gdpr/ropa.md (A2), docs/gdpr/retention.md, and — because the
--      mini-map that displays a pin fetches tiles — docs/gdpr/subprocessors.md, which
--      gains the MapTiler row that should have been added with GVM-407.

-- ── 1. The columns ─────────────────────────────────────────────────────────────
-- numeric, not float8 and not PostGIS geography. numeric is what every other decimal on
-- this schema uses (amounts, litres, fuel fractions), it round-trips through JSON
-- without a binary-float surprise, and a parking pin needs no distance maths in the
-- database. PostGIS would be a whole extension for two columns nothing joins on.
--
-- Constraints are added by name rather than inline so a replay against an existing
-- column still installs them (migration 166's pattern, reused by 167).
alter table public.ledgers
  add column if not exists parking_lat numeric;

alter table public.ledgers
  add column if not exists parking_lng numeric;

-- BOTH OR NEITHER. Half a pin is not a degraded pin, it is a bug that would render as a
-- marker somewhere on the equator or the prime meridian. The RPC refuses the same shape
-- with a readable message; this is the half a direct write cannot talk its way past.
alter table public.ledgers
  drop constraint if exists ledgers_parking_pin_pair_check;

alter table public.ledgers
  add constraint ledgers_parking_pin_pair_check check (
    (parking_lat is null) = (parking_lng is null)
  );

alter table public.ledgers
  drop constraint if exists ledgers_parking_lat_range_check;

alter table public.ledgers
  add constraint ledgers_parking_lat_range_check check (
    parking_lat is null or (parking_lat >= -90 and parking_lat <= 90)
  );

alter table public.ledgers
  drop constraint if exists ledgers_parking_lng_range_check;

alter table public.ledgers
  add constraint ledgers_parking_lng_range_check check (
    parking_lng is null or (parking_lng >= -180 and parking_lng <= 180)
  );

comment on column public.ledgers.parking_lat is
  'Latitude of the OPTIONAL parking pin for the car''s current spot (GVM-536). GDPR: this is the ONE deliberate exception to the platform''s no-coordinates rule — owner decision 2026-08-04 — and it is an exception, not a softening: migrations 062/071 and 151 dropped coordinates, and 164/167 chose free text for exactly these fields. A SINGLE user-initiated point, saved only when a member taps save, overwritten in place: no history, no previous-value column, no background collection, never a track. It NEVER appears in ledger_events metadata (the feed carries the boolean parking_pin_set and nothing else), never in a URL, a query string or a log line. Lifetime is the workspace''s — it dies with the ledgers row via the ordinary purge, with no age-based sweep — and it is CLEARED whenever the parking text changes without a fresh pin (an old client''s save, or a handover mirroring a new parking text), so a stale pin can never outlive the text it belonged to. Paired with parking_lng by ledgers_parking_pin_pair_check.';

comment on column public.ledgers.parking_lng is
  'Longitude of the OPTIONAL parking pin for the car''s current spot (GVM-536). Same posture as parking_lat in every respect: the ONE deliberate exception to the platform''s no-coordinates rule (owner decision 2026-08-04), a single user-initiated point overwritten in place with no history and no background collection, never in ledger_events metadata, a URL or a log line, workspace lifetime with no age-based sweep, and cleared whenever the parking text changes without a fresh pin. Neither column may be set without the other.';

-- ── 2. set_vehicle_location, re-declared off migration 167 with the pin ────────
-- DROP + CREATE, not create-or-replace: the parameter LIST changes, and Postgres would
-- otherwise leave the five-argument version alive beside the seven-argument one. Two
-- candidate signatures with defaulted parameters is PGRST203 — PostgREST cannot resolve
-- between them and every call fails (the 157/156/063 lesson).
--
-- The two new parameters sit BEFORE the trailing event_title/event_body, the 051
-- convention: the event pair stays last, so the next addition lands in the same place.
-- Every in-repo caller uses named arguments; the role matrix's positional calls are
-- updated in the same commit.
--
-- Re-declared COMPLETELY off migration 167's definition (the only one this function has
-- ever had — verified by grep across supabase/migrations), so nothing drifts in from an
-- intermediate version. Everything except the pin is byte-identical to 167, header
-- comments included, so the equivalence check has nothing to say about it.
drop function if exists public.set_vehicle_location(text, text, text, text, text);

-- "I just moved the car" — no booking, no handover, no admin rights required. See the
-- header for the any-member decision and for why this is a FULL SET rather than a
-- patch (the client prefills both fields, so an omitted one means CLEARED).
--
-- Payload validation runs FIRST, ahead of the membership lookup, following migrations
-- 162 and 164: it judges only values the caller themselves sent, so it needs no
-- lookup and leaks nothing about the workspace.
--
-- The guard messages are English and deliberately distinctive — govehlo-mobile maps
-- them to Danish copy by matching the text, so no message here may share an opening
-- clause with an existing one (there are already forty guards starting "Only ledger
-- members can …", and a forty-first would be unmappable).
--
-- No advisory lock: this is a single-statement UPDATE of two columns on one row, and
-- Postgres serialises concurrent updates of the same row by itself. There is no
-- read-decide-write sequence to protect, which is the only thing the handover's lock
-- is for.
--
-- No optimistic-concurrency token either, and that is a decision rather than an
-- omission: GV-421 preconditions exist to protect a form somebody is EDITING, where a
-- silent overwrite loses typed work. This is a one-line statement of a fact that
-- changes every time the car moves, and the newest statement is by definition the
-- right one — refusing it because another member also moved the car would be exactly
-- backwards.
--
-- ── GVM-536: the pin is FULL SET too, and an OLD CLIENT therefore CLEARS it ────
-- parking_lat/parking_lng are written on every call, like the two text columns, and
-- null/null means the pin is CLEARED. A client that predates this migration posts five
-- named keys and never mentions the pin; PostgREST resolves that body against this
-- signature through the two defaults, so both coordinates arrive null and the stored
-- pin is dropped. That is the CORRECT outcome and not something to defend against: a
-- save that states a parking text without a fresh pin is a save whose pin, if kept,
-- would point at wherever the car used to be. The role matrix pins this exact call.
create or replace function public.set_vehicle_location(
  target_ledger_id text,
  parking_location_value text default null,
  key_location_value text default null,
  parking_lat_value numeric default null,
  parking_lng_value numeric default null,
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
  v_parking text;
  v_keys text;
  v_stamped_at timestamptz;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Vehicle location updates need a workspace id' using errcode = '22023';
  end if;

  -- btrim + nullif('') so a field the member cleared by deleting its text arrives as
  -- NULL rather than as a blank string the UI would render as a location (164's rule).
  v_parking := nullif(btrim(parking_location_value), '');
  v_keys := nullif(btrim(key_location_value), '');

  if char_length(coalesce(v_parking, '')) > 200 then
    raise exception 'Where the car is parked must be 200 characters or fewer' using errcode = '22023';
  end if;

  if char_length(coalesce(v_keys, '')) > 200 then
    raise exception 'Where the keys are kept must be 200 characters or fewer' using errcode = '22023';
  end if;

  -- GVM-536. Half a pin is a marker on the equator, so it is refused rather than
  -- stored: exactly both coordinates, or exactly neither.
  if (parking_lat_value is null) <> (parking_lng_value is null) then
    raise exception 'A parking pin needs both its coordinates' using errcode = '22023';
  end if;

  if parking_lat_value is not null
     and (parking_lat_value < -90 or parking_lat_value > 90
          or parking_lng_value < -180 or parking_lng_value > 180) then
    raise exception 'A parking pin must be a valid coordinate pair' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Vehicle location can only be updated by a member of this workspace' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Vehicle location updates need an active membership in this workspace' using errcode = '42501';
  end if;

  -- FULL SET: all four columns are written every call. A null means the member cleared
  -- the field, and clearing a spot that is no longer true has to be possible. For the
  -- pin that also covers the old-client case in the header — five named keys, both
  -- coordinates defaulting to null, stale pin gone.
  update public.ledgers l
     set parking_location = v_parking,
         key_location = v_keys,
         parking_lat = parking_lat_value,
         parking_lng = parking_lng_value,
         location_updated_by_member_id = v_actor_member_id,
         location_updated_at = now(),
         updated_at = now()
   where l.id = target_ledger_id
  returning l.location_updated_at into v_stamped_at;

  -- The feed carries the CLIENT's title, and the metadata deliberately carries only
  -- whether each field now holds a value — never the location text itself, and never
  -- the coordinates (GVM-536: `parking_pin_set` is a boolean, and that is the whole of
  -- what the feed learns about the pin). A feed row is the widest audience a workspace
  -- has, and the free text is already one query away for every member who needs it;
  -- duplicating it into event metadata would spread personal-adjacent location data
  -- into a second store for no gain (GDPR data minimisation, the same reason the
  -- handover event carries only ids).
  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'vehicle_location_updated', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object(
        'parking_location_set', v_parking is not null,
        'key_location_set', v_keys is not null,
        'parking_pin_set', parking_lat_value is not null,
        'source', 'set_vehicle_location'
      )
    );
  end if;

  -- The coordinates ARE echoed here, unlike in the event metadata, and the difference
  -- is the audience: this payload goes back to the one member who just sent them, over
  -- the same TLS connection, and is what lets the client confirm the save without a
  -- re-read. The event is read by the whole workspace and stored for the workspace's
  -- lifetime.
  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'parking_location', v_parking,
    'key_location', v_keys,
    'parking_lat', parking_lat_value,
    'parking_lng', parking_lng_value,
    'location_updated_by_member_id', v_actor_member_id,
    'location_updated_at', v_stamped_at
  );
end;
$$;

revoke all on function public.set_vehicle_location(text, text, text, numeric, numeric, text, text) from public;
revoke all on function public.set_vehicle_location(text, text, text, numeric, numeric, text, text) from anon;
grant execute on function public.set_vehicle_location(text, text, text, numeric, numeric, text, text) to authenticated;

-- ── 3. upsert_booking_handover, re-declared off its migration 167 definition ───
-- Re-declared COMPLETELY off the newest prior definition (167, verified by grep across
-- every migration: 164 created it, 167 re-declared it whole, 148 only revoked anon's
-- execute), so nothing drifts in from an intermediate version. The signature is
-- unchanged, so create-or-replace suffices and no overload is left behind for PostgREST
-- to trip on.
--
-- ONE behavioural change, inside the GVM-520 mirror block: when the mirror writes a
-- NON-NULL parking text, it also NULLS parking_lat/parking_lng. Everything else — the
-- write gate, the trip-driver branch, the GV-421 precondition, the full-replace update,
-- the create-only feed event, the null-preserving mirror itself — is byte-identical to
-- 167, and the header below is 164's own, kept verbatim so the equivalence check (which
-- diffs function bodies including their comments) has nothing to say about it.
--
-- The mirror is NULL-PRESERVING, unlike set_vehicle_location's full set: a handover
-- that says nothing about parking must not erase the car's known parking spot. See
-- this migration's header.
--
-- WHY THE MIRROR LIVES HERE rather than in a trigger on booking_handovers: the RPC is
-- already the table's only writer (no INSERT/UPDATE policy, no grant), so a trigger
-- would add a second mechanism without covering a single extra path — migration 166's
-- reasoning for the same choice.
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
-- The payload validations (odometer, fuel fraction, the four text lengths) run
-- FIRST, ahead of the membership lookup, following migration 162's duration check:
-- they judge only values the caller themselves sent, so they need no lookup and leak
-- nothing about the workspace.
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
  -- GVM-536: THE PIN BELONGS TO THE TEXT IT WAS SET WITH. A handover form has no way
  -- to drop a pin, so when this mirror writes a NEW parking text the stored
  -- coordinates describe wherever the car used to be — a stale pin that would send the
  -- next driver confidently to the wrong street, which is the exact failure the
  -- location feature exists to prevent. So a mirrored parking text CLEARS the pin. A
  -- null parking field preserves the text and therefore its pin too: nothing was
  -- asserted about the parking spot, so nothing about it changes.
  if v_parking is not null or v_keys is not null then
    update public.ledgers l
       set parking_location = coalesce(v_parking, l.parking_location),
           parking_lat = case when v_parking is null then l.parking_lat else null end,
           parking_lng = case when v_parking is null then l.parking_lng else null end,
           key_location = coalesce(v_keys, l.key_location),
           location_updated_by_member_id = v_actor_member_id,
           location_updated_at = now(),
           updated_at = now()
     where l.id = target_ledger_id;
  end if;

  -- CREATE only. An edit writes no event; see the header.
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

revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, text, text, timestamptz) from public;
revoke all on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, text, text, timestamptz) from anon;
grant execute on function public.upsert_booking_handover(text, uuid, integer, numeric, text, text, boolean, text, text, boolean, text, text, timestamptz) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '168_parking_pin',
  'The parking pin — ONE optional coordinate pair on the workspace row (GVM-536, slice 4 of the GVM-519 handover epic). Two nullable numeric columns on public.ledgers, parking_lat and parking_lng, with three named check constraints: ledgers_parking_pin_pair_check ((parking_lat is null) = (parking_lng is null)), ledgers_parking_lat_range_check (-90..90) and ledgers_parking_lng_range_check (-180..180). THIS DELIBERATELY REVERSES THE PLATFORM''S NO-COORDINATES POSTURE FOR THIS ONE FIELD PAIR, and says so rather than letting a diff imply it: migrations 062/071 dropped user GPS from fuel logs, 151 dropped station coordinates, 164 chose free text for the handover''s parking field and wrote "never coordinates" into the column comment, and 167 repeated that choice for these very columns in its header, its comments and this tracker table. Overturned by owner decision 2026-08-04 for three reasons. (1) The use case is the one coordinates are actually for: every dropped coordinate above was TELEMETRY — a position collected as a side effect of doing something else, about a PERSON, that the feature did not need — whereas this is a member deliberately tapping "brug min placering", about a CAR parked in a public street, and it is the entire answer to the question being asked; "P-plads bag Netto" is useless to the newest member, who is exactly the person most likely to be reading it. Data minimisation is a test of necessity, not a ban on a data type. (2) ONE point, overwritten in place, never a track: what made the dropped GPS dangerous was accumulation (a row per fuel stop is a movement history of a named person), and there is exactly one pin per workspace, with no history table, no per-member column, no background collection and nothing writing it but a member''s own deliberate save. (3) It dies with the text it belonged to — a stale pin is worse than none, because it sends the next driver confidently to the wrong street, the precise failure migration 167 exists to prevent. The pin is OPTIONAL and stays optional: a workspace that never taps the button holds null/null forever. set_vehicle_location gains parking_lat_value and parking_lng_value, placed BEFORE the trailing event_title/event_body per the 051 convention, and is therefore DROP + CREATE rather than create-or-replace: the parameter list changes, and leaving the five-argument version alive beside the seven-argument one is PGRST203, which PostgREST cannot resolve (the 157/156/063 lesson). It is re-declared completely off its migration 167 definition — the only one it has ever had — and is byte-identical to it apart from the pin. Two new guards, English and deliberately distinctive because govehlo-mobile maps guard text to Danish copy by matching it: ''A parking pin needs both its coordinates'' (22023, exactly both or neither — half a pin is a marker on the equator) and ''A parking pin must be a valid coordinate pair'' (22023, lat -90..90, lng -180..180). Both run with the other payload validations, ahead of the membership lookup, so they leak nothing about the workspace. THE PIN IS FULL-SET like everything else in the RPC: both coordinates are written on every call and null/null CLEARS. That has a consequence stated out loud rather than discovered in production — an OLD CLIENT (govehlo-mobile #561 posts exactly five named keys: target_ledger_id, parking_location_value, key_location_value, event_title, event_body) resolves against the new signature through the two defaults and therefore CLEARS THE PIN on every save. That is CORRECT, not a regression: a save that states a parking text without a fresh pin is a save whose pin, if kept, would point at wherever the car used to be. The role matrix calls the RPC with only those five named arguments and asserts the pin is gone afterwards, so it cannot be "fixed" into a coalesce without a guard saying so. upsert_booking_handover is re-declared off its newest prior definition (167; 164 created it, 148 only revoked anon''s execute), signature unchanged so create-or-replace suffices, byte-identical apart from ONE addition inside the GVM-520 mirror block: when the mirror writes a NON-NULL parking text it also NULLS parking_lat/parking_lng, because a handover form has no way to drop a pin and the stored one now describes where the car used to be. The mirror stays NULL-PRESERVING in every other respect — a handover that says nothing about parking still leaves the workspace''s text, its author, its stamp AND its pin exactly as they were. GDPR, honestly: the pin is personal location data (it can be a member''s home street or workplace car park); it is USER-INITIATED ALWAYS, with no background collection anywhere in this migration and none to be added quietly, since the only writer is an RPC a member calls after tapping save; it is ONE point with NO history — two columns overwritten in place, no audit table, no previous-value column, no event carrying the old value; it NEVER reaches the feed, whose metadata gains the BOOLEAN ''parking_pin_set'' and nothing else, so coordinates appear in no title, body or metadata; it never goes in a URL, a query string or a log line, the same standing rule as number plates; its lifetime is the workspace''s, dying with the ledgers row on purge with no age-based sweep, and the two stale-pin rules above act as a retention mechanism in practice because a pin cannot outlive the parking text it was dropped for; and there is no new deletion step, because nothing here references a member — location_updated_by_member_id still carries attribution and still rides the existing delete_my_account path. Recorded in docs/gdpr/ropa.md (A2) and docs/gdpr/retention.md, and docs/gdpr/subprocessors.md gains the MapTiler row (Switzerland/EU, client-side style and tile fetches with an API key and no account identifiers) that should have been added with GVM-407 and that the pin''s mini-map deepens. MERGE ORDER: PostgREST rejects a body carrying an argument the function lacks (PGRST202), so this must be applied in production BEFORE govehlo-mobile''s GVM-536 half ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 167: where the car is RIGHT NOW — parking and key placement on the workspace (GVM-520)
--
-- Slice 3 of the Vehicle Handover epic (GVM-519). Migration 164 shipped the handover
-- row; the mobile sheet followed. This slice answers the question the epic was really
-- about: a member standing in the street with the app open asks "where is the car,
-- and where are the keys?" — and wants to be able to ANSWER it too, without a booking
-- to hang the answer on.
--
-- ── This REVERSES a position migration 164 wrote down, deliberately ────────────
-- 164's header says, in as many words, that the car's current parking and keys live
-- in the newest handover row "and nowhere else", and that a pair of columns on
-- `ledgers` was rejected because "two places holding the same fact is how they
-- drift". That was a reasonable call on the data it had. It is being overturned by an
-- owner decision (2026-08-04), and the reasons are worth writing down rather than
-- quietly contradicting:
--
--   1. THE HANDOVER DOES NOT COVER THE QUESTION. A handover hangs off a BOOKING. The
--      car moves without one all the time — someone shifts it off a street-sweeping
--      day, a member borrows it for twenty minutes, the group parks it somewhere new
--      after a wash. The newest handover then states, with full confidence, where the
--      car was left LAST TIME A BOOKING ENDED, which is not where it is. "Read the
--      newest handover" is not a slightly stale answer to the question; on those days
--      it is a wrong one, and the next driver walks to the wrong street — the exact
--      failure 164 set out to prevent.
--   2. THE ALTERNATIVE IS WORSE, not better. Making it work off handovers alone means
--      either booking-less handover rows (a `booking_handovers` row with a null
--      booking_id, which breaks the UNIQUE that makes a save a correction and turns
--      the table into an append-only location log), or a second table that is the
--      same thing with a different name. Both put MORE places in play than one pair
--      of columns does.
--   3. DRIFT IS ANSWERED BY DIRECTION, not by refusing to store it. There is exactly
--      one writer per direction: the handover MIRRORS into these columns, and nothing
--      ever copies back. `ledgers` is the current state; `booking_handovers` is the
--      history of what each driver reported. They are not two copies of one fact —
--      they answer "where is it now?" and "what did Bo say when he handed it over on
--      the 3rd?", and only the first is on the workspace row.
--
-- ── What this migration adds ──────────────────────────────────────────────────
--   1. Four nullable columns on public.ledgers. The workspace row already carries car
--      state that is not a "setting" — tank_baseline_odometer/fraction/recorded_at
--      (migration 092) are the precedent, down to the recorded-at stamp.
--   2. public.set_vehicle_location — the standalone writer, for moving the car with
--      no booking in sight.
--   3. upsert_booking_handover re-declared off its 164 definition with ONE
--      behavioural change: it mirrors what the handover carries into those columns.
--
-- ── ANY member may write it, and that is the decision, not an oversight ────────
-- set_vehicle_location is gated on active MEMBERSHIP, not on admin. Whoever moved the
-- car is the only person who knows where it is now, and they are usually not the
-- admin. This is the standing any-member-attribution decision the platform already
-- takes everywhere a fact about the shared car is recorded (a trip, a fuel stop, an
-- incident): the group's protection against a wrong entry is that everyone can see it
-- and anyone can fix it, not that one person owns the pen. A second member
-- overwriting the first is therefore CORRECT behaviour — the car moved again — and
-- the role matrix pins it as such so a later "harden this to admin-only" reads as the
-- reversal it would be.
--
-- Contrast with upsert_booking_handover, which stays narrowly gated (the booking's
-- member, the linked trip's driver, or an admin). That is not an inconsistency: a
-- handover is one person's ACCOUNT of a booking they held, and letting a bystander
-- author it would put words in their mouth. "Where is the car now" is a fact about
-- the group's shared property, with no author to misrepresent.
--
-- ── FULL-SET on the RPC, NULL-PRESERVING on the mirror ─────────────────────────
-- The two writers deliberately do NOT share semantics, because they are answering
-- different questions:
--
--   • set_vehicle_location writes BOTH columns on every call — null means CLEARED.
--     The client prefills the sheet with the current values, so the call means "here
--     is where the car is now", not "patch this one field". A coalescing version
--     could never clear a parking spot that is no longer true, which is migration
--     164's own argument for the handover being a full replace.
--   • the handover mirror writes only what the HANDOVER CARRIES. A handover whose
--     parking field was left blank must not erase the car's known parking spot: the
--     driver skipped a field on a form about their booking, they did not assert that
--     nobody knows where the car is. So for each of the two fields: non-null
--     mirrors, null leaves the ledger column exactly as it was. That property is
--     pinned in tools/test-booking-handover-contract.mjs and in the role matrix,
--     because a mutation to a plain assignment would look completely ordinary in a
--     diff and would quietly wipe the car's location on every partial handover.
--
-- Both stamp location_updated_by_member_id and location_updated_at, so the UI can say
-- "Bo, i går kl. 18.42" — which is what makes a location believable. The mirror
-- stamps only when it actually wrote something.
--
-- ── GDPR: the same free-text-no-coordinates posture as migration 164 ───────────
-- Where a shared car is parked, and where its keys are kept, is location data about
-- the group's members — a home street, a workplace car park, a named person's
-- hallway. These columns carry exactly the class of data booking_handovers already
-- carries, and they carry it under exactly the same rules:
--
--   1. FREE TEXT, capped at 200 chars, with NO coordinate columns. Data minimisation,
--      and also simply what the use case needs: a group of four needs "P-kælder
--      niveau 2, plads 14" or "nøgler i postkassen hos Lars", never a lat/lng pair. A
--      coordinate would be more precise, more sensitive and less useful. The platform
--      has DROPPED coordinates twice (migration 151 for fuel stations, 062/071 for
--      user GPS on fuel logs); it is not adding them back for a parking spot.
--   2. Lifetime = the workspace's lifetime. These are columns ON ledgers, so a
--      workspace purge takes them with the row itself — no cascade to arrange, no
--      age-based sweep. There is deliberately no retention window: the value IS the
--      car's current state, and an emptied one would just mean "nobody knows".
--   3. No new deletion step. location_updated_by_member_id points at a ledger_members
--      row, and delete_my_account rewrites that row in place (name to 'Slettet
--      medlem', email to null) exactly as it does for trips.driver_member_id and
--      every other retained membership reference. The two text columns are not nulled
--      on account deletion for migration 164's stated reason: they are facts about
--      the SHARED CAR that the remaining group needs to keep, and nulling them would
--      delete the group's only record of where their car is.
--   4. Never in a URL, a query string or a log line. Recorded in RoPA A2.

-- ── 1. The columns ─────────────────────────────────────────────────────────────
-- All four nullable: a workspace that has never recorded a location is the normal
-- starting state, and every existing row backfills to "unknown", which is the honest
-- value. Constraints are added by name rather than inline so a replay against an
-- existing column still installs them (migration 166's pattern).
alter table public.ledgers
  add column if not exists parking_location text;

alter table public.ledgers
  drop constraint if exists ledgers_parking_location_check;

alter table public.ledgers
  add constraint ledgers_parking_location_check check (
    parking_location is null or char_length(parking_location) <= 200
  );

alter table public.ledgers
  add column if not exists key_location text;

alter table public.ledgers
  drop constraint if exists ledgers_key_location_check;

alter table public.ledgers
  add constraint ledgers_key_location_check check (
    key_location is null or char_length(key_location) <= 200
  );

alter table public.ledgers
  add column if not exists location_updated_by_member_id uuid;

alter table public.ledgers
  drop constraint if exists ledgers_location_updated_by_member_id_fkey;

-- `on delete set null`, the convention every optional member reference on a surviving
-- row follows (trips.driver_member_id, vehicle_incidents.reporter_member_id,
-- settlement_events.actor_member_id). It is close to unreachable in practice — member
-- rows are anonymised in place rather than deleted — but if one ever does go, losing
-- the attribution must not take the car's location with it.
alter table public.ledgers
  add constraint ledgers_location_updated_by_member_id_fkey
    foreign key (location_updated_by_member_id)
    references public.ledger_members(id) on delete set null;

alter table public.ledgers
  add column if not exists location_updated_at timestamptz;

comment on column public.ledgers.parking_location is
  'Free text, max 200 chars: where the car is RIGHT NOW ("P-kaelder niveau 2, plads 14"). GVM-520. Written by set_vehicle_location (full set — null clears) and mirrored from upsert_booking_handover (null preserves). GDPR: personal-adjacent location data — it can be a member''s home street or workplace car park. Deliberately free text and NEVER coordinates (data minimisation; migrations 151 and 062/071 both DROPPED coordinates); never put it in a URL, a query string or a log line. Lifetime is the workspace''s: it dies with the ledgers row, with no age-based sweep.';

comment on column public.ledgers.key_location is
  'Free text, max 200 chars: where the car keys are RIGHT NOW ("noeglerne i postkassen hos Lars"). GVM-520. Same writers and the same GDPR posture as parking_location — personal-adjacent, free text by design, no coordinates, workspace lifetime.';

comment on column public.ledgers.location_updated_by_member_id is
  'The member who last stated where the car and keys are — set_vehicle_location''s caller, or the author of the handover that mirrored into these columns. Nullable and `on delete set null`; anonymisation rides the existing delete_my_account path, which rewrites the member row in place rather than deleting it. What makes a location believable is who said it and when, so the client shows this next to the value (GVM-520).';

comment on column public.ledgers.location_updated_at is
  'When the car''s parking/key placement was last stated (GVM-520). Stamped server-side by set_vehicle_location on every call, and by upsert_booking_handover only when the handover actually carried a location to mirror — a handover that mentions neither must not make a week-old spot look fresh.';

-- ── 2. The standalone writer ───────────────────────────────────────────────────
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
create or replace function public.set_vehicle_location(
  target_ledger_id text,
  parking_location_value text default null,
  key_location_value text default null,
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

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Vehicle location can only be updated by a member of this workspace' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Vehicle location updates need an active membership in this workspace' using errcode = '42501';
  end if;

  -- FULL SET: both columns are written every call. A null means the member cleared
  -- the field, and clearing a spot that is no longer true has to be possible.
  update public.ledgers l
     set parking_location = v_parking,
         key_location = v_keys,
         location_updated_by_member_id = v_actor_member_id,
         location_updated_at = now(),
         updated_at = now()
   where l.id = target_ledger_id
  returning l.location_updated_at into v_stamped_at;

  -- The feed carries the CLIENT's title, and the metadata deliberately carries only
  -- whether each field now holds a value — never the location text itself. A feed row
  -- is the widest audience a workspace has, and the free text is already one query
  -- away for every member who needs it; duplicating it into event metadata would
  -- spread personal-adjacent location data into a second store for no gain (GDPR data
  -- minimisation, the same reason the handover event carries only ids).
  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'vehicle_location_updated', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object(
        'parking_location_set', v_parking is not null,
        'key_location_set', v_keys is not null,
        'source', 'set_vehicle_location'
      )
    );
  end if;

  return jsonb_build_object(
    'ledger_id', target_ledger_id,
    'parking_location', v_parking,
    'key_location', v_keys,
    'location_updated_by_member_id', v_actor_member_id,
    'location_updated_at', v_stamped_at
  );
end;
$$;

revoke all on function public.set_vehicle_location(text, text, text, text, text) from public;
revoke all on function public.set_vehicle_location(text, text, text, text, text) from anon;
grant execute on function public.set_vehicle_location(text, text, text, text, text) to authenticated;

-- ── 3. upsert_booking_handover, re-declared off its migration 164 definition ───
-- Re-declared COMPLETELY off the newest prior definition (164 is the only migration
-- that has ever created it — 148's anon revoke came earlier and is restated below),
-- so nothing drifts in from an intermediate version. The signature is unchanged, so
-- create-or-replace suffices and no overload is left behind for PostgREST to trip on.
--
-- ONE behavioural change, at the end: after the handover row is saved, MIRROR what it
-- carries into ledgers.parking_location / key_location. Everything else — the write
-- gate, the trip-driver branch, the GV-421 precondition, the full-replace update, the
-- create-only feed event — is byte-identical to 164, and the header below is 164's
-- own, kept verbatim so the equivalence check (which diffs function bodies including
-- their comments) has nothing to say about it.
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
  if v_parking is not null or v_keys is not null then
    update public.ledgers l
       set parking_location = coalesce(v_parking, l.parking_location),
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
  '167_vehicle_current_location',
  'Where the car is RIGHT NOW — parking and key placement on the workspace row (GVM-520, slice 3 of the GVM-519 handover epic). Four nullable columns on public.ledgers: parking_location and key_location (text, each check-constrained to 200 chars), location_updated_by_member_id (FK to ledger_members, on delete set null) and location_updated_at. The workspace row already carries non-setting car state — tank_baseline_odometer/fraction/recorded_at from migration 092 are the precedent down to the recorded-at stamp. THIS REVERSES A POSITION MIGRATION 164 WROTE DOWN and says so rather than contradicting it quietly: 164 held that the car''s current parking lives in the newest handover row "and nowhere else", because two places holding one fact is how they drift. Overturned by owner decision 2026-08-04 for three reasons. (1) A handover hangs off a BOOKING, and the car moves without one constantly — shifted off a street-sweeping day, borrowed for twenty minutes, parked somewhere new after a wash — so the newest handover confidently states where the car was left LAST TIME A BOOKING ENDED, which on those days is simply wrong, and the next driver walks to the wrong street: the exact failure 164 set out to prevent. (2) The booking-less alternatives are worse, not better: a booking_handovers row with a null booking_id breaks the UNIQUE that makes a second save a correction and turns the table into an append-only location log, and a second table is the same thing renamed — both put MORE places in play than one pair of columns. (3) Drift is answered by DIRECTION: exactly one writer per direction, the handover mirrors INTO these columns and nothing ever copies back, so ledgers is the current state and booking_handovers is the history of what each driver reported — two different questions, not two copies of one fact. New RPC public.set_vehicle_location(target_ledger_id, parking_location_value, key_location_value, event_title, event_body), security definer with a pinned search_path, granted to authenticated with public and anon revoked explicitly (148 convention). It is gated on ACTIVE MEMBERSHIP, not on admin, and that is the decision: whoever moved the car is the only person who knows where it is and is usually not the admin — the standing any-member-attribution position the platform takes for every other fact about the shared car (trips, fuel stops, incidents), where the protection is that everyone can see and fix an entry rather than that one person owns the pen. A second member overwriting the first is CORRECT (the car moved again) and the role matrix pins it so, so that a later hardening to admin-only reads as the reversal it would be. upsert_booking_handover keeps its narrow gate (the booking''s member, the linked trip''s driver, or an admin) because a handover is one person''s ACCOUNT of a booking they held; "where is the car now" is a fact about shared property with no author to misrepresent. The two writers have deliberately DIFFERENT semantics. set_vehicle_location is FULL SET: both columns are written every call and null means CLEARED, because the client prefills the sheet with the current values, so the call means "here is where the car is now" — and a coalescing version could never clear a spot that is no longer true (164''s own argument for the handover being a full replace). The handover MIRROR is NULL-PRESERVING: for each field, non-null mirrors into the ledger column and null leaves it exactly as it was, because a driver who skipped the parking field on a form about their booking did not assert that nobody knows where the car is, and erasing it would leave the group with nothing where they had a spot. That property is pinned in tools/test-booking-handover-contract.mjs and in the role matrix, since a mutation to a plain assignment would look completely ordinary in a diff and would wipe the location on every partial handover. Both writers stamp location_updated_by_member_id and location_updated_at — the mirror only when it actually wrote something, so a handover carrying neither location cannot make a week-old spot look freshly confirmed — because who said it and when is what makes a location believable. The mirror runs on CREATE and EDIT alike, unlike the create-only feed event: a correction from niveau 2 to niveau 3 is exactly the case where the current location must follow. It lives in the RPC rather than in a trigger for migration 166''s reason — the RPC is already the table''s only writer (no write policy, no grant), so a trigger would add a mechanism without covering a path. upsert_booking_handover is re-declared COMPLETELY off its newest prior definition (164 is the only migration that has ever created it; 148 only revoked anon''s execute), signature unchanged so create-or-replace suffices and no overload is left for PostgREST to trip on, and byte-identical to 164 apart from the mirror block. NEW event_type ''vehicle_location_updated'', written by set_vehicle_location only when the caller supplies an event_title, classified FEED-VISIBLE in tools/ledger-event-visibility.mjs (GV-413) — the whole point is that the group learns the car moved. Its metadata carries only booleans saying whether each field now holds a value, plus the source, and NEVER the location text: a feed row is the widest audience a workspace has, and copying personal-adjacent location data into a second store buys nothing when every member can already read the column. The guard messages are English and deliberately distinctive (govehlo-mobile maps guard text to Danish copy by matching it, and forty existing guards already open with "Only ledger members can"): ''Vehicle location updates need a workspace id'' (22023), ''Where the car is parked must be 200 characters or fewer'' (22023), ''Where the keys are kept must be 200 characters or fewer'' (22023), ''Vehicle location can only be updated by a member of this workspace'' (42501) and ''Vehicle location updates need an active membership in this workspace'' (42501). No advisory lock (a single-statement UPDATE of one row needs none — the handover''s lock protects a read-decide-write sequence this has not) and no GV-421 token, deliberately: preconditions protect a form somebody is editing, and refusing the newest statement of where the car is because somebody else also moved it would be backwards. GDPR: identical posture to migration 164 — FREE TEXT capped at 200 chars with NO coordinate columns (data minimisation; a group needs "P-kaelder niveau 2, plads 14", not geodata, and the platform has DROPPED coordinates twice in 151 and 062/071), never in a URL, query string or log line; lifetime is the workspace''s because these are columns ON ledgers, with no age-based sweep since the value IS the current state; and no new deletion step, because location_updated_by_member_id points at a ledger_members row that delete_my_account rewrites in place, exactly as for trips.driver_member_id. The two text columns are not nulled on account deletion for 164''s stated reason: they are facts about the SHARED CAR the remaining group needs to keep. Recorded in RoPA A2. MERGE ORDER: PostgREST rejects a call to a function that does not exist (PGRST202), so this must be applied in production BEFORE govehlo-mobile''s GVM-520 half ships.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

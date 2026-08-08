-- Migration 189: a handover cannot be observed in the future (GVM-557)
--
-- ── THE GAP (owner review, 2026-08-08) ───────────────────────────────────────
-- Nothing stops a handover from being written while its booking is still running — or
-- before it has even started. That is partly by design (you hand the car over minutes
-- BEFORE the scheduled end all the time, and offline flows arrive late), but migration
-- 182 stamps observed_at with the booking's SCHEDULED end unconditionally, so a handover
-- written early carries a FUTURE observed_at. A future stamp (1) wins the "latest
-- handover" ordering, (2) re-anchors the fuel model immediately, and (3) BLOCKS every
-- other handover's re-anchor until that future moment passes — migration 186's
-- latest-only guard compares observed_at, so a handover on a booking ending next Sunday
-- locks the re-anchor for the whole week. Secondarily: editing the BOOKING's end after
-- its handover exists never restamped observed_at (182's trigger sits only on
-- booking_handovers), and the RPC accepted handovers on cancelled bookings (the client's
-- hiding was courtesy, not enforcement).
--
-- ── THE RULE ─────────────────────────────────────────────────────────────────
-- An observation cannot postdate the observer: observed_at := least(booking end, now()).
--   • Written AFTER the booking ended (the normal case, and every late offline upload):
--     end_at, exactly as migration 182 chose — belongs to the booking, not upload time.
--   • Written BEFORE the booking ends: NOW — the handover describes the car as it stands
--     at the moment it is written. No future stamps exist, so nothing can hold the
--     "latest" crown early or lock out the re-anchor.
-- Each save re-derives the stamp (BEFORE INSERT OR UPDATE, as before), so a later edit of
-- an early handover is a re-observation at edit time, still clamped by the booking end.
--
-- Three companions:
--   1. BACKFILL: any already-stored future observed_at is clamped through the same rule
--      (the touch-update runs the trigger, so one formula decides in all three places).
--   2. RESTAMP ON BOOKING EDIT: a booking's end_at can be corrected after its handover is
--      written (shortened on early return, extended on a late one). A new AFTER UPDATE
--      trigger on car_bookings touches the booking's handover so 182's BEFORE trigger
--      recomputes observed_at from the corrected end. The touch also re-fires the
--      re-anchor trigger (183/186/187), which is DESIRED — the ordering just changed, and
--      its guards re-decide from scratch.
--   3. CANCELLED BOOKINGS REFUSED: upsert_booking_handover now rejects a booking with
--      deleted_at set, making the server agree with what the client always showed.
--
-- WHAT IS DELIBERATELY NOT ADDED: a hard "no handover while the booking is active" block.
-- Handing the car over shortly before the scheduled end is the natural flow and must keep
-- working; with the clamp, an early handover is simply an honest "the car stands like
-- this NOW". The client half (GVM-557) hides the affordance for bookings that have not
-- STARTED, where a handover is meaningless.
--
-- ── GV-413 / GDPR ────────────────────────────────────────────────────────────
-- No ledger_event is written by any trigger here (handover_created already covers the
-- feed), so nothing to classify. No new column, no new category of data, recipient or
-- retention — observed_at keeps meaning "when the car was observed", now truthfully.

-- ── 1. the clamp: re-declared off migration 182 (its only prior definition), ────
--       byte-identical bar wrapping the derivation in least(..., now()).
create or replace function public.set_handover_observed_at()
returns trigger
language plpgsql
as $$
begin
  new.observed_at := least(
    coalesce(
      (select cb.end_at from public.car_bookings cb where cb.id = new.booking_id),
      new.created_at,
      now()
    ),
    now()  -- an observation cannot postdate the observer (GVM-557)
  );
  return new;
end;
$$;

-- ── 2. backfill: clamp any stored future stamp through the SAME trigger ─────────
-- The touch-update fires set_handover_observed_at_trg, so the formula above is the only
-- place the rule lives; it also re-fires the re-anchor, whose guards re-decide honestly.
update public.booking_handovers
   set observed_at = observed_at
 where observed_at > now();

-- ── 3. restamp when the booking's end is corrected ──────────────────────────────
-- security definer: the touch must reach booking_handovers regardless of which member's
-- booking edit fired it (upsert_car_booking is itself security definer, but the trigger
-- defends its own access rather than inheriting an assumption). Fully qualified for the
-- SQL ambiguity guard.
create or replace function public.restamp_handover_observed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The value written here is irrelevant: booking_handovers' BEFORE UPDATE trigger
  -- (set_handover_observed_at_trg, migration 182) recomputes observed_at from the
  -- booking's corrected end_at on every write. This touch only makes that happen.
  update public.booking_handovers bh
     set observed_at = bh.observed_at
   where bh.booking_id = new.id;
  return new;
end;
$$;

revoke all on function public.restamp_handover_observed_at() from public;
revoke all on function public.restamp_handover_observed_at() from anon;
revoke all on function public.restamp_handover_observed_at() from authenticated;

drop trigger if exists restamp_handover_observed_at_trg on public.car_bookings;
create trigger restamp_handover_observed_at_trg
  after update of end_at on public.car_bookings
  for each row
  when (old.end_at is distinct from new.end_at)
  execute function public.restamp_handover_observed_at();

-- ── 4. cancelled bookings take no handover ──────────────────────────────────────
-- upsert_booking_handover re-declared COMPLETELY off its newest prior definition
-- (migration 174; 182/183/186/187/188 did not touch it), byte-identical but for one
-- added guard after the booking-exists check and the comment above it. Signature
-- unchanged — create or replace, no PGRST203 hazard, no client change.

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

  -- A cancelled booking is history and takes no handover (GVM-557). The client has
  -- always hidden the affordance for a cancelled booking; this makes the server agree
  -- instead of accepting a write the UI could never have offered.
  if v_booking.deleted_at is not null then
    raise exception 'Bookingen er annulleret og kan ikke få en overdragelse.' using errcode = '22023';
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
  '189_handover_observed_at_clamp',
  'A handover cannot be observed in the future (GVM-557). Migration 182 stamps observed_at with the booking''s SCHEDULED end unconditionally, and nothing anywhere blocks writing a handover while the booking is running — or before it starts — so an early handover carried a FUTURE observed_at that (1) won the latest-handover ordering, (2) re-anchored the fuel model immediately and (3) BLOCKED every other handover''s re-anchor until that future moment passed (186''s latest-only guard compares observed_at): a handover on a booking ending next Sunday locked the re-anchor all week. Fix: set_handover_observed_at re-declared off 182 (byte-identical bar the clamp) as observed_at := least(coalesce(booking end_at, created_at, now()), now()) — written after the booking ended (the normal case and every late offline upload) keeps end_at exactly as 182 chose; written before, the stamp is NOW, because the handover describes the car as it stands when written; re-derived on every save as before, so a later edit of an early handover is a re-observation at edit time, still capped by the booking end. Companions: (a) backfill clamps any stored future stamp via a touch-update through the SAME trigger (one formula, three places; the touch re-fires the re-anchor, whose guards re-decide honestly); (b) new AFTER UPDATE OF end_at trigger restamp_handover_observed_at_trg on car_bookings (security definer fn, execute revoked from public/anon/authenticated) touches the booking''s handover so a corrected end restamps observed_at — 182''s trigger sits only on booking_handovers and never saw booking edits; (c) upsert_booking_handover re-declared COMPLETELY off its newest prior definition (174; byte-identical bar one added guard) now refuses a cancelled booking (deleted_at set) with 22023 "Bookingen er annulleret og kan ikke faa en overdragelse.", making the server agree with what the client always hid. DELIBERATELY NOT ADDED: a hard no-handover-while-active block — handing the car over shortly before the scheduled end is the natural flow; with the clamp an early handover is an honest "the car stands like this now". The client half hides the affordance for bookings that have not STARTED. All functions return trigger / signature unchanged, so types/database.ts moves only its header stamp; no ledger_event, nothing for GV-413; GDPR: no new data, recipient or retention — observed_at keeps meaning "when the car was observed", now truthfully. Depends on 182 (observed_at), 174 (newest upsert_booking_handover), 186/187 (the re-anchor guards this protects).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

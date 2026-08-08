-- Migration 191: review-hardening bundle — keyset registered-paths RPC, active
-- newsletter-job reader, no handover before booking start (GV-467 / GV-469 / GVM-561)
--
-- Three small, unrelated-by-table but related-by-origin changes from the external
-- review of 2026-08-08, bundled so production takes ONE manual SQL apply.
--
-- ── 1. GV-467 (P1): list_registered_storage_paths — keyset, not offset ────────
-- The storage-orphan sweep reads each bucket's REGISTERED paths before deleting
-- anything. Today it pages with OFFSET against a live table: a row deleted on an
-- earlier page mid-pagination shifts later rows up, one registered path can slide
-- past a page boundary unseen, the set still looks complete (short last page), and
-- the skipped path's LIVE photo is classified an orphan and deleted. Keyset paging
-- on storage_path is immune — a vanished row before the cursor shifts nothing — and
-- an RPC carries the cursor in the POST BODY, honouring the GV-389 rule that a
-- storage path (two identifiers) never appears in a request line. The table name is
-- allow-listed in a CASE, never interpolated. Duplicate-path rows (none today; both
-- tables hold unique paths) would be skipped by the strict '>' — harmless, the
-- consumer builds a Set. service_role only, like every hook-facing reader.
--
-- ── 2. GV-469: get_active_newsletter_send_job — the door 179 didn't open ──────
-- newsletter_send_jobs is deny-all even to service_role; the only reader takes a
-- campaign id. The console's re-attach (GV-460) therefore recovers the id from the
-- audit log — best-effort and 7-day-bounded, so a job whose audit write failed can
-- block new sends (55006) while being invisible. This RPC answers "is a send
-- running, and which one" directly: the newest pending/sending job, counts-only
-- (same deliberate omissions as get_newsletter_send_job: no cursor, no ceiling, no
-- operator email). Zero rows = nothing running. The endpoint keeps the audit path
-- as fallback for deploys older than this migration.
--
-- ── 3. GVM-561: upsert_booking_handover refuses a booking that hasn't started ──
-- GVM-557 hid the handover affordance for future bookings in the client; the RPC
-- still accepted them, and with 189's clamp a premature handover carries
-- observed_at = now() — the workspace's LATEST, able to re-anchor the model and
-- move the car's location from a modified client. Re-declared COMPLETELY off its
-- newest prior definition (189), byte-identical bar one added guard after the
-- cancelled check. Signature unchanged.
--
-- No ledger_event added anywhere (nothing for GV-413). GDPR: RPC 1 returns paths
-- only to the service-role sweep that already reads them; RPC 2 is counts +
-- marketing headline; guard 3 stores nothing new.

-- ── 1. GV-467 ─────────────────────────────────────────────────────────────────
create or replace function public.list_registered_storage_paths(
  p_table text,
  p_after text default null,
  p_limit integer default 1000
)
returns table(storage_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  -- Allow-list, never interpolate: the sweep names exactly two registered-path
  -- tables. Anything else is a caller bug and fails loudly.
  if p_table = 'fuel_payment_receipts' then
    return query
      select r.storage_path
        from public.fuel_payment_receipts r
       where r.storage_path > coalesce(p_after, '')
       order by r.storage_path asc
       limit v_limit;
  elsif p_table = 'vehicle_incident_photos' then
    return query
      select r.storage_path
        from public.vehicle_incident_photos r
       where r.storage_path > coalesce(p_after, '')
       order by r.storage_path asc
       limit v_limit;
  else
    raise exception 'Unknown registered-path table' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.list_registered_storage_paths(text, text, integer) from public;
revoke all on function public.list_registered_storage_paths(text, text, integer) from anon;
revoke all on function public.list_registered_storage_paths(text, text, integer) from authenticated;
grant execute on function public.list_registered_storage_paths(text, text, integer) to service_role;

-- ── 2. GV-469 ─────────────────────────────────────────────────────────────────
create or replace function public.get_active_newsletter_send_job()
returns table(
  campaign_id uuid,
  status text,
  headline text,
  total_recipients integer,
  sent_count integer,
  failed_count integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select j.id, j.status, j.headline, j.total_recipients, j.sent_count, j.failed_count,
         j.created_at
    from public.newsletter_send_jobs j
   where j.status in ('pending', 'sending')
   order by j.created_at desc, j.id desc
   limit 1;
end;
$$;

revoke all on function public.get_active_newsletter_send_job() from public;
revoke all on function public.get_active_newsletter_send_job() from anon;
revoke all on function public.get_active_newsletter_send_job() from authenticated;
grant execute on function public.get_active_newsletter_send_job() to service_role;

-- ── 3. GVM-561 ────────────────────────────────────────────────────────────────
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
  '191_review_hardening_bundle',
  'Review-hardening bundle (external review 2026-08-08; GV-467 / GV-469 / GVM-561). (1) list_registered_storage_paths(p_table, p_after, p_limit): keyset reader for the storage-orphan sweep''s registered set — OFFSET paging against a live table could skip one registered path when a row on an earlier page was deleted mid-pagination, and the skipped path''s LIVE photo then classified as orphan and deleted; keyset on storage_path is delete-immune and the cursor rides in the RPC POST body so no path ever appears in a request line (GV-389). Table name allow-listed in a CASE (fuel_payment_receipts / vehicle_incident_photos), never interpolated; limit clamped 1..1000; security definer, service_role only. (2) get_active_newsletter_send_job(): the newest pending/sending job (campaign_id + counts + headline, same deliberate omissions as get_newsletter_send_job — no cursor/ceiling/operator email), zero rows = nothing running; closes GV-460''s audit-log re-attach fragility (best-effort, 7-day window) with the door migration 179 deliberately did not open; security definer, service_role only. (3) upsert_booking_handover re-declared COMPLETELY off its newest prior definition (189), byte-identical bar one added guard after the cancelled check: a booking with start_at > now() takes no handover (22023, Danish) — GVM-557 hid the affordance client-side, and with 189''s clamp a premature handover would carry observed_at = now(), the workspace''s latest, able to re-anchor the fuel model from a modified client; signature unchanged, no PGRST203 hazard. No ledger_event anywhere, nothing for GV-413. GDPR: RPC 1 returns paths only to the service-role sweep that already reads them, RPC 2 is counts + marketing headline, guard 3 stores nothing. Depends on 179/180 (newsletter job model) and 189 (newest upsert_booking_handover).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

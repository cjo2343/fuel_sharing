-- Migration 164: the vehicle handover a driver leaves for the next one (GVM-529)
--
-- Slice 1 of the Vehicle Handover epic (GVM-519): the DATA MODEL only — one table,
-- one write RPC, the RLS posture and the feed event. No client calls any of this
-- yet; govehlo-mobile's sheet is slice 2 and ships after this SQL is applied.
--
-- ── What a handover is ─────────────────────────────────────────────────────────
-- When a booking ends, the person who had the car hands it over to the group: the
-- final odometer, how full the tank is, WHERE the car is parked, WHERE the keys
-- are, whether anything is wrong with it, a note to whoever drives next, and a
-- confirmation that the keys were actually returned. Today that conversation
-- happens in the chat, or does not happen at all, and the next driver walks to the
-- wrong street.
--
-- One handover per booking — the row is the handover, and saving again EDITS it
-- rather than appending a second one, which is why booking_id is UNIQUE and the RPC
-- is an upsert on it. A person correcting "P-kælder niveau 2" to "niveau 3" is
-- fixing the same fact, not recording a new event.
--
-- ── The car's CURRENT parking and keys live HERE, and nowhere else ─────────────
-- GVM-520 will show "where is the car right now?" — that is the NEWEST handover row
-- for the workspace, read straight off this table (booking_handovers_ledger_recent_idx
-- exists for exactly that query). Deliberately NOT a pair of columns on `ledgers`
-- kept in sync by this RPC: two places holding the same fact is how they drift, and
-- the handover row already carries who said it and when, which a settings column
-- cannot.
--
-- ── Explicitly out of scope in this slice ──────────────────────────────────────
--   • Photos. They need client upload infrastructure (a bucket, signed uploads, the
--     storage-policy dance migration 138/139 went through) and get their own slice.
--   • The tank model. fuel_fraction is RECORDED here and fed to NOTHING: it does not
--     call set_tank_state and does not move ledgers.tank_state_*. The tank model
--     (migrations 155/156) is seeded from a baseline and self-heals on a full tank;
--     letting a free-hand gauge reading write into it would corrupt a running
--     balance with an eyeballed number. Reconciling the two is its own decision.
--
-- ── GDPR: parking and key locations are personal-adjacent, and are FREE TEXT ────
-- Where a shared car is parked, and where its keys are kept, is location data about
-- the group's members — a home street, a workplace car park, a named person's
-- hallway. Two deliberate choices:
--
--   1. FREE TEXT, no coordinate columns. Data minimisation, and it is also simply
--      what the use case needs: a group of four needs "P-kælder niveau 2, plads 14"
--      or "nøgler i postkassen hos Lars", not a lat/lng pair. A coordinate would be
--      more precise, more sensitive, and less useful. This is the same reasoning
--      migration 151 applied when it DROPPED fuel-station coordinates, and migration
--      062/071 when they dropped user GPS from fuel logs — the platform has removed
--      coordinates twice; it is not adding them back for a parking spot.
--   2. Lifetime = the workspace's lifetime. Every row hangs off ledgers(id) with
--      `on delete cascade`, so a workspace purge (operator decommission after the
--      90-day window, or the last active member deleting their account) takes the
--      whole class with it. There is no age-based retention: the newest row IS the
--      car's current state, and the older ones are the vehicle's history, which is
--      the same posture retention.md already records for vehicle_incidents.
--
-- Author anonymisation rides the EXISTING member-anonymisation path and needs no new
-- step in delete_my_account: author_member_id keeps pointing at the member row, and
-- delete_my_account (migration 138's definition) rewrites that row in place — name
-- to 'Slettet medlem', email to null. That is exactly how trips.driver_member_id and
-- every other retained membership reference is handled.
--
-- The four text fields are NOT nulled on account deletion, and that is a decision
-- rather than an oversight: unlike a trip note (the creator's words about their own
-- journey, which delete_my_account does null), a handover's parking spot, key
-- location and condition note are facts about the SHARED CAR that the group needs to
-- keep — nulling the newest row would delete the group's only record of where their
-- car currently is. note_to_next is authored prose and is the weakest case of the
-- four; it is retained with them because splitting one form across two retention
-- rules would be arbitrary, and because it dies with the workspace anyway. Written
-- down in docs/gdpr/retention.md and A2 of the RoPA so the position is auditable.

-- ── 1. The handover table ──────────────────────────────────────────────────────
-- Every field except keys_confirmed is NULLABLE on purpose. A handover is a form a
-- person fills in while standing in a car park in the rain: partial is normal, and
-- refusing to save "the car is at Nørre Allé, I did not read the odometer" would
-- push that information back into the chat. keys_confirmed is a boolean with a
-- default of false because "not confirmed" and "explicitly not returned" are the
-- same thing for the next driver.
create table if not exists public.booking_handovers (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  -- UNIQUE: one handover per booking. This is the upsert key, and it is what stops
  -- a retried save (or an offline replay) from stacking duplicate handovers on one
  -- booking, each with a different half of the truth.
  booking_id uuid not null unique references public.car_bookings(id) on delete cascade,
  -- `on delete cascade` matches messages.sender_member_id: member rows are
  -- anonymised in place rather than deleted (see the GDPR note above), so this only
  -- ever fires as part of a workspace-wide cascade.
  author_member_id uuid not null references public.ledger_members(id) on delete cascade,
  end_odometer integer check (end_odometer is null or end_odometer >= 0),
  -- A fraction, not a percentage and not litres: the client shows a gauge, and 0..1
  -- is what a gauge is. Inclusive at both ends — an empty tank and a full tank are
  -- both real readings.
  fuel_fraction numeric check (fuel_fraction is null or (fuel_fraction >= 0 and fuel_fraction <= 1)),
  parking_location text check (parking_location is null or char_length(parking_location) <= 200),
  key_location text check (key_location is null or char_length(key_location) <= 200),
  condition_ok boolean,
  condition_note text check (condition_note is null or char_length(condition_note) <= 500),
  note_to_next text check (note_to_next is null or char_length(note_to_next) <= 500),
  keys_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.booking_handovers is
  'Vehicle handover at the end of a booking (GVM-529): final odometer, fuel level, where the car is parked, where the keys are, a condition check, a note to the next driver, and whether the keys were returned. One row per booking (booking_id is unique) — a second save EDITS it. GDPR: parking_location and key_location are personal-adjacent location data about the group''s members and are stored as FREE TEXT on purpose — no coordinate columns, because a small group needs "P-kaelder niveau 2, plads 14" rather than geodata (data minimisation; the same reasoning migrations 151 and 062/071 used when they DROPPED coordinates). Retention is the workspace''s lifetime: every row hangs off ledgers(id) on delete cascade and dies with a workspace purge, with no age-based sweep, because the newest row IS the car''s current state. Author anonymisation rides the existing member-anonymisation path in delete_my_account — author_member_id keeps pointing at the member row, which that function rewrites in place.';

comment on column public.booking_handovers.parking_location is
  'Free text, max 200 chars: where the car was left ("P-kaelder niveau 2, plads 14"). GDPR: personal-adjacent location data — it can be a member''s home street or workplace car park. Deliberately free text and never coordinates (data minimisation, GVM-529); never put it in a URL or a log line. Lifetime is the workspace''s; purged by the ledgers cascade.';

comment on column public.booking_handovers.key_location is
  'Free text, max 200 chars: where the keys were left ("noeglerne i postkassen hos Lars"). Same GDPR posture as parking_location — personal-adjacent, free text by design, workspace lifetime, purged by the ledgers cascade.';

comment on column public.booking_handovers.fuel_fraction is
  'Tank level as a fraction 0..1 inclusive, as read off the gauge. RECORDED ONLY (GVM-529): nothing feeds this into the tank model (migrations 155/156) — set_tank_state is not called and ledgers.tank_state_* does not move. An eyeballed gauge reading must not overwrite a running litre balance; reconciling the two is its own decision.';

-- "What is the newest handover in this workspace?" is the query behind the car's
-- current parking spot and key location (GVM-520), so it gets its own index rather
-- than a sequential scan that grows with the group's history.
create index if not exists booking_handovers_ledger_recent_idx
  on public.booking_handovers (ledger_id, created_at desc, id);

alter table public.booking_handovers enable row level security;

-- SELECT for the workspace's members — the whole point of a handover is that the
-- NEXT driver reads it, and that is any member, not just the two people involved.
drop policy if exists "Ledger members can read booking handovers"
  on public.booking_handovers;
create policy "Ledger members can read booking handovers"
  on public.booking_handovers
  for select
  using (public.is_ledger_member(ledger_id));

-- No INSERT/UPDATE/DELETE policy exists, and none is coming: every write goes
-- through upsert_booking_handover below, so the identity gate is enforced in ONE
-- place no matter which client (or raw PostgREST call) attempts the write. Migration
-- 138's incident posture, for the same reason.
revoke all on table public.booking_handovers from public;
revoke all on table public.booking_handovers from anon;
revoke all on table public.booking_handovers from authenticated;
revoke all on table public.booking_handovers from service_role;
grant select on table public.booking_handovers to authenticated;
grant select on table public.booking_handovers to service_role;

-- ── 2. The write RPC ───────────────────────────────────────────────────────────
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
  '164_booking_handovers',
  'Vehicle handover data model (GVM-529, slice 1 of the GVM-519 epic): the table, the write RPC and the feed event, with no client caller until the mobile sheet ships in slice 2. public.booking_handovers records what the driver leaves for the next one at the end of a booking — end_odometer, fuel_fraction, parking_location, key_location, condition_ok/condition_note, note_to_next and keys_confirmed — one row per booking (booking_id UNIQUE), so a second save EDITS the handover rather than stacking a duplicate. Every field but keys_confirmed is nullable on purpose: a handover is filled in standing in a car park, and refusing a partial one would push the information back into the chat. Length checks (200 on the two locations, 500 on the two notes) and 0..1 on fuel_fraction are enforced BOTH as table constraints and in the RPC, the latter with Danish 22023 sentences. RLS is on with SELECT for the workspace''s members and NO write policy at all — every write goes through public.upsert_booking_handover, security definer with a pinned search_path, so the identity gate lives in one place no matter which client or raw PostgREST call attempts it. Who may write: the booking''s own member, the driver of the trip linked to that booking through migration 123''s durable booking→trip link (trips.booking_id, deleted_at is null), or a workspace admin; anyone else gets 42501 with a Danish sentence. The trip-driver branch is narrower than it looks and the header says so rather than overselling it: migration 123''s enforce_trip_booking_scope trigger already forces a linked trip''s driver to equal the booking''s member, so the first branch covers them at the moment the trip is written. The branch exists because that equality is enforced on the TRIP and never re-checked when car_bookings.member_id is REASSIGNED (which GV-253 lets an admin or the booking''s creator do) — after a reassignment the person who actually drove and parked the car would otherwise be locked out of describing where they left it. The contract test drives that exact sequence. That is a WRITE gate only — every member reads the handover, which is the entire point of the feature. An update REPLACES every field rather than coalescing, because the client posts the whole sheet and a coalescing update could never CLEAR a wrong parking spot. One advisory lock per booking, hashtext(ledger || '':handover:'' || booking_id), its own infix so it cannot collide with migration 063''s '':booking:'' or 162''s '':bookingcap:''. The LAST parameter is expected_updated_at with migration 160''s exact GV-421 semantics — null or absent is last-write-wins, a token against a row that does not exist yet is ignored because a create cannot conflict, and a stale token on an existing row raises errcode GV42O (O for Overdragelse, joining GV42T/GV42F/GV42B) with a Danish sentence saying the changes were NOT saved, writing nothing at all. Both sides truncate to milliseconds (a token through a JavaScript Date has lost its microseconds) and compare with `is distinct from`; the guard sits after every permission gate and before the write. Payload validation runs ahead of the membership lookup, following migration 162, since it judges only values the caller sent. The feed event ''handover_created'' is written on CREATE ONLY — a handover is news, the third correction to a parking spot is not — and is classified FEED-VISIBLE in tools/ledger-event-visibility.mjs. GDPR: parking_location and key_location are personal-adjacent location data (a home street, a workplace car park) and are stored as FREE TEXT with no coordinate columns, deliberately — a group of four needs "P-kaelder niveau 2, plads 14", not geodata, and the platform has already DROPPED coordinates twice (migrations 151 and 062/071). Retention is the workspace''s lifetime with no age-based sweep, purged by the ledgers cascade; author anonymisation rides the existing member-anonymisation path in delete_my_account (author_member_id keeps pointing at the member row, which that function rewrites in place), so no new deletion step is needed. Recorded in docs/gdpr/retention.md and RoPA A2. Out of scope here and stated so the omissions are not read as oversights: photos (they need client upload infrastructure and get their own slice) and the tank model — fuel_fraction is RECORDED and fed to nothing, because an eyeballed gauge reading must not overwrite the running litre balance migrations 155/156 maintain. Contract test: tools/test-booking-handover-contract.mjs; role-matrix cases cover member/stranger reads, the direct-write refusals and every write path per role.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

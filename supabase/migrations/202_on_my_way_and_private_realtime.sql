-- Migration 202: "Jeg er på vej" (GVM-238 P0) + private Realtime presence (GVM-575)
--
-- Two independent changes, deliberately in one migration because they are the two
-- halves of the same product moment — the group wants to know who is coming and who is
-- here — and because they land in the same prod apply window ahead of the same mobile
-- PR. Part 3 folds in a review finding on two OLDER photo RPCs (see below), which is
-- unrelated to either but must not wait behind them.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1 — GVM-238 P0: "Jeg er på vej"
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- ── What the owner decided on 2026-08-10, and what was cut ────────────────────
-- GVM-238 started as a live location map and was SCOPED DOWN to a single share: the
-- driver of the active booking taps once, the PHONE computes an ETA from its own
-- position, and ONLY THE DERIVED MINUTES are sent. No coordinate is transmitted, none
-- is stored, and there is no server-side geo processing of any kind. That is the whole
-- feature, and the shape of this migration is the enforcement of it rather than a
-- promise about it (see the CHECK constraint below).
--
-- Refinement from the same decision: the ETA REFRESHES while the app is foregrounded
-- (roughly every five minutes), so one share is a SEQUENCE of writes, not a single
-- one. Everything about the event design below follows from that — a feature that
-- writes a feed row per refresh would put eight "Bo er på vej" entries in the group's
-- Activity feed for one drive home.
--
-- Auto-stop is the client's job (booking end, arrival, manual stop) and
-- clear_on_my_way is the one endpoint all three use. Staleness is shown honestly on
-- the receiving side ("opdateret for 8 min siden"), which is why updated_at is part of
-- the stored shape rather than something a reader has to infer.
--
-- ── The stored shape, and why the RPC constructs it ───────────────────────────
-- car_bookings.on_my_way is a nullable jsonb holding EXACTLY three keys:
--
--     {"eta_minutes": <int 1..600>, "started_at": <ts>, "updated_at": <ts>}
--
--   • eta_minutes — whole minutes, computed on the device. Bounded 1..600 (ten hours):
--     below 1 there is nothing to share, and above ten hours the number is a bug, not
--     a drive.
--   • started_at  — when THIS share began. Preserved verbatim across every refresh, so
--     the receiving client can say how long someone has been on their way.
--   • updated_at  — when the minutes were last recomputed. This is the honesty field:
--     the reader renders staleness from it, and it is what makes a five-minute refresh
--     cadence safe to display.
--
-- NO COORDINATE KEY EVER. Not latitude, not longitude, not accuracy, not a geohash,
-- not a place name. This is enforced three ways, not one:
--
--   (a) set_on_my_way takes eta_minutes as a SCALAR integer and BUILDS the jsonb
--       server-side. It does not accept a jsonb blob from the client, so there is no
--       parameter a future client could smuggle a position through.
--   (b) A table CHECK constraint pins the key set to exactly those three names, the
--       types of all three, and the numeric bounds. This one is load-bearing rather
--       than belt-and-braces: car_bookings has a REAL update policy for authenticated
--       (migration 005 — the booking's member, its creator or an admin may UPDATE the
--       row directly through PostgREST), so without the constraint any of those three
--       could PATCH a coordinate into this column without going near the RPC.
--   (c) The two ledger_events rows carry ids and minutes only.
--
-- ── updated_at is deliberately NOT bumped ─────────────────────────────────────
-- Neither RPC touches car_bookings.updated_at, and that is a decision rather than an
-- omission. Migration 160 (GV-421) made car_bookings.updated_at an OPTIMISTIC
-- CONCURRENCY TOKEN: upsert_car_booking refuses an edit whose expected_updated_at no
-- longer matches, with GV42T/GV42F/GV42B. A share that refreshes every five minutes
-- would move that token every five minutes, so every other member holding a loaded
-- booking sheet would be told "bookingen blev ændret" — by a driver who changed
-- nothing about the booking. An ETA share is ephemeral intent ABOUT a booking, not an
-- edit OF one, so it leaves the booking's own version alone.
--
-- ── Who may share, and why admin is not on the list ───────────────────────────
-- set_on_my_way is gated to the booking's MEMBER or its CREATOR. It deliberately does
-- NOT reuse public.can_manage_car_booking (migration 002), which is the same pair PLUS
-- a workspace admin: that helper answers "who may edit this booking", and an admin
-- editing someone's booking window is a reasonable escape hatch, whereas an admin
-- announcing that ANOTHER PERSON is on their way is a statement about where that
-- person is. The share is personal; it is not administrable.
--
-- clear_on_my_way DOES allow the admin, and therefore DOES use can_manage_car_booking:
-- clearing is the escape hatch for a share stuck on by a crashed or uninstalled client,
-- it removes information rather than asserting any, and the alternative is a stale
-- "Bo er på vej" the group cannot get rid of.
--
-- ── Events: one feed row per SHARE, audit rows per refresh (GV-413) ───────────
-- Every call writes exactly one ledger_events row, because a write that reaches no
-- other client is invisible until the next manual refresh (the migration 087 lesson —
-- cross-client live sync IS the event insert). But only the FIRST call of a share is
-- news:
--
--   • on_my_way_started — FEED-VISIBLE. Written on the first call of a share, with the
--     client's own event_title/event_body (migrations 051/052 pattern), so the sentence
--     is composed where the names and the locale live. Registered in
--     FEED_VISIBLE_EVENT_TYPES.
--   • on_my_way_updated — AUDIT ONLY. Written by every refresh, and also by a first
--     call that supplied no title (a caller that wants no feed row still gets live
--     sync). Server-authored Danish title because ledger_events.title is NOT NULL;
--     nothing renders it. Registered in EVENT_TYPE_EXCLUDE.
--   • on_my_way_stopped — AUDIT ONLY. Written when a live share is cleared, so the
--     other clients drop the badge immediately. Registered in EVENT_TYPE_EXCLUDE.
--
-- MERGE-ORDER CONSEQUENCE, stated so it is not read as a bug: EVENT_TYPE_EXCLUDE is
-- mirrored ORDER-SENSITIVELY between tools/load-rehearsal/lib/hotpaths.mjs and
-- govehlo-mobile's ledger-data-gateway.ts, and check-hotpath-mirror.mjs only runs in
-- the umbrella workflow (the only CI that checks out all three repos). This migration
-- appends the two audit types on the platform side; the gateway's matching append lands
-- in the mobile PR. The umbrella is RED between the two merges, by construction. Until
-- the mobile half lands, an unfiltered client would show "Forventet ankomst opdateret"
-- rows in the feed — which is exactly the leak GV-413 exists to prevent, and exactly
-- why the two appends must be sequenced rather than skipped.
--
-- ── GDPR ──────────────────────────────────────────────────────────────────────
-- Recorded in docs/gdpr/ropa.md. The short version: the phone processes position
-- locally and the platform receives a DERIVED DURATION. No coordinate is transmitted or
-- stored at any point, so the existing "ingen løbende sporing" claim on the privacy
-- page is untouched — there is no position for anyone, including us, to process, and no
-- history to build. The state is ephemeral by construction (cleared at stop, and gone
-- with the booking), and the three event rows carry only a booking id and a minute
-- count and expire with ledger_events' own 30-day sweep.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 2 — GVM-575: the presence channel is public
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- THE BUG. govehlo-mobile's src/store/use-ledger-realtime.ts opens
-- `supabase.channel('presence-' || ledgerId, { config: { presence: { key: memberId } } })`
-- — a PUBLIC channel. Supabase Realtime does not consult any policy for a public
-- channel, so ANY authenticated user who knows (or guesses) a workspace id can join
-- that topic and read the presence state: the member ids of everyone in that workspace
-- who currently has the app open. It is not a data-plane hole — no row is readable —
-- but it is an online/offline signal about named people, leaking across the workspace
-- boundary every other read in this schema enforces.
--
-- THE FIX, in three parts, only the first of which is SQL:
--   1. (here) RLS policies on realtime.messages authorising `presence-<ledger_id>` for
--      the workspace's own members.
--   2. (mobile PR, AFTER this is applied) the channel is opened with
--      `config: { private: true }`.
--   3. (OPERATOR, in the Supabase dashboard) Realtime Settings → turn OFF "Allow public
--      access". See the warning below; without step 3 the hole is still open.
--
-- ── What the Supabase contract actually is (verified 2026-08-10 against ─────────
-- ── supabase.com/docs/guides/realtime/authorization) ──────────────────────────
--   • Broadcast and Presence authorization is expressed as ordinary RLS policies on the
--     table `realtime.messages`.
--   • `realtime.topic()` is the accessor: it returns the channel topic the client is
--     attempting to join. The topic is a plain string; there is no ledger column.
--   • `realtime.messages.extension` carries the message class — 'presence' or
--     'broadcast'. Presence needs BOTH a SELECT policy (receive presence state) and an
--     INSERT policy (track/untrack yourself). Read-only would leave the client able to
--     see the room and never appear in it.
--   • RLS is ENABLED BY DEFAULT on realtime.messages. The docs say so explicitly —
--     "you don't need to execute ALTER TABLE realtime.messages ENABLE ROW LEVEL
--     SECURITY" — so this migration does not, and deliberately: that statement needs
--     ownership of a table owned by supabase_realtime_admin, and issuing it would be a
--     failure mode in the SQL Editor in exchange for nothing.
--   • Policies apply ONLY to channels the client opened with `private: true`. That is
--     what makes this migration NON-BREAKING to apply while the shipped mobile build
--     still opens a public channel: for a public channel Realtime never evaluates a
--     policy, so today's clients keep working unchanged, and the mobile flip can follow
--     at its own pace.
--
-- ⚠ THE PART THAT IS NOT CLOSED BY SQL. Because policies are only consulted for private
-- channels, a private-channel client does not by itself lock anyone out: an attacker
-- can simply open the SAME topic as a PUBLIC channel and still see the presence state.
-- Supabase's answer is a project-level switch — "Allow public access" in Realtime
-- Settings — and until an operator turns it off, GVM-575 is mitigated for our own
-- clients and NOT closed against a hostile one. This must be done AFTER the mobile
-- private:true build is the only build in the field, because disabling public access
-- breaks every client that has not flipped. Sequence: apply this SQL → ship mobile
-- private:true → force-upgrade past the old build → turn off public access.
--
-- ── Why left() and not LIKE, again ────────────────────────────────────────────
-- The topic is `presence-<ledger_id>` and a ledger id can contain '_', which LIKE reads
-- as a single-character wildcard — so `topic like 'presence-%'` is fine but
-- `topic like 'presence-' || id || '%'` is not, and the habit is what matters. The
-- prefix is matched with left(realtime.topic(), 9) = 'presence-' and the id is taken
-- with substring(realtime.topic() from 10): position 10 is the first character after
-- the nine-character literal. A topic that is exactly 'presence-' yields the empty
-- string, which is_ledger_member answers false for.
--
-- ── STORAGE-GUARD LESSON, APPLIED TO A SECOND SCHEMA ──────────────────────────
-- The `realtime` schema does not exist in a plain-Postgres container, and every
-- Docker-backed guard in this repo (schema equivalence, the role matrix, db-types)
-- replays into exactly that. So EVERY realtime.* statement below sits inside
-- `if exists (select 1 from information_schema.schemata where schema_name = 'realtime')`
-- and is issued through EXECUTE, so a plain replay never even PARSES a reference to
-- realtime.messages. This is migration 138's storage lesson applied to a second schema,
-- and the failure it avoids is identical: without the guard both replays abort and
-- every CI job in the repo goes red on a feature that has nothing to do with them.
--
-- CONSEQUENCE, stated plainly: the two policies are PROD-ONLY. Neither the role matrix
-- nor schema-equivalence can see them, so the contract test pins their TEXT in both the
-- migration and the consolidated schema instead — that is the only guard these two
-- objects will ever have, and it is why the test asserts the whole policy body rather
-- than its name.
--
-- ── Why is_ledger_member is callable from here ────────────────────────────────
-- Verified rather than assumed, because it is the one way this could fail closed for
-- everyone at once. A function referenced from an RLS policy is subject to an ordinary
-- EXECUTE privilege check against the ROLE RUNNING THE QUERY — confirmed empirically on
-- Postgres 17: with EXECUTE revoked, the read fails with "permission denied for
-- function", and it fails whether or not the table owner and the function owner are the
-- same role. Migration 083 revoked public.is_ledger_member(text) from PUBLIC and never
-- granted it to authenticated, so on the face of it this policy could not run.
--
-- It does, because in a real Supabase project `authenticated` holds an EXPLICIT execute
-- grant from the project's default privileges (`alter default privileges in schema
-- public grant execute on functions to anon, authenticated, service_role`), which
-- revoking from PUBLIC does not touch. Two independent confirmations: migration 148 had
-- to revoke this same function from anon EXPLICITLY, which would have been a no-op if
-- PUBLIC were the only source; and tools/test-rls-role-matrix.mjs installs those same
-- default privileges in its prelude precisely so its replay reproduces production's
-- grant state. No new grant is added here — adding one would contradict migration 083's
-- documented posture for auth helpers to fix a problem that does not exist.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 3 — review finding: photo ROW registration was uncapped
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found in the external review of migration 201 and verified against both bodies. The
-- per-folder cap on incident photos and document pages is enforced ONLY by
-- public.enforce_storage_upload_quota (migration 184), a BEFORE INSERT trigger on
-- storage.objects. That caps OBJECTS. It does not cap ROWS, and the two are registered
-- separately: add_incident_photo / add_vehicle_document_photo insert a row given a
-- path, and neither counts anything. So a member can register an unbounded number of
-- rows — including rows whose path has no object behind it at all, which the trigger by
-- definition never sees.
--
-- Blast radius is small but real: unbounded rows in a members-readable table, a
-- document or incident whose page list is arbitrarily long in every client that renders
-- it, and a registered-path list the govehlo-web orphan sweep must page through. The
-- fix is the shape create_vehicle_document already uses for its 50-document cap and
-- that migration 184 argued for at length: a transaction-scoped advisory lock keyed on
-- the PARENT entity, the count taken UNDER that lock, and a refusal at the limit. A
-- plain count-then-insert would be the same check-then-insert race 184 exists to close.
--
-- Each row cap equals its bucket's object cap, so the two agree instead of racing:
-- 5 pages per document, 10 photos per incident (migration 184's limits, unchanged).
--
-- ── Ancestry (the GV-202 newest-prior-definition rule) ────────────────────────
--   • public.add_vehicle_document_photo(uuid, text) — re-declared off migration 201
--     (its only prior definition; chain 201 → 202), byte-identical apart from the lock,
--     the count and the refusal.
--   • public.add_incident_photo(uuid, text) — re-declared off migration 138 (verified as
--     the newest prior definition: 148 only revokes from anon, and nothing between 139
--     and 201 re-declares it; chain 138 → 202), byte-identical apart from the same three
--     additions. Its EXISTING error sentences are English and are preserved verbatim —
--     re-declaring is not licence to retranslate a function's whole vocabulary — while
--     the ONE new sentence follows the current Danish convention. The mismatch is
--     deliberate and is the smaller of the two evils.
--
-- Neither signature moves, so create-or-replace is enough: no DROP, no restated ACLs,
-- no PGRST202/203 window, and no client build can be stranded. The ACL block is
-- restated anyway with anon named explicitly, per migration 148's convention.
--
-- ── What this migration does NOT change ───────────────────────────────────────
-- No change to delete_my_account: on_my_way holds no member reference at all (it is
-- three scalars), and the two photo RPCs' created_by_member_id pointers are already
-- covered by the in-place member anonymisation, exactly as migrations 169 and 201
-- documented. No retention rule: on_my_way dies with its booking and the event rows
-- with ledger_events' 30-day expiry. No storage change, no bucket, no new table.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. GVM-238 P0 — the column, the shape constraint, and the two RPCs
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.car_bookings
  add column if not exists on_my_way jsonb;

-- The "never a coordinate" promise as a constraint rather than a comment. car_bookings
-- has a real UPDATE policy for authenticated (migration 005), so the booking's member,
-- its creator and any workspace admin can PATCH this column directly through PostgREST
-- without going near set_on_my_way. This is what stops them putting a position in it.
--
-- Exactly three keys, all three required, no others tolerated: `?&` demands all three
-- are present and `on_my_way - array[...] = '{}'::jsonb` demands nothing else is. Types
-- are pinned with jsonb_typeof and the bounds are compared as jsonb literals rather
-- than cast to numeric, so every operator in here is immutable (a CHECK constraint
-- cannot contain a subquery, which also rules out the jsonb_object_keys formulation).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'car_bookings_on_my_way_shape_check'
  ) then
    alter table public.car_bookings
      add constraint car_bookings_on_my_way_shape_check
      check (
        on_my_way is null
        or (
          jsonb_typeof(on_my_way) = 'object'
          and on_my_way ?& array['eta_minutes', 'started_at', 'updated_at']
          and on_my_way - array['eta_minutes', 'started_at', 'updated_at'] = '{}'::jsonb
          and jsonb_typeof(on_my_way -> 'eta_minutes') = 'number'
          and on_my_way -> 'eta_minutes' >= '1'::jsonb
          and on_my_way -> 'eta_minutes' <= '600'::jsonb
          and jsonb_typeof(on_my_way -> 'started_at') = 'string'
          and jsonb_typeof(on_my_way -> 'updated_at') = 'string'
        )
      );
  end if;
end $$;

-- ── set_on_my_way ───────────────────────────────────────────────────────────────
-- Start or refresh the driver's "jeg er på vej" share. One call = one write = one
-- event. The first call of a share writes the feed row; every refresh writes an
-- audit-only row so the other clients re-fetch without the feed filling up.
create or replace function public.set_on_my_way(
  target_ledger_id text,
  legacy_booking_id text,
  eta_minutes integer,
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
  v_booking public.car_bookings%rowtype;
  v_first boolean;
  v_started_at timestamptz;
  v_updated_at timestamptz := now();
  v_state jsonb;
begin
  -- Payload validation first (migration 162's order): these judge only what the caller
  -- sent, so they can be answered without looking anything up and they leak nothing
  -- about the workspace.
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Mangler workspace-id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Mangler booking-id' using errcode = '22023';
  end if;

  if eta_minutes is null then
    raise exception 'Mangler forventet ankomsttid' using errcode = '22023';
  end if;

  -- 1..600 minutes. Under a minute there is nothing to share; over ten hours the
  -- number came from a bug, not from a drive.
  if eta_minutes < 1 or eta_minutes > 600 then
    raise exception 'Forventet ankomst skal være mellem 1 og 600 minutter' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer af workspacet kan dele forventet ankomst' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kunne ikke matche brugeren med et aktivt medlem' using errcode = '42501';
  end if;

  -- Its own advisory-lock infix, so it cannot collide with migration 063's ':booking:',
  -- 162's ':bookingcap:' or 164's ':handover:'. Two refreshes racing from a reconnecting
  -- client must not interleave read-decide-write on started_at.
  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':onmyway:' || legacy_booking_id));

  select *
    into v_booking
  from public.car_bookings cb
  where cb.ledger_id = target_ledger_id
    and cb.legacy_id = legacy_booking_id
    and cb.deleted_at is null
  for update;

  if v_booking.id is null then
    raise exception 'Bookingen blev ikke fundet' using errcode = '22023';
  end if;

  -- The share is PERSONAL: the booked member or whoever created the booking, and NOT a
  -- workspace admin. public.can_manage_car_booking would include the admin, which is
  -- right for editing a booking and wrong for announcing that somebody else is on their
  -- way. clear_on_my_way is where the admin escape hatch lives.
  if v_actor_member_id is distinct from v_booking.member_id
     and v_actor_member_id is distinct from v_booking.created_by_member_id then
    raise exception 'Kun den, bookingen tilhører, eller den, der oprettede den, kan dele forventet ankomst'
      using errcode = '42501';
  end if;

  -- Active or upcoming only. A booking that is over cannot be arrived at, and a share
  -- on one would sit in the group's feed as a permanent falsehood.
  if v_booking.end_at <= now() then
    raise exception 'Bookingen er slut, så der er ikke noget at være på vej til' using errcode = '22023';
  end if;

  v_first := v_booking.on_my_way is null;

  -- started_at survives every refresh so the reader can say how long the drive has been
  -- running; the coalesce is the self-heal for a row whose value somehow went missing.
  if v_first then
    v_started_at := v_updated_at;
  else
    v_started_at := coalesce(
      nullif(v_booking.on_my_way ->> 'started_at', '')::timestamptz,
      v_updated_at
    );
  end if;

  -- Built HERE from scalars. There is no path by which a caller-supplied object reaches
  -- this column, which is what makes "no coordinate is ever stored" a property of the
  -- code rather than a rule someone has to remember.
  v_state := jsonb_build_object(
    'eta_minutes', eta_minutes,
    'started_at', v_started_at,
    'updated_at', v_updated_at
  );

  -- car_bookings.updated_at is NOT touched: migration 160 made it an optimistic
  -- concurrency token, and a five-minute refresh cadence would otherwise refuse every
  -- other member's booking edit with GV42T. See the header.
  update public.car_bookings cb
     set on_my_way = v_state
   where cb.id = v_booking.id;

  -- Exactly one event per call, because the event insert IS the cross-client live sync
  -- (migration 087). Feed row only for the first call of a share, and only when the
  -- client composed a sentence for it; everything else is audit-only.
  if v_first and event_title is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'on_my_way_started', event_title, coalesce(event_body, ''),
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', v_booking.id, 'eta_minutes', eta_minutes)
    );
  else
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id, 'on_my_way_updated', 'Forventet ankomst opdateret', '',
      v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('booking_id', v_booking.id, 'eta_minutes', eta_minutes)
    );
  end if;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_booking_id,
    'eta_minutes', eta_minutes,
    'started_at', v_started_at,
    'updated_at', v_updated_at,
    'first_share', v_first
  );
end;
$$;

revoke all on function public.set_on_my_way(text, text, integer, text, text) from public;
revoke all on function public.set_on_my_way(text, text, integer, text, text) from anon;
grant execute on function public.set_on_my_way(text, text, integer, text, text) to authenticated;

-- ── clear_on_my_way ─────────────────────────────────────────────────────────────
-- Stop the share. Called by the client on arrival, at booking end and on a manual stop,
-- so it must be IDEMPOTENT: a second stop is a no-op that returns cleared=false and
-- writes no event, because three auto-stop triggers racing each other is the normal
-- case, not the exceptional one.
--
-- Unlike set_on_my_way this DOES admit the workspace admin — via
-- public.can_manage_car_booking, the member/creator/admin helper — because clearing is
-- the escape hatch for a share left on by a crashed or uninstalled client, and it
-- removes information rather than asserting any.
--
-- Deliberately no `deleted_at is null` filter on the lookup: a cancelled booking with a
-- live share is precisely a case that needs clearing.
create or replace function public.clear_on_my_way(
  target_ledger_id text,
  legacy_booking_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_member_id uuid;
  v_booking public.car_bookings%rowtype;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Mangler workspace-id' using errcode = '22023';
  end if;

  if legacy_booking_id is null or legacy_booking_id = '' then
    raise exception 'Mangler booking-id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Kun medlemmer af workspacet kan stoppe delingen' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kunne ikke matche brugeren med et aktivt medlem' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(target_ledger_id || ':onmyway:' || legacy_booking_id));

  select *
    into v_booking
  from public.car_bookings cb
  where cb.ledger_id = target_ledger_id
    and cb.legacy_id = legacy_booking_id
  for update;

  if v_booking.id is null then
    raise exception 'Bookingen blev ikke fundet' using errcode = '22023';
  end if;

  if not public.can_manage_car_booking(v_booking.id) then
    raise exception 'Kun den, bookingen tilhører, den, der oprettede den, eller en administrator kan stoppe delingen'
      using errcode = '42501';
  end if;

  if v_booking.on_my_way is null then
    return jsonb_build_object(
      'booking_id', v_booking.id,
      'ledger_id', target_ledger_id,
      'legacy_id', legacy_booking_id,
      'cleared', false
    );
  end if;

  update public.car_bookings cb
     set on_my_way = null
   where cb.id = v_booking.id;

  -- Audit-only: the other clients need the nudge to drop the badge, and "Bo stoppede
  -- med at være på vej" is not a sentence any feed should contain.
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, 'on_my_way_stopped', 'Deling af ankomst stoppet', '',
    v_actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object('booking_id', v_booking.id)
  );

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'ledger_id', target_ledger_id,
    'legacy_id', legacy_booking_id,
    'cleared', true
  );
end;
$$;

revoke all on function public.clear_on_my_way(text, text) from public;
revoke all on function public.clear_on_my_way(text, text) from anon;
grant execute on function public.clear_on_my_way(text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. GVM-575 — RLS on realtime.messages for the presence channel
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- PROD-ONLY by construction: the whole block is inside the realtime-schema guard and
-- every statement goes through EXECUTE, so a plain-Postgres replay never parses a
-- reference to realtime.messages. RLS is already enabled on that table by Supabase, and
-- these policies are only ever consulted for channels opened with private: true — so
-- applying this changes nothing for the currently shipped mobile build.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    execute $pol$drop policy if exists "Ledger members can read workspace presence" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can read workspace presence"
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension = 'presence'
        and left(realtime.topic(), 9) = 'presence-'
        and public.is_ledger_member(substring(realtime.topic() from 10))
      )
    $pol$;

    execute $pol$drop policy if exists "Ledger members can track workspace presence" on realtime.messages $pol$;
    execute $pol$
      create policy "Ledger members can track workspace presence"
      on realtime.messages
      for insert
      to authenticated
      with check (
        realtime.messages.extension = 'presence'
        and left(realtime.topic(), 9) = 'presence-'
        and public.is_ledger_member(substring(realtime.topic() from 10))
      )
    $pol$;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Review finding — cap the photo ROWS, not just the storage objects
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── add_vehicle_document_photo — re-declared off migration 201 (chain 201 → 202) ──
-- 201 verbatim apart from the advisory lock, the count under it and the refusal. The
-- cap (5) is the same number migration 184's trigger enforces on the vehicle-documents
-- bucket, so the row list and the object list agree instead of drifting.
create or replace function public.add_vehicle_document_photo(
  p_document_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.vehicle_documents%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_photo_id uuid;
  v_existing integer;
begin
  if p_document_id is null then
    raise exception 'Mangler dokument-id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Mangler sti til filen' using errcode = '22023';
  end if;

  select * into v_document
  from public.vehicle_documents vd
  where vd.id = p_document_id;

  if v_document.id is null then
    raise exception 'Dokumentet blev ikke fundet' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_document.ledger_id) then
    raise exception 'Kun medlemmer af workspacet kan tilføje sider' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_document.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Kunne ikke matche brugeren med et aktivt medlem' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<document_id>/<token>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_document.ledger_id || '/' || p_document_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Filen skal ligge under dokumentets eget workspace og dokument-id' using errcode = '22023';
  end if;

  -- Cap the ROWS as well as the objects. Migration 184's trigger caps this bucket at 5
  -- OBJECTS, but nothing capped the registrations -- including registrations of a path
  -- with no object behind it, which that trigger by definition never sees. Serialise
  -- concurrent page adds for THIS document and count under the lock: a plain
  -- count-then-insert is the same check-then-insert race 184 was written to close.
  perform pg_advisory_xact_lock(hashtext('vehicle_document_photos:' || p_document_id::text));

  select count(*)
    into v_existing
    from public.vehicle_document_photos vdp
   where vdp.document_id = p_document_id;

  if v_existing >= 5 then
    raise exception 'Der er plads til højst 5 sider på et dokument' using errcode = '23514';
  end if;

  insert into public.vehicle_document_photos (
    document_id, ledger_id, storage_path, created_by_member_id
  ) values (
    p_document_id, v_document.ledger_id, p_storage_path, v_actor_member_id
  )
  returning id into v_photo_id;

  return jsonb_build_object(
    'photo_id', v_photo_id,
    'document_id', p_document_id,
    'ledger_id', v_document.ledger_id
  );
end;
$$;

revoke all on function public.add_vehicle_document_photo(uuid, text) from public;
revoke all on function public.add_vehicle_document_photo(uuid, text) from anon;
grant execute on function public.add_vehicle_document_photo(uuid, text) to authenticated;

-- ── add_incident_photo — re-declared off migration 138 (chain 138 → 202) ─────────
-- 138 verbatim apart from the same three additions. Its existing English sentences are
-- preserved word for word: re-declaring a function to add a cap is not licence to
-- retranslate its whole vocabulary, and a half-translated body would be worse than
-- either. The ONE new sentence is Danish, per the current convention. The cap (10) is
-- migration 184's incident-photos limit.
create or replace function public.add_incident_photo(
  p_incident_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident public.vehicle_incidents%rowtype;
  v_actor_member_id uuid;
  v_expected_prefix text;
  v_photo_id uuid;
  v_existing integer;
begin
  if p_incident_id is null then
    raise exception 'Missing incident id' using errcode = '22023';
  end if;

  if nullif(btrim(p_storage_path), '') is null then
    raise exception 'Missing storage path' using errcode = '22023';
  end if;

  select * into v_incident
  from public.vehicle_incidents vi
  where vi.id = p_incident_id;

  if v_incident.id is null then
    raise exception 'Incident was not found' using errcode = '22023';
  end if;

  if not public.is_ledger_member(v_incident.ledger_id) then
    raise exception 'Only ledger members can attach incident photos' using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(v_incident.ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Path convention: <ledger_id>/<incident_id>/<uuid>.<ext>. Compare the literal
  -- prefix (no LIKE -- ledger ids can contain '_', a LIKE wildcard).
  v_expected_prefix := v_incident.ledger_id || '/' || p_incident_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Storage path must live under the incident''s workspace/incident prefix' using errcode = '22023';
  end if;

  -- Cap the ROWS as well as the objects, for the reason spelled out on
  -- add_vehicle_document_photo above: migration 184's trigger caps this bucket at 10
  -- OBJECTS and nothing capped the registrations. Count under a transaction-scoped
  -- advisory lock keyed on the incident, never a bare count-then-insert.
  perform pg_advisory_xact_lock(hashtext('vehicle_incident_photos:' || p_incident_id::text));

  select count(*)
    into v_existing
    from public.vehicle_incident_photos vip
   where vip.incident_id = p_incident_id;

  if v_existing >= 10 then
    raise exception 'Der er plads til højst 10 billeder på en skade' using errcode = '23514';
  end if;

  insert into public.vehicle_incident_photos (
    incident_id, ledger_id, storage_path, created_by_member_id
  ) values (
    p_incident_id, v_incident.ledger_id, p_storage_path, v_actor_member_id
  )
  returning id into v_photo_id;

  return jsonb_build_object(
    'photo_id', v_photo_id,
    'incident_id', p_incident_id,
    'ledger_id', v_incident.ledger_id
  );
end;
$$;

revoke all on function public.add_incident_photo(uuid, text) from public;
revoke all on function public.add_incident_photo(uuid, text) from anon;
grant execute on function public.add_incident_photo(uuid, text) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '202_on_my_way_and_private_realtime',
  'Three things in one apply window. (1) GVM-238 P0 "Jeg er paa vej", SCOPED DOWN by the owner on 2026-08-10 from a live location map to a single derived share: the driver of the active booking taps once, the PHONE computes the ETA from its own position, and ONLY THE MINUTES are sent -- no coordinate is transmitted, stored or processed server-side, ever. New nullable car_bookings.on_my_way jsonb holding EXACTLY three keys, {"eta_minutes": int 1..600, "started_at": ts, "updated_at": ts}: started_at survives every refresh so a reader can say how long the drive has been running, and updated_at is the honesty field the receiving client renders staleness from ("opdateret for 8 min siden"), which is what makes the ~5-minute foreground refresh cadence safe to display. The no-coordinate rule is enforced THREE ways rather than promised: set_on_my_way takes eta_minutes as a SCALAR and BUILDS the jsonb server-side (there is no parameter to smuggle a position through), a table CHECK constraint car_bookings_on_my_way_shape_check pins the key set to exactly those three names plus their types and bounds -- load-bearing rather than belt-and-braces, because migration 005 gives authenticated a real UPDATE policy on car_bookings so the member/creator/admin could otherwise PATCH a coordinate straight in -- and the event rows carry ids and minutes only. set_on_my_way(text, text, integer, text default null, text default null) is gated to the booking''s MEMBER or CREATOR and deliberately NOT to public.can_manage_car_booking, which would add the workspace admin: that helper answers "who may edit this booking", and an admin announcing that ANOTHER PERSON is on their way is a statement about where that person is. Booking must exist, be un-deleted and not have ended; eta bounded 1..600 with Danish 22023 copy. clear_on_my_way(text, text) DOES admit the admin (it uses can_manage_car_booking) because clearing is the escape hatch for a share stuck on by a crashed client and it removes information rather than asserting any, takes no deleted_at filter (a cancelled booking with a live share is exactly the case needing a clear), and is IDEMPOTENT -- a second stop returns cleared=false and writes nothing, since three auto-stop triggers racing (arrival, booking end, manual) is the normal case. Both take their own advisory-lock infix '':onmyway:'' so they cannot collide with 063''s '':booking:'', 162''s '':bookingcap:'' or 164''s '':handover:''. NEITHER TOUCHES car_bookings.updated_at, and that is a decision: migration 160 made that column an optimistic-concurrency token, so a five-minute refresh cadence would refuse every other member''s booking edit with GV42T for a driver who changed nothing about the booking. EVENTS (GV-413): exactly one ledger_events row per call, because the event insert IS the cross-client live sync (migration 087 lesson), but only the first call of a share is news -- on_my_way_started is FEED-VISIBLE with the client''s own title/body (051/052 pattern) and is registered in FEED_VISIBLE_EVENT_TYPES, while on_my_way_updated (every refresh, and a first call with no title) and on_my_way_stopped are AUDIT-ONLY, server-titled because ledger_events.title is NOT NULL, and are APPENDED LAST to EVENT_TYPE_EXCLUDE in tools/load-rehearsal/lib/hotpaths.mjs. Metadata is booking_id plus eta_minutes and nothing else. The matching order-sensitive append to govehlo-mobile''s ledger-data-gateway ships in the mobile PR, so check-hotpath-mirror.mjs is red in the umbrella between the two merges by construction. (2) GVM-575: govehlo-mobile opens presence-<ledgerId> as a PUBLIC channel, so any authenticated user who knows a workspace id can read which members currently have the app open -- not a data-plane hole, but an online/offline signal about named people crossing the workspace boundary every other read enforces. Two RLS policies on realtime.messages (SELECT to receive presence state and INSERT to track/untrack -- presence needs both, or a client sees the room and never appears in it), both gated on realtime.messages.extension = ''presence'' AND left(realtime.topic(), 9) = ''presence-'' AND public.is_ledger_member(substring(realtime.topic() from 10)); left() and substring() rather than LIKE because a ledger id can contain the ''_'' wildcard. VERIFIED AGAINST THE CURRENT SUPABASE CONTRACT (docs/guides/realtime/authorization, 2026-08-10): realtime.topic() is the topic accessor, extension carries ''presence''/''broadcast'', RLS is ENABLED BY DEFAULT on realtime.messages so this migration does NOT run an ALTER TABLE it lacks ownership for, and policies are consulted ONLY for channels opened with private: true -- which is what makes applying this NON-BREAKING while the shipped mobile build is still public, so the mobile flip can follow at its own pace. STATED PLAINLY BECAUSE SQL CANNOT CLOSE IT: since policies bind only private channels, an attacker can still open the same topic as a PUBLIC channel until an operator disables "Allow public access" in the project''s Realtime Settings -- a dashboard step that must come AFTER the private:true build is the only one in the field, or it breaks every client that has not flipped. Sequence: apply this SQL, ship mobile private:true, force-upgrade past the old build, then turn public access off. The whole realtime block sits inside an `if exists (information_schema.schemata where schema_name = ''realtime'')` guard and every statement is issued through EXECUTE, so a plain-Postgres CI replay never even parses a reference to realtime.messages -- migration 138''s storage lesson applied to a second schema. Consequence, accepted and named: the two policies are PROD-ONLY and invisible to both schema-equivalence and the role matrix, so the contract test pins their full TEXT in both the migration and the consolidated mirror, which is the only guard they will ever have. is_ledger_member is callable from an RLS policy because `authenticated` holds an EXPLICIT execute grant from Supabase''s default privileges (migration 083 revoked only PUBLIC, which is also why 148 had to revoke this same function from anon explicitly, and why the role matrix''s prelude installs those defaults); verified empirically on Postgres 17 that a policy''s function reference IS privilege-checked against the querying role, regardless of table owner, so this was checked rather than assumed. (3) REVIEW FINDING on two OLDER functions: the per-folder cap on incident photos and document pages was enforced only by migration 184''s BEFORE INSERT trigger on storage.objects, which caps OBJECTS -- nothing capped the ROW registrations, including rows whose path has no object behind it, which that trigger by definition never sees, so a member could register unbounded rows in a members-readable table. public.add_vehicle_document_photo(uuid, text) is re-declared off migration 201 (chain 201 -> 202) and public.add_incident_photo(uuid, text) off migration 138 (verified newest prior: 148 only revokes from anon and nothing between 139 and 201 re-declares it; chain 138 -> 202), each byte-identical apart from a transaction-scoped advisory lock keyed on the parent entity, a count taken UNDER that lock and a Danish check_violation refusal at the limit -- create_vehicle_document''s 50-document shape, and the anti-race form migration 184 argued for. Row caps equal their bucket''s object cap so the two agree instead of drifting: 5 pages per document, 10 photos per incident. 138''s existing ENGLISH sentences are preserved verbatim (re-declaring to add a cap is not licence to retranslate a body) while the one new sentence is Danish. Neither signature moves, so create-or-replace suffices: no DROP, no PGRST202/203 window, no stranded client build; ACLs are restated with anon named explicitly (148 convention). NO CHANGE to delete_my_account (on_my_way holds no member reference -- it is three scalars -- and the photo RPCs'' created_by_member_id pointers ride the in-place member anonymisation, as 169 and 201 documented), no retention rule (on_my_way dies with its booking, the events with ledger_events'' 30-day expiry), no new table, no storage change. GDPR: the phone processes position LOCALLY and the platform receives a derived DURATION, so the privacy page''s "ingen loebende sporing" claim is untouched -- there is no position for anyone to process and no history to build; recorded in docs/gdpr/ropa.md. Guarded by tools/test-on-my-way-realtime-contract.mjs in the dependency-free gate (both copies) and by role-matrix cases for both RPCs. MERGE ORDER: PostgREST answers PGRST202 for a function that does not exist, so this SQL must be applied in the Supabase SQL Editor BEFORE govehlo-mobile''s GVM-238/GVM-575 half ships, and the govehlo-web half (EXPECTED_LATEST_MIGRATION 202) must not deploy before it either.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

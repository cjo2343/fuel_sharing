-- Migration 209: a per-share signing key on car_bookings.on_my_way (GVM-593)
--
-- ── THE HOLE ──────────────────────────────────────────────────────────────────
-- GVM-587 put a live map behind "Jeg er på vej". While a share is running, the sharing
-- device broadcasts an `omw-position` payload every few seconds on the workspace's
-- PRIVATE presence topic, and every other member's map draws a dot from it. Nothing is
-- stored: the broadcast is ephemeral and this column still holds only derived minutes.
--
-- What migrations 202/205/206 authorise, though, is the ROOM and not the SENTENCE.
-- Migration 205's policies say "any member of this workspace may read and write on the
-- presence topic for it". They say nothing about who a payload CLAIMS to be from,
-- because a broadcast payload is opaque jsonb that never passes through a policy. Three
-- consequences, all reachable by any ordinary member of the workspace:
--
--   (a) ANY member can broadcast a payload carrying the sharer's memberId and a position
--       of their choosing, and every other member's map draws the sharer standing there.
--       The map is the most personal thing this product shows and its trust boundary is
--       currently "everyone in the workspace is honest".
--   (b) ORDERING IS SENDER-SUPPLIED. `ts` is a millisecond clock reading from the sending
--       phone, and the viewer sorts by it. One payload with a `ts` far in the future pins
--       the dot for the rest of the share: nothing genuine ever looks newer.
--   (c) THERE IS NO SESSION KEY. A payload captured from a PREVIOUS share of the same
--       booking is indistinguishable from a current one, so a replay of yesterday's drive
--       is a valid message today.
--
-- ── THE DECISION (owner, 2026-08-19) ──────────────────────────────────────────
-- The sender proves the SENTENCE, not just the room. When a share starts, the sharing
-- device mints a fresh ed25519 keypair, keeps the private half in memory only, and
-- registers the PUBLIC half through set_on_my_way — which migration 202 already gates to
-- the booking's MEMBER or its CREATOR (never an admin) and migration 207 already made the
-- only writer of this column. The row therefore carries an authenticated statement of the
-- form "for this share, the positions that count are the ones signed by this key", and
-- every viewer reads that statement from a table it can already read under RLS.
--
-- The server-minted `started_at` doubles as the SESSION KEY. It is set by the RPC on the
-- first share, preserved verbatim across every refresh (202), and un-rewritable by any
-- direct write (207) — so a payload that names the wrong `started_at` is from another
-- share and is dropped. Stopping and re-sharing mints a new key AND a new started_at,
-- which is what retires (c) rather than merely narrowing it.
--
-- THE KEY IS NOT PERSONAL DATA AND IT IS NOT A POSITION. It is 32 random bytes, minted
-- per share, thrown away when the share ends, and it identifies nothing outside the row
-- it sits on. The promise this feature was built on — the platform never receives, never
-- stores and never logs a coordinate — is unchanged, and the shape constraint below still
-- says so: the ONLY key this migration lets into the object is `pubkey`.
--
-- ── THE BROADCAST PAYLOAD CONTRACT (the clients implement this) ───────────────
-- This repo is the source of truth for the shared schema, so the wire format that the
-- registered key certifies is written down HERE rather than in one of the two client
-- repos, where the other one could not see it.
--
--   channel : presence-<ledgerId>          (private: true — migrations 202/205)
--   event   : omw-position
--   payload : {
--               bookingId : text    -- car_bookings.id (the uuid, not legacy_id)
--               memberId  : text    -- the sharer's ledger_members id
--               lat       : number  -- 5 decimals
--               lng       : number  -- 5 decimals
--               ts        : integer -- milliseconds, the SENDER's clock
--               sharedAt  : integer -- milliseconds = Date.parse(on_my_way.started_at)
--                                   --   the session key: which share this belongs to
--               sig       : text    -- base64 of an ed25519 DETACHED signature over the
--                                   --   UTF-8 string
--                                   --     `${bookingId}|${memberId}|${lat.toFixed(5)}|${lng.toFixed(5)}|${ts}|${sharedAt}`
--                                   --   made with the private half of `pubkey`
--             }
--
-- VIEWER RULES (documented here, enforced in the mobile client — no server sees any of
-- this, which is the point):
--
--   • DROP the payload unless the signature verifies against the `pubkey` on that
--     booking's row. No key on the row means the share is ETA-only: draw no dot at all,
--     rather than trusting an unsigned one.
--   • DROP it unless `sharedAt` equals the row's `started_at` in milliseconds. That is
--     the replay gate.
--   • DROP it unless `memberId` is the booking's member or its creator — the same two
--     people set_on_my_way admits. A valid signature from the wrong person is still the
--     wrong person.
--   • ORDER BY RECEIVE TIME, never by `ts`. The socket's arrival order is the one thing
--     a sender cannot forge, and it is what retires (b).
--   • `ts` feeds ONLY the freshness label ("opdateret for 8 sek. siden"), clamped to
--     [receivedAt − 2 min, receivedAt] so a wrong phone clock cannot make a fresh dot
--     look stale or a stale one look fresh.
--   • A dot EXPIRES 3 minutes after the last accepted payload for it, and is purged on
--     stop (the on_my_way_stopped event) and on a re-key — a new `pubkey` on the row
--     invalidates every dot drawn from the old one.
--
-- WHY NOT A SERVER RELAY. The obvious alternative — have the clients POST positions to an
-- RPC that re-broadcasts them with `realtime.send()`, so the server can vouch for the
-- sender — was REJECTED, and not on cost. That function INSERTS the payload as a row in
-- Realtime's own messages table, where it is retained for days. The coordinate would then
-- be stored, in our database, on our EU project, under our controllership: exactly the one
-- thing GVM-238 P0 promised would never happen, traded away to fix a smaller problem. A
-- signature that the clients check is the version where nothing is stored.
--
-- ── WHAT CHANGES HERE ─────────────────────────────────────────────────────────
--   1. The shape CHECK gains ONE optional key, `pubkey`, pinned as a string matching
--      ^[A-Za-z0-9+/]{43}= — standard base64 of exactly 32 bytes. The key set is still
--      CLOSED: `on_my_way - array[…four names…] = '{}'::jsonb` is what keeps a coordinate
--      out of a direct PostgREST PATCH, and it is still the load-bearing half.
--   2. set_on_my_way takes a trailing `share_pubkey text default null`. First share: the
--      key given, or none (an ETA-only share, which is what a client that cannot sign
--      sends, and what every build in the field sends until the mobile half ships).
--      Refresh with null: KEEP the key already on the row — a refresh does not re-key.
--      Refresh with a NEW key: REPLACE it, which is the sharer re-keying after an app
--      restart lost the private half.
--   3. Nothing else. clear_on_my_way is untouched (207 is its newest definition and it
--      simply nulls the column, key and all), and 207's trigger
--      enforce_on_my_way_rpc_only is untouched — it validates the timestamps and the
--      transaction-local mark, neither of which the key set affects. No new event_type
--      (nothing to classify under GV-413), no new table, column, index or policy.
--
-- ── Provenance (the GV-202 newest-prior-definition rule) ──────────────────────
-- CHAIN 202 → 207 → 209. public.set_on_my_way is re-declared off MIGRATION 207 — its
-- newest prior definition, and the one that added the set_config bracketing around the
-- UPDATE; 208 is the newsletter lease and touches nothing here. The body below is 207's
-- verbatim apart from the three additions above. public.clear_on_my_way is NOT re-declared
-- (207 remains its newest definition, unchanged).
--
-- THE SIGNATURE MOVES, so this is a DROP + CREATE rather than a bare create-or-replace:
-- adding a defaulted parameter makes a NEW function, and leaving the 5-argument one in
-- place would give PostgREST two candidates for a 5-key call and answer PGRST203
-- ("Could not choose the best candidate function") for every share in the field. Dropping
-- it first means there is exactly one candidate, and a 5-key call — which is what the
-- load-rehearsal driver and every mobile build before the GVM-593 client change send —
-- resolves to it with share_pubkey defaulting to null. ACLs are restated on the NEW
-- signature with anon named explicitly (migration 148's convention); the old signature's
-- grants disappear with it.
--
-- MERGE/APPLY ORDER: vehloshare-web (EXPECTED_LATEST_MIGRATION + types) → this repo →
-- APPLY THIS SQL IN THE SUPABASE SQL EDITOR → vehloshare-mobile. The mobile PR calls
-- set_on_my_way with six keys, which answers PGRST202 until this migration is applied.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The shape constraint gains ONE optional key
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop-and-add rather than a second constraint: migration 202's version closes the key set
-- at exactly three, so the two could never both be true of a share that carries a key. The
-- add is guarded exactly as 202 guarded its own, so the file replays cleanly, and every
-- operator in here stays immutable (a CHECK constraint cannot contain a subquery, which is
-- why the key set is closed with the jsonb minus operator rather than jsonb_object_keys).
--
-- 43 base64 characters plus one '=' pad is 32 bytes, which is the size of an ed25519
-- public key. Standard alphabet, not URL-safe: one alphabet, so a viewer comparing a
-- payload's key against the row's is comparing the same string both sides.
do $$
begin
  alter table public.car_bookings
    drop constraint if exists car_bookings_on_my_way_shape_check;

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
          and on_my_way - array['eta_minutes', 'started_at', 'updated_at', 'pubkey'] = '{}'::jsonb
          and jsonb_typeof(on_my_way -> 'eta_minutes') = 'number'
          and on_my_way -> 'eta_minutes' >= '1'::jsonb
          and on_my_way -> 'eta_minutes' <= '600'::jsonb
          and jsonb_typeof(on_my_way -> 'started_at') = 'string'
          and jsonb_typeof(on_my_way -> 'updated_at') = 'string'
          and (
            not (on_my_way ? 'pubkey')
            or (
              jsonb_typeof(on_my_way -> 'pubkey') = 'string'
              and on_my_way ->> 'pubkey' ~ '^[A-Za-z0-9+/]{43}=$'
            )
          )
        )
      );
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. set_on_my_way registers the share's public key
-- ═══════════════════════════════════════════════════════════════════════════════

-- The 5-argument signature goes first: a defaulted parameter makes a NEW function, and two
-- candidates is PGRST203 for every 5-key call. See the header.
drop function if exists public.set_on_my_way(text, text, integer, text, text);

-- ── set_on_my_way — re-declared off migration 207 (chain 202 → 207 → 209) ──────
-- 207 verbatim apart from the share_pubkey validation, the v_pubkey resolution and the
-- conditional key in v_state.
--
-- Start or refresh the driver's "jeg er på vej" share. One call = one write = one
-- event. The first call of a share writes the feed row; every refresh writes an
-- audit-only row so the other clients re-fetch without the feed filling up.
create or replace function public.set_on_my_way(
  target_ledger_id text,
  legacy_booking_id text,
  eta_minutes integer,
  event_title text default null,
  event_body text default null,
  share_pubkey text default null
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
  v_pubkey text;
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

  -- GVM-593: the share's PUBLIC signing key, and nothing else — 32 random bytes in
  -- standard base64. Judged here as well as by the shape constraint so a client that
  -- sends a malformed one gets a Danish sentence from the RPC rather than a bare 23514
  -- from the table, and so the refusal happens before anything is looked up.
  if share_pubkey is not null and share_pubkey !~ '^[A-Za-z0-9+/]{43}=$' then
    raise exception 'Ugyldig delingsnøgle' using errcode = '22023';
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
  --
  -- GVM-593 leans on this gate for a second job: it is what makes the registered key an
  -- AUTHENTICATED statement rather than a claim. Only these two people can say which key
  -- speaks for this share.
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
  -- GVM-593 gives it a second job: it is the SESSION KEY the broadcast payloads name, so
  -- a payload from a previous share of this booking is refused by every viewer.
  if v_first then
    v_started_at := v_updated_at;
  else
    v_started_at := coalesce(
      nullif(v_booking.on_my_way ->> 'started_at', '')::timestamptz,
      v_updated_at
    );
  end if;

  -- GVM-593, the three cases, in one line. A key given wins: on a first share it is the
  -- share's key, and on a refresh it REPLACES the stored one, which is the sharer
  -- re-keying after an app restart lost the private half. No key given falls back to
  -- whatever the row already carries, so an ordinary refresh does not re-key. Neither
  -- one: an ETA-only share, which is exactly what a client that cannot sign sends, and
  -- what the viewers must read as "draw no dot".
  v_pubkey := coalesce(share_pubkey, v_booking.on_my_way ->> 'pubkey');

  -- Built HERE from scalars. There is no path by which a caller-supplied object reaches
  -- this column, which is what makes "no coordinate is ever stored" a property of the
  -- code rather than a rule someone has to remember. The key is appended only when there
  -- is one, so an ETA-only share stores exactly the same three keys it always did.
  v_state := jsonb_build_object(
    'eta_minutes', eta_minutes,
    'started_at', v_started_at,
    'updated_at', v_updated_at
  ) || case
         when v_pubkey is null then '{}'::jsonb
         else jsonb_build_object('pubkey', v_pubkey)
       end;

  -- car_bookings.updated_at is NOT touched: migration 160 made it an optimistic
  -- concurrency token, and a five-minute refresh cadence would otherwise refuse every
  -- other member's booking edit with GV42T. See the header.
  --
  -- GV-489: raise the transaction-local mark immediately before the write and clear it
  -- immediately after, so it describes exactly this UPDATE and nothing else in the
  -- transaction. enforce_on_my_way_rpc_only_trg refuses the write without it, which is
  -- what makes every gate above binding on a direct PostgREST PATCH too.
  perform set_config('govehlo.on_my_way_command', '1', true);
  update public.car_bookings cb
     set on_my_way = v_state
   where cb.id = v_booking.id;
  perform set_config('govehlo.on_my_way_command', '', true);

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
    'pubkey', v_pubkey,
    'first_share', v_first
  );
end;
$$;

revoke all on function public.set_on_my_way(text, text, integer, text, text, text) from public;
revoke all on function public.set_on_my_way(text, text, integer, text, text, text) from anon;
grant execute on function public.set_on_my_way(text, text, integer, text, text, text) to authenticated;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '209_on_my_way_share_pubkey',
  'A per-share ed25519 signing key on car_bookings.on_my_way, so the live map can prove WHO a position came from (GVM-593, Tier 2, owner decision 2026-08-19). THE HOLE: GVM-587''s live map broadcasts an omw-position payload every few seconds on the workspace''s private presence topic while a share runs -- ephemeral, never stored, and still no coordinate in any table. But migrations 202/205/206 authorise the ROOM, not the SENTENCE: the presence policies say "any member of this workspace may read and write on this topic" and say nothing about who a payload CLAIMS to be from, because a broadcast payload is opaque jsonb that never passes through a policy. Three consequences, all reachable by any ordinary member: (a) anyone in the workspace could broadcast a payload carrying the SHARER''s memberId and a place of their choosing, and every other member''s map would draw the sharer standing there -- the map is the most personal thing this product shows and its trust boundary was "everyone in the workspace is honest"; (b) ordering was SENDER-SUPPLIED, since the viewer sorted by the sending phone''s millisecond clock, so one payload dated far in the future pinned the dot for the rest of the share; (c) there was no session key, so a payload captured from a PREVIOUS share of the same booking was indistinguishable from a current one and a replay of yesterday''s drive was a valid message today. THE FIX: the sender proves the sentence. When a share starts, the sharing device mints a fresh ed25519 keypair, keeps the private half in memory only, and registers the PUBLIC half through set_on_my_way -- already gated by migration 202 to the booking''s MEMBER or CREATOR (never an admin) and already, since migration 207, the ONLY writer of this column. The row therefore carries an authenticated statement of the form "for this share, the positions that count are the ones signed by this key", readable by every member under the RLS they already have. The server-minted started_at doubles as the SESSION KEY: set on the first share, preserved verbatim across refreshes (202) and un-rewritable by any direct write (207), so a payload naming the wrong started_at belongs to another share and is dropped; stopping and re-sharing mints a new key AND a new started_at, which retires (c) rather than narrowing it. WHAT CHANGES: (1) car_bookings_on_my_way_shape_check is dropped and re-added (drop-and-add rather than a second constraint -- 202''s closes the key set at exactly three, so both could never hold of a share carrying a key) with the same three REQUIRED keys and at most ONE optional extra, pubkey, pinned as a jsonb string matching ^[A-Za-z0-9+/]{43}= -- standard base64 of exactly 32 bytes, the size of an ed25519 public key. The key set stays CLOSED (on_my_way minus the four names must equal ''{}''), which is the half that keeps a coordinate out of a direct PostgREST PATCH and is still the load-bearing one; every operator stays immutable and there is no subquery, because a CHECK cannot contain one. (2) set_on_my_way gains a trailing share_pubkey text default null and is DROPPED at its 5-argument signature and recreated at 6 -- a defaulted parameter makes a NEW function, and leaving both in place would give PostgREST two candidates and answer PGRST203 for every 5-key call in the field; with exactly one candidate, a 5-key call (the load-rehearsal driver, and every mobile build before the GVM-593 client change) resolves with share_pubkey null. Its body is migration 207''s verbatim -- the set_config bracketing, the advisory lock, the member-or-creator gate, the ended-booking gate, the preserved started_at, one event per call -- plus: a 22023 "Ugyldig delingsnoegle" for a malformed key, judged with the payload checks before anything is looked up; v_pubkey := coalesce(share_pubkey, the key already on the row), which is the three cases in one line (first share registers the given key or none at all; a refresh with null KEEPS the stored key, because a refresh does not re-key; a refresh with a NEW key REPLACES it, which is the sharer re-keying after an app restart lost the private half); and the key appended to v_state ONLY when there is one, so an ETA-only share still stores exactly three keys. The returned jsonb gains pubkey. ACLs restated on the new signature with anon named explicitly (148 convention); the old signature''s grants disappear with it. THE KEY IS NOT PERSONAL DATA AND NOT A POSITION: 32 random bytes, minted per share, discarded when the share ends, identifying nothing outside the row it sits on -- the GVM-238 P0 promise that the platform never receives, stores or logs a coordinate is unchanged, and the constraint still says so. THE BROADCAST PAYLOAD CONTRACT the clients implement is documented in the migration header, because this repo is the source of truth both client repos share: event omw-position on the private presence topic, payload {bookingId, memberId, lat, lng (5 decimals), ts (sender clock ms), sharedAt (= Date.parse(started_at), the session key), sig (base64 ed25519 detached signature over `bookingId|memberId|lat|lng|ts|sharedAt`)}, with the viewer rules stated there too: drop unless the signature verifies against the row''s pubkey, drop unless sharedAt matches the row''s started_at, drop unless memberId is the booking''s member or creator, ORDER BY RECEIVE TIME rather than ts (arrival order is the one thing a sender cannot forge, which is what retires (b)), ts feeding only the freshness label clamped to [receivedAt - 2 min, receivedAt], a dot expiring 3 minutes after its last accepted payload, and a purge on stop or re-key. A SERVER RELAY WAS REJECTED: an RPC that re-broadcast positions could vouch for the sender, but the send function INSERTS the payload into Realtime''s own messages table, where it is retained for days -- the coordinate would then be STORED, in our database, on our EU project, under our controllership, which is the exact thing the feature promised would never happen, traded away for a smaller fix. WHAT DOES NOT CHANGE: clear_on_my_way is not re-declared (207 stays its newest definition; it nulls the column, key and all) and neither is 207''s trigger enforce_on_my_way_rpc_only, which validates the timestamps and the transaction-local mark and is indifferent to the key set -- an unmarked write still answers 42501 and a marked write with an extra lat key still answers 23514. No new event_type (nothing to classify under GV-413), no new table, column, index or policy, no grant change to any other RPC, no realtime change at all. GDPR: no new personal data, no new recipient, no new retention -- a random per-share key that dies with the booking''s share. Provenance: chain 202 -> 207 -> 209; set_on_my_way re-declared off 207, its newest prior definition (208 is the newsletter lease and touches nothing here). Verified by tools/test-on-my-way-realtime-contract.mjs (the constraint and both copies of the re-declared body) and tools/test-rls-role-matrix.mjs (key stored on a first share, preserved on a refresh with null, replaced by a refresh with a new key, a malformed key refused with 22023, an ETA-only share still exactly three keys, a marked coordinate PATCH still 23514, a direct write still 42501, and the feed-event count unchanged). MERGE/APPLY ORDER: vehloshare-web (EXPECTED_LATEST_MIGRATION + vendored types) -> this repo -> APPLY THIS SQL MANUALLY IN THE SUPABASE SQL EDITOR -> vehloshare-mobile, whose PR calls set_on_my_way with six keys and answers PGRST202 until the migration is applied.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

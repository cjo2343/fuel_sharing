-- Migration 207: car_bookings.on_my_way is writable only through its two RPCs (GV-489)
--
-- ── THE HOLE ──────────────────────────────────────────────────────────────────
-- Migration 202 built "Jeg er på vej" as two RPCs with a careful gate each:
--
--   • set_on_my_way  — the booking's MEMBER or its CREATOR, and deliberately NOT a
--     workspace admin (an admin announcing that ANOTHER PERSON is on their way is a
--     statement about where that person is); booking un-deleted and not yet ended;
--     eta bounded 1..600; started_at preserved verbatim across every refresh; and
--     EXACTLY ONE ledger_events row per call — the feed row on the first share, the
--     audit row on every refresh.
--   • clear_on_my_way — member/creator/admin (clearing removes information rather than
--     asserting any), idempotent, and it writes the on_my_way_stopped audit row so the
--     other clients drop the badge.
--
-- None of that was reachable-only. car_bookings has a REAL update policy for
-- authenticated since migration 005 — "Booking creators members and admins can update
-- car bookings" — so the booking's member, its creator AND any workspace admin could
-- PATCH the column straight through PostgREST, and the only thing standing in the way
-- was migration 202's CHECK constraint car_bookings_on_my_way_shape_check, which
-- validates the SHAPE of the jsonb and nothing else. Everything the RPC bodies decide
-- was therefore advisory:
--
--   (a) An ADMIN could announce that another member was on their way. That is the one
--       refusal migration 202 argued for at length and gave its own role-matrix case
--       (onmyway-share-admin-denied) — and it was enforced only for callers polite
--       enough to use the RPC.
--   (b) started_at could be rewritten, so "Bo har været på vej i 4 timer" could be
--       turned into "i 2 minutter" (or the reverse) by the person it describes.
--   (c) The two timestamps are only pinned as jsonb STRINGS by the shape constraint.
--       'ikke en dato' passes it, and then set_on_my_way's own
--       `nullif(on_my_way ->> 'started_at', '')::timestamptz` self-heal — and any
--       reader that casts — chokes on 22007 on the NEXT refresh, from a value written
--       hours earlier by a different request.
--   (d) A share could be set or cleared with NO ledger_events row at all. That is the
--       migration 087 lesson in its exact original form: the event insert IS the
--       cross-client live sync, so a direct write leaves every other member's app
--       showing yesterday's answer until they pull to refresh — no feed row for the
--       share, and no nudge for the stop. It also walks straight past the consent
--       moment GVM-587 put on the live-map broadcast: the group learns someone is on
--       their way from a row that no event, and therefore no client, ever announced.
--
-- ── THE DECISION ──────────────────────────────────────────────────────────────
-- The column becomes RPC-ONLY. A BEFORE INSERT OR UPDATE OF on_my_way trigger refuses
-- any write to it that is not marked as coming from set_on_my_way / clear_on_my_way,
-- with 42501 and a Danish sentence.
--
-- The mark is the house pattern, not a new mechanism: a TRANSACTION-LOCAL GUC
-- (`govehlo.on_my_way_command`), set immediately before the write and cleared
-- immediately after — migration 204's govehlo.settlement_lifecycle_command, itself the
-- govehlo.pii_scrub convention from 131/176. Why that is a real gate and not a
-- decoration: PostgREST exposes only functions in the public schema, set_config lives
-- in pg_catalog and is not among them, and every PostgREST request is its own
-- transaction — so a client has no statement it can run to raise the flag, and a flag
-- raised inside one request cannot survive into the next. Belt and braces on top of
-- that: both RPCs carry a `set search_path = public` proconfig clause, which makes
-- Postgres unwind every GUC they set at function exit, so the mark cannot outlive the
-- call even inside one transaction.
--
-- WHAT A DIRECT WRITER NOW SEES: 42501 "Forventet ankomst kan kun ændres via
-- "Jeg er på vej" i appen". Not a silent no-op and not a stripped column — the write
-- is refused whole, so nobody ends up believing they shared something they did not.
--
-- TWO WRITES ARE STILL ALLOWED, and both have to be:
--   • INSERT with a NULL on_my_way — i.e. every booking anyone creates. The trigger
--     fires on all inserts (a column list narrows UPDATE only), and both booking RPCs
--     create rows with no share on them.
--   • UPDATE where the value is UNCHANGED (`is not distinct from`). PostgREST PATCHes
--     carry whatever columns the client sent, and an ordinary booking edit that happens
--     to carry on_my_way along unchanged is not an attempt to write it. Refusing that
--     would break editing a booking that has a live share on it — the single most
--     ordinary combination in the feature.
--
-- NO ROLE EXEMPTION. Not for admins (that is defect (a) itself), not for the service
-- role, not for postgres. The RPCs are the only writers, and a rule with a hole for the
-- most privileged caller is the rule migration 202 already had. THE OPERATOR ESCAPE
-- HATCH is the same door the RPCs use, opened by hand: in the Supabase SQL Editor, in
-- ONE transaction,
--
--     begin;
--     select set_config('govehlo.on_my_way_command', '1', true);
--     update public.car_bookings set on_my_way = null where id = '…';
--     commit;
--
-- clears a share stuck on a row that neither RPC can reach. Prefer clear_on_my_way:
-- doing it by hand writes no on_my_way_stopped event, so the other clients keep the
-- badge until something else nudges them.
--
-- ── BELT AND BRACES: the timestamps must be timestamps ─────────────────────────
-- Even when the mark IS present, a non-null share must carry a started_at and an
-- updated_at that cast cleanly to timestamptz, with updated_at >= started_at. Today
-- both RPCs build the object from `now()` and a preserved start, so this can only fire
-- on a future bug in one of them — which is the point: (c) above is a value that is
-- accepted at write time and explodes in a LATER request, and that is the most
-- expensive shape a data defect can have. The casts sit inside their own exception
-- block so an invalid string raises THIS sentence under 22023 rather than a bare
-- Postgres cast error from inside a trigger.
--
-- ── What this does NOT change ─────────────────────────────────────────────────
-- No policy is dropped or narrowed: the migration 005 update policy still governs the
-- REST of the booking row (start/end/purpose/member), exactly as GV-253 intends, and
-- this trigger only removes on_my_way from what that policy effectively grants. The
-- shape CHECK constraint stays and still bites — a BEFORE row trigger runs first, so an
-- unmarked coordinate PATCH now answers 42501 (the trigger) and a MARKED one still
-- answers 23514 (the constraint); both refusals are pinned in the role matrix.
-- GVM-587's live-map broadcast is untouched: it is an ephemeral Realtime broadcast on
-- the workspace topic, not a write to this column, so nothing about it passes through
-- here. No new event_type (nothing to classify under GV-413), no column, no index, no
-- grant change to any client-callable RPC. GDPR: no new data, recipient or retention —
-- this migration only narrows who may write three scalars that were already there.
--
-- ── Provenance (the GV-202 newest-prior-definition rule) ──────────────────────
-- public.set_on_my_way(text, text, integer, text, text) and
-- public.clear_on_my_way(text, text) are re-declared off MIGRATION 202, which is their
-- only prior definition: 203 (dispute reprice), 204 (re-request), 205 and 206 (realtime
-- policies) touch neither, and nothing between them mentions car_bookings.on_my_way at
-- all. Chain 202 -> 207 for both. Each body is byte-identical to 202's apart from the
-- two set_config lines bracketing its UPDATE. Neither signature moves, so
-- create-or-replace suffices: no DROP, no PGRST202/203 window, no stranded client
-- build, and types/database.ts moves only by its generation stamp. ACLs are restated
-- with anon named explicitly (migration 148's convention).

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The guard
-- ═══════════════════════════════════════════════════════════════════════════════

-- Security definer with a pinned search_path, and execute revoked from every client
-- role, following migration 189's restamp_handover_observed_at: a trigger function
-- defends its own access rather than inheriting an assumption about which caller fired
-- it. Fully qualified throughout for the SQL ambiguity guard.
create or replace function public.enforce_on_my_way_rpc_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started_at timestamptz;
  v_updated_at timestamptz;
begin
  -- Every booking INSERT reaches here (a column list narrows UPDATE only). A booking
  -- is created without a share, and both booking RPCs do exactly that.
  if tg_op = 'INSERT' and new.on_my_way is null then
    return new;
  end if;

  -- An ordinary booking edit that carries the column along unchanged is not a write to
  -- it. Refusing this would make a booking with a live share uneditable.
  if tg_op = 'UPDATE' and new.on_my_way is not distinct from old.on_my_way then
    return new;
  end if;

  -- The transaction-local mark set_on_my_way / clear_on_my_way raise around their own
  -- UPDATE (the govehlo.settlement_lifecycle_command convention from migration 204).
  -- No role is exempt: an admin bypassing this IS the defect GV-489 is about. An
  -- operator who must hand-clear a stuck share raises the same flag by hand in the same
  -- transaction -- see the header.
  if coalesce(current_setting('govehlo.on_my_way_command', true), '') <> '1' then
    raise exception 'Forventet ankomst kan kun ændres via "Jeg er på vej" i appen'
      using errcode = '42501';
  end if;

  -- Belt and braces, and cheap: even a marked write must carry timestamps that ARE
  -- timestamps. The shape constraint pins them as jsonb strings only, so without this a
  -- future bug in either RPC could store 'ikke en dato' and blow up a LATER request
  -- that casts it. The casts sit in their own exception block so the refusal is this
  -- Danish sentence rather than a bare cast error raised from inside a trigger.
  if new.on_my_way is not null then
    begin
      v_started_at := (new.on_my_way ->> 'started_at')::timestamptz;
      v_updated_at := (new.on_my_way ->> 'updated_at')::timestamptz;
    exception
      when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
        raise exception 'Forventet ankomst har ugyldige tidsstempler' using errcode = '22023';
    end;

    if v_started_at is null or v_updated_at is null then
      raise exception 'Forventet ankomst har ugyldige tidsstempler' using errcode = '22023';
    end if;

    if v_updated_at < v_started_at then
      raise exception 'Forventet ankomst kan ikke være opdateret, før den blev delt'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_on_my_way_rpc_only() from public;
revoke all on function public.enforce_on_my_way_rpc_only() from anon;
revoke all on function public.enforce_on_my_way_rpc_only() from authenticated;

drop trigger if exists enforce_on_my_way_rpc_only_trg on public.car_bookings;
create trigger enforce_on_my_way_rpc_only_trg
  before insert or update of on_my_way on public.car_bookings
  for each row
  execute function public.enforce_on_my_way_rpc_only();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. The two RPCs raise the mark around their own write
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── set_on_my_way — re-declared off migration 202 (chain 202 → 207) ────────────
-- 202 verbatim apart from the two set_config lines bracketing the UPDATE.
--
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
    'first_share', v_first
  );
end;
$$;

revoke all on function public.set_on_my_way(text, text, integer, text, text) from public;
revoke all on function public.set_on_my_way(text, text, integer, text, text) from anon;
grant execute on function public.set_on_my_way(text, text, integer, text, text) to authenticated;

-- ── clear_on_my_way — re-declared off migration 202 (chain 202 → 207) ──────────
-- 202 verbatim apart from the two set_config lines bracketing the UPDATE.
--
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

  -- GV-489: the same transaction-local mark, raised immediately before the write and
  -- cleared immediately after. Without it enforce_on_my_way_rpc_only_trg refuses the
  -- clear, which is what stops a direct write from removing a share with no
  -- on_my_way_stopped row behind it — the other clients would keep the badge.
  perform set_config('govehlo.on_my_way_command', '1', true);
  update public.car_bookings cb
     set on_my_way = null
   where cb.id = v_booking.id;
  perform set_config('govehlo.on_my_way_command', '', true);

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

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '207_on_my_way_rpc_only_writes',
  'car_bookings.on_my_way becomes writable ONLY through its two RPCs (GV-489, from the 2026-08-12 external review). THE HOLE: migration 202 gated set_on_my_way to the booking''s MEMBER or CREATOR (deliberately not an admin -- announcing that ANOTHER PERSON is on their way is a statement about where that person is), required the booking to be un-deleted and unfinished, bounded eta 1..600, preserved started_at across refreshes and wrote EXACTLY ONE ledger_events row per call; clear_on_my_way admitted the admin, was idempotent and wrote the stop row. None of it was reachable-only. Migration 005 gives authenticated a REAL update policy on car_bookings ("Booking creators members and admins can update car bookings"), so member, creator AND admin could PATCH the column straight through PostgREST, with only 202''s shape CHECK (jsonb key set, types, bounds) in the way. Four consequences, all reachable by any authenticated member of the workspace: (a) an ADMIN could announce that another member was on their way -- the single refusal 202 argued for hardest, enforced only for callers polite enough to use the RPC; (b) started_at could be rewritten, so how long someone has been on their way became editable by the person it describes; (c) the two timestamps are pinned only as jsonb STRINGS, so ''ikke en dato'' was accepted at write time and exploded on a LATER request that casts it (set_on_my_way''s own started_at self-heal, and any reader) -- the most expensive shape a data defect can have; (d) a share could be set or cleared with NO event row at all, which is the migration 087 lesson verbatim (the event insert IS the cross-client live sync): no feed row for the share, no nudge for the stop, every other member''s app showing yesterday''s answer until a manual refresh, and the GVM-587 consent moment on the live-map share bypassed by a state change nothing announced. THE FIX: new BEFORE INSERT OR UPDATE OF on_my_way trigger enforce_on_my_way_rpc_only_trg on public.car_bookings, running security-definer function public.enforce_on_my_way_rpc_only() (search_path pinned, execute revoked from public/anon/authenticated, migration 189''s restamp_handover_observed_at convention). It allows exactly two unmarked writes, both of which it must: an INSERT whose on_my_way is NULL (every booking anyone creates -- a column list narrows UPDATE only, so all inserts reach the trigger), and an UPDATE where the value is UNCHANGED under `is not distinct from` (a PostgREST PATCH carries whatever the client sent, and an ordinary booking edit that drags the column along unchanged is not a write to it; refusing it would make a booking with a live share uneditable). Every other write must carry the TRANSACTION-LOCAL mark govehlo.on_my_way_command = ''1'', or it is refused with 42501 and the Danish sentence "Forventet ankomst kan kun aendres via "Jeg er paa vej" i appen" -- refused whole, never silently stripped, so nobody believes they shared something they did not. The mark is migration 204''s govehlo.settlement_lifecycle_command pattern (itself the govehlo.pii_scrub convention from 131/176): set immediately before the write, cleared immediately after. It is a real gate rather than a decoration because PostgREST exposes only public-schema functions, set_config is in pg_catalog and is not among them, and every PostgREST request is its own transaction -- a client has no statement with which to raise the flag and no way to carry one across requests; and because both RPCs carry a `set search_path = public` proconfig clause, Postgres unwinds any GUC they set at function exit, so the mark cannot outlive the call even within one transaction. NO ROLE IS EXEMPT -- not admin (that is defect (a)), not service_role, not postgres: a rule with a hole for the most privileged caller is the rule 202 already had. THE OPERATOR ESCAPE HATCH is the same door opened by hand -- in the SQL Editor, in one transaction, `select set_config(''govehlo.on_my_way_command'', ''1'', true);` before the UPDATE -- documented in the migration header, with the warning that a hand-clear writes no on_my_way_stopped row so other clients keep the badge; clear_on_my_way is preferred. BELT AND BRACES: even a MARKED write must carry a started_at and an updated_at that cast cleanly to timestamptz with updated_at >= started_at, refused with 22023 in Danish; the casts sit in their own exception block (invalid_datetime_format / datetime_field_overflow / invalid_text_representation) so an invalid string raises that sentence rather than a bare cast error from inside a trigger. This can only fire on a future bug in either RPC, which is exactly why it is cheap to keep. Both RPCs are re-declared off MIGRATION 202, their only prior definition (203, 204, 205 and 206 touch neither, and nothing between them mentions this column; chain 202 -> 207 for both), byte-identical apart from the two set_config lines bracketing each UPDATE; neither signature moves, so create-or-replace suffices -- no DROP, no PGRST202/203 window, no stranded client build, and types/database.ts moves only by its generation stamp. ACLs restated with anon named explicitly (148 convention). WHAT DOES NOT CHANGE: no RLS policy is dropped or narrowed -- migration 005''s update policy still governs the rest of the booking row (start/end/purpose/member) exactly as GV-253 intends, and this trigger only removes on_my_way from what it effectively grants; 202''s shape CHECK stays and still bites, and because a BEFORE row trigger runs ahead of constraint evaluation an UNMARKED coordinate PATCH now answers 42501 while a MARKED one still answers 23514 (both pinned in the role matrix). GVM-587''s live-map share is unaffected: it is an ephemeral broadcast on the workspace topic, not a write to this column. No new event_type and nothing to classify under GV-413, no column, no index, no new grant. GDPR: no new data, recipient or retention -- the migration only narrows who may write three scalars that were already stored. Verified by tools/test-rls-role-matrix.mjs (direct set by member, direct set by admin, direct clear, started_at rewrite, unmarked coordinate patch and marked coordinate patch, plus an unchanged-column booking edit that must still succeed, and every pre-existing on_my_way RPC case unchanged) and by tools/test-on-my-way-realtime-contract.mjs, which re-reads the re-declared bodies in both the migration and the consolidated mirror. MERGE ORDER: this SQL must be applied in the Supabase SQL Editor after the vehloshare-web EXPECTED_LATEST_MIGRATION bump deploys and before the mobile types PR merges; no client code change is required, because no client ever wrote this column directly.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

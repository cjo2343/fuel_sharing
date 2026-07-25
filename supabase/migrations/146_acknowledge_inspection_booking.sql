-- Migration 146: acknowledge a booked syn so the reminder stops for the whole workspace (GVM-442)
--
-- Home's health queue (GVM-285) raises a `syn_due` item for the 30 days before the
-- periodic inspection falls due, and it is one of the few items with NO dismissal:
-- bookings and the station-arrival prompt can be waved off, syn cannot. So the moment
-- somebody actually books the inspection — the one thing the reminder is asking for —
-- it goes on sitting on every member's Home until the date passes. A reminder you
-- cannot switch off after acting on it becomes noise, and noise teaches people to
-- ignore the whole queue, including the items that matter. That is exactly the
-- failure state the queue was built to avoid.
--
-- Why this cannot be a client-side dismissal: acknowledging has to apply to the WHOLE
-- workspace. Kept local it would leave the other members nagged, and the person who
-- booked with no way to tell the rest it is handled — which is most of the problem.
-- A workspace-level marker needs a write, and a write needs an RPC.
--
-- ── Storage: three keys in the EXISTING ledgers.vehicle_info jsonb ─────────────────
-- next_inspection_date already lives there, and GVM-443/446 established the pattern of
-- member-confirmed values sitting beside the register-written ones in that same jsonb
-- (ejerafgift_next_due_confirmed, ejerafgift_amount_confirmed). A syn acknowledgement
-- is the same shape of fact about the same object, so it goes in the same place: no
-- schema change beyond this function, and the date and its acknowledgement can never
-- be fetched separately or drift apart. A dedicated column would be more queryable,
-- but nothing queries this server-side — the only consumer is a client that already
-- loads vehicle_info whole.
--
--   syn_booked_for            the acknowledged inspection date (YYYY-MM-DD)
--   syn_booked_at             ISO-8601 UTC timestamp of the acknowledgement
--   syn_booked_by_member_id   who acknowledged, so the group can be told who
--
-- ── Self-invalidation: the ack names its date ─────────────────────────────────────
-- syn_booked_for stores WHICH inspection date was acknowledged, not merely that
-- someone acknowledged something. Storing only a timestamp would let next year's
-- inspection arrive silently pre-acknowledged — strictly worse than the noise being
-- removed. Because the ack names the date it applies to that date and no other: when
-- the register refresh writes a new next_inspection_date (govehlo-mobile
-- src/lib/register-refresh.ts re-pulls 7 days past the syn date), syn_booked_for stops
-- matching and the reminder simply returns. No reset logic, no cleanup job, nothing to
-- forget. The same property is why an acknowledgement for any date OTHER than the
-- ledger's current next_inspection_date is rejected outright: a stale or invented date
-- could otherwise park an ack that the live date later grows into.
--
-- ── Authorisation: any member ────────────────────────────────────────────────────
-- Gated on is_ledger_member, not is_ledger_admin. Booking an inspection is not an
-- administrative act, and admin-gating recreates the exact problem the ticket
-- describes: the person who booked could not tell the others. That also rules out
-- reusing update_ledger_settings, which is admin-gated and raises 42501 — hence this
-- separate member-callable RPC rather than another vehicle_info patch through it.
--
-- Passing a NULL date clears the acknowledgement. Any member can silence a
-- safety-critical reminder for the whole group with one tap, so any member has to be
-- able to put it back: a mistaken tap, or a cancelled garage slot, would otherwise
-- leave the group with no syn reminder at all until the deadline passed.
--
-- ── The event is not decoration ──────────────────────────────────────────────────
-- Cross-client live update in this app IS a ledger_events insert (migration 087
-- lesson). Without the row the other members' devices keep rendering the reminder
-- until they cold-start, which fails the ticket's whole purpose. So the insert here is
-- UNCONDITIONAL: unlike migration 144, an omitted event_title falls back to
-- server-composed Danish copy instead of silently skipping the event, because a client
-- must not be able to opt out of the sync. "Lars har booket synet" is also precisely
-- what the group wants to see in the feed. The event_type starts with `vehicle`, so
-- the mobile feed's existing prefix mapping gives it the neutral vehicle treatment
-- with no client change needed.
--
-- Safe to rerun (create or replace; idempotent migration record).

create or replace function public.acknowledge_inspection_booking(
  target_ledger_id text,
  acknowledged_inspection_date date,
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
  v_actor_email text;
  v_actor_first text;
  v_syn_date date;
  v_previous_ack date;
  v_title text;
  v_body text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can acknowledge a booked inspection'
      using errcode = '42501';
  end if;

  v_actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if v_actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member'
      using errcode = '42501';
  end if;

  -- Lock the workspace row: two devices acknowledging at once must not interleave
  -- into a half-written marker (a date with nobody's name against it).
  select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date,
         nullif(l.vehicle_info ->> 'syn_booked_for', '')::date
    into v_syn_date, v_previous_ack
    from public.ledgers l
    where l.id = target_ledger_id
    for update;

  if not found then
    raise exception 'Workspace was not found' using errcode = '22023';
  end if;

  v_actor_email := nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '');

  select split_part(coalesce(nullif(btrim(m.name), ''), 'Nogen'), ' ', 1)
    into v_actor_first
    from public.ledger_members m
    where m.id = v_actor_member_id;
  v_actor_first := coalesce(v_actor_first, 'Nogen');

  -- ── Clear the acknowledgement (null date) ──────────────────────────────────────
  if acknowledged_inspection_date is null then
    -- Idempotent: nothing acknowledged means nothing to clear, so no write and no
    -- second event.
    if v_previous_ack is null then
      return jsonb_build_object(
        'acknowledged_for', null,
        'acknowledged_by_member_id', null,
        'changed', false
      );
    end if;

    update public.ledgers l
    set vehicle_info = l.vehicle_info
          - 'syn_booked_for'
          - 'syn_booked_at'
          - 'syn_booked_by_member_id',
        updated_at = now()
    where l.id = target_ledger_id;

    v_title := coalesce(nullif(btrim(event_title), ''), v_actor_first || ' fjernede syn-bookingen');
    v_body := coalesce(nullif(btrim(event_body), ''), 'Påmindelsen om syn er tilbage.');

    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      'vehicle_inspection_booking_cleared',
      v_title,
      v_body,
      v_actor_member_id,
      v_actor_email,
      jsonb_build_object('inspection_date', v_previous_ack::text)
    );

    return jsonb_build_object(
      'acknowledged_for', null,
      'acknowledged_by_member_id', null,
      'changed', true
    );
  end if;

  -- ── Acknowledge the current inspection date ───────────────────────────────────
  if v_syn_date is null then
    raise exception 'This workspace has no next inspection date to acknowledge'
      using errcode = '22023';
  end if;

  -- The ack names its date, so it may only ever name the CURRENT one. A stale client,
  -- or a register refresh that landed in between, would otherwise silence a date
  -- nobody is being reminded about — or park an ack the live date later grows into.
  if acknowledged_inspection_date <> v_syn_date then
    raise exception 'The acknowledged inspection date is not this workspace''s next inspection date'
      using errcode = '22023';
  end if;

  -- Idempotent: a replay (double tap, offline retry, a second device) finds the same
  -- date already acknowledged and writes neither a marker nor a second event.
  if v_previous_ack = acknowledged_inspection_date then
    return jsonb_build_object(
      'acknowledged_for', acknowledged_inspection_date::text,
      'acknowledged_by_member_id',
        nullif((select l.vehicle_info ->> 'syn_booked_by_member_id'
                from public.ledgers l where l.id = target_ledger_id), ''),
      'changed', false
    );
  end if;

  update public.ledgers l
  set vehicle_info = l.vehicle_info || jsonb_build_object(
        'syn_booked_for', acknowledged_inspection_date::text,
        'syn_booked_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'syn_booked_by_member_id', v_actor_member_id::text
      ),
      updated_at = now()
  where l.id = target_ledger_id;

  v_title := coalesce(nullif(btrim(event_title), ''), v_actor_first || ' har booket synet');
  v_body := coalesce(
    nullif(btrim(event_body), ''),
    'Syn senest ' || to_char(v_syn_date, 'DD-MM-YYYY') || '. Påmindelsen er slået fra indtil da.'
  );

  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id,
    'vehicle_inspection_booked',
    v_title,
    v_body,
    v_actor_member_id,
    v_actor_email,
    jsonb_build_object('inspection_date', acknowledged_inspection_date::text)
  );

  return jsonb_build_object(
    'acknowledged_for', acknowledged_inspection_date::text,
    'acknowledged_by_member_id', v_actor_member_id::text,
    'changed', true
  );
end;
$$;

revoke all on function public.acknowledge_inspection_booking(text, date, text, text) from public;
revoke all on function public.acknowledge_inspection_booking(text, date, text, text) from anon;
grant execute on function public.acknowledge_inspection_booking(text, date, text, text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '146_acknowledge_inspection_booking',
  'Acknowledge a booked syn so Home''s syn_due reminder stops for the WHOLE workspace (GVM-442): new member-callable acknowledge_inspection_booking(text, date, text, text) stamps syn_booked_for / syn_booked_at / syn_booked_by_member_id into the existing ledgers.vehicle_info jsonb, beside next_inspection_date and the GVM-443/446 member-confirmed ejerafgift keys. Gated on is_ledger_member, not is_ledger_admin — booking an inspection is not an administrative act, and admin-gating would recreate the ticket''s bug (the person who booked could not tell the others), which is also why update_ledger_settings could not be reused. The ack names WHICH date it acknowledges, so it is self-invalidating: a new next_inspection_date stops matching and the reminder returns with no reset logic; an ack for any other date is rejected. A null date clears the acknowledgement, so a mistaken tap or a cancelled garage slot cannot leave the group with no syn reminder. Both paths are idempotent (a replay writes no second event) and both write a ledger_events row unconditionally — cross-client live sync IS that insert (migration 087 lesson), so an omitted event_title falls back to server-composed Danish copy rather than skipping it.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

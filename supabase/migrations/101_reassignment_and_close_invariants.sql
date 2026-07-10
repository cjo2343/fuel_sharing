-- Migration 101: identity reassignment protection + close-rule invariant + Danish period label (GV-253)
--
-- Three hardenings verified by the lead (decision recorded on GV-253, Christian
-- 2026-07-10). All server messages stay English, matching the existing style.
--
-- FIX 1 — identity-field reassignment protection.
--   On an EXISTING row, the identity-bearing member column may only CHANGE when the
--   actor is a ledger admin OR the row's creator (created_by_member_id = actor):
--     * trips.driver_member_id
--     * fuel_payments.payer_member_id
--     * car_bookings.member_id
--   A permitted non-owner editor (the driver / payer / booked member acting as a
--   party) may still edit every OTHER field, but reassigning the identity to someone
--   else is rejected with 42501. Creating rows is unchanged (INSERT is not guarded).
--
--   Design choice — ONE shared BEFORE UPDATE trigger, not per-RPC body checks.
--   enforce_identity_reassignment() is attached to all three tables and is the single
--   control point. It covers BOTH paths at once:
--     * the SECURITY DEFINER upsert RPCs (upsert_trip_with_participants / 054,
--       upsert_fuel_payment / 071, upsert_car_booking / 063) — RLS does not apply
--       inside a definer function, so their own permission gate (creator/driver/
--       payer/booked-member/admin) is what would otherwise let a party silently
--       reassign; the trigger closes that gap. Each RPC routes an existing-row edit
--       through a real UPDATE (trip/fuel via INSERT ... ON CONFLICT DO UPDATE,
--       booking via an explicit UPDATE), so BEFORE UPDATE fires with OLD/NEW.
--     * any direct PostgREST UPDATE. (In practice the direct path is already closed:
--       the symmetric RLS with-check on these tables rejects a non-creator party who
--       reassigns the identity to a third person, because the NEW row then fails the
--       "... or <identity> = current member" clause. The trigger makes that belt-and-
--       braces and keeps ONE rule in ONE place.)
--   The JWT-based helpers (public.current_ledger_member_id / public.is_ledger_admin)
--   resolve the real actor even inside the definer RPCs because auth.jwt() is
--   request-scoped, not role-scoped — the same reason is_ledger_admin already works
--   inside close_settlement_period. Because the RPC bodies now route through this one
--   trigger, no upsert RPC body is re-declared for FIX 1.
--
-- FIX 2 — close-rule DB invariant (GVM-278). close_settlement_period is re-declared
--   off its newest prior body (migration 087) with one added guard: when the
--   workspace has NOT disabled rule_require_requests_before_close (the per-workspace
--   flag from migration 098; default true), every computed settlement pair that
--   moves money must already have a settlement_requests row for this period in a
--   requested-or-later state (status other than 'open' / 'cancelled'). Until now this
--   rule lived ONLY in the client (SettleScreen), so a crafted RPC call could close a
--   period with unrequested payments. When the flag is an explicit false the guard is
--   skipped.
--
-- FIX 3 — Danish period label. The same re-declaration replaces the English
--   'Current period' label written on the auto-created next period with a Danish
--   month-year label ('Juli 2026' style) matching the app's own period labels.

-- ── FIX 1: shared identity-reassignment guard ──────────────────────────────────
create or replace function public.enforce_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text := new.ledger_id;
  v_actor_member_id uuid;
  v_old_identity uuid;
  v_new_identity uuid;
  v_creator_member_id uuid := old.created_by_member_id;
begin
  -- Identity-bearing member column per table (GV-253). Any other table falls
  -- straight through untouched.
  if tg_table_name = 'trips' then
    v_old_identity := old.driver_member_id;
    v_new_identity := new.driver_member_id;
  elsif tg_table_name = 'fuel_payments' then
    v_old_identity := old.payer_member_id;
    v_new_identity := new.payer_member_id;
  elsif tg_table_name = 'car_bookings' then
    v_old_identity := old.member_id;
    v_new_identity := new.member_id;
  else
    return new;
  end if;

  -- Guard only an actual reassignment; an unchanged identity passes through so the
  -- driver / payer / booked member keeps editing every non-identity field.
  if v_new_identity is not distinct from v_old_identity then
    return new;
  end if;

  -- Reassignment is admin-or-creator only. The JWT helpers resolve the real actor
  -- even inside the SECURITY DEFINER upsert RPCs (auth.jwt() is request-scoped),
  -- mirroring how is_ledger_admin / current_ledger_member_id already work there.
  v_actor_member_id := public.current_ledger_member_id(v_ledger_id);
  if not (
    public.is_ledger_admin(v_ledger_id)
    or (v_creator_member_id is not null and v_creator_member_id = v_actor_member_id)
  ) then
    raise exception
      'Only the creator or a ledger admin can reassign who this entry belongs to.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_identity_reassignment() from public;

drop trigger if exists enforce_identity_reassignment_trips on public.trips;
create trigger enforce_identity_reassignment_trips
before update on public.trips
for each row execute function public.enforce_identity_reassignment();

drop trigger if exists enforce_identity_reassignment_fuel on public.fuel_payments;
create trigger enforce_identity_reassignment_fuel
before update on public.fuel_payments
for each row execute function public.enforce_identity_reassignment();

drop trigger if exists enforce_identity_reassignment_bookings on public.car_bookings;
create trigger enforce_identity_reassignment_bookings
before update on public.car_bookings
for each row execute function public.enforce_identity_reassignment();

-- ── FIX 2 + FIX 3: close_settlement_period, re-declared off migration 087 ───────
-- Verbatim re-declaration of migration 087's body with three additions:
--   (2a) two extra locals for the request-coverage guard,
--   (2b) the request-coverage guard after the integrity gate, and
--   (3)  a Danish month-year label on the freshly opened next period.
create or replace function public.close_settlement_period(
  target_ledger_id text,
  target_period_id uuid,
  period_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  snapshot_fingerprint text;
  server_fingerprint text;
  computed jsonb;
  computed_person jsonb;
  snapshot_person jsonb;
  snapshot_flow numeric;
  duplicate_period_id uuid;
  closed_period_id uuid;
  new_open_period_id uuid;
  requested_closed_at timestamptz;
  lock_acquired boolean;
  v_rule_require_requests boolean;
  v_settlement jsonb;
  v_missing_settlements integer := 0;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing open settlement period id' using errcode = '22023';
  end if;

  if period_snapshot is null or jsonb_typeof(period_snapshot) <> 'object' then
    raise exception 'Period snapshot must be a JSON object' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can close settlement periods' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  -- Guard before taking the advisory lock. Older frontend builds and health probes
  -- may call this RPC with a fake or already-closed period id. Reject those
  -- immediately so they cannot queue behind the lock and burn database CPU.
  if not exists (
    select 1
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
  ) then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '22023';
  end if;

  lock_acquired := pg_try_advisory_xact_lock(hashtext(target_ledger_id));
  if lock_acquired is not true then
    raise exception 'Another settlement close is already in progress for this ledger' using errcode = '55P03';
  end if;

  -- ── Integrity gate (GVM-112) ──────────────────────────────────────────────
  -- (a) Entry set: the snapshot's fingerprint must equal the one recomputed
  -- from the live rows. In-flight writers hold FOR SHARE on the period row, so
  -- by the time this runs the row set is stable for the transaction.
  snapshot_fingerprint := nullif(period_snapshot->>'entryFingerprint', '');
  server_fingerprint := public.calculate_period_entry_fingerprint(target_ledger_id, target_period_id);

  if snapshot_fingerprint is not null and snapshot_fingerprint <> server_fingerprint then
    raise exception 'Entries changed since this close was prepared. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  -- (b) Amounts: per-member figures within 0.02 kr, totals within 0.05 kr.
  computed := public.calculate_period_settlement(target_ledger_id, target_period_id);

  if abs(coalesce((period_snapshot->>'totalKm')::numeric, 0) - (computed->>'totalKm')::numeric) > 0.05
     or abs(coalesce((period_snapshot->>'totalPaid')::numeric, 0) - (computed->>'totalPaid')::numeric) > 0.05 then
    raise exception 'Snapshot totals do not match the server calculation. Refresh the app and try closing again.'
      using errcode = '23514';
  end if;

  for computed_person in
    select value from jsonb_array_elements(computed->'people')
  loop
    select p.value
      into snapshot_person
      from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb)) as p(value)
      where p.value->>'id' = computed_person->>'id'
      limit 1;

    if abs(coalesce((snapshot_person->>'km')::numeric, 0) - (computed_person->>'km')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'fuelPaid')::numeric, 0) - (computed_person->>'fuelPaid')::numeric) > 0.02
       or abs(coalesce((snapshot_person->>'net')::numeric, 0) - (computed_person->>'net')::numeric) > 0.02 then
      raise exception 'Snapshot member amounts do not match the server calculation. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;

    -- (c) The archived settlements must actually move each member's net:
    -- outflow - inflow ~= -net for every member.
    select coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'fromId' = computed_person->>'id'), 0)
         - coalesce(sum((s.value->>'amount')::numeric) filter (where s.value->>'toId' = computed_person->>'id'), 0)
      into snapshot_flow
      from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb)) as s(value);

    if abs(snapshot_flow + (computed_person->>'net')::numeric) > 0.05 then
      raise exception 'Snapshot settlements do not match the member balances. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;

  -- Snapshot-only members (left the ledger between fetch and close) must carry
  -- no money, otherwise the archive would hide a real balance.
  for snapshot_person in
    select value from jsonb_array_elements(coalesce(period_snapshot->'people', '[]'::jsonb))
  loop
    if not exists (
      select 1 from jsonb_array_elements(computed->'people') as c(value)
      where c.value->>'id' = snapshot_person->>'id'
    ) and abs(coalesce((snapshot_person->>'net')::numeric, 0)) > 0.02 then
      raise exception 'Snapshot includes a member the server no longer recognizes. Refresh the app and try closing again.'
        using errcode = '23514';
    end if;
  end loop;
  -- ── End integrity gate ────────────────────────────────────────────────────

  -- ── FIX 2 (GV-253 / GVM-278): require requests before close ────────────────
  -- rule_require_requests_before_close (migration 098) shipped stored-only — this
  -- is its first database enforcement. When the workspace flag is NOT an explicit
  -- false, every settlement pair that moves money must already have a request row
  -- for this period in a requested-or-later state (status not 'open'/'cancelled').
  -- The period_snapshot settlements are safe to read here: integrity gate (c) just
  -- proved they reconcile each member's server-computed net, so they ARE the real
  -- outstanding pairs. A settlement_requests row is keyed by period + payer
  -- (from_member_id) + recipient (to_member_id), matching the snapshot fromId/toId.
  select l.rule_require_requests_before_close
    into v_rule_require_requests
    from public.ledgers l
    where l.id = target_ledger_id;

  if v_rule_require_requests is not false then
    for v_settlement in
      select value from jsonb_array_elements(coalesce(period_snapshot->'settlements', '[]'::jsonb))
    loop
      if coalesce((v_settlement->>'amount')::numeric, 0) > 0
         and not exists (
           select 1
           from public.settlement_requests sr
           where sr.period_id = target_period_id
             and sr.from_member_id = (v_settlement->>'fromId')::uuid
             and sr.to_member_id = (v_settlement->>'toId')::uuid
             and sr.status not in ('open', 'cancelled')
         ) then
        v_missing_settlements := v_missing_settlements + 1;
      end if;
    end loop;

    if v_missing_settlements > 0 then
      raise exception
        'All settlements must be requested before this period can be closed. Request the outstanding payments and try again.'
        using errcode = '42501';
    end if;
  end if;
  -- ── End require-requests-before-close ──────────────────────────────────────

  if snapshot_fingerprint is not null then
    select sp.id into duplicate_period_id
    from public.settlement_periods sp
    where sp.ledger_id = target_ledger_id
      and sp.status = 'closed'
      and sp.snapshot_json->>'entryFingerprint' = snapshot_fingerprint
    limit 1;

    if duplicate_period_id is not null then
      raise exception 'This settlement period snapshot has already been closed' using errcode = '23505';
    end if;
  end if;

  begin
    requested_closed_at := coalesce((period_snapshot->>'closedAt')::timestamptz, now());
  exception when others then
    requested_closed_at := now();
  end;

  update public.settlement_periods sp
  set status = 'closed',
      label = coalesce(nullif(period_snapshot->>'label', ''), sp.label, 'Closed period'),
      closed_at = requested_closed_at,
      closed_by_member_id = actor_member_id,
      snapshot_json = period_snapshot,
      updated_at = now()
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  returning sp.id into closed_period_id;

  if closed_period_id is null then
    raise exception 'Open settlement period was not found or was already closed' using errcode = '40001';
  end if;

  -- FIX 3 (GV-253): label the freshly opened period in Danish to match the app's
  -- own period labels (client formats da-DK month+year; demo data uses 'Juni
  -- 2026'). to_char(..., 'Month') only speaks English, so index a Danish month
  -- array by the current month and capitalize, e.g. 'Juli 2026'. Deterministic and
  -- server-clock based; the client overwrites this with its own snapshot label when
  -- it later closes, so it only shows while this is the current period.
  insert into public.settlement_periods (ledger_id, status, label, opened_at)
  values (
    target_ledger_id,
    'open',
    (array['Januar','Februar','Marts','April','Maj','Juni','Juli','August','September','Oktober','November','December'])[extract(month from now())::int]
      || ' ' || to_char(now(), 'YYYY'),
    now()
  )
  returning id into new_open_period_id;

  -- Activity feed + realtime nudge (GVM-247): closing a period writes a
  -- ledger_events row so every other member's client (subscribed to
  -- ledger_events) refetches immediately — otherwise the close only reaches them
  -- on a manual refresh. metadata carries both period ids for the feed/routing.
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, 'period_closed', 'Periode lukket', 'En ny periode er klar.',
    actor_member_id, nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
    jsonb_build_object('closed_period_id', closed_period_id, 'open_period_id', new_open_period_id)
  );

  return jsonb_build_object(
    'closed_period_id', closed_period_id,
    'open_period_id', new_open_period_id,
    'closed_by_member_id', actor_member_id,
    'closed_at', requested_closed_at,
    'entry_fingerprint', snapshot_fingerprint
  );
end;
$$;

revoke execute on function public.close_settlement_period(text, uuid, jsonb) from public;
grant execute on function public.close_settlement_period(text, uuid, jsonb) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('101_reassignment_and_close_invariants',
        'Identity-reassignment protection: one shared BEFORE UPDATE trigger (enforce_identity_reassignment) on trips/fuel_payments/car_bookings lets only a ledger admin or the row creator change driver_member_id/payer_member_id/member_id, covering both the SECURITY DEFINER upsert RPCs and direct PostgREST updates (42501). close_settlement_period re-declared off 087 to enforce rule_require_requests_before_close (every money-moving settlement pair needs a requested-or-later request row unless the workspace flag is false, GVM-278) and to label the new open period in Danish (Juli 2026 style) instead of English Current period (GV-253).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

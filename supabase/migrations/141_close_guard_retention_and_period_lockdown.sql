-- Migration 141: unblock period close, restore the repair retention rule, and remove the settlement_periods update policy (GV-358/GV-359/GV-351)
--
-- Three defects that all land on the settlement-period boundary.
--
-- GV-358 — closing a period became impossible. Migration 140 added
-- "(new.period_id is distinct from old.period_id)" to enforce_repair_period_lock's
-- guard set plus a requested/paid lock check. close_settlement_period's own
-- cleanup UPDATE (added in 114) binds legacy repairs carrying period_id IS NULL to
-- the period right before it closes, so it trips that guard:
-- settlement_entry_is_locked(ledger, NULL) falls back to the ledger's OPEN period,
-- and at close time a requested/paid/paid_pending request always exists because
-- rule_require_requests_before_close demands one — so every close aborted with
-- 42501 and a message about repairs. close_settlement_period does not set
-- govehlo.pii_scrub, and SECURITY DEFINER does not bypass triggers.
--
-- GV-359 — migration 140 re-declared enforce_repair_period_lock from migration
-- 112's body instead of migration 131's, its newest prior definition, silently
-- dropping 131's row-age retention carve-out. run_operational_retention could
-- still purge repair tombstones because it sets the scrub flag, but the standalone
-- age rule that 131 deliberately made flag-independent was gone.
--
-- GV-351 — "Ledger admins can update periods" (migration 005) was never dropped.
-- Migration 099 removed only the sibling INSERT policy, on the stated grounds that
-- every legitimate write is SECURITY DEFINER. The surviving UPDATE policy let any
-- workspace admin PATCH settlement_periods directly through PostgREST: flipping
-- the open period to 'closed' bricks the workspace (no snapshot, no event, no
-- successor open period, and 099 removed the INSERT policy so nothing can create
-- one), the reverse write thaws archived history away from its frozen snapshot,
-- and post-140 flipping a 'queued' row to 'open' yields two open periods and makes
-- the lock predicate non-deterministic.
--
-- Composition note (the lesson of GV-359): public.enforce_repair_period_lock below
-- is composed from migration 140's body VERBATIM plus migration 131's row-age
-- carve-out, so it carries both 140's carry-over behaviour and 131's retention
-- behaviour. public.close_settlement_period_unlocked below is migration 114's body
-- verbatim (renamed by migration 117, never re-declared since) with only the
-- repair-stamping UPDATE changed. Always state the ancestry here — 140's header
-- did not, and that is exactly how the drift went unnoticed.

-- ── GV-359 + GV-358: enforce_repair_period_lock ───────────────────────────────
-- 140 verbatim, with 131's retention carve-out restored ahead of the scrub gate.
create or replace function public.enforce_repair_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_closed boolean := false;
  v_guard boolean := tg_op = 'DELETE';
  v_rule_lock boolean;
begin
  -- Restored from migration 131 (GV-359). Migration 112 freezes repairs that
  -- belong to closed periods, including hard DELETE. Keep that invariant for the
  -- full accounting window, then permit only an already-soft-deleted tombstone
  -- outside the approved window to be purged. This rule is intrinsic to the row
  -- age, so it cannot be bypassed by setting a session flag; ordinary
  -- closed-period edits and deletes remain rejected.
  if tg_op = 'DELETE'
     and old.deleted_at is not null
     and old.deleted_at < date_trunc('year', now()) - interval '5 years' then
    return old;
  end if;

  if coalesce(current_setting('govehlo.pii_scrub', true), '') = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if old.period_id is not null then
    select (sp.status = 'closed' or sp.closed_at is not null)
      into v_period_closed
      from public.settlement_periods sp
      where sp.id = old.period_id
        and sp.ledger_id = old.ledger_id;
  else
    select exists (
      select 1
      from public.settlement_periods sp
      where sp.ledger_id = old.ledger_id
        and sp.closed_at is not null
        and old.created_at >= sp.opened_at
        and old.created_at < sp.closed_at
    ) into v_period_closed;
  end if;

  if v_period_closed then
    raise exception
      'This repair belongs to a closed settlement period and can no longer be edited or deleted.'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    v_guard := (new.cost_dkk is distinct from old.cost_dkk)
            or (new.paid_by_member_id is distinct from old.paid_by_member_id)
            or (new.period_id is distinct from old.period_id)
            or (new.deleted_at is distinct from old.deleted_at);
  end if;

  select l.rule_lock_period_after_payment
    into v_rule_lock
    from public.ledgers l
    where l.id = old.ledger_id;

  if v_guard and v_rule_lock is not false
     and public.settlement_entry_is_locked(old.ledger_id, old.period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. New repairs are saved for the next period; existing repairs cannot be changed.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_repair_period_lock() from public;
revoke all on function public.enforce_repair_period_lock() from anon;
revoke all on function public.enforce_repair_period_lock() from authenticated;

-- ── GV-358: close_settlement_period_unlocked ──────────────────────────────────
-- Migration 114's close body (renamed to *_unlocked by migration 117, which kept
-- the public close_settlement_period wrapper that takes the FOR UPDATE row lock
-- and then calls this function). Re-declared here verbatim except for the repair
-- stamping UPDATE, which now runs inside the transaction-local scrub bypass so the
-- 140 repair guard stops rejecting close's own cleanup write. The wrapper, the
-- signature, the integrity gate, the require-requests coverage, the duplicate
-- guard, the close/open pair, the event and the grants are unchanged.
create or replace function public.close_settlement_period_unlocked(
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
             and sr.amount = round((v_settlement->>'amount')::numeric, 2)
         ) then
        v_missing_settlements := v_missing_settlements + 1;
      end if;
    end loop;

    if v_missing_settlements > 0 then
      raise exception
        'All settlements must be requested at their current amounts before this period can be closed. Request or update the outstanding payments and try again.'
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

  -- GV-277: bind this period's remaining legacy null-period repairs to it BEFORE
  -- the period flips to closed, so period_id is authoritative for every repair
  -- once the period is closed. A stamped repair already carries period_id from
  -- insert_repair; only pre-114 rows are updated here, matched by the same
  -- created_at window the settlement/fingerprint use.
  --
  -- GV-358: since migration 140 the repair guard ALSO rejects a period_id change
  -- while the period is locked by a requested or paid settlement -- and close
  -- cannot legally run without those requests when
  -- rule_require_requests_before_close is on, so this statement rejected the
  -- close it belongs to. Reuse the transaction-local metadata bypass exactly as
  -- migration 140 does for trip workflow metadata: it is opened for this single
  -- server-authored statement and closed again immediately, no caller-controlled
  -- SQL runs while it is set, and the write only records the period a legacy
  -- repair already belonged to by created_at -- no amount, payer or membership
  -- changes, so neither the archived snapshot nor the fingerprint can move.
  perform set_config('govehlo.pii_scrub', '1', true);

  update public.vehicle_repairs vr
  set period_id = target_period_id
  from public.settlement_periods sp
  where sp.id = target_period_id
    and sp.ledger_id = target_ledger_id
    and vr.ledger_id = target_ledger_id
    and vr.period_id is null
    and vr.deleted_at is null
    and vr.created_at >= sp.opened_at
    and vr.created_at < requested_closed_at;

  perform set_config('govehlo.pii_scrub', '', true);

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

revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from public;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from anon;
revoke all on function public.close_settlement_period_unlocked(text, uuid, jsonb) from authenticated;

-- ── GV-351: settlement_periods is not client-writable ─────────────────────────
-- Every legitimate settlement_periods write is a SECURITY DEFINER RPC
-- (close_settlement_period, ensure_settlement_carryover_period, the owner
-- integrity batch), which runs as the function owner and is unaffected by client
-- policies or client grants. Every client reference is SELECT-only: govehlo-mobile
-- src/store/ledger-data-gateway.ts and src/lib/data-export.ts, govehlo-web
-- functions/api/public/km-rate.js, functions/api/owner/workspace/[id].js and
-- admin/admin.js. So the update policy has no legitimate caller.
drop policy if exists "Ledger admins can update periods" on public.settlement_periods;

-- Production policy NAMES have drifted from the migration files before (migration
-- 103 / PR #117 had to sweep pg_policies to actually clean prod), so pair the
-- by-name drop with a dynamic sweep: any UPDATE policy on this table is removed
-- whatever it happens to be called. SELECT policies are deliberately left alone --
-- both clients read this table -- which is also why policies declared FOR ALL are
-- not swept blind here; none exist, and dropping one would silently remove read
-- access.
do $$
declare
  v_policy record;
begin
  for v_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'settlement_periods'
      and cmd = 'UPDATE'
  loop
    execute format('drop policy %I on public.settlement_periods', v_policy.policyname);
  end loop;
end
$$;

-- Defence in depth, so a policy re-added by mistake still cannot be exercised over
-- PostgREST. This deliberately revokes only the write privileges rather than the
-- vehicle_incidents-style blanket "revoke all" + "grant select": settlement_periods
-- is read by the authenticated clients AND by service-role endpoints, so a blanket
-- revoke would risk the read paths (and any future service-role write) for no
-- additional protection against the JWT-driven writes this fixes.
revoke insert, update, delete on table public.settlement_periods from authenticated;
revoke insert, update, delete on table public.settlement_periods from anon;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '141_close_guard_retention_and_period_lockdown',
  'GV-358: close_settlement_period_unlocked (off 114) wraps its legacy-repair period_id stamping UPDATE in the transaction-local govehlo.pii_scrub bypass so migration 140''s repair guard no longer rejects close''s own cleanup write and aborts every period close. GV-359: enforce_repair_period_lock re-declared from 140''s body (its newest prior definition) with migration 131''s row-age GDPR carve-out restored, so it carries both the carry-over lock and the five-accounting-year retention rule. GV-351: the never-dropped "Ledger admins can update periods" policy on settlement_periods is dropped by name and by a dynamic pg_policies sweep (prod name drift), and insert/update/delete are revoked from anon and authenticated; all legitimate writes are SECURITY DEFINER and every client reference is SELECT-only.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

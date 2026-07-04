-- Migration 072: review hardening — deletion fuel_stop scrub, retention tenant scope, closed-period entry rails (GV-197, GV-198, GV-199)
--
-- Three verified review findings, bundled:
--
-- FIX A (GV-197, GDPR deletion completeness): delete_my_account never scrubbed
--   car_bookings.fuel_stop. That jsonb (migration 063) holds the booking's
--   from/to labels + lat/lng — the deleted member's route history, potentially
--   their home address. Re-declared verbatim from migration 071 with one new
--   scrub in the bookings section: for the member's bookings that carry a
--   fuel_stop, null the WHOLE jsonb. Station coords describe a public place, but
--   from/to are personal; simplest-correct wins, so the whole blob goes.
--
-- FIX B (GV-198, tenant scoping): run_retention_cleanup's push_subscriptions
--   DELETE was unscoped, so any self-service workspace admin could purge stale
--   rows for ALL users across every tenant. Impact is low (the table serves only
--   the decommissioned PWA), but the cross-tenant write pattern must go.
--   push_subscriptions is keyed by user_email with no ledger_id, so the DELETE
--   (and the matching preview count) is now scoped to emails that belong to a
--   member of the target ledger. The self-documenting return payload's
--   push_subscription_scope flips from 'global_user_device_records' to
--   'target_ledger_members'. Re-declared verbatim from migration 021 otherwise.
--
-- FIX C (GV-199, closed-period write rails): entries could be written INTO a
--   CLOSED settlement period three ways — a direct PostgREST insert (RLS checks
--   membership only), a direct update, and the RPC EDIT paths (which validate
--   only the OPEN period when stamping period_id on INSERT). The fix lives in the
--   settlement lock TRIGGER so every path is covered at once. enforce_settlement_
--   entry_lock now raises (errcode 22023) before its existing requested/paid lock
--   logic whenever the row's effective period is closed (status = 'closed' or
--   closed_at is not null). The trigger is additionally attached to
--   workspace_expenses (migration 065 shipped it without the trigger).
--
--   Deliberately trigger-only, NOT duplicated into the RLS with-check: the
--   trigger fires on every INSERT/UPDATE/DELETE path (RPC, direct REST, admin)
--   and is single-sourced, so a second RLS copy would only add drift risk.
--
--   Legit flows preserved:
--     * close_settlement_period only UPDATEs settlement_periods (no trigger) and
--       INSERTs a fresh open period; it never touches entry rows, so it is
--       unaffected — no bypass needed.
--     * Soft-deleting / editing OPEN-period entries is untouched (the check keys
--       on the row's own closed status, and the requested/paid lock is unchanged).
--     * delete_my_account scrubs PII on rows that may sit in CLOSED periods (trip
--       note nulling). To keep those GDPR erasures working, delete_my_account
--       sets a transaction-local GUC (govehlo.pii_scrub = '1') and the trigger
--       skips ONLY the closed-period check while it is set. The requested/paid
--       lock still applies — but delete_my_account already only touches columns
--       that lock does not guard (note), so nothing regresses. The GUC is the
--       least-surface exemption: it opens no path for a client, since clients
--       cannot call set_config inside delete_my_account's SECURITY DEFINER body.

-- ── FIX C part 1: guard + trigger function ─────────────────────────────────
-- settlement_entry_is_locked is unchanged in behaviour; re-declared verbatim so
-- the migration is self-contained and the consolidated schema mirror can carry
-- an identical trailing copy.
create or replace function public.settlement_entry_is_locked(
  p_ledger_id text,
  p_period_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period_id uuid := p_period_id;
begin
  if p_ledger_id is null or p_ledger_id = '' then
    return false;
  end if;

  -- Entries created through the trip/fuel RPCs always carry the open period id.
  -- Fall back to the ledger's open period for any row that has none.
  if v_period_id is null then
    select sp.id
      into v_period_id
      from public.settlement_periods sp
      where sp.ledger_id = p_ledger_id
        and sp.status = 'open'
      limit 1;
  end if;

  if v_period_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.settlement_requests sr
    join public.settlement_periods sp on sp.id = sr.period_id
    where sr.period_id = v_period_id
      and sp.status = 'open'
      and sr.status in ('requested', 'paid')
  );
end;
$$;

-- enforce_settlement_entry_lock, extended from migration 046 with a closed-period
-- rejection (GV-199) that runs BEFORE the existing requested/paid lock. It is
-- bypassed only for delete_my_account's PII scrubs via the govehlo.pii_scrub GUC.
create or replace function public.enforce_settlement_entry_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger_id text;
  v_period_id uuid;
  v_trip_deleted_at timestamptz;
  v_guard boolean := false;
  v_check_period_id uuid;
  v_period_closed boolean;
begin
  if tg_table_name = 'trip_participants' then
    -- Participants have no ledger/period of their own; inherit from the trip.
    -- Changing who shares a trip changes the split, so any insert/update/delete
    -- is guarded unless the parent trip is already a tombstone or is gone.
    if tg_op = 'DELETE' then
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = old.trip_id;
    else
      select t.ledger_id, t.period_id, t.deleted_at
        into v_ledger_id, v_period_id, v_trip_deleted_at
        from public.trips t
        where t.id = new.trip_id;
    end if;

    v_guard := v_ledger_id is not null and v_trip_deleted_at is null;

  elsif tg_op = 'INSERT' then
    v_ledger_id := new.ledger_id;
    v_period_id := new.period_id;
    -- Adding a live entry to a settling period changes the totals.
    v_guard := new.deleted_at is null;

  elsif tg_op = 'DELETE' then
    v_ledger_id := old.ledger_id;
    v_period_id := old.period_id;
    -- Removing a live entry changes the totals; purging a tombstone does not.
    v_guard := old.deleted_at is null;

  else -- UPDATE on trips / fuel_payments / workspace_expenses
    v_ledger_id := coalesce(new.ledger_id, old.ledger_id);
    v_period_id := coalesce(old.period_id, new.period_id);

    if tg_table_name = 'trips' then
      v_guard := (new.start_km is distinct from old.start_km)
              or (new.end_km is distinct from old.end_km)
              or (new.trip_date is distinct from old.trip_date)
              or (new.driver_member_id is distinct from old.driver_member_id)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    elsif tg_table_name = 'fuel_payments' then
      v_guard := (new.amount is distinct from old.amount)
              or (new.liters is distinct from old.liters)
              or (new.payer_member_id is distinct from old.payer_member_id)
              or (new.payment_date is distinct from old.payment_date)
              or (new.full_tank is distinct from old.full_tank)
              or (new.period_id is distinct from old.period_id)
              or (new.deleted_at is distinct from old.deleted_at);
    end if;

    -- Editing a row that is a tombstone before and after the change is a no-op
    -- for settlement; leave it alone.
    if old.deleted_at is not null and new.deleted_at is not null then
      v_guard := false;
    end if;
  end if;

  -- Closed-period rejection (GV-199): no path may add, change, or remove an entry
  -- that belongs to a closed settlement period. Runs before the requested/paid
  -- lock and covers every attached table. delete_my_account's GDPR scrubs set
  -- the transaction-local govehlo.pii_scrub GUC to opt out — those touch only
  -- non-settlement columns (e.g. trip note) and must succeed on closed rows.
  if coalesce(current_setting('govehlo.pii_scrub', true), '') <> '1' then
    v_check_period_id := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
    if tg_table_name = 'trip_participants' then
      v_check_period_id := v_period_id;
    end if;
    if v_check_period_id is not null then
      select (sp.status = 'closed' or sp.closed_at is not null)
        into v_period_closed
        from public.settlement_periods sp
        where sp.id = v_check_period_id;
      if v_period_closed then
        raise exception
          'This settlement period is closed — entries can no longer be added or changed.'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_guard and public.settlement_entry_is_locked(v_ledger_id, v_period_id) then
    raise exception
      'This settlement period is locked because a payment has been requested or paid. Reopen the payment before changing trips or fuel logs.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Attach the trigger to workspace_expenses (migration 065 created the table
-- without it, leaving expenses writable into closed periods). The trips /
-- fuel_payments / trip_participants triggers from migration 046 already exist;
-- re-create them idempotently so a fresh install and a replay match.
drop trigger if exists enforce_settlement_entry_lock_trips on public.trips;
create trigger enforce_settlement_entry_lock_trips
before insert or update or delete on public.trips
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_fuel on public.fuel_payments;
create trigger enforce_settlement_entry_lock_fuel
before insert or update or delete on public.fuel_payments
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_participants on public.trip_participants;
create trigger enforce_settlement_entry_lock_participants
before insert or update or delete on public.trip_participants
for each row execute function public.enforce_settlement_entry_lock();

drop trigger if exists enforce_settlement_entry_lock_expenses on public.workspace_expenses;
create trigger enforce_settlement_entry_lock_expenses
before insert or update or delete on public.workspace_expenses
for each row execute function public.enforce_settlement_entry_lock();

-- ── FIX B: run_retention_cleanup + preview, push_subscriptions tenant-scoped ─
-- Re-declared verbatim from migration 021, except the push_subscriptions
-- read/DELETE is now scoped to emails of the target ledger's members and the
-- returned push_subscription_scope reflects that.
create or replace function public.preview_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
  kept_report_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can preview retention cleanup';
  end if;

  select count(*) into event_count
  from public.ledger_events
  where ledger_id = target_ledger_id
    and (
      expires_at < now()
      or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
    );

  -- Tenant-scoped (GV-198): only this ledger's members' device records.
  select count(*) into push_count
  from public.push_subscriptions
  where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
    and user_email in (
      select lm.email
      from public.ledger_members lm
      where lm.ledger_id = target_ledger_id
        and lm.email is not null
    );

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), removable_reports as (
    select id
    from ranked_reports
    where newest_rank > greatest(keep_latest_test_lab_reports, 1)
       or retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
  )
  select count(*) into report_count from removable_reports;

  select count(*) into kept_report_count
  from public.test_lab_reports
  where ledger_id = target_ledger_id;
  kept_report_count := greatest(kept_report_count - report_count, 0);

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'kept_test_lab_reports', kept_report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'target_ledger_members'
  );
end;
$$;

create or replace function public.run_retention_cleanup(
  target_ledger_id text default 'main-car',
  event_retention_days integer default 30,
  stale_push_days integer default 180,
  test_lab_report_days integer default 30,
  keep_latest_test_lab_reports integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_count integer := 0;
  push_count integer := 0;
  report_count integer := 0;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can run retention cleanup';
  end if;

  with deleted_events as (
    delete from public.ledger_events
    where ledger_id = target_ledger_id
      and (
        expires_at < now()
        or created_at < now() - make_interval(days => greatest(event_retention_days, 1))
      )
    returning 1
  )
  select count(*) into event_count from deleted_events;

  -- Tenant-scoped (GV-198): a workspace admin may only purge stale device
  -- records for members of their own ledger, never every user's.
  with deleted_push as (
    delete from public.push_subscriptions
    where updated_at < now() - make_interval(days => greatest(stale_push_days, 30))
      and user_email in (
        select lm.email
        from public.ledger_members lm
        where lm.ledger_id = target_ledger_id
          and lm.email is not null
      )
    returning 1
  )
  select count(*) into push_count from deleted_push;

  with ranked_reports as (
    select
      id,
      row_number() over (order by synced_at desc, created_at desc, id desc) as newest_rank,
      coalesce(synced_at, created_at) as retention_at
    from public.test_lab_reports
    where ledger_id = target_ledger_id
  ), deleted_reports as (
    delete from public.test_lab_reports reports
    using ranked_reports ranked
    where reports.id = ranked.id
      and (
        ranked.newest_rank > greatest(keep_latest_test_lab_reports, 1)
        or ranked.retention_at < now() - make_interval(days => greatest(test_lab_report_days, 1))
      )
    returning 1
  )
  select count(*) into report_count from deleted_reports;

  return jsonb_build_object(
    'ledger_events', event_count,
    'global_stale_push_subscriptions', push_count,
    'stale_push_subscriptions', push_count,
    'test_lab_reports', report_count,
    'cloud_test_lab_reports', report_count,
    'event_retention_days', event_retention_days,
    'stale_push_days', stale_push_days,
    'test_lab_report_days', test_lab_report_days,
    'keep_latest_test_lab_reports', keep_latest_test_lab_reports,
    'push_subscription_scope', 'target_ledger_members'
  );
end;
$$;

revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.preview_retention_cleanup(text, integer, integer, integer, integer) from anon;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from public;
revoke all on function public.run_retention_cleanup(text, integer, integer, integer, integer) from anon;
grant execute on function public.preview_retention_cleanup(text, integer, integer, integer, integer) to authenticated;
grant execute on function public.run_retention_cleanup(text, integer, integer, integer, integer) to authenticated;

-- ── FIX A: delete_my_account scrubs car_bookings.fuel_stop ──────────────────
-- Re-declared verbatim from migration 071, with: (1) a transaction-local GUC set
-- so the settlement trigger permits PII scrubs on closed-period rows (GV-199),
-- and (2) a new fuel_stop null-out in the bookings section (GV-197).
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := public.current_user_email();
  v_member record;
  v_old_name text;
  v_first_name text;
  v_anon_name text;
  v_suffix integer;
  v_no_other_active boolean;
  v_successor record;
  v_ledgers_scrubbed integer := 0;
  v_ledgers_deleted integer := 0;
  v_admins_promoted integer := 0;
begin
  if v_uid is null or v_email is null then
    raise exception 'Account deletion requires a signed-in user' using errcode = '42501';
  end if;

  -- Let the settlement lock trigger (GV-199) know these writes are GDPR PII
  -- scrubs, not settlement edits, so its closed-period rejection stands aside.
  -- Transaction-local, so it clears automatically at commit/rollback.
  perform set_config('govehlo.pii_scrub', '1', true);

  for v_member in
    select lm.id, lm.ledger_id, lm.name, lm.role, lm.is_active
    from public.ledger_members lm
    where lm.email is not null
      and lower(lm.email) = v_email
  loop
    v_old_name := v_member.name;
    v_first_name := split_part(v_old_name, ' ', 1);

    -- No other active member left? The workspace dies with this account: nobody
    -- could ever access it again, so full deletion is the cleanest erasure.
    -- Every child table references ledgers(id) with on delete cascade.
    select not exists (
      select 1
      from public.ledger_members lm2
      where lm2.ledger_id = v_member.ledger_id
        and lm2.is_active = true
        and lm2.id <> v_member.id
    ) into v_no_other_active;
    if v_no_other_active then
      delete from public.ledgers l where l.id = v_member.ledger_id;
      v_ledgers_deleted := v_ledgers_deleted + 1;
      continue;
    end if;

    -- Admin succession: never leave a live workspace admin-less. Promote the
    -- longest-standing active member and say so in the feed (system actor).
    if v_member.is_active and v_member.role = 'admin' and not exists (
      select 1
      from public.ledger_members lm3
      where lm3.ledger_id = v_member.ledger_id
        and lm3.is_active = true
        and lm3.role = 'admin'
        and lm3.id <> v_member.id
    ) then
      select lm4.id, lm4.name
      into v_successor
      from public.ledger_members lm4
      where lm4.ledger_id = v_member.ledger_id
        and lm4.is_active = true
        and lm4.id <> v_member.id
      order by lm4.created_at asc, lm4.id asc
      limit 1;

      update public.ledger_members lm5
      set role = 'admin', updated_at = now()
      where lm5.id = v_successor.id;

      insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, target_member_id, metadata)
      values (
        v_member.ledger_id,
        'member_promoted',
        v_successor.name || ' er nu administrator',
        'Automatisk, fordi den tidligere administrator slettede sin konto',
        null,
        null,
        v_successor.id,
        jsonb_build_object('reason', 'account_deleted')
      );
      v_admins_promoted := v_admins_promoted + 1;
    end if;

    -- Per-ledger-unique anonymized name (unique(ledger_id, name) would reject a
    -- second 'Slettet medlem' in the same group).
    v_anon_name := 'Slettet medlem';
    v_suffix := 1;
    while exists (
      select 1
      from public.ledger_members lm6
      where lm6.ledger_id = v_member.ledger_id
        and lm6.name = v_anon_name
        and lm6.id <> v_member.id
    ) loop
      v_suffix := v_suffix + 1;
      v_anon_name := 'Slettet medlem ' || v_suffix;
    end loop;

    -- Authored free text: trip notes are the creator's words, not car facts.
    update public.trips t
    set note = null, updated_at = now()
    where t.ledger_id = v_member.ledger_id
      and t.created_by_member_id = v_member.id
      and t.note is not null;

    -- Bookings: purposes are authored text; future bookings would block the car
    -- for a person who no longer exists.
    update public.car_bookings cb
    set purpose = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.purpose is not null;

    -- Structured fuel stop (migration 063): the from/to labels + lat/lng are the
    -- member's route history — potentially their home address. Null the whole
    -- jsonb; station coords are public, but from/to are personal, so simplest-
    -- correct wins (GV-197).
    update public.car_bookings cb
    set fuel_stop = null, updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and (cb.member_id = v_member.id or cb.created_by_member_id = v_member.id)
      and cb.fuel_stop is not null;

    update public.car_bookings cb
    set deleted_at = now(), updated_at = now()
    where cb.ledger_id = v_member.ledger_id
      and cb.member_id = v_member.id
      and cb.start_at > now()
      and cb.deleted_at is null;

    -- Chat: blank + soft-delete their messages (the app already filters deleted).
    update public.messages msg
    set body = '', deleted_at = coalesce(msg.deleted_at, now())
    where msg.ledger_id = v_member.ledger_id
      and msg.sender_member_id = v_member.id;

    -- Feed events: drop stored emails and replace the member's name inside titles
    -- and bodies they authored or are targeted by. Events self-expire after 30
    -- days, so this is belt-and-braces on top of bounded retention. Very short
    -- first names (< 3 chars) are skipped for the substring pass — the collision
    -- risk with unrelated words outweighs the residual exposure.
    if char_length(v_first_name) < 3 then
      v_first_name := v_old_name;
    end if;
    update public.ledger_events ev
    set actor_email = case when ev.actor_member_id = v_member.id then null else ev.actor_email end,
        target_email = case when ev.target_member_id = v_member.id then null else ev.target_email end,
        title = replace(replace(ev.title, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem'),
        body = replace(replace(ev.body, v_old_name, 'Slettet medlem'), v_first_name, 'Slettet medlem')
    where ev.ledger_id = v_member.ledger_id
      and (ev.actor_member_id = v_member.id or ev.target_member_id = v_member.id);

    -- Archived snapshots: closed periods keep their maths, but the name fields
    -- inside people[] / settlements[] must stop identifying the person. The
    -- entry fingerprint (migration 054) covers trip/fuel ids only, never names,
    -- so this rewrite cannot invalidate any integrity check.
    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{people}',
      (
        select coalesce(jsonb_agg(
          case when person ->> 'id' = v_member.id::text
            then jsonb_set(person, '{name}', to_jsonb(v_anon_name))
            else person
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(sp.snapshot_json -> 'people') as person
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'people') = 'array';

    update public.settlement_periods sp
    set snapshot_json = jsonb_set(
      sp.snapshot_json,
      '{settlements}',
      (
        select coalesce(jsonb_agg(
          case when settled ->> 'toId' = v_member.id::text
            then jsonb_set(settled, '{toName}', to_jsonb(v_anon_name))
            else settled
          end
        ), '[]'::jsonb)
        from (
          select case when raw ->> 'fromId' = v_member.id::text
            then jsonb_set(raw, '{fromName}', to_jsonb(v_anon_name))
            else raw
          end as settled
          from jsonb_array_elements(sp.snapshot_json -> 'settlements') as raw
        ) as renamed
      )
    )
    where sp.ledger_id = v_member.ledger_id
      and sp.snapshot_json is not null
      and jsonb_typeof(sp.snapshot_json -> 'settlements') = 'array';

    -- Invites addressed to this email in this ledger.
    update public.ledger_invites li
    set invited_email = null, updated_at = now()
    where li.ledger_id = v_member.ledger_id
      and lower(coalesce(li.invited_email, '')) = v_email;

    -- Finally the member row itself. Role drops to 'member' (succession above
    -- already ensured another admin exists when one was needed).
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
        updated_at = now()
    where lm7.id = v_member.id;

    -- Feed transparency, in app voice, without re-publishing the old name.
    insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
    values (
      v_member.ledger_id,
      'member_deleted',
      'Et medlem slettede sin konto',
      v_anon_name || ' er anonymiseret. Gruppens regnskab er uændret.',
      null,
      null,
      jsonb_build_object('member_id', v_member.id)
    );

    v_ledgers_scrubbed := v_ledgers_scrubbed + 1;
  end loop;

  -- Cross-ledger cleanup keyed by identity rather than membership.
  delete from public.push_subscriptions ps
  where lower(ps.user_email) = v_email;

  delete from public.ledger_onboarding_rate_limits rl
  where lower(rl.actor_email) = v_email;

  update public.owner_activity_log oal
  set actor_email = null, actor_user_id = null
  where oal.actor_user_id = v_uid
     or lower(coalesce(oal.actor_email, '')) = v_email;

  -- Push tokens die with the account (migration 057): match by user id and by
  -- the scrubbed email so nothing keeps addressing this person's devices.
  delete from public.expo_push_tokens ept
  where ept.user_id = v_uid
     or lower(ept.email) = v_email;

  -- Kill the credentials last: cascades sessions/identities, frees the email for
  -- a fresh sign-up. The caller's JWT stays technically valid until expiry but no
  -- longer matches any member (email scrubbed), so RLS yields nothing.
  delete from auth.users au where au.id = v_uid;

  return jsonb_build_object(
    'ledgers_scrubbed', v_ledgers_scrubbed,
    'ledgers_deleted', v_ledgers_deleted,
    'admins_promoted', v_admins_promoted
  );
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('072_review_hardening', 'Review hardening: delete_my_account scrubs car_bookings.fuel_stop (GV-197); run_retention_cleanup push_subscriptions DELETE scoped to the target ledger''s members (GV-198); enforce_settlement_entry_lock rejects writes into closed periods across trips/fuel/expenses, with a PII-scrub GUC bypass for delete_my_account (GV-199)')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

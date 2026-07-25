-- Migration 149: stop storing every user's e-mail in the API throttle counter (GV-385)
--
-- public.owner_api_rate_limits.actor_email held a verified e-mail address, in clear
-- text, forever. Six of the seven writers are ordinary users, not operators: the
-- /api/mobile/* proxies (address-suggest, trip-distance, nearby-stations,
-- vehicle-registry, receipt-ocr, activity) all route through checkUserRate() in
-- govehlo-web functions/api/_auth.js, which reuses this owner-named limiter. Nothing
-- ever read the column back, no retention sweep touched the table, and
-- delete_my_account() had no reference to it -- so a deletion request left the row
-- standing. Both a data-minimisation problem and an article 17 hole.
--
-- ONE CORRECTION TO THE TICKET, since it changes nothing but should be on the record:
-- the table has TWO readers, not one. owner/ocr-telemetry.js (GV-231) and
-- owner/external-usage.js (GV-239) both select it. Neither reads the actor: both ask
-- only for (action, attempts, window_started_at) and aggregate by action over a 7-day
-- window. The conclusion the ticket drew therefore stands, and it is what makes the fix
-- below safe -- no reader loses anything.
--
-- THE DECISION: the limiter needs to tell actors APART, so one user's burst cannot eat
-- another's budget. It does not need to know WHO they are. Dropping the column outright
-- would collapse every caller into one bucket and silently turn a per-user limit into a
-- global one, so the column is replaced by a keyed digest instead:
--
--   1. A single-row pepper table, readable by NOBODY -- every grant revoked, including
--      service_role. Only the owner (postgres) reaches it, which in practice means only
--      through the security-definer functions below. That is the difference that
--      matters: an unsalted sha256 of an e-mail is trivially reversed by running the
--      user list through the same hash, so an unsalted digest would leave the admin
--      console (service role) able to re-identify every row. With the pepper out of its
--      reach, no reader of owner_api_rate_limits can.
--   2. actor_email is RENAMED to actor_hash and the existing values are digested in
--      place, so the unique key (actor, action, window) and its index carry over
--      untouched and no live throttle state is lost.
--   3. check_owner_rate_limit hashes internally. Its JSON parameter contract is
--      unchanged -- callers still send actor_email -- so NO govehlo-web change ships
--      with this migration.
--
-- Plus the two paths the ticket asked for, because a pepper is a pseudonym, not an
-- erasure: run_operational_retention now purges counters older than 30 days, and
-- delete_my_account deletes the caller's rows by recomputing the digest.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The pepper                                                          (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One row, one column that matters. Generated per database, so the digests in
-- owner_api_rate_limits are unlinkable to an address for anyone who cannot read this
-- table -- and nobody can: RLS is on with no policy, and every grant is revoked
-- including service_role, so the only access left is the table owner's, i.e. the
-- security-definer functions below.

create table if not exists public.rate_limit_actor_pepper (
  id boolean primary key default true check (id),
  pepper text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);

comment on table public.rate_limit_actor_pepper is
  'Single-row secret used to key the actor digests in owner_api_rate_limits (GV-385). Never expose it: no policy, no grant, service_role included. Rotating the value is safe -- it only resets throttle buckets.';

alter table public.rate_limit_actor_pepper enable row level security;

revoke all on public.rate_limit_actor_pepper from public;
revoke all on public.rate_limit_actor_pepper from anon;
revoke all on public.rate_limit_actor_pepper from authenticated;
revoke all on public.rate_limit_actor_pepper from service_role;

insert into public.rate_limit_actor_pepper (id) values (true)
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. The digest helper                                                   (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Same normalisation the limiter always applied (lower + btrim) so an address maps to
-- one bucket however it is typed. security definer because the pepper is unreadable
-- otherwise; no grant to anyone, since both callers are themselves security-definer
-- functions running as the owner. Follows migration 028's hash_ledger_invite_code
-- shape, with the pepper added -- an invite code carries its own entropy, an e-mail
-- address does not.

create or replace function public.hash_rate_limit_actor(actor_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(
    extensions.digest(
      lower(btrim(coalesce(actor_email, ''))) || (select p.pepper from public.rate_limit_actor_pepper p where p.id),
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.hash_rate_limit_actor(text) from public;
revoke all on function public.hash_rate_limit_actor(text) from anon;
revoke all on function public.hash_rate_limit_actor(text) from authenticated;
revoke all on function public.hash_rate_limit_actor(text) from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Replace the address with its digest, in place                       (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- RENAME rather than add-and-drop: the unique constraint (actor, action, window) and
-- owner_api_rate_limits_actor_idx follow the column automatically, so live throttle
-- state survives the migration instead of every user getting a fresh allowance. The
-- guard makes the whole step idempotent -- on a re-run the column is already
-- actor_hash and the digests must NOT be hashed a second time.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'owner_api_rate_limits'
      and column_name = 'actor_email'
  ) then
    alter table public.owner_api_rate_limits rename column actor_email to actor_hash;
    update public.owner_api_rate_limits arl
    set actor_hash = public.hash_rate_limit_actor(arl.actor_hash);
  end if;
end $$;

comment on table public.owner_api_rate_limits is
  'Fixed-window request counts for the owner API and the /api/mobile/* proxies (GV-156, GV-204). Service-role only. Rows are ephemeral throttle state, not an audit trail (see owner_activity_log) -- and since GV-385 they are pseudonymous: the actor is a peppered digest, run_operational_retention purges rows older than 30 days, and delete_my_account erases the caller''s.';

comment on column public.owner_api_rate_limits.actor_hash is
  'Peppered sha256 of the normalised actor e-mail (GV-385). Discriminates callers for throttling; identifies none of them. Was actor_email, in clear text, until migration 149.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. The limiter writes the digest                                       (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 100 (its newest prior definition), verbatim except for the
-- hashing. #variable_conflict use_column stays: the 42702 that migration 100 fixed came
-- from the actor_email parameter shadowing the same-named column in the ON CONFLICT
-- target, and while THAT collision is gone with the rename, the RETURNS TABLE column
-- `attempts` still shadows the table's, which is what the pragma resolves. Parameter
-- names are unchanged on purpose -- the Cloudflare Functions call this RPC with named
-- JSON parameters and renaming any of them would break that contract.

create or replace function public.check_owner_rate_limit(
  actor_email text,
  limit_action text default 'owner.api',
  max_attempts integer default 60,
  window_seconds integer default 60
)
returns table (
  allowed boolean,
  attempts integer,
  limit_value integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  safe_email text := nullif(lower(btrim(coalesce(actor_email, ''))), '');
  safe_actor text;
  safe_action text := coalesce(nullif(btrim(coalesce(limit_action, '')), ''), 'owner.api');
  safe_max integer := greatest(coalesce(max_attempts, 60), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_email is null then
    raise exception 'actor_email is required for owner rate limiting' using errcode = 'P0001';
  end if;

  -- GV-385: the counter stores a keyed digest of the actor, never the address
  -- itself. Hashing here rather than at the caller keeps the RPC's JSON parameter
  -- contract (actor_email / limit_action / max_attempts / window_seconds) exactly as
  -- the Cloudflare Functions send it, so no client changes with this migration.
  safe_actor := public.hash_rate_limit_actor(safe_email);

  -- Fixed window aligned to safe_window-second boundaries from the epoch.
  window_start := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);

  insert into public.owner_api_rate_limits (actor_hash, action, window_started_at, attempts, last_attempt_at)
  values (safe_actor, safe_action, window_start, 1, now())
  on conflict (actor_hash, action, window_started_at)
  do update set attempts = public.owner_api_rate_limits.attempts + 1,
               last_attempt_at = now()
  returning public.owner_api_rate_limits.attempts into current_attempts;

  return query
  select
    current_attempts <= safe_max,
    current_attempts,
    safe_max,
    greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => safe_window) - now())))::integer);
end;
$$;

revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from public;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from authenticated;
grant execute on function public.check_owner_rate_limit(text, text, integer, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Retention: counters expire                                          (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 131 (its newest prior definition), verbatim plus an
-- eleventh table. The sweep already runs daily; it simply never looked here.

create or replace function public.run_operational_retention(
  p_stale_push_days integer default 180,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_tokens integer := 0;
  v_expired_events integer := 0;
  v_deleted_messages integer := 0;
  v_deleted_bookings integer := 0;
  v_deleted_recurring_templates integer := 0;
  v_deleted_trips integer := 0;
  v_deleted_fuel_payments integer := 0;
  v_deleted_workspace_expenses integer := 0;
  v_deleted_vehicle_repairs integer := 0;
  v_deleted_owner_activity integer := 0;
  v_deleted_rate_limit_counters integer := 0;
  v_short_cutoff timestamptz := now() - interval '90 days';
  v_financial_cutoff timestamptz := date_trunc('year', now()) - interval '5 years';
  v_audit_cutoff timestamptz := now() - interval '24 months';
  -- GV-385: throttle counters are working state, not history. The longest window any
  -- caller configures is a day, and the two admin readers (owner/ocr-telemetry and
  -- owner/external-usage) both look back 7 days, so 30 days is already generous.
  v_rate_limit_cutoff timestamptz := now() - interval '30 days';
begin
  if p_stale_push_days is null or p_stale_push_days < 30 or p_stale_push_days > 3650 then
    raise exception 'p_stale_push_days must be between 30 and 3650' using errcode = '22023';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run must not be null' using errcode = '22023';
  end if;

  if p_dry_run then
    select count(*) into v_stale_tokens from public.expo_push_tokens
    where updated_at < now() - make_interval(days => p_stale_push_days);
    select count(*) into v_expired_events from public.ledger_events
    where expires_at is not null and expires_at < now();
    select count(*) into v_deleted_messages from public.messages where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_bookings from public.car_bookings where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_recurring_templates from public.recurring_expenses where deleted_at < v_short_cutoff;
    select count(*) into v_deleted_trips from public.trips where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_fuel_payments from public.fuel_payments where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_workspace_expenses from public.workspace_expenses where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_vehicle_repairs from public.vehicle_repairs where deleted_at < v_financial_cutoff;
    select count(*) into v_deleted_owner_activity from public.owner_activity_log where created_at < v_audit_cutoff;
    select count(*) into v_deleted_rate_limit_counters from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff;
  else
    with purged as (delete from public.expo_push_tokens where updated_at < now() - make_interval(days => p_stale_push_days) returning 1)
      select count(*) into v_stale_tokens from purged;
    with purged as (delete from public.ledger_events where expires_at is not null and expires_at < now() returning 1)
      select count(*) into v_expired_events from purged;
    with purged as (delete from public.messages where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_messages from purged;
    with purged as (delete from public.car_bookings where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_bookings from purged;
    with purged as (delete from public.recurring_expenses where deleted_at < v_short_cutoff returning 1)
      select count(*) into v_deleted_recurring_templates from purged;

    -- Closed-period entry triggers deliberately freeze accounting history. The
    -- account-deletion path already uses this transaction-local gate for GDPR
    -- scrubs; enable it only inside this service-role-only function and only
    -- around tombstones that have outlived the accounting retention window.
    perform set_config('govehlo.pii_scrub', '1', true);
    with purged as (delete from public.trips where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_trips from purged;
    with purged as (delete from public.fuel_payments where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_fuel_payments from purged;
    with purged as (delete from public.workspace_expenses where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_workspace_expenses from purged;
    with purged as (delete from public.vehicle_repairs where deleted_at < v_financial_cutoff returning 1)
      select count(*) into v_deleted_vehicle_repairs from purged;
    perform set_config('govehlo.pii_scrub', '', true);
    with purged as (delete from public.owner_activity_log where created_at < v_audit_cutoff returning 1)
      select count(*) into v_deleted_owner_activity from purged;
    with purged as (delete from public.owner_api_rate_limits where window_started_at < v_rate_limit_cutoff returning 1)
      select count(*) into v_deleted_rate_limit_counters from purged;
  end if;

  return jsonb_build_object(
    'staleExpoPushTokens', v_stale_tokens,
    'expiredLedgerEvents', v_expired_events,
    'deletedMessages', v_deleted_messages,
    'deletedBookings', v_deleted_bookings,
    'deletedRecurringTemplates', v_deleted_recurring_templates,
    'deletedTrips', v_deleted_trips,
    'deletedFuelPayments', v_deleted_fuel_payments,
    'deletedWorkspaceExpenses', v_deleted_workspace_expenses,
    'deletedVehicleRepairs', v_deleted_vehicle_repairs,
    'deletedOwnerActivity', v_deleted_owner_activity,
    'deletedRateLimitCounters', v_deleted_rate_limit_counters,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'rateLimitRetentionDays', 30,
    'ranAt', now()
  );
end;
$$;

revoke all on function public.run_operational_retention(integer, boolean) from public;
revoke all on function public.run_operational_retention(integer, boolean) from anon;
revoke all on function public.run_operational_retention(integer, boolean) from authenticated;
grant execute on function public.run_operational_retention(integer, boolean) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Erasure: deletion reaches the counter                               (GV-385)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 147 (its newest prior definition), verbatim plus one
-- delete, placed with the other cross-ledger cleanups that key on identity rather than
-- membership -- next to its sibling, ledger_onboarding_rate_limits, which has been
-- cleaned up there all along.

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

    -- Incident photos (GVM-396): the photos belong to the workspace (they die with
    -- the incident or the workspace via cascade). Only the authorship pointer is
    -- personal, so detach it. The incident rows' own reporter/driver references
    -- are left pointing at this member row, which is anonymized in place below —
    -- exactly like trips.driver_member_id and every other retained reference.
    update public.vehicle_incident_photos vip
    set created_by_member_id = null
    where vip.ledger_id = v_member.ledger_id
      and vip.created_by_member_id = v_member.id;

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
    -- already ensured another admin exists when one was needed). last_seen_at is
    -- nulled too (GVM-66): activity metadata must not outlive the account.
    update public.ledger_members lm7
    set name = v_anon_name,
        email = null,
        mobilepay_phone = null,
        role = 'member',
        is_active = false,
        last_seen_at = null,
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
  delete from public.ledger_onboarding_rate_limits rl
  where lower(rl.actor_email) = v_email;

  -- The owner/mobile API throttle counter (migration 049; pseudonymised by this
  -- migration). The row no longer holds an address, but its key is still DERIVED from
  -- one, so article 17 reaches it: recompute the same keyed digest and delete. Without
  -- this line the only thing that ever removed it would be the 30-day sweep.
  delete from public.owner_api_rate_limits arl
  where arl.actor_hash = public.hash_rate_limit_actor(v_email);

  update public.owner_activity_log oal
  set actor_email = null, actor_user_id = null
  where oal.actor_user_id = v_uid
     or lower(coalesce(oal.actor_email, '')) = v_email;

  -- Push tokens die with the account (migration 057): match by user id and by
  -- the scrubbed email so nothing keeps addressing this person's devices.
  delete from public.expo_push_tokens ept
  where ept.user_id = v_uid
     or lower(ept.email) = v_email;


  -- Purge this user's notification preferences (GV-229). No PII (three booleans
  -- + a uuid), but data minimisation says don't leave an orphaned row behind.
  delete from public.notification_preferences np where np.user_id = v_uid;

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

-- `create or replace` preserves the ACL (the grant dates from 056, re-asserted by
-- 083). Restated by name so this file is readable on its own, and so anon is denied
-- explicitly rather than by inheritance.
revoke all on function public.delete_my_account() from public;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '149_rate_limit_actor_pseudonymisation',
  'GV-385: owner_api_rate_limits.actor_email stored every user''s verified e-mail in clear text, forever, with no reader, no retention sweep and no reference from delete_my_account. Six of its seven writers are ordinary users, not operators -- the /api/mobile/* proxies all route through checkUserRate() in govehlo-web functions/api/_auth.js, which reuses this owner-named limiter. Correction to the ticket: the table has TWO readers, not one (owner/ocr-telemetry.js GV-231 and owner/external-usage.js GV-239), but neither reads the actor -- both select only (action, attempts, window_started_at) and aggregate by action over 7 days, so the ticket''s conclusion stands and the fix costs no reader anything. The limiter needs to tell actors apart, not to know who they are, so the column is REPLACED rather than dropped: dropping it would collapse every caller into one bucket and turn a per-user limit into a global one. actor_email is renamed to actor_hash in place -- keeping the (actor, action, window) unique key, its index and all live throttle state -- and the values are digested with a per-database pepper held in a new single-row table that has RLS on, no policy and every grant revoked including service_role, so only the owner (i.e. the security-definer functions) can read it. The pepper is the point: an unsalted sha256 of an e-mail is reversed by hashing the known user list, which would leave the admin console able to re-identify every row. check_owner_rate_limit is re-declared off migration 100 (its newest prior definition), verbatim except that it hashes internally, so its named-JSON parameter contract is untouched and NO govehlo-web change ships with this migration; #variable_conflict use_column stays because the RETURNS TABLE column attempts still shadows the table''s even though the actor_email collision migration 100 fixed is gone. Because a pepper is a pseudonym and not an erasure, both paths the ticket asked for are added too: run_operational_retention (re-declared off 131) purges counters older than 30 days -- the longest configured window is a day and both admin readers look back 7 -- reporting deletedRateLimitCounters, and delete_my_account (re-declared off 147) deletes the caller''s rows by recomputing the digest, next to the sibling ledger_onboarding_rate_limits cleanup it sits beside.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 147: retire ten dead RPCs and the legacy push_subscriptions table (GV-311, GV-383, GV-392)
--
-- Three tickets, one file, because they collide in the same two objects.
--
--   GV-383 — drop ten functions with no caller anywhere.
--   GV-311 — retire the legacy Web Push store: delete_my_account stops scrubbing
--            public.push_subscriptions, then the table goes with it.
--   GV-392 — supabase-schema.sql was missing three tracker INSERTs, so a database
--            provisioned from the consolidated schema booted reporting its own drift.
--            Backfilled idempotently here; the mirror guard is tightened in the same
--            commit so the masking cannot recur.
--
-- ORDER IS LOAD-BEARING. fuel_ledger_healthcheck enumerates ten of the dropped
-- functions in critical_rpc_names, the dropped table in expected_tables and
-- expected_columns, and three of the dropped functions again in
-- workspace_readiness.invite_onboarding_ready. Re-declare the diagnostic FIRST, drop
-- SECOND — otherwise the operator healthcheck reports, forever, that objects are
-- missing which it is itself the only thing still asking for. That is the trap
-- migration 143 handled for production_activity_reset and migration 130 deferred its
-- drops over.
--
-- ── What was verified before dropping anything ────────────────────────────────
--
-- GV-379 (PR #191) produced the deletion analysis. Its own lesson was that migration
-- TEXT is not the end state -- 083/130/131/143 revoke as well as grant -- so every
-- claim below was re-checked against the REPLAYED catalog (pg_proc, pg_policy,
-- pg_trigger, pg_attrdef, pg_constraint, pg_index, pg_views) on Postgres 17, not by
-- grepping migrations. For each of the ten: zero in-SQL callers, zero RLS policy
-- references, zero trigger bindings, zero column defaults / check constraints / index
-- expressions / view definitions, and zero call sites in either client repo once the
-- vendored generated types are discounted. Both indirection conventions GV-379 found
-- were searched for by name: the string-literal lookup table behind sbRpc(env, rpc, …)
-- and the unquoted PostgREST path /rest/v1/rpc/<name>.
--
-- NOT DROPPED, deliberately:
--   * enforce_onboarding_rate_limit -- it sits in critical_rpc_names next to the ten
--     and no client calls it, but it has FIVE live in-SQL callers
--     (create_private_ledger_workspace, redeem_ledger_invite, resolve_ledger_invite,
--     rotate_workspace_join_code, and create_ledger_invite which this migration drops).
--     Uncallable from a client is not dead. Its critical_rpc_names entry stays.
--   * hash_ledger_invite_code, normalize_ledger_slug -- same shape, live in-SQL
--     helpers. hash_ledger_invite_code keeps redeem_ledger_invite and
--     resolve_ledger_invite as callers after this migration.
--   * public.ledger_invites (the TABLE) -- migration 143 made the legacy invite path
--     WRITE-CLOSED by leaving create_ledger_invite as its only writer, and this
--     migration drops that writer. Write-closed is not dead: resolve_ledger_invite and
--     redeem_ledger_invite still READ it for pre-143 rows and delete_my_account still
--     UPDATEs it. The table, its columns and its policies stay in the healthcheck's
--     expectation lists.
--   * public.test_lab_reports (the TABLE) -- upsert_test_lab_report and
--     purge_generated_test_rows are dropped, but the stored reports and their
--     immutable-history trigger (migration 019) are untouched.
--
-- Applied MANUALLY in the Supabase SQL Editor. Merging the PR applies nothing.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. fuel_ledger_healthcheck -- stop asking for what step 3 removes  (GV-383/GV-311)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 143 (its newest prior definition -- the GV-202 rule; an
-- equivalence check structurally cannot catch drift introduced by an intermediate
-- definition, so the base has to be the highest-numbered one). The body is 143
-- VERBATIM apart from four deletions, all of them entries naming objects this
-- migration removes:
--
--   a. critical_rpc_names loses its ten dead entries, 21 -> 11. What survives is the
--      list of RPCs a client can actually reach, which is what a "critical RPC"
--      diagnostic was ever supposed to mean.
--   b. expected_tables loses ('push_subscriptions').
--   c. expected_columns loses ('push_subscriptions', 'user_email').
--   d. workspace_readiness.invite_onboarding_ready loses its create_ledger_invite,
--      revoke_ledger_invite and check_ledger_invite_email existence probes. It keeps
--      the ledger_invites TABLE probe and the redeem_ledger_invite probe, which is
--      now exactly what "invite onboarding is ready" means: members still join by
--      redeeming a join code (migration 045), which is what superseded these three.
--
-- NOTHING ELSE CHANGES -- in particular expected_schema_migrations is left exactly as
-- migration 143 left it. It is a frozen list ending at 037 and it is the SUBJECT of
-- GV-392 below, not a target: editing it here would move the very strings whose
-- accidental presence was masking the missing tracker rows.
create or replace function public.fuel_ledger_healthcheck(target_ledger_id text default 'main-car')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with critical_rpc_names(rpc_name) as (
    values
      ('close_settlement_period'),
      ('upsert_trip_with_participants'),
      ('upsert_fuel_payment'),
      ('upsert_car_booking'),
      ('soft_delete_car_booking'),
      ('upsert_settlement_request_status'),
      ('upsert_ledger_member_admin'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('enforce_onboarding_rate_limit'),
      ('redeem_ledger_invite')
  ),
  critical_rpc_status as (
    select jsonb_object_agg(
      rpc_name,
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = rpc_name
      )
      order by rpc_name
    ) as critical_rpcs
    from critical_rpc_names
  ),
  expected_schema_migrations(migration_id) as (
    values
      ('001_initial_schema'),
      ('002_auth_helpers'),
      ('003_payment_booking_guards'),
      ('004_period_close_and_admin_rpcs'),
      ('005_rls_policies'),
      ('006_realtime_ledger_events'),
      ('007_security_health_rpc'),
      ('008_scheduled_reminder_rpcs'),
      ('009_retention_privacy_cleanup'),
      ('010_trip_transaction_rpc'),
      ('011_booking_transaction_rpcs'),
      ('012_admin_tools_guardrails'),
      ('013_fuel_payment_rpc'),
      ('014_rpc_health_visibility'),
      ('015_test_lab_report_store'),
      ('016_realtime_publication_health'),
      ('017_healthcheck_rpc_detection_fix'),
      ('018_realtime_publication_cleanup'),
      ('019_immutable_test_lab_report_history'),
      ('020_bootstrap_lock'),
      ('021_cloud_test_lab_report_retention'),
      ('022_settlement_request_transaction_rpc'),
      ('023_schema_migration_tracking'),
      ('024_schema_drift_healthcheck'),
      ('025_workspace_foundation'),
      ('026_invite_onboarding_foundation'),
      ('027_invite_code_generation_pgcrypto_fix'),
      ('028_invite_code_hash_pgcrypto_fix'),
      ('029_invite_redeem_return_ambiguity_fix'),
      ('030_onboarding_abuse_rate_limits'),
      ('031_payment_status_action_rpc'),
      ('032_security_health_current_migration_expectations'),
      ('033_onboarding_rate_limit_scope_key_alignment'),
      ('034_invite_rate_limit_actor_email_ambiguity_fix'),
      ('035_sql_ambiguity_guardrail'),
      ('036_invite_profile_setup'),
      ('037_invite_email_preflight')
  ),
  migration_status as (
    select
      (select max(migration_id) from expected_schema_migrations) as latest_expected,
      (select max(migration_id) from public.fuel_ledger_schema_migrations) as latest_applied,
      coalesce((
        select jsonb_agg(e.migration_id order by e.migration_id)
        from expected_schema_migrations e
        where not exists (
          select 1
          from public.fuel_ledger_schema_migrations m
          where m.migration_id = e.migration_id
        )
      ), '[]'::jsonb) as missing_migrations,
      coalesce((
        select jsonb_agg(m.migration_id order by m.migration_id)
        from public.fuel_ledger_schema_migrations m
        where not exists (
          select 1
          from expected_schema_migrations e
          where e.migration_id = m.migration_id
        )
      ), '[]'::jsonb) as extra_migrations
  ),
  expected_tables(table_name) as (
    values
      ('ledgers'),
      ('ledger_members'),
      ('ledger_invites'),
      ('ledger_onboarding_rate_limits'),
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('test_lab_reports'),
      ('fuel_ledger_schema_migrations')
  ),
  missing_tables as (
    select coalesce(jsonb_agg(format('public.%I', table_name) order by table_name), '[]'::jsonb) as items
    from expected_tables et
    where not exists (
      select 1
      from information_schema.tables t
      where t.table_schema = 'public'
        and t.table_name = et.table_name
    )
  ),
  expected_columns(table_name, column_name) as (
    values
      ('ledgers', 'id'),
      ('ledgers', 'slug'),
      ('ledgers', 'name'),
      ('ledgers', 'created_by_member_id'),
      ('ledgers', 'is_public_signup_enabled'),
      ('ledgers', 'invite_required'),
      ('ledgers', 'bootstrap_locked_at'),
      ('ledger_members', 'ledger_id'),
      ('ledger_members', 'email'),
      ('ledger_members', 'role'),
      ('ledger_members', 'is_active'),
      ('ledger_invites', 'ledger_id'),
      ('ledger_invites', 'invite_code_hash'),
      ('ledger_invites', 'role'),
      ('ledger_invites', 'invited_email'),
      ('ledger_invites', 'max_uses'),
      ('ledger_invites', 'uses_count'),
      ('ledger_invites', 'expires_at'),
      ('ledger_invites', 'revoked_at'),
      ('ledger_onboarding_rate_limits', 'action'),
      ('ledger_onboarding_rate_limits', 'scope_key'),
      ('ledger_onboarding_rate_limits', 'window_started_at'),
      ('ledger_onboarding_rate_limits', 'attempts'),
      ('trips', 'ledger_id'),
      ('trips', 'driver_member_id'),
      ('trip_participants', 'trip_id'),
      ('trip_participants', 'member_id'),
      ('fuel_payments', 'ledger_id'),
      ('fuel_payments', 'payer_member_id'),
      ('car_bookings', 'ledger_id'),
      ('car_bookings', 'member_id'),
      ('settlement_requests', 'ledger_id'),
      ('settlement_requests', 'status'),
      ('settlement_periods', 'ledger_id'),
      ('ledger_events', 'ledger_id'),
      ('ledger_events', 'event_type'),
      ('test_lab_reports', 'report_payload'),
      ('fuel_ledger_schema_migrations', 'migration_id')
  ),
  missing_columns as (
    select coalesce(jsonb_agg(format('public.%I.%I', table_name, column_name) order by table_name, column_name), '[]'::jsonb) as items
    from expected_columns ec
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = ec.table_name
        and c.column_name = ec.column_name
    )
  ),
  expected_policies(table_name, policy_name) as (
    values
      ('ledgers', 'Ledger members can read ledgers'),
      ('ledger_members', 'Ledger members can read members'),
      ('ledger_invites', 'Ledger admins can read invites'),
      ('ledger_invites', 'Ledger admins can update invites'),
      ('trips', 'Ledger members can read trips'),
      ('trip_participants', 'Ledger members can read trip participants'),
      ('fuel_payments', 'Ledger members can read fuel payments'),
      ('car_bookings', 'Ledger members can read car bookings'),
      ('settlement_requests', 'Ledger members can read settlement requests'),
      ('ledger_events', 'Ledger members can read ledger events'),
      ('test_lab_reports', 'Ledger members can read test lab reports'),
      ('fuel_ledger_schema_migrations', 'fuel_ledger_schema_migrations_admin_select')
  ),
  missing_policies as (
    select coalesce(jsonb_agg(format('public.%I:%s', table_name, policy_name) order by table_name, policy_name), '[]'::jsonb) as items
    from expected_policies ep
    where not exists (
      select 1
      from pg_policies pp
      where pp.schemaname = 'public'
        and pp.tablename = ep.table_name
        and pp.policyname = ep.policy_name
    )
  ),
  schema_drift_status as (
    select
      missing_tables.items as missing_tables,
      missing_columns.items as missing_columns,
      missing_policies.items as missing_policies,
      jsonb_array_length(missing_tables.items) = 0
        and jsonb_array_length(missing_columns.items) = 0
        and jsonb_array_length(missing_policies.items) = 0 as ok
    from missing_tables, missing_columns, missing_policies
  ),
  workspace_status as (
    select jsonb_build_object(
      'ok', true,
      'public_signup_default', false,
      'invite_required_default', true,
      'main_ledger_id', target_ledger_id,
      'workspace_foundation_ready',
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledgers' and column_name = 'slug')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_my_ledgers')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_private_ledger_workspace'),
      'invite_onboarding_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_invites')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite'),
      'abuse_rate_limit_ready',
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ledger_onboarding_rate_limits')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'enforce_onboarding_rate_limit')
    ) as payload
  )
  select jsonb_build_object(
    'ok', true,
    'ledger_id', target_ledger_id,
    'close_settlement_period_exists',
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'close_settlement_period'
      ),
    'critical_rpcs', critical_rpc_status.critical_rpcs,
    'schema_migrations', jsonb_build_object(
      'table', 'public.fuel_ledger_schema_migrations',
      'latest_expected', migration_status.latest_expected,
      'latest_applied', migration_status.latest_applied,
      'missing_migrations', migration_status.missing_migrations,
      'extra_migrations', migration_status.extra_migrations,
      'ok', jsonb_array_length(migration_status.missing_migrations) = 0
    ),
    'schema_drift', jsonb_build_object(
      'ok', schema_drift_status.ok,
      'missing_tables', schema_drift_status.missing_tables,
      'missing_columns', schema_drift_status.missing_columns,
      'missing_policies', schema_drift_status.missing_policies
    ),
    'workspace_readiness', workspace_status.payload,
    'realtime_publication', jsonb_build_object(
      'publication', 'supabase_realtime',
      'recommended_tables', jsonb_build_array('public.ledger_events'),
      'tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
      ), '[]'::jsonb),
      'extra_tables', coalesce((
        select jsonb_agg(format('%I.%I', schemaname, tablename) order by schemaname, tablename)
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename <> 'ledger_events'
      ), '[]'::jsonb),
      'ledger_events_enabled', exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ledger_events'
      )
    ),
    'checked_at', now()
  )
  from critical_rpc_status, migration_status, schema_drift_status, workspace_status;
$$;

-- `create or replace` preserves the existing ACL, so 143's revokes survive it; they
-- are repeated by name because that is the only way to read this file and know the
-- diagnostic is still owner-only. No client calls it; the owner runs it in the SQL
-- Editor and owns the function, so owner access is unaffected.
revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
revoke all on function public.fuel_ledger_healthcheck(text) from authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. delete_my_account -- stop scrubbing a table step 4 removes          (GV-311)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 138 (its newest prior definition -- the GV-202 rule).
-- Every definition in between was checked: 056 -> 057 -> 071 -> 072 -> 096 -> 111 ->
-- 138, and 138 is the highest. The body is 138 VERBATIM apart from the deletion of
-- one two-line statement:
--
--     delete from public.push_subscriptions ps
--     where lower(ps.user_email) = v_email;
--
-- GDPR is unaffected, and that is the point: the statement is dropped because the
-- TABLE is dropped in step 4, which erases every row in it for every user at once --
-- strictly more deletion than the per-account scrub achieved. The account's real push
-- identity lives in expo_push_tokens (migration 057) and that delete is untouched,
-- three statements further down. push_subscriptions is the legacy Web Push
-- subscription store from the retired PWA runtime (archived at tag
-- legacy-runtime-final); the React Native app has never written to it.
--
-- The "Cross-ledger cleanup keyed by identity rather than membership" comment stays --
-- it introduces the ledger_onboarding_rate_limits and owner_activity_log statements
-- that follow, not only the removed one.
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Drop the ten dead functions                                          (GV-383)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Every one of these is superseded, and the successor is named. `if exists` keeps
-- each statement idempotent on replay and on a database where it was already removed
-- by hand.
--
-- Superseded by migration 045's workspace join codes (resolve_ledger_invite /
-- redeem_ledger_invite / rotate_workspace_join_code):
drop function if exists public.create_ledger_invite(text, text, text, integer, integer);
drop function if exists public.revoke_ledger_invite(text, uuid);
drop function if exists public.check_ledger_invite_email(text, text);

-- Superseded by upsert_ledger_member_admin, which is what both clients call. This is
-- the function GV-277 built the recurring-suspension feature on while production
-- deactivated through the other one; migration 145 moved that behaviour across.
drop function if exists public.set_ledger_member_active_admin(text, uuid, boolean);

-- Superseded by set_member_name + update_own_ledger_member_mobilepay:
drop function if exists public.update_own_ledger_member_profile(text, text, text);

-- Superseded by transition_settlement_request_status:
drop function if exists public.apply_payment_status_action(text, uuid, uuid, uuid, numeric, text, text, text, text, text, jsonb, text[]);

-- Superseded by run_operational_retention (migration 131's GDPR retention policy).
-- These two are also the last readers of push_subscriptions besides delete_my_account,
-- so they must go before the table does.
drop function if exists public.preview_retention_cleanup(text, integer, integer, integer, integer);
drop function if exists public.run_retention_cleanup(text, integer, integer, integer, integer);

-- Orphaned with the legacy PWA runtime (removed from main in GV-266, archived at tag
-- legacy-runtime-final). The test_lab_reports TABLE and its immutable-history trigger
-- stay; only these two writers go.
drop function if exists public.upsert_test_lab_report(text, text, jsonb);
drop function if exists public.purge_generated_test_rows(text, boolean);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Drop the legacy push_subscriptions table                             (GV-311)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The Web Push subscription store from the retired PWA. Verified against the replayed
-- catalog: no foreign key points AT it, it is not in the supabase_realtime
-- publication, and after steps 2 and 3 no function reads or writes it. Its own FK
-- (member_id -> ledger_members) and its four owner-scoped RLS policies go with it.
-- Native push has lived in expo_push_tokens since migration 057.
--
-- GDPR: this deletes the last stored Web Push endpoints, which are personal data.
-- That is a reduction in retained personal data, not a loss of a deletion path --
-- see step 2.
drop table if exists public.push_subscriptions;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Backfill three tracker rows the consolidated schema never inserted   (GV-392)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- SEPARATE CONCERN from steps 1-4. It shares this file only because it shares a
-- release, and it is written here rather than only in supabase-schema.sql so that any
-- database bootstrapped from the consolidated schema self-heals when this migration
-- is applied.
--
-- Replaying supabase/migrations/*.sql produced 146 rows in
-- fuel_ledger_schema_migrations; replaying supabase-schema.sql produced 143. All three
-- of these migrations insert their own id in their own migration file, but the
-- consolidated schema had no INSERT for any of them -- so a fresh install booted
-- reporting three missing migrations against itself.
--
-- WHY NO GUARD CAUGHT IT, which is the part worth writing down: the mirror check in
-- tools/test-migrations.mjs was `consolidatedSchema.includes(migrationId)`, a bare
-- substring test. The only occurrences of these three strings in supabase-schema.sql
-- were inside fuel_ledger_healthcheck's own expected_schema_migrations VALUES list.
-- The substring satisfying the mirror guard WAS the expectation list of the drift
-- detector that would have reported the failure. check-schema-equivalence.mjs cannot
-- see it either -- tracker rows are data and it dumps schema-only, deliberately.
--
-- Both halves are fixed in this commit: the three INSERTs are added to
-- supabase-schema.sql where they belong, and the mirror check now requires a real
-- tracker INSERT statement (tools/lib/tracker-insert-scan.mjs) rather than any
-- substring, so a description string or an expectation list can never satisfy it
-- again. tools/test-retired-rpcs-functional.sh asserts the row count from the
-- consolidated schema as a standing regression test.
--
-- Idempotent, and a no-op in production, where all three were applied years of
-- migrations ago.
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values
  ('024_schema_drift_healthcheck', 'Schema drift detection in fuel_ledger_healthcheck.'),
  ('033_onboarding_rate_limit_scope_key_alignment', 'Aligns onboarding rate-limit scope keys.'),
  ('036_invite_profile_setup', 'Invite profile setup during redemption.')
on conflict (migration_id) do nothing;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '147_retire_dead_rpcs_and_legacy_push_subscriptions',
  'GV-383: drops ten functions with no caller anywhere -- create_ledger_invite, revoke_ledger_invite and check_ledger_invite_email (superseded by migration 045 join codes), set_ledger_member_active_admin (superseded by upsert_ledger_member_admin, the RPC both clients actually call; migration 145 moved GV-277''s recurring-suspension behaviour across), update_own_ledger_member_profile (superseded by set_member_name + update_own_ledger_member_mobilepay), apply_payment_status_action (superseded by transition_settlement_request_status), preview_retention_cleanup and run_retention_cleanup (superseded by run_operational_retention), and upsert_test_lab_report + purge_generated_test_rows (orphaned with the legacy PWA runtime). Each was verified against the REPLAYED Postgres 17 catalog rather than migration text -- zero in-SQL callers, zero RLS policy references, zero trigger bindings, zero defaults/constraints/indexes/views, and zero client call sites in govehlo-mobile or govehlo-web once the vendored generated types are discounted, searching both indirection conventions (the sbRpc string-literal lookup table and the unquoted PostgREST /rest/v1/rpc/<name> path). enforce_onboarding_rate_limit is deliberately NOT dropped despite sitting in critical_rpc_names with no client caller: it has five live in-SQL callers. ledger_invites (the table) is deliberately NOT dropped: migration 143 left the legacy invite path write-closed, but resolve_ledger_invite and redeem_ledger_invite still read it and delete_my_account still updates it -- write-closed is not dead. test_lab_reports (the table) stays too. ORDER IS LOAD-BEARING: fuel_ledger_healthcheck is re-declared FIRST, off migration 143 (its newest prior definition), byte-identical except for four deletions -- the ten dead entries in critical_rpc_names (21 -> 11), (''push_subscriptions'') in expected_tables, (''push_subscriptions'', ''user_email'') in expected_columns, and the create_ledger_invite/revoke_ledger_invite/check_ledger_invite_email probes in workspace_readiness.invite_onboarding_ready -- so the operator diagnostic does not report as missing the objects it is itself the only thing still asking for. Its expected_schema_migrations list is untouched. GV-311: delete_my_account re-declared off migration 138 (its newest prior definition), 138 verbatim minus the two-line push_subscriptions scrub, then public.push_subscriptions is dropped -- the legacy Web Push store from the retired PWA runtime, with no inbound foreign key, no realtime publication membership and no remaining reader. Dropping the table deletes strictly more personal data than the per-account scrub did; native push identity lives in expo_push_tokens (migration 057) and that scrub is untouched. GV-392: backfills the 024_schema_drift_healthcheck, 033_onboarding_rate_limit_scope_key_alignment and 036_invite_profile_setup tracker rows, which supabase-schema.sql never inserted (146 rows from the migrations, 143 from the consolidated schema), so a fresh install booted reporting its own drift. Nothing caught it because tools/test-migrations.mjs mirrored by bare substring and the only occurrences of those ids in the consolidated schema were inside fuel_ledger_healthcheck''s own expected_schema_migrations list -- the substring satisfying the guard was the expectation list of the drift detector that would have reported it; check-schema-equivalence cannot see it either because tracker rows are data and it dumps schema-only. The mirror check now requires a real tracker INSERT (tools/lib/tracker-insert-scan.mjs).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

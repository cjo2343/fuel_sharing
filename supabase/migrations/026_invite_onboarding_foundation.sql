-- Migration 026: Add private invite onboarding foundation for future public workspace joins.
-- This keeps public signup disabled. Invites are admin-created, signed-in-user redeemed, and scoped to one ledger.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ledger_invites (
  id uuid primary key default gen_random_uuid(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  invite_code_hash text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_email text,
  max_uses integer not null default 1 check (max_uses > 0),
  uses_count integer not null default 0 check (uses_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by_member_id uuid references public.ledger_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ledger_id, invite_code_hash),
  check (uses_count <= max_uses)
);

create index if not exists ledger_invites_ledger_active_idx
on public.ledger_invites (ledger_id, expires_at)
where revoked_at is null and uses_count < max_uses;

create index if not exists ledger_invites_email_active_idx
on public.ledger_invites (lower(invited_email), ledger_id)
where invited_email is not null and revoked_at is null and uses_count < max_uses;

alter table public.ledger_invites enable row level security;

drop policy if exists "Ledger admins can read invites" on public.ledger_invites;
create policy "Ledger admins can read invites"
  on public.ledger_invites
  for select
  to authenticated
  using (public.is_ledger_admin(ledger_id));

drop policy if exists "Ledger admins can update invites" on public.ledger_invites;
create policy "Ledger admins can update invites"
  on public.ledger_invites
  for update
  to authenticated
  using (public.is_ledger_admin(ledger_id))
  with check (public.is_ledger_admin(ledger_id));

create or replace function public.hash_ledger_invite_code(invite_code text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(invite_code, ''), 'sha256'), 'hex');
$$;

create or replace function public.create_ledger_invite(
  target_ledger_id text default 'main-car',
  invite_role text default 'member',
  invite_email text default null,
  expires_in_hours integer default 168,
  max_uses integer default 1
)
returns table (
  invite_id uuid,
  invite_code text,
  ledger_id text,
  role text,
  invited_email text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  generated_code text;
  normalized_role text := case when invite_role = 'admin' then 'admin' else 'member' end;
  normalized_email text := nullif(lower(btrim(coalesce(invite_email, ''))), '');
  safe_max_uses integer := greatest(coalesce(max_uses, 1), 1);
  safe_expires_at timestamptz := case
    when expires_in_hours is null or expires_in_hours <= 0 then now() + interval '7 days'
    else now() + make_interval(hours => least(expires_in_hours, 24 * 30))
  end;
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can create invites' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Current user is not linked to this ledger' using errcode = '42501';
  end if;

  generated_code := 'fl-' || lower(encode(extensions.gen_random_bytes(16), 'hex'));

  insert into public.ledger_invites (
    ledger_id,
    invite_code_hash,
    role,
    invited_email,
    max_uses,
    uses_count,
    expires_at,
    created_by_member_id
  ) values (
    target_ledger_id,
    public.hash_ledger_invite_code(generated_code),
    normalized_role,
    normalized_email,
    safe_max_uses,
    0,
    safe_expires_at,
    actor_member_id
  ) returning id into invite_id;

  return query
  select invite_id, generated_code, target_ledger_id, normalized_role, normalized_email, safe_expires_at;
end;
$$;

create or replace function public.redeem_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  member_id uuid,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  base_name text;
  saved_member_id uuid;
begin
  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  select * into invite_row
  from public.ledger_invites li
  where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
    and li.revoked_at is null
    and (li.expires_at is null or li.expires_at > now())
    and li.uses_count < li.max_uses
  order by li.created_at asc
  limit 1
  for update;

  if invite_row.id is null then
    raise exception 'Invite is invalid, expired, revoked, or already used.' using errcode = 'P0001';
  end if;

  if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
    raise exception 'This invite is for a different email address.' using errcode = '42501';
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = invite_row.ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else invite_row.role end,
        updated_at = now()
    where id = existing_member.id
    returning id, ledger_id, role into saved_member_id, ledger_id, role;
  else
    base_name := split_part(current_email, '@', 1);
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = invite_row.ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (
      ledger_id,
      name,
      email,
      role,
      is_active
    ) values (
      invite_row.ledger_id,
      base_name,
      current_email,
      invite_row.role,
      true
    ) returning id, ledger_id, role into saved_member_id, ledger_id, role;
  end if;

  update public.ledger_invites
  set uses_count = uses_count + 1,
      updated_at = now()
  where id = invite_row.id;

  member_id := saved_member_id;
  return next;
end;
$$;

create or replace function public.revoke_ledger_invite(
  target_ledger_id text,
  target_invite_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can revoke invites' using errcode = '42501';
  end if;

  update public.ledger_invites
  set revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where id = target_invite_id
    and ledger_id = target_ledger_id;
end;
$$;

revoke all on table public.ledger_invites from public;
revoke all on table public.ledger_invites from anon;
revoke all on table public.ledger_invites from authenticated;
grant select on public.ledger_invites to authenticated;

revoke all on function public.hash_ledger_invite_code(text) from public;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from public;
revoke all on function public.redeem_ledger_invite(text) from public;
revoke all on function public.revoke_ledger_invite(text, uuid) from public;
revoke all on function public.create_ledger_invite(text, text, text, integer, integer) from anon;
revoke all on function public.redeem_ledger_invite(text) from anon;
revoke all on function public.revoke_ledger_invite(text, uuid) from anon;
grant execute on function public.hash_ledger_invite_code(text) to authenticated;
grant execute on function public.create_ledger_invite(text, text, text, integer, integer) to authenticated;
grant execute on function public.redeem_ledger_invite(text) to authenticated;
grant execute on function public.revoke_ledger_invite(text, uuid) to authenticated;

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
      ('set_ledger_member_active_admin'),
      ('purge_generated_test_rows'),
      ('production_activity_reset'),
      ('preview_retention_cleanup'),
      ('run_retention_cleanup'),
      ('upsert_test_lab_report'),
      ('list_my_ledgers'),
      ('create_private_ledger_workspace'),
      ('create_ledger_invite'),
      ('redeem_ledger_invite'),
      ('revoke_ledger_invite')
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
      ('027_invite_code_generation_pgcrypto_fix')
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
      ('trips'),
      ('trip_participants'),
      ('fuel_payments'),
      ('car_bookings'),
      ('settlement_requests'),
      ('settlement_periods'),
      ('ledger_events'),
      ('push_subscriptions'),
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
      ('push_subscriptions', 'user_email'),
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
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'redeem_ledger_invite')
        and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'revoke_ledger_invite')
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

revoke all on function public.fuel_ledger_healthcheck(text) from public;
revoke all on function public.fuel_ledger_healthcheck(text) from anon;
grant execute on function public.fuel_ledger_healthcheck(text) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('026_invite_onboarding_foundation', 'Private invite onboarding foundation with admin-created invites and signed-in redemption RPCs.')
on conflict (migration_id) do update set
  description = excluded.description;

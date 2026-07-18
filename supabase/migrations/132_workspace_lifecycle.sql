-- Migration 132: operator workspace decommission lifecycle (GV-316)
--
-- A workspace (public.ledgers row) can now be decommissioned by the OPERATOR
-- ONLY, from the admin console — never member-initiated and never
-- inactivity-based (migration 131's principle stands: inactivity never
-- auto-deletes a workspace). The lifecycle is:
--   1. Soft-delete: admin_soft_delete_workspace() stamps ledgers.deleted_at and
--      writes a ledger_events notification. From that instant the workspace and
--      all its data become invisible and read-only to every authenticated
--      member (RLS + RPC guards), while the operator can still see it (the
--      owner overview surfaces deleted_at so the console can badge it).
--   2. Restore: admin_restore_workspace() clears deleted_at during a 90-day
--      grace window, bringing the workspace back into full member visibility.
--   3. Purge: after 90 days the existing service-role retention sweep
--      (run_operational_retention) permanently deletes the tombstoned ledger;
--      on delete cascade takes every child row with it.
--
-- Visibility is enforced at a single choke point: the three membership helper
-- functions (is_ledger_member / is_ledger_admin / current_ledger_member_id)
-- that every member-facing RLS policy and write-guard funnels through. Adding a
-- `ledgers.deleted_at is null` join to each makes a soft-deleted workspace
-- vanish uniformly across reads, writes and actor resolution with no
-- per-policy churn. delete_my_account() is SECURITY DEFINER and deletes ledgers
-- directly by id (bypassing RLS), so its sole-member hard-delete branch keeps
-- working on a soft-deleted row unchanged; a whole-workspace `delete from
-- public.ledgers` cascade tears down closed-period trips/fuel/repairs/requests
-- cleanly because settlement_periods are removed first, so the per-row
-- closed-period locks (which only freeze INDIVIDUAL edits) find no period and
-- stand aside.

-- 1. The soft-delete tombstone. The live-list queries never filter on it, so a
--    small partial index keeps the operator overview and the retention sweep
--    predictable as the table grows.
alter table public.ledgers
  add column if not exists deleted_at timestamptz;

comment on column public.ledgers.deleted_at is
  'Operator decommission tombstone (GV-316): non-null means the workspace was soft-deleted by the operator and is invisible/read-only to members. Restorable for 90 days, then purged permanently by run_operational_retention. Null = live.';

create index if not exists ledgers_deleted_at_idx
  on public.ledgers (deleted_at)
  where deleted_at is not null;

-- 2. Visibility choke point. Re-declared off migration 002 (their newest prior
--    definition; migration 083 only re-granted them). The ONLY change is the
--    join to public.ledgers with `l.deleted_at is null`, so every RLS read
--    policy and every RPC/trigger write-guard that resolves membership through
--    these helpers treats a soft-deleted workspace as gone.
create or replace function public.is_ledger_member(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ledger_members lm
    join public.ledgers l on l.id = lm.ledger_id
    where lm.ledger_id = p_ledger_id
      and l.deleted_at is null
      and lm.is_active = true
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  );
$$;

create or replace function public.is_ledger_admin(p_ledger_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ledger_members lm
    join public.ledgers l on l.id = lm.ledger_id
    where lm.ledger_id = p_ledger_id
      and l.deleted_at is null
      and lm.is_active = true
      and lm.role = 'admin'
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
  );
$$;

create or replace function public.current_ledger_member_id(p_ledger_id text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select lm.id
  from public.ledger_members lm
  join public.ledgers l on l.id = lm.ledger_id
  where lm.ledger_id = p_ledger_id
    and l.deleted_at is null
    and lm.is_active = true
    and lm.email is not null
    and lower(lm.email) = public.current_user_email()
  limit 1;
$$;

-- 2b. Member-facing enumeration + invite paths that resolve workspace
--     visibility with a DIRECT join to public.ledgers — they do NOT funnel
--     through the helpers above, so they each need the same deleted_at gate:
--       * list_my_ledgers (re-declared off migration 040) drops a soft-deleted
--         workspace from the member's switcher/resolver, so the client's active
--         workspace naturally falls back to another workspace or the empty state.
--       * resolve_ledger_invite (re-declared off migration 058 — its VOLATILE
--         newest) reveals nothing for a soft-deleted workspace's code.
--       * redeem_ledger_invite (re-declared off migration 061 — the 2-arg
--         display-name newest) refuses to enrol anyone into a soft-deleted
--         workspace.
create or replace function public.list_my_ledgers()
returns table (
  ledger_id text,
  slug text,
  name text,
  role text,
  member_id uuid,
  is_public_signup_enabled boolean,
  invite_required boolean,
  bootstrap_locked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked_members as (
    select
      l.id as ledger_id,
      l.slug,
      l.name,
      case when bool_or(lm.role = 'admin') then 'admin' else 'member' end as role,
      (array_agg(lm.id order by case when lm.role = 'admin' then 0 else 1 end, lm.created_at asc nulls last, lm.id asc))[1] as member_id,
      l.is_public_signup_enabled,
      l.invite_required,
      l.bootstrap_locked_at,
      l.created_at
    from public.ledgers l
    join public.ledger_members lm on lm.ledger_id = l.id
    where lm.is_active = true
      and l.deleted_at is null
      and lm.email is not null
      and lower(lm.email) = public.current_user_email()
    group by l.id, l.slug, l.name, l.is_public_signup_enabled, l.invite_required, l.bootstrap_locked_at, l.created_at
  )
  select
    ranked_members.ledger_id,
    ranked_members.slug,
    ranked_members.name,
    ranked_members.role,
    ranked_members.member_id,
    ranked_members.is_public_signup_enabled,
    ranked_members.invite_required,
    ranked_members.bootstrap_locked_at
  from ranked_members
  order by ranked_members.created_at asc, ranked_members.ledger_id asc;
$$;

create or replace function public.resolve_ledger_invite(invite_code text)
returns table (
  ledger_id text,
  ledger_name text,
  member_count integer,
  owner_name text,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := public.current_user_email();
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  matched_ledger_id text;
  matched_role text := 'member';
  invite_row public.ledger_invites%rowtype;
begin
  perform public.enforce_onboarding_rate_limit('resolve_ledger_invite', null, 15, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to look up an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into matched_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  -- Fall back to a legacy one-time invite.
  if matched_ledger_id is null then
    select * into invite_row
    from public.ledger_invites li
    where li.invite_code_hash = public.hash_ledger_invite_code(invite_code)
      and li.revoked_at is null
      and (li.expires_at is null or li.expires_at > now())
      and li.uses_count < li.max_uses
    order by li.created_at asc
    limit 1;

    if invite_row.id is null then
      return; -- invalid / expired / used: reveal nothing
    end if;
    if invite_row.invited_email is not null and lower(invite_row.invited_email) <> current_email then
      return; -- pinned to a different email
    end if;

    matched_ledger_id := invite_row.ledger_id;
    matched_role := invite_row.role;
  end if;

  return query
  select
    l.id,
    l.name,
    (
      select count(*)::integer
      from public.ledger_members m
      where m.ledger_id = l.id and m.is_active = true
    ),
    (
      select o.name
      from public.ledger_members o
      where o.ledger_id = l.id and o.role = 'admin' and o.is_active = true
      order by o.created_at asc
      limit 1
    ),
    matched_role
  from public.ledgers l
  where l.id = matched_ledger_id
    and l.deleted_at is null; -- GV-316: a decommissioned workspace reveals nothing
end;
$$;

drop function if exists public.redeem_ledger_invite(text);

create or replace function public.redeem_ledger_invite(invite_code text, display_name text default null)
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
  normalized_code text := upper(btrim(coalesce(invite_code, '')));
  invite_row public.ledger_invites%rowtype;
  existing_member public.ledger_members%rowtype;
  target_ledger_id text;
  target_role text := 'member';
  is_stable boolean := false;
  base_name text;
  saved_member_id uuid;
  redeemed_ledger_id text;
  redeemed_role text;
  was_existing boolean := false;
  saved_member_name text;
begin
  perform public.enforce_onboarding_rate_limit('redeem_ledger_invite', null, 8, 60);

  if current_email is null or btrim(current_email) = '' then
    raise exception 'A signed-in user email is required to redeem an invite.' using errcode = 'P0001';
  end if;

  -- Stable workspace code first.
  select id into target_ledger_id
  from public.ledgers
  where join_code = normalized_code
  limit 1;

  if target_ledger_id is not null then
    is_stable := true;
  else
    -- Legacy one-time invite.
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

    target_ledger_id := invite_row.ledger_id;
    target_role := invite_row.role;
  end if;

  -- GV-316: never enrol anyone into a workspace the operator has decommissioned.
  if target_ledger_id is not null and exists (
    select 1 from public.ledgers l
    where l.id = target_ledger_id and l.deleted_at is not null
  ) then
    raise exception 'This workspace is no longer available.' using errcode = 'P0001';
  end if;

  select * into existing_member
  from public.ledger_members lm
  where lm.ledger_id = target_ledger_id
    and lm.email is not null
    and lower(lm.email) = current_email
  limit 1;

  if existing_member.id is not null then
    was_existing := true;
    update public.ledger_members
    set is_active = true,
        role = case when existing_member.role = 'admin' then 'admin' else target_role end,
        updated_at = now()
    where id = existing_member.id
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  else
    -- Prefer the name the user typed during onboarding; fall back to the email
    -- local-part when no display name was supplied (backward-compatible).
    if display_name is not null and btrim(display_name) <> '' then
      base_name := btrim(display_name);
    else
      base_name := split_part(current_email, '@', 1);
    end if;
    if exists (select 1 from public.ledger_members lm where lm.ledger_id = target_ledger_id and lm.name = base_name) then
      base_name := base_name || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;

    insert into public.ledger_members (ledger_id, name, email, role, is_active)
    values (target_ledger_id, base_name, current_email, target_role, true)
    returning public.ledger_members.id, public.ledger_members.ledger_id, public.ledger_members.role
      into saved_member_id, redeemed_ledger_id, redeemed_role;
  end if;

  -- Only one-time invites consume a use; the stable code is reusable.
  if not is_stable then
    update public.ledger_invites
    set uses_count = uses_count + 1,
        updated_at = now()
    where id = invite_row.id;
  end if;

  -- Activity / audit entry for the join (GVM-127). Actor = the joining member;
  -- the ledger_events INSERT webhook pushes "new activity" to the others.
  select lm.name into saved_member_name
  from public.ledger_members lm
  where lm.id = saved_member_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    redeemed_ledger_id,
    'member_joined',
    coalesce(saved_member_name, 'Et nyt medlem') || ' kom med i gruppen',
    case when was_existing then 'Kom med i gruppen igen' else 'Nyt medlem' end,
    saved_member_id,
    current_email,
    jsonb_build_object(
      'via', case when is_stable then 'join_code' else 'invite' end,
      'new_member', not was_existing
    )
  );

  redeem_ledger_invite.ledger_id := redeemed_ledger_id;
  redeem_ledger_invite.member_id := saved_member_id;
  redeem_ledger_invite.role := redeemed_role;
  return next;
end;
$$;

-- 3. Operator lifecycle RPCs. SERVICE-ROLE ONLY: the admin console calls them
--    through its owner-gated Pages Functions using the service key, exactly like
--    the other owner endpoints. Both are idempotency-guarded and raise clean
--    22023 errors. Soft-delete writes a ledger_events row so connected members
--    get the live-sync notification at the moment it happens (migration 051/052
--    event pattern); the operator has no ledger membership, so the actor fields
--    are null, matching delete_my_account's system-actor events.
create or replace function public.admin_soft_delete_workspace(p_ledger_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_deleted_at timestamptz;
  v_now timestamptz := now();
begin
  select l.name, l.deleted_at
    into v_name, v_deleted_at
  from public.ledgers l
  where l.id = p_ledger_id;

  if not found then
    raise exception 'Workspace % does not exist', p_ledger_id using errcode = '22023';
  end if;
  if v_deleted_at is not null then
    raise exception 'Workspace % is already decommissioned', p_ledger_id using errcode = '22023';
  end if;

  update public.ledgers l
  set deleted_at = v_now,
      updated_at = v_now
  where l.id = p_ledger_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    p_ledger_id,
    'workspace_decommissioned',
    'Workspacet er nedlagt',
    'Workspacet ' || coalesce(nullif(btrim(v_name), ''), p_ledger_id) || ' er nedlagt af operatøren; data slettes permanent efter 90 dage.',
    null,
    null,
    jsonb_build_object('decommissioned_at', v_now, 'grace_days', 90)
  );

  return jsonb_build_object('id', p_ledger_id, 'deletedAt', v_now, 'graceDays', 90);
end;
$$;

create or replace function public.admin_restore_workspace(p_ledger_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_deleted_at timestamptz;
  v_now timestamptz := now();
begin
  select l.name, l.deleted_at
    into v_name, v_deleted_at
  from public.ledgers l
  where l.id = p_ledger_id;

  if not found then
    raise exception 'Workspace % does not exist', p_ledger_id using errcode = '22023';
  end if;
  if v_deleted_at is null then
    raise exception 'Workspace % is not decommissioned', p_ledger_id using errcode = '22023';
  end if;

  update public.ledgers l
  set deleted_at = null,
      updated_at = v_now
  where l.id = p_ledger_id;

  insert into public.ledger_events (ledger_id, event_type, title, body, actor_member_id, actor_email, metadata)
  values (
    p_ledger_id,
    'workspace_restored',
    'Workspacet er gendannet',
    'Workspacet ' || coalesce(nullif(btrim(v_name), ''), p_ledger_id) || ' er gendannet af operatøren og er tilgængeligt igen.',
    null,
    null,
    jsonb_build_object('restored_at', v_now)
  );

  return jsonb_build_object('id', p_ledger_id, 'restoredAt', v_now);
end;
$$;

revoke all on function public.admin_soft_delete_workspace(text) from public;
revoke all on function public.admin_soft_delete_workspace(text) from anon;
revoke all on function public.admin_soft_delete_workspace(text) from authenticated;
grant execute on function public.admin_soft_delete_workspace(text) to service_role;

revoke all on function public.admin_restore_workspace(text) from public;
revoke all on function public.admin_restore_workspace(text) from anon;
revoke all on function public.admin_restore_workspace(text) from authenticated;
grant execute on function public.admin_restore_workspace(text) to service_role;

-- 4. Operator overview: re-declared off migration 129 (its newest prior
--    definition). The operator must keep SEEING decommissioned workspaces so the
--    console can badge them (Nedlagt · slettes <dato>), so this does NOT filter
--    deleted_at — it just surfaces it as an extra `deletedAt` field per row.
create or replace function public.owner_workspace_overview_page(
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit must be between 1 and 200' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'p_offset must be between 0 and 100000' using errcode = '22023';
  end if;

  with page as (
    select l.id, l.slug, l.name, l.created_at, l.updated_at, l.deleted_at
    from public.ledgers l
    order by l.created_at asc, l.id asc
    limit p_limit
    offset p_offset
  ),
  member_stats as (
    select lm.ledger_id,
           count(*)::integer as member_count,
           count(*) filter (where lm.role in ('admin', 'owner'))::integer as admin_count,
           count(*) filter (where lm.role = 'owner')::integer as owner_count,
           count(*) filter (where lm.role = 'admin')::integer as role_admin_count,
           count(*) filter (where lm.role not in ('owner', 'admin'))::integer as role_member_count,
           (array_agg(
             lm.email
             order by case lm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                      lm.created_at asc,
                      lm.id asc
           ) filter (where lm.email is not null))[1] as contact_email
    from public.ledger_members lm
    join page p on p.id = lm.ledger_id
    where lm.is_active = true
    group by lm.ledger_id
  ),
  open_periods as (
    select sp.ledger_id, true as has_open_period, max(sp.label) as open_period_label
    from public.settlement_periods sp
    join page p on p.id = sp.ledger_id
    where sp.status = 'open'
    group by sp.ledger_id
  ),
  request_stats as (
    select sr.ledger_id,
           count(*) filter (where sr.status = 'requested')::integer as stale_requests
    from public.settlement_requests sr
    join page p on p.id = sr.ledger_id
    group by sr.ledger_id
  ),
  activity_stats as (
    select oal.ledger_id,
           max(oal.created_at) as last_activity_at,
           count(*) filter (
             where oal.ok = false
               and oal.created_at >= now() - interval '7 days'
           )::integer as error_count_7d
    from public.owner_activity_log oal
    join page p on p.id = oal.ledger_id
    group by oal.ledger_id
  ),
  overview as (
    select p.*,
           coalesce(ms.member_count, 0) as member_count,
           coalesce(ms.admin_count, 0) as admin_count,
           coalesce(ms.owner_count, 0) as owner_count,
           coalesce(ms.role_admin_count, 0) as role_admin_count,
           coalesce(ms.role_member_count, 0) as role_member_count,
           coalesce(ms.contact_email, '') as contact_email,
           coalesce(op.has_open_period, false) as has_open_period,
           coalesce(op.open_period_label, '') as open_period_label,
           coalesce(rs.stale_requests, 0) as stale_requests,
           coalesce(ast.error_count_7d, 0) as error_count_7d,
           coalesce(ast.last_activity_at, p.updated_at) as last_activity_at
    from page p
    left join member_stats ms on ms.ledger_id = p.id
    left join open_periods op on op.ledger_id = p.id
    left join request_stats rs on rs.ledger_id = p.id
    left join activity_stats ast on ast.ledger_id = p.id
  )
  select jsonb_build_object(
    'totalWorkspaces', (select count(*) from public.ledgers),
    'workspaces', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', o.id,
        'name', coalesce(o.name, o.id),
        'slug', coalesce(o.slug, ''),
        'ownerEmail', o.contact_email,
        'memberCount', o.member_count,
        'adminCount', o.admin_count,
        'roles', concat_ws(', ',
          case when o.owner_count > 0 then o.owner_count || ' owner' || case when o.owner_count = 1 then '' else 's' end end,
          case when o.role_admin_count > 0 then o.role_admin_count || ' admin' || case when o.role_admin_count = 1 then '' else 's' end end,
          case when o.role_member_count > 0 then o.role_member_count || ' member' || case when o.role_member_count = 1 then '' else 's' end end
        ),
        'createdAt', o.created_at,
        'deletedAt', o.deleted_at,
        'lastActivityAt', o.last_activity_at,
        'health', jsonb_build_object(
          'openPeriod', o.has_open_period,
          'openPeriodLabel', o.open_period_label,
          'staleRequests', o.stale_requests,
          'errorCount7d', o.error_count_7d,
          'status', case
            when o.error_count_7d > 0 then 'error'
            when o.stale_requests > 0 then 'warning'
            else 'ok'
          end
        )
      ) order by o.created_at asc, o.id asc
    ), '[]'::jsonb)
  ) into result
  from overview o;

  return result;
end;
$$;

revoke all on function public.owner_workspace_overview_page(integer, integer) from public;
revoke all on function public.owner_workspace_overview_page(integer, integer) from anon;
revoke all on function public.owner_workspace_overview_page(integer, integer) from authenticated;
grant execute on function public.owner_workspace_overview_page(integer, integer) to service_role;

-- 5. Purge class. Re-declared off migration 131 (its newest prior definition).
--    The only additions purge workspaces whose operator tombstone has outlived
--    the 90-day grace window: on delete cascade removes every child row. A
--    whole-workspace teardown deletes settlement_periods first, so the per-row
--    closed-period locks that freeze INDIVIDUAL edits (enforce_settlement_entry_lock,
--    enforce_settlement_entry_period_boundary, enforce_repair_period_lock) find no
--    period and stand aside — verified against both a fresh consolidated replay and
--    a migration-applied database. The pii_scrub gate is kept around the delete for
--    parity with the financial-row purges above. This NEVER deletes a workspace for
--    inactivity (migration 131's principle) — only an explicit operator soft-delete
--    plus 90 days can select a ledger here.
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
  v_purged_workspaces integer := 0;
  v_short_cutoff timestamptz := now() - interval '90 days';
  v_financial_cutoff timestamptz := date_trunc('year', now()) - interval '5 years';
  v_audit_cutoff timestamptz := now() - interval '24 months';
  v_workspace_cutoff timestamptz := now() - interval '90 days';
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
    select count(*) into v_purged_workspaces from public.ledgers where deleted_at < v_workspace_cutoff;
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

    -- GV-316: purge workspaces whose operator decommission tombstone has
    -- outlived the 90-day grace window. On delete cascade removes every child
    -- row; the closed-period locks stand aside for a whole-workspace teardown
    -- (settlement_periods delete first). Kept inside the pii_scrub gate for
    -- parity with the financial-row purges above.
    with purged as (delete from public.ledgers where deleted_at < v_workspace_cutoff returning 1)
      select count(*) into v_purged_workspaces from purged;
    perform set_config('govehlo.pii_scrub', '', true);
    with purged as (delete from public.owner_activity_log where created_at < v_audit_cutoff returning 1)
      select count(*) into v_deleted_owner_activity from purged;
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
    'purgedWorkspaces', v_purged_workspaces,
    'dryRun', p_dry_run,
    'staleDays', p_stale_push_days,
    'shortRetentionDays', 90,
    'financialRetentionYears', 5,
    'auditRetentionMonths', 24,
    'workspaceGraceDays', 90,
    'ranAt', now()
  );
end;
$$;

revoke all on function public.run_operational_retention(integer, boolean) from public;
revoke all on function public.run_operational_retention(integer, boolean) from anon;
revoke all on function public.run_operational_retention(integer, boolean) from authenticated;
grant execute on function public.run_operational_retention(integer, boolean) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '132_workspace_lifecycle',
  'Operator workspace decommission lifecycle (GV-316): ledgers.deleted_at tombstone + partial index; is_ledger_member / is_ledger_admin / current_ledger_member_id gated on deleted_at is null so a soft-deleted workspace is invisible and read-only to members; service-role-only admin_soft_delete_workspace / admin_restore_workspace (idempotent, Danish ledger_events notification, system actor); owner_workspace_overview_page surfaces deletedAt so the operator can still see and badge tombstoned workspaces; run_operational_retention purges workspaces past the 90-day grace window (cascade) and reports purgedWorkspaces. Inactivity never auto-deletes a workspace.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

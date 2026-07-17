-- Migration 129: set-based owner workspace overview.
--
-- The operator workspace list previously downloaded capped member, period,
-- settlement-request and activity datasets and aggregated them in a Worker. At
-- scale that made counts approximate and transferred thousands of rows for a
-- 200-workspace page. Compute the same response in PostgreSQL and return only the
-- requested page. This command is intentionally service-role-only.

create index if not exists settlement_requests_ledger_status_idx
  on public.settlement_requests (ledger_id, status);

create index if not exists owner_activity_log_failed_ledger_created_idx
  on public.owner_activity_log (ledger_id, created_at desc)
  where ok = false;

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
    select l.id, l.slug, l.name, l.created_at, l.updated_at
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '129_owner_workspace_overview',
  'Replace capped owner-workspace overview row downloads with one bounded service-role-only set-based RPC, including exact member/role/request/activity health aggregates and supporting indexes.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 134: durable in-app notice for operator-decommissioned workspaces (GV-330)
--
-- Migration 132 gates is_ledger_member / is_ledger_admin / current_ledger_member_id
-- on `ledgers.deleted_at is null`, so the instant an operator decommissions a
-- workspace its members lose ALL read access — including to the Danish
-- ledger_events decommission notice the RPC inserts, because ledger_events SELECT
-- RLS funnels through is_ledger_member. The push notification is best-effort only,
-- and the mobile client silently falls back to another workspace when the active
-- one vanishes from list_my_ledgers, so members can be left with no durable trace
-- that their workspace was retired or when its data will be purged.
--
-- The tombstoned public.ledgers row and its public.ledger_members rows survive the
-- entire 90-day grace window — the cascade delete only fires at purge — so the
-- data a member needs already exists. This adds a single narrow read path that
-- bypasses the deleted_at gate: a SECURITY DEFINER, STABLE, read-only RPC that
-- reproduces is_ledger_member's membership conditions EXCEPT the `deleted_at is
-- null` gate (requiring `deleted_at is not null` instead) and returns, per
-- decommissioned workspace the caller still belongs to, its name, when it was
-- tombstoned, and when it will be permanently purged. It writes nothing.
--
-- purge_after mirrors run_operational_retention's workspace-purge predicate
-- (`deleted_at < now() - interval '90 days'`): the sweep runs with a hardcoded
-- 90-day grace window (not parameterised), so purge_after is deleted_at + 90 days.
create or replace function public.get_my_decommissioned_workspaces()
returns table (
  ledger_id text,
  name text,
  deleted_at timestamptz,
  purge_after timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Reproduces is_ledger_member's membership conditions (migration 132) via an
  -- EXISTS against public.ledger_members, but selects only tombstoned workspaces
  -- (`l.deleted_at is not null`) instead of live ones. The EXISTS keeps exactly
  -- one row per workspace and every column is fully qualified for the ambiguity
  -- guard. purge_after = deleted_at + 90 days matches the retention sweep.
  select
    l.id as ledger_id,
    l.name as name,
    l.deleted_at as deleted_at,
    (l.deleted_at + interval '90 days') as purge_after
  from public.ledgers l
  where l.deleted_at is not null
    and exists (
      select 1
      from public.ledger_members lm
      where lm.ledger_id = l.id
        and lm.is_active = true
        and lm.email is not null
        and lower(lm.email) = public.current_user_email()
    );
$$;

grant execute on function public.get_my_decommissioned_workspaces() to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '134_decommissioned_workspace_notices',
  'Durable in-app decommission notice (GV-330): read-only SECURITY DEFINER get_my_decommissioned_workspaces() returns (ledger_id, name, deleted_at, purge_after) for every tombstoned workspace the caller still belongs to. It reproduces is_ledger_member''s membership conditions except the deleted_at gate (requiring deleted_at is not null) so members keep a durable notice after migration 132 revokes their read access; purge_after is deleted_at + 90 days, matching run_operational_retention. Read-only, writes nothing; granted to authenticated.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

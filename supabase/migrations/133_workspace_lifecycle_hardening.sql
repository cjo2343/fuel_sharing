-- Migration 133: harden the workspace-lifecycle RPCs (GV-328)
--
-- Migration 132 (GV-316) shipped admin_soft_delete_workspace /
-- admin_restore_workspace as service-role-only operator commands, but a Codex
-- review of that migration surfaced two concrete defects, both fixed here by
-- re-declaring the two functions off their migration-132 definitions (nothing
-- later touched them):
--
--   (a) GRACE WINDOW NOT ENFORCED ON RESTORE. admin_restore_workspace cleared
--       deleted_at for ANY tombstoned workspace, regardless of age. The promise
--       to members (and the ledger_events notification) is that data is deleted
--       permanently 90 days after decommission; the nightly purge in
--       run_operational_retention is what enforces that, but if the sweep is
--       delayed, a restore could still succeed AFTER the promised 90 days and
--       resurrect data past its deletion date. Restore now refuses once the
--       tombstone has outlived the 90-day grace window: the workspace is
--       purge-pending and must not be resurrected. It raises a clean Danish
--       message with a DISTINCT errcode 'GV328' so the admin console can show a
--       specific "grace expired" message rather than a generic error.
--
--   (b) NO ROW LOCK — CONCURRENT DUPLICATE EVENTS. Neither RPC locked the
--       ledgers row, so two concurrent calls could both read deleted_at, both
--       pass the state check, and both emit a lifecycle event (double
--       decommission / double restore notification). Both functions now take a
--       `select ... for update` on the ledgers row BEFORE the state check, so
--       concurrent calls serialize: the second caller blocks until the first
--       commits, then re-reads the fresh deleted_at and takes the idempotent
--       no-op branch below instead of emitting a duplicate event.
--
-- IDEMPOTENCY CONTRACT (GV-328, one honest contract, documented here):
--   * Repeating soft-delete on an already-tombstoned workspace, or restore on a
--     workspace that is already live, is a NO-OP: the function returns the
--     result jsonb with `alreadyApplied: true` (soft-delete echoes the ORIGINAL
--     tombstone; restore echoes restoredAt=null) and emits NO second lifecycle
--     event. This replaces migration 132's behaviour, which raised a 22023
--     "already decommissioned" / "not decommissioned" error MISLABELLED as
--     idempotency — a no-op is not an error, so it no longer raises.
--   * Genuinely INVALID transitions remain errors: a missing workspace raises
--     22023 (unchanged), and restore-after-grace raises errcode 'GV328'
--     (new). Callers distinguish the honest no-op (200 + alreadyApplied) from
--     the hard failure (409 grace-expired) by the return shape vs the SQLSTATE.
--
-- SERVICE-ROLE ONLY is unchanged: the admin console calls these through its
-- owner-gated Pages Functions with the service key; the revoke/grant lines are
-- re-asserted for parity with the consolidated schema mirror.

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
  -- GV-328 (b): lock the ledger row so concurrent lifecycle calls serialize. A
  -- second caller blocks here until the first commits, then reads the fresh
  -- deleted_at and takes the idempotent no-op branch below instead of both
  -- passing the state check and emitting duplicate decommission events.
  select l.name, l.deleted_at
    into v_name, v_deleted_at
  from public.ledgers l
  where l.id = p_ledger_id
  for update;

  if not found then
    raise exception 'Workspace % does not exist', p_ledger_id using errcode = '22023';
  end if;

  -- GV-328 idempotency contract: a repeat soft-delete of an already-tombstoned
  -- workspace is a NO-OP, not an error. Echo the ORIGINAL tombstone with
  -- alreadyApplied=true and emit NO second decommission event.
  if v_deleted_at is not null then
    return jsonb_build_object('id', p_ledger_id, 'deletedAt', v_deleted_at, 'graceDays', 90, 'alreadyApplied', true);
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

  return jsonb_build_object('id', p_ledger_id, 'deletedAt', v_now, 'graceDays', 90, 'alreadyApplied', false);
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
  v_grace_cutoff timestamptz := now() - interval '90 days';
begin
  -- GV-328 (b): lock the ledger row so concurrent lifecycle calls serialize (see
  -- admin_soft_delete_workspace). The second caller reads the fresh state and
  -- takes the idempotent no-op branch instead of emitting a duplicate event.
  select l.name, l.deleted_at
    into v_name, v_deleted_at
  from public.ledgers l
  where l.id = p_ledger_id
  for update;

  if not found then
    raise exception 'Workspace % does not exist', p_ledger_id using errcode = '22023';
  end if;

  -- GV-328 idempotency contract: restoring a workspace that is already live is a
  -- NO-OP (alreadyApplied=true, restoredAt=null, no restore event), not an error.
  if v_deleted_at is null then
    return jsonb_build_object('id', p_ledger_id, 'restoredAt', null, 'alreadyApplied', true);
  end if;

  -- GV-328 (a): enforce the 90-day grace window. Once the tombstone has outlived
  -- it the workspace is purge-pending — run_operational_retention is entitled to
  -- delete it permanently at any moment, and the notification already promised
  -- members permanent deletion after 90 days — so restore must FAIL rather than
  -- resurrect data past its deletion date, even if the nightly sweep has not run
  -- yet. This is a genuinely invalid transition: raise a clean Danish message
  -- with the distinct errcode 'GV328' so the console can badge it specifically.
  if v_deleted_at < v_grace_cutoff then
    raise exception 'Gendannelsesfristen på 90 dage er udløbet' using errcode = 'GV328';
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

  return jsonb_build_object('id', p_ledger_id, 'restoredAt', v_now, 'alreadyApplied', false);
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '133_workspace_lifecycle_hardening',
  'Harden the workspace-lifecycle RPCs (GV-328): admin_soft_delete_workspace / admin_restore_workspace now take select ... for update on the ledgers row before the state check so concurrent calls serialize (no duplicate lifecycle events); admin_restore_workspace enforces the 90-day grace window and raises errcode GV328 (''Gendannelsesfristen på 90 dage er udløbet'') once the tombstone is purge-pending; repeated soft-delete of a tombstoned workspace and restore of a live workspace are now honest no-ops (alreadyApplied=true, no second event) instead of mislabelled idempotency errors, while a missing workspace stays 22023.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

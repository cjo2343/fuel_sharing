-- Migration 135: decommission grants hardening + atomic attestation (GV-333)
--
-- Three defects surfaced by a Codex review of the migration-134 / govehlo-web
-- PR #180 decommission work, fixed here:
--
--   (a) get_my_decommissioned_workspaces() (migration 134) granted EXECUTE to
--       authenticated but never revoked the implicit PUBLIC grant Postgres gives
--       every function by default, so anon (and any future role) could still call
--       it. It deliberately crosses the deleted_at boundary that migration 132
--       uses to hide a tombstoned workspace from its members, so leaving it
--       PUBLIC-executable is a real widening. Match the house revoke/grant phrasing
--       (migrations 004/007/008/014–022, 133): revoke from public + anon, then
--       grant only authenticated.
--
--   (b) THE DECOMMISSION ATTESTATION WAS FAIL-SOFT AND NON-DURABLE. The operator's
--       pre-decommission checklist acknowledgements (exportOffered / noLegalHold)
--       were journaled AFTER the RPC by the fail-soft withOwnerAudit path, so a
--       workspace could be decommissioned without the attestation ever being
--       retained. Worse, both the RPC's own ledger_events notice AND a
--       ledger_id-scoped owner_activity_log row cascade-delete when
--       run_operational_retention purges the workspace at 90 days (migration 132,
--       `delete from public.ledgers` ON DELETE CASCADE). admin_soft_delete_workspace
--       now (1) REQUIRES both acknowledgements strictly true on the path that
--       performs a NEW soft-delete and (2) writes, IN THE SAME TRANSACTION, exactly
--       one durable owner_activity_log attestation row. That row is written with a
--       NULL ledger_id (console-level, migration 048) precisely so it SURVIVES the
--       90-day workspace-purge cascade; the workspace identity is preserved in
--       workspace_label + metadata, and owner_activity_log's own 24-month retention
--       class then governs it. A missing/false acknowledgement raises a Danish
--       message with a DISTINCT errcode 'GV333' (mirroring how migration 133 uses
--       'GV328' for the grace-expiry case) so the admin console can map it to a 400
--       rather than the residual missing-workspace 22023 -> 409 conflict.
--
-- IDEMPOTENCY IS PRESERVED: a repeat soft-delete of an already-tombstoned workspace
-- stays an honest no-op (alreadyApplied=true) — it requires NO acknowledgements and
-- writes NO second attestation row, because nothing new happens. The row lock, the
-- 22023 missing-workspace guard, the Danish ledger_events notice, and the
-- service-role-only grant posture are all carried over UNCHANGED from migration 133
-- (the newest prior definition). admin_restore_workspace is untouched.
--
-- The signature changes (three trailing params added), so the old one-arg function
-- is dropped first; CREATE OR REPLACE would otherwise leave two overloads and make
-- a one-arg call ambiguous.

revoke all on function public.get_my_decommissioned_workspaces() from public;
revoke all on function public.get_my_decommissioned_workspaces() from anon;
grant execute on function public.get_my_decommissioned_workspaces() to authenticated;

drop function if exists public.admin_soft_delete_workspace(text);

create function public.admin_soft_delete_workspace(
  p_ledger_id text,
  p_ack_export_offered boolean default null,
  p_ack_no_legal_hold boolean default null,
  p_operator_email text default null
)
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
  -- alreadyApplied=true and emit NO second decommission event. Nothing new happens,
  -- so this path deliberately requires NO acknowledgements and writes NO attestation.
  if v_deleted_at is not null then
    return jsonb_build_object('id', p_ledger_id, 'deletedAt', v_deleted_at, 'graceDays', 90, 'alreadyApplied', true);
  end if;

  -- GV-333: a NEW decommission deliberately OVERRIDES the 5-year financial-retention
  -- window (docs/gdpr/retention.md), so the operator must actively attest both
  -- pre-decommission checklist points. Require both strictly true, or reject with a
  -- Danish message under a DISTINCT errcode 'GV333' (not the missing-workspace 22023)
  -- so the console can surface it as a 400 rather than the residual 409 conflict.
  -- Nothing is tombstoned or journaled on this path.
  if p_ack_export_offered is not true or p_ack_no_legal_hold is not true then
    raise exception 'Nedlæggelse kræver bekræftelse af begge tjeklistepunkter (dataeksport tilbudt og ingen legal hold)' using errcode = 'GV333';
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

  -- GV-333: durable, atomic attestation. Committed in the SAME transaction as the
  -- tombstone so a decommission can NEVER happen without the acknowledgements being
  -- retained. ledger_id is NULL (console-level, migration 048) ON PURPOSE: it keeps
  -- this row OUT of the ON DELETE CASCADE that fires when run_operational_retention
  -- purges the workspace at 90 days, so the attestation outlives the workspace and
  -- is governed by owner_activity_log's own 24-month retention class. The workspace
  -- identity is preserved in workspace_label + metadata.ledgerId; the action label
  -- and 'owner' actor_role match what govehlo-web's recordOwnerActivity() writes for
  -- this route, and metadata.source='rpc' distinguishes this durable row from the
  -- fail-soft withOwnerAudit route log. No tokens/PII beyond the operator email.
  insert into public.owner_activity_log (
    ledger_id, workspace_label, actor_email, actor_role,
    route, action, result_code, status_code, ok, summary, metadata
  ) values (
    null,
    coalesce(nullif(btrim(v_name), ''), p_ledger_id),
    p_operator_email,
    'owner',
    'rpc:admin_soft_delete_workspace',
    'owner.workspace.decommission',
    'OK',
    200,
    true,
    'decommission attestation',
    jsonb_build_object(
      'acknowledgements', jsonb_build_object('exportOffered', true, 'noLegalHold', true),
      'source', 'rpc',
      'ledgerId', p_ledger_id
    )
  );

  return jsonb_build_object('id', p_ledger_id, 'deletedAt', v_now, 'graceDays', 90, 'alreadyApplied', false);
end;
$$;

revoke all on function public.admin_soft_delete_workspace(text, boolean, boolean, text) from public;
revoke all on function public.admin_soft_delete_workspace(text, boolean, boolean, text) from anon;
revoke all on function public.admin_soft_delete_workspace(text, boolean, boolean, text) from authenticated;
grant execute on function public.admin_soft_delete_workspace(text, boolean, boolean, text) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '135_workspace_decommission_attestation',
  'Decommission grants hardening + atomic attestation (GV-333): revoke the implicit PUBLIC/anon EXECUTE on get_my_decommissioned_workspaces() left by migration 134 (authenticated only); admin_soft_delete_workspace now takes trailing p_ack_export_offered / p_ack_no_legal_hold / p_operator_email params, REQUIRES both acks strictly true on the path that performs a NEW soft-delete (else raises Danish errcode ''GV333''), and writes ONE durable owner_activity_log attestation row in the same transaction with a NULL ledger_id so it survives the 90-day workspace-purge cascade (identity kept in workspace_label + metadata; source=rpc). The idempotent alreadyApplied no-op requires no acks and writes no attestation. Row lock, 22023 missing-workspace guard, Danish ledger_events notice and service-role-only grant carried over unchanged from migration 133.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

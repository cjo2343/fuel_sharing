-- Migration 113: close-period reminder skips running-mode groups (GVM-318)
--
-- The scheduled "luk perioden" push (claim_due_close_reminders, engine op for the
-- daily web scheduler) fires the 30-day cadence for any open period whose ledger
-- still has close_reminder_enabled = true. In Løbende (running) settlement mode
-- there is no monthly close to nudge — the locked GVM-64 decision is that the
-- 30-day cadence trigger is suppressed in running mode while the all-paid trigger
-- stays (src/lib/close-nudge.ts already enforces that in-app). A group that ran in
-- Månedlig, enabled the reminder, then switched to Løbende would keep
-- close_reminder_enabled = true and still receive cadence pushes.
--
-- Re-declared off migration 106 (the newest prior definition — lease + claim
-- token). The ONLY behavioral change: the target CTE additionally requires
-- l.settlement_mode = 'monthly', so running-mode groups never get a cadence
-- "luk perioden" push even when close_reminder_enabled is still true from before a
-- mode switch. Signature, grants (service_role only), lease/claim-token semantics
-- are byte-for-byte unchanged. Return type is unchanged, so a plain create-or-replace
-- suffices (no drop). GVM-318, honouring the GVM-64 running-mode suppression.

-- ── claim_due_close_reminders: skip running-mode groups (GVM-318 / GVM-64) ───────────
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[], claim_token uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sp.id
    from public.settlement_periods sp
    join public.ledgers l on l.id = sp.ledger_id
    where sp.status = 'open'
      and l.close_reminder_enabled = true
      and l.settlement_mode = 'monthly'
      and sp.opened_at <= now() - interval '30 days'
      and (sp.close_reminder_claimed_at is null
           or sp.close_reminder_claimed_at <= now() - interval '15 minutes')
      and (sp.last_close_reminder_at is null
           or sp.last_close_reminder_at <= now() - interval '7 days')
    order by sp.opened_at
    limit greatest(coalesce(batch_limit, 200), 0)
    for update of sp skip locked
  ),
  claimed as (
    update public.settlement_periods sp
    set close_reminder_claimed_at = now(),
        close_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id,
              sp.ledger_id as ledger_id,
              sp.label as label,
              sp.close_reminder_claim_token as claim_token
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails,
         c.claim_token
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label, c.claim_token;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('113_close_reminder_running_mode',
        'Close-period reminder skips running-mode groups (GVM-318): claim_due_close_reminders re-declared off 106; the target CTE additionally requires ledgers.settlement_mode = ''monthly'' so a group that switched to Løbende never receives the 30-day cadence "luk perioden" push even when close_reminder_enabled is still true. Honours the locked GVM-64 running-mode suppression (in-app close-nudge already suppresses the cadence trigger in running mode). Signature, grants (service_role only), and lease/claim-token semantics unchanged.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

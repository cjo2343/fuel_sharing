-- Migration 082: reminder-claim concurrency + targeting hardening (GV review)
--
-- Codex review of the scheduled-push work (migrations 078 / 080 / 081) surfaced three
-- issues this migration closes:
--   1. The two claim RPCs picked candidates in a CTE and then updated them by id only,
--      so two overlapping runs could both select the same due row and both re-send — the
--      UPDATE never re-checked the due predicate (READ COMMITTED re-check is on the join
--      key only). Re-declared here with `for update ... skip locked` in the target CTE so
--      a second run skips rows a first run has already claimed. Now the "can't double-
--      send" guarantee holds at the DB level, not just because the scheduler serializes.
--   2. claim_due_payment_reminders could still return a deactivated debtor's email and
--      push them about an old request. Now filters debtor.is_active + email is not null in
--      the claim itself, so we never even burn a reminder slot on an unreachable/left member.
--   3. The four migration-078 RPCs granted execute to authenticated but never revoked the
--      default PUBLIC grant that SECURITY DEFINER functions ship with. The internal
--      is_ledger_* gates already reject anon, but this tightens them to match every later
--      RPC (revoke from public / anon).
--
-- Re-declares off the newest prior definitions (080 close, 081 payment); the function
-- shape / return type is unchanged, so callers and the service_role grants are untouched.

-- ── claim_due_close_reminders: skip-locked claim ─────────────────────────────────
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[])
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
      and sp.opened_at <= now() - interval '30 days'
      and (sp.last_close_reminder_at is null
           or sp.last_close_reminder_at <= now() - interval '7 days')
    order by sp.opened_at
    limit greatest(coalesce(batch_limit, 200), 0)
    for update of sp skip locked
  ),
  claimed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;

-- ── claim_due_payment_reminders: skip-locked claim + active-debtor targeting ──────
create or replace function public.claim_due_payment_reminders(
  batch_limit integer default 200
)
returns table (request_id uuid, ledger_id text, debtor_email text, creditor_name text, amount numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sr.id
    from public.settlement_requests sr
    join public.ledger_members debtor on debtor.id = sr.from_member_id
    where sr.status = 'requested'
      and sr.reminder_count < 3
      and debtor.is_active = true
      and debtor.email is not null
      and (
        (sr.reminder_count = 0
          and sr.requested_at is not null
          and sr.requested_at <= now() - interval '3 days')
        or (sr.reminder_count between 1 and 2
          and sr.last_reminder_at is not null
          and sr.last_reminder_at <= now() - interval '7 days')
      )
    order by sr.requested_at
    limit greatest(coalesce(batch_limit, 200), 0)
    for update of sr skip locked
  ),
  claimed as (
    update public.settlement_requests sr
    set reminder_count = sr.reminder_count + 1,
        last_reminder_at = now(),
        updated_at = now()
    from target t
    where sr.id = t.id
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount
  )
  select c.request_id,
         c.ledger_id,
         lower(debtor.email) as debtor_email,
         creditor.name as creditor_name,
         c.amount
  from claimed c
  left join public.ledger_members debtor on debtor.id = c.debtor_id
  left join public.ledger_members creditor on creditor.id = c.creditor_id;
end;
$$;

revoke all on function public.claim_due_payment_reminders(integer) from public;
revoke all on function public.claim_due_payment_reminders(integer) from anon;
revoke all on function public.claim_due_payment_reminders(integer) from authenticated;
grant execute on function public.claim_due_payment_reminders(integer) to service_role;

-- ── Tighten migration-078 RPC grants: revoke the default PUBLIC execute ───────────
revoke all on function public.insert_repair(text, date, text, numeric, integer) from public;
revoke all on function public.insert_repair(text, date, text, numeric, integer) from anon;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb) from public;
revoke all on function public.update_ledger_settings(text, text, jsonb, jsonb) from anon;
revoke all on function public.post_message(text, text) from public;
revoke all on function public.post_message(text, text) from anon;
revoke all on function public.mark_messages_read(text) from public;
revoke all on function public.mark_messages_read(text) from anon;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('082_reminder_claim_hardening',
        'Reminder-claim hardening: skip-locked claims + active-debtor targeting + 078 grant revokes (GV review).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

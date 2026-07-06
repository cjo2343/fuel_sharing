-- Migration 081: payment-reminder engine (GVM-5)
--
-- When a creditor requests a payment the debtor gets the original push; if they still
-- haven't paid, GoVehlo re-nudges them on a fixed cadence — first after 3 days, then
-- every 7 days, max 3 — until the request is paid/cancelled. Same scheduled-push shape
-- as the close reminder (migration 080): a daily Cloudflare endpoint hits this claim RPC
-- and pushes the debtor. Cadence is a fixed app default (owner-configurable is a future
-- ticket); per-event opt-out is GVM-119.

alter table public.settlement_requests
  add column if not exists reminder_count integer not null default 0;

alter table public.settlement_requests
  add column if not exists last_reminder_at timestamptz;

-- ── claim_due_payment_reminders: engine op for the scheduled push ─────────────────
-- Atomically claims 'requested' payments that are due (first 3 days after requested_at,
-- then ≥7 days since the last reminder, capped at 3), incrementing reminder_count +
-- stamping last_reminder_at so overlapping runs can't double-send (increment-on-claim →
-- a push failure under-reminds, never spams). Returns each with the debtor's email (to
-- resolve to push tokens), the creditor's name, and the amount. Service-role only.
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
    where sr.status = 'requested'
      and sr.reminder_count < 3
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

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('081_payment_reminders',
        'Payment-reminder engine: reminder_count/last_reminder_at + claim_due_payment_reminders (GVM-5).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 102: reminder claim-lease + confirm-after-send (GV-254)
--
-- Both scheduled reminder engines used to stamp their "sent" bookkeeping AT CLAIM
-- TIME, before any push was attempted: claim_due_payment_reminders bumped
-- reminder_count + stamped last_reminder_at, claim_due_close_reminders stamped
-- last_close_reminder_at, and 091 also inserted the payment_reminder_sent /
-- close_reminder_sent ledger_events row — all in the claim UPDATE. A failed Expo
-- send therefore permanently burned one of the debtor's 3 payment-reminder slots
-- (worst case: 0 pushes, system believes 3 sent), silently delayed the next close
-- nudge 7 days, and made the admin activity feed lie. This splits the write into a
-- two-phase claim lease: claim marks a row in-flight, a separate confirm RPC (called
-- by the web hook only after the push actually succeeds) advances the cadence
-- counters and logs the event.
--
-- Semantics:
--   * Send fails → no confirm → the lease expires after 15 min → the next daily
--     scheduler run re-claims and retries. The 3-reminder budget is only spent on
--     confirmed sends; retry backoff = the daily scheduler cadence.
--   * Confirm call fails after a successful send → at-least-once: the row re-sends on
--     the next run (rare duplicate push, bounded to one per day by the lease + daily
--     cadence). Chosen deliberately over at-most-once — a silently dropped money
--     reminder is worse than a rare duplicate nudge.
--   * Cadence timestamps (last_reminder_at, last_close_reminder_at) now reflect
--     actual deliveries, which is what the 7-day re-nudge predicate should measure.
--
-- The two claim RPCs are re-declared off their newest prior definitions (migration
-- 091) with three changes each: the due predicate gains a lease check (null lease or
-- lease older than 15 min = claimable), the claimed CTE now sets ONLY the
-- *_claimed_at lease stamp + updated_at (it no longer touches the cadence counters),
-- and the logged CTE is removed (the event moves to the confirm RPC). Return shapes
-- are unchanged, so the push sender and mobile clients are untouched. The two new
-- confirm RPCs are service_role-only (revoked from public/anon/authenticated); the
-- confirm event insert is a data-modifying CTE that Postgres runs to completion for
-- every confirmed row exactly as 091's logged CTE did.

alter table public.settlement_requests add column if not exists reminder_claimed_at timestamptz;
alter table public.settlement_periods add column if not exists close_reminder_claimed_at timestamptz;

-- ── claim_due_close_reminders: lease-claim only (event moves to confirm) ────────────
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

-- ── claim_due_payment_reminders: lease-claim only (event moves to confirm) ──────────
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
      and (sr.reminder_claimed_at is null
           or sr.reminder_claimed_at <= now() - interval '15 minutes')
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
    set reminder_claimed_at = now(),
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

-- ── confirm_close_reminders: advance cadence + log event after a successful send ────
create or replace function public.confirm_close_reminders(period_ids uuid[])
returns integer
language sql
security definer
set search_path = public
as $$
  with confirmed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        close_reminder_claimed_at = null,
        updated_at = now()
    where sp.id = any(period_ids)
      and sp.close_reminder_claimed_at is not null
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    )
    select c.ledger_id, 'close_reminder_sent', 'Lukkepåmindelse sendt', '',
           null, null,
           jsonb_build_object(
             'period_id', c.period_id,
             'label', c.label
           )
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_close_reminders(uuid[]) from public;
revoke all on function public.confirm_close_reminders(uuid[]) from anon;
revoke all on function public.confirm_close_reminders(uuid[]) from authenticated;
grant execute on function public.confirm_close_reminders(uuid[]) to service_role;

-- ── confirm_payment_reminders: advance cadence + log event after a successful send ──
create or replace function public.confirm_payment_reminders(request_ids uuid[])
returns integer
language sql
security definer
set search_path = public
as $$
  with confirmed as (
    update public.settlement_requests sr
    set reminder_count = sr.reminder_count + 1,
        last_reminder_at = now(),
        reminder_claimed_at = null,
        updated_at = now()
    where sr.id = any(request_ids)
      and sr.reminder_claimed_at is not null
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount,
              sr.reminder_count as reminder_count
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    )
    select c.ledger_id, 'payment_reminder_sent', 'Betalingspåmindelse sendt', '',
           null, null,
           jsonb_build_object(
             'settlement_request_id', c.request_id,
             'from_member_id', c.debtor_id,
             'to_member_id', c.creditor_id,
             'amount', c.amount,
             'reminder_count', c.reminder_count
           )
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_payment_reminders(uuid[]) from public;
revoke all on function public.confirm_payment_reminders(uuid[]) from anon;
revoke all on function public.confirm_payment_reminders(uuid[]) from authenticated;
grant execute on function public.confirm_payment_reminders(uuid[]) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('102_reminder_claim_confirm',
        'Reminder delivery two-phase claim lease (GV-254): claim_due_payment_reminders / claim_due_close_reminders re-declared off 091 to only stamp a *_claimed_at lease (15-min expiry) instead of advancing cadence counters or logging events, so a failed Expo send no longer burns a reminder slot or delays the next close nudge. New service_role-only confirm_payment_reminders(uuid[]) / confirm_close_reminders(uuid[]) advance the counters + insert the payment_reminder_sent / close_reminder_sent ledger_events row, called by the web hooks only after a successful send. At-least-once (rare duplicate on a confirm-call failure) over at-most-once. Return shapes unchanged.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

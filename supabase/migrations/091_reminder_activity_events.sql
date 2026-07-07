-- Migration 091: reminders write a ledger_events row per send (GV-226)
--
-- The scheduled reminder engines (claim_due_payment_reminders GVM-5,
-- claim_due_close_reminders GVM-60) previously only bumped a counter + stamped a
-- last_*_at timestamp and returned rows to the push sender — they left no trace in
-- ledger_events, so a sent reminder was invisible in the admin activity feed /
-- audit log. This re-declares both claim RPCs (off the newest prior definitions in
-- migration 082) to also insert a system ledger_events row for each claimed row:
--   payment_reminder_sent  — metadata: settlement_request_id, from/to member, amount, reminder_count
--   close_reminder_sent    — metadata: period_id, label
-- The insert is a data-modifying CTE reading the `claimed` set; Postgres runs an
-- unreferenced data-modifying WITH sub-statement exactly once to completion, so the
-- event is logged for every row the UPDATE claimed, without changing the RPC's
-- return shape (the push sender is untouched). Events are actor-less (system);
-- clients hide these two types from the activity feed (govehlo-mobile fetch filter).

-- ── claim_due_close_reminders: also log a close_reminder_sent event ────────────────
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
    from claimed c
    returning 1
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

-- ── claim_due_payment_reminders: also log a payment_reminder_sent event ────────────
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
    from claimed c
    returning 1
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

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('091_reminder_activity_events',
        'Reminders log a ledger_events row per send (GV-226): claim_due_payment_reminders → payment_reminder_sent, claim_due_close_reminders → close_reminder_sent (system, actor-less), so sent reminders show in the admin activity feed. Re-declared off 082; return shapes unchanged. Clients hide both types from the mobile feed.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

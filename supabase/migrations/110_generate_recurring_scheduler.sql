-- Migration 110: server-side recurring-expense generation for the daily scheduler (GV-272)
--
-- Recurring expenses materialise via CLIENT CATCH-UP: the mobile app calls
-- generate_due_recurring_expenses(ledger) on load (migrations 069/073/075), which is
-- idempotent and fills in every occurrence missed since the last run. That works while
-- someone opens the app — but if a ledger goes quiet, no occurrence is ever generated,
-- and external readers (the admin console) see stale state until a member next opens it.
--
-- Fix (hybrid, decided 2026-07-04 in migration 069's header — "pg_cron can be layered on
-- later against the same RPC"): the daily scheduler also generates. This adds a
-- service-role-only sweep, generate_all_due_recurring_expenses, that iterates every ledger
-- with a due, active recurring template and generates EXACTLY the rows the client RPC would
-- — same open-period target, same columns, same attribution (template creator on the
-- expense, no actor on the feed event), same idempotence key.
--
-- No double-generation: generated rows are keyed by the workspace_expenses_recurrence_uq
-- unique index on (recurring_expense_id, occurrence_date) and inserted with ON CONFLICT DO
-- NOTHING, and each template row is taken FOR UPDATE SKIP LOCKED before its next_due_date
-- advances. So the client and this scheduler can both run — even concurrently — without ever
-- materialising an occurrence twice: whoever locks a template first advances it; the other
-- skips the locked row, and the ON CONFLICT is the final guard.
--
-- This is an ENGINE OP, not client-callable: execute is revoked from public/anon/
-- authenticated and granted only to service_role. The govehlo-web scheduler hook calls it
-- with the service key.

-- ── Sweep: generate_all_due_recurring_expenses (service role) ─────────────────
-- Per-ledger body mirrors generate_due_recurring_expenses (migration 075's newest
-- definition) verbatim: same open-period FOR SHARE lock, same FOR UPDATE SKIP LOCKED over
-- due templates, same insert + ON CONFLICT, same cadence advance, same null-actor feed
-- event. batch_limit caps the number of ledgers swept per tick (default 200); the next
-- tick catches up the rest. Returns a summary for the hook to log (no PII).
create or replace function public.generate_all_due_recurring_expenses(
  batch_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  due_ledger record;
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  ledger_generated integer;
  total_generated integer := 0;
  ledgers_touched integer := 0;
  ledgers_scanned integer := 0;
begin
  for due_ledger in
    select distinct r.ledger_id
    from public.recurring_expenses r
    where r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
    order by r.ledger_id
    limit greatest(coalesce(batch_limit, 200), 0)
  loop
    ledgers_scanned := ledgers_scanned + 1;

    -- Materialise into the ledger's open period. If none is open (a period close
    -- briefly precedes the next open), skip this ledger this run; the next tick catches
    -- up. FOR SHARE serializes against a concurrent close (which exclusively locks the
    -- period row).
    select sp.id into open_period_id
    from public.settlement_periods sp
    where sp.ledger_id = due_ledger.ledger_id
      and sp.status = 'open'
      and sp.closed_at is null
    order by sp.opened_at desc
    limit 1
    for share of sp;

    if open_period_id is null then
      open_period_id := null;
      continue;
    end if;

    ledger_generated := 0;

    for tmpl in
      select *
      from public.recurring_expenses r
      where r.ledger_id = due_ledger.ledger_id
        and r.is_active
        and r.deleted_at is null
        and r.next_due_date <= current_date
      order by r.next_due_date
      for update skip locked
    loop
      due_date := tmpl.next_due_date;
      template_count := 0;

      while due_date <= current_date loop
        insert into public.workspace_expenses (
          ledger_id, period_id, category, description, amount_dkk, expense_date,
          split_rule, split_config, paid_by_member_id, created_by_member_id,
          recurring_expense_id, occurrence_date
        ) values (
          due_ledger.ledger_id,
          open_period_id,
          tmpl.category,
          tmpl.description,
          tmpl.amount_dkk,
          due_date,
          tmpl.split_rule,
          tmpl.split_config,
          tmpl.paid_by_member_id,
          tmpl.created_by_member_id,
          tmpl.id,
          due_date
        )
        on conflict (recurring_expense_id, occurrence_date)
          where recurring_expense_id is not null do nothing
        returning id into inserted_id;

        if inserted_id is not null then
          template_count := template_count + 1;
        end if;
        inserted_id := null;

        due_date := (case tmpl.cadence
          when 'monthly' then due_date + interval '1 month'
          when 'quarterly' then due_date + interval '3 months'
          when 'semiannual' then due_date + interval '6 months'
          when 'yearly' then due_date + interval '1 year'
          else due_date + interval '1 month'
        end)::date;
      end loop;

      update public.recurring_expenses
        set next_due_date = due_date, last_generated_at = now(), updated_at = now()
      where id = tmpl.id;

      if template_count > 0 then
        insert into public.ledger_events (
          ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
        ) values (
          due_ledger.ledger_id,
          'expense_recurring_added',
          'Fast udgift tilføjet',
          coalesce(nullif(tmpl.description, ''), initcap(tmpl.category))
            || ' blev automatisk tilføjet og delt.',
          null,
          null,
          jsonb_build_object(
            'category', tmpl.category,
            'recurring_expense_id', tmpl.id,
            'count', template_count
          )
        );
        ledger_generated := ledger_generated + template_count;
      end if;
    end loop;

    if ledger_generated > 0 then
      ledgers_touched := ledgers_touched + 1;
      total_generated := total_generated + ledger_generated;
    end if;

    open_period_id := null;
  end loop;

  return jsonb_build_object(
    'generated', total_generated,
    'ledgers_touched', ledgers_touched,
    'ledgers_scanned', ledgers_scanned
  );
end;
$$;

revoke execute on function public.generate_all_due_recurring_expenses(integer) from public;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from anon;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from authenticated;
grant execute on function public.generate_all_due_recurring_expenses(integer) to service_role;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('110_generate_recurring_scheduler',
        'Server-side recurring-expense generation for the daily scheduler (GV-272): service-role-only generate_all_due_recurring_expenses sweeps every ledger with a due active template and materialises occurrences exactly as the client catch-up RPC does (same open-period target, attribution, and (recurring_expense_id, occurrence_date) idempotence key), so the client and scheduler can both run without double-generating.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 116: recurring generation skips entry-locked periods, isolates per-ledger failures (GV-281)
--
-- Root cause (verified by Docker repro): generate_all_due_recurring_expenses (114)
-- inserts a due occurrence into an OPEN period that has an ACTIVE settlement request
-- (status requested/paid/paid_pending — see settlement_entry_is_locked). The
-- enforce_settlement_entry_lock trigger (072/088) then raises 42501, and — because the
-- whole sweep ran in one statement — that single exception aborted the ENTIRE batch,
-- so /api/hooks/recurring-generate 500'd hourly (every run after any template first came
-- due in prod). One locked ledger poisoned the whole batch. The client variant
-- generate_due_recurring_expenses hit the same 42501 on app load.
--
-- Fix (both generators re-declared off migration 114 — their newest prior definition;
-- 115 did not touch them):
--   * generate_all_due_recurring_expenses (scheduler, service_role):
--       - Per-ledger lock skip: after resolving the open period, if that period is
--         entry-locked, skip the ledger WITHOUT touching it and count it in a new
--         `ledgers_skipped` return key. (Implemented as an in-loop guard rather than an
--         extra EXISTS predicate on purpose: the sweep must be able to REPORT how many
--         ledgers it deferred, which an invisible candidate-scan exclusion cannot do —
--         GV-281 role-matrix asserts ledgers_skipped=1.)
--       - Defense in depth: each ledger's body runs in its own BEGIN/EXCEPTION
--         subtransaction, so any unexpected error rolls back ONLY that ledger, counts it
--         in `ledgers_skipped`, records the first SQLSTATE in `first_error` (code only —
--         never row values, GDPR), and the sweep CONTINUES. One bad ledger can never
--         abort the batch again.
--       - Return jsonb gains `ledgers_skipped` and `first_error`; every existing key
--         (generated, ledgers_touched, ledgers_scanned) is preserved so the hook's
--         parsing stays valid.
--   * generate_due_recurring_expenses (client catch-up, per-member): if the ledger's
--     open period is entry-locked, return the normal zero-summary
--     ({generated:0, reason:'locked'}) instead of raising, so the app's on-load catch-up
--     no-ops until the lock lifts. Signature unchanged.
--
-- Semantics: a deferred occurrence is caught up AUTOMATICALLY on a later run once the
-- payment completes/cancels or the period closes and a new period opens — the catch-up
-- inserts into whatever period is open at that point. Nothing is lost; it is only delayed
-- until the period is writable again.

-- ── generate_due_recurring_expenses — skip when the open period is entry-locked ─
-- Re-declared off migration 114 (its newest prior definition). Body is 114 verbatim
-- plus one GV-281 guard: bail with a zero-summary when the open period is locked,
-- instead of letting the entry-lock trigger raise 42501 into the client's catch-up.
create or replace function public.generate_due_recurring_expenses(
  target_ledger_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  open_period_id uuid;
  tmpl record;
  due_date date;
  inserted_id uuid;
  template_count integer;
  occurrences integer;
  total_generated integer := 0;
  -- Bound the per-template catch-up so one stale template can't materialise an
  -- unbounded backlog in a single run; the remainder catches up on later runs
  -- (GV-274). Same value in generate_all_due_recurring_expenses (the scheduler).
  max_catchup_occurrences constant integer := 24;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can generate recurring expenses' using errcode = '42501';
  end if;

  -- Materialise into the ledger's open period. If none is open (should not happen
  -- after bootstrap, but a period close briefly precedes the next open), do
  -- nothing this run; the next call catches up. FOR SHARE serializes against a
  -- concurrent close (which exclusively locks the period row).
  select sp.id into open_period_id
  from public.settlement_periods sp
  where sp.ledger_id = target_ledger_id
    and sp.status = 'open'
    and sp.closed_at is null
  order by sp.opened_at desc
  limit 1
  for share of sp;

  if open_period_id is null then
    return jsonb_build_object('generated', 0, 'reason', 'no_open_period');
  end if;

  -- GV-281: if the open period is entry-locked (an active settlement request has
  -- been requested/paid), skip generation this run rather than raising 42501 from
  -- the enforce_settlement_entry_lock trigger — which used to crash the client's
  -- on-load catch-up. The deferred occurrence is caught up automatically once the
  -- payment completes/cancels or the period closes and a new one opens.
  if public.settlement_entry_is_locked(target_ledger_id, open_period_id) then
    return jsonb_build_object('generated', 0, 'reason', 'locked');
  end if;

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
      and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
    order by r.next_due_date
    for update skip locked
  loop
    due_date := tmpl.next_due_date;
    template_count := 0;
    occurrences := 0;

    while due_date <= current_date and occurrences < max_catchup_occurrences loop
      insert into public.workspace_expenses (
        ledger_id, period_id, category, description, amount_dkk, expense_date,
        split_rule, split_config, paid_by_member_id, created_by_member_id,
        recurring_expense_id, occurrence_date
      ) values (
        target_ledger_id,
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
      occurrences := occurrences + 1;

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
        target_ledger_id,
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
      total_generated := total_generated + template_count;
    end if;
  end loop;

  return jsonb_build_object('generated', total_generated);
end;
$$;

revoke all on function public.generate_due_recurring_expenses(text) from public;
revoke all on function public.generate_due_recurring_expenses(text) from anon;
grant execute on function public.generate_due_recurring_expenses(text) to authenticated;

-- ── generate_all_due_recurring_expenses — per-ledger lock skip + failure isolation ─
-- Re-declared off migration 114 (its newest prior definition). Body is 114 verbatim
-- plus the GV-281 fix: each ledger runs in its own BEGIN/EXCEPTION subtransaction, a
-- locked open period is skipped and counted, and any error rolls back only that ledger.
-- Service-role only (grants restated).
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
  occurrences integer;
  ledger_generated integer;
  total_generated integer := 0;
  ledgers_touched integer := 0;
  ledgers_scanned integer := 0;
  -- GV-281: ledgers deferred this run (open period entry-locked) or rolled back on an
  -- unexpected error; first_error_code holds the FIRST failure's SQLSTATE only.
  ledgers_skipped integer := 0;
  first_error_code text := null;
  -- Same per-template catch-up bound as generate_due_recurring_expenses (GV-274).
  max_catchup_occurrences constant integer := 24;
begin
  for due_ledger in
    -- Only ledgers with a due active template (with an active payer, GV-277) AND an
    -- open period to receive it, oldest debt first, so no-open-period ledgers never
    -- occupy a batch slot and the most overdue ledger is caught up first under
    -- batch_limit (GV-274). Locked ledgers are NOT excluded here — they are skipped
    -- and counted inside the loop (GV-281) so the sweep can report ledgers_skipped.
    select r.ledger_id
    from public.recurring_expenses r
    where r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
      and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
      and exists (
        select 1
        from public.settlement_periods sp
        where sp.ledger_id = r.ledger_id
          and sp.status = 'open'
          and sp.closed_at is null
      )
    group by r.ledger_id
    order by min(r.next_due_date) asc, r.ledger_id
    limit greatest(coalesce(batch_limit, 200), 0)
  loop
    ledgers_scanned := ledgers_scanned + 1;

    -- GV-281: isolate each ledger in its own subtransaction so one bad ledger (a lock
    -- race, an unexpected constraint) can never abort the whole sweep again. On error
    -- we roll THIS ledger back (the exception block does this automatically), count it
    -- in ledgers_skipped, remember the first SQLSTATE (code only — no row values, GDPR),
    -- and CONTINUE with the next ledger.
    begin
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

      -- GV-281: if the open period is entry-locked (a settlement request has been
      -- requested/paid), defer this ledger without touching it. Inserting would trip the
      -- enforce_settlement_entry_lock trigger (42501); one such ledger used to abort the
      -- ENTIRE hourly sweep. The deferred occurrence is caught up on a later run once the
      -- payment completes/cancels or the period closes.
      if public.settlement_entry_is_locked(due_ledger.ledger_id, open_period_id) then
        ledgers_skipped := ledgers_skipped + 1;
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
          and public.member_is_active_in_ledger(r.paid_by_member_id, r.ledger_id)
        order by r.next_due_date
        for update skip locked
      loop
        due_date := tmpl.next_due_date;
        template_count := 0;
        occurrences := 0;

        while due_date <= current_date and occurrences < max_catchup_occurrences loop
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
          occurrences := occurrences + 1;

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
    exception when others then
      -- Roll this ledger back (the subtransaction does this automatically) and keep
      -- sweeping. Record the first failure's SQLSTATE only — never message text or row
      -- values (GDPR).
      ledgers_skipped := ledgers_skipped + 1;
      if first_error_code is null then
        get stacked diagnostics first_error_code = returned_sqlstate;
      end if;
      open_period_id := null;
    end;
  end loop;

  return jsonb_build_object(
    'generated', total_generated,
    'ledgers_touched', ledgers_touched,
    'ledgers_scanned', ledgers_scanned,
    'ledgers_skipped', ledgers_skipped,
    'first_error', first_error_code
  );
end;
$$;

revoke execute on function public.generate_all_due_recurring_expenses(integer) from public;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from anon;
revoke execute on function public.generate_all_due_recurring_expenses(integer) from authenticated;
grant execute on function public.generate_all_due_recurring_expenses(integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('116_recurring_generation_lock_skip',
        'Recurring generation skips entry-locked periods and isolates per-ledger failures (GV-281). generate_all_due_recurring_expenses (scheduler) re-declared off 114: each ledger runs in its own BEGIN/EXCEPTION subtransaction, an entry-locked open period is deferred and counted in a new ledgers_skipped key, any unexpected error rolls back only that ledger (first SQLSTATE in first_error, code only — GDPR) and the sweep continues — one locked ledger no longer 500s the hourly /api/hooks/recurring-generate batch. generate_due_recurring_expenses (client catch-up) re-declared off 114: returns the zero-summary {generated:0, reason:''locked''} instead of raising 42501 when the open period is locked. Deferred occurrences are caught up automatically once the payment completes/cancels or the period closes and a new one opens.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

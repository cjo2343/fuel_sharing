-- Migration 142: recurring materialisations carry over into the queued period (GV-360)
--
-- Ancestry (the lesson of GV-359 — always state it): BOTH functions below are
-- re-declared off migration 116 (116_recurring_generation_lock_skip.sql), which is
-- the newest prior definition of each. generate_due_recurring_expenses was declared
-- by 069/070/073/075/112/114/116; generate_all_due_recurring_expenses by
-- 110/112/114/116. Nothing between 117 and 141 touches either one. Both bodies here
-- are 116 VERBATIM with a single deletion each — no other line moves.
--
-- What changes, and why it is a deletion rather than an addition.
--
-- Migration 116 (GV-281) taught both generators to short-circuit when the ledger's
-- open period is entry-locked: the client catch-up returned
-- {generated:0, reason:'locked'} and the scheduler skipped the ledger and counted it
-- in ledgers_skipped. That was correct at the time — the alternative was a raw 42501
-- from enforce_settlement_entry_lock, which crashed the app's on-load catch-up and
-- (before 116's per-ledger subtransactions) aborted the entire hourly sweep.
--
-- The ground has since moved. Migration 121 attached the trigger
-- assert_settlement_period_boundary_expenses to public.workspace_expenses — the exact
-- table both generators INSERT into — and migration 140 taught
-- public.enforce_settlement_entry_period_boundary() to rebind a live INSERT aimed at a
-- locked open period into the queued carry-over period via
-- ensure_settlement_carryover_period. That rebind branch keys on `new_period_id is not
-- null` and fires on tg_op = 'INSERT' even when period_id is supplied explicitly, which
-- is what these generators do. Trigger firing order is load-bearing and already
-- correct: 'assert_settlement_period_boundary_expenses' sorts before
-- 'enforce_settlement_entry_lock_expenses', so the rebind happens first and the lock
-- trigger then evaluates the QUEUED period — which carries no settlement request, so
-- settlement_entry_is_locked returns false and the insert lands.
--
-- The owner's decision (2026-07-24) is that a recurring materialisation must behave
-- exactly like a manually logged expense during a lock: carried over into the queued
-- period, not deferred. Trips, fuel, expenses and repairs have all done this since
-- migration 140. So the fix is to DELETE the two short-circuits and let the boundary
-- trigger do what it already does — adding a second carry-over implementation inside
-- the generators would duplicate (and eventually drift from) 140's single one.
--
-- Preserved unchanged in both bodies: the no_open_period early return, `for share of
-- sp` on the open period, `for update skip locked` on the templates, the
-- max_catchup_occurrences (24) cap from GV-274, the per-ledger BEGIN/EXCEPTION
-- subtransaction isolation in the scheduler, the GDPR-safe error reporting (SQLSTATE
-- code only, never message text or row values), and every grant/revoke.
--
-- Return contracts:
--   * generate_due_recurring_expenses no longer emits reason:'locked'. Verified
--     read-only that no caller branches on it — govehlo-mobile's only consumer,
--     src/store/LedgerContext.tsx, reads `generated > 0` and ignores `reason`.
--   * generate_all_due_recurring_expenses KEEPS the ledgers_skipped key
--     (/api/hooks/recurring-generate in govehlo-web reads it). Entry-locked ledgers
--     simply stop appearing in it; the per-ledger error rollback still counts, exactly
--     as in 116. Note that 116's no-open-period branch never incremented the counter
--     either (the candidate scan already excludes those ledgers) — that is unchanged
--     here, not a regression introduced by this migration.

-- ── generate_due_recurring_expenses — materialise even while the period is locked ─
-- Re-declared off migration 116 (its newest prior definition). Body is 116 verbatim
-- minus the GV-281 lock short-circuit; the period-boundary trigger now rebinds the
-- insert into the queued carry-over period instead.
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

  -- GV-360: no entry-lock short-circuit here. GV-281's guard returned
  -- {generated:0, reason:'locked'} to avoid a 42501 from enforce_settlement_entry_lock,
  -- but migration 140 made that exception unreachable for this insert:
  -- assert_settlement_period_boundary_expenses (migration 121) fires first — it sorts
  -- before enforce_settlement_entry_lock_expenses — and rebinds a live INSERT aimed at
  -- a locked open period into the queued carry-over period. A recurring occurrence now
  -- carries over exactly like a manually logged expense instead of being deferred.

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

-- ── generate_all_due_recurring_expenses — same carry-over, failure isolation kept ─
-- Re-declared off migration 116 (its newest prior definition). Body is 116 verbatim
-- minus the GV-281 per-ledger lock skip. The per-ledger BEGIN/EXCEPTION subtransaction,
-- the ledgers_skipped/first_error keys, and the GDPR-safe SQLSTATE-only reporting all
-- stay. Service-role only (grants restated).
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
  -- Ledgers rolled back on an unexpected error; first_error_code holds the FIRST
  -- failure's SQLSTATE only. GV-281 also counted entry-locked ledgers here; GV-360
  -- removed that deferral, so this is now purely the per-ledger failure counter. The
  -- key stays in the return contract either way — /api/hooks/recurring-generate in
  -- govehlo-web reads it.
  ledgers_skipped integer := 0;
  first_error_code text := null;
  -- Same per-template catch-up bound as generate_due_recurring_expenses (GV-274).
  max_catchup_occurrences constant integer := 24;
begin
  for due_ledger in
    -- Only ledgers with a due active template (with an active payer, GV-277) AND an
    -- open period to receive it, oldest debt first, so no-open-period ledgers never
    -- occupy a batch slot and the most overdue ledger is caught up first under
    -- batch_limit (GV-274). Entry-locked ledgers are neither excluded here nor skipped
    -- in the loop any more (GV-360): their occurrences are materialised, and the
    -- period-boundary trigger rebinds them into the queued carry-over period.
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

      -- GV-360: no entry-lock deferral here either. The insert below targets the open
      -- period; when that period is entry-locked, migration 121's
      -- assert_settlement_period_boundary_expenses trigger rebinds the row into the
      -- queued carry-over period (migration 140) before the entry-lock trigger runs, so
      -- the 42501 GV-281 defended against can no longer be raised on this path.

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
values ('142_recurring_generation_carryover',
        'Recurring expense materialisations carry over into the queued settlement period during a lock instead of being deferred (GV-360). Both generators re-declared off migration 116 (their newest prior definition) with only the GV-281 entry-lock short-circuits deleted: generate_due_recurring_expenses no longer returns {generated:0, reason:''locked''}, and generate_all_due_recurring_expenses no longer skips and counts entry-locked ledgers. Migration 121''s assert_settlement_period_boundary_expenses trigger fires before enforce_settlement_entry_lock_expenses and, since migration 140, rebinds a live INSERT aimed at a locked open period into the queued carry-over period — so a recurring occurrence now behaves exactly like a manually logged expense during a payment freeze. Everything else is 116 verbatim: the no_open_period early return, FOR SHARE on the open period, FOR UPDATE SKIP LOCKED on templates, the 24-occurrence catch-up cap, the per-ledger BEGIN/EXCEPTION subtransaction, the SQLSTATE-only first_error (GDPR), the ledgers_skipped key (still counts per-ledger error rollbacks, read by /api/hooks/recurring-generate), and all grants/revokes.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

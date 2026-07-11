-- Migration 112: Codex release-blocker remediation (GV-273 + GV-274 + GV-275)
--
-- Three pre-TestFlight blockers found in the 2026-07-11 Codex review, bundled
-- into one migration:
--
--   GV-273  Repairs must become immutable once the period they were logged in
--           closes. vehicle_repairs has no period_id, so — exactly like
--           calculate_period_settlement (migration 108) — a repair belongs to
--           the period whose [opened_at, closed_at) window contains its
--           created_at. A new BEFORE UPDATE OR DELETE trigger rejects any change
--           to a repair that falls inside ANY closed period of its ledger,
--           mirroring the closed-period rejection the settlement lock trigger
--           already enforces for trips/fuel/expenses (GV-199, errcode 22023).
--           Soft delete is an UPDATE of deleted_at, so the UPDATE branch covers
--           it; hard DELETE is blocked too. Repairs in the OPEN period stay
--           editable. No backfill — the lock protects history from now on.
--
--   GV-274  Recurring-expense hardening + credit-only inactive payers:
--             1. upsert_recurring_expense (re-declared off migration 077, its
--                newest prior definition — 083 only re-granted it) requires a
--                positive amount and an in-window next_due_date instead of
--                coalescing them away.
--             2. A 24-occurrence catch-up cap in BOTH generators
--                (generate_due_recurring_expenses off 075, the client catch-up;
--                generate_all_due_recurring_expenses off 110, the scheduler
--                sweep) bounds how many occurrences a single stale template can
--                materialise per run; next_due_date advances only through what
--                was generated, so the remainder catches up on later runs.
--             3. The scheduler's candidate-ledger scan now requires an OPEN
--                period to EXIST and orders by the ledger's oldest due
--                next_due_date, so a no-open-period ledger never occupies a batch
--                slot and the oldest debt is served first.
--             4. calculate_period_settlement (re-declared off 108) stops
--                dropping expenses/repairs/fuel whose payer is an INACTIVE
--                member: the payer is now a CREDIT-ONLY participant, credited
--                what they paid with ZERO weight in every share split (shares
--                stay distributed over ACTIVE members only; largest-remainder
--                untouched). Their net = +paid. Inactive members who paid nothing
--                never appear. Owner decision locked 2026-07-11.
--
--   GV-275  set_notification_preferences (re-declared off 109) becomes
--           back-compatible: the four advanced params default NULL = "leave
--           unchanged" (COALESCE with the existing row, falling back to the
--           standard defaults only when no row exists), plus a trailing
--           clear_snooze_value that explicitly clears the snooze (null-means-
--           unchanged makes clearing impossible otherwise). An old 3-arg client
--           toggling a category can no longer wipe a snooze/quiet-hours setting.
--
-- Re-declared functions are each based on their NEWEST prior definition, verified
-- by searching every later migration for a re-declaration (upsert_recurring 077,
-- generate_due 075, generate_all 110, calculate_period_settlement 108,
-- set_notification_preferences 109; 083 only touched grants).

-- ── GV-273: repairs immutable after their period closes ─────────────────────────
-- Runs BEFORE UPDATE OR DELETE on vehicle_repairs. A repair belongs to the period
-- whose [opened_at, closed_at) window contains its created_at (the moment it was
-- LOGGED — repair_date is display-only and may lie years in the past, exactly as
-- calculate_period_settlement scopes repairs, GV-269). If that period is closed,
-- the row is frozen: both a soft delete (UPDATE of deleted_at) and a hard DELETE
-- are rejected. created_at and ledger_id are immutable, so OLD carries them for
-- both operations. Matches the settlement lock trigger's closed-period rejection
-- style (GV-199): errcode 22023, a single clear sentence.
create or replace function public.enforce_repair_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.settlement_periods sp
    where sp.ledger_id = old.ledger_id
      and sp.closed_at is not null
      and old.created_at >= sp.opened_at
      and old.created_at < sp.closed_at
  ) then
    raise exception
      'This repair belongs to a closed settlement period and can no longer be edited or deleted.'
      using errcode = '22023';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_repair_period_lock on public.vehicle_repairs;
create trigger enforce_repair_period_lock
before update or delete on public.vehicle_repairs
for each row execute function public.enforce_repair_period_lock();

-- ── GV-274.1: upsert_recurring_expense — positive amount + in-window due date ────
-- Re-declared off migration 077 (its newest prior definition; 083 only re-granted
-- it). Everything from 077 is preserved — admin gate, actor resolution, the
-- payer-membership gate, the active-payer gate on INSERT, the cadence/split
-- validation, and the event insert. The only additions (GV-274): a recurring
-- template is a financial record, so its amount must be present and > 0 (rounded
-- to 2 decimals; the coalesce-to-0 is gone) and its next_due_date must be present
-- and within [current_date - 90 days, current_date + 5 years]. On an EDIT a null
-- amount / next_due_date still means "leave unchanged" (the update COALESCEs), but
-- a value that IS supplied is validated. Signature is unchanged, so this is a
-- plain create-or-replace; grants are restated defensively.
create or replace function public.upsert_recurring_expense(
  target_ledger_id text,
  recurring_id_value uuid default null,
  category_value text default 'other',
  description_value text default null,
  amount_value numeric default 0,
  cadence_value text default 'monthly',
  next_due_date_value date default null,
  split_rule_value text default null,
  split_config_value jsonb default null,
  paid_by_value uuid default null,
  is_active_value boolean default true,
  event_title text default null,
  event_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_member_id uuid;
  result_id uuid;
  is_new boolean := recurring_id_value is null;
  normalized_event_type text;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can manage recurring expenses' using errcode = '42501';
  end if;

  actor_member_id := public.current_ledger_member_id(target_ledger_id);
  if actor_member_id is null then
    raise exception 'Could not match the current user to an active ledger member' using errcode = '42501';
  end if;

  if paid_by_value is not null
     and not public.member_belongs_to_ledger(paid_by_value, target_ledger_id) then
    raise exception 'Payer must be a member of this ledger' using errcode = '22023';
  end if;

  if coalesce(cadence_value, 'monthly') not in ('monthly', 'quarterly', 'semiannual', 'yearly') then
    raise exception 'Invalid cadence' using errcode = '22023';
  end if;

  if split_rule_value is not null and split_rule_value not in ('equal', 'usage', 'custom') then
    raise exception 'Invalid split rule' using errcode = '22023';
  end if;

  -- Amount: a recurring template drives every future generated expense, so a
  -- missing or non-positive amount is rejected rather than coalesced to 0
  -- (GV-274). Rounded to 2 decimals. A null on an EDIT leaves it unchanged.
  if amount_value is not null then
    amount_value := round(amount_value, 2);
    if amount_value <= 0 then
      raise exception 'Recurring amount must be greater than zero' using errcode = '22023';
    end if;
  elsif is_new then
    raise exception 'Recurring amount is required' using errcode = '22023';
  end if;

  -- Next due date: required on a new template and, when supplied, within
  -- [current_date - 90 days, current_date + 5 years] — a date decades in the past
  -- would make the generator materialise (then cap) a huge backlog, one far in
  -- the future would never fire (GV-274). A null on an EDIT leaves it unchanged.
  if next_due_date_value is not null then
    if next_due_date_value < (current_date - interval '90 days')::date
       or next_due_date_value > (current_date + interval '5 years')::date then
      raise exception 'Next due date must be within 90 days ago and 5 years ahead' using errcode = '22023';
    end if;
  elsif is_new then
    raise exception 'Next due date is required' using errcode = '22023';
  end if;

  if is_new then
    -- A brand-new template must be paid by an ACTIVE member (GV-208) — its payer
    -- drives every future generated expense. Edits keep the looser membership gate.
    if paid_by_value is not null
       and not public.member_is_active_in_ledger(paid_by_value, target_ledger_id) then
      raise exception 'Payer must be an active member of this ledger' using errcode = '22023';
    end if;

    insert into public.recurring_expenses (
      ledger_id, category, description, amount_dkk, cadence, next_due_date,
      split_rule, split_config, paid_by_member_id, is_active, created_by_member_id
    ) values (
      target_ledger_id,
      coalesce(nullif(category_value, ''), 'other'),
      nullif(description_value, ''),
      amount_value,
      coalesce(nullif(cadence_value, ''), 'monthly'),
      next_due_date_value,
      split_rule_value,
      split_config_value,
      coalesce(paid_by_value, actor_member_id),
      coalesce(is_active_value, true),
      actor_member_id
    )
    returning id into result_id;
    normalized_event_type := 'recurring_expense_added';
  else
    if not exists (
      select 1 from public.recurring_expenses r
      where r.id = recurring_id_value
        and r.ledger_id = target_ledger_id
        and r.deleted_at is null
    ) then
      raise exception 'Recurring expense was not found' using errcode = '22023';
    end if;

    update public.recurring_expenses set
      category          = coalesce(nullif(category_value, ''), category),
      description       = nullif(description_value, ''),
      amount_dkk        = coalesce(amount_value, amount_dkk),
      cadence           = coalesce(nullif(cadence_value, ''), cadence),
      next_due_date     = coalesce(next_due_date_value, next_due_date),
      split_rule        = split_rule_value,
      split_config      = split_config_value,
      paid_by_member_id = coalesce(paid_by_value, paid_by_member_id),
      is_active         = coalesce(is_active_value, is_active),
      updated_at        = now()
    where id = recurring_id_value
      and ledger_id = target_ledger_id;
    result_id := recurring_id_value;
    normalized_event_type := 'recurring_expense_updated';
  end if;

  if nullif(event_title, '') is not null then
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    ) values (
      target_ledger_id,
      normalized_event_type,
      event_title,
      coalesce(event_body, ''),
      actor_member_id,
      nullif(lower(coalesce(auth.jwt() ->> 'email', '')), ''),
      jsonb_build_object('category', coalesce(nullif(category_value, ''), 'other'))
    );
  end if;

  return jsonb_build_object(
    'id', result_id,
    'event_type', normalized_event_type
  );
end;
$$;

revoke all on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) from public;
revoke all on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) from anon;
grant execute on function public.upsert_recurring_expense(text, uuid, text, text, numeric, text, date, text, jsonb, uuid, boolean, text, text) to authenticated;

-- ── GV-274.2: generate_due_recurring_expenses — 24-occurrence catch-up cap ───────
-- Re-declared off migration 075 (its newest prior definition; 083 only re-granted
-- it). Body is 075 verbatim plus one guard: a single template materialises at most
-- MAX_CATCHUP_OCCURRENCES occurrences per run (24). next_due_date advances only
-- through the occurrences actually processed, so a very stale template is caught up
-- across several runs (bounded per tick, nothing lost) rather than generating an
-- unbounded backlog in one call. Same constant as the scheduler sweep below.
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

  for tmpl in
    select *
    from public.recurring_expenses r
    where r.ledger_id = target_ledger_id
      and r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
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

-- ── GV-274.2 + .3: generate_all_due_recurring_expenses — cap + batch fairness ────
-- Re-declared off migration 110 (its only prior definition). Two changes:
--   * The same MAX_CATCHUP_OCCURRENCES (24) per-template cap as the client RPC.
--   * The candidate-ledger scan now requires an OPEN period to EXIST and orders by
--     the ledger's oldest due next_due_date ascending (GV-274). A ledger with no
--     open period never occupies a batch slot (the inner FOR SHARE would skip it
--     anyway, wasting a slot), and the oldest debt is served first under the
--     batch_limit. The inner open-period FOR SHARE + null-skip stay as a
--     belt-and-braces guard against a period that closes between scan and process.
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
  -- Same per-template catch-up bound as generate_due_recurring_expenses (GV-274).
  max_catchup_occurrences constant integer := 24;
begin
  for due_ledger in
    -- Only ledgers with a due active template AND an open period to receive it,
    -- oldest debt first, so no-open-period ledgers never occupy a batch slot and
    -- the most overdue ledger is caught up first under batch_limit (GV-274).
    select r.ledger_id
    from public.recurring_expenses r
    where r.is_active
      and r.deleted_at is null
      and r.next_due_date <= current_date
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

-- ── GV-274.4: calculate_period_settlement — credit-only inactive payers ──────────
-- Re-declared off migration 108 (its newest prior definition). The trips/fuel and
-- largest-remainder maths are byte-identical to 108; the ONLY change is that a
-- payer who is an INACTIVE member of the ledger is no longer dropped. Owner
-- decision (2026-07-11): an inactive payer becomes a CREDIT-ONLY participant —
-- credited exactly what they paid (fuel + expense + repair), with ZERO weight in
-- every share split. Concretely:
--   * all_members is the full membership; active_members is the split universe.
--   * period_expenses / period_repairs join all_members (not active_members), so
--     an inactive-payer entry is retained and its cost is still split — but the
--     weight CTEs cross join active_members only, so the split lands entirely on
--     ACTIVE members and the inactive payer bears nothing (largest-remainder
--     semantics unchanged).
--   * settlement_members = active_members UNION any member (active or not) who
--     paid fuel/expense/repair this period; per_member is built from it. An
--     inactive member who paid NOTHING is not a settlement_member and never
--     appears. Fuel already had no active-only join — it was dropped only because
--     per_member was built from active_members — so widening per_member credits
--     inactive fuel payers by the same rule (consistent everywhere).
--   * An inactive payer has no km (km_shares is active-only), no expense_share,
--     no repair_share, so their net is exactly +paid and the period still nets to
--     zero. Signature unchanged; grants restated.
create or replace function public.calculate_period_settlement(
  target_ledger_id text,
  target_period_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if target_period_id is null then
    raise exception 'Missing settlement period id' using errcode = '22023';
  end if;

  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate settlements' using errcode = '42501';
  end if;

  with active_members as (
    select lm.id, lm.name
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
      and lm.is_active = true
  ),
  all_members as (
    -- Every member of the ledger, active or not. Used to retain (not drop) an
    -- entry whose payer has since gone inactive so that payer can be credited
    -- (GV-274, credit-only). is_active decides who lands in settlement_members.
    select lm.id, lm.name, lm.is_active
    from public.ledger_members lm
    where lm.ledger_id = target_ledger_id
  ),
  live_trips as (
    select t.id,
           t.driver_member_id,
           greatest(t.end_km - t.start_km, 0)::numeric as km
    from public.trips t
    where t.ledger_id = target_ledger_id
      and t.period_id = target_period_id
      and t.deleted_at is null
  ),
  trip_assignees as (
    select lt.id as trip_id,
           lt.km,
           coalesce(
             valid_participants.member_ids,
             case when driver_check.id is not null then array[lt.driver_member_id] end
           ) as assignees
    from live_trips lt
    left join lateral (
      select array_agg(distinct tp.member_id) as member_ids
      from public.trip_participants tp
      join active_members am on am.id = tp.member_id
      where tp.trip_id = lt.id
    ) valid_participants on true
    left join active_members driver_check on driver_check.id = lt.driver_member_id
  ),
  km_shares as (
    select shared.member_id,
           ta.km / array_length(ta.assignees, 1) as share_km
    from trip_assignees ta
    cross join lateral unnest(ta.assignees) as shared(member_id)
    where ta.assignees is not null
      and array_length(ta.assignees, 1) > 0
  ),
  member_km as (
    -- Unrounded per-member km, reused both for the settlement km and as the
    -- usage-split weight (the client weights usage on raw km).
    select ks.member_id, sum(ks.share_km) as km_sum
    from km_shares ks
    group by ks.member_id
  ),
  fuel_paid as (
    select fp.payer_member_id as member_id,
           sum(fp.amount)::numeric as paid
    from public.fuel_payments fp
    where fp.ledger_id = target_ledger_id
      and fp.period_id = target_period_id
      and fp.deleted_at is null
      and fp.payer_member_id is not null
    group by fp.payer_member_id
  ),
  ledger_defaults as (
    select l.expense_split_defaults as defaults
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  repairs_mode as (
    -- The workspace rule that governs repair folding (GVM-307). null (old row,
    -- pre-107) behaves like deles_ikke: the mode filter below excludes every
    -- repair, matching a client that has no mode field to read.
    select l.repairs_split_mode as mode
    from public.ledgers l
    where l.id = target_ledger_id
  ),
  period_bounds as (
    -- Repairs have no period_id: a repair counts in the period whose
    -- [opened_at, closed_at) window contains its created_at — the moment it was
    -- LOGGED (GV-269; repair_date is display-only and may lie far in the past).
    -- The settling period is still open here (closed_at null), so its window has
    -- no upper bound.
    select sp.opened_at, sp.closed_at
    from public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
  ),
  period_expenses as (
    -- Live expenses in this period whose payer is a MEMBER of the ledger (active
    -- OR inactive). An inactive payer is retained (credit-only, GV-274) rather
    -- than dropped: its cost is still split (over active members, via the weight
    -- CTEs below), and the payer is credited what they paid. An expense with no
    -- payer or a non-member payer is still skipped entirely.
    select we.id,
           we.amount_dkk,
           we.paid_by_member_id,
           we.split_config,
           coalesce(nullif(we.split_rule, ''),
                    (ld.defaults ->> we.category),
                    'equal') as rule
    from public.workspace_expenses we
    cross join ledger_defaults ld
    join all_members payer on payer.id = we.paid_by_member_id
    where we.ledger_id = target_ledger_id
      and we.period_id = target_period_id
      and we.deleted_at is null
      and we.amount_dkk > 0
  ),
  expense_weights as (
    select pe.id as expense_id,
           pe.amount_dkk,
           am.id as member_id,
           case pe.rule
             when 'usage'  then coalesce(mk.km_sum, 0)
             when 'custom' then coalesce((pe.split_config ->> am.id::text)::numeric, 0)
             else 1::numeric
           end as weight
    from period_expenses pe
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  expense_weight_totals as (
    select expense_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from expense_weights
    group by expense_id
  ),
  expense_cents as (
    -- Largest-remainder split, step 1 (GV-269): per expense, work in integer
    -- oere and compute each member's exact (unrounded) share of them. A
    -- non-positive total weight falls back to equal weights, matching the
    -- pre-108 fallback and the client.
    select ew.expense_id,
           ew.member_id,
           round(ew.amount_dkk * 100) as total_cents,
           round(ew.amount_dkk * 100)
             * (case when ewt.total_weight > 0 then ew.weight else 1 end)
             / (case when ewt.total_weight > 0 then ewt.total_weight else ewt.member_count end)
             as exact_cents
    from expense_weights ew
    join expense_weight_totals ewt using (expense_id)
  ),
  expense_lr as (
    -- Step 2: floor every share, then hand the leftover oere (R = total oere -
    -- sum of floors, 0 <= R < member count) to the R members with the largest
    -- remainders; ties break on member id ascending (uuid byte order = its
    -- canonical text order), matching the client tie-break. Every expense's
    -- shares now sum EXACTLY to its amount.
    select ec.member_id,
           floor(ec.exact_cents)
             + case when row_number() over (
                      partition by ec.expense_id
                      order by ec.exact_cents - floor(ec.exact_cents) desc, ec.member_id asc
                    ) <= ec.total_cents - sum(floor(ec.exact_cents)) over (partition by ec.expense_id)
                    then 1 else 0 end
             as share_cents
    from expense_cents ec
  ),
  expense_share as (
    select el.member_id,
           sum(el.share_cents) / 100.0 as share
    from expense_lr el
    group by el.member_id
  ),
  expense_paid as (
    select pe.paid_by_member_id as member_id, sum(pe.amount_dkk)::numeric as paid
    from period_expenses pe
    group by pe.paid_by_member_id
  ),
  period_repairs as (
    -- Repairs folded per the workspace mode (GVM-307). Only efter_koersel /
    -- ligeligt fold; deles_ikke (or a null mode) yields no rows. The payer is
    -- paid_by_member_id, falling back to created_by_member_id for pre-108 rows
    -- (GV-269); a repair whose payer is a MEMBER of the ledger — active OR
    -- inactive — is retained (credit-only, GV-274; an inactive payer's cost still
    -- splits over active members and the payer is credited). A repair whose payer
    -- is not a member at all is skipped. Scoped by created_at (timestamps, no
    -- ::date truncation) within the period's [opened_at, closed_at) window.
    select vr.id,
           vr.cost_dkk,
           coalesce(vr.paid_by_member_id, vr.created_by_member_id) as payer_member_id,
           rm.mode
    from public.vehicle_repairs vr
    cross join repairs_mode rm
    cross join period_bounds pb
    join all_members payer on payer.id = coalesce(vr.paid_by_member_id, vr.created_by_member_id)
    where vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.cost_dkk > 0
      and rm.mode in ('efter_koersel', 'ligeligt')
      and vr.created_at >= pb.opened_at
      and (pb.closed_at is null or vr.created_at < pb.closed_at)
  ),
  repair_weights as (
    -- efter_koersel weights by each member's raw km (like the expense usage rule);
    -- ligeligt weights everyone equally. Zero total weight (efter_koersel with no
    -- km) falls back to an equal split below, matching the client.
    select pr.id as repair_id,
           pr.cost_dkk,
           am.id as member_id,
           case when pr.mode = 'efter_koersel' then coalesce(mk.km_sum, 0)
                else 1::numeric end as weight
    from period_repairs pr
    cross join active_members am
    left join member_km mk on mk.member_id = am.id
  ),
  repair_weight_totals as (
    select repair_id, sum(weight) as total_weight, count(*)::numeric as member_count
    from repair_weights
    group by repair_id
  ),
  repair_cents as (
    -- Largest-remainder split for repairs — identical to the expense chain above
    -- (GV-269).
    select rw.repair_id,
           rw.member_id,
           round(rw.cost_dkk * 100) as total_cents,
           round(rw.cost_dkk * 100)
             * (case when rwt.total_weight > 0 then rw.weight else 1 end)
             / (case when rwt.total_weight > 0 then rwt.total_weight else rwt.member_count end)
             as exact_cents
    from repair_weights rw
    join repair_weight_totals rwt using (repair_id)
  ),
  repair_lr as (
    select rc.member_id,
           floor(rc.exact_cents)
             + case when row_number() over (
                      partition by rc.repair_id
                      order by rc.exact_cents - floor(rc.exact_cents) desc, rc.member_id asc
                    ) <= rc.total_cents - sum(floor(rc.exact_cents)) over (partition by rc.repair_id)
                    then 1 else 0 end
             as share_cents
    from repair_cents rc
  ),
  repair_share as (
    select rl.member_id,
           sum(rl.share_cents) / 100.0 as share
    from repair_lr rl
    group by rl.member_id
  ),
  repair_paid as (
    select pr.payer_member_id as member_id, sum(pr.cost_dkk)::numeric as paid
    from period_repairs pr
    group by pr.payer_member_id
  ),
  settlement_members as (
    -- The settlement participant set (GV-274): every ACTIVE member, plus any
    -- member (necessarily inactive, since actives are already in) who PAID fuel,
    -- an expense, or a repair this period. Inactive payers are credit-only — they
    -- appear so they can be credited what they paid, but they carry zero weight in
    -- every share split (the weight CTEs cross join active_members only), so their
    -- net is exactly +paid. An inactive member who paid nothing never appears.
    select am.id, am.name
    from all_members am
    where am.is_active
       or am.id in (select fp.member_id from fuel_paid fp)
       or am.id in (select ep.member_id from expense_paid ep)
       or am.id in (select rp.member_id from repair_paid rp)
  ),
  per_member as (
    select sm.id,
           sm.name,
           round(coalesce(mk.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid,
           round(coalesce(xp.paid, 0), 2) as expense_paid,
           round(coalesce(xs.share, 0), 2) as expense_share,
           round(coalesce(rp.paid, 0), 2) as repair_paid,
           round(coalesce(rs.share, 0), 2) as repair_share
    from settlement_members sm
    left join member_km mk on mk.member_id = sm.id
    left join fuel_paid f on f.member_id = sm.id
    left join expense_paid xp on xp.member_id = sm.id
    left join expense_share xs on xs.member_id = sm.id
    left join repair_paid rp on rp.member_id = sm.id
    left join repair_share rs on rs.member_id = sm.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid,
           coalesce(sum(pm.expense_paid), 0) as total_expenses,
           coalesce(sum(pm.repair_paid), 0) as total_repairs
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'totalExpenses', t.total_expenses,
    'totalRepairs', t.total_repairs,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'expensePaid', pm.expense_paid,
        'expenseShare', pm.expense_share,
        'repairPaid', pm.repair_paid,
        'repairShare', pm.repair_share,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid + pm.expense_paid + pm.repair_paid - round(pm.km * (t.total_paid / t.total_km), 2) - pm.expense_share - pm.repair_share, 2)
                    else round(pm.fuel_paid + pm.expense_paid + pm.repair_paid - pm.expense_share - pm.repair_share, 2) end
      ) order by pm.id::text collate "C")
      from per_member pm
    ), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.calculate_period_settlement(text, uuid) from public;
revoke all on function public.calculate_period_settlement(text, uuid) from anon;
grant execute on function public.calculate_period_settlement(text, uuid) to authenticated;

-- ── GV-275: set_notification_preferences — null-means-unchanged back-compat ──────
-- Re-declared off migration 109 (its newest prior definition). The four advanced
-- params now default NULL = "leave unchanged": each is COALESCEd with the caller's
-- EXISTING row, falling back to the standard defaults (snooze off, quiet disabled
-- 22->7) only when no row exists yet. A trailing clear_snooze_value explicitly
-- clears the snooze (null-means-unchanged makes clearing impossible otherwise). So
-- an old 3-arg client toggling a category can no longer wipe a snooze / quiet-hours
-- setting it never knew about. Validation from 109 is unchanged, run against the
-- EFFECTIVE (coalesced) values. Signature changes (adds clear_snooze_value), so the
-- 7-arg version is dropped and the 8-arg recreated with grants restated in full.
drop function if exists public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint);
create function public.set_notification_preferences(
  activity boolean,
  payments boolean,
  periods boolean,
  snooze_until_value timestamptz default null,
  quiet_hours_enabled_value boolean default null,
  quiet_start_hour_value smallint default null,
  quiet_end_hour_value smallint default null,
  clear_snooze_value boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.notification_preferences%rowtype;
  v_snooze timestamptz;
  v_quiet_enabled boolean;
  v_quiet_start smallint;
  v_quiet_end smallint;
begin
  if v_uid is null then
    raise exception 'Notification preferences require a signed-in user' using errcode = '42501';
  end if;

  select * into v_existing
  from public.notification_preferences
  where user_id = v_uid;

  -- Effective advanced values: a null param leaves the existing row value
  -- unchanged (or the standard default when no row exists). clear_snooze_value
  -- wins over any snooze param and sets snooze_until back to null (GV-275).
  if coalesce(clear_snooze_value, false) then
    v_snooze := null;
  else
    v_snooze := coalesce(snooze_until_value, v_existing.snooze_until);
  end if;
  v_quiet_enabled := coalesce(quiet_hours_enabled_value, v_existing.quiet_hours_enabled, false);
  v_quiet_start := coalesce(quiet_start_hour_value, v_existing.quiet_start_hour, 22::smallint);
  v_quiet_end := coalesce(quiet_end_hour_value, v_existing.quiet_end_hour, 7::smallint);

  -- Validation from migration 109, unchanged, on the effective values.
  if v_quiet_start is null or v_quiet_start < 0 or v_quiet_start > 23 then
    raise exception 'quiet_start_hour must be between 0 and 23' using errcode = '22023';
  end if;
  if v_quiet_end is null or v_quiet_end < 0 or v_quiet_end > 23 then
    raise exception 'quiet_end_hour must be between 0 and 23' using errcode = '22023';
  end if;
  if coalesce(v_quiet_enabled, false) and v_quiet_start = v_quiet_end then
    raise exception 'quiet hours start and end must differ when enabled' using errcode = '22023';
  end if;
  if v_snooze is not null
     and (v_snooze <= now() - interval '1 minute'
          or v_snooze > now() + interval '30 days') then
    raise exception 'snooze_until must be in the future and at most 30 days out' using errcode = '22023';
  end if;

  insert into public.notification_preferences (
    user_id, activity_enabled, payments_enabled, periods_enabled,
    snooze_until, quiet_hours_enabled, quiet_start_hour, quiet_end_hour, updated_at
  )
  values (
    v_uid,
    coalesce(activity, true),
    coalesce(payments, true),
    coalesce(periods, true),
    v_snooze,
    coalesce(v_quiet_enabled, false),
    v_quiet_start,
    v_quiet_end,
    now()
  )
  on conflict (user_id) do update
  set activity_enabled = excluded.activity_enabled,
      payments_enabled = excluded.payments_enabled,
      periods_enabled = excluded.periods_enabled,
      snooze_until = excluded.snooze_until,
      quiet_hours_enabled = excluded.quiet_hours_enabled,
      quiet_start_hour = excluded.quiet_start_hour,
      quiet_end_hour = excluded.quiet_end_hour,
      updated_at = now();
end;
$$;

revoke all on function public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint, boolean) from public;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint, boolean) to authenticated;

-- ── GV-274: repair-aware close-staleness fingerprint ────────────────────────────
-- Re-declared off migration 070 (its newest prior definition; 083 only re-granted
-- it). Since GVM-307/108 folded repairs into the settlement, a repair added or
-- removed while a close is being prepared changes the computed settlement — but the
-- close-staleness fingerprint only covered trips/fuel/expenses, and the totals guard
-- only checks totalKm/totalPaid (repairs move neither). So a stale snapshot could
-- close over a changed repair set. This adds repairs to the fingerprint, scoped by
-- created_at within the period's [opened_at, closed_at) window (deleted_at null) —
-- identical to how calculate_period_settlement and the mobile client
-- (scopeRepairsToPeriod) scope them. The "repairs" key is appended ONLY when the
-- period has at least one in-scope repair, so a period with no repairs produces the
-- byte-identical trips/fuel/expenses string as before (and matches the mobile
-- client's periodEntryFingerprint, which likewise omits the key when empty).
create or replace function public.calculate_period_entry_fingerprint(
  target_ledger_id text,
  target_period_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result text;
  repairs_json text;
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

  -- Repairs have no period_id: a repair belongs to the period whose
  -- [opened_at, closed_at) window contains its created_at (the moment it was
  -- LOGGED), exactly as calculate_period_settlement scopes them (GV-269). During a
  -- close the period is still open (closed_at null), so the window has no upper
  -- bound. Empty string when the period has no in-scope repair.
  select coalesce(
           string_agg(to_json(vr.id::text)::text, ',' order by vr.id::text collate "C"),
           '')
    into repairs_json
    from public.vehicle_repairs vr
    cross join public.settlement_periods sp
    where sp.id = target_period_id
      and sp.ledger_id = target_ledger_id
      and vr.ledger_id = target_ledger_id
      and vr.deleted_at is null
      and vr.created_at >= sp.opened_at
      and (sp.closed_at is null or vr.created_at < sp.closed_at);

  select '{"trips":['
    || coalesce((
         select string_agg(to_json(t.id::text)::text, ',' order by t.id::text collate "C")
         from public.trips t
         where t.ledger_id = target_ledger_id
           and t.period_id = target_period_id
           and t.deleted_at is null
       ), '')
    || '],"fuel":['
    || coalesce((
         select string_agg(to_json(fp.id::text)::text, ',' order by fp.id::text collate "C")
         from public.fuel_payments fp
         where fp.ledger_id = target_ledger_id
           and fp.period_id = target_period_id
           and fp.deleted_at is null
       ), '')
    || '],"expenses":['
    || coalesce((
         select string_agg(to_json(we.id::text)::text, ',' order by we.id::text collate "C")
         from public.workspace_expenses we
         where we.ledger_id = target_ledger_id
           and we.period_id = target_period_id
           and we.deleted_at is null
       ), '')
    || ']'
    || case when repairs_json <> '' then ',"repairs":[' || repairs_json || ']' else '' end
    || '}'
  into result;

  return result;
end;
$$;

revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from public;
revoke all on function public.calculate_period_entry_fingerprint(text, uuid) from anon;
grant execute on function public.calculate_period_entry_fingerprint(text, uuid) to authenticated;

-- ── Register migration ────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('112_release_blockers_remediation',
        'Codex release-blocker remediation (GV-273/274/275). GV-273: enforce_repair_period_lock trigger freezes a vehicle_repairs row (UPDATE incl. soft delete, and DELETE) once its created_at falls inside a closed settlement period (errcode 22023, mirrors the GV-199 closed-period rejection). GV-274: upsert_recurring_expense (off 077) requires amount > 0 and next_due_date within [today-90d, today+5y]; both recurring generators (client off 075, scheduler off 110) cap catch-up at 24 occurrences/template/run and advance next_due_date only through what was generated; the scheduler scan now requires an open period to EXIST and orders by oldest due next_due_date; calculate_period_settlement (off 108) makes an INACTIVE payer a credit-only participant — credited what they paid with zero share weight, cost still split over active members, net = +paid, applied to expenses, repairs, and fuel consistently; calculate_period_entry_fingerprint (off 070) is now repair-aware (repairs scoped by created_at, key omitted when empty) so a close over a changed repair set is caught. GV-275: set_notification_preferences (off 109) advanced params default NULL = leave-unchanged (coalesce with existing row) plus a clear_snooze_value to explicitly clear the snooze, so old 3-arg clients no longer reset snooze/quiet hours.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

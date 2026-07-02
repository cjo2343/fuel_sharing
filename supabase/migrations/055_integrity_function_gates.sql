-- Migration 055: operator access + membership gate for the integrity functions (GVM-112)
--
-- Two gate corrections to migration 054's helpers, found during live verification:
--
--   1. calculate_period_settlement required ledger membership unconditionally, so
--      the operator running the verification queries in the Supabase SQL Editor
--      (role postgres, no user JWT) was rejected. Diagnostics from the SQL Editor
--      or the service role are legitimate operator contexts.
--   2. calculate_period_entry_fingerprint shipped with NO membership gate at all:
--      any authenticated user could list another workspace's trip/fuel row ids.
--      It now enforces the same member-or-operator rule.
--
-- public.is_operator_context() is true only when the request carries no user JWT
-- (direct database access: SQL Editor, psql) or the service_role JWT. anon and
-- authenticated PostgREST requests always carry their role claim, so end users
-- can never satisfy it — they still need active membership.

create or replace function public.is_operator_context()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'role', '') in ('', 'service_role');
$$;

revoke all on function public.is_operator_context() from public;
revoke all on function public.is_operator_context() from anon;
grant execute on function public.is_operator_context() to authenticated;

-- ── calculate_period_settlement: allow operator context ─────────────────────
-- Verbatim re-declaration of migration 054's definition; only the gate changed.
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
    -- Participants who are active members; when none remain, fall back to the
    -- driver (if active) — exactly settlement-calc.ts's assignee resolution.
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
  per_member as (
    select am.id,
           am.name,
           round(coalesce(k.km_sum, 0), 2) as km,
           round(coalesce(f.paid, 0), 2) as fuel_paid
    from active_members am
    left join (
      select ks.member_id, sum(ks.share_km) as km_sum
      from km_shares ks
      group by ks.member_id
    ) k on k.member_id = am.id
    left join fuel_paid f on f.member_id = am.id
  ),
  totals as (
    select coalesce(sum(pm.km), 0) as total_km,
           coalesce(sum(pm.fuel_paid), 0) as total_paid
    from per_member pm
  )
  select jsonb_build_object(
    'totalKm', t.total_km,
    'totalPaid', t.total_paid,
    'fuelRate', case when t.total_km > 0 then round(t.total_paid / t.total_km, 2) else 0 end,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pm.id,
        'name', pm.name,
        'km', pm.km,
        'fuelPaid', pm.fuel_paid,
        'tripCost', case when t.total_km > 0 then round(pm.km * (t.total_paid / t.total_km), 2) else 0 end,
        'net', case when t.total_km > 0
                    then round(pm.fuel_paid - round(pm.km * (t.total_paid / t.total_km), 2), 2)
                    else round(pm.fuel_paid, 2) end
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

-- ── calculate_period_entry_fingerprint: add the missing gate ────────────────
-- Same computation as migration 054 (byte-exact vs period-snapshot.ts), now as
-- plpgsql so it can enforce member-or-operator before revealing row ids.
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
begin
  if not public.is_operator_context()
     and not public.is_ledger_member(target_ledger_id) then
    raise exception 'Only ledger members can calculate the entry fingerprint' using errcode = '42501';
  end if;

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
    || ']}'
  into result;

  return result;
end;
$$;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('055_integrity_function_gates', 'is_operator_context() helper; calculate_period_settlement allows operator diagnostics (SQL Editor / service role); calculate_period_entry_fingerprint gains the membership gate it shipped without (GVM-112).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

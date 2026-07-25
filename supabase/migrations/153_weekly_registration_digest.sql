-- Migration 153: weekly group digest of work nobody has registered yet (GVM-440)
--
-- If one member never logs their trips, EVERYONE's settlement is wrong. The app has
-- plenty of private nudges (the booking-ended push from migration 124, the Home
-- backlog item from GVM-433) but nothing that makes the gap visible to the group
-- while there is still time to fix it -- the first time the rest of the group learns
-- about it today is the pre-request warning, i.e. the moment it is too late.
--
-- This adds the missing surface as ONE more hook on the existing hourly reminder
-- tick. No new engine: the same claim/lease/token/confirm discipline as migrations
-- 080, 102, 118 and 124, and the same shared Expo sender in govehlo-web.
--
-- ── OWNER DECISION 1: what "mangler at blive registreret" means ────────────────
-- Two signals, and deliberately only two -- they are exactly the pair
-- settlementReadinessIssues() already computes for the pre-request warning
-- (govehlo-mobile src/lib/settlement-readiness.ts), so the digest and the warning
-- can never disagree about what is outstanding:
--
--   1. ENDED BOOKINGS WITH NO REGISTERED TRIP. car_bookings whose end_at has passed,
--      that are marked requires_linked_trip (migration 124 -- pre-123 bookings are
--      excluded because their date-fallback link is not reliable enough to name), and
--      that have no active row in trips.booking_id. Scoped to the OPEN settlement
--      period: a booking that ended before the period opened can no longer move this
--      period's split, so nagging about it is noise.
--
--   2. DEFERRED FUEL RECEIPTS. trips with fuel_resolution = 'deferred' -- "I refuelled,
--      I will register the receipt later". Deliberately NOT period-scoped, for exactly
--      the reason GVM-427 gives: resolving a deferred receipt writes the fuel into the
--      CURRENT open period, so a receipt deferred in period 1 and still outstanding in
--      period 2 changes period 2's split. Filtering by the trip's period would hide the
--      single most likely outstanding case.
--
-- NOT counted, on purpose: an unclosed period (the close reminder from migration 080
-- already owns that, and duplicating it would make the digest the thing people mute),
-- and "a trip that was never booked", which is unknowable -- there is no record of a
-- drive nobody wrote down and no booking to hang it on.
--
-- ── OWNER DECISION 2: cadence ──────────────────────────────────────────────────
-- SUNDAY 18:00-20:59, Europe/Copenhagen. Sunday evening is when the week's driving is
-- over and the person is at home with their phone, and it lands before the typical
-- month-end close rather than after it. The window is three hours wide, not one, so a
-- run that is deferred by quiet hours (GVM-286), a snooze, or a transient Expo failure
-- still gets two more attempts the same evening instead of losing the week. The hour is
-- read in DANISH LOCAL TIME (now() at time zone 'Europe/Copenhagen'), so CET/CEST does
-- not drift the send time twice a year.
--
-- The hook rides the EXISTING hourly cron rather than adding a weekly cron trigger.
-- Two reasons: 165 of every 168 hourly calls return zero rows for the price of one
-- cheap indexed probe, and a weekly trigger has exactly one shot per week -- if that
-- single firing lands during an outage, the digest silently skips a week.
--
-- ── OWNER DECISION 3: opt-out, and its default ─────────────────────────────────
-- weekly_digest_enabled is a WORKSPACE setting (admin-only setter below) and it
-- defaults to TRUE. That is the one genuinely arguable default here, so it is called
-- out rather than buried:
--   * FOR true: the digest only ever fires when there is real unfinished work -- a
--     group that keeps its log current never hears from it at all. It is a
--     transactional nudge about the members' own shared car, not marketing, so
--     markedsføringsloven §10 does not apply and no prior consent is required.
--   * FOR false: it is still an unsolicited weekly push, and those are how people end
--     up switching off notifications for an app entirely.
-- MIGRATIONS ARE APPLIED BY HAND, so this is a live choice: to ship it opt-IN instead,
-- change `default true` to `default false` on the weekly_digest_enabled column BELOW
-- and in the mirrored block in supabase-schema.sql before applying. Nothing else in
-- this migration or in either client depends on which way it goes.
--
-- Independently of the workspace switch, every individual already has three ways out
-- that this reuses for free (govehlo-web functions/api/_push.js): the 'activity'
-- notification category mute (GVM-119), the snooze, and quiet hours (GVM-286).
--
-- ── Double sends ───────────────────────────────────────────────────────────────
-- weekly_digest_sent_at is stamped only by confirm_weekly_digests, and only against a
-- matching one-shot claim token, so a crash between claim and send never marks a
-- workspace as digested. The claim itself takes a 15-minute lease under
-- `for update ... skip locked`, so two overlapping ticks cannot both pick up the same
-- workspace, and the six-day floor on weekly_digest_sent_at means a workspace cannot be
-- digested twice inside one weekend even if its lease expires mid-window.

alter table public.ledgers
  add column if not exists weekly_digest_enabled boolean not null default true,
  add column if not exists weekly_digest_claimed_at timestamptz,
  add column if not exists weekly_digest_claim_token uuid,
  add column if not exists weekly_digest_sent_at timestamptz;

comment on column public.ledgers.weekly_digest_enabled is
  'GVM-440: workspace switch for the weekly "what is still unregistered" digest push. Admin-only via set_weekly_digest_enabled. Per-member opt-outs (activity mute / snooze / quiet hours) apply on top of this and are honoured by the push hook, not here.';

create index if not exists ledgers_weekly_digest_due_idx
  on public.ledgers (weekly_digest_sent_at)
  where weekly_digest_enabled = true;

-- Admin-only workspace switch, mirroring set_close_reminder_enabled (migration 083's
-- grant shape): the digest is about the whole group's bookkeeping, so one member
-- cannot silence it for everyone -- they mute their own notifications instead.
create or replace function public.set_weekly_digest_enabled(
  target_ledger_id text,
  enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change reminder settings.' using errcode = '42501';
  end if;

  update public.ledgers l
  set weekly_digest_enabled = coalesce(enabled, true),
      updated_at = now()
  where l.id = target_ledger_id;
end;
$$;

revoke all on function public.set_weekly_digest_enabled(text, boolean) from public;
revoke all on function public.set_weekly_digest_enabled(text, boolean) from anon;
grant execute on function public.set_weekly_digest_enabled(text, boolean) to authenticated;

-- ── claim_due_weekly_digests: engine op for the scheduled push ─────────────────
-- Returns nothing at all outside the Sunday-evening window, which is what makes it
-- safe to hang off the hourly tick. Inside the window it claims every enabled
-- workspace that (a) has outstanding registration work right now and (b) has not been
-- digested in the last six days, stamping a fresh one-shot token per claim.
--
-- `recipients` carries one entry per ACTIVE member with an e-mail, each with that
-- member's OWN outstanding counts, so the push hook can address the person who forgot
-- ("du mangler...") and everyone else with the group total, from a single claim.
-- Members with nothing outstanding are still included -- the point of the digest is
-- that the group sees the gap, not that the forgetful member is singled out.
--
-- Service-role only -- not client-callable.
create or replace function public.claim_due_weekly_digests(
  p_limit integer default 200
)
returns table (
  ledger_id text,
  claim_token uuid,
  missing_trips integer,
  deferred_fuel integer,
  recipients jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp := (now() at time zone 'Europe/Copenhagen');
begin
  -- Sunday (ISO day 7), 18:00-20:59 Danish local time. Outside it there is nothing to
  -- claim and, deliberately, nothing to lock either.
  if extract(isodow from v_local) <> 7
     or extract(hour from v_local) < 18
     or extract(hour from v_local) > 20 then
    return;
  end if;

  return query
  with outstanding as (
    -- Ended bookings in the open period with no registered trip.
    select cb.ledger_id as l_id, cb.member_id as m_id, 'trip'::text as kind
    from public.car_bookings cb
    join public.settlement_periods sp
      on sp.ledger_id = cb.ledger_id
     and sp.status = 'open'
    where cb.deleted_at is null
      and cb.requires_linked_trip = true
      and cb.member_id is not null
      and cb.end_at <= now()
      and cb.end_at >= sp.opened_at
      and not exists (
        select 1
        from public.trips t
        where t.booking_id = cb.id
          and t.deleted_at is null
      )
    union all
    -- Deferred fuel receipts, NOT period-scoped (GVM-427): resolving one writes into
    -- the CURRENT open period regardless of which period its trip sits in.
    select t.ledger_id as l_id, t.driver_member_id as m_id, 'fuel'::text as kind
    from public.trips t
    where t.deleted_at is null
      and t.fuel_resolution = 'deferred'
      and t.booking_id is not null
      and t.driver_member_id is not null
  ),
  scoped as (
    -- Only work owed by a still-active member counts: a departed member's leftovers
    -- are an admin cleanup job, not something to nag the group about every Sunday.
    select o.l_id, o.m_id, o.kind
    from outstanding o
    join public.ledger_members lm
      on lm.id = o.m_id
     and lm.ledger_id = o.l_id
     and lm.is_active = true
  ),
  totals as (
    select s.l_id,
           (count(*) filter (where s.kind = 'trip'))::integer as missing_trips,
           (count(*) filter (where s.kind = 'fuel'))::integer as deferred_fuel
    from scoped s
    group by s.l_id
  ),
  per_member as (
    select s.l_id,
           s.m_id,
           (count(*) filter (where s.kind = 'trip'))::integer as own_trips,
           (count(*) filter (where s.kind = 'fuel'))::integer as own_fuel
    from scoped s
    group by s.l_id, s.m_id
  ),
  target as (
    select l.id
    from public.ledgers l
    join totals tt on tt.l_id = l.id
    where l.weekly_digest_enabled = true
      and (l.weekly_digest_sent_at is null
           or l.weekly_digest_sent_at <= now() - interval '6 days')
      and (l.weekly_digest_claimed_at is null
           or l.weekly_digest_claimed_at <= now() - interval '15 minutes')
    order by l.id
    limit greatest(coalesce(p_limit, 200), 0)
    for update of l skip locked
  ),
  claimed as (
    update public.ledgers l
    set weekly_digest_claimed_at = now(),
        weekly_digest_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where l.id = t.id
    returning l.id as l_id, l.weekly_digest_claim_token as token
  )
  select c.l_id,
         c.token,
         tt.missing_trips,
         tt.deferred_fuel,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'email', lower(lm.email),
                       'own_trips', coalesce(pm.own_trips, 0),
                       'own_fuel', coalesce(pm.own_fuel, 0)
                     )
                     order by lower(lm.email)
                   )
            from public.ledger_members lm
            left join per_member pm
              on pm.l_id = lm.ledger_id
             and pm.m_id = lm.id
            where lm.ledger_id = c.l_id
              and lm.is_active = true
              and lm.email is not null),
           '[]'::jsonb
         ) as recipients
  from claimed c
  join totals tt on tt.l_id = c.l_id;
end;
$$;

revoke all on function public.claim_due_weekly_digests(integer) from public;
revoke all on function public.claim_due_weekly_digests(integer) from anon;
revoke all on function public.claim_due_weekly_digests(integer) from authenticated;
grant execute on function public.claim_due_weekly_digests(integer) to service_role;

-- ── confirm_weekly_digests: the other half of the lease ────────────────────────
-- Stamps weekly_digest_sent_at ONLY for a workspace whose claim token still matches
-- and whose six-day floor still holds, so a stale token from an expired lease cannot
-- retro-confirm a send and a retry inside the window cannot double-stamp. An
-- unconfirmed workspace simply becomes claimable again when its 15-minute lease
-- lapses -- under-sending on a crash, never double-sending.
--
-- Logs one ledger_events row per confirmed workspace: the reminder engines' audit
-- convention (migration 124), and the row is what makes other members' open clients
-- refresh. Counts only -- no e-mail, name, or push copy.
create or replace function public.confirm_weekly_digests(confirmations jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with input as (
    select (elem ->> 'id') as ledger_id,
           (elem ->> 'token')::uuid as claim_token,
           (elem ->> 'outcome') as outcome,
           greatest(coalesce((elem ->> 'recipients')::integer, 0), 0) as recipients
    from jsonb_array_elements(coalesce(confirmations, '[]'::jsonb)) as elem
    where (elem ->> 'outcome') in ('delivered', 'suppressed_no_device', 'muted')
  ),
  confirmed as (
    update public.ledgers l
    set weekly_digest_sent_at = now(),
        weekly_digest_claimed_at = null,
        weekly_digest_claim_token = null,
        updated_at = now()
    from input i
    where l.id = i.ledger_id
      and l.weekly_digest_claimed_at is not null
      and l.weekly_digest_claim_token = i.claim_token
      and (l.weekly_digest_sent_at is null
           or l.weekly_digest_sent_at <= now() - interval '6 days')
    returning l.id as ledger_id,
              i.outcome as outcome,
              i.recipients as recipients
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email,
      target_member_id, metadata
    )
    select c.ledger_id,
           'weekly_digest_sent',
           'Ugentligt resumé behandlet',
           '',
           null,
           null,
           null,
           jsonb_build_object('outcome', c.outcome, 'recipients', c.recipients)
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_weekly_digests(jsonb) from public;
revoke all on function public.confirm_weekly_digests(jsonb) from anon;
revoke all on function public.confirm_weekly_digests(jsonb) from authenticated;
grant execute on function public.confirm_weekly_digests(jsonb) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '153_weekly_registration_digest',
  'GVM-440: weekly Sunday-evening group digest of registration work nobody has done yet. Adds the workspace switch weekly_digest_enabled (default true, admin-only via set_weekly_digest_enabled) plus a 15-minute lease/one-shot-token pair of service-role-only RPCs, claim_due_weekly_digests + confirm_weekly_digests, on the same claim-then-confirm-after-send discipline as migrations 080/102/118/124. "Missing" is defined as exactly the two signals settlementReadinessIssues() already computes: ended bookings in the OPEN period with no linked trip (requires_linked_trip only, so pre-123 date-fallback bookings are excluded), and deferred fuel receipts, which are deliberately not period-scoped because resolving one writes into the current open period (GVM-427). The claim returns nothing outside Sunday 18:00-20:59 Europe/Copenhagen, which is what lets it hang off the existing hourly cron instead of needing a weekly trigger with a single yearly-52 shot at firing. Six-day floor on weekly_digest_sent_at plus skip-locked claiming means a workspace cannot be digested twice in one weekend, and a crash between claim and send under-sends rather than double-sends.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

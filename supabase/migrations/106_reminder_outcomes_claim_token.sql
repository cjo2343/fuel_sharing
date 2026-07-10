-- Migration 106: reminder outcome states + claim token (GV-265)
--
-- Builds on the GV-254 two-phase claim lease (migration 102). Two changes:
--
--   1. Per-lease claim token. Migration 102 lets any worker that sees a non-null
--      *_claimed_at within the 15-minute window confirm a row. If a slow worker's
--      send finally lands AFTER its lease expired and a SECOND worker already
--      re-claimed the row, the stale worker could still confirm the newer lease
--      and double-advance the cadence. Each claim now stamps a fresh
--      gen_random_uuid() into a *_claim_token column and returns it; confirm only
--      matches when BOTH the lease is live AND the supplied token equals the
--      stored one, so a stale worker holding an old token can no longer confirm.
--
--   2. Delivery outcome. The web hooks classify each row they processed —
--      'delivered' (Expo accepted at least one ticket), 'suppressed_no_device'
--      (no email / no registered token after the mute filter), or 'muted' (tokens
--      existed but every one was dropped because the recipient muted the
--      category). All three are terminal "the slot is spent" states that advance
--      the cadence exactly as a delivery does — the difference is only recorded
--      for the admin activity feed. A FAILED send (Expo/network error, or a
--      thrown prefs lookup) is never one of these outcomes: the hook simply does
--      not confirm it, the lease expires, and the daily scheduler retries. The
--      outcome is written into the existing ledger_events metadata as "outcome";
--      title/body and every other metadata field stay exactly as 102 wrote them.
--
-- Both claim RPCs are re-declared off their 102 definitions. The claimed CTE now
-- also sets the *_claim_token, and the RETURNS TABLE gains a trailing
-- claim_token uuid column. Because Postgres cannot add an OUT column to an
-- existing function with CREATE OR REPLACE (the return type changes), each claim
-- RPC is dropped and recreated; the argument signature is unchanged (integer),
-- so the web caller and its RPC name/params are untouched and the extra
-- claim_token is simply an additional field in the returned JSON that old web
-- code ignores. The two confirm RPCs change signature from (uuid[]) to a single
-- (confirmations jsonb) — an array of {"id","token","outcome"} objects — so they
-- are dropped explicitly and recreated with a full service_role-only grant
-- restatement.
--
-- Deploy order (web + SQL ship separately; SQL is applied by hand after merge):
--   * WEB-FIRST (new hooks live, 106 not yet applied): the new hooks read
--     row.claim_token (undefined against the old claim def) and POST the new
--     confirm shape {confirmations:[…]}. The DB still exposes only
--     confirm_*_reminders(uuid[]), so PostgREST finds no function matching the
--     `confirmations` argument → the confirm call throws → the hook records
--     confirm_failed and returns 200. The OLD claim defs still stamp a
--     lease-only claim (no token, no cadence bump), so nothing is double-counted;
--     the rows just wait for the SQL to land and confirm on a later run.
--   * SQL-FIRST (106 applied, old hooks still live): the old hooks POST the old
--     confirm shape {request_ids:[…]} / {period_ids:[…]}, but that signature was
--     dropped, so PostgREST finds no match → confirm throws → the hook's existing
--     catch leaves the lease to expire and the row retries. The new claim defs
--     only ever stamp a lease + token, so again nothing is double-stamped.
--   Both directions are safe (no burned slot, no double cadence advance); apply
--   the SQL promptly after the web deploy so confirmations resume the same day.

alter table public.settlement_requests add column if not exists reminder_claim_token uuid;
alter table public.settlement_periods add column if not exists close_reminder_claim_token uuid;

-- ── claim_due_close_reminders: lease + claim token (return gains claim_token) ────────
drop function if exists public.claim_due_close_reminders(integer);
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[], claim_token uuid)
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
        close_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id,
              sp.ledger_id as ledger_id,
              sp.label as label,
              sp.close_reminder_claim_token as claim_token
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails,
         c.claim_token
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label, c.claim_token;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;

-- ── claim_due_payment_reminders: lease + claim token (return gains claim_token) ──────
drop function if exists public.claim_due_payment_reminders(integer);
create or replace function public.claim_due_payment_reminders(
  batch_limit integer default 200
)
returns table (request_id uuid, ledger_id text, debtor_email text, creditor_name text, amount numeric, claim_token uuid)
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
        reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where sr.id = t.id
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount,
              sr.reminder_claim_token as claim_token
  )
  select c.request_id,
         c.ledger_id,
         lower(debtor.email) as debtor_email,
         creditor.name as creditor_name,
         c.amount,
         c.claim_token
  from claimed c
  left join public.ledger_members debtor on debtor.id = c.debtor_id
  left join public.ledger_members creditor on creditor.id = c.creditor_id;
end;
$$;

revoke all on function public.claim_due_payment_reminders(integer) from public;
revoke all on function public.claim_due_payment_reminders(integer) from anon;
revoke all on function public.claim_due_payment_reminders(integer) from authenticated;
grant execute on function public.claim_due_payment_reminders(integer) to service_role;

-- ── confirm_close_reminders(jsonb): token-gated confirm + outcome in metadata ────────
drop function if exists public.confirm_close_reminders(uuid[]);
create or replace function public.confirm_close_reminders(confirmations jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with input as (
    select (elem ->> 'id')::uuid as period_id,
           (elem ->> 'token')::uuid as claim_token,
           (elem ->> 'outcome') as outcome
    from jsonb_array_elements(coalesce(confirmations, '[]'::jsonb)) as elem
    where (elem ->> 'outcome') in ('delivered', 'suppressed_no_device', 'muted')
  ),
  confirmed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        close_reminder_claimed_at = null,
        close_reminder_claim_token = null,
        updated_at = now()
    from input i
    where sp.id = i.period_id
      and sp.close_reminder_claimed_at is not null
      and sp.close_reminder_claim_token = i.claim_token
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label, i.outcome as outcome
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    )
    select c.ledger_id, 'close_reminder_sent', 'Lukkepåmindelse sendt', '',
           null, null,
           jsonb_build_object(
             'period_id', c.period_id,
             'label', c.label,
             'outcome', c.outcome
           )
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_close_reminders(jsonb) from public;
revoke all on function public.confirm_close_reminders(jsonb) from anon;
revoke all on function public.confirm_close_reminders(jsonb) from authenticated;
grant execute on function public.confirm_close_reminders(jsonb) to service_role;

-- ── confirm_payment_reminders(jsonb): token-gated confirm + outcome in metadata ──────
drop function if exists public.confirm_payment_reminders(uuid[]);
create or replace function public.confirm_payment_reminders(confirmations jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with input as (
    select (elem ->> 'id')::uuid as request_id,
           (elem ->> 'token')::uuid as claim_token,
           (elem ->> 'outcome') as outcome
    from jsonb_array_elements(coalesce(confirmations, '[]'::jsonb)) as elem
    where (elem ->> 'outcome') in ('delivered', 'suppressed_no_device', 'muted')
  ),
  confirmed as (
    update public.settlement_requests sr
    set reminder_count = sr.reminder_count + 1,
        last_reminder_at = now(),
        reminder_claimed_at = null,
        reminder_claim_token = null,
        updated_at = now()
    from input i
    where sr.id = i.request_id
      and sr.reminder_claimed_at is not null
      and sr.reminder_claim_token = i.claim_token
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount,
              sr.reminder_count as reminder_count,
              i.outcome as outcome
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
             'reminder_count', c.reminder_count,
             'outcome', c.outcome
           )
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_payment_reminders(jsonb) from public;
revoke all on function public.confirm_payment_reminders(jsonb) from anon;
revoke all on function public.confirm_payment_reminders(jsonb) from authenticated;
grant execute on function public.confirm_payment_reminders(jsonb) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('106_reminder_outcomes_claim_token',
        'Reminder outcome states + per-lease claim token (GV-265): settlement_requests.reminder_claim_token / settlement_periods.close_reminder_claim_token added; claim_due_payment_reminders / claim_due_close_reminders re-declared off 102 (dropped + recreated) to stamp gen_random_uuid() into the token and return a trailing claim_token uuid. confirm_payment_reminders / confirm_close_reminders change signature from (uuid[]) to (confirmations jsonb) = [{"id","token","outcome"}]; a row confirms only when its lease is live AND the stored token matches (stale worker can no longer confirm a newer lease), and the outcome (delivered / suppressed_no_device / muted) is recorded in the ledger_events metadata as "outcome". Confirm clears both the lease and the token. Failed sends are still never confirmed (retry path unchanged). service_role only.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

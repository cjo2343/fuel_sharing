-- Migration 118: confirm-receipt reminders — nudge the creditor to confirm a paid_pending claim (GV-286)
--
-- Migration 117 removed the 3-day auto-confirm (owner decision: only the recipient
-- confirms that money actually arrived). The side effect: a paid_pending claim now
-- hangs forever if the creditor never opens the app to confirm or dispute it. This
-- migration repurposes the freed scheduler slot into a PUSH NUDGE to the CREDITOR:
-- "X har markeret Y kr som betalt — bekræft modtagelsen".
--
-- It mirrors the two-phase claim/confirm discipline of the payment- and close-reminder
-- engines (migrations 102 + 106) EXACTLY — this is not a new mechanism, it is the same
-- lease + per-lease claim token + terminal-outcome pattern applied to a third reminder:
--
--   * claim_due_confirm_reminders (service role) marks each due paid_pending request
--     in-flight with a 15-minute lease and stamps a fresh gen_random_uuid() claim
--     token, returning everything the web hook needs to push the creditor. It never
--     advances the cadence — that only happens AFTER a push actually goes out.
--   * confirm_confirm_reminders (service role) is called AFTER the send with a jsonb
--     array of {id, token, outcome}. A row's cadence advances (last_confirm_reminder_at
--     stamped, lease + token cleared) only when its lease is still live AND the supplied
--     token matches the stored one, so a stale worker whose send landed after its lease
--     expired — and whose row was re-claimed by a newer lease — can no longer confirm the
--     newer lease (migration 106 discipline). The terminal outcome (delivered /
--     suppressed_no_device / muted) is recorded in ledger_events metadata for the admin
--     feed; a FAILED or thrown send is never one of these outcomes, so the row stays
--     unconfirmed, its lease expires, and the daily scheduler retries.
--
-- Cadence: a paid_pending claim is nudged once its paid_claimed_at is older than a 24h
-- grace window (the creditor gets a day to notice the claim organically before we push),
-- then re-nudged no more often than once per 24h (last_confirm_reminder_at). There is no
-- send cap — unlike a payment request (max 3), an unconfirmed receipt should keep gently
-- nudging until the creditor confirms or disputes, since only they can clear it.
--
-- New per-request state columns (added, never a new table — same shape as the payment
-- reminder columns on this table): confirm_reminder_claimed_at (lease),
-- confirm_reminder_claim_token (per-lease token), last_confirm_reminder_at (cadence).
--
-- Trigger interaction: neither status nor any money column changes here, so the 090
-- integrity trigger (column-list gated: it fires only on ledger_id/period_id/members/
-- amount/status/requested_at/paid_at/requested_by_member_id/paid_claimed_at, none of
-- which are our new columns) does not fire, and the 117 exact-amount trigger returns
-- immediately for a non-'requested' row (a paid_pending row is `status <> 'requested'`).
-- So the reminder bookkeeping is a clean side-write, exactly like the payment/close
-- reminder claims. All three functions are service-role only.

alter table public.settlement_requests add column if not exists confirm_reminder_claimed_at timestamptz;
alter table public.settlement_requests add column if not exists confirm_reminder_claim_token uuid;
alter table public.settlement_requests add column if not exists last_confirm_reminder_at timestamptz;

-- ── claim_due_confirm_reminders: lease + claim token, returns the creditor push target ──
-- Selects paid_pending requests whose claim is older than the 24h grace window and that
-- have not been nudged in the last 24h, whose CREDITOR is an active member with an email
-- (an un-nudgeable creditor is simply never claimed, mirroring how the payment claim
-- filters the debtor). Stamps a 15-minute lease + a fresh token, at most one claim per
-- request per run (for update ... skip locked). Returns the request + the creditor's push
-- identity (member id + email) + the debtor display name, amount, currency, and paid_note.
create or replace function public.claim_due_confirm_reminders(
  p_limit integer default 200
)
returns table (
  request_id uuid,
  ledger_id text,
  creditor_id uuid,
  creditor_email text,
  debtor_name text,
  amount numeric,
  currency text,
  paid_note text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sr.id
    from public.settlement_requests sr
    join public.ledger_members creditor on creditor.id = sr.to_member_id
    where sr.status = 'paid_pending'
      and sr.paid_claimed_at is not null
      and sr.paid_claimed_at <= now() - interval '24 hours'
      and creditor.is_active = true
      and creditor.email is not null
      and (sr.confirm_reminder_claimed_at is null
           or sr.confirm_reminder_claimed_at <= now() - interval '15 minutes')
      and (sr.last_confirm_reminder_at is null
           or sr.last_confirm_reminder_at <= now() - interval '24 hours')
    order by sr.paid_claimed_at
    limit greatest(coalesce(p_limit, 200), 0)
    for update of sr skip locked
  ),
  claimed as (
    update public.settlement_requests sr
    set confirm_reminder_claimed_at = now(),
        confirm_reminder_claim_token = gen_random_uuid(),
        updated_at = now()
    from target t
    where sr.id = t.id
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount,
              sr.currency as currency,
              sr.paid_note as paid_note,
              sr.confirm_reminder_claim_token as claim_token
  )
  select c.request_id,
         c.ledger_id,
         c.creditor_id,
         lower(creditor.email) as creditor_email,
         debtor.name as debtor_name,
         c.amount,
         c.currency,
         c.paid_note,
         c.claim_token
  from claimed c
  left join public.ledger_members creditor on creditor.id = c.creditor_id
  left join public.ledger_members debtor on debtor.id = c.debtor_id;
end;
$$;

revoke all on function public.claim_due_confirm_reminders(integer) from public;
revoke all on function public.claim_due_confirm_reminders(integer) from anon;
revoke all on function public.claim_due_confirm_reminders(integer) from authenticated;
grant execute on function public.claim_due_confirm_reminders(integer) to service_role;

-- ── confirm_confirm_reminders(jsonb): token-gated cadence advance + outcome in metadata ──
-- Finalizes the confirm-receipt reminders whose push the hook just processed. Each element
-- is {id, token, outcome}; only the three terminal outcomes advance the cadence. A row
-- confirms (last_confirm_reminder_at stamped, lease + token cleared) only when its lease is
-- still live AND the token matches, and only while it is still paid_pending — if the
-- creditor confirmed/disputed the claim between claim and confirm, the status guard leaves
-- the reminder state untouched. The outcome lands in the ledger_events metadata for the
-- admin feed. A failed/thrown send is never listed here, so its lease simply expires and
-- the daily scheduler retries.
create or replace function public.confirm_confirm_reminders(confirmations jsonb)
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
    set last_confirm_reminder_at = now(),
        confirm_reminder_claimed_at = null,
        confirm_reminder_claim_token = null,
        updated_at = now()
    from input i
    where sr.id = i.request_id
      and sr.status = 'paid_pending'
      and sr.confirm_reminder_claimed_at is not null
      and sr.confirm_reminder_claim_token = i.claim_token
    returning sr.id as request_id,
              sr.ledger_id as ledger_id,
              sr.from_member_id as debtor_id,
              sr.to_member_id as creditor_id,
              sr.amount as amount,
              i.outcome as outcome
  ),
  logged as (
    insert into public.ledger_events (
      ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
    )
    select c.ledger_id, 'confirm_reminder_sent', 'Påmindelse om bekræftelse sendt', '',
           null, null,
           jsonb_build_object(
             'settlement_request_id', c.request_id,
             'from_member_id', c.debtor_id,
             'to_member_id', c.creditor_id,
             'amount', c.amount,
             'outcome', c.outcome
           )
    from confirmed c
    returning 1
  )
  select count(*)::integer from confirmed;
$$;

revoke all on function public.confirm_confirm_reminders(jsonb) from public;
revoke all on function public.confirm_confirm_reminders(jsonb) from anon;
revoke all on function public.confirm_confirm_reminders(jsonb) from authenticated;
grant execute on function public.confirm_confirm_reminders(jsonb) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('118_confirm_receipt_reminders',
        'Confirm-receipt reminders (GV-286): after migration 117 removed the 3-day auto-confirm, a paid_pending claim hangs until the creditor confirms — so nudge the creditor. settlement_requests gains confirm_reminder_claimed_at (lease) + confirm_reminder_claim_token (per-lease token) + last_confirm_reminder_at (cadence). claim_due_confirm_reminders(p_limit) marks due paid_pending requests (paid_claimed_at older than a 24h grace window, not nudged in the last 24h, creditor active + has email) in-flight with a 15-minute lease and a gen_random_uuid() token, returning the creditor push identity + debtor name + amount/currency/paid_note (mirrors claim_due_payment_reminders). confirm_confirm_reminders(confirmations jsonb = [{id,token,outcome}]) advances the cadence only when the lease is live AND the token matches AND the row is still paid_pending, recording the terminal outcome (delivered / suppressed_no_device / muted) in ledger_events metadata; failed sends are never confirmed and retry. No send cap. Both RPCs service_role only.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

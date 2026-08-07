-- Migration 180: newsletter send-job status reader (GV-442)
--
-- WHY A READER IS NEEDED
--
-- Migration 179 made a newsletter send a durable JOB in public.newsletter_send_jobs,
-- driven one small batch at a time by the govehlo-scheduler Worker. The govehlo-web
-- admin console needs to SHOW that progress while a send runs -- "Sender... 40/120" --
-- so an operator can watch a campaign drain and know when it is done. But 179 gave the
-- job table the same deny-all posture as the three newsletter tables beside it: RLS on,
-- no policy, EVERY grant revoked including service_role. Nothing -- not even the code
-- that holds the service-role key -- can read a job row directly. So the console has a
-- job id (create_newsletter_send_job returned it) and no way to read the job behind it.
--
-- This migration adds the ONE reader that closes that gap. It is the fourth
-- security-definer accessor beside create/claim/mint/advance from 179, and it keeps the
-- table deny-all: the console reaches the job ONLY through this function, never the
-- table.
--
-- WHY COUNTS + STATUS + HEADLINE ONLY
--
-- The console renders a progress bar and a label. That needs the status
-- (pending/sending/done/failed), the three counts (total_recipients, sent_count,
-- failed_count), the last Sweego status code for triage, and the timestamps. It also
-- needs the HEADLINE -- marketing copy, not PII, the same class of data as
-- newsletter_send_log.headline -- so the UI can name WHICH campaign it is showing.
--
-- It deliberately returns NOTHING else. Not cursor_confirmed_at or cursor_id: those are
-- the keyset position into the address list, an internal key the console has no reason
-- to see and every reason not to. Not ceiling_at: an internal send-window bound, not
-- progress. Not operator_email: the one address on the job row, staff PII the console
-- does not need to render a progress bar. A reader that returned the cursor or the
-- operator email would widen the job table's exposure past "how far along is the send,
-- and how many succeeded" -- which is all the console asks and all this function answers.
--
-- No address, no name, no cursor, no per-recipient anything. The job table stays
-- unenumerable exactly as 179 left it; this reader hands out a progress snapshot and
-- nothing that identifies a subscriber.
--
-- ACCESS. service_role only, like the four RPCs from 179. The operator endpoint holds
-- that key and calls this function; anon and authenticated cannot. An unknown campaign
-- id returns ZERO rows -- the caller treats an empty result as "not found" -- and the
-- function does NOT raise, so a stale or mistyped id is a clean miss, not an error.
--
-- No ledger_events are written (a send is not workspace activity -- no ledger, member or
-- feed), so no event_type is introduced and the GV-413 classification guard does not
-- apply, exactly as in 161/173/175/179.

-- ═══════════════════════════════════════════════════════════════════════════════
-- Read a send job's progress                                             (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Called by govehlo-web's operator-only progress endpoint to poll a running send.
-- Returns the status, the headline, the three counts, the last Sweego status code and
-- the timestamps for the given campaign id -- and never the cursor or the operator
-- email. Zero rows for an unknown id; it does not raise.

create or replace function public.get_newsletter_send_job(p_campaign_id uuid)
returns table(
  status text,
  headline text,
  total_recipients integer,
  sent_count integer,
  failed_count integer,
  last_status_code integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select j.status, j.headline, j.total_recipients, j.sent_count, j.failed_count,
         j.last_status_code, j.created_at, j.updated_at
  from public.newsletter_send_jobs j
  where j.id = p_campaign_id;
end;
$$;

revoke all on function public.get_newsletter_send_job(uuid) from public;
revoke all on function public.get_newsletter_send_job(uuid) from anon;
revoke all on function public.get_newsletter_send_job(uuid) from authenticated;
grant execute on function public.get_newsletter_send_job(uuid) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '180_newsletter_send_job_status',
  'GV-442 phase 2a (platform half): the newsletter send-job status reader. Migration 179 made a send a durable JOB in public.newsletter_send_jobs with the same deny-all posture as the three newsletter tables beside it -- RLS on, no policy, EVERY grant revoked including service_role -- so nothing can read a job row directly, and the govehlo-web admin console (which holds only the job id create_newsletter_send_job returned) has no way to show a running send''s progress. get_newsletter_send_job(p_campaign_id uuid) returns table(status text, headline text, total_recipients integer, sent_count integer, failed_count integer, last_status_code integer, created_at timestamptz, updated_at timestamptz) is the fourth security-definer accessor beside 179''s create/claim/mint/advance: it returns the status, the headline (marketing copy, not PII, so the UI can name which campaign it is showing), the three counts, the last Sweego status code and the timestamps for one campaign, and DELIBERATELY nothing else -- not cursor_confirmed_at/cursor_id (the keyset position into the address list, an internal key), not ceiling_at (an internal send-window bound), not operator_email (staff PII the console does not need to render a progress bar). An unknown id returns ZERO rows (the caller treats that as not-found) and it does NOT raise. service_role only (revoked from public/anon/authenticated, granted to service_role), so the job table stays deny-all and reachable only through its RPCs. No ledger_events written (a send has no ledger, member or feed), so no event_type and the GV-413 guard does not apply, exactly as in 161/173/175/179. Read-only: this migration touches newsletter_send_jobs only, never newsletter_subscribers, so like 179''s claim_ and advance_ it is NOT added to tools/test-newsletter-consent-contract.mjs''s ALLOWED_FUNCTIONS (that allowlist gates functions touching newsletter_subscribers). Phase 2b (govehlo-web scheduler endpoint, async send endpoint and admin progress UI) follows after this migration is applied.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

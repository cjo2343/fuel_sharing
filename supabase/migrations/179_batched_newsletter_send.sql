-- Migration 179: durable batched newsletter send (GV-442)
--
-- THE PROBLEM THIS SOLVES
--
-- Migration 173/175's mint_newsletter_send_tokens is a single call that reads EVERY
-- confirmed subscriber, mints a token for each and returns the whole list in one result
-- set — and govehlo-web's operator endpoint then loops that list and posts one Sweego
-- request per recipient from a single Cloudflare Pages Function invocation. A Pages
-- Function has a hard cap on how many outbound subrequests it may make (~50), so the
-- send silently stops after the first ~45 recipients: the token for everyone past that
-- point is minted (their old link rotated away, under 173) but their mail never goes
-- out. The list grows, the cap does not, and the failure is invisible because the
-- function returns 200 having "sent" what it could.
--
-- The fix is to stop treating a send as one request. A send becomes a durable JOB that
-- the govehlo-scheduler Worker drives one small BATCH at a time: claim the job, mint and
-- mail a handful of recipients, advance a cursor, release the job, and let the next
-- scheduler tick pick up where the last left off. No single invocation ever touches more
-- than a batch, so the subrequest budget is never the limit.
--
-- THE GDPR INVARIANT, WHICH IS ABSOLUTE
--
-- A job is durable state — it survives between scheduler ticks, for as long as a send
-- takes. So it must hold NO email address and NO per-recipient status. Migration 161
-- spent its whole header making the subscriber list unenumerable (deny-all, no policy,
-- reachable only through security-definer RPCs that return a status and never rows); a
-- job row that stored "who has been mailed so far" would rebuild exactly the mailing
-- history 161 refused to keep, in a second table, and it would survive the unsubscribe
-- DELETE. So newsletter_send_jobs stores only:
--
--   * COUNTS — total_recipients (a best-effort snapshot), sent_count, failed_count.
--     A count enumerates nobody, the same argument newsletter_send_log rests on.
--   * A KEYSET CURSOR — (cursor_confirmed_at, cursor_id): the confirmed_at timestamp and
--     subscriber id of the last recipient the previous batch processed. Both are internal
--     keys, not personal data — a timestamp and a uuid identify a position in an ordering,
--     not a person, and neither can be turned back into an address without the list the
--     job cannot read.
--   * The MARKETING COPY — headline, intro, features. This is the mail body, not PII; it
--     is the same class of data as newsletter_send_log.headline.
--   * The OPERATOR EMAIL — who pressed send. Staff, not a subscriber, kept on exactly the
--     legitimate-interest audit basis newsletter_send_log.operator_email already uses.
--
-- No address, no name, no per-recipient row, ever. The job cannot answer "who did we
-- mail"; only "how far through an ordering are we, and how many succeeded".
--
-- WHY KEYSET, AND WHY A CEILING
--
-- The set of confirmed subscribers MUTATES while a send runs: anyone can unsubscribe
-- (a hard DELETE, migration 161) between two batches, and anyone can confirm a new
-- signup. An OFFSET-based pager over a mutating set skips or repeats rows. Keyset
-- pagination on (confirmed_at, id) — "give me the next N rows strictly after this
-- (confirmed_at, id) pair" — is stable under deletion: a removed row simply is not
-- there, and the cursor still points past everything already processed. A late JOINER,
-- though, must NOT be swept into a send that was defined before they confirmed, or the
-- total is a moving target and a person who confirmed mid-send gets a mail from a
-- campaign that predates their consent. So each job pins ceiling_at = its creation time
-- and every batch filters confirmed_at <= ceiling_at: the send targets exactly the set
-- that was confirmed when the operator pressed send, no more.
--
-- THE CLAIM-LEASE CONCURRENCY GUARD (migration 082's pattern)
--
-- The scheduler ticks on a timer; two ticks can overlap if one runs long. claim_due_...
-- claims a job with `for update skip locked` and a lease timestamp exactly as migration
-- 082's reminder claims do, so two ticks never drive the same job at once. A tick that
-- crashes mid-batch leaves claimed_at set; the lease (default 300s) lets a later tick
-- reclaim a job whose worker died, so a crash delays a send rather than wedging it
-- forever.
--
-- WHY create_ REFUSES A SECOND CONCURRENT SEND
--
-- Two sends running at once would each mint tokens for the same subscribers; because a
-- token click deletes the subscriber and cascades away ALL their tokens (migration 175),
-- interleaved sends would race to invalidate each other's unsubscribe links. So there is
-- at most one active job: create_newsletter_send_job refuses (SQLSTATE 55006) while any
-- job is pending or sending. A send finishes — status done — before the next may start.
--
-- WHY THE SEND LOG STAYS ONE ROW PER CAMPAIGN
--
-- newsletter_send_log (migration 173) is one row per send: who, what, how many, when.
-- Under batching the mail goes out in many pieces, but it is still ONE campaign, so the
-- log row is written ONCE, at completion, by advance_newsletter_send_job when it marks
-- the job done — recipient_count = the final sent_count. Writing a log row per batch
-- would turn a counts-only audit into a per-batch trace and break the "one row per send"
-- shape the retention sweep (migration 176) and the consent contract both assume. The
-- 24-month token-retention prune (migration 175) likewise runs ONCE per campaign here,
-- at completion, rather than every batch — a global DELETE on every batch would be
-- wasteful and is not what correctness needs.
--
-- ACCESS. newsletter_send_jobs is a fourth server-owned newsletter table and takes the
-- same posture as the other three: RLS on, no policy, every grant revoked including
-- service_role. The scheduler and the operator endpoint hold the service-role key and
-- reach the table ONLY through the four security-definer RPCs below, never directly.
--
-- No ledger_events are written. A newsletter send is not workspace activity — no ledger,
-- no member, no feed — so no event_type is introduced and the GV-413 classification
-- guard does not apply, exactly as in 161/173/175.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The job table                                                       (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.newsletter_send_jobs (
  id uuid primary key default gen_random_uuid(),
  headline text not null,
  intro text not null,
  features jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  cursor_confirmed_at timestamptz,
  cursor_id uuid,
  ceiling_at timestamptz not null,
  operator_email text not null,
  last_status_code integer,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint newsletter_send_jobs_status_valid
    check (status in ('pending', 'sending', 'done', 'failed')),
  constraint newsletter_send_jobs_operator_email_normalised
    check (operator_email = lower(btrim(operator_email))
           and operator_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  constraint newsletter_send_jobs_headline_present
    check (btrim(headline) <> ''),
  constraint newsletter_send_jobs_intro_present
    check (btrim(intro) <> ''),
  constraint newsletter_send_jobs_counts_nonnegative
    check (total_recipients >= 0 and sent_count >= 0 and failed_count >= 0)
);

comment on table public.newsletter_send_jobs is
  'A durable, batched newsletter send (GV-442). One row per campaign, driven to completion by the govehlo-scheduler Worker one small batch at a time so no single Cloudflare Pages Function invocation exceeds the subrequest budget. Holds ONLY counts (total/sent/failed), a keyset cursor (cursor_confirmed_at + cursor_id, both internal keys, never an address), the marketing copy (headline/intro/features) and the operator email (staff audit, same basis as newsletter_send_log). NO subscriber address and NO per-recipient status ever lands here -- that would rebuild the mailing history migration 161 declined to keep, in a table that outlives the unsubscribe DELETE. RLS on, no policy, every grant revoked including service_role, exactly like the three tables it sits beside; reachable only through create/claim/mint/advance_newsletter_send RPCs.';
comment on column public.newsletter_send_jobs.headline is
  'The mail headline (marketing copy, not PII). Copied into newsletter_send_log.headline when the campaign completes.';
comment on column public.newsletter_send_jobs.intro is
  'The mail intro paragraph (marketing copy, not PII).';
comment on column public.newsletter_send_jobs.features is
  'The mail feature blocks as a jsonb array of {title, body} objects (or nulls for spacers). Marketing copy, not PII.';
comment on column public.newsletter_send_jobs.status is
  'pending (created, not yet claimed) -> sending (a batch has been claimed) -> done (all targeted recipients processed) or failed. At most one row is pending or sending at a time -- create_newsletter_send_job refuses a second concurrent send.';
comment on column public.newsletter_send_jobs.total_recipients is
  'Best-effort snapshot of the confirmed-subscriber count at creation (confirmed_at <= ceiling_at). A count enumerates nobody; it exists only to drive a progress bar. sent_count + failed_count converge on it as the send drains.';
comment on column public.newsletter_send_jobs.cursor_confirmed_at is
  'Keyset cursor: the confirmed_at of the last recipient the previous batch processed. Null before the first batch. A timestamp is a position in an ordering, not a person.';
comment on column public.newsletter_send_jobs.cursor_id is
  'Keyset cursor: the subscriber id tiebreak paired with cursor_confirmed_at. A uuid that cannot be turned back into an address without the list this job may not read.';
comment on column public.newsletter_send_jobs.ceiling_at is
  'Creation time. Every batch targets only subscribers with confirmed_at <= ceiling_at, so a send reaches exactly the set that was confirmed when the operator pressed send -- a late joiner is never swept into a campaign that predates their consent.';
comment on column public.newsletter_send_jobs.operator_email is
  'The staff member who pressed send. The only address in this table and it is ours, not a subscriber''s -- the accountability record of who triggered a marketing send, the same basis as newsletter_send_log.operator_email.';
comment on column public.newsletter_send_jobs.last_status_code is
  'The last Sweego failure status the scheduler saw, or null. A single code for triage, NOT a per-recipient error list -- storing which addresses failed would be a mailing history by another name.';
comment on column public.newsletter_send_jobs.claimed_at is
  'Claim lease. Set when a scheduler tick claims the job, cleared when it releases it. A tick may reclaim a job whose claimed_at is older than the lease window, so a crashed worker delays a send rather than wedging it forever.';

-- Find the active job fast -- the scheduler asks "is anything pending or sending?" on
-- every tick, and create_ asks the same to refuse a concurrent send.
create index if not exists newsletter_send_jobs_active_idx
  on public.newsletter_send_jobs (status)
  where status in ('pending', 'sending');

alter table public.newsletter_send_jobs enable row level security;
revoke all on public.newsletter_send_jobs from public;
revoke all on public.newsletter_send_jobs from anon;
revoke all on public.newsletter_send_jobs from authenticated;
-- service_role too, for migration 161's reason applied a fourth time: the Pages Functions
-- and the scheduler hold that key, and the job table carries the marketing copy and the
-- cursor into the address list -- neither is something the code that runs the send should
-- read or rewrite directly. It calls the RPCs.
revoke all on public.newsletter_send_jobs from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Create a campaign                                                   (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Called by govehlo-web's operator-only send endpoint. Validates the copy and the
-- operator, REFUSES while any job is pending or sending (the concurrent-send guard),
-- snapshots the confirmed-subscriber count and the ceiling, and returns the new job id.
-- It does not mint anything or read an address out -- the scheduler does that per batch.

create or replace function public.create_newsletter_send_job(
  p_headline text,
  p_intro text,
  p_features jsonb,
  p_operator_email text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := nullif(lower(btrim(coalesce(p_operator_email, ''))), '');
  v_headline text := nullif(btrim(coalesce(p_headline, '')), '');
  v_intro text := nullif(btrim(coalesce(p_intro, '')), '');
  v_features jsonb := coalesce(p_features, '[]'::jsonb);
  v_ceiling timestamptz := now();
  v_total integer;
  v_job_id uuid;
begin
  if v_operator is null or v_operator !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'p_operator_email must be a syntactically valid address -- the job records who sent marketing mail' using errcode = '22023';
  end if;
  if v_headline is null then
    raise exception 'p_headline is required -- it is the mail headline and the audit row that matches the send' using errcode = '22023';
  end if;
  if v_intro is null then
    raise exception 'p_intro is required -- it is the mail intro paragraph' using errcode = '22023';
  end if;
  if jsonb_typeof(v_features) <> 'array' then
    raise exception 'p_features must be a jsonb array of feature blocks' using errcode = '22023';
  end if;

  -- The concurrent-send guard. Two active sends would each mint tokens for the same
  -- subscribers and race to invalidate each other's unsubscribe links (a token click
  -- cascades away all of a subscriber's tokens, migration 175). At most one job may be
  -- pending or sending; the caller surfaces this message to the operator.
  if exists (
    select 1 from public.newsletter_send_jobs j
    where j.status in ('pending', 'sending')
  ) then
    raise exception 'en udsendelse er allerede i gang' using errcode = '55006';
  end if;

  -- Best-effort snapshot of the target size, on the same predicate every batch uses.
  select count(*) into v_total
  from public.newsletter_subscribers ns
  where ns.confirmed_at is not null
    and ns.confirmed_at <= v_ceiling;

  insert into public.newsletter_send_jobs (
    headline, intro, features, status, total_recipients, ceiling_at, operator_email
  ) values (
    v_headline, v_intro, v_features, 'pending', v_total, v_ceiling, v_operator
  )
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from public;
revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from anon;
revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from authenticated;
grant execute on function public.create_newsletter_send_job(text, text, jsonb, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Claim a due job                                                     (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Migration 082's claim-lease pattern. The scheduler calls this each tick; it claims ONE
-- pending-or-sending job whose lease is free (never claimed, or claimed longer ago than
-- p_lease_seconds), marks it sending, stamps the lease and returns the whole row so the
-- caller has the copy, the cursor and the ceiling to render and continue. `for update
-- skip locked` means two overlapping ticks never claim the same job.

create or replace function public.claim_due_newsletter_send_job(
  p_lease_seconds integer default 300
)
returns setof public.newsletter_send_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select j.id
    from public.newsletter_send_jobs j
    where j.status in ('pending', 'sending')
      and (j.claimed_at is null
           or j.claimed_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 1)))
    order by j.created_at
    limit 1
    for update of j skip locked
  ),
  claimed as (
    update public.newsletter_send_jobs j
    set status = 'sending',
        claimed_at = now(),
        updated_at = now()
    from target t
    where j.id = t.id
    returning j.*
  )
  select c.* from claimed c;
end;
$$;

revoke all on function public.claim_due_newsletter_send_job(integer) from public;
revoke all on function public.claim_due_newsletter_send_job(integer) from anon;
revoke all on function public.claim_due_newsletter_send_job(integer) from authenticated;
grant execute on function public.claim_due_newsletter_send_job(integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Mint one batch                                                      (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The batched equivalent of migration 175's mint. It selects the NEXT p_limit confirmed
-- subscribers strictly after the caller's keyset cursor and no later than the ceiling,
-- mints a fresh unsubscribe token per recipient EXACTLY as 175 does -- 32 random bytes,
-- its sha256 digest INSERTED as a new row in newsletter_send_tokens so every historical
-- link keeps working -- and returns (subscriber_id, confirmed_at, email, RAW token) so
-- the caller can mail them and advance the cursor to the last (confirmed_at, id) it saw.
--
-- Keyset, NOT offset: the confirmed set mutates as people unsubscribe (a hard DELETE) and
-- confirm, and an offset over a mutating set skips or repeats rows. (confirmed_at, id) >
-- (p_after_confirmed_at, p_after_id) with a matching ORDER BY is stable under deletion.
--
-- The raw token exists ONLY in this result set: generated inside the statement that
-- stores its digest, returned, and written nowhere else. 175's MATERIALIZED-CTE atomicity
-- is preserved -- the token is generated in `fresh` (MATERIALIZED so the volatile
-- gen_random_bytes is evaluated once, not re-evaluated by an inlined CTE into a digest of
-- a token the caller never receives), `minted` inserts the digests and returns the rows
-- it actually wrote, and the final select JOINS those back to `fresh`, so an address is
-- handed out only once its digest is on disk. An empty result means the campaign is
-- drained. No send-log row and no retention delete here -- both are once-per-campaign, at
-- completion, in advance_newsletter_send_job.

create or replace function public.mint_newsletter_send_batch(
  p_campaign_id uuid,
  p_after_confirmed_at timestamptz,
  p_after_id uuid,
  p_ceiling_at timestamptz,
  p_limit integer
)
returns table(subscriber_id uuid, subscriber_confirmed_at timestamptz, email text, unsubscribe_token text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with fresh as materialized (
    select ns.id as sub_id,
           ns.confirmed_at as sub_confirmed_at,
           ns.email as sub_email,
           encode(extensions.gen_random_bytes(32), 'hex') as raw_token
    from public.newsletter_subscribers ns
    where ns.confirmed_at is not null
      and ns.confirmed_at <= p_ceiling_at
      and (p_after_confirmed_at is null
           or (ns.confirmed_at, ns.id) > (p_after_confirmed_at, p_after_id))
    order by ns.confirmed_at, ns.id
    limit greatest(1, least(coalesce(p_limit, 1), 100))
  ),
  minted as (
    insert into public.newsletter_send_tokens (subscriber_id, token_digest)
    select f.sub_id, encode(extensions.digest(f.raw_token, 'sha256'), 'hex')
    from fresh f
    returning newsletter_send_tokens.subscriber_id as minted_id
  )
  select f.sub_id, f.sub_confirmed_at, f.sub_email, f.raw_token
  from minted m
  join fresh f on f.sub_id = m.minted_id
  order by f.sub_confirmed_at, f.sub_id;
end;
$$;

revoke all on function public.mint_newsletter_send_batch(uuid, timestamptz, uuid, timestamptz, integer) from public;
revoke all on function public.mint_newsletter_send_batch(uuid, timestamptz, uuid, timestamptz, integer) from anon;
revoke all on function public.mint_newsletter_send_batch(uuid, timestamptz, uuid, timestamptz, integer) from authenticated;
grant execute on function public.mint_newsletter_send_batch(uuid, timestamptz, uuid, timestamptz, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Advance a job                                                       (GV-442)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Called after each batch. Adds the batch's sent/failed deltas, advances the cursor to
-- the last (confirmed_at, id) the batch processed (only when the caller passes a non-null
-- pair -- an empty final batch advances nothing), records the last Sweego status code,
-- and RELEASES the lease so the next tick can pick the job up. When p_done is true it
-- marks the job done, writes the ONE newsletter_send_log row for the whole campaign
-- (operator_email, headline, recipient_count = the final sent_count) and runs the 24-month
-- newsletter_send_tokens retention prune once, mirroring migration 175's opportunistic
-- global sweep -- here at completion rather than every batch.

create or replace function public.advance_newsletter_send_job(
  p_campaign_id uuid,
  p_last_confirmed_at timestamptz,
  p_last_id uuid,
  p_sent_delta integer,
  p_failed_delta integer,
  p_done boolean,
  p_status_code integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text;
  v_headline text;
  v_sent integer;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  update public.newsletter_send_jobs j
  set sent_count = j.sent_count + coalesce(p_sent_delta, 0),
      failed_count = j.failed_count + coalesce(p_failed_delta, 0),
      cursor_confirmed_at = case when p_last_confirmed_at is not null then p_last_confirmed_at else j.cursor_confirmed_at end,
      cursor_id = case when p_last_id is not null then p_last_id else j.cursor_id end,
      last_status_code = coalesce(p_status_code, j.last_status_code),
      status = case when coalesce(p_done, false) then 'done' else j.status end,
      claimed_at = null,
      updated_at = now()
  where j.id = p_campaign_id
  returning j.operator_email, j.headline, j.sent_count
  into v_operator, v_headline, v_sent;

  if v_operator is null then
    raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
  end if;

  if coalesce(p_done, false) then
    -- One counts-only audit row for the whole campaign, the same shape migration 173's
    -- send log has always taken (operator_email, headline, recipient_count). Written at
    -- completion, not per batch, so the "one row per send" shape the retention sweep and
    -- the consent contract assume still holds.
    insert into public.newsletter_send_log (operator_email, headline, recipient_count)
    values (v_operator, v_headline, v_sent);

    -- Migration 175's 24-month token prune, run once per campaign here rather than every
    -- batch. Every confirmed subscriber targeted by this send was just handed a fresh
    -- token, so nobody is left without a working link by this sweep.
    delete from public.newsletter_send_tokens st
    where st.created_at < now() - interval '24 months';
  end if;
end;
$$;

revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from public;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from anon;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from authenticated;
grant execute on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '179_batched_newsletter_send',
  'GV-442 phase 1 (platform half): durable, batched, idempotent newsletter send. Migration 173/175''s mint_newsletter_send_tokens reads EVERY confirmed subscriber and returns them in one result set, which govehlo-web''s operator endpoint then loops one Sweego request per recipient from a single Cloudflare Pages Function -- and a Pages Function has a hard subrequest cap (~50), so the send silently stops after ~45 recipients: their token is minted (their old link rotated away) but their mail never goes out, and the function returns 200 having "sent" what it could. THE FIX: a send becomes a durable JOB the govehlo-scheduler Worker drives one small BATCH at a time, so no single invocation exceeds the budget. public.newsletter_send_jobs (id, headline, intro, features jsonb, status check in pending/sending/done/failed, total_recipients, sent_count, failed_count, cursor_confirmed_at, cursor_id, ceiling_at, operator_email, last_status_code, claimed_at, created_at, updated_at) holds ONLY counts, a keyset cursor, the marketing copy and the operator email -- NO subscriber address and NO per-recipient status ever, because durable state that recorded who was mailed would rebuild the mailing history migration 161 declined to keep, in a table that outlives the unsubscribe DELETE (GDPR: the list stays unenumerable; the cursor is a timestamp + uuid, internal keys not personal data; operator_email is staff on the same legitimate-interest audit basis as newsletter_send_log). RLS on, no policy, every grant revoked including service_role -- a fourth server-owned newsletter table with the same deny-all posture as its three neighbours -- reachable only through four security-definer RPCs granted to service_role only. create_newsletter_send_job(p_headline text, p_intro text, p_features jsonb, p_operator_email text) returns uuid validates the copy and operator (22023), REFUSES with SQLSTATE 55006 while any job is pending or sending (the concurrent-send guard: two active sends would each mint tokens for the same subscribers and race to invalidate each other''s unsubscribe links, since a token click cascades away all of a subscriber''s tokens under migration 175), snapshots total_recipients = count of confirmed subscribers with confirmed_at <= ceiling_at (ceiling_at = now()), and returns the new job id. claim_due_newsletter_send_job(p_lease_seconds integer default 300) returns setof newsletter_send_jobs claims ONE pending-or-sending job whose lease is free with `for update skip locked` (migration 082''s pattern) so two overlapping scheduler ticks never drive the same job, marks it sending, stamps the lease and returns the full row; a crashed worker''s job is reclaimable once its claimed_at is older than the lease window. mint_newsletter_send_batch(p_campaign_id uuid, p_after_confirmed_at timestamptz, p_after_id uuid, p_ceiling_at timestamptz, p_limit integer) returns table(subscriber_id uuid, subscriber_confirmed_at timestamptz, email text, unsubscribe_token text) selects the next batch by KEYSET pagination -- (ns.confirmed_at, ns.id) > (p_after_confirmed_at, p_after_id) order by ns.confirmed_at, ns.id limit greatest(1, least(p_limit, 100)) -- and confirmed_at <= p_ceiling_at, so the send targets exactly the set confirmed when the operator pressed send (a late joiner is never swept in) and the pager is stable as people unsubscribe mid-send (keyset, not offset, over a mutating set). It mints a fresh token per recipient EXACTLY as migration 175 does: 32 random bytes in a MATERIALIZED CTE (so the volatile gen_random_bytes is evaluated once), the sha256 digest INSERTED as a new row in newsletter_send_tokens (so every historical link keeps working), and the raw token returned and written nowhere else, with the final select JOINed back to the materialized CTE so an address is handed out only once its digest is on disk. No send-log row and no retention delete per batch. advance_newsletter_send_job(p_campaign_id uuid, p_last_confirmed_at timestamptz, p_last_id uuid, p_sent_delta integer, p_failed_delta integer, p_done boolean, p_status_code integer default null) returns void adds the sent/failed deltas, advances the cursor to the last processed (confirmed_at, id) when non-null, records last_status_code, and releases the lease (claimed_at = null); when p_done it marks the job done, writes the ONE newsletter_send_log row for the whole campaign (operator_email, headline, recipient_count = final sent_count -- the counts-only shape migration 173 defined and migration 176 retains for 24 months) and runs migration 175''s 24-month newsletter_send_tokens prune once, at completion rather than every batch. No ledger_events written (a send has no ledger, member or feed), so no event_type and the GV-413 guard does not apply. Phase 2 (govehlo-web scheduler endpoint, async send endpoint and admin progress UI) follows after this migration is applied. Pinned by tools/test-newsletter-consent-contract.mjs (create_newsletter_send_job and mint_newsletter_send_batch added to ALLOWED_FUNCTIONS as the deliberate decisions that allowlist exists to force; the job table''s deny-all posture asserted globally) and behaviourally by tools/test-rls-role-matrix.mjs (anon/authenticated/service_role denied on newsletter_send_jobs).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

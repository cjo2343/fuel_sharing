-- Migration 208: the newsletter send lease needs an OWNER, not just a timestamp (GV-491)
--
-- THE BUG, AS AN INTERLEAVING
--
-- govehlo-web's batch hook drives one bounded batch per invocation: claim the job (a 300s
-- lease) -> render -> mint a keyset page of BATCH_LIMIT (20) recipients -> then, for each
-- SEND_CHUNK (5) of that page, Sweego fan-out followed by advance_newsletter_send_job. The
-- per-chunk advance is GV-486's fix: it shrinks the crash-duplicate window from a whole
-- batch to a chunk, because Sweego has NO idempotency mechanism (GV-464, confirmed with
-- their support on 2026-08-12) and every recipient mailed past the last recorded cursor is
-- mailed AGAIN by the retry.
--
-- But EVERY advance -- checkpoint or not -- sets claimed_at = null. That line has been there
-- since 179, when there was exactly one advance per invocation and releasing at the end was
-- the whole point. Since GV-486 there are up to four, and the first of them releases the
-- lease while the invocation is still mailing:
--
--   t0  tick A: claim                       -> status 'sending', claimed_at = t0
--   t1  tick A: mint 20                     -> rows 1..20, cursor NOT moved yet
--   t2  tick A: Sweego rows 1..5            -> mailed
--   t3  tick A: advance(cursor=row 5)       -> cursor at 5 AND claimed_at = null. The job is
--               now unclaimed although tick A is still holding rows 6..20 and still sending.
--   t4  tick B (the next */5 cron, or a retried invocation): claim -> SUCCEEDS. Nothing is
--               stale about the lease; it was handed back.
--   t5  tick B: mint from cursor 5          -> rows 6..25
--   t6  tick B: Sweego rows 6..10           -- WHILE tick A is mailing rows 6..10 itself.
--   t7  both advance. The cursor lands wherever the arithmetic allows, and five people (at
--               least -- a slow tick A can be lapped for the whole rest of its batch) have
--               the campaign twice.
--
-- The hook's own header already names this as the accepted price of GV-486 ("from the first
-- chunk advance until this invocation returns the job is claimable by an overlapping tick").
-- GV-491 is the decision that it does not have to be paid: the lease was released by mistake,
-- not by necessity, and a checkpoint that records progress is not a checkpoint that hands the
-- job away.
--
-- WHY claimed_at ALONE CANNOT FIX IT
--
-- Leaving claimed_at set at a checkpoint is necessary but not sufficient. claimed_at is a
-- TIMESTAMP, and a timestamp answers "is this lease fresh?" -- it cannot answer "am *I* the
-- worker holding it?". After a lease legitimately expires (a tick that outlives 300s, a
-- Worker that dies mid-batch) claim_ hands the job to a new worker, and the OLD worker is
-- still running: its next advance would move the cursor over a page the new owner is also
-- mailing, and its releaseLease would free a lease it no longer holds. Nothing about a
-- timestamp distinguishes the two workers.
--
-- THE FIX: A LEASE OWNER TOKEN
--
--   1. newsletter_send_jobs gains a nullable `lease_token uuid`. claim_due_newsletter_send_job
--      mints a fresh one (gen_random_uuid()) with every claim -- including every RE-claim of
--      an expired lease -- and, because claim_ returns `setof newsletter_send_jobs`, the hook
--      receives it with the job row and needs no new RPC to learn it.
--   2. advance_newsletter_send_job gains two trailing parameters: p_lease_token uuid (the
--      caller's proof of ownership) and p_release boolean default true (does this call hand
--      the lease back?). When a token is supplied the UPDATE is FENCED with
--      `and j.lease_token = p_lease_token`, so a worker whose lease was re-claimed under it
--      moves NOTHING -- no cursor, no counts, no status -- and is told so with a
--      {"status":"stale_lease"} jsonb instead of an exception, so the hook can stop sending
--      rather than fail the invocation.
--   3. A call HOLDS the lease only in the one shape that means "mid-batch checkpoint": a
--      token was supplied AND p_release is false AND p_done is false AND the call actually
--      carries a cursor. Everything else -- the explicit release, the done advance, the pure
--      lease-release that is GV-459's failed tick, and every legacy p_lease_token-null call --
--      nulls claimed_at AND lease_token exactly as before. That is the safety direction:
--      forgetting to release delays a send by at most one lease window, whereas releasing at
--      a checkpoint duplicates mail, and the retry-ceiling path (which must leave claimed_at
--      null so 198's receipt cannot be confused with it) can never accidentally hold.
--   4. LEGACY CALLS ARE BIT-FOR-BIT UNCHANGED. With p_lease_token null there is no fence, no
--      hold, and the same reconciliation, P0002 and quiet-no-op outcomes as 198 -- which is
--      what lets this SQL be applied BEFORE the govehlo-web deploy that starts passing tokens.
--      (The reverse order does not work: a hook that sends p_lease_token to a database that
--      has not got the parameter gets PGRST202 on every advance.)
--
-- WHAT HAPPENS TO 198's CANCEL RECEIPT
--
-- 198 made a surviving claimed_at on a terminal job a RECEIPT: "a worker was mid-batch when
-- the operator cancelled, and what it did is unaccounted for". That is unchanged, and
-- cancel_newsletter_send_job is NOT re-declared here -- it never wrote lease_token and it
-- must not start. The receipt is now the PAIR (claimed_at, lease_token), both left in place
-- by cancel, and advance_'s reconciliation branch carries the same fence as the primary
-- UPDATE: `p_lease_token is null or j.lease_token = p_lease_token`. So the owning worker's
-- advance still lands the cursor over the page it already mailed (198's whole point), while a
-- worker that lost the lease before the cancel cannot land anything. Reconciling clears both
-- halves of the receipt, which is what lifts retry_'s 55P03 fence, exactly as in 198.
--
-- retry_newsletter_send_job IS re-declared, for one added assignment: it must null lease_token
-- alongside claimed_at. A re-queued job that kept a live token would be writable by the worker
-- that still holds it -- its advance would match `status in ('pending','sending') and
-- lease_token = <its token>` and push the cursor of a job it does not own past recipients the
-- NEW tick has not mailed. With the token cleared that same call gets stale_lease and stops.
-- (Before this migration the equivalent call moved the cursor unconditionally, so this is a
-- window GV-491 closes rather than one it opens.)
--
-- RESIDUAL, DOCUMENTED. A lease that genuinely expires is still re-claimed, and the previous
-- worker may still be mailing: those sends are duplicates and nothing in the database can
-- stop them (the mail is already out before any advance is called). What the token buys is
-- that the dead worker can no longer ALSO corrupt the cursor or the counts, so the new owner
-- drains the campaign from an honest position and nobody beyond that in-flight page is
-- affected. Closing the rest would need a per-recipient record, which migration 161 refused
-- to keep.
--
-- RE-DECLARE OFF NEWEST (GV-202).
--   * advance_newsletter_send_job: 179 -> 181 -> 185 -> 198. Re-declared off 198, byte-
--     identical bar the fence, the hold, and the jsonb returns.
--   * claim_due_newsletter_send_job: 179 -> 185. Re-declared off 185 (198 left it alone),
--     byte-identical bar the one added assignment.
--   * retry_newsletter_send_job: 185 -> 198. Re-declared off 198, byte-identical bar the one
--     added assignment.
--   * cancel_newsletter_send_job (newest 198), mint_ and create_ (newest 181) and the two
--     readers (180, 191) are NOT touched.
--
-- SIGNATURE CHANGE, AND WHY IT IS A DROP. advance_ gains two parameters AND changes its return
-- type from void to jsonb. `create or replace` cannot do either: a different argument list is
-- a different function, so the 7-argument version would SURVIVE beside the 9-argument one and
-- PostgREST -- which resolves an RPC by the names in the request body -- would find two
-- candidates for the hook's 7-key call and answer PGRST203 on every one of them. So the old
-- signature is dropped explicitly first (the house pattern, DEPLOY-CHECKLIST section 1), which
-- also drops its ACLs, and the full revoke/grant set is restated for the new signature. After
-- the drop exactly ONE candidate exists, and because both new parameters are defaulted the
-- hook's existing 7-key call still resolves -- which is what makes the apply-before-deploy
-- order safe.
--
-- No ledger_events are written (a send has no ledger, member or feed), so no event_type is
-- introduced and the GV-413 classification guard does not apply, exactly as in 179/181/185/198.
-- The new column and the new signature DO move public types, so types/database.ts is
-- regenerated and re-vendored into both clients.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The lease owner token                                              (GV-491)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- A random uuid minted per claim. It is not subscriber data by any reading: it is generated
-- from nothing, keyed to a JOB rather than a person, cannot be correlated with an address,
-- and dies with the lease. Added by ALTER so the create-table block stays the 179 shape the
-- consent contract's column parser reads -- and that parser is extended in the same PR to
-- follow ALTER ... add column too, so this name is judged rather than merely missed.

alter table public.newsletter_send_jobs
  add column if not exists lease_token uuid;

comment on column public.newsletter_send_jobs.lease_token is
  'GV-491: the OWNER of the current claim lease. claim_ mints a fresh uuid on every claim (and every re-claim of an expired lease) and hands it back with the job row; advance_ fences its writes on it, so a worker whose lease was re-claimed under it cannot move the cursor, the counts or the status of a job it no longer holds. Nulled whenever claimed_at is nulled, and deliberately LEFT IN PLACE by cancel_newsletter_send_job, where it is the second half of migration 198''s in-flight receipt. A random uuid tied to a job, never to a subscriber -- not personal data, and not an unsubscribe token (those live, digested, in newsletter_send_tokens).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Claim a due job -- and mint the lease owner token                  (GV-491)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 185 (its newest definition; 198 left claim_ untouched). ONE
-- change: the claiming UPDATE also stamps a fresh lease_token. Everything else -- the lease
-- window, GV-459's next_attempt_at floor, `for update skip locked`, returning the whole row --
-- is byte-identical to 185.
--
-- A RE-claim of an expired lease mints a NEW token, which is the point: from that moment the
-- previous worker's advances are stale and write nothing. Its sends are still duplicates (the
-- mail leaves before any advance), but the cursor it would have corrupted is now safe, so the
-- new owner resumes from a position that is true.

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
      and (j.next_attempt_at is null or j.next_attempt_at <= now())
    order by j.created_at
    limit 1
    for update of j skip locked
  ),
  claimed as (
    update public.newsletter_send_jobs j
    set status = 'sending',
        claimed_at = now(),
        -- GV-491: a claim is an OWNERSHIP, and a timestamp cannot express one. Every claim
        -- mints a fresh token; the holder proves it on every advance.
        lease_token = gen_random_uuid(),
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
-- 3. Advance a job -- fenced on the lease owner, and it may KEEP the lease (GV-491)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 198 (its newest definition; chain 179 -> 181 -> 185 -> 198), with
-- the 7-argument signature dropped first because two new parameters and a jsonb return cannot
-- be reached by `create or replace` -- see the header for why a surviving overload would be
-- PGRST203 on every hook call.
--
-- Three changes to 198's body, nothing else:
--
--   * THE FENCE. When p_lease_token is supplied, both UPDATEs require j.lease_token to match.
--     A worker whose lease was re-claimed under it writes nothing at all.
--   * THE HOLD. claimed_at (and lease_token with it) is preserved -- rather than nulled -- in
--     exactly one shape: a fenced, non-releasing, non-done call that carries a cursor. That is
--     GV-486's mid-batch checkpoint and nothing else. Every other shape releases, including
--     every legacy call, so GV-459's retry ceiling still fails a stuck job with claimed_at
--     null and 198's receipt keeps meaning only what 198 says it means.
--   * THE RETURN. void becomes jsonb so the caller can tell the four outcomes apart:
--     'advanced' / 'done' (the UPDATE landed), 'reconciled' (198's cancelled-job branch),
--     'stale_lease' (this worker no longer owns the job -- stop sending) and 'noop' (the job
--     is terminal and unclaimed, 181's deliberate quiet outcome). A genuinely absent campaign
--     id still RAISES P0002; being told about an id that does not exist is not an outcome.

drop function if exists public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer);

create or replace function public.advance_newsletter_send_job(
  p_campaign_id uuid,
  p_last_confirmed_at timestamptz,
  p_last_id uuid,
  p_sent_delta integer,
  p_failed_delta integer,
  p_done boolean,
  p_status_code integer default null,
  p_lease_token uuid default null,
  p_release boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text;
  v_headline text;
  v_sent integer;
  v_updated integer;
  v_reconciled integer;
  v_hold boolean;
  v_status text;
  v_token uuid;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  -- GV-491: the ONE shape that keeps the lease -- a fenced mid-batch checkpoint. It needs all
  -- four: an owner token (an unfenced caller may not hold a lease it cannot prove), an explicit
  -- p_release false, not done, and an actual cursor to record. Anything else releases, which
  -- keeps every legacy call, the done advance, the explicit release and GV-459's failed tick
  -- byte-for-byte as they were -- and keeps a ceiling-failed job's claimed_at null, so 198's
  -- receipt still means "cancelled mid-batch" and nothing else.
  v_hold := p_lease_token is not null
            and not coalesce(p_release, true)
            and not coalesce(p_done, false)
            and p_last_confirmed_at is not null;

  -- The UPDATE ALWAYS applies to an active job (status in pending/sending) THIS CALLER OWNS
  -- (GV-491: `p_lease_token is null or j.lease_token = p_lease_token` -- no token supplied is
  -- the pre-208 unfenced behaviour, kept so the SQL can be applied before the web deploy). It
  -- releases the lease (claimed_at = null, and lease_token with it) UNLESS this is the fenced
  -- mid-batch checkpoint above, stamps updated_at and records last_status_code UNCONDITIONALLY
  -- -- all safe to repeat. The count-add and cursor-move stay IDEMPOTENT: they apply only
  -- when this batch is NEW (p_last_confirmed_at non-null AND its keyset strictly past the
  -- stored cursor, or the cursor was never set). attempt_count/next_attempt_at (GV-459) key
  -- off two shapes: a NEW batch is progress (reset to 0 / null), a pure lease-release
  -- (p_last_confirmed_at null, zero deltas, p_done false) is a failed tick (increment /
  -- push out the backoff). The status case gains a failed transition on the fifth
  -- consecutive failed tick; the done transition (status -> done) still fires on p_done, and
  -- because the WHERE excludes an already-done row a duplicate done updates 0 rows.
  update public.newsletter_send_jobs j
  set sent_count = j.sent_count
        + case when p_last_confirmed_at is not null
                    and (j.cursor_confirmed_at is null
                         or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
               then coalesce(p_sent_delta, 0) else 0 end,
      failed_count = j.failed_count
        + case when p_last_confirmed_at is not null
                    and (j.cursor_confirmed_at is null
                         or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
               then coalesce(p_failed_delta, 0) else 0 end,
      cursor_confirmed_at = case when p_last_confirmed_at is not null
                                      and (j.cursor_confirmed_at is null
                                           or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                                 then p_last_confirmed_at else j.cursor_confirmed_at end,
      cursor_id = case when p_last_confirmed_at is not null
                            and (j.cursor_confirmed_at is null
                                 or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                       then p_last_id else j.cursor_id end,
      -- GV-459: progress resets the counter, a failed tick increments it, anything else holds.
      attempt_count = case
        when p_last_confirmed_at is not null
             and (j.cursor_confirmed_at is null
                  or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
          then 0
        when p_last_confirmed_at is null
             and not coalesce(p_done, false)
             and coalesce(p_sent_delta, 0) = 0
             and coalesce(p_failed_delta, 0) = 0
          then j.attempt_count + 1
        else j.attempt_count end,
      -- GV-459: progress clears the backoff, a failed tick pushes it out (linear, capped 1h).
      next_attempt_at = case
        when p_last_confirmed_at is not null
             and (j.cursor_confirmed_at is null
                  or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
          then null
        when p_last_confirmed_at is null
             and not coalesce(p_done, false)
             and coalesce(p_sent_delta, 0) = 0
             and coalesce(p_failed_delta, 0) = 0
          then now() + make_interval(secs => least(3600, 60 * (j.attempt_count + 1)))
        else j.next_attempt_at end,
      last_status_code = coalesce(p_status_code, j.last_status_code),
      -- GV-459: the retry ceiling. The fifth consecutive failed tick fails the job, freeing
      -- the single-active slot a permanently-stuck send would otherwise hold forever.
      status = case
        when coalesce(p_done, false) then 'done'
        when p_last_confirmed_at is null
             and not coalesce(p_done, false)
             and coalesce(p_sent_delta, 0) = 0
             and coalesce(p_failed_delta, 0) = 0
             and j.attempt_count + 1 >= 5
          then 'failed'
        else j.status end,
      -- GV-491: a checkpoint records progress; it does not hand the job to the next tick.
      claimed_at = case when v_hold then j.claimed_at else null end,
      lease_token = case when v_hold then j.lease_token else null end,
      updated_at = now()
  where j.id = p_campaign_id
    and j.status in ('pending', 'sending')
    and (p_lease_token is null or j.lease_token = p_lease_token)
  returning j.operator_email, j.headline, j.sent_count
  into v_operator, v_headline, v_sent;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    -- GV-470: before treating this as a no-op, reconcile a job the operator CANCELLED while
    -- this worker held the lease. cancel_newsletter_send_job leaves claimed_at in place
    -- precisely so this branch can recognise that state -- every other path (this function
    -- above, cancel_ on an unclaimed job, retry_) nulls the lease, so `status = 'failed' and
    -- claimed_at is not null` means "a worker was mid-batch when the job was cancelled and
    -- what it did is unaccounted for", and nothing else.
    --
    -- GV-491 adds the same owner fence the primary UPDATE carries. cancel_ leaves lease_token
    -- alongside claimed_at, so the receipt names WHICH worker was mid-batch: the owner still
    -- lands its page (which is the whole of GV-470), and a worker whose lease had already been
    -- re-claimed before the cancel cannot land a page the new owner never mailed.
    --
    -- The batch it is reporting has ALREADY BEEN MAILED (the fan-out happens before this
    -- call), so the cursor must move: retry_newsletter_send_job resumes from the cursor, and
    -- a cursor that ignored this batch would re-mail every one of its recipients. The
    -- arithmetic is byte-for-byte the strictly-advancing test used above, so a retried or
    -- stale advance still adds nothing and moves nothing.
    --
    -- What it deliberately does NOT do: it does not change status (a cancelled campaign stays
    -- cancelled -- this is reconciliation, not resurrection), does not touch attempt_count or
    -- next_attempt_at (a terminal job has no ticks left to count), and does not fall through
    -- to the done-branch below whatever p_done says, so no newsletter_send_log row is ever
    -- written for a campaign that was cancelled. Clearing claimed_at (and the token with it)
    -- is what releases retry_'s fence: the in-flight batch is now accounted for, so a retry is
    -- safe at once.
    update public.newsletter_send_jobs j
    set sent_count = j.sent_count
          + case when p_last_confirmed_at is not null
                      and (j.cursor_confirmed_at is null
                           or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                 then coalesce(p_sent_delta, 0) else 0 end,
        failed_count = j.failed_count
          + case when p_last_confirmed_at is not null
                      and (j.cursor_confirmed_at is null
                           or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                 then coalesce(p_failed_delta, 0) else 0 end,
        cursor_confirmed_at = case when p_last_confirmed_at is not null
                                        and (j.cursor_confirmed_at is null
                                             or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                                   then p_last_confirmed_at else j.cursor_confirmed_at end,
        cursor_id = case when p_last_confirmed_at is not null
                              and (j.cursor_confirmed_at is null
                                   or (p_last_confirmed_at, p_last_id) > (j.cursor_confirmed_at, j.cursor_id))
                         then p_last_id else j.cursor_id end,
        last_status_code = coalesce(p_status_code, j.last_status_code),
        claimed_at = null,
        lease_token = null,
        updated_at = now()
    where j.id = p_campaign_id
      and j.status = 'failed'
      and j.claimed_at is not null
      and (p_lease_token is null or j.lease_token = p_lease_token);

    get diagnostics v_reconciled = row_count;
    if v_reconciled > 0 then
      return jsonb_build_object('status', 'reconciled');
    end if;

    -- Nothing was updated. Because the UPDATE touches any ACTIVE job THIS CALLER OWNS, a
    -- 0-row outcome means one of three things: the job is genuinely unknown (an error), it is
    -- already terminal -- a retried done advance, a retried failed tick, or a lease-release
    -- arriving after the job finished -- or, GV-491, this caller no longer owns it. A no-op on
    -- an existing job is expected under an at-least-once scheduler and is NOT an error, so
    -- only a truly absent id raises; the other two are told apart in the answer, because a
    -- caller that has lost the lease must STOP MAILING and one that merely met a finished job
    -- has nothing left to do either way.
    select j.status, j.lease_token into v_status, v_token
    from public.newsletter_send_jobs j
    where j.id = p_campaign_id;

    if v_status is null then
      raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
    end if;

    if p_lease_token is not null
       and v_status in ('pending', 'sending')
       and v_token is distinct from p_lease_token then
      return jsonb_build_object('status', 'stale_lease');
    end if;

    return jsonb_build_object('status', 'noop');
  end if;

  if coalesce(p_done, false) then
    -- Reached only when this call actually transitioned the job to done (a row was updated
    -- AND p_done), so it runs exactly once per campaign even under retries.
    --
    -- One counts-only audit row for the whole campaign, the same shape migration 173's send
    -- log has always taken (operator_email, headline, recipient_count). Written at completion,
    -- not per batch, so the "one row per send" shape the retention sweep and the consent
    -- contract assume still holds.
    insert into public.newsletter_send_log (operator_email, headline, recipient_count)
    values (v_operator, v_headline, v_sent);

    -- GV-456: migration 181's 24-month newsletter_send_tokens prune is DELIBERATELY GONE.
    -- A token now lives for the subscriber's lifetime (bounded by ON DELETE CASCADE), so no
    -- unsubscribe link ever silently stops matching while the address is still on the list.

    -- LOW-7 (GV-451): terminal jobs are otherwise never removed, so prune done/failed jobs
    -- older than 90 days. The job just completed above is safe -- its updated_at is now().
    -- This is a different table from GV-456's removed prune -- newsletter_send_jobs holds no
    -- address -- and is kept unchanged.
    delete from public.newsletter_send_jobs j
    where j.status in ('done', 'failed')
      and j.updated_at < now() - interval '90 days';

    return jsonb_build_object('status', 'done');
  end if;

  return jsonb_build_object('status', 'advanced');
end;
$$;

revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer, uuid, boolean) from public;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer, uuid, boolean) from anon;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer, uuid, boolean) from authenticated;
grant execute on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer, uuid, boolean) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Operator: retry a failed job -- and drop the old owner with the lease (GV-491)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 198 (its newest definition). ONE change: the re-queueing UPDATE
-- nulls lease_token beside claimed_at. A retried job that kept a live token would still be
-- writable by the worker that holds it -- its advance would match `status in
-- ('pending','sending') and lease_token = <its token>` and move the cursor of a job it does
-- not own, past recipients the new tick has not mailed. Clearing the token turns that same
-- call into a stale_lease no-op. 198's 55P03 fence, its Danish sentence, the ordering of the
-- two refusals and the 55006 single-active re-raise are all untouched.

create or replace function public.retry_newsletter_send_job(
  p_campaign_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_claimed_at timestamptz;
  v_updated integer;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  select j.status, j.claimed_at into v_status, v_claimed_at
  from public.newsletter_send_jobs j
  where j.id = p_campaign_id;

  if v_status is null then
    raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
  end if;
  if v_status <> 'failed' then
    raise exception 'kun en fejlet udsendelse kan genstartes' using errcode = '22023';
  end if;

  -- GV-470: the cancel-mid-batch fence. A terminal job whose lease stamp survives was
  -- cancelled out from under a running worker (cancel_ leaves claimed_at alone for exactly
  -- this reason; every other path nulls it, including a job failed by the retry ceiling), so
  -- a batch may already be in the post, and resuming from the current cursor would send it
  -- twice. Wait for the worker's advance -- which clears this stamp as it lands the cursor --
  -- or for the lease window to close on a worker that will never report.
  if v_claimed_at is not null and v_claimed_at > now() - make_interval(secs => 300) then
    raise exception 'udsendelsen har stadig en batch i gang - vent til den er afsluttet og prøv igen' using errcode = '55P03';
  end if;

  -- Re-activating the job collides with newsletter_send_jobs_single_active if another send is
  -- already pending/sending; the index rejects whichever loses and we re-raise the operator's
  -- 55006 rather than a raw 23505. The WHERE re-checks status = 'failed' so a concurrent
  -- retry of the same job cannot double-activate it.
  begin
    update public.newsletter_send_jobs j
    set status = 'pending',
        attempt_count = 0,
        next_attempt_at = null,
        claimed_at = null,
        -- GV-491: the old owner loses its claim with the lease. A token that survived a retry
        -- would let a worker still holding it advance the cursor of the re-queued job.
        lease_token = null,
        updated_at = now()
    where j.id = p_campaign_id
      and j.status = 'failed';
  exception when unique_violation then
    raise exception 'en udsendelse er allerede i gang' using errcode = '55006';
  end;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    -- Lost a race: the job left 'failed' between the read and the write. Report it as the
    -- same not-retryable condition rather than silently doing nothing.
    raise exception 'kun en fejlet udsendelse kan genstartes' using errcode = '22023';
  end if;

  return jsonb_build_object('status', 'pending');
end;
$$;

revoke all on function public.retry_newsletter_send_job(uuid) from public;
revoke all on function public.retry_newsletter_send_job(uuid) from anon;
revoke all on function public.retry_newsletter_send_job(uuid) from authenticated;
grant execute on function public.retry_newsletter_send_job(uuid) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '208_newsletter_lease_owner_token',
  'GV-491: a newsletter send''s claim lease gains an OWNER token, so a mid-batch cursor checkpoint stops handing the job to an overlapping scheduler tick. THE INTERLEAVING: govehlo-web''s batch hook runs claim (300s lease) -> mint 20 -> for each chunk of 5, Sweego fan-out then advance_newsletter_send_job. The per-chunk advance is GV-486, which shrank the crash-duplicate window from a batch to a chunk because Sweego has NO idempotency mechanism (GV-464, confirmed 2026-08-12). But EVERY advance since migration 179 sets claimed_at = null, so the FIRST chunk checkpoint releases the lease while the invocation is still mailing rows 6..20: the next */5 tick claims the same job legitimately (nothing is stale -- the lease was handed back), mints from the advanced cursor, and mails rows 6..10 alongside the first worker. At least one chunk of genuine duplicate mail, and a slow tick can be lapped for the rest of its batch. The hook''s own header already names this as GV-486''s accepted price; GV-491 is the decision that it need not be paid, because the release was incidental rather than necessary. WHY claimed_at ALONE CANNOT FIX IT: a timestamp answers "is this lease fresh" but never "am I the worker holding it", and after a lease genuinely expires the old worker is still running -- its advance would corrupt the new owner''s cursor and its release would free a lease it no longer holds. THE FIX: (1) newsletter_send_jobs gains a nullable lease_token uuid, minted by claim_due_newsletter_send_job (re-declared off 185, its newest definition; one added assignment) on every claim AND every re-claim of an expired lease, and returned to the hook with the job row because claim_ returns setof newsletter_send_jobs. (2) advance_newsletter_send_job gains trailing p_lease_token uuid default null and p_release boolean default true. With a token supplied BOTH of its UPDATEs are fenced on `j.lease_token = p_lease_token`, so a worker whose lease was re-claimed under it moves no cursor, no counts and no status. (3) The lease is HELD -- claimed_at and lease_token preserved rather than nulled -- in exactly one shape: fenced, p_release false, not done, and carrying a cursor. That is GV-486''s mid-batch checkpoint and nothing else; the explicit release, the done advance, GV-459''s pure-lease-release failed tick and EVERY legacy p_lease_token-null call release exactly as before, which keeps a ceiling-failed job''s claimed_at null so migration 198''s receipt still means only "cancelled mid-batch". (4) The return type becomes jsonb so the four outcomes are distinguishable -- advanced / done (the UPDATE landed), reconciled (198''s cancelled-job branch), stale_lease (this worker lost the lease: the hook stops sending immediately, with no further Sweego calls and no lease release it is not entitled to make) and noop (181''s quiet terminal outcome) -- while a genuinely absent campaign id still RAISES P0002. SIGNATURE CHANGE IS A DROP, NOT A REPLACE: two added parameters and void -> jsonb are both out of reach of create or replace, and a surviving 7-argument overload would make PostgREST answer PGRST203 to the hook''s 7-key call, so the old signature is dropped explicitly (its ACLs with it) and the full revoke/grant set is restated for the 9-argument one. Because both new parameters are defaulted, the CURRENT hook''s 7-key call still resolves against the new function and behaves bit-for-bit as it does today -- which is what makes the apply-before-deploy order safe, and the reverse order unsafe (a hook sending p_lease_token to a database without the parameter gets PGRST202 on every advance). MIGRATION 198''s CANCEL RECEIPT IS PRESERVED: cancel_newsletter_send_job is NOT re-declared -- it never wrote lease_token and must not start -- so the receipt becomes the PAIR (claimed_at, lease_token), and advance_''s reconciliation branch carries the same owner fence, letting the OWNING worker still land the page it already mailed (GV-470''s whole point) while a worker that had already lost the lease cannot. Reconciling clears both halves, which lifts retry_''s 55P03 fence exactly as in 198. retry_newsletter_send_job IS re-declared (off 198) for one added assignment: it nulls lease_token beside claimed_at, because a re-queued job that kept a live token would still be writable by the worker holding it -- that call now gets stale_lease and stops. RESIDUAL, DOCUMENTED: a lease that genuinely expires is still re-claimed while the previous worker may still be mailing, and those sends are duplicates nothing in the database can stop (the mail leaves before any advance). What the token buys is that the dead worker can no longer ALSO corrupt the cursor or the counts, so the new owner drains from an honest position; closing the rest would need the per-recipient record migration 161 refused to keep. cancel_ (newest 198), mint_ and create_ (newest 181) and the two readers (180, 191) are untouched. No ledger_events are written, so the GV-413 guard does not apply. The new column and the new signature DO move public types, so types/database.ts is regenerated and re-vendored into both clients. VERIFIED BY tools/test-newsletter-lease-token-contract.mjs (npm run test:newsletter-lease-token, wired into npm run validate): static pins on this migration and its consolidated mirror, plus a Docker replay proving that a checkpoint advance keeps claimed_at non-null, that an overlapping claim during a live lease returns nothing, that a stale-token advance writes nothing and answers stale_lease, that an explicit release frees the job, and that the whole migration-198 cancel/retry interleaving still passes unchanged. Depends on 198 (the definitions it re-declares), 185 (claim_ and the GV-459 columns) and 179/181 (the job model and the single-active index).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

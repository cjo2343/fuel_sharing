-- Migration 198: cancelling a newsletter send mid-batch must not make retry re-mail it (GV-470)
--
-- THE BUG, AS AN INTERLEAVING
--
-- The durable send (179/181/185) is driven by govehlo-web's batch hook, one bounded batch
-- per invocation, in this order: claim (lease) -> render template -> mint the next keyset
-- page -> mail it -> advance the cursor and release the lease. The operator can CANCEL at
-- any point (185's cancel_newsletter_send_job, which forces an active job to 'failed') and
-- RETRY a failed job later (185's retry_newsletter_send_job, which re-queues it FROM ITS
-- CURSOR so nobody already mailed is mailed again). Those two facts collide:
--
--   t0  hook: claim_due_newsletter_send_job  -> status 'sending', claimed_at = t0
--   t1  hook: mint_newsletter_send_batch     -> 20 recipients + fresh tokens (cursor NOT moved yet)
--   t2  hook: Sweego fan-out                 -> THE MAIL IS OUT. Irreversible.
--   t3  operator: cancel_newsletter_send_job -> status 'failed', claimed_at cleared.
--                 The lease knows nothing about the cancel and the hook is still running.
--   t4  hook: advance_newsletter_send_job    -> its UPDATE is `where ... and j.status in
--                 ('pending','sending')`, the job is 'failed', so 0 rows. 185's own comment
--                 calls that outcome "a no-op on an existing (terminal) job ... NOT an
--                 error" and returns quietly. THE CURSOR NEVER MOVES.
--   t5  operator: retry_newsletter_send_job  -> 'pending', cursor unchanged
--   t6  hook: claim + mint from the OLD cursor -> the SAME 20 subscribers, fresh tokens
--   t7  hook: Sweego fan-out                 -> those 20 receive the campaign a SECOND time.
--
-- Every step is behaving exactly as designed; the defect is that the one durable record of
-- "these recipients have been processed" -- the cursor -- is thrown away precisely when the
-- job stops being active, and retry then resumes from a position that is a lie. It is not a
-- rare race either: t3 landing anywhere in t0..t4 produces it deterministically, and t0..t4
-- is the whole duration of a tick that is mailing.
--
-- GV-457's per-(campaign, recipient) Sweego idempotency key is NOT the guard here. It is
-- best-effort (Sweego's honouring of it is unconfirmed) and a retry can arrive hours or days
-- after the cancel, long past any provider-side dedupe window.
--
-- WHAT WAS CONSIDERED
--
--   (a) CANCEL WAITS FOR / REFUSES DURING A LIVE LEASE. Rejected. It does not stop the
--       in-flight batch from mailing (nothing can -- t2 already happened), it takes the one
--       tool an operator has for "stop this now" away for up to a full lease window, and it
--       still loses the cursor at t4 for any tick that outlives its own lease.
--   (b) CANCEL BURNS THE CLAIMED PAGE (advances the cursor over it). Rejected: the database
--       does not know the page. p_limit is the hook's own BATCH_LIMIT constant and is passed
--       to mint_, never stored, so cancel_ would have to GUESS how far the in-flight tick got
--       -- and guessing high silently drops recipients who never received the campaign, which
--       is the same class of invisible failure the whole job model exists to end.
--   (c) RETRY REFUSES WHILE THE CLAIMED BATCH IS UNRESOLVED. Kept, but on its own it only
--       DELAYS the double send: when the fence lifts the cursor is still stale.
--
-- THE FIX: (c) PLUS THE THING THAT MAKES THE WAIT WORTH ANYTHING -- the in-flight tick's
-- advance is allowed to LAND on the job it was cancelled out from under. Three changes, no
-- new column, no signature change:
--
--   1. cancel_newsletter_send_job NO LONGER CLEARS claimed_at. Cancelling is still immediate
--      and total (status 'failed' the moment it is called, so claim_ -- which only ever looks
--      at pending/sending -- never touches the job again and the single-active slot frees at
--      once). The surviving lease stamp is not a lock; it is a RECEIPT: "a worker held this
--      job when it was cancelled, and what it did is not yet accounted for". Because advance_,
--      cancel_ and retry_ all otherwise null claimed_at, a terminal job with a non-null
--      claimed_at means exactly that and nothing else -- a job failed by 185's retry ceiling
--      has claimed_at null (the same UPDATE that failed it cleared the lease), so the ceiling
--      path is untouched.
--   2. advance_newsletter_send_job RECONCILES A CANCELLED JOB. When its ordinary UPDATE
--      matches nothing, it now tries a second, deliberately narrow UPDATE against
--      `status = 'failed' and claimed_at is not null` -- the receipt above -- which applies
--      the SAME strictly-advancing cursor/count arithmetic and then clears the receipt. So
--      the batch that went out at t2 is recorded at t4 even though the job is cancelled, and
--      t6's mint starts PAST it. It does NOT resurrect the job (status stays 'failed'), does
--      NOT touch attempt_count/next_attempt_at, and does NOT run the done-branch: a cancelled
--      campaign still writes no newsletter_send_log row, however p_done arrives.
--   3. retry_newsletter_send_job REFUSES WHILE THE RECEIPT IS OUTSTANDING AND FRESH --
--      claimed_at within one lease window (300s, the hook's LEASE_SECONDS and claim_'s
--      default) -- with SQLSTATE 55P03 and a Danish sentence telling the operator to wait.
--      Without it, retry at t4-minus-a-moment re-activates the job before the in-flight
--      advance can land, and step 2's reconciliation would find a pending job instead.
--
-- EVERY WINDOW, AFTER THIS MIGRATION
--
--   * cancel BEFORE any claim (job 'pending', claimed_at null): unchanged. No receipt, no
--     fence, retry is allowed immediately and resumes from a cursor that is accurate because
--     nothing was ever minted.
--   * cancel DURING a tick, before it mints: receipt written; the tick mints and mails
--     anyway (nothing in the database can stop a Worker mid-invocation); its advance lands
--     the cursor via 2; retry resumes past those recipients. No duplicate.
--   * cancel AFTER the mail, before the advance (the ticket's case): identical to the line
--     above -- this IS t3 in the map. No duplicate.
--   * retry DURING a live lease with no cancel: unchanged -- the job is 'sending', not
--     'failed', so retry_ still raises 22023 'kun en fejlet udsendelse kan genstartes'.
--   * retry while the receipt is fresh: 55P03, "wait". Bounded by wall clock, never longer
--     than one lease window; the fence cannot outlive it because claimed_at is a fixed past
--     timestamp, so no job is ever stranded un-retryable (the GV-459 failure mode this must
--     not re-open).
--   * retry after the receipt is reconciled (the normal case -- the hook's advance arrives
--     within seconds): allowed at once, cursor accurate.
--   * retry after the receipt EXPIRED unreconciled -- the hook died between Sweego and its
--     advance AND the job was cancelled: allowed, and those recipients can be mailed twice.
--     This is the pre-existing at-least-once window the design already carries (the same
--     crash without a cancel is re-claimed after the lease and re-mints the same page), it
--     is what GV-457's idempotency key exists to soften, and closing it would require a
--     per-recipient record -- the mailing history migration 161 refused to keep. Cancel+retry
--     is now no more dangerous than the ordinary crash path, which is the whole ask; before
--     this migration it was WORSE, and deterministically so.
--   * a job failed by 185's RETRY CEILING: claimed_at is null, so no fence and nothing to
--     reconcile. Cancel/retry behave exactly as they did.
--   * an advance arriving at a long-terminal job (no receipt): still the quiet no-op 181
--     made it, and a genuinely absent campaign id still raises P0002.
--
-- RE-DECLARE OFF NEWEST (GV-202). advance_newsletter_send_job: 179 -> 181 -> 185, so it is
-- re-declared COMPLETELY off 185, byte-identical bar the reconciliation block. cancel_ and
-- retry_ were both introduced in 185 and nothing has touched them since, so both are
-- re-declared off 185 as well. claim_ (newest 185), mint_ and create_ (newest 181) and the
-- two readers (180, 191) are NOT touched. No column, no index, no policy, no grant change and
-- no signature change -- the three functions keep their exact parameter names, types, order
-- and returns, so govehlo-web's batch hook and control endpoint stay compatible and
-- types/database.ts is unchanged.
--
-- No ledger_events are written (a send has no ledger, member or feed), so no event_type is
-- introduced and the GV-413 classification guard does not apply, exactly as in 179/181/185.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Advance a job -- and reconcile one that was cancelled mid-batch    (GV-470)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 185 (its newest definition). ONE change: the v_updated = 0 branch
-- no longer goes straight to "unknown id or quiet no-op". It first tries to reconcile a job
-- that was cancelled while this very worker held the lease, so the batch that already went
-- out is recorded and a later retry_ resumes PAST it instead of re-mailing it.

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
  v_updated integer;
  v_reconciled integer;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  -- The UPDATE ALWAYS applies to an active job (status in pending/sending). It releases the
  -- lease (claimed_at = null), stamps updated_at and records last_status_code UNCONDITIONALLY
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
      claimed_at = null,
      updated_at = now()
  where j.id = p_campaign_id
    and j.status in ('pending', 'sending')
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
    -- written for a campaign that was cancelled. Clearing claimed_at is what releases
    -- retry_'s fence: the in-flight batch is now accounted for, so a retry is safe at once.
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
        updated_at = now()
    where j.id = p_campaign_id
      and j.status = 'failed'
      and j.claimed_at is not null;

    get diagnostics v_reconciled = row_count;
    if v_reconciled > 0 then
      return;
    end if;

    -- Nothing was updated. Because the UPDATE touches any ACTIVE job, a 0-row outcome means
    -- the job is either genuinely unknown (an error) or already terminal -- a retried done
    -- advance, a retried failed tick, or a lease-release arriving after the job finished. A
    -- no-op on an existing job is expected under an at-least-once scheduler and is NOT an
    -- error, so only a truly absent id raises.
    if not exists (select 1 from public.newsletter_send_jobs j where j.id = p_campaign_id) then
      raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
    end if;
    return;
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
  end if;
end;
$$;

revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from public;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from anon;
revoke all on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) from authenticated;
grant execute on function public.advance_newsletter_send_job(uuid, timestamptz, uuid, integer, integer, boolean, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Operator: cancel an active job -- now leaves a receipt for the batch (GV-470)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 185 (its newest definition). ONE change: claimed_at is no longer
-- cleared. Cancelling is still immediate and total -- status flips to 'failed' at once, so
-- claim_ (which only looks at pending/sending) never touches the job again and the
-- single-active slot frees without waiting out the retry ceiling -- but a lease that was live
-- SURVIVES as the receipt described in section 1: proof that a worker was mid-batch, which is
-- what lets its advance land the cursor and what makes retry_ wait for it.
--
-- The returned jsonb gains two keys so the operator console can say WHY a retry may not be
-- available yet; 'status' is unchanged, so a caller reading only that (govehlo-web's
-- newsletter-send-control endpoint does) needs no change.

create or replace function public.cancel_newsletter_send_job(
  p_campaign_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
  v_claimed_at timestamptz;
  v_in_flight boolean;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  -- GV-470: claimed_at is deliberately NOT set to null here. A cancel that cleared the lease
  -- threw away the only evidence that a batch was in flight, and the in-flight worker's
  -- advance then found a terminal job, moved nothing, and left the cursor pointing at
  -- recipients who had already been mailed -- which a later retry_ dutifully mailed again.
  update public.newsletter_send_jobs j
  set status = 'failed',
      updated_at = now()
  where j.id = p_campaign_id
    and j.status in ('pending', 'sending')
  returning j.claimed_at into v_claimed_at;

  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    -- One lease window (300s -- the batch hook's LEASE_SECONDS and claim_'s default). Inside
    -- it a worker is presumed alive and its advance still expected; past it the worker is
    -- presumed dead, exactly as claim_ presumes when it re-claims a stale lease.
    v_in_flight := v_claimed_at is not null and v_claimed_at > now() - make_interval(secs => 300);
    return jsonb_build_object(
      'status', 'cancelled',
      'in_flight', v_in_flight,
      'retry_after', case when v_in_flight then v_claimed_at + make_interval(secs => 300) else null end);
  end if;

  if not exists (select 1 from public.newsletter_send_jobs j where j.id = p_campaign_id) then
    raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
  end if;

  -- The job exists but is already terminal (done/failed) -- nothing to cancel.
  return jsonb_build_object('status', 'noop');
end;
$$;

revoke all on function public.cancel_newsletter_send_job(uuid) from public;
revoke all on function public.cancel_newsletter_send_job(uuid) from anon;
revoke all on function public.cancel_newsletter_send_job(uuid) from authenticated;
grant execute on function public.cancel_newsletter_send_job(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Operator: retry a failed job -- not while a batch is unaccounted for (GV-470)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 185 (its newest definition). ONE change: a job cancelled while a
-- worker held the lease (the receipt from section 2) may not be re-queued until that batch is
-- accounted for -- either because the worker's advance landed (section 1 clears the receipt,
-- usually within seconds) or because a full lease window has passed and the worker is
-- presumed dead. Retrying inside that window is what re-mails a batch that already went out.
--
-- SQLSTATE 55P03 (lock_not_available), distinct from the 22023 a non-failed job raises and
-- from the 55006 a concurrent send raises, so the caller can tell "wait a moment" apart from
-- "never" and say so. The refusal is bounded by wall clock -- claimed_at is a fixed past
-- timestamp, so the fence always lifts -- and a job can therefore never be stranded
-- un-retryable, which is the failure GV-459 added retry_ to prevent in the first place.

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
  '198_newsletter_cancel_lease_safety',
  'GV-470: cancelling a newsletter send while a batch is claimed must not let a later retry re-mail that batch. THE INTERLEAVING: govehlo-web''s batch hook drives one bounded batch per invocation as claim (lease) -> render -> mint the next keyset page -> Sweego fan-out -> advance the cursor and release the lease. If the operator cancels between the claim and the advance -- which is the whole duration of a tick that is mailing -- then (t2) the mail is already out, (t3) cancel_newsletter_send_job forces the job to ''failed'' and, before this migration, cleared claimed_at, (t4) the hook''s advance_newsletter_send_job matches nothing because its UPDATE is guarded on status in (pending, sending) and returns quietly as the deliberate no-op 181 made it, SO THE CURSOR NEVER MOVES, and (t5/t6) retry_newsletter_send_job re-queues the job from that stale cursor and the next tick mints and mails EXACTLY THE SAME RECIPIENTS a second time. Deterministic, not a rare race. GV-457''s per-(campaign, recipient) Sweego idempotency key cannot be the guard: it is best-effort (Sweego''s honouring of it is unconfirmed) and a retry can arrive days after the cancel. CONSIDERED AND REJECTED: (a) cancel refusing or waiting while the lease is live -- it cannot un-send t2, it removes the operator''s only stop button for a full lease window, and it still loses the cursor for a tick that outlives its own lease; (b) cancel burning the claimed page by advancing the cursor over it -- the database does not know the page (p_limit is the hook''s BATCH_LIMIT, passed to mint_ and never stored), so it would have to guess, and guessing high silently drops recipients who never received the campaign. THE FIX, three body changes with NO new column, NO index, NO grant change and NO signature change: (1) cancel_newsletter_send_job no longer clears claimed_at. Cancelling stays immediate and total (status ''failed'' at once, so claim_ -- which only reads pending/sending -- never touches the job again and the single-active slot frees without waiting out the retry ceiling), but a surviving lease stamp becomes a RECEIPT: because advance_, retry_ and cancel_-on-an-unclaimed-job all null the lease, a terminal job with a non-null claimed_at means exactly "a worker was mid-batch when this was cancelled and its work is unaccounted for" -- notably a job failed by 185''s retry CEILING has claimed_at null (the same UPDATE cleared it), so that path is untouched. Its jsonb gains in_flight and retry_after beside the unchanged ''status'' key. (2) advance_newsletter_send_job, re-declared COMPLETELY off 185 (chain 179 -> 181 -> 185), byte-identical bar one block: when its ordinary active-job UPDATE matches 0 rows it now attempts a second, narrow UPDATE against status = ''failed'' and claimed_at is not null, applying the SAME strictly-advancing cursor/count arithmetic and then clearing the receipt -- so the batch that was already mailed IS recorded even though the job is cancelled, and a later retry resumes past it. It does not change status (reconciliation, not resurrection), does not touch attempt_count/next_attempt_at, and never falls through to the done-branch, so a cancelled campaign still writes no newsletter_send_log row whatever p_done says; an advance at a long-terminal job with no receipt is still the quiet no-op and a genuinely absent id still raises P0002. (3) retry_newsletter_send_job, re-declared off 185, refuses while that receipt is outstanding and younger than one lease window (300s -- the hook''s LEASE_SECONDS and claim_''s default) with SQLSTATE 55P03 (lock_not_available -- distinct from the 22023 for a non-failed job and the 55006 for a concurrent send) and the Danish sentence "udsendelsen har stadig en batch i gang - vent til den er afsluttet og prøv igen", so a retry cannot re-activate the job before the in-flight advance can land. The fence is bounded by wall clock (claimed_at is a fixed past timestamp), so it always lifts and no job is ever stranded un-retryable -- the GV-459 failure this must not re-open. RESIDUAL, DOCUMENTED: if the hook dies between the Sweego fan-out and its advance AND the job was cancelled, the receipt expires unreconciled and a retry can re-mail that page. That is the pre-existing at-least-once window the design already carries (the same crash without a cancel is re-claimed after the lease and re-mints the same page), it is what GV-457''s key exists to soften, and closing it would require the per-recipient mailing record migration 161 refused to keep; cancel+retry is now no more dangerous than the ordinary crash path, where before it was worse and deterministically so. claim_ (newest 185), mint_ and create_ (newest 181) and the two readers (180, 191) are untouched. Signatures are unchanged, so govehlo-web''s batch hook and newsletter-send-control endpoint stay compatible and types/database.ts does not change (no re-vendoring). No ledger_events written, so the GV-413 guard does not apply. VERIFIED BY tools/test-newsletter-cancel-lease-contract.mjs (npm run test:newsletter-cancel-lease, wired into npm run validate): static pins on both this migration and the consolidated mirror, plus a Docker replay that drives the full claim/mint/mail/cancel/advance/retry interleaving and asserts the second mint returns the NEXT recipients rather than the ones already mailed. Depends on 185 (the definitions it re-declares) and 179/181 (the job model and the single-active index).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

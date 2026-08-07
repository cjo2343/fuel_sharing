-- Migration 185: unsubscribe tokens for the subscriber's lifetime + a poison-job retry ceiling (GV-456/457/459)
--
-- Three fixes to the batched newsletter send (migrations 179/181), all on the SAME
-- function and table, so they ship as one migration rather than three that would collide.
--
-- GV-456 (HIGH, GDPR) -- an old unsubscribe link must never silently fail.
--   Migration 181's advance_newsletter_send_job prunes newsletter_send_tokens older than
--   24 months at each campaign's completion. That prune re-opens EXACTLY the class of bug
--   migration 175 (GV-441) closed: govehlo-web's unsubscribe endpoint renders the same
--   "din adresse er vaek" goodbye page whether or not the RPC matched a row -- deliberate
--   anti-enumeration silence -- so a subscriber who clicks a >24-month-old newsletter's
--   link, whose token the prune has since deleted, is told they are unsubscribed while
--   remaining fully on the list. An opt-out that reports success and does nothing is
--   markedsfoeringsloven paragraph 10 inverted and article 17 answered with a lie, which
--   is the precise failure 175's header spent itself on. The 24-month cap was 175's own
--   article 5(1)(e) storage-minimisation gesture, but it is unnecessary: a token row is
--   already bounded by ON DELETE CASCADE (migration 175) -- it lives exactly as long as the
--   subscriber and dies in the same statement as the unsubscribe DELETE, so it can never
--   become the tombstone migration 161 refused to keep. "The subscriber's lifetime" IS
--   storage limited to the purpose. So this migration REMOVES the 24-month token prune from
--   advance_'s done-branch and keeps every unsubscribe link working for as long as the
--   address is on the list. The 90-day terminal-JOB prune (LOW-7, migration 181) is a
--   different sweep over a different table (newsletter_send_jobs, which holds no address)
--   and is KEPT untouched.
--
-- GV-459 (MEDIUM) -- a permanently-failing send must not wedge every future campaign.
--   The single-active partial unique index (migration 181) allows at most one pending/
--   sending job. A job whose every batch fails before it can move the cursor (a template
--   that never loads, a mint that always errors) is released by the hook's pure lease-
--   release and re-claimed forever: it never reaches a terminal state, so the single-active
--   slot never frees and NO new campaign can be created (create_ raises 55006). This adds
--   two columns -- attempt_count (how many consecutive no-progress ticks this job has had)
--   and next_attempt_at (a backoff floor claim_ honours) -- and a retry ceiling of 5: after
--   the fifth consecutive failed tick advance_ transitions the job to status='failed',
--   freeing the slot. A tick that makes progress (the cursor advances) resets attempt_count
--   to 0, so the ceiling only ever fires on a job that is genuinely stuck. Two operator RPCs
--   round it out: cancel_newsletter_send_job forces an active job terminal (an operator who
--   knows a send is wrong should not have to wait out five ticks), and retry_newsletter_send_job
--   re-queues a failed job from where its cursor stopped (resume, not restart -- nobody who
--   already got the mail gets it twice). Both are service_role-only like the rest.
--
-- GV-457 lives entirely in govehlo-web (functions/api/hooks/newsletter-batch.js + _send.js):
--   a per-(campaign, recipient) Sweego idempotency key, so a Worker crash between "mailed"
--   and "cursor advanced" re-mails nobody. It needs no schema and is not in this migration.
--
-- RE-DECLARE OFF NEWEST (GV-202). advance_ and (the untouched-here) create_ have their
-- newest definition in migration 181; claim_ has its newest in 179 (181 left it alone). So
-- advance_ is re-declared off 181 and claim_ off 179, each COMPLETELY and byte-identical to
-- its newest prior body except the change described -- the equivalence check diffs bodies
-- and in-body comments. create_/mint_ are not touched (create_'s INSERT needs no change:
-- attempt_count defaults to 0 and next_attempt_at to null).
--
-- SIGNATURES ARE UNCHANGED for claim_/advance_, so govehlo-web's batch hook (written
-- against them verbatim) stays compatible; cancel_/retry_ are new and additive. The two new
-- columns DO change public types, so types/database.ts is regenerated and vendored.
--
-- No ledger_events are written (a send has no ledger, member or feed), so no event_type is
-- introduced and the GV-413 classification guard does not apply, exactly as in 179/181.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Retry bookkeeping columns                                       (GV-459)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- attempt_count counts CONSECUTIVE no-progress ticks; next_attempt_at is a backoff floor.
-- Neither is subscriber data -- a count enumerates nobody and a timestamp is a position in
-- time, not a person -- so the consent contract's PII-name guard (which already exempts the
-- count/operator columns) is satisfied. Both are added by ALTER so create-table stays the
-- 179 block the guard parses.

alter table public.newsletter_send_jobs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz;

comment on column public.newsletter_send_jobs.attempt_count is
  'GV-459: consecutive no-progress ticks. advance_ increments it on a pure lease-release (a tick that mailed nobody and did not move the cursor) and resets it to 0 the moment a tick advances the cursor. When it reaches the ceiling (5) advance_ transitions the job to failed, freeing the single-active slot a permanently-stuck job would otherwise hold forever. A count, not personal data.';
comment on column public.newsletter_send_jobs.next_attempt_at is
  'GV-459: earliest time claim_ may re-claim this job. advance_ sets it to a growing backoff on each failed tick and clears it on progress; null means immediately eligible. A timestamp, not personal data.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Claim a due job -- now honours the retry backoff floor             (GV-459)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 179 (its newest definition; 181 left claim_ untouched). The
-- only change is one added predicate: a job whose next_attempt_at is in the future is not
-- yet eligible, so a failing job backs off between ticks instead of being hammered every
-- tick. Everything else -- the lease window, `for update skip locked`, the sending/lease
-- stamp -- is byte-identical to 179.

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
-- 3. Advance a job -- no token prune, and a retry ceiling               (GV-456/459)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off migration 181 (its newest definition). TWO changes to 181's body:
--
--   * GV-456: the 24-month `delete from newsletter_send_tokens` is GONE from the done-branch.
--     A token now lives for the subscriber's lifetime (bounded by ON DELETE CASCADE), so no
--     unsubscribe link ever silently stops matching while the address is still on the list.
--     The 90-day terminal-JOB prune below it stays -- different table, no address, kept.
--
--   * GV-459: attempt_count and next_attempt_at are maintained IN the same UPDATE, and the
--     status case gains a failed transition. 181's idempotency structure is preserved
--     exactly -- the UPDATE still always applies to an active job (releasing the lease,
--     stamping updated_at and last_status_code unconditionally), and the count-add and
--     cursor-move are still conditional on the batch being NEW. Three tick shapes drive it:
--       - PROGRESS: a new batch (p_last_confirmed_at non-null AND strictly past the cursor).
--         attempt_count resets to 0 and next_attempt_at clears -- a job that moved is healthy.
--       - FAILED TICK: a pure lease-release (p_last_confirmed_at null, zero deltas, p_done
--         false -- the hook's releaseLease shape after a template/mint/fan-out failure).
--         attempt_count increments and next_attempt_at is pushed out by a growing backoff;
--         on the fifth such tick the status flips to failed and the single-active slot frees.
--       - DONE: p_done true. Unchanged -- writes the one send-log row and prunes old terminal
--         jobs. A failed tick is never a done tick, so the two cases never overlap.
--     A retried failed tick simply increments once more (accelerating the ceiling harmlessly)
--     or, once the job is already failed, updates 0 rows and returns quietly like any other
--     no-op on a terminal job -- no double-count, no second send-log row.

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
-- 4. Operator: cancel an active job                                     (GV-459)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Force an active (pending/sending) job to the terminal 'failed' state, freeing the single-
-- active slot immediately. For an operator who knows a running send is wrong and should not
-- have to wait out the retry ceiling. It writes NO send-log row -- a cancelled campaign did
-- not complete -- and touches no address. A quiet no-op on an already-terminal job (returns
-- {'status':'noop'}); a genuinely absent id raises P0002. service_role only, like the rest.

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
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  update public.newsletter_send_jobs j
  set status = 'failed',
      claimed_at = null,
      updated_at = now()
  where j.id = p_campaign_id
    and j.status in ('pending', 'sending');

  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return jsonb_build_object('status', 'cancelled');
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
-- 5. Operator: retry a failed job                                       (GV-459)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-queue a FAILED job for the batch hook to pick up again. It RESUMES from where the
-- cursor stopped -- status back to 'pending', attempt_count and next_attempt_at reset, lease
-- cleared, but the cursor left in place -- so recipients already mailed are not mailed again.
-- Only a 'failed' job may be retried (a done job completed; an active job is already running).
-- Because re-activating collides with the single-active partial unique index when another
-- job is already pending/sending, the UPDATE is wrapped to catch unique_violation and raise
-- the same friendly Danish 55006 create_ uses. service_role only.

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
  v_updated integer;
begin
  if p_campaign_id is null then
    raise exception 'p_campaign_id is required' using errcode = '22023';
  end if;

  select j.status into v_status
  from public.newsletter_send_jobs j
  where j.id = p_campaign_id;

  if v_status is null then
    raise exception 'no newsletter_send_jobs row for %', p_campaign_id using errcode = 'P0002';
  end if;
  if v_status <> 'failed' then
    raise exception 'kun en fejlet udsendelse kan genstartes' using errcode = '22023';
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
  '185_newsletter_send_job_lifetime_and_retry',
  'GV-456/457/459: harden the batched newsletter send (migrations 179/181) with three fixes on the same function and table. GV-456 (HIGH, GDPR): advance_newsletter_send_job''s done-branch no longer prunes newsletter_send_tokens at 24 months. That prune re-opened migration 175''s (GV-441) class of bug -- govehlo-web''s unsubscribe endpoint renders the same goodbye page whether or not a row matched (deliberate anti-enumeration silence), so a subscriber clicking a >24-month-old newsletter''s link, whose token the prune deleted, is told they are unsubscribed while staying on the list: an opt-out that reports success and does nothing (markedsfoeringsloven paragraph 10 inverted, article 17 answered with a lie). The 24-month cap was unnecessary because a token row is already bounded by ON DELETE CASCADE -- it lives exactly as long as the subscriber and dies in the unsubscribe DELETE -- so "the subscriber''s lifetime" is already storage limited to the purpose and cannot become the tombstone 161 refused. The prune is removed; every unsubscribe link now works for as long as the address is on the list. The 90-day terminal-JOB prune (LOW-7, 181) over newsletter_send_jobs (no address) is a different sweep and is KEPT. GV-459 (MEDIUM): a permanently-failing send used to wedge every future campaign, because the single-active partial unique index (181) allows one pending/sending job and a job that fails before it can move the cursor is released and re-claimed forever, never terminal, so the slot never frees (create_ raises 55006 for every new send). Two columns are added -- attempt_count (consecutive no-progress ticks) and next_attempt_at (a backoff floor claim_ honours) -- and advance_ gains a retry ceiling of 5: a NEW batch (cursor advances) resets attempt_count to 0, a pure lease-release (p_last_confirmed_at null, zero deltas, p_done false -- the hook''s failure path) increments it and pushes next_attempt_at out by a growing linear backoff (capped 1h), and the fifth consecutive failed tick transitions the job to failed, freeing the slot. 181''s idempotency structure is preserved exactly (the UPDATE always applies to an active job, releasing the lease and stamping last_status_code unconditionally; count-add and cursor-move stay conditional on the batch being new; the done-branch runs only when a row was updated AND p_done). claim_due_newsletter_send_job is re-declared off 179 (its newest; 181 left it untouched) with one added predicate -- next_attempt_at is null or <= now() -- so a failing job backs off between ticks. advance_ is re-declared off 181 (its newest). Two new operator RPCs, service_role only: cancel_newsletter_send_job(p_campaign_id uuid) returns jsonb forces an active job to failed (freeing the slot without waiting out the ceiling), writing no send-log row and returning {status:cancelled} or {status:noop} on an already-terminal job (P0002 if absent); retry_newsletter_send_job(p_campaign_id uuid) returns jsonb re-queues a failed job from where its cursor stopped (status->pending, attempt_count/next_attempt_at reset, cursor kept so already-mailed recipients are not re-mailed), raising 55006 (via a unique_violation handler on the single-active index) if another send is already running and 22023 if the job is not failed. GV-457 (duplicate sends) lives entirely in govehlo-web (a per-(campaign, recipient) Sweego idempotency key in the batch hook) and needs no schema. Signatures for claim_/advance_ are unchanged so the web batch hook stays compatible; the two new columns change types/database.ts, which is regenerated and vendored to both clients; EXPECTED_LATEST_MIGRATION and DB_TYPES_GENERATION are bumped to 185. No ledger_events written, so the GV-413 guard does not apply. The new columns are counts/timestamps, not subscriber PII, so tools/test-newsletter-consent-contract.mjs stays green; the re-declared functions stay clean under tools/check-concurrency-hazards.mjs (advance_''s additive SETs are case-when-guarded and its WHERE carries a status predicate; the new RPCs are neither check-then-insert nor unguarded additive updates).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

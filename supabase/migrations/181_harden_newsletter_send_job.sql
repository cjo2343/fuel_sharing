-- Migration 181: harden newsletter send-job model (GV-451)
--
-- WHAT THIS IS. An adversarial review of migration 179's batched newsletter send found
-- three genuine defects. This migration fixes all three by RE-DECLARING two of 179's
-- functions off their newest definition (179 itself, the "re-declare off latest" rule),
-- changing ONLY the bodies. The signatures are UNCHANGED -- same parameter names, types,
-- order and defaults, same RETURNS -- because the GV-442 Phase 2b web hook is being built
-- against them verbatim and a reordered or renamed parameter would be a PGRST202 the
-- platform CI cannot see. It also adds one partial unique index and one assertion to the
-- consent contract. No signature change and no new column, so types/database.ts does not
-- change. claim_ and mint_ are correct as they stand and are left untouched.
--
-- FIX 1 (HIGH) -- advance_newsletter_send_job is now IDEMPOTENT.
--   179's UPDATE was `where j.id = p_campaign_id` with no status or cursor guard, its
--   counts were additive, and the done-branch (the ONE newsletter_send_log insert and the
--   24-month token prune) ran unconditionally whenever p_done was true. The scheduler that
--   drives a send is at-least-once: a tick can be retried, and a worker whose lease expired
--   mid-batch can advance a job a NEW tick has already re-claimed. Under 179 a retried final
--   advance(p_done=>true) wrote a SECOND send_log row and re-ran the prune, and a retried
--   non-done advance double-counted sent/failed.
--     The fix SPLITS the guard rather than gating the whole UPDATE, because the Phase 2b
--   hook drives advance_ three ways and the third must not regress: (1) cursor-advance --
--   non-null keyset, non-zero deltas, p_done false; (2) done -- null keyset, p_done true;
--   (3) PURE LEASE-RELEASE -- null keyset, zero deltas, p_done false, called after a
--   template/mint/fan-out failure to clear claimed_at so the NEXT tick re-claims immediately
--   instead of waiting out the 300s lease. Gating the entire UPDATE on "the batch is new"
--   would turn case 3 on a job whose cursor is already set into a no-op, and the lease would
--   never release -- a regression. So the UPDATE ALWAYS applies to an active job (status in
--   'pending'/'sending'), releasing the lease, stamping updated_at and recording
--   last_status_code unconditionally (all safe to repeat). Only the COUNT-ADD and the
--   CURSOR-MOVE are made conditional, inside SET, applied only when the batch is NEW:
--   p_last_confirmed_at is non-null AND its keyset is strictly past the stored cursor (or the
--   cursor was never set). A retried cursor-advance with the same or a lower cursor therefore
--   adds nothing and moves nothing. The done transition (status -> done) fires on p_done, and
--   because the WHERE excludes an already-done row a duplicate done updates 0 rows. We capture
--   ROW_COUNT: the done side effects run ONLY when a row was updated AND p_done, so a duplicate
--   final advance writes no second log row and re-runs no prune. A 0-row outcome on a job that
--   genuinely does not exist still raises P0002; a 0-row no-op on an existing (already
--   terminal) job is not an error and returns quietly.
--
-- FIX 2 (MEDIUM) -- the single-active-job guard is now RACE-PROOF.
--   179's create_newsletter_send_job did `if exists(... pending/sending ...) then raise
--   55006` -- a check-then-insert TOCTOU. Two near-simultaneous operator submits both pass
--   the check and both insert an active job, and the whole list is mailed twice. A partial
--   unique index over the constant expression ((true)) WHERE status in ('pending','sending')
--   enforces at most one active row at the storage layer. create_ keeps its fast-path
--   exists-check (for the friendly Danish 55006 message on the common path) but now also
--   wraps the INSERT to catch a unique_violation and re-raise the SAME 55006 -- so a race
--   that slips past the check is refused, never a second active job.
--
-- LOW-7 (folded in) -- completed jobs are pruned. 179 never removed terminal jobs, so the
--   table grew without bound. advance_'s done-branch now opportunistically deletes done/
--   failed jobs older than 90 days, right beside the token prune (the just-completed job is
--   safe: its updated_at is now()).
--
-- FIX 3 (MEDIUM) -- lives in tools/test-newsletter-consent-contract.mjs, not here. 179's
--   tracker claimed the job table's deny-all posture was "asserted globally" in that file,
--   but the table appeared there 0 times -- only the role matrix guarded it. The consent
--   contract now parses newsletter_send_jobs' column list from supabase-schema.sql and fails
--   if any column name looks like subscriber PII (any /email/ other than operator_email, or
--   /name|recipient|address|token|subscriber/), so a future `add column last_recipient_email`
--   fails CI. This migration's tracker corrects the 179 record accordingly.
--
-- No ledger_events are written (a send has no ledger, member or feed), so no event_type is
-- introduced and the GV-413 classification guard does not apply, exactly as in 179.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Race-proof the single-active-job guard                              (GV-451)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- At most one row may be pending or sending. The expression is the constant ((true)), so
-- every row that matches the partial predicate collides on the same index key -- the index
-- therefore permits at most ONE such row, which is exactly the invariant create_ checks for
-- in application code. ((true)) is a valid immutable index expression in Postgres and the
-- partial WHERE restricts the constraint to active rows, leaving done/failed rows unconstrained.
create unique index if not exists newsletter_send_jobs_single_active
  on public.newsletter_send_jobs ((true))
  where status in ('pending', 'sending');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Create a campaign -- now refuses a racing second send at the storage layer (GV-451)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off 179. Same signature and same validation; the only change is that the
-- INSERT is wrapped to catch the unique_violation the new partial index raises when a
-- concurrent call wins the race between the exists-check and the insert, re-raising the
-- same friendly Danish 55006 the caller already renders.

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

  -- The concurrent-send guard, fast path. Two active sends would each mint tokens for the
  -- same subscribers and race to invalidate each other's unsubscribe links (a token click
  -- cascades away all of a subscriber's tokens, migration 175). At most one job may be
  -- pending or sending; the caller surfaces this message to the operator. This exists-check
  -- gives the friendly message on the common path, but it is a check-then-insert and cannot
  -- be the whole guard -- see the unique_violation handler below.
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

  -- The storage-layer guard. Between the exists-check above and this insert a second call
  -- can slip through and insert its own active job; the partial unique index
  -- newsletter_send_jobs_single_active then rejects whichever loses, and we re-raise the
  -- same 55006 so a race is refused with the operator's message rather than a raw 23505.
  begin
    insert into public.newsletter_send_jobs (
      headline, intro, features, status, total_recipients, ceiling_at, operator_email
    ) values (
      v_headline, v_intro, v_features, 'pending', v_total, v_ceiling, v_operator
    )
    returning id into v_job_id;
  exception when unique_violation then
    raise exception 'en udsendelse er allerede i gang' using errcode = '55006';
  end;

  return v_job_id;
end;
$$;

revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from public;
revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from anon;
revoke all on function public.create_newsletter_send_job(text, text, jsonb, text) from authenticated;
grant execute on function public.create_newsletter_send_job(text, text, jsonb, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Advance a job -- now idempotent under an at-least-once scheduler     (GV-451)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared off 179. Same signature. The UPDATE always applies to an active job (so a
-- pure lease-release always unlocks it), but the count-add and cursor-move are conditional
-- so a retried or stale cursor-advance adds and moves nothing, and the done-branch (the one
-- send_log row, the token prune, and the new terminal-job prune) runs ONLY on the call that
-- actually transitions the job to done. A 0-row outcome distinguishes a genuinely-absent
-- campaign id (P0002) from a no-op on an existing (terminal) job (return quietly).

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
  -- -- all three are safe to repeat, and doing them unconditionally is what lets the hook's
  -- "pure lease-release" retry (p_last_* null, zero deltas, p_done false, called after a
  -- template/mint/fan-out failure) unlock the job immediately instead of waiting out the
  -- 300s lease. What is made IDEMPOTENT is the count-add and the cursor-move: both apply only
  -- when this batch is NEW -- p_last_confirmed_at is non-null AND its keyset is strictly past
  -- the stored cursor (or the cursor was never set). So a retried cursor-advance carrying the
  -- same or a lower cursor adds nothing and moves nothing, while a lease-release still unlocks.
  -- The done transition (status -> done) fires on p_done; because the WHERE excludes an
  -- already-done row, a duplicate done updates 0 rows and its once-per-campaign side effects
  -- below are skipped.
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
      status = case when coalesce(p_done, false) then 'done' else j.status end,
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
    -- advance, or a lease-release arriving after the job finished. A no-op on an existing job
    -- is expected under an at-least-once scheduler and is NOT an error, so only a truly absent
    -- id raises.
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

    -- Migration 175's 24-month token prune, run once per campaign here rather than every
    -- batch. Every confirmed subscriber targeted by this send was just handed a fresh
    -- token, so nobody is left without a working link by this sweep.
    delete from public.newsletter_send_tokens st
    where st.created_at < now() - interval '24 months';

    -- LOW-7 (GV-451): terminal jobs are otherwise never removed, so prune done/failed jobs
    -- older than 90 days. The job just completed above is safe -- its updated_at is now().
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

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '181_harden_newsletter_send_job',
  'GV-451: harden migration 179''s batched newsletter send against three review findings, with UNCHANGED signatures so the GV-442 Phase 2b web hook stays compatible (create_/advance_ re-declared off 179, their newest definition, bodies only; claim_/mint_ untouched; no new column, so types/database.ts is unchanged). FIX 1 (HIGH) advance_newsletter_send_job is now idempotent WITHOUT breaking the hook''s pure lease-release path. The Phase 2b hook drives advance_ three ways: cursor-advance (non-null keyset, deltas, p_done false), done (null keyset, p_done true) and pure lease-release (null keyset, zero deltas, p_done false, to clear claimed_at after a template/mint/fan-out failure so the next tick re-claims immediately). Gating the whole UPDATE on "batch is new" would make a lease-release on a job with an already-set cursor a no-op and delay retry up to the 300s lease, so instead the UPDATE always applies to an active job (status in pending/sending) -- releasing the lease, stamping updated_at and recording last_status_code unconditionally -- and only the count-add and cursor-move are conditional (applied only when p_last_confirmed_at is non-null AND its keyset is strictly past the stored cursor, or the cursor was never set). A retried cursor-advance with the same/lower cursor adds and moves nothing. The done-branch (the ONE newsletter_send_log row, the 24-month newsletter_send_tokens prune, and a new 90-day terminal-job prune, LOW-7) runs only when GET DIAGNOSTICS shows a row was actually updated AND p_done -- and a duplicate done finds status already done, so 0 rows update and the branch is skipped -- so a retried or lease-expired advance no longer double-counts sent/failed nor writes a second send_log row; a 0-row outcome raises P0002 only for a genuinely-absent campaign id and returns quietly for a no-op on an existing (terminal) job. FIX 2 (MEDIUM) the single-active-job guard is race-proof: a partial unique index newsletter_send_jobs_single_active on ((true)) where status in (pending,sending) enforces at most one active row at the storage layer, and create_newsletter_send_job keeps its fast-path exists-check (friendly Danish 55006) but now wraps the INSERT to catch unique_violation and re-raise the same 55006, so a TOCTOU race that slips past the check is refused rather than mailing the whole list twice. FIX 3 (MEDIUM) corrects the 179 record: 179''s tracker claimed newsletter_send_jobs'' deny-all posture was asserted globally in tools/test-newsletter-consent-contract.mjs, but the table appeared there 0 times (only the role matrix guarded it); the consent contract now really does assert the job table''s column list, failing if any column name looks like subscriber PII (any /email/ other than operator_email, or /name|recipient|address|token|subscriber/), so a future add column last_recipient_email fails CI. No ledger_events written, so the GV-413 guard does not apply.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 173: mint per-send unsubscribe tokens + a counts-only send log (GV-430)
--
-- Migration 161 built the CONSENT half of the newsletter and made one decision that
-- this migration has to live with rather than undo: the unsubscribe token is stored
-- ONLY as a sha256 digest. That is what makes a database dump harmless — nobody can
-- reconstruct a working link from it — and it is also why a send cannot simply read
-- the list and paste each subscriber's existing link into their mail. The link does
-- not exist anywhere any more. Sending therefore requires MINTING a fresh token per
-- recipient at send time, and that is the whole of what this migration adds.
--
-- WHY A SEND FLOW AT ALL, RATHER THAN "just export the addresses once"
--
-- Markedsføringsloven § 10 requires that every marketing mail carry an easy, free way
-- to opt out, and that opting out actually stops the mail. A manual campaign built on
-- an exported address list cannot satisfy that: the export is a copy of the list that
-- nobody unsubscribes FROM, so the moment it leaves the database it is a list that
-- keeps mailing people who have already left. Minting through this RPC is the lawful
-- path precisely because it is not an export — the addresses are handed out together
-- with a live unsubscribe token, one send at a time, and anybody who clicks it is gone
-- from the source of truth before the next send reads it.
--
-- WHAT THIS ADDS
--
--   public.mint_newsletter_send_tokens(p_operator_email, p_headline)
--       For every CONFIRMED subscriber: generate 32 random bytes, store their sha256
--       digest over the old one, and return (email, RAW token). Returns rows, which is
--       a deliberate exception to 161's "the RPCs return a status, never rows" rule and
--       the only one this feature may have: a send is the one operation that genuinely
--       needs the addresses. It is service_role only, so the exception is not reachable
--       from a browser under any circumstance.
--
--   public.newsletter_send_log
--       One row per mint: who asked, what the campaign was called, HOW MANY addresses
--       were handed out. No address, ever.
--
-- THE RAW TOKENS EXIST ONLY IN THE RESULT SET. They are generated inside the statement
-- that stores their digest, returned to the caller, and never written anywhere — not to
-- newsletter_subscribers, not to newsletter_send_log, not to a log line. 161's promise
-- that a dump cannot unsubscribe anybody survives this migration unchanged, and so does
-- the sha256-hex check constraint that enforces it.
--
-- ROTATION IS THE POINT, NOT A SIDE EFFECT. Each mint REPLACES the stored digest, so
-- the previous send's links stop working the moment the next send is minted. That is a
-- real cost — someone who kept an old newsletter and clicks its unsubscribe link a
-- month later lands on the "not on the list" page instead of unsubscribing — and it is
-- accepted because the alternative is worse: keeping a long-lived token usable would
-- mean either storing the raw token (which 161 refuses) or never rotating, and a token
-- that never rotates is one that leaks once and works forever. The mitigation is that
-- the CURRENT mail always carries a working link, which is what § 10 actually requires.
--
-- GDPR
--
--   * Raw tokens are returned and not stored: storage minimisation (article 5(1)(c))
--     and the integrity duty in 5(1)(f). The digest is enough to honour an unsubscribe
--     and is useless to anyone who steals the table, so keeping the raw value would add
--     risk without adding capability.
--   * The send log is COUNTS ONLY. Article 5(1)(c) again: the accountability question
--     an audit row has to answer is "who sent what, to how many, when", and none of
--     those four is an address. A per-recipient send log would rebuild, inside the
--     audit table, exactly the mailing history 161 declined to keep — and it would
--     survive the unsubscribe DELETE, which is the one thing that must never happen to
--     someone who asked us to stop. So the log has no recipient column and no foreign
--     key to the list, and the check that keeps it that way is in the contract test.
--   * operator_email is OUR staff, not a subscriber: it is the accountability record of
--     who triggered a marketing send, kept on the legitimate-interest basis that any
--     audit trail rests on, and it is the only address in the table.
--   * No new personal-data category, no new recipient, no new retention question for
--     subscribers: the list itself is untouched except for one rotated digest per row.
--
-- No ledger_events are written. A newsletter send is not workspace activity — it has no
-- ledger, no member and no feed to appear in — so no event_type is introduced and the
-- GV-413 classification guard does not apply. The send-log row IS the record.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The send log                                                        (GV-430)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Deny-all exactly like its parent table, service_role included. The admin console has
-- no reason to read raw rows; if the operator ever wants "when did we last send?" the
-- answer is a counts function in the shape of migration 163's, not a grant.

create table if not exists public.newsletter_send_log (
  id uuid primary key default gen_random_uuid(),
  operator_email text not null,
  headline text not null,
  recipient_count integer not null,
  created_at timestamptz not null default now(),
  -- Same normalisation and shape rule as the subscriber list, so the two agree on what
  -- an address looks like without a second opinion.
  constraint newsletter_send_log_operator_email_normalised
    check (operator_email = lower(btrim(operator_email))
           and operator_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  constraint newsletter_send_log_headline_present
    check (btrim(headline) <> ''),
  constraint newsletter_send_log_recipient_count_nonnegative
    check (recipient_count >= 0)
);

comment on table public.newsletter_send_log is
  'Counts-only audit of newsletter sends (GV-430). One row per mint_newsletter_send_tokens call: who asked, what the campaign was called, how many addresses were handed out, when. NO recipient address and no link to newsletter_subscribers, on purpose -- a per-recipient send log would rebuild the mailing history migration 161 declined to keep, and it would survive the unsubscribe DELETE. RLS on, no policy, every grant revoked including service_role, exactly like the list it audits.';
comment on column public.newsletter_send_log.operator_email is
  'The staff member who triggered the send. The only address in this table, and it is ours rather than a subscriber''s -- the accountability record of who sent marketing mail on the company''s behalf.';
comment on column public.newsletter_send_log.headline is
  'What the campaign was called, so a row can be matched to the mail that went out. Free text supplied by the operator; it is a subject line, not personal data.';
comment on column public.newsletter_send_log.recipient_count is
  'How many confirmed subscribers were handed a token by this send. A count enumerates nobody -- this is the whole of what the audit row knows about the recipients.';

-- Newest first is the only way anybody will ever read this table.
create index if not exists newsletter_send_log_created_at_idx
  on public.newsletter_send_log (created_at desc);

alter table public.newsletter_send_log enable row level security;
revoke all on public.newsletter_send_log from public;
revoke all on public.newsletter_send_log from anon;
revoke all on public.newsletter_send_log from authenticated;
-- service_role too, for migration 161's reason: the Pages Functions hold that key, and
-- the audit trail of a marketing programme is not something the code that runs the
-- programme should be able to rewrite.
revoke all on public.newsletter_send_log from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Mint the send                                                       (GV-430)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Called by govehlo-web's operator-only send endpoint, behind the dual-gated admin
-- console. Returns one row per confirmed subscriber:
--
--   email              the address to send to
--   unsubscribe_token  the RAW token to embed in that mail's unsubscribe link
--
-- Only CONFIRMED rows are returned. An unconfirmed row is somebody who typed an address
-- into the form and never clicked the link in the mail — which, when the address is not
-- theirs, is a stranger — and mailing them anything but that one confirmation is exactly
-- what the double opt-in exists to prevent. There is no "unsubscribed" state to exclude:
-- migration 161 hard-deletes on unsubscribe, so a row that is gone is gone.
--
-- The whole operation is ONE statement, and the reason is atomicity of the rotation. The
-- token is generated in `fresh`, its digest stored by `minted`, and the raw value comes
-- back out of the same CTE that produced it, so there is no window in which a digest is
-- stored whose raw token nobody holds — which would be a subscriber with no working
-- unsubscribe link. `fresh` is MATERIALIZED explicitly: gen_random_bytes is volatile and
-- would already block inlining, but "the planner happens not to inline this" is not a
-- property to rest a token on, since an inlined CTE would evaluate the random expression
-- twice and store the digest of a token the caller never receives.
--
-- `logged` is a data-modifying CTE that nothing selects from. Postgres executes those
-- exactly once and to completion regardless, so the audit row is written in the same
-- statement as the rotation: there is no path that hands out addresses without recording
-- that it happened, and none that records a send that did not happen.

create or replace function public.mint_newsletter_send_tokens(
  p_operator_email text,
  p_headline text
)
returns table(email text, unsubscribe_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := nullif(lower(btrim(coalesce(p_operator_email, ''))), '');
  v_headline text := nullif(btrim(coalesce(p_headline, '')), '');
begin
  if v_operator is null or v_operator !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'p_operator_email must be a syntactically valid address -- the send log records who sent marketing mail' using errcode = '22023';
  end if;
  if v_headline is null then
    raise exception 'p_headline is required -- it is what makes an audit row match the mail that went out' using errcode = '22023';
  end if;

  return query
  with fresh as materialized (
    select ns.id as subscriber_id,
           ns.email as subscriber_email,
           encode(extensions.gen_random_bytes(32), 'hex') as raw_token
    from public.newsletter_subscribers ns
    where ns.confirmed_at is not null
  ),
  minted as (
    update public.newsletter_subscribers ns
    set unsubscribe_token_hash = encode(extensions.digest(f.raw_token, 'sha256'), 'hex')
    from fresh f
    where ns.id = f.subscriber_id
    returning f.subscriber_email, f.raw_token
  ),
  logged as (
    insert into public.newsletter_send_log (operator_email, headline, recipient_count)
    select v_operator, v_headline, count(*) from minted
  )
  select m.subscriber_email, m.raw_token from minted m;
end;
$$;

revoke all on function public.mint_newsletter_send_tokens(text, text) from public;
revoke all on function public.mint_newsletter_send_tokens(text, text) from anon;
revoke all on function public.mint_newsletter_send_tokens(text, text) from authenticated;
grant execute on function public.mint_newsletter_send_tokens(text, text) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '173_newsletter_send_tokens',
  'Per-send unsubscribe-token minting plus a counts-only send audit log (GV-430, platform half). Migration 161 stores the unsubscribe token ONLY as a sha256 digest, which is what makes a database dump harmless and is also why a send cannot read each subscriber''s existing link -- it does not exist anywhere any more. So a send MINTS a fresh token per recipient: public.mint_newsletter_send_tokens(p_operator_email text, p_headline text) returns table(email text, unsubscribe_token text), one row per CONFIRMED subscriber, generating 32 random bytes, storing their sha256 digest over the old one and returning the RAW token. Returning rows at all is a deliberate exception to 161''s "status, never rows" rule and the only one this feature may have -- a send is the one operation that genuinely needs the addresses -- and it is contained by the grants: revoked from public, anon AND authenticated, granted to service_role only, so no browser role can reach it and it stays outside the GV-379 role-matrix coverage scope, which tracks authenticated-executable functions. Unconfirmed rows are never returned (an address typed by a third party who never clicked the link is a stranger, and the double opt-in exists to stop us mailing them), and there is no unsubscribed state to exclude because 161 hard-deletes. THE RAW TOKENS EXIST ONLY IN THE RESULT SET: generated inside the statement that stores their digest, returned, and written nowhere -- not to newsletter_subscribers, not to the send log, not to a log line -- so 161''s promise that a dump cannot unsubscribe anybody survives unchanged, as does the sha256-hex check constraint that enforces it. ROTATION IS THE POINT: each mint replaces the stored digest, so the previous send''s links stop working, and the accepted cost is that someone clicking a month-old newsletter''s link lands on the "not on the list" page; the alternative would be storing the raw token (which 161 refuses) or a token that leaks once and works forever, and markedsfoeringsloven paragraph 10 asks that the CURRENT mail carry a working link, which it always does. The whole operation is ONE statement for atomicity of the rotation -- the token is generated in an explicitly MATERIALIZED CTE (gen_random_bytes is volatile and would already block inlining, but an inlined CTE would evaluate the random expression twice and store the digest of a token the caller never receives, which is a subscriber with no working unsubscribe link), its digest stored by a second CTE, and the audit row written by a third, data-modifying and unreferenced, which Postgres still executes exactly once and to completion -- so there is no path that hands out addresses without recording it and none that records a send that did not happen. public.newsletter_send_log holds id, operator_email, headline, recipient_count, created_at and NOTHING ELSE: no recipient address and no foreign key to the list, because a per-recipient send log would rebuild inside the audit table exactly the mailing history 161 declined to keep and would survive the unsubscribe DELETE, which is the one thing that must never happen to somebody who asked us to stop. operator_email is our own staff -- the accountability record of who triggered a marketing send -- and is the only address in the table. The log is deny-all like its parent: RLS on with no policy and every grant revoked including service_role, since the code that runs the marketing programme should not be able to rewrite its audit trail; if the operator ever needs "when did we last send?", the answer is a counts function shaped like migration 163''s, not a grant. WHY A SEND FLOW EXISTS AT ALL rather than a one-off address export: markedsfoeringsloven paragraph 10 requires every marketing mail to carry an easy, free opt-out that actually stops the mail, and an exported list is a copy nobody unsubscribes FROM -- it keeps mailing people who have already left the moment it leaves the database. Minting is the lawful path because it is not an export: addresses are handed out together with a live token, one send at a time, and anyone who clicks it is gone from the source of truth before the next send reads it. GDPR: raw tokens returned and not stored is article 5(1)(c) minimisation and the 5(1)(f) integrity duty (the digest honours an unsubscribe and is useless to a thief, so the raw value would add risk without capability); the counts-only log is 5(1)(c) again, since "who sent what, to how many, when" is the whole accountability question and none of the four is an address. No new personal-data category, no new recipient and no new retention question for subscribers -- the list is untouched apart from one rotated digest per row. No ledger_events are written (a send has no ledger, member or feed), so no event_type is introduced and the GV-413 classification guard does not apply; the send-log row IS the record. Pinned statically by tools/test-newsletter-consent-contract.mjs (the new RPC is added to ALLOWED_FUNCTIONS as the deliberate decision that allowlist exists to force, and its grants, its confirmed-only predicate, the rotation, both tables'' deny-all posture and the log''s address-free column list are asserted in the migration AND the consolidated mirror) and behaviourally by tools/test-rls-role-matrix.mjs (anon and authenticated denied on the RPC and on newsletter_send_log, service_role denied on the table, and a service-role round trip proving the mint rotates the stored digest, skips unconfirmed rows and writes exactly one counts-only audit row).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

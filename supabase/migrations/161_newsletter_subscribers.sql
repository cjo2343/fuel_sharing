-- Migration 161: standalone double-opt-in newsletter list (GV-366)
--
-- The newsletter is MARKETING mail. Under markedsføringsloven § 10 it may only go to
-- someone who asked for it, and under the GDPR that request has to be provable after
-- the fact (article 7(1)). Neither is satisfied by "they have an account": consent to
-- use a product is not consent to be marketed to. So this list is STANDALONE and stays
-- standalone — nothing in this migration, and nothing that may ever be added to it,
-- reads auth.users or public.ledger_members. There is no seeding path, on purpose. An
-- address is on this list because a person typed it into the form on /nyhedsbrev/ and
-- then clicked a link in a mail sent to that address, and for no other reason.
--
-- WHAT THE CONSENT PROOF IS
--
--   requested_at          when the form was submitted
--   confirmed_at          when the link in the confirmation mail was clicked
--   consent_text_version  the identifier of the exact wording shown above the button
--
-- Those three columns ARE the documentation. requested_at alone proves nothing (anyone
-- can type someone else's address); confirmed_at is what proves the holder of the
-- mailbox agreed, because the token only ever existed in a mail delivered to it. The
-- version string is what lets us say what they agreed TO, months later, when the page
-- text has moved on. govehlo-web pins the current version as a literal in its tests.
--
-- WHAT IS DELIBERATELY NOT STORED
--
--   * No IP address and no user agent. They are the usual "proof" fields and they are
--     the ones that add personal data without adding proof: an IP does not identify a
--     mailbox holder, and the confirmed_at round trip already does. The abuse control
--     that would have justified an IP lives in the rate limiter, which stores a
--     peppered digest and purges it after 30 days (migration 149).
--   * No name, no workspace link, no engagement history.
--   * No raw tokens. Both token columns hold a sha256 hex digest. A database dump
--     therefore cannot be used to confirm or unsubscribe anybody: the raw token exists
--     only in the mail and in the URL the recipient clicks.
--   * No unsubscribed_at, and NO TOMBSTONE OF ANY KIND. Unsubscribing hard-deletes the
--     row. Keeping a "do not mail" record would mean keeping the address of exactly the
--     person who told us to stop holding it, and the suppression list that argument
--     usually justifies is only needed when a list can be re-imported from somewhere
--     else. This one cannot: the only way back on is the same double opt-in. So the
--     honest minimum is deletion, and article 17 is then satisfied by one click rather
--     than by a support mail.
--
-- ACCESS. The table is not client-facing in any sense. RLS is on with NO policy, and
-- every grant is revoked — anon, authenticated AND service_role — so the Cloudflare
-- Pages Functions cannot read or write it directly even though they hold the
-- service-role key. The only reachable surface is the three security-definer functions
-- below, each of which does one whole operation and returns a status, never rows. That
-- is the difference that matters: no code path anywhere can enumerate the list.
--
-- EXPIRY. A pending row that is never confirmed is an address we were never given
-- permission to keep, so it expires after 7 days (pending_ttl_hours, 168). Two halves:
-- newsletter_confirm_subscription refuses a token older than the window, and
-- newsletter_request_subscription purges every expired pending row on each signup —
-- not only the caller's, so the sweep does not depend on the specific person coming
-- back. It is opportunistic rather than scheduled; if the list ever gets enough volume
-- for that to matter, the right move is a line in run_operational_retention, not a
-- bigger sweep here.
--
-- No ledger_events are written. A newsletter signup is not workspace activity — it has
-- no ledger, no member and no feed to appear in — so no event_type is introduced and
-- the GV-413 classification guard does not apply.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The list                                                            (GV-366)
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  consent_text_version text not null,
  confirm_token_hash text,
  unsubscribe_token_hash text not null,
  -- Stored normalised, so the unique index and every lookup agree without a
  -- case-folding function at each call site.
  constraint newsletter_subscribers_email_normalised
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  -- The single-use invariant, expressed so the database holds it rather than the
  -- Function: a pending row HAS a confirm token, a confirmed row has none. Confirming
  -- is the one transition that flips both halves, and a replayed link therefore finds
  -- nothing to match instead of relying on a status column being read correctly.
  constraint newsletter_subscribers_confirm_token_single_use
    check ((confirmed_at is null) = (confirm_token_hash is not null)),
  constraint newsletter_subscribers_confirmed_after_requested
    check (confirmed_at is null or confirmed_at >= requested_at),
  -- sha256 hex, lower case. A raw token stored here by mistake would not match.
  constraint newsletter_subscribers_confirm_hash_shape
    check (confirm_token_hash is null or confirm_token_hash ~ '^[0-9a-f]{64}$'),
  constraint newsletter_subscribers_unsubscribe_hash_shape
    check (unsubscribe_token_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.newsletter_subscribers is
  'Standalone double-opt-in marketing list (GV-366). NEVER seeded from auth.users or ledger_members: a product account is not marketing consent (markedsfoeringsloven paragraph 10). Consent proof is requested_at + confirmed_at + consent_text_version. No IP, no user agent, no tombstone -- unsubscribing deletes the row. RLS on, no policy, every grant revoked including service_role; reachable only through newsletter_request_subscription / newsletter_confirm_subscription / newsletter_unsubscribe.';
comment on column public.newsletter_subscribers.requested_at is
  'When the signup form was submitted. Proof of the request; on its own it proves nothing about the mailbox holder -- confirmed_at is what does.';
comment on column public.newsletter_subscribers.confirmed_at is
  'When the link in the confirmation mail was clicked. Null until then, and an unconfirmed row is never mailed anything but that one confirmation. This is the timestamp that makes the consent provable: the token existed only inside a mail delivered to the address.';
comment on column public.newsletter_subscribers.consent_text_version is
  'Identifier of the exact consent wording shown at signup (e.g. 2026-08-01). Lets us state months later WHAT was agreed to, after the page text has moved on.';
comment on column public.newsletter_subscribers.confirm_token_hash is
  'sha256 hex of the single-use confirmation token. Cleared when the link is used, which is also what the single-use check constraint enforces. The raw token is never stored.';
comment on column public.newsletter_subscribers.unsubscribe_token_hash is
  'sha256 hex of the long-lived one-click unsubscribe token embedded in every mail. The raw token is never stored, so a database dump cannot unsubscribe anybody -- and cannot be used to send either.';

create unique index if not exists newsletter_subscribers_email_key
  on public.newsletter_subscribers (lower(email));
create unique index if not exists newsletter_subscribers_confirm_token_key
  on public.newsletter_subscribers (confirm_token_hash)
  where confirm_token_hash is not null;
create unique index if not exists newsletter_subscribers_unsubscribe_token_key
  on public.newsletter_subscribers (unsubscribe_token_hash);
-- Makes the expiry sweep in newsletter_request_subscription an index scan over the
-- pending rows only, rather than a walk of the confirmed list on every signup.
create index if not exists newsletter_subscribers_pending_requested_at_idx
  on public.newsletter_subscribers (requested_at)
  where confirmed_at is null;

alter table public.newsletter_subscribers enable row level security;
revoke all on public.newsletter_subscribers from public;
revoke all on public.newsletter_subscribers from anon;
revoke all on public.newsletter_subscribers from authenticated;
-- service_role too, unlike every other server-owned table in this schema. The Pages
-- Functions hold that key, and a marketing list is the one dataset where "the server
-- can read it" buys nothing: the flow needs three whole operations, not queries. With
-- the grant gone, an accidental select on this table fails in code review AND at
-- runtime rather than quietly returning every address we hold.
revoke all on public.newsletter_subscribers from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Request a subscription                                              (GV-366)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Called by govehlo-web's POST /api/newsletter/subscribe with hashes it computed from
-- tokens it generated. Returns a status plus send_mail, because only the database can
-- decide whether a confirmation mail is warranted:
--
--   pending           / send_mail true   a new or refreshed pending row -- send it
--   already_confirmed / send_mail false  the address is already on the list
--
-- The caller must render the SAME Danish reassurance either way ("check your inbox"),
-- so the endpoint cannot be used to ask whether a given address is subscribed. Note it
-- is send_mail, not "is this new" -- an endpoint that mailed on every submit would be a
-- mail bomb aimed at any address an attacker chooses.
--
-- Re-submitting a live pending address REPLACES its tokens and restarts the 7-day
-- window rather than erroring, so "I lost the mail" resolves by submitting again. The
-- old confirmation link stops working at that moment, which is the correct reading of
-- single-use.

create or replace function public.newsletter_request_subscription(
  subscriber_email text,
  consent_version text,
  confirm_hash text,
  unsubscribe_hash text,
  pending_ttl_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(subscriber_email, ''))), '');
  v_version text := nullif(btrim(coalesce(consent_version, '')), '');
  v_confirm text := nullif(lower(btrim(coalesce(confirm_hash, ''))), '');
  v_unsubscribe text := nullif(lower(btrim(coalesce(unsubscribe_hash, ''))), '');
  v_ttl interval;
  v_existing_id uuid;
  v_existing_confirmed_at timestamptz;
begin
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'subscriber_email must be a syntactically valid address' using errcode = '22023';
  end if;
  if v_version is null then
    raise exception 'consent_version is required -- it is half the consent proof' using errcode = '22023';
  end if;
  if v_confirm is null or v_confirm !~ '^[0-9a-f]{64}$'
     or v_unsubscribe is null or v_unsubscribe !~ '^[0-9a-f]{64}$' then
    raise exception 'confirm_hash and unsubscribe_hash must be sha256 hex digests' using errcode = '22023';
  end if;
  if pending_ttl_hours is null or pending_ttl_hours < 1 or pending_ttl_hours > 720 then
    raise exception 'pending_ttl_hours must be between 1 and 720' using errcode = '22023';
  end if;
  v_ttl := make_interval(hours => pending_ttl_hours);

  -- Opportunistic expiry sweep, for EVERY pending row rather than just this address:
  -- an abandoned signup is an address nobody gave us permission to keep, and it must
  -- not depend on that particular person returning to be removed.
  delete from public.newsletter_subscribers ns
  where ns.confirmed_at is null
    and ns.requested_at < now() - v_ttl;

  select ns.id, ns.confirmed_at
  into v_existing_id, v_existing_confirmed_at
  from public.newsletter_subscribers ns
  where ns.email = v_email;

  if v_existing_id is not null and v_existing_confirmed_at is not null then
    return jsonb_build_object('status', 'already_confirmed', 'send_mail', false);
  end if;

  if v_existing_id is not null then
    update public.newsletter_subscribers ns
    set requested_at = now(),
        consent_text_version = v_version,
        confirm_token_hash = v_confirm,
        unsubscribe_token_hash = v_unsubscribe
    where ns.id = v_existing_id;
    return jsonb_build_object('status', 'pending', 'send_mail', true);
  end if;

  insert into public.newsletter_subscribers (
    email, consent_text_version, confirm_token_hash, unsubscribe_token_hash
  ) values (
    v_email, v_version, v_confirm, v_unsubscribe
  );
  return jsonb_build_object('status', 'pending', 'send_mail', true);
end;
$$;

revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from public;
revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from anon;
revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from authenticated;
grant execute on function public.newsletter_request_subscription(text, text, text, text, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Confirm a subscription                                              (GV-366)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The whole opt-in turns on this one UPDATE, so it is written as a single statement
-- whose WHERE clause carries every precondition -- unused token, not yet confirmed,
-- inside the window. There is no read-then-write, so two simultaneous clicks cannot
-- both confirm, and there is no branch that can be reordered into confirming a row the
-- window has already expired.
--
-- Clearing confirm_token_hash makes the link genuinely single-use and removes a secret
-- we have no further use for. It also means a second click is indistinguishable from a
-- wrong token, which is why the caller renders ONE page for 'invalid' covering both
-- ("the link has been used or has expired") rather than guessing.

create or replace function public.newsletter_confirm_subscription(
  confirm_hash text,
  pending_ttl_hours integer default 168
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_confirm text := nullif(lower(btrim(coalesce(confirm_hash, ''))), '');
  v_ttl interval;
  v_id uuid;
begin
  if pending_ttl_hours is null or pending_ttl_hours < 1 or pending_ttl_hours > 720 then
    raise exception 'pending_ttl_hours must be between 1 and 720' using errcode = '22023';
  end if;
  -- A malformed token is answered with the ordinary "invalid" page, not an exception:
  -- this is a link a person clicked, and every wrong-link outcome must look the same.
  if v_confirm is null or v_confirm !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_ttl := make_interval(hours => pending_ttl_hours);

  update public.newsletter_subscribers ns
  set confirmed_at = now(),
      confirm_token_hash = null
  where ns.confirm_token_hash = v_confirm
    and ns.confirmed_at is null
    and ns.requested_at >= now() - v_ttl
  returning ns.id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'confirmed');
end;
$$;

revoke all on function public.newsletter_confirm_subscription(text, integer) from public;
revoke all on function public.newsletter_confirm_subscription(text, integer) from anon;
revoke all on function public.newsletter_confirm_subscription(text, integer) from authenticated;
grant execute on function public.newsletter_confirm_subscription(text, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Unsubscribe                                                         (GV-366)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One click, one DELETE, no tombstone -- see the header for why a suppression list
-- would be the wrong trade here. Works on a pending row as well as a confirmed one, so
-- somebody who never asked for the mail in the first place (an address typed by a third
-- party) can still get their address off the list from the confirmation mail itself.
--
-- 'unknown' is returned rather than raised, and the caller renders the same goodbye
-- page for both outcomes: an already-deleted row and a wrong token are the same fact
-- from the reader's side -- this address is not on the list -- and telling them apart
-- would turn the endpoint into a token oracle.

create or replace function public.newsletter_unsubscribe(
  unsubscribe_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unsubscribe text := nullif(lower(btrim(coalesce(unsubscribe_hash, ''))), '');
  v_id uuid;
begin
  if v_unsubscribe is null or v_unsubscribe !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'unknown');
  end if;

  delete from public.newsletter_subscribers ns
  where ns.unsubscribe_token_hash = v_unsubscribe
  returning ns.id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  return jsonb_build_object('status', 'unsubscribed');
end;
$$;

revoke all on function public.newsletter_unsubscribe(text) from public;
revoke all on function public.newsletter_unsubscribe(text) from anon;
revoke all on function public.newsletter_unsubscribe(text) from authenticated;
grant execute on function public.newsletter_unsubscribe(text) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '161_newsletter_subscribers',
  'GV-366: standalone double-opt-in newsletter list. The newsletter is marketing mail, so markedsfoeringsloven paragraph 10 requires an explicit prior request and the GDPR article 7(1) requires it to be provable -- and neither is satisfied by "they have an account", because consent to use a product is not consent to be marketed to. public.newsletter_subscribers is therefore standalone and has NO seeding path from auth.users or ledger_members, by construction and on purpose. The consent proof is three columns: requested_at (form submitted), confirmed_at (link in the confirmation mail clicked) and consent_text_version (which wording was shown). confirmed_at is the one that carries the weight -- anyone can type someone else''s address, but only the mailbox holder ever sees the token. Deliberately NOT stored: IP address and user agent (they add personal data without adding proof; the abuse control that would justify an IP is the rate limiter, whose actor digest is peppered and purged after 30 days by migration 149), any name or workspace link, and raw tokens -- both token columns hold a sha256 hex digest, so a database dump can neither confirm nor unsubscribe anybody. There is also no unsubscribed_at and no tombstone of any kind: unsubscribing HARD-DELETES the row, because a suppression list would mean retaining the address of precisely the person who asked us to stop, and the re-import risk that normally justifies one does not exist here (the only way back on is the same double opt-in). RLS is on with no policy and every grant is revoked including service_role -- unlike any other server-owned table in this schema -- so the Cloudflare Pages Functions cannot query the list even holding the service-role key; the only surface is three security-definer functions that each perform one whole operation and return a status rather than rows, so no code path can enumerate the list. newsletter_request_subscription upserts a pending row and returns status + send_mail, letting the database rather than the endpoint decide whether a mail is warranted (already_confirmed sends nothing, and the caller renders the same Danish reassurance either way so the endpoint is not a subscription oracle); re-submitting a live pending address replaces its tokens and restarts the window, invalidating the older link. newsletter_confirm_subscription is a single UPDATE whose WHERE carries every precondition (unused token, not yet confirmed, inside the 7-day window) so two simultaneous clicks cannot both confirm, and it clears confirm_token_hash, which is what the single-use check constraint ((confirmed_at is null) = (confirm_token_hash is not null)) enforces at the schema level. newsletter_unsubscribe deletes by unsubscribe-token digest and returns unknown rather than raising, because an already-deleted row and a wrong token are the same fact from the reader''s side and distinguishing them would make the endpoint a token oracle. Unconfirmed rows expire after 7 days from both ends: confirm refuses an older token, and request purges every expired pending row on each signup rather than only the caller''s -- opportunistic rather than scheduled, and a line in run_operational_retention is the right move if volume ever makes that matter. No ledger_events are written (a signup has no ledger, member or feed), so no event_type is introduced and the GV-413 classification guard does not apply.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

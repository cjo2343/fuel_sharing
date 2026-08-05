-- Migration 175: every newsletter's unsubscribe link keeps working, not just the newest (GV-441)
--
-- THE BUG THIS FIXES, IN THE ORDER IT HAPPENS TO A PERSON
--
-- Migration 173 mints a fresh unsubscribe token per recipient at every send and stores
-- its digest OVER the previous one, in a single column on the subscriber row. Migration
-- 161 keeps the digest only, never the raw token, so that column can hold exactly one
-- live link per subscriber. Meanwhile govehlo-web's unsubscribe endpoint answers the
-- goodbye page -- "Din adresse er vaek" -- whether or not the RPC matched anything, on
-- purpose: an already-deleted row and a wrong token are the same fact from the reader's
-- side, and telling them apart would make the endpoint a token oracle.
--
-- Put the two together. Lars is subscribed. We send the August newsletter, then the
-- September one. In October Lars scrolls back to the August mail -- the one still in his
-- inbox -- and clicks "Afmeld". His August token's digest was overwritten in September,
-- so newsletter_unsubscribe matches nothing and returns 'unknown'; the endpoint cannot
-- distinguish that from a real deletion, so it tells him his address has been deleted.
-- IT HAS NOT. Lars is still on the list and gets the November newsletter.
--
-- That is the worst failure this feature can have. It is not "a link stopped working" --
-- a dead link that SAID it was dead would be a nuisance. It is an opt-out that reports
-- success and does nothing, which is markedsfoeringsloven paragraph 10's one requirement
-- inverted, and article 17 answered with a lie. Neither half is fixable alone: the
-- endpoint's silence is load-bearing (it is what stops the URL being an oracle), so the
-- database is where the fix has to be, and it has to be "the old token still works"
-- rather than "the old token reports failure honestly".
--
-- THE FIX, AND WHAT IT KEEPS OF 173's ARGUMENT
--
-- Unsubscribe tokens move OUT of the subscriber row and into their own table, one row
-- per token, keyed by digest and pointing back at the subscriber ON DELETE CASCADE. A
-- send inserts a row per recipient instead of overwriting theirs, so every historical
-- link stays live. Unsubscribing deletes the subscriber, and the cascade takes every
-- token with it, so the whole set dies at once and there is nothing left to match.
--
-- 173's reason for rotating survives intact, which is why this is a safe change rather
-- than a reversal. That reason was never "old links should stop working" as a goal in
-- itself -- it was that a token which never rotates is one that leaks once and works
-- forever. Under this design a leaked mint result set still dies with the subscriber
-- row: the moment anybody clicks any of its tokens the subscriber is deleted and the
-- cascade removes the rest, so the leak buys one unsubscribe of a person who wanted to
-- go anyway. And the raw token is STILL never stored -- only its sha256 digest, under
-- the same hex-shape check constraint 161 wrote -- so a database dump remains unable to
-- unsubscribe anybody, which was the property 161 spent its whole header on.
--
-- WHY THE OLD COLUMN GOES AWAY ENTIRELY
--
-- newsletter_subscribers.unsubscribe_token_hash was NOT a dead column that this
-- migration could simply stop reading. Migration 161's newsletter_request_subscription
-- writes it from the hash the signup endpoint computes, and that token is the one in the
-- unsubscribe link at the foot of the CONFIRMATION mail -- the link that exists so that
-- somebody whose address a stranger typed into the form can remove it immediately rather
-- than waiting out the 7-day expiry. Moving the lookup to the new table while leaving
-- that column in place would have broken exactly that link for every new signup: written
-- to a column nothing looks up any more. So the signup path registers its digest in the
-- new table too, the existing column's contents are copied across, and the column is
-- dropped. ONE place holds unsubscribe digests, which is the shape that makes the class
-- of bug at the top of this file impossible rather than fixed once.
--
-- NO RPC SIGNATURE CHANGES. All four functions keep their exact argument lists, so
-- govehlo-web's three newsletter endpoints are unaffected and there is no PGRST202/203
-- hazard and no merge-order constraint against the web repo. `unsubscribe_hash` stays a
-- PARAMETER name on newsletter_request_subscription; only the column it used to land in
-- is gone.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
--
--   * The double opt-in confirmation token. confirm_token_hash stays exactly where it
--     is, single-use, cleared on confirmation, with its check constraint intact. It is a
--     different token solving a different problem, and it SHOULD stop working when used
--     or replaced -- the argument above applies only to unsubscribe links.
--   * newsletter_send_log. Still counts only, still no recipient column, still deny-all
--     including service_role.
--   * The list's deny-all posture, the confirmed-only send predicate, the hard delete
--     with no tombstone.
--
-- ONE BEHAVIOUR DOES CHANGE BEYOND THE SEND. Re-submitting a live pending address used
-- to REPLACE its unsubscribe token; now it adds another one, so the older confirmation
-- mail's unsubscribe link keeps working too. That is the same rule as the rest of this
-- migration applied to the same kind of link, and it is the correct reading: a person
-- who clicks "get me off this list" in ANY mail we ever sent them must come off the
-- list. The confirmation link's single-use behaviour is unchanged -- re-submitting still
-- replaces confirm_token_hash and invalidates the older confirm link.
--
-- GDPR
--
--   * newsletter_send_tokens holds a subscriber_id and a sha256 digest. The digest is
--     pseudonymous and useless to anyone who steals it -- it cannot be reversed into a
--     working link -- but the row is linkable to a person through subscriber_id, so it
--     is treated as personal data and given a lifetime rather than left to accumulate.
--   * Its lifetime IS the subscriber's lifetime: ON DELETE CASCADE means unsubscribing
--     (which is a hard delete, migration 161) removes every token row in the same
--     statement. There is no path by which a token outlives the address it belonged to,
--     which is the property that would have made this table a tombstone in disguise --
--     precisely what 161 refused.
--   * Capped at 24 MONTHS on top of that, pruned opportunistically at each mint, aligned
--     with owner_activity_log's window. A three-year-old newsletter's link is not a
--     working opt-out anybody is relying on, and article 5(1)(e) says storage limited to
--     what the purpose needs. The prune runs AFTER the mint in the same call, so every
--     confirmed subscriber always ends a send holding a token minted seconds ago.
--   * No address, no name, no send history: the table cannot answer "who did we mail",
--     only "is this digest one of ours". Article 5(1)(c) unchanged from 173's reasoning.
--   * Deny-all like both its neighbours -- RLS on, no policy, every grant revoked
--     including service_role -- so the only reachable surface is the security-definer
--     RPCs, and no code path can enumerate tokens any more than it can enumerate
--     addresses.
--
-- No ledger_events are written. A newsletter send is not workspace activity -- no
-- ledger, no member, no feed -- so no event_type is introduced and the GV-413
-- classification guard does not apply, exactly as in 161 and 173.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The token table                                                     (GV-441)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Named for the send that dominates it, but it holds EVERY unsubscribe token the system
-- issues, the one in the confirmation mail included -- see the header for why there must
-- be exactly one such place.

create table if not exists public.newsletter_send_tokens (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.newsletter_subscribers(id) on delete cascade,
  token_digest text not null unique,
  created_at timestamptz not null default now(),
  -- Migration 161's shape rule, carried over with the data it protects: sha256 hex, lower
  -- case. A raw token stored here by mistake would not match, so the promise that a dump
  -- cannot unsubscribe anybody is enforced by the database rather than by review.
  constraint newsletter_send_tokens_digest_shape
    check (token_digest ~ '^[0-9a-f]{64}$')
);

comment on table public.newsletter_send_tokens is
  'Every live unsubscribe token, as a sha256 digest, one row per token (GV-441). Replaces the single rotating newsletter_subscribers.unsubscribe_token_hash column, which meant only the NEWEST mail carried a working link: an older newsletter''s link matched nothing, and the endpoint''s deliberate anti-enumeration silence then told an active subscriber their address had been deleted when it had not. Accumulating rows instead means every mail we ever sent carries a link that still works. ON DELETE CASCADE from the subscriber is the retention rule and the security argument at once -- unsubscribing hard-deletes the row and takes every token with it, so a leaked mint result set dies the first time any of its tokens is used, and no token can outlive the address it belonged to. Raw tokens are still never stored. RLS on, no policy, every grant revoked including service_role, exactly like the two tables it sits between.';
comment on column public.newsletter_send_tokens.subscriber_id is
  'Whose link this is. ON DELETE CASCADE: the unsubscribe DELETE removes every token in the same statement, which is what keeps this table from becoming the tombstone migration 161 refused to keep.';
comment on column public.newsletter_send_tokens.token_digest is
  'sha256 hex of the raw unsubscribe token that went out in a mail. Unique across the whole table, so a digest identifies at most one subscriber. The raw token exists only in that mail and in the URL the recipient clicks -- never here.';
comment on column public.newsletter_send_tokens.created_at is
  'When the token was issued. The only thing the 24-month prune reads, and the only sense in which this table remembers anything about a send.';

-- The unsubscribe lookup is by digest and the unique constraint already indexes it. This
-- one is for the prune, which is the only other way anybody reads the table.
create index if not exists newsletter_send_tokens_created_at_idx
  on public.newsletter_send_tokens (created_at);
-- Cascading a subscriber delete without this is a sequential scan of every token in the
-- table, on the one operation that must never be slow enough to time out.
create index if not exists newsletter_send_tokens_subscriber_id_idx
  on public.newsletter_send_tokens (subscriber_id);

alter table public.newsletter_send_tokens enable row level security;
revoke all on public.newsletter_send_tokens from public;
revoke all on public.newsletter_send_tokens from anon;
revoke all on public.newsletter_send_tokens from authenticated;
-- service_role too, for migration 161's reason applied one table over: the Pages
-- Functions hold that key, and a table of live unsubscribe digests is not something the
-- code that mails the newsletter needs to query. It calls the RPCs.
revoke all on public.newsletter_send_tokens from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Mint the send                                                       (GV-441)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared COMPLETELY off migration 173's definition, which is its newest: same
-- signature, same return shape, same validation, same service_role-only grants, same
-- confirmed-only predicate. The one change is where the digest goes -- an INSERT of a new
-- row rather than an UPDATE over the old one -- and that is the whole of GV-441 at this
-- end.
--
-- 173's ATOMICITY PROPERTY IS PRESERVED IN THE NEW SHAPE, and it is worth restating
-- because the shape moved. It is still ONE statement. The token is generated in `fresh`,
-- which is MATERIALIZED explicitly: gen_random_bytes is volatile and would already block
-- inlining, but "the planner happens not to inline this" is not a property to rest a
-- token on, since an inlined CTE would evaluate the random expression twice and store the
-- digest of a token the caller never receives. `minted` inserts the digests and returns
-- the rows it actually wrote, and the final select JOINS those rows back to `fresh` --
-- so an address is handed out only when its digest is on disk, and a digest is written
-- only for an address that is being handed out with its raw token in the same result
-- set. Neither half can happen without the other, which is the guarantee: no subscriber
-- ends a send holding a link that matches nothing, and no digest exists that nobody
-- holds the token for.
--
-- `logged` is a data-modifying CTE that the final select does not read. Postgres executes
-- those exactly once and to completion regardless, so the counts-only audit row is
-- written in the same statement as the mint: no path hands out addresses without
-- recording that it happened, and none records a send that did not happen.
--
-- The prune is a SEPARATE statement on purpose. It is retention, not correctness, and
-- folding it into the mint would put a DELETE in the statement whose atomicity the
-- paragraphs above are about. It runs after, so a subscriber whose only token was old
-- already holds a fresh one before anything is removed.

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
    insert into public.newsletter_send_tokens (subscriber_id, token_digest)
    select f.subscriber_id, encode(extensions.digest(f.raw_token, 'sha256'), 'hex')
    from fresh f
    returning subscriber_id
  ),
  logged as (
    insert into public.newsletter_send_log (operator_email, headline, recipient_count)
    select v_operator, v_headline, count(*) from minted
  )
  select f.subscriber_email, f.raw_token
  from minted m
  join fresh f on f.subscriber_id = m.subscriber_id;

  -- Retention, opportunistic and global rather than scoped to one subscriber, for
  -- migration 161's reason: a sweep that only tidies the row in front of it depends on
  -- that particular person coming back. Every confirmed subscriber was just handed a
  -- token by the statement above, so nobody can be left without a working link by this.
  delete from public.newsletter_send_tokens st
  where st.created_at < now() - interval '24 months';
end;
$$;

revoke all on function public.mint_newsletter_send_tokens(text, text) from public;
revoke all on function public.mint_newsletter_send_tokens(text, text) from anon;
revoke all on function public.mint_newsletter_send_tokens(text, text) from authenticated;
grant execute on function public.mint_newsletter_send_tokens(text, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Unsubscribe                                                         (GV-441)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared completely off migration 161's definition, which is its newest. Everything
-- about it is unchanged except the lookup: the digest is matched in newsletter_send_tokens
-- instead of on the subscriber row, and the subscriber that token belongs to is deleted.
-- The cascade removes their remaining tokens, so the other links in their inbox stop
-- working at the same instant -- which is right, because there is no longer an address to
-- take off the list.
--
-- 'unknown' is still RETURNED rather than raised for a digest that matches nothing, and
-- the caller still renders the same goodbye page either way. That silence is what stops
-- the URL being a token oracle, and it is also exactly what made the pre-GV-441 bug
-- invisible -- which is an argument for making old links work, not for making the
-- endpoint chattier.

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
  where ns.id in (
    select st.subscriber_id
    from public.newsletter_send_tokens st
    where st.token_digest = v_unsubscribe
  )
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Request a subscription                                              (GV-441)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Re-declared completely off migration 161's definition, which is its newest. The
-- signature is byte-identical -- five arguments, same names, same order, same default --
-- so govehlo-web's POST /api/newsletter/subscribe is unaffected; `unsubscribe_hash` is
-- still the parameter it passes, it simply lands in the token table now that the column
-- it used to land in is gone.
--
-- Everything else is 161 unchanged: the same validation, the same opportunistic expiry
-- sweep over EVERY pending row, the same already_confirmed / send_mail decision made by
-- the database because the endpoint must render one reassurance either way and therefore
-- cannot be allowed to know.
--
-- The one behavioural change is stated in the header: a re-submitted pending address ADDS
-- an unsubscribe token instead of replacing one, so the older confirmation mail's
-- unsubscribe link keeps working. The CONFIRM token is still replaced, so the older
-- confirm link still stops working -- single-use means single-use, and only unsubscribe
-- links are promised to be forever.

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
  v_subscriber_id uuid;
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
  -- not depend on that particular person returning to be removed. The cascade takes
  -- their unsubscribe tokens with them.
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
        confirm_token_hash = v_confirm
    where ns.id = v_existing_id;
    v_subscriber_id := v_existing_id;
  else
    insert into public.newsletter_subscribers (
      email, consent_text_version, confirm_token_hash
    ) values (
      v_email, v_version, v_confirm
    )
    returning id into v_subscriber_id;
  end if;

  -- The unsubscribe link at the foot of the confirmation mail. Registered rather than
  -- assigned, so a re-submitted address ends up with two working links instead of one
  -- working and one that silently does nothing -- which is the whole of GV-441.
  insert into public.newsletter_send_tokens (subscriber_id, token_digest)
  values (v_subscriber_id, v_unsubscribe);

  return jsonb_build_object('status', 'pending', 'send_mail', true);
end;
$$;

revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from public;
revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from anon;
revoke all on function public.newsletter_request_subscription(text, text, text, text, integer) from authenticated;
grant execute on function public.newsletter_request_subscription(text, text, text, text, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Carry the existing digests across, then drop the column             (GV-441)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The seed is what stops this migration from being the very bug it fixes. Every
-- subscriber on the list today holds exactly one live unsubscribe link -- from the last
-- send, or from their confirmation mail if no send has reached them yet -- and its digest
-- is in the column about to disappear. Copying it over first means nobody's link breaks
-- at the moment the migration is applied.
--
-- Wrapped in a guard on the column's existence, and executed dynamically, for two
-- reasons. Re-running the whole file in the SQL editor must be safe (migrations here are
-- applied by hand, and a half-applied script is a real thing that happens), and a
-- statement naming a dropped column fails at PARSE time -- so the second run would error
-- before reaching anything, even inside an `if` that is false. Dynamic SQL defers the
-- name resolution to the branch that actually runs.
--
-- On a fresh install replaying the consolidated schema there are zero rows to seed, which
-- is exactly as correct: the migration path and the fresh-install path both end with the
-- column gone and the token table holding whatever the list held.

do $seed$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'newsletter_subscribers'
      and column_name = 'unsubscribe_token_hash'
  ) then
    execute $seed_sql$
      insert into public.newsletter_send_tokens (subscriber_id, token_digest)
      select ns.id, ns.unsubscribe_token_hash
      from public.newsletter_subscribers ns
      where ns.unsubscribe_token_hash is not null
      on conflict (token_digest) do nothing
    $seed_sql$;

    -- The column, its not-null, its sha256-hex check constraint and its unique index all
    -- go together -- Postgres drops the dependent constraint and index with the column.
    -- Nothing reads it after section 3 and nothing writes it after section 4, which is
    -- the condition this drop was waiting on.
    execute 'alter table public.newsletter_subscribers drop column unsubscribe_token_hash';
  end if;
end;
$seed$;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '175_per_send_unsubscribe_tokens',
  'GV-441: unsubscribe links from EVERY newsletter we ever sent keep working, not only the newest one. THE BUG: migration 173 mints a fresh unsubscribe token per recipient at each send and stores its digest OVER the previous one in a single column on the subscriber row (161 keeps the digest only, never the raw token, so that column can hold exactly one live link), while govehlo-web''s unsubscribe endpoint deliberately renders the same goodbye page whether or not the RPC matched anything -- an already-deleted row and a wrong token are the same fact from the reader''s side, and distinguishing them would make the URL a token oracle. Combined, an active subscriber who clicks the unsubscribe link in an OLDER newsletter is told "Din adresse er vaek" while remaining fully subscribed, and keeps receiving mail. That is not a dead link, which would merely be a nuisance; it is an opt-out that reports success and does nothing, i.e. markedsfoeringsloven paragraph 10 inverted and article 17 answered with a lie. The endpoint''s silence is load-bearing, so the fix has to be in the database and it has to be "the old token still works" rather than "the old token fails honestly". THE FIX: public.newsletter_send_tokens (id, subscriber_id uuid not null references newsletter_subscribers(id) ON DELETE CASCADE, token_digest text not null unique with 161''s ^[0-9a-f]{64}$ shape check, created_at), one row per issued token instead of one column per subscriber. A send INSERTS a row per recipient rather than overwriting theirs, so every historical link stays live; unsubscribing deletes the subscriber and the cascade takes every token with it, so the whole set dies at once. 173''S ROTATION RATIONALE SURVIVES INTACT rather than being reversed: it was never "old links should stop working" as a goal, it was that a token which never rotates is one that leaks once and works forever -- and under this design a leaked mint result set still dies with the subscriber row, since the first click on any of its tokens deletes the subscriber and cascades away the rest, buying the attacker one unsubscribe of somebody who wanted to leave anyway. Raw tokens are STILL never stored, only sha256 digests under the same check constraint, so 161''s promise that a database dump cannot unsubscribe anybody is unchanged. THE OLD COLUMN newsletter_subscribers.unsubscribe_token_hash IS DROPPED, and it was not dead code: 161''s newsletter_request_subscription writes it from the hash the signup endpoint computes, and that token backs the unsubscribe link at the foot of the CONFIRMATION mail -- the link that lets somebody whose address a stranger typed into the form remove it at once instead of waiting out the 7-day expiry. Moving the lookup while leaving the column would have broken precisely that link for every new signup, written to a column nothing consults any more. So newsletter_request_subscription is re-declared to register its digest in the token table instead, every existing non-null digest is copied across by a seed guarded on the column''s existence and executed dynamically (re-running a hand-applied migration must be safe, and a statement naming a dropped column fails at PARSE time even inside a false branch), and only then is the column dropped with its not-null, its shape constraint and its unique index. ONE place now holds unsubscribe digests, which makes this class of bug impossible rather than fixed once. NO RPC SIGNATURE CHANGES: mint_newsletter_send_tokens(p_operator_email text, p_headline text) returns table(email text, unsubscribe_token text), newsletter_unsubscribe(unsubscribe_hash text) and newsletter_request_subscription(subscriber_email text, consent_version text, confirm_hash text, unsubscribe_hash text, pending_ttl_hours integer default 168) all keep their exact argument lists, so govehlo-web''s three newsletter endpoints are untouched, there is no PGRST202/203 hazard and no merge-order constraint against the web repo; unsubscribe_hash remains a PARAMETER name, only the column it used to land in is gone. 173''S ATOMICITY PROPERTY IS PRESERVED IN THE NEW SHAPE: the mint is still ONE statement, the token is still generated in an explicitly MATERIALIZED CTE (gen_random_bytes is volatile and would already block inlining, but an inlined CTE would evaluate the random expression twice and store the digest of a token the caller never receives), the INSERT returns the rows it actually wrote and the final select JOINS them back to that CTE -- so an address is handed out only when its digest is on disk and a digest is written only for an address being handed out with its raw token in the same result set -- and the counts-only audit row is still written by a data-modifying CTE the final select does not read, which Postgres executes exactly once regardless. A separate, later statement prunes tokens older than 24 months, opportunistically and globally for 161''s reason (a sweep that only tidies the row in front of it depends on that person coming back); it is separate on purpose, since retention is not correctness and a DELETE does not belong in the statement whose atomicity the above is about, and it runs AFTER the mint so every confirmed subscriber ends a send holding a token minted seconds ago. newsletter_unsubscribe now deletes the subscriber whose id appears in newsletter_send_tokens for the given digest and still RETURNS unknown rather than raising when nothing matches. ONE FURTHER BEHAVIOURAL CHANGE: re-submitting a live pending address now ADDS an unsubscribe token instead of replacing one, so the older confirmation mail''s unsubscribe link keeps working too -- the same rule applied to the same kind of link; the CONFIRM token is still replaced, so the older confirm link still stops working, because single-use means single-use and only unsubscribe links are promised to be forever. DELIBERATELY NOT TOUCHED: the double opt-in confirmation token (confirm_token_hash, its single-use check constraint and its clearing on confirmation are a different token solving a different problem, and it SHOULD stop working when used); newsletter_send_log, still counts only, no recipient column, deny-all including service_role; the list''s deny-all posture, the confirmed-only send predicate and the hard delete with no tombstone. GDPR: the token rows are pseudonymous digests but linkable through subscriber_id, so they are treated as personal data and given a lifetime rather than left to accumulate -- that lifetime IS the subscriber''s, by ON DELETE CASCADE, so no token can outlive the address it belonged to and the table cannot become the tombstone 161 refused to keep; capped at 24 months on top of that (article 5(1)(e), aligned with owner_activity_log''s window, since a three-year-old newsletter''s link is not an opt-out anybody relies on); no address, no name and no send history, so the table can answer "is this digest one of ours" and not "who did we mail" (5(1)(c), unchanged from 173); deny-all with RLS on and no policy, every grant revoked including service_role, so no code path can enumerate tokens any more than it can enumerate addresses. Documented in docs/gdpr/retention.md. No ledger_events are written (a send has no ledger, member or feed), so no event_type is introduced and the GV-413 classification guard does not apply. Pinned statically by tools/test-newsletter-consent-contract.mjs (the mint''s new insert-into-table shape with MATERIALIZED kept and no write to any subscriber digest column, the cascade FK, the digest shape check, the token table''s deny-all posture in the block and in a global sweep, and the unsubscribe RPC''s new lookup -- in the migration and the consolidated mirror alike) and behaviourally by tools/test-rls-role-matrix.mjs (anon/authenticated/service_role denied on the token table, two successive mints leaving BOTH tokens able to unsubscribe, the unsubscribe removing the subscriber and every token row by cascade, an unknown digest deleting nothing and returning the silent answer, and the confirmation mail''s own token still working after a send).'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 150: service-role RPCs so the push engine can keep emails and tokens out of URLs (GV-398)
--
-- Follow-up to GV-389. The web half of that ticket is closed in govehlo-web: the
-- broadcast path now reads (token, user_id) unfiltered, /api/owner/errors' ?email=
-- is gone, and test/pii-in-url.test.mjs guards the rule. Two call sites could not
-- move from the web repo alone, because the blocker is not the JavaScript — it is
-- PostgREST. A GET or a DELETE takes its filter in the query string and nowhere
-- else, so the only shape that carries the arguments in a request BODY is an RPC
-- (POST /rest/v1/rpc/<fn>). No suitable function existed: delete_push_token is
-- auth.uid()-scoped and the service role has no auth.uid().
--
-- The rule this serves is GDPR data minimisation in CLAUDE.md: a URL is written to
-- the Cloudflare edge log and to Supabase's gateway log, a POST body is not. Both
-- of the remaining values are personal data — an email obviously, and an Expo push
-- token because it identifies a device.
--
--   1. functions/api/_push.js resolveTokensWithMuteState
--      GET expo_push_tokens?email=in.("a@b.dk","c@d.dk")&select=token,user_id
--      Runs on EVERY ledger_events insert plus four scheduled reminder hooks, so
--      it is the highest-frequency writer of addresses into a request line in the
--      whole product. Recipients arrive as emails and there is no pseudonymous key
--      to filter on instead: ledger_members has no user_id column and the
--      claim_due_* engines return emails.
--
--   2. functions/api/_push.js pruneTokens
--      DELETE expo_push_tokens?token=in.("ExponentPushToken[…]")
--      Deleting by the owner's user_id instead is not merely a different shape, it
--      is wrong: a member with two devices would lose the live one alongside the
--      dead one and go silent until the app is next opened.
--
-- ── Why resolve_push_targets does NOT take a category ─────────────────────────────
-- GV-398 sketches resolve_push_targets(p_emails text[], p_category text) and notes
-- the mute/snooze/quiet filtering could move into the database too, while calling a
-- plain lookup RPC the acceptable minimum. This is the plain lookup, deliberately.
--
-- That filter (govehlo-web _push.js dropMutedTokens) serves TWO callers: the email
-- path fixed here, and the operator broadcast, which has no email list at all — its
-- recipient set is "every registered device". Implementing the filter in SQL for one
-- caller would fork it into two implementations that must agree about category mutes,
-- snooze windows and Europe/Copenhagen quiet hours forever, and drift between them
-- would be silent: the push simply would not arrive. The notification_preferences
-- lookup therefore stays in the web repo, where it is already covered by tests that
-- exercise mute/snooze/quiet outcomes end to end.
--
-- The category parameter goes with it. An accepted-and-ignored parameter is exactly
-- what migration 151 is removing next door (GV-400), so adding one here would be
-- writing the next cleanup ticket while closing this one. Adding the filter later is
-- a new function signature either way.
--
-- ── A silent-drop fix that comes along for free ────────────────────────────────────
-- resolve_push_targets lower-cases BOTH sides of the comparison. The URL path only
-- lower-cased its input, so a token row stored with a capitalised address
-- (upsert_push_token stores current_user_email() verbatim) never matched the in.()
-- list and its owner missed every targeted push. The broadcast path already had this
-- fixed in GV-389 by not filtering on email at all; this closes the same hole for the
-- targeted path.
--
-- ── Grants ────────────────────────────────────────────────────────────────────────
-- Both are service-role only, like the claim_due_* engine ops. The revokes name anon
-- and authenticated EXPLICITLY (migration 148): Supabase's project bootstrap runs
-- ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
-- service_role in schema public, so every new function is created with explicit anon
-- and authenticated entries in its ACL that a `revoke ... from public` does not touch.
--
-- Safe to rerun (create or replace; idempotent migration record).

-- ── resolve_push_targets: the targeted-recipient lookup, arguments in the body ─────
-- Returns one row per registered device for the given addresses. Same two columns the
-- URL select asked for and in the same order, so the caller's row shape is unchanged:
-- `token` for the send, `user_id` for the mute/snooze/quiet filter that stays in the
-- web repo. A NULL or empty array returns no rows — never every device.
create or replace function public.resolve_push_targets(p_emails text[])
returns table (token text, user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select ept.token, ept.user_id
  from public.expo_push_tokens ept
  where lower(ept.email) = any (
    select distinct lower(btrim(candidate))
    from unnest(coalesce(p_emails, array[]::text[])) as candidate
    where nullif(btrim(candidate), '') is not null
  );
$$;

revoke all on function public.resolve_push_targets(text[]) from public;
revoke all on function public.resolve_push_targets(text[]) from anon;
revoke all on function public.resolve_push_targets(text[]) from authenticated;
grant execute on function public.resolve_push_targets(text[]) to service_role;

-- ── prune_push_tokens: delete the devices Expo reported DeviceNotRegistered ────────
-- Returns the number of rows actually deleted. The URL DELETE returned nothing usable
-- (Prefer: return=minimal), so the caller could not tell a successful prune from a
-- silently mismatched token list; a count is free here and makes that observable
-- without logging a single token.
create or replace function public.prune_push_tokens(p_tokens text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.expo_push_tokens ept
  where ept.token = any (
    select distinct btrim(candidate)
    from unnest(coalesce(p_tokens, array[]::text[])) as candidate
    where nullif(btrim(candidate), '') is not null
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_push_tokens(text[]) from public;
revoke all on function public.prune_push_tokens(text[]) from anon;
revoke all on function public.prune_push_tokens(text[]) from authenticated;
grant execute on function public.prune_push_tokens(text[]) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '150_push_target_rpcs',
  'GV-398: two service-role-only RPCs so the push engine stops writing personal data into request lines. resolve_push_targets(text[]) returns (token, user_id) for a set of member addresses and prune_push_tokens(text[]) deletes the devices Expo reported DeviceNotRegistered, returning a count. Both replace a PostgREST query-string filter in govehlo-web functions/api/_push.js (resolveTokensWithMuteState''s GET expo_push_tokens?email=in.(...) and pruneTokens'' DELETE ?token=in.(...)) -- the last two sites GV-389 could not close, because a GET/DELETE filter only travels in the URL and the only body-carrying shape PostgREST offers is an RPC. A URL reaches the Cloudflare edge log and Supabase''s gateway log; a POST body does not. Deliberately a plain lookup with NO category parameter: the mute/snooze/quiet filter also serves the operator broadcast, which has no email list at all, so moving it into SQL for one caller would fork it into two implementations whose disagreement would be a silently undelivered push -- and an accepted-and-ignored parameter is exactly what migration 151 removes next door. resolve_push_targets also lower-cases BOTH sides of the address comparison, fixing a silent drop: upsert_push_token stores current_user_email() verbatim, so a capitalised address never matched the lower-cased in.() list and its owner missed every targeted push. Service-role only, with anon and authenticated revoked explicitly per migration 148.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

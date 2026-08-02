-- Migration 163: subscriber COUNTS for the admin Health page (GV-431)
--
-- The operator asked one question the deny-all design could not answer from any
-- surface but the SQL Editor: "how many people are on the newsletter list?"
-- newsletter_subscribers revokes every grant including service_role on purpose —
-- no code path may ENUMERATE the address list (migration 161) — but a count
-- enumerates nobody. This is exactly the decision the consent guard's
-- ALLOWED_FUNCTIONS allowlist exists for: a new function touching the table,
-- added deliberately, reviewed against the one property that matters. This one
-- returns two integers and nothing else; no parameter can widen it into a read.
--
--   confirmed  rows with confirmed_at set — the real, mailable list.
--   pending    rows still inside the double-opt-in window. Counted as-is: an
--              expired row that the signup-time sweep has not yet removed will
--              briefly inflate this number, which is the honest trade against
--              making a COUNT function also a DELETE path.
--
-- service_role only, like the three flow RPCs: the Pages Function behind the
-- dual-gated admin console is the single caller. No browser role can execute it,
-- so the numbers themselves stay operator-only.

create or replace function public.newsletter_subscriber_counts()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'confirmed', count(*) filter (where ns.confirmed_at is not null),
    'pending', count(*) filter (where ns.confirmed_at is null)
  )
  from public.newsletter_subscribers ns;
$$;

revoke all on function public.newsletter_subscriber_counts() from public;
revoke all on function public.newsletter_subscriber_counts() from anon;
revoke all on function public.newsletter_subscriber_counts() from authenticated;
grant execute on function public.newsletter_subscriber_counts() to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values (
  '163_newsletter_subscriber_counts',
  'Operator-only subscriber counts for the admin Health page (GV-431). newsletter_subscribers is deny-all including service_role so nothing can enumerate the address list (migration 161); the one question that posture could not answer anywhere but the SQL Editor is "how many?", and a count enumerates nobody. public.newsletter_subscriber_counts() returns jsonb {confirmed, pending} and nothing else — no parameters, so it can never be widened into a read of rows. confirmed is rows with confirmed_at set (the real, mailable list); pending counts every unconfirmed row as-is, accepting that an expired row the signup-time sweep has not yet removed briefly inflates the number rather than making a COUNT function double as a DELETE path. security definer with pinned search_path, revoked from public/anon/authenticated, granted to service_role only — the Pages Function behind the dual-gated admin console is the single caller. The function is added to ALLOWED_FUNCTIONS in tools/test-newsletter-consent-contract.mjs as the deliberate decision that allowlist exists to force.'
)
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 100: fix check_owner_rate_limit 42702 param/column ambiguity (GV-252)
--
-- The limiter RPC has thrown `42702 column reference "actor_email" is ambiguous`
-- on EVERY call since migration 049: the function parameter actor_email shadows
-- the owner_api_rate_limits column of the same name inside the INSERT's
-- `on conflict (actor_email, action, window_started_at)` index-inference list,
-- and PL/pgSQL refuses to guess. Verified in prod 2026-07-09:
-- owner_api_rate_limits has never held a single row. Fail-closed callers
-- (vehicle-registry GV-204, receipt-ocr GVM-237) therefore returned RATE_LIMITED
-- ("For mange forsog") on a user's FIRST attempt, while fail-open callers
-- (owner API GV-156, the GV-235 proxies) enforced no cap at all.
--
-- Fix: recreate the function (based on the 049 definition - the only prior
-- one; 083 only revoked public EXECUTE) with `#variable_conflict use_column`,
-- which makes column names win inside SQL statements. Parameter names are kept
-- exactly as-is because the Cloudflare Functions call this RPC with named JSON
-- parameters (actor_email / limit_action / max_attempts / window_seconds) -
-- renaming them would break that call contract.
--
-- Body audit under the pragma: the INSERT's conflict target now resolves to
-- columns (the fix). Every other name in SQL statements is either a declared
-- variable with no same-named column (safe_email, safe_action, safe_max,
-- safe_window, window_start, current_attempts), an explicitly qualified column
-- (public.owner_api_rate_limits.attempts), or a column-list position that never
-- underwent variable substitution. The final `return query select` reads only
-- variables with no FROM clause. Nothing else changes meaning.

create or replace function public.check_owner_rate_limit(
  actor_email text,
  limit_action text default 'owner.api',
  max_attempts integer default 60,
  window_seconds integer default 60
)
returns table (
  allowed boolean,
  attempts integer,
  limit_value integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  safe_email text := nullif(lower(btrim(coalesce(actor_email, ''))), '');
  safe_action text := coalesce(nullif(btrim(coalesce(limit_action, '')), ''), 'owner.api');
  safe_max integer := greatest(coalesce(max_attempts, 60), 1);
  safe_window integer := greatest(coalesce(window_seconds, 60), 1);
  window_start timestamptz;
  current_attempts integer;
begin
  if safe_email is null then
    raise exception 'actor_email is required for owner rate limiting' using errcode = 'P0001';
  end if;

  -- Fixed window aligned to safe_window-second boundaries from the epoch.
  window_start := to_timestamp(floor(extract(epoch from now()) / safe_window) * safe_window);

  insert into public.owner_api_rate_limits (actor_email, action, window_started_at, attempts, last_attempt_at)
  values (safe_email, safe_action, window_start, 1, now())
  on conflict (actor_email, action, window_started_at)
  do update set attempts = public.owner_api_rate_limits.attempts + 1,
               last_attempt_at = now()
  returning public.owner_api_rate_limits.attempts into current_attempts;

  return query
  select
    current_attempts <= safe_max,
    current_attempts,
    safe_max,
    greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => safe_window) - now())))::integer);
end;
$$;

revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from public;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.check_owner_rate_limit(text, text, integer, integer) from authenticated;
grant execute on function public.check_owner_rate_limit(text, text, integer, integer) to service_role;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('100_fix_rate_limit_ambiguity',
        'check_owner_rate_limit re-declared with #variable_conflict use_column: the actor_email parameter shadowed the column in the ON CONFLICT target, so the limiter threw 42702 on every call since 049 - fail-closed proxies blocked first attempts, fail-open callers enforced nothing (GV-252).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

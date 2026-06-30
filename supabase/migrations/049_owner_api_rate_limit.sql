-- Migration 049: Rate-limit the operator (owner) API (GV-156).
--
-- The /api/owner/* Cloudflare Pages Functions are single-operator and already
-- gated to the APP_OWNER_EMAILS allow-list, so the abuse surface is essentially
-- a compromised owner token. This adds a per-operator throttle to cap exactly
-- that: a stolen token cannot hammer the cross-workspace read endpoints.
--
-- Why not enforce_onboarding_rate_limit (migration 030): that limiter derives
-- the actor from the user JWT via current_user_email(), so it is unusable from
-- the service-role Pages Function context. This one takes the actor email as an
-- explicit parameter and is callable by the service role.
--
-- The function RETURNS the decision (it does not raise) so the Pages Function
-- can shape a 429 with a Retry-After header. Safe to rerun.

create table if not exists public.owner_api_rate_limits (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  action text not null default 'owner.api',
  window_started_at timestamptz not null,
  attempts integer not null default 1 check (attempts > 0),
  last_attempt_at timestamptz not null default now(),
  unique (actor_email, action, window_started_at)
);

comment on table public.owner_api_rate_limits is
  'Per-operator fixed-window request counts for the owner API (GV-156). Service-role only; rows are ephemeral throttle state, not an audit trail (see owner_activity_log for auditing).';

create index if not exists owner_api_rate_limits_actor_idx
  on public.owner_api_rate_limits (actor_email, action, window_started_at desc);

alter table public.owner_api_rate_limits enable row level security;

-- No browser-side policy is added intentionally, mirroring owner_activity_log:
-- only the service role (via the Pages Function) ever touches this table.
revoke all on public.owner_api_rate_limits from public;
revoke all on public.owner_api_rate_limits from anon;
revoke all on public.owner_api_rate_limits from authenticated;

-- Param-based limiter callable by the service role. Atomic increment via upsert
-- on the (actor, action, window) unique key; returns whether the call is allowed
-- plus the seconds until the window resets so the caller can set Retry-After.
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
values ('049_owner_api_rate_limit', 'Service-role-callable per-operator rate limiter for the owner API /api/owner/* (GV-156).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

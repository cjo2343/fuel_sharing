-- Migration 041: Add server-owned owner activity log.
-- Creates an app-owner support/audit table populated by Render backend routes so
-- the owner can inspect safe cross-user/cross-workspace activity without relying
-- on browser-local Data I/O from the owner's session. Safe to rerun.

create table if not exists public.owner_activity_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ledger_id text not null references public.ledgers(id) on delete cascade,
  workspace_label text not null default '',
  actor_user_id uuid,
  actor_email text,
  actor_member_id uuid references public.ledger_members(id) on delete set null,
  actor_role text not null default 'member' check (actor_role in ('member', 'admin', 'owner', 'system')),
  route text not null default '',
  action text not null default '',
  result_code text not null default '',
  status_code integer not null default 200,
  duration_ms integer,
  ok boolean not null default true,
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb
);

comment on table public.owner_activity_log is
  'Server-owned owner-only activity ledger for safe cross-user/cross-workspace backend support diagnostics.';
comment on column public.owner_activity_log.metadata is
  'Small redacted JSON payload. Do not store provider secrets, auth tokens, cookies, VINs, or raw request bodies.';

create index if not exists owner_activity_log_created_at_idx
  on public.owner_activity_log (created_at desc);
create index if not exists owner_activity_log_ledger_created_at_idx
  on public.owner_activity_log (ledger_id, created_at desc);
create index if not exists owner_activity_log_actor_email_created_at_idx
  on public.owner_activity_log (lower(actor_email), created_at desc)
  where actor_email is not null;
create index if not exists owner_activity_log_action_created_at_idx
  on public.owner_activity_log (action, created_at desc);
create index if not exists owner_activity_log_ok_created_at_idx
  on public.owner_activity_log (ok, created_at desc);

alter table public.owner_activity_log enable row level security;
revoke all on public.owner_activity_log from public;
revoke all on public.owner_activity_log from anon;
revoke all on public.owner_activity_log from authenticated;

-- No browser-side access policy is added intentionally. Render writes and reads
-- this table with the service role after verifying the configured app owner on
-- /api/owner/activity. Workspace users/admins keep normal workspace audit only.

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('041_owner_activity_log', 'Server-owned owner-only cross-workspace activity log for Render backend actions.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

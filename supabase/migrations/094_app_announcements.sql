-- Migration 094: operator-managed announcements table + RLS (GV-181)
--
-- The Home announcement banner (GVM-120) is served inside /app-config.json. Today
-- that file is static and edited by a git commit + Cloudflare deploy. This table lets
-- a non-technical operator publish/clear an announcement from the admin console without
-- a deploy. The /app-config.json Cloudflare Function reads the current active row and
-- injects it; the SAFETY gate (minSupportedVersion/killSwitch) stays static, so this
-- table only ever drives the low-risk, non-blocking banner.
--
-- Access model: writes are operator-only and go through the admin console's service-
-- role owner endpoints (which bypass RLS). No insert/update/delete policy is defined,
-- so with RLS enabled every non-service role is denied writes by default. The single
-- read policy exposes only currently-active rows to authenticated clients.

create table if not exists public.app_announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  url text,
  variant text not null default 'info' check (variant in ('info', 'warning', 'success')),
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);

comment on table public.app_announcements is
  'Operator-managed Home announcement banners surfaced via /app-config.json (GV-181). Writes are service-role only (admin console); authenticated clients may read only currently-active rows.';

-- Most-recent active row lookup, used by the /app-config.json Function.
create index if not exists app_announcements_active_idx
  on public.app_announcements (active, created_at desc);

alter table public.app_announcements enable row level security;

-- Authenticated clients may read only announcements that are active AND within their
-- optional schedule window. Writes have no policy → service-role only (admin console).
drop policy if exists "Authenticated read active announcements" on public.app_announcements;
create policy "Authenticated read active announcements" on public.app_announcements
  for select to authenticated
  using (
    active = true
    and (starts_at is null or starts_at <= now())
    and (expires_at is null or expires_at > now())
  );

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('094_app_announcements',
        'Operator-managed announcements table + RLS (GV-181) — Home banner served via /app-config.json; service-role writes, authenticated read active-only.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

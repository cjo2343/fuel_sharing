-- Migration 080: scheduled close-period reminder (GVM-60, part 2)
--
-- The in-app nudge banner only fires when an admin opens Settle. The real failure
-- mode is a FORGOTTEN period — nobody opens the app. This adds the schema for a
-- scheduled push (a daily Cloudflare endpoint hits claim_due_close_reminders and
-- notifies admins of periods left open past ~a month, re-nudging weekly until the
-- period is closed). Never auto-closes — the push just points the admin at Settle.
--
-- Also adds a per-workspace on/off switch (default on) with a self-contained admin
-- RPC, so we don't have to re-declare update_ledger_settings and juggle overloads.

-- ── Schema ──────────────────────────────────────────────────────────────────────
alter table public.ledgers
  add column if not exists close_reminder_enabled boolean not null default true;

alter table public.settlement_periods
  add column if not exists last_close_reminder_at timestamptz;

-- ── set_close_reminder_enabled: admin toggles the workspace switch ───────────────
create or replace function public.set_close_reminder_enabled(
  target_ledger_id text,
  enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_ledger_id is null or target_ledger_id = '' then
    raise exception 'Missing ledger id' using errcode = '22023';
  end if;

  if not public.is_ledger_admin(target_ledger_id) then
    raise exception 'Only ledger admins can change reminder settings.' using errcode = '42501';
  end if;

  update public.ledgers l
  set close_reminder_enabled = coalesce(enabled, true),
      updated_at = now()
  where l.id = target_ledger_id;
end;
$$;

revoke all on function public.set_close_reminder_enabled(text, boolean) from public;
revoke all on function public.set_close_reminder_enabled(text, boolean) from anon;
grant execute on function public.set_close_reminder_enabled(text, boolean) to authenticated;

-- ── claim_due_close_reminders: engine op for the scheduled push ──────────────────
-- Atomically claims open periods that are past the ~1-month cadence and either never
-- reminded or last reminded ≥7 days ago, stamping last_close_reminder_at so overlapping
-- runs can't double-send (increment-on-claim → a push failure under-reminds, never
-- spams). Returns each claimed period with its workspace's active admin emails, which
-- the caller resolves to push tokens. Service-role only — not client-callable.
create or replace function public.claim_due_close_reminders(
  batch_limit integer default 200
)
returns table (period_id uuid, ledger_id text, label text, admin_emails text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with target as (
    select sp.id
    from public.settlement_periods sp
    join public.ledgers l on l.id = sp.ledger_id
    where sp.status = 'open'
      and l.close_reminder_enabled = true
      and sp.opened_at <= now() - interval '30 days'
      and (sp.last_close_reminder_at is null
           or sp.last_close_reminder_at <= now() - interval '7 days')
    order by sp.opened_at
    limit greatest(coalesce(batch_limit, 200), 0)
  ),
  claimed as (
    update public.settlement_periods sp
    set last_close_reminder_at = now(),
        updated_at = now()
    from target t
    where sp.id = t.id
    returning sp.id as period_id, sp.ledger_id as ledger_id, sp.label as label
  )
  select c.period_id,
         c.ledger_id,
         c.label,
         coalesce(
           array_agg(lower(lm.email)) filter (where lm.email is not null),
           array[]::text[]
         ) as admin_emails
  from claimed c
  left join public.ledger_members lm
    on lm.ledger_id = c.ledger_id
   and lm.role = 'admin'
   and lm.is_active = true
   and lm.email is not null
  group by c.period_id, c.ledger_id, c.label;
end;
$$;

revoke all on function public.claim_due_close_reminders(integer) from public;
revoke all on function public.claim_due_close_reminders(integer) from anon;
revoke all on function public.claim_due_close_reminders(integer) from authenticated;
grant execute on function public.claim_due_close_reminders(integer) to service_role;

-- ── Register migration ──────────────────────────────────────────────────────────
insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('080_close_reminder_push',
        'Scheduled close-period reminder: close_reminder_enabled + claim_due_close_reminders (GVM-60).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

-- Migration 095: per-user notification preferences + RPCs (GVM-119)
--
-- Per-event-type push toggles. Push tokens (migration 057) are per-user, so prefs
-- are too — one row per auth user, applied across every workspace they belong to.
-- Three coarse categories cover the four push hooks in govehlo-web:
--   activity → trips, fuel, bookings logged by others (ledger-event hook)
--   payments → payment requests, reminders, settlement confirmations
--   periods  → close-period reminders
-- Default all-on: a user with no row (or a null column) is notified. The push hooks
-- read this table with the service role (bypassing RLS) and drop a recipient's token
-- for a category they've turned off. No FK to auth.users — matching expo_push_tokens
-- (057), since the schema-equivalence harness has no auth schema. The row holds no
-- PII (three booleans + a uuid); purging it on account deletion is a follow-up.

create table if not exists public.notification_preferences (
  user_id uuid primary key,
  activity_enabled boolean not null default true,
  payments_enabled boolean not null default true,
  periods_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.notification_preferences is
  'Per-user push notification toggles (GVM-119). Three categories (activity/payments/periods), default all-on. Read by the govehlo-web push hooks (service role) to skip a recipient who has muted a category.';

alter table public.notification_preferences enable row level security;

drop policy if exists "Users manage own notification preferences" on public.notification_preferences;
create policy "Users manage own notification preferences" on public.notification_preferences
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Read the current user's prefs, defaulting every category to enabled when no row
-- exists yet (the all-on default).
create or replace function public.get_notification_preferences()
returns table (activity_enabled boolean, payments_enabled boolean, periods_enabled boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(np.activity_enabled, true),
    coalesce(np.payments_enabled, true),
    coalesce(np.periods_enabled, true)
  from (select auth.uid() as uid) me
  left join public.notification_preferences np on np.user_id = me.uid;
$$;

revoke all on function public.get_notification_preferences() from public;
grant execute on function public.get_notification_preferences() to authenticated;

-- Upsert the current user's prefs. Null args coalesce to enabled.
create or replace function public.set_notification_preferences(
  activity boolean,
  payments boolean,
  periods boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Notification preferences require a signed-in user' using errcode = '42501';
  end if;
  insert into public.notification_preferences (user_id, activity_enabled, payments_enabled, periods_enabled, updated_at)
  values (v_uid, coalesce(activity, true), coalesce(payments, true), coalesce(periods, true), now())
  on conflict (user_id) do update
  set activity_enabled = excluded.activity_enabled,
      payments_enabled = excluded.payments_enabled,
      periods_enabled = excluded.periods_enabled,
      updated_at = now();
end;
$$;

revoke all on function public.set_notification_preferences(boolean, boolean, boolean) from public;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('095_notification_preferences',
        'Per-user notification preferences table + get/set RPCs (GVM-119) — 3 categories (activity/payments/periods), default all-on; push hooks filter recipients.')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

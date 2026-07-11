-- Migration 109: notification snooze + quiet hours (GVM-286)
--
-- Two per-user push controls layered on top of the migration 095 category toggles:
--   snooze_until — a one-shot pause; while now() < snooze_until every push category
--                  is suppressed. Null means not snoozed. The client computes the
--                  timestamp ("resten af i dag" = next local midnight; "3 dage" =
--                  now + 72h); the server only validates it is null-or-future and no
--                  more than 30 days out.
--   quiet hours  — a recurring nightly window [quiet_start_hour, quiet_end_hour) in
--                  which every push category is suppressed. start > end crosses
--                  midnight (default 22 → 7). Equal start/end with enabled=true is
--                  rejected.
--
-- TIMEZONE IS FIXED Europe/Copenhagen. GoVehlo is a Danish-only product; the quiet
-- window's hours are always interpreted in Copenhagen local time. The govehlo-web
-- push filter computes the current Copenhagen hour and applies the same window; this
-- migration only stores the raw hours (0..23) and does no timezone math itself.
--
-- Both controls apply to ALL push categories and are enforced by the govehlo-web push
-- hooks (service role): instant sends drop the recipient's tokens silently; scheduled
-- reminder hooks defer (release the lease, retry on a later run) rather than burning a
-- reminder slot. Migration 096's delete_my_account already purges
-- notification_preferences rows, so these columns need no GDPR follow-up (same row).

alter table public.notification_preferences
  add column if not exists snooze_until timestamptz,
  add column if not exists quiet_hours_enabled boolean not null default false,
  add column if not exists quiet_start_hour smallint not null default 22,
  add column if not exists quiet_end_hour smallint not null default 7;

alter table public.notification_preferences
  drop constraint if exists notification_preferences_quiet_start_hour_check;
alter table public.notification_preferences
  add constraint notification_preferences_quiet_start_hour_check
  check (quiet_start_hour >= 0 and quiet_start_hour <= 23);

alter table public.notification_preferences
  drop constraint if exists notification_preferences_quiet_end_hour_check;
alter table public.notification_preferences
  add constraint notification_preferences_quiet_end_hour_check
  check (quiet_end_hour >= 0 and quiet_end_hour <= 23);

comment on table public.notification_preferences is
  'Per-user push notification controls. Three category toggles (activity/payments/periods, GVM-119, default all-on) plus snooze_until (one-shot pause) and quiet hours (recurring nightly window, Europe/Copenhagen, default 22->7, GVM-286). Read by the govehlo-web push hooks (service role) to skip a recipient who has muted a category, is snoozed, or is inside their quiet window.';

-- get_notification_preferences: return type changes (adds snooze + quiet columns), so
-- drop and recreate. Re-declared off migration 095 (the newest prior definition). A
-- missing row still defaults every category on, snooze null, quiet disabled at 22->7.
drop function if exists public.get_notification_preferences();
create function public.get_notification_preferences()
returns table (
  activity_enabled boolean,
  payments_enabled boolean,
  periods_enabled boolean,
  snooze_until timestamptz,
  quiet_hours_enabled boolean,
  quiet_start_hour smallint,
  quiet_end_hour smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(np.activity_enabled, true),
    coalesce(np.payments_enabled, true),
    coalesce(np.periods_enabled, true),
    np.snooze_until,
    coalesce(np.quiet_hours_enabled, false),
    coalesce(np.quiet_start_hour, 22::smallint),
    coalesce(np.quiet_end_hour, 7::smallint)
  from (select auth.uid() as uid) me
  left join public.notification_preferences np on np.user_id = me.uid;
$$;

revoke all on function public.get_notification_preferences() from public;
grant execute on function public.get_notification_preferences() to authenticated;

-- set_notification_preferences: signature changes (adds trailing snooze + quiet
-- params), so drop the (boolean,boolean,boolean) version and recreate. Re-declared off
-- migration 095. Params are suffixed *_value so they never collide with the columns of
-- the same name (PL/pgSQL ON CONFLICT shadowing guard).
drop function if exists public.set_notification_preferences(boolean, boolean, boolean);
create function public.set_notification_preferences(
  activity boolean,
  payments boolean,
  periods boolean,
  snooze_until_value timestamptz default null,
  quiet_hours_enabled_value boolean default false,
  quiet_start_hour_value smallint default 22,
  quiet_end_hour_value smallint default 7
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
  if quiet_start_hour_value is null or quiet_start_hour_value < 0 or quiet_start_hour_value > 23 then
    raise exception 'quiet_start_hour must be between 0 and 23' using errcode = '22023';
  end if;
  if quiet_end_hour_value is null or quiet_end_hour_value < 0 or quiet_end_hour_value > 23 then
    raise exception 'quiet_end_hour must be between 0 and 23' using errcode = '22023';
  end if;
  if coalesce(quiet_hours_enabled_value, false) and quiet_start_hour_value = quiet_end_hour_value then
    raise exception 'quiet hours start and end must differ when enabled' using errcode = '22023';
  end if;
  if snooze_until_value is not null
     and (snooze_until_value <= now() - interval '1 minute'
          or snooze_until_value > now() + interval '30 days') then
    raise exception 'snooze_until must be in the future and at most 30 days out' using errcode = '22023';
  end if;
  insert into public.notification_preferences (
    user_id, activity_enabled, payments_enabled, periods_enabled,
    snooze_until, quiet_hours_enabled, quiet_start_hour, quiet_end_hour, updated_at
  )
  values (
    v_uid,
    coalesce(activity, true),
    coalesce(payments, true),
    coalesce(periods, true),
    snooze_until_value,
    coalesce(quiet_hours_enabled_value, false),
    quiet_start_hour_value,
    quiet_end_hour_value,
    now()
  )
  on conflict (user_id) do update
  set activity_enabled = excluded.activity_enabled,
      payments_enabled = excluded.payments_enabled,
      periods_enabled = excluded.periods_enabled,
      snooze_until = excluded.snooze_until,
      quiet_hours_enabled = excluded.quiet_hours_enabled,
      quiet_start_hour = excluded.quiet_start_hour,
      quiet_end_hour = excluded.quiet_end_hour,
      updated_at = now();
end;
$$;

revoke all on function public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint) from public;
grant execute on function public.set_notification_preferences(boolean, boolean, boolean, timestamptz, boolean, smallint, smallint) to authenticated;

insert into public.fuel_ledger_schema_migrations (migration_id, description)
values ('109_notification_snooze_quiet_hours',
        'Notification snooze + quiet hours (GVM-286) — notification_preferences gains snooze_until (one-shot pause) + quiet_hours_enabled/quiet_start_hour/quiet_end_hour (recurring nightly window, Europe/Copenhagen, default 22->7, hours 0..23). get/set RPCs re-declared off 095 with the new columns/params; set validates hours, enabled start<>end, and snooze null-or-future <=30 days. Both controls suppress ALL push categories in the govehlo-web hooks (instant drop, scheduled defer).')
on conflict (migration_id) do update
set description = excluded.description,
    applied_at = now();

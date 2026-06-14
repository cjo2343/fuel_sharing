-- Migration 008: scheduled reminder service-role RPCs.

-- Scheduled backend reminder helpers.
-- These RPC functions are called by the Render cron endpoint with the service-role key.
-- They let the backend process the same Supabase production JSON mirror used by the app,
-- instead of scanning Render's local ledger-data.json file.
create or replace function public.scheduled_reminder_state(p_ledger_id text default 'main-car')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'ledger_id', id,
    'state', state,
    'updated_at', updated_at
  ) into result
  from public.car_share_ledgers
  where id = p_ledger_id;

  return coalesce(result, jsonb_build_object(
    'ledger_id', p_ledger_id,
    'state', null,
    'updated_at', null
  ));
end;
$$;

create or replace function public.save_scheduled_reminder_state(p_ledger_id text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  insert into public.car_share_ledgers (id, state, updated_at)
  values (p_ledger_id, coalesce(p_state, '{}'::jsonb), now())
  on conflict (id) do update set
    state = excluded.state,
    updated_at = excluded.updated_at
  returning jsonb_build_object(
    'ledger_id', id,
    'updated_at', updated_at
  ) into result;

  return result;
end;
$$;

-- Post-run setup check:
-- select name, email, role, is_active from ledger_members where ledger_id = 'main-car' order by name;

-- Scheduled reminder RPCs must not be executable by normal client roles.
-- The Render reminder endpoint calls them with the Supabase service-role key.
revoke all on function public.scheduled_reminder_state(text) from public;
revoke all on function public.scheduled_reminder_state(text) from anon;
revoke all on function public.scheduled_reminder_state(text) from authenticated;
grant execute on function public.scheduled_reminder_state(text) to service_role;

revoke all on function public.save_scheduled_reminder_state(text, jsonb) from public;
revoke all on function public.save_scheduled_reminder_state(text, jsonb) from anon;
revoke all on function public.save_scheduled_reminder_state(text, jsonb) from authenticated;
grant execute on function public.save_scheduled_reminder_state(text, jsonb) to service_role;

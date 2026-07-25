#!/bin/bash
# Functional regression test for migration 146's syn acknowledgement (GVM-442).
#
# Home's syn_due item had no dismissal, so a booked inspection went on nagging the
# whole group until the date passed. acknowledge_inspection_booking is the way to
# say "handled" for the WHOLE workspace. Structural checks (schema-equivalence)
# prove it EXISTS; only a replay proves it BEHAVES — that it stamps the marker, that
# ANY member (not just an admin) may call it, that the acknowledgement names its date
# and therefore self-invalidates when the next inspection date arrives, that it
# refuses a date that is not the live one, that a replay writes no second event, that
# it can be cleared again, and that every path writes the ledger_events row the other
# members' devices live-sync on.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-syn-ack-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the syn-acknowledgement functional test." >&2
  exit 1
fi

# Keep in step with the canonical IMAGE constant in tools/lib/replay-container.mjs
# (shell can't import it). Prod Supabase runs Postgres 17.x — GV-314.
docker run -d --name "${C}" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$REPO":/repo:ro postgres:17-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "${C}" pg_isready -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Postgres did not become ready within 60s." >&2
  exit 1
fi
sleep 2

PSQL() { docker exec -i "${C}" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

PSQL <<'SQL'
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.jwt() returns jsonb
language sql stable
as 'select nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb';
create or replace function auth.uid() returns uuid
language sql stable
as 'select nullif(auth.jwt() ->> ''sub'', '''')::uuid';
create publication supabase_realtime;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
SQL

PSQL -f /repo/supabase-schema.sql >/dev/null

PSQL <<'SQL'
-- Two workspaces: one with a syn date coming up, one with no syn date at all.
-- syn-flow also carries a STALE syn_booked_at, as a workspace acknowledged before
-- migration 151 would: the first acknowledgement below must strip it (GV-400), which
-- is what makes the marker self-heal without depending on the one-time cleanup.
insert into public.ledgers (id, name, slug, vehicle_info) values
  ('syn-flow', 'Syn flow', 'syn-flow',
   jsonb_build_object('next_inspection_date', to_char(current_date + 12, 'YYYY-MM-DD'),
                      'syn_booked_at', '2026-01-01T09:00:00Z')),
  ('no-syn', 'No syn', 'no-syn', '{}'::jsonb);

-- Lars is a PLAIN member. Every acknowledgement below that is supposed to succeed is
-- made by him: booking an inspection is not an administrative act, and admin-gating
-- would recreate the exact bug (the person who booked cannot tell the others).
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-000000000001', 'syn-flow', 'Lars Hansen', 'lars@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'syn-flow', 'Mette Sørensen', 'mette@test.dk', 'member', true),
  ('10000000-0000-0000-0000-000000000003', 'syn-flow', 'Admin Admins', 'admin@test.dk', 'admin', true),
  ('10000000-0000-0000-0000-000000000004', 'no-syn', 'Solo Ejer', 'solo@test.dk', 'admin', true);
SQL

PSQL <<'SQL'
select set_config('request.jwt.claims', '{"email":"lars@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 1. A PLAIN member acknowledges the workspace's current syn date.
do $$
declare
  v_result jsonb;
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  v_result := public.acknowledge_inspection_booking(
    'syn-flow', v_syn, 'Lars har booket synet', 'Syn er booket.'
  );
  if not (v_result ->> 'changed')::boolean then
    raise exception 'FAIL: first acknowledgement did not report a change: %', v_result;
  end if;
  if (v_result ->> 'acknowledged_for') <> v_syn::text then
    raise exception 'FAIL: acknowledgement did not report its date: %', v_result;
  end if;
  if (v_result ->> 'acknowledged_by_member_id') <> '10000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: acknowledgement did not report its actor: %', v_result;
  end if;
end $$;

-- The marker itself: the whole point is that it is workspace-level and durable.
do $$
declare
  v_info jsonb := (select l.vehicle_info from public.ledgers l where l.id = 'syn-flow');
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  if nullif(v_info ->> 'syn_booked_for', '')::date is distinct from v_syn then
    raise exception 'FAIL: syn_booked_for was not stamped with the live date: %', v_info;
  end if;
  if (v_info ->> 'syn_booked_by_member_id') <> '10000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: syn_booked_by_member_id was not stamped: %', v_info;
  end if;
  -- GVM-457 / GV-400 (migration 151): the acknowledgement timestamp is NOT stamped.
  -- It was written on every ack and read by nothing — syn_booked_for answers the only
  -- question anyone asks, and names its own date so it self-invalidates.
  -- The seed planted a stale one, so this also proves the acknowledge path SUBTRACTS
  -- the key rather than merely no longer writing it.
  if v_info ? 'syn_booked_at' then
    raise exception 'FAIL: syn_booked_at survived the acknowledgement — migration 151 removes it: %', v_info;
  end if;
  -- The acknowledgement must not disturb the date it acknowledges, or anything else.
  if (v_info ->> 'next_inspection_date') is null then
    raise exception 'FAIL: acknowledgement clobbered next_inspection_date: %', v_info;
  end if;
  -- Without this event the other members' devices keep showing the reminder until
  -- they cold-start (live sync IS a ledger_events insert).
  if (select count(*) from public.ledger_events
      where ledger_id = 'syn-flow' and event_type = 'vehicle_inspection_booked') <> 1 then
    raise exception 'FAIL: acknowledgement did not write exactly one vehicle_inspection_booked event';
  end if;
  if (select le.title from public.ledger_events le where le.event_type = 'vehicle_inspection_booked')
     <> 'Lars har booket synet' then
    raise exception 'FAIL: acknowledgement event lost its title';
  end if;
  if (select le.actor_email from public.ledger_events le where le.event_type = 'vehicle_inspection_booked')
     <> 'lars@test.dk' then
    raise exception 'FAIL: acknowledgement event lost its actor';
  end if;
  if (select le.metadata ->> 'inspection_date' from public.ledger_events le
      where le.event_type = 'vehicle_inspection_booked') <> v_syn::text then
    raise exception 'FAIL: acknowledgement event did not carry its inspection date';
  end if;
end $$;

-- 2. A replay (double tap, offline retry, second device) is a no-op — not an error,
--    and above all not a second feed event.
do $$
declare
  v_result jsonb;
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  v_result := public.acknowledge_inspection_booking('syn-flow', v_syn, 'Lars har booket synet', null);
  if (v_result ->> 'changed')::boolean then
    raise exception 'FAIL: replay reported a change: %', v_result;
  end if;
  if (v_result ->> 'acknowledged_by_member_id') <> '10000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: replay lost the original acknowledger: %', v_result;
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'syn-flow' and event_type = 'vehicle_inspection_booked') <> 1 then
    raise exception 'FAIL: replay wrote a duplicate event';
  end if;
end $$;

-- 3. An acknowledgement may only ever name the LIVE inspection date. A stale client,
--    or an invented date, must not be able to park an ack the live date grows into.
do $$
begin
  perform public.acknowledge_inspection_booking('syn-flow', current_date + 400);
  raise exception 'FAIL: an acknowledgement was accepted for a date that is not the live one';
exception
  when invalid_parameter_value then null;
end $$;

do $$
declare
  v_info jsonb := (select l.vehicle_info from public.ledgers l where l.id = 'syn-flow');
begin
  if nullif(v_info ->> 'syn_booked_for', '')::date <> (nullif(v_info ->> 'next_inspection_date', ''))::date then
    raise exception 'FAIL: the refused acknowledgement still moved the marker: %', v_info;
  end if;
end $$;

-- 4. A workspace with no syn date has nothing to acknowledge.
reset role;
select set_config('request.jwt.claims', '{"email":"solo@test.dk","role":"authenticated"}', false);
set role authenticated;

do $$
begin
  perform public.acknowledge_inspection_booking('no-syn', current_date + 5);
  raise exception 'FAIL: an acknowledgement was accepted with no next inspection date';
exception
  when invalid_parameter_value then null;
end $$;

-- 5. A signed-in non-member of this workspace never gets in.
reset role;
select set_config('request.jwt.claims', '{"email":"stranger@test.dk","role":"authenticated"}', false);
set role authenticated;

do $$
declare
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  perform public.acknowledge_inspection_booking('syn-flow', v_syn);
  raise exception 'FAIL: a non-member acknowledged another workspace''s syn';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  perform public.acknowledge_inspection_booking('syn-flow', null);
  raise exception 'FAIL: a non-member cleared another workspace''s acknowledgement';
exception
  when insufficient_privilege then null;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"mette@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 6. SELF-INVALIDATION — the property the whole design rests on. The register refresh
--    writes next year's syn date; the stored acknowledgement names LAST year's, so it
--    no longer applies and the reminder comes back on its own. No reset logic runs.
reset role;
create temporary table syn_ack_before as
select l.vehicle_info ->> 'syn_booked_for' as booked_for
from public.ledgers l where l.id = 'syn-flow';
grant select on syn_ack_before to authenticated;

-- Exactly what src/lib/register-refresh.ts writes after the car passes syn (it goes
-- through mergeRegisterVehicleInfo, so it is run here as the owner rather than as a
-- member — the point of the case is the NEW date, not who wrote it).
update public.ledgers l
set vehicle_info = l.vehicle_info
      || jsonb_build_object('next_inspection_date', to_char(current_date + 20, 'YYYY-MM-DD'))
where l.id = 'syn-flow';

set role authenticated;

do $$
declare
  v_before text := (select booked_for from syn_ack_before);
begin
  if (select nullif(l.vehicle_info ->> 'syn_booked_for', '') from public.ledgers l where l.id = 'syn-flow')
     is distinct from v_before then
    raise exception 'FAIL: a new inspection date silently rewrote the acknowledgement';
  end if;
  if (select nullif(l.vehicle_info ->> 'syn_booked_for', '')::date = nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
      from public.ledgers l where l.id = 'syn-flow') then
    raise exception 'FAIL: the old acknowledgement still matches the NEW inspection date — next year arrives pre-acknowledged';
  end if;
end $$;

-- ...and a different member can acknowledge the NEW date, which does emit its own event.
do $$
declare
  v_result jsonb;
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  -- No event_title: the server must compose Danish copy rather than skip the event,
  -- because a client cannot be allowed to opt out of the other members' live sync.
  v_result := public.acknowledge_inspection_booking('syn-flow', v_syn);
  if not (v_result ->> 'changed')::boolean then
    raise exception 'FAIL: the new inspection date could not be acknowledged: %', v_result;
  end if;
  if (v_result ->> 'acknowledged_by_member_id') <> '10000000-0000-0000-0000-000000000002' then
    raise exception 'FAIL: the second acknowledgement recorded the wrong member: %', v_result;
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'syn-flow' and event_type = 'vehicle_inspection_booked') <> 2 then
    raise exception 'FAIL: acknowledging a NEW date did not write its own event';
  end if;
  if not exists (
    select 1 from public.ledger_events le
    where le.ledger_id = 'syn-flow'
      and le.event_type = 'vehicle_inspection_booked'
      and le.title = 'Mette har booket synet'
  ) then
    raise exception 'FAIL: the server did not compose the fallback Danish title';
  end if;
  if not exists (
    select 1 from public.ledger_events le
    where le.ledger_id = 'syn-flow'
      and le.event_type = 'vehicle_inspection_booked'
      and le.body like 'Syn senest %'
  ) then
    raise exception 'FAIL: the server did not compose the fallback Danish body';
  end if;
end $$;

-- 7. Clearing puts the reminder back — any member can silence a safety-critical
--    reminder for the group, so any member has to be able to undo it.
do $$
declare
  v_result jsonb;
begin
  v_result := public.acknowledge_inspection_booking('syn-flow', null);
  if not (v_result ->> 'changed')::boolean then
    raise exception 'FAIL: clearing did not report a change: %', v_result;
  end if;
  if (v_result ->> 'acknowledged_for') is not null then
    raise exception 'FAIL: clearing still reports an acknowledged date: %', v_result;
  end if;
end $$;

do $$
declare
  v_info jsonb := (select l.vehicle_info from public.ledgers l where l.id = 'syn-flow');
begin
  if v_info ? 'syn_booked_for' or v_info ? 'syn_booked_at' or v_info ? 'syn_booked_by_member_id' then
    raise exception 'FAIL: clearing left an acknowledgement key behind: %', v_info;
  end if;
  if (v_info ->> 'next_inspection_date') is null then
    raise exception 'FAIL: clearing clobbered next_inspection_date: %', v_info;
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'syn-flow' and event_type = 'vehicle_inspection_booking_cleared') <> 1 then
    raise exception 'FAIL: clearing did not write exactly one vehicle_inspection_booking_cleared event';
  end if;
end $$;

-- 8. Clearing twice is a no-op, not a second event.
do $$
declare
  v_result jsonb;
begin
  v_result := public.acknowledge_inspection_booking('syn-flow', null);
  if (v_result ->> 'changed')::boolean then
    raise exception 'FAIL: a repeat clear reported a change: %', v_result;
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'syn-flow' and event_type = 'vehicle_inspection_booking_cleared') <> 1 then
    raise exception 'FAIL: a repeat clear wrote a duplicate event';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"admin@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 9. An admin is a member too — the member gate must not have excluded them.
do $$
declare
  v_syn date := (select nullif(l.vehicle_info ->> 'next_inspection_date', '')::date
                 from public.ledgers l where l.id = 'syn-flow');
begin
  perform public.acknowledge_inspection_booking('syn-flow', v_syn, 'Admin har booket synet', null);
  if (select nullif(l.vehicle_info ->> 'syn_booked_for', '')::date from public.ledgers l where l.id = 'syn-flow')
     is distinct from v_syn then
    raise exception 'FAIL: an admin could not acknowledge the syn';
  end if;
end $$;

do $$
begin
  perform public.acknowledge_inspection_booking('', current_date);
  raise exception 'FAIL: acknowledgement accepted an empty ledger id';
exception
  when invalid_parameter_value then null;
end $$;

reset role;

-- 10. Supabase-facing grants are explicit.
do $$
begin
  if has_function_privilege('anon', 'public.acknowledge_inspection_booking(text,date,text,text)', 'EXECUTE') then
    raise exception 'FAIL: anon retains EXECUTE on the syn acknowledgement';
  end if;
  if not has_function_privilege('authenticated', 'public.acknowledge_inspection_booking(text,date,text,text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated lacks EXECUTE on the syn acknowledgement';
  end if;
end $$;
SQL

echo "ok - a booked syn can be acknowledged workspace-wide and self-invalidates on the next date (GVM-442)"

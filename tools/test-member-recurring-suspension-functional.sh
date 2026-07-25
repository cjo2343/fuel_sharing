#!/bin/bash
# Functional regression test for migration 145's payer-deactivation suspension (GV-373).
#
# Migration 114 gave set_ledger_member_active_admin the suspension + the
# recurring_suspended feed event. No client calls that function — both clients
# deactivate through upsert_ledger_member_admin's is_active parameter — so the
# behaviour never fired in production and the role-matrix case that covered it
# stayed green the whole time. That is precisely the failure mode a structural
# check cannot see: the RPC EXISTS, it is CORRECT, and it is unreachable.
#
# So this suite drives the function the apps actually call, and asserts the things
# only a replay can prove: that deactivation suspends the templates, that it says so
# in the feed exactly once, that a replay and a routine profile edit stay silent,
# that a bystander's templates are never touched, and that re-activation does NOT
# quietly resume anything.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="govehlo-recurring-suspend-$$"

cleanup() { docker rm -f "${C}" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required for the payer-deactivation suspension functional test." >&2
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
insert into public.ledgers (id, name, slug) values
  ('suspend-flow', 'Suspend flow', 'suspend-flow');

--   A  admin, the actor
--   B  the member who gets deactivated; fronts the templates under test
--   C  a bystander whose template must survive every case below
--   D  gets deactivated but fronts nothing (the suspended_count = 0 path)
--   E  a second admin, so the last-admin guard is never what a case trips on
insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('10000000-0000-0000-0000-00000000000a', 'suspend-flow', 'Anna',  'anna@test.dk',  'admin',  true),
  ('10000000-0000-0000-0000-00000000000b', 'suspend-flow', 'Bo',    'bo@test.dk',    'member', true),
  ('10000000-0000-0000-0000-00000000000c', 'suspend-flow', 'Cille', 'cille@test.dk', 'member', true),
  ('10000000-0000-0000-0000-00000000000d', 'suspend-flow', 'Dorte', 'dorte@test.dk', 'member', true),
  ('10000000-0000-0000-0000-00000000000e', 'suspend-flow', 'Ejnar', 'ejnar@test.dk', 'admin',  true);

-- b1  Bo, active, named            -> suspended, named in the event
-- b2  Bo, active, description null -> suspended, falls back to initcap(category)
-- b3  Bo, already paused by hand   -> not re-suspended, not counted, not named
-- b4  Bo, active but soft-deleted  -> excluded by the deleted_at guard
-- c1  Cille, active                -> a bystander's template, must never move
insert into public.recurring_expenses
  (id, ledger_id, category, description, amount_dkk, cadence, next_due_date,
   paid_by_member_id, is_active, deleted_at, created_by_member_id)
values
  ('20000000-0000-0000-0000-000000000001', 'suspend-flow', 'insurance', 'Forsikring', 450.00,
   'monthly', current_date, '10000000-0000-0000-0000-00000000000b', true, null,
   '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000002', 'suspend-flow', 'parking', null, 200.00,
   'monthly', current_date, '10000000-0000-0000-0000-00000000000b', true, null,
   '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000003', 'suspend-flow', 'other', 'Manuelt sat på pause', 75.00,
   'monthly', current_date, '10000000-0000-0000-0000-00000000000b', false, null,
   '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000004', 'suspend-flow', 'other', 'Slettet skabelon', 60.00,
   'monthly', current_date, '10000000-0000-0000-0000-00000000000b', true, now(),
   '10000000-0000-0000-0000-00000000000a'),
  ('20000000-0000-0000-0000-000000000005', 'suspend-flow', 'other', 'Cilles abonnement', 100.00,
   'monthly', current_date, '10000000-0000-0000-0000-00000000000c', true, null,
   '10000000-0000-0000-0000-00000000000a');
SQL

PSQL <<'SQL'
select set_config('request.jwt.claims', '{"email":"anna@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 1. THE case. Anna deactivates Bo through the RPC both clients actually call.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo', 'bo@test.dk', null, 'member', false
  );
end $$;

do $$
declare
  evt public.ledger_events%rowtype;
  evt_count integer;
begin
  -- Every template Bo fronted is paused...
  if (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000001') then
    raise exception 'FAIL: the deactivated payer''s named template is still active';
  end if;
  if (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000002') then
    raise exception 'FAIL: the deactivated payer''s unnamed template is still active';
  end if;
  -- ...and nobody else's is.
  if not (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000005') then
    raise exception 'FAIL: a bystander''s template was suspended';
  end if;

  select count(*) into evt_count
  from public.ledger_events
  where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended';
  if evt_count <> 1 then
    raise exception 'FAIL: expected exactly one recurring_suspended event, got %', evt_count;
  end if;

  select * into evt
  from public.ledger_events
  where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended';

  -- The whole point of the event is that it NAMES what stopped: an admin who cannot
  -- tell which template died has no action item.
  if position('Forsikring' in evt.body) = 0 then
    raise exception 'FAIL: the event does not name the suspended template: %', evt.body;
  end if;
  -- A template with no description falls back to its category, not to nothing.
  if position('Parking' in evt.body) = 0 then
    raise exception 'FAIL: the event does not name the description-less template by category: %', evt.body;
  end if;
  if position('Bo' in evt.body) = 0 then
    raise exception 'FAIL: the event does not name the deactivated member: %', evt.body;
  end if;
  -- Neither the hand-paused nor the soft-deleted template is Bo's deactivation's doing.
  if position('Manuelt sat på pause' in evt.body) > 0 then
    raise exception 'FAIL: the event claims credit for an already-paused template: %', evt.body;
  end if;
  if position('Slettet skabelon' in evt.body) > 0 then
    raise exception 'FAIL: the event counted a soft-deleted template: %', evt.body;
  end if;

  if (evt.metadata ->> 'suspended_count')::integer <> 2 then
    raise exception 'FAIL: suspended_count is % (expected 2)', evt.metadata ->> 'suspended_count';
  end if;
  if (evt.metadata ->> 'deactivated_member_id') <> '10000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL: the event lost the deactivated member id: %', evt.metadata;
  end if;
  if evt.target_member_id <> '10000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL: the event lost its target member';
  end if;
  -- Actor attribution is the audit half of this ticket (migration 051/052 pattern).
  if evt.actor_email <> 'anna@test.dk' then
    raise exception 'FAIL: the event lost its actor email: %', evt.actor_email;
  end if;
  if evt.actor_member_id <> '10000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: the event lost its actor member';
  end if;
  if evt.title <> 'Faste udgifter sat på pause' then
    raise exception 'FAIL: unexpected event title: %', evt.title;
  end if;
end $$;

-- The soft-deleted row must be untouched, not merely uncounted: the suspension has no
-- business writing to a deleted template at all.
do $$
begin
  if not (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000004') then
    raise exception 'FAIL: the suspension wrote to a soft-deleted template';
  end if;
end $$;

-- 2. A replay (double tap, offline retry, second device) is silent. The member is
--    already inactive, so there is no transition and no second event.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo', 'bo@test.dk', null, 'member', false
  );
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 1 then
    raise exception 'FAIL: a replayed deactivation wrote a duplicate event';
  end if;
end $$;

-- 3. The reason this gates on the TRANSITION and not on the payload value. This RPC
--    is the full-member upsert: the clients call it for name/email/phone/role edits
--    too, carrying the member's current is_active along. Renaming an already-inactive
--    member must not re-run the scan or re-announce anything.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo Jensen', 'bo@test.dk', '+4512345678', 'member', false
  );
  if (select name from public.ledger_members where id = '10000000-0000-0000-0000-00000000000b') <> 'Bo Jensen' then
    raise exception 'FAIL: the profile edit itself did not land';
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 1 then
    raise exception 'FAIL: a routine profile edit of an inactive member re-announced the suspension';
  end if;
end $$;

-- 4. An ACTIVE member's edit touches nothing. Cille is renamed with is_active = true;
--    her template stays live and the feed stays quiet.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000c',
    'Cille Hansen', 'cille@test.dk', null, 'member', true
  );
  if not (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000005') then
    raise exception 'FAIL: editing an active member suspended her template';
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 1 then
    raise exception 'FAIL: editing an active member wrote a suspension event';
  end if;
end $$;

-- 5. RE-ACTIVATION IS NOT THE MIRROR IMAGE (the decision this migration makes).
--    Bringing Bo back must not resume anything: the generators catch up on missed
--    occurrences, so a silent resume would materialise a backlog of real charges from
--    a tap that only said "this person is back". Resolution is GVM-330's explicit
--    reassignment instead.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo Jensen', 'bo@test.dk', null, 'member', true
  );
  if not (select is_active from public.ledger_members where id = '10000000-0000-0000-0000-00000000000b') then
    raise exception 'FAIL: the re-activation itself did not land';
  end if;
  if (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000001') then
    raise exception 'FAIL: re-activating the member silently resumed a suspended template';
  end if;
  if (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000002') then
    raise exception 'FAIL: re-activating the member silently resumed a suspended template';
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 1 then
    raise exception 'FAIL: re-activation wrote a suspension event';
  end if;
end $$;

-- 6. Deactivating again with everything already paused is a real transition but has
--    nothing to suspend, so it stays silent: no event without a suspension.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo Jensen', 'bo@test.dk', null, 'member', false
  );
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 1 then
    raise exception 'FAIL: a deactivation that suspended nothing still wrote an event';
  end if;
end $$;

-- 7. ...but the mechanism still arms for the next round. An admin resumes a template
--    by hand (what GVM-330's reassignment sheet does through upsert_recurring_expense),
--    and the next deactivation announces it again.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo Jensen', 'bo@test.dk', null, 'member', true
  );
end $$;

reset role;
update public.recurring_expenses set is_active = true
where id = '20000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claims', '{"email":"anna@test.dk","role":"authenticated"}', false);
set role authenticated;

do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000b',
    'Bo Jensen', 'bo@test.dk', null, 'member', false
  );
  if (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000001') then
    raise exception 'FAIL: a resumed template was not re-suspended on the next deactivation';
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 2 then
    raise exception 'FAIL: the second real suspension did not announce itself';
  end if;
  if (select (metadata ->> 'suspended_count')::integer from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended'
      order by created_at desc limit 1) <> 1 then
    raise exception 'FAIL: the second event miscounted';
  end if;
end $$;

-- 8. Deactivating a member who fronts nothing writes no event at all.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000d',
    'Dorte', 'dorte@test.dk', null, 'member', false
  );
  if (select is_active from public.ledger_members where id = '10000000-0000-0000-0000-00000000000d') then
    raise exception 'FAIL: Dorte was not deactivated';
  end if;
  if (select count(*) from public.ledger_events
      where ledger_id = 'suspend-flow' and event_type = 'recurring_suspended') <> 2 then
    raise exception 'FAIL: deactivating a member with no templates wrote an event';
  end if;
end $$;

-- 9. The 042 guards this migration re-declares are still in force. A verbatim
--    re-declaration that quietly dropped one of these would be the worst outcome here.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000a',
    'Anna', 'anna@test.dk', null, 'admin', false
  );
  raise exception 'FAIL: an admin deactivated themselves';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', null, 'Ny person', 'ny@test.dk', null, 'member', true
  );
  raise exception 'FAIL: the RPC created a brand-new member outside the invite flow';
exception
  when insufficient_privilege then null;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"cille@test.dk","role":"authenticated"}', false);
set role authenticated;

do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000c',
    'Cille Hansen', 'cille@test.dk', null, 'member', false
  );
  raise exception 'FAIL: a non-admin reached member management';
exception
  when insufficient_privilege then null;
end $$;

do $$
begin
  if not (select is_active from public.recurring_expenses where id = '20000000-0000-0000-0000-000000000005') then
    raise exception 'FAIL: a refused call still suspended a template';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '{"email":"stranger@test.dk","role":"authenticated"}', false);
set role authenticated;

-- 10. A signed-in non-member of this workspace never gets in.
do $$
begin
  perform public.upsert_ledger_member_admin(
    'suspend-flow', '10000000-0000-0000-0000-00000000000c',
    'Cille Hansen', 'cille@test.dk', null, 'member', false
  );
  raise exception 'FAIL: a non-member reached another workspace''s members';
exception
  when insufficient_privilege then null;
end $$;

reset role;

-- 11. The re-declaration kept the grant footprint migration 083 left: EXECUTE
--     revoked from PUBLIC, re-granted to authenticated. `create or replace` preserves
--     privileges, so the risk this guards is the signature quietly changing and
--     stranding a fresh function on default privileges.
--
--     anon is deliberately NOT asserted. 083 revokes from PUBLIC and never names anon,
--     because in Supabase anon's EXECUTE comes FROM the PUBLIC default — so the revoke
--     covers it there. This harness grants anon explicitly via `alter default
--     privileges ... to anon` above, which no revoke-from-PUBLIC can undo, so an anon
--     assertion here would test the harness's own setup rather than the migration.
do $$
begin
  if has_function_privilege('public',
       'public.upsert_ledger_member_admin(text,uuid,text,text,text,text,boolean)', 'EXECUTE') then
    raise exception 'FAIL: PUBLIC retains EXECUTE on member management';
  end if;
  if not has_function_privilege('authenticated',
       'public.upsert_ledger_member_admin(text,uuid,text,text,text,text,boolean)', 'EXECUTE') then
    raise exception 'FAIL: authenticated lacks EXECUTE on member management';
  end if;
end $$;
SQL

echo "ok - deactivating a member suspends their recurring templates and announces it once (GV-373)"

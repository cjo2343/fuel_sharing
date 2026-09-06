// GVM-597: execute the write/event contract on disposable Postgres, never production.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbWithPrelude, psql, removeContainer, startPostgres } from './lib/replay-container.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = `vehlo-booking-edit-${process.pid}`;
const DB = 'booking_edits';
const ANNA = '10000000-0000-0000-0000-000000000001';
const BO = '10000000-0000-0000-0000-000000000002';
const OUTSIDER = '10000000-0000-0000-0000-000000000003';
const literal = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
let checked = 0;

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
} catch {
  console.error('Booking edit events: Docker unavailable; SQL was NOT tested.');
  process.exit(process.argv.includes('--strict') ? 1 : 0);
}

function sql(statement) {
  const result = psql(CONTAINER, DB, ['-t', '-A', '-c', statement]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').at(-1);
}
function as(email, statement) {
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', ${literal(JSON.stringify({ email, role: 'authenticated' }))}, false);
    ${statement}`);
}
function call({ legacy = 'qa-booking', member = ANNA, from = '2030-01-10T09:00:00Z',
  to = '2030-01-10T18:00:00Z', purpose = 'original', title = null, body = null,
  fuel = null, token = null } = {}) {
  return `public.upsert_car_booking('edits', ${literal(legacy)}, ${literal(member)}::uuid,
    ${literal(from)}::timestamptz, ${literal(to)}::timestamptz, ${literal(purpose)},
    ${literal(title)}, ${literal(body)}, ${literal(fuel == null ? null : JSON.stringify(fuel))}::jsonb,
    ${literal(token)}::timestamptz)`;
}
function save(input = {}, email = 'anna@test.dk') {
  return JSON.parse(as(email, `select ${call(input)};`));
}
function state(input, email = 'anna@test.dk') {
  return as(email, `select public.qa_try_booking(${literal(call(input))});`);
}
function row() {
  return JSON.parse(sql("select row_to_json(b) from public.car_bookings b where legacy_id='qa-booking';"));
}
function events(type = 'booking_updated') {
  return JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at, e.id), '[]'::jsonb)
    from public.ledger_events e where e.ledger_id='edits' and e.event_type=${literal(type)};`));
}
function pin(label, test) {
  test();
  checked += 1;
  console.log(`ok - ${label}`);
}

try {
  startPostgres(CONTAINER, ROOT);
  createDbWithPrelude(CONTAINER, DB);
  // Supabase supplies these defaults; match the role-matrix harness before replay
  // so migration revokes still win and authenticated SELECT exercises real RLS.
  sql(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  const applied = psql(CONTAINER, DB, ['-f', '/work/supabase-schema.sql']);
  assert.equal(applied.status, 0, applied.stderr);
  sql(`
    insert into public.ledgers (id, name, slug) values
      ('edits', 'QA edits', 'qa-edits'), ('other', 'QA other', 'qa-other');
    insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
      ('${ANNA}', 'edits', 'Anna', 'anna@test.dk', 'admin', true),
      ('${BO}', 'edits', 'Bo', 'bo@test.dk', 'member', true),
      ('${OUTSIDER}', 'other', 'Else', 'else@test.dk', 'admin', true);
    create function public.qa_try_booking(command text) returns text language plpgsql as $$
    begin
      execute 'select ' || command;
      return 'OK';
    exception when others then return sqlstate;
    end $$;
  `);

  pin('creation without optional copy still emits one member-visible event', () => {
    const saved = save();
    const created = events('booking_created');
    assert.equal(created.length, 1);
    assert.equal(created[0].metadata.booking_id, saved.booking_id);
    assert.equal(created[0].actor_member_id, ANNA);
    assert.equal(created[0].title, 'Anna bookede bilen');
  });

  pin('replaying a create preserves the booking token and creates no second event', () => {
    const before = row();
    save();
    assert.deepEqual(row(), before);
    assert.equal(events('booking_created').length, 1);
    assert.equal(events().length, 0);
  });

  pin('a note edit with omitted event text emits booking_updated atomically', () => {
    const saved = save({ purpose: 'edited', token: row().updated_at });
    assert.equal(row().purpose, 'edited');
    const updated = events();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].metadata.booking_id, saved.booking_id);
    assert.equal(updated[0].title, 'Anna ændrede en booking');
    assert.equal(updated[0].body, '');
    assert.equal(updated[0].actor_member_id, ANNA);
    assert.deepEqual(Object.keys(updated[0].metadata), ['booking_id']);
  });

  pin('unchanged retry does not emit or advance the edit token', () => {
    const before = row();
    save({ purpose: 'edited', token: before.updated_at, title: 'Different optional title' });
    assert.deepEqual(row(), before);
    assert.equal(events().length, 1);
    save({ purpose: 'edited' });
    assert.deepEqual(row(), before);
    assert.equal(events().length, 1);
  });

  pin('changed dates and supplied event copy are preserved', () => {
    save({ purpose: 'edited', to: '2030-01-10T19:00:00Z', title: 'Anna flyttede en booking', body: 'Ny sluttid' });
    assert.equal(events().length, 2);
    assert.equal(events().at(-1).title, 'Anna flyttede en booking');
    assert.equal(events().at(-1).body, 'Ny sluttid');
  });

  pin('route changes, route clearing and reassignment each emit', () => {
    const fuel = { version: 1, plannedDistanceKm: 30 };
    const unchanged = { purpose: 'edited', to: '2030-01-10T19:00:00Z' };
    save({ ...unchanged, fuel });
    assert.deepEqual(row().fuel_stop, fuel);
    save({ ...unchanged, fuel: null });
    assert.equal(row().fuel_stop, null);
    save({ ...unchanged, member: BO });
    assert.equal(row().member_id, BO);
    assert.equal(events().length, 5);
  });

  pin('normal member can edit own booking and gets the correct actor', () => {
    save({ member: BO, purpose: 'Bo edited' }, 'bo@test.dk');
    assert.equal(events().length, 6);
    assert.equal(events().at(-1).actor_member_id, BO);
    assert.equal(events().at(-1).title, 'Bo ændrede en booking');
  });

  pin('null and empty note normalize to the same unchanged row', () => {
    save({ member: BO, purpose: null });
    const before = row();
    const count = events().length;
    save({ member: BO, purpose: '' });
    assert.deepEqual(row(), before);
    assert.equal(events().length, count);
  });

  pin('blank event title still generates copy and restores emit an event', () => {
    sql("update public.car_bookings set deleted_at=now() where legacy_id='qa-booking';");
    const count = events().length;
    save({ member: BO, purpose: null, title: '   ' });
    assert.equal(row().deleted_at, null);
    assert.equal(events().length, count + 1);
    assert.equal(events().at(-1).title, 'Anna ændrede en booking');
  });

  pin('readers only see events for their workspace', () => {
    assert.equal(Number(as('bo@test.dk', "select count(*) from public.ledger_events where event_type='booking_updated';")), events().length);
    assert.equal(Number(as('else@test.dk', "select count(*) from public.ledger_events where ledger_id='edits';")), 0);
  });

  pin('unauthorized and stale writes change neither row nor events', () => {
    save({ member: ANNA, purpose: 'owned by Anna' });
    const before = row();
    const count = events().length;
    assert.equal(state({ purpose: 'forbidden' }, 'bo@test.dk'), '42501');
    assert.equal(state({ purpose: 'forbidden' }, 'else@test.dk'), '42501');
    assert.equal(state({ purpose: 'stale', token: '2020-01-01T00:00:00Z' }), 'GV42B');
    assert.deepEqual(row(), before);
    assert.equal(events().length, count);
    assert.equal(sql("select has_function_privilege('anon', 'public.upsert_car_booking(text,text,uuid,timestamptz,timestamptz,text,text,text,jsonb,timestamptz)', 'EXECUTE');"), 'f');
  });

  pin('event insertion failure rolls back the booking edit', () => {
    const before = row();
    const count = events().length;
    sql(`create function public.qa_reject_event() returns trigger language plpgsql as $$
      begin raise exception 'Injected event failure'; end $$;
      create trigger qa_reject_event before insert on public.ledger_events
      for each row when (new.event_type = 'booking_updated') execute function public.qa_reject_event();`);
    assert.equal(state({ purpose: 'must roll back' }), 'P0001');
    assert.deepEqual(row(), before);
    assert.equal(events().length, count);
    sql('drop trigger qa_reject_event on public.ledger_events;');
  });

  pin('two simultaneous edits share the existing lock; only the winning token emits', () => {
    const before = row();
    const count = events().length;
    sql('create extension if not exists dblink;');
    sql(`create function public.qa_edit_race() returns jsonb language plpgsql as $race$
      declare second_pid integer; first_result text; second_result text; blocked boolean := false;
      begin
        perform dblink_connect('edit_a', 'dbname=' || current_database());
        perform dblink_connect('edit_b', 'dbname=' || current_database());
        perform dblink_exec('edit_a', 'set role authenticated');
        perform dblink_exec('edit_b', 'set role authenticated');
        perform dblink_exec('edit_a', 'set request.jwt.claims = ''{"email":"anna@test.dk","role":"authenticated"}''');
        perform dblink_exec('edit_b', 'set request.jwt.claims = ''{"email":"anna@test.dk","role":"authenticated"}''');
        perform dblink_exec('edit_a', 'begin');
        perform dblink_exec('edit_b', 'begin');
        select p into second_pid from dblink('edit_b', 'select pg_backend_pid()') as t(p integer);
        select r into first_result from dblink('edit_a',
          ${literal(`select public.qa_try_booking(${literal(call({ purpose: 'winner', token: before.updated_at }))})`)}) as t(r text);
        perform dblink_send_query('edit_b',
          ${literal(`select public.qa_try_booking(${literal(call({ purpose: 'loser', token: before.updated_at }))})`)});
        for i in 1..100 loop
          select cardinality(pg_blocking_pids(second_pid)) > 0 into blocked;
          exit when blocked;
          perform pg_sleep(0.02);
        end loop;
        perform dblink_exec('edit_a', 'commit');
        select r into second_result from dblink_get_result('edit_b') as t(r text);
        perform * from dblink_get_result('edit_b') as t(r text);
        perform dblink_exec('edit_b', 'commit');
        perform dblink_disconnect('edit_a');
        perform dblink_disconnect('edit_b');
        return jsonb_build_object('blocked', blocked, 'winner', first_result, 'loser', second_result);
      end $race$;`);
    assert.deepEqual(JSON.parse(sql('select public.qa_edit_race();')), { blocked: true, winner: 'OK', loser: 'GV42B' });
    assert.equal(row().purpose, 'winner');
    assert.equal(events().length, count + 1);
  });

  const cancelCall = "public.soft_delete_car_booking('edits', 'qa-booking')";
  pin('unauthorized cancellation leaves the row and event stream untouched', () => {
    const before = row();
    assert.equal(as('bo@test.dk', `select public.qa_try_booking(${literal(cancelCall)});`), '42501');
    assert.equal(as('else@test.dk', `select public.qa_try_booking(${literal(cancelCall)});`), '42501');
    assert.deepEqual(row(), before);
    assert.equal(events('booking_deleted').length, 0);
  });

  pin('failed cancellation event rolls the cancellation back', () => {
    const before = row();
    sql(`create trigger qa_reject_event before insert on public.ledger_events
      for each row when (new.event_type = 'booking_deleted') execute function public.qa_reject_event();`);
    assert.equal(as('anna@test.dk', `select public.qa_try_booking(${literal(cancelCall)});`), 'P0001');
    assert.deepEqual(row(), before);
    assert.equal(events('booking_deleted').length, 0);
    sql('drop trigger qa_reject_event on public.ledger_events;');
  });

  pin('cancellation emits one booking_deleted event with no note or route metadata', () => {
    const result = JSON.parse(as('anna@test.dk', `select ${cancelCall};`));
    assert.equal(result.deleted, true);
    assert.ok(row().deleted_at);
    const cancelled = events('booking_deleted');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].title, 'Anna aflyste en booking');
    assert.equal(cancelled[0].actor_member_id, ANNA);
    assert.deepEqual(cancelled[0].metadata, { booking_id: result.booking_id });
  });

  pin('repeated and missing cancellation emit nothing and preserve the token', () => {
    const before = row();
    assert.equal(JSON.parse(as('anna@test.dk', `select ${cancelCall};`)).deleted, true);
    assert.deepEqual(row(), before);
    const absent = JSON.parse(as('anna@test.dk', "select public.soft_delete_car_booking('edits', 'absent');"));
    assert.equal(absent.deleted, false);
    assert.equal(absent.reason, 'not_found');
    assert.equal(events('booking_deleted').length, 1);
    assert.equal(sql("select has_function_privilege('anon', 'public.soft_delete_car_booking(text,text)', 'EXECUTE');"), 'f');
  });

  pin('migration applies over an existing booking and can be reapplied without rewriting it', () => {
    const before = row();
    const count = events().length;
    const oldDefinition = psql(CONTAINER, DB, ['-f', '/work/supabase/migrations/162_booking_cap_lock_and_duration.sql']);
    assert.equal(oldDefinition.status, 0, oldDefinition.stderr);
    for (let n = 0; n < 2; n += 1) {
      const upgrade = psql(CONTAINER, DB, ['-f', '/work/supabase/migrations/211_booking_edit_realtime_events.sql']);
      assert.equal(upgrade.status, 0, upgrade.stderr);
      assert.deepEqual(row(), before);
      assert.equal(events().length, count);
    }
    save({ purpose: 'after upgrade', token: before.updated_at });
    assert.equal(events().length, count + 1);
    assert.equal(row().purpose, 'after upgrade');
  });

  console.log(`Booking edit events: ${checked} functional checks passed.`);
} finally {
  removeContainer(CONTAINER);
}

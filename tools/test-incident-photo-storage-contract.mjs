import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/139_incident_photo_storage_hardening.sql', 'utf8');
const quotaMigration = readFileSync('supabase/migrations/178_incident_photo_upload_quota.sql', 'utf8');
const schema = readFileSync('supabase-schema.sql', 'utf8');

// The last incident-photo INSERT policy in a file is the authoritative one: the
// consolidated schema appends migration 178's re-declaration at the end (last
// definition wins on replay), so lastIndexOf lands on the count-capped version.
function insertPolicyBody(sql) {
  const start = sql.lastIndexOf('create policy "Incident photos are writable by workspace members"');
  const rest = sql.slice(start);
  let end = rest.length;
  for (const marker of [
    'drop policy if exists "Incident photos are deletable by workspace members"',
    'insert into public.fuel_ledger_schema_migrations',
    '\n  end if;',
  ]) {
    const i = rest.indexOf(marker);
    if (i !== -1) end = Math.min(end, i);
  }
  return rest.slice(0, end);
}

// Uploads stay incident-bound (membership + a real vehicle_incident in the same ledger)
// in the migration-139 hardening, migration-178 re-declaration, and the consolidated mirror.
for (const sql of [migration, quotaMigration, schema]) {
  const insertPolicy = insertPolicyBody(sql);
  assert.match(insertPolicy, /cardinality\(storage\.foldername\(name\)\) = 2/i);
  assert.match(insertPolicy, /from public\.vehicle_incidents vi/i);
  assert.match(insertPolicy, /vi\.ledger_id = \(storage\.foldername\(name\)\)\[1\]/i);
  assert.match(insertPolicy, /vi\.id::text = \(storage\.foldername\(name\)\)\[2\]/i);
}

// The per-incident object count cap (< 10 under the same <ledger_id>/<incident_id>/
// prefix) lives in migration 178 and in the consolidated mirror, but NOT in the
// original migration-139 hardening.
for (const sql of [quotaMigration, schema]) {
  const insertPolicy = insertPolicyBody(sql);
  assert.match(insertPolicy, /from storage\.objects so2/i);
  assert.match(insertPolicy, /so2\.bucket_id = 'incident-photos'/i);
  assert.match(
    insertPolicy,
    /so2\.name like \(storage\.foldername\(name\)\)\[1\] \|\| '\/' \|\| \(storage\.foldername\(name\)\)\[2\] \|\| '\/%'/i,
  );
  assert.match(insertPolicy, /\)\s*< 10/);
}
assert.doesNotMatch(insertPolicyBody(migration), /from storage\.objects so2/i);

// Deletes remain owner/admin-only in the migration-139 hardening and the mirror.
for (const sql of [migration, schema]) {
  const deletePolicy = sql.slice(
    sql.lastIndexOf('create policy "Incident photos are deletable by workspace members"'),
    sql.indexOf('insert into public.fuel_ledger_schema_migrations', sql.lastIndexOf('create policy "Incident photos are deletable by workspace members"')),
  );
  assert.match(deletePolicy, /owner_id::text = auth\.uid\(\)::text/i);
  assert.match(deletePolicy, /public\.is_ledger_admin\(\(storage\.foldername\(name\)\)\[1\]\)/i);
  assert.doesNotMatch(deletePolicy, /and public\.is_ledger_member\([^)]*\)\s*\)\s*;/i);
}

console.log('ok - incident photo Storage writes are incident-bound, count-capped, and deletes are owner/admin-only');

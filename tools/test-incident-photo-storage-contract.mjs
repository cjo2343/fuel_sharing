import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/139_incident_photo_storage_hardening.sql', 'utf8');
const schema = readFileSync('supabase-schema.sql', 'utf8');

for (const sql of [migration, schema]) {
  const insertPolicy = sql.slice(
    sql.lastIndexOf('create policy "Incident photos are writable by workspace members"'),
    sql.lastIndexOf('drop policy if exists "Incident photos are deletable by workspace members"'),
  );
  assert.match(insertPolicy, /cardinality\(storage\.foldername\(name\)\) = 2/i);
  assert.match(insertPolicy, /from public\.vehicle_incidents vi/i);
  assert.match(insertPolicy, /vi\.ledger_id = \(storage\.foldername\(name\)\)\[1\]/i);
  assert.match(insertPolicy, /vi\.id::text = \(storage\.foldername\(name\)\)\[2\]/i);

  const deletePolicy = sql.slice(
    sql.lastIndexOf('create policy "Incident photos are deletable by workspace members"'),
    sql.indexOf('insert into public.fuel_ledger_schema_migrations', sql.lastIndexOf('create policy "Incident photos are deletable by workspace members"')),
  );
  assert.match(deletePolicy, /owner_id::text = auth\.uid\(\)::text/i);
  assert.match(deletePolicy, /public\.is_ledger_admin\(\(storage\.foldername\(name\)\)\[1\]\)/i);
  assert.doesNotMatch(deletePolicy, /and public\.is_ledger_member\([^)]*\)\s*\)\s*;/i);
}

console.log('ok - incident photo Storage writes are incident-bound and deletes are owner/admin-only');

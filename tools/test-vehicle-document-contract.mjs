// Anti-drift contract for the vehicle document archive (GVM-523, migration 201).
//
// Mirrors tools/test-fuel-receipt-contract.mjs and
// tools/test-incident-photo-storage-contract.mjs, which do the same job for the two
// buckets this feature is cloned from. Static and dependency-free, so it runs in
// `npm run validate` on every commit; the role matrix proves the BEHAVIOUR against a
// real Postgres. Everything is asserted in BOTH the migration and the consolidated
// schema, so the two copies cannot drift apart either.
//
// What it pins, and why each one is the kind of thing a later tidy-up reverses without
// any other guard noticing:
//
//   (1) RPC-ONLY, MEMBERS-READ. A write grant on either table would make the RPC gates
//       (membership, creator-or-admin, the path prefix) optional for anyone holding a
//       PostgREST token — which is how a page of somebody's registreringsattest ends up
//       registered against another workspace's document.
//
//   (2) THE left() PREFIX RULE. A ledger id may contain '_', which LIKE reads as a
//       wildcard, so `path like prefix || '%'` would accept a neighbouring workspace's
//       prefix. This is the exact bug migration 138 wrote its comment about; a `like`
//       here looks tidier and is wrong.
//
//   (3) CREATOR-OR-ADMIN ON EDIT AND DELETE. Migration 138's gate, chosen deliberately
//       over "any member may edit". Widening it is a product decision, not a cleanup.
//
//   (4) THE STORAGE HALF STAYS PROD-ONLY AND HARDENED. Every storage statement lives
//       inside the `schema_name = 'storage'` guard (the migration-138 lesson: without
//       it, plain-Postgres CI replays fail), uploads are bound to a real document in
//       the same ledger, and direct deletes are owner-or-admin.
//
//   (5) THE TWO RE-DECLARATIONS KEEP THEIR SIBLINGS. 201 re-declares
//       enforce_storage_upload_quota (off 184) and list_registered_storage_paths (off
//       191). Dropping a branch from either is invisible in a diff and breaks a
//       DIFFERENT feature: the fuel-receipt cap, or the incident-photo orphan sweep.
//
//   (6) NO ledger_events ROW. Writing one is a GV-413 classification decision, not a
//       detail — the mobile feed renders whatever the database writes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/201_vehicle_documents.sql', 'utf8');
const schema = readFileSync('supabase-schema.sql', 'utf8');

const sliceFrom = (sql, start, end) => {
  const from = sql.lastIndexOf(start);
  assert.ok(from >= 0, `expected to find ${JSON.stringify(start)}`);
  const to = sql.indexOf(end, from);
  assert.ok(to > from, `expected to find ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return sql.slice(from, to);
};

for (const sql of [migration, schema]) {
  // ── (1) tables: shape + RPC-only posture ─────────────────────────────────────
  const documents = sliceFrom(
    sql,
    'create table if not exists public.vehicle_documents',
    'alter table public.vehicle_documents enable row level security',
  );
  assert.match(documents, /ledger_id text not null references public\.ledgers\(id\) on delete cascade/i);
  assert.match(
    documents,
    /title text not null check \(btrim\(title\) <> '' and char_length\(title\) <= 120\)/i,
    'a blank or unbounded title must be impossible at the table, not only in the RPC',
  );
  assert.match(documents, /expiry_date date/i);
  assert.match(documents, /created_by_member_id uuid references public\.ledger_members\(id\) on delete set null/i);
  // Hard delete, no tombstone (owner decision 2026-08-10): a deleted_at column here
  // would silently turn the archive into a retention class it has no rule for.
  assert.doesNotMatch(documents, /deleted_at/i, 'documents are hard-deleted — there is no tombstone column');

  const photos = sliceFrom(
    sql,
    'create table if not exists public.vehicle_document_photos',
    'alter table public.vehicle_document_photos enable row level security',
  );
  assert.match(photos, /document_id uuid not null references public\.vehicle_documents\(id\) on delete cascade/i);
  assert.match(photos, /ledger_id text not null references public\.ledgers\(id\) on delete cascade/i);
  assert.match(photos, /storage_path text not null unique/i);
  assert.match(photos, /created_by_member_id uuid references public\.ledger_members\(id\) on delete set null/i);

  for (const table of ['vehicle_documents', 'vehicle_document_photos']) {
    assert.doesNotMatch(
      sql,
      new RegExp(`grant (insert|update|delete)[^;]*on table public\\.${table}`, 'i'),
      `${table} must stay RPC-only: no client role may write it directly`,
    );
    assert.match(sql, new RegExp(`grant select on table public\\.${table} to authenticated;`, 'i'));
    // service_role's select is what lets the govehlo-web orphan sweep read the
    // registered paths through list_registered_storage_paths.
    assert.match(sql, new RegExp(`grant select on table public\\.${table} to service_role;`, 'i'));
  }
  assert.match(
    sql,
    /create policy "Ledger members can read vehicle documents"[\s\S]*?using \(public\.is_ledger_member\(ledger_id\)\)/i,
  );
  assert.match(
    sql,
    /create policy "Ledger members can read vehicle document photos"[\s\S]*?using \(public\.is_ledger_member\(ledger_id\)\)/i,
  );

  // ── create: membership + the per-workspace cap taken UNDER a lock ────────────
  const create = sliceFrom(
    sql,
    'create or replace function public.create_vehicle_document',
    'revoke all on function public.create_vehicle_document',
  );
  assert.match(create, /public\.is_ledger_member\(target_ledger_id\)/i);
  assert.match(create, /v_actor_member_id := public\.current_ledger_member_id\(target_ledger_id\)/i);
  assert.match(
    create,
    /perform pg_advisory_xact_lock\(hashtext\('vehicle_documents:' \|\| target_ledger_id\)\);[\s\S]*?select count\(\*\)[\s\S]*?from public\.vehicle_documents vd[\s\S]*?if v_existing >= 50 then/i,
    'the 50-document cap must be counted UNDER the advisory lock — a plain count-then-insert is the ' +
      'check-then-insert race migration 184 was written about',
  );

  // ── (3) creator-or-admin on edit and delete ─────────────────────────────────
  const update = sliceFrom(
    sql,
    'create or replace function public.update_vehicle_document',
    'revoke all on function public.update_vehicle_document',
  );
  assert.match(
    update,
    /public\.is_ledger_admin\(v_document\.ledger_id\)\s*or coalesce\(v_document\.created_by_member_id = v_actor_member_id, false\)/i,
    'editing a document is creator-or-admin (migration 138\'s gate), not any-member',
  );
  // FULL-SET expiry: the update assigns the parameter directly, so a null CLEARS the
  // date. A coalesce here would quietly make an expiry unremovable.
  assert.match(update, /expiry_date = document_expiry,/i);
  assert.doesNotMatch(
    update,
    /expiry_date = coalesce\(/i,
    'update_vehicle_document is FULL-SET: a null expiry must clear the date, not leave it unchanged',
  );

  const del = sliceFrom(
    sql,
    'create or replace function public.delete_vehicle_document(',
    'revoke all on function public.delete_vehicle_document(uuid)',
  );
  assert.match(
    del,
    /public\.is_ledger_admin\(v_document\.ledger_id\)\s*or coalesce\(v_document\.created_by_member_id = v_actor_member_id, false\)/i,
  );
  // The caller deletes the objects (migration 138's coordination), so it must be told
  // which ones — and the paths must be collected BEFORE the cascade removes the rows.
  const pathsAt = del.search(/select coalesce\(array_agg\(vdp\.storage_path/i);
  const deleteAt = del.search(/delete from public\.vehicle_documents vd/i);
  assert.ok(pathsAt > 0 && deleteAt > pathsAt, 'the photo paths must be collected BEFORE the document row is deleted');
  assert.match(del, /'storage_paths', to_jsonb\(v_paths\)/i);

  // ── (2) the left() prefix rule on the photo RPC ─────────────────────────────
  const addPhoto = sliceFrom(
    sql,
    'create or replace function public.add_vehicle_document_photo',
    'revoke all on function public.add_vehicle_document_photo',
  );
  assert.match(addPhoto, /public\.is_ledger_member\(v_document\.ledger_id\)/i);
  assert.match(addPhoto, /v_expected_prefix := v_document\.ledger_id \|\| '\/' \|\| p_document_id::text \|\| '\/'/i);
  assert.match(addPhoto, /left\(p_storage_path, length\(v_expected_prefix\)\) <> v_expected_prefix/i);
  assert.doesNotMatch(addPhoto, /p_storage_path like/i);

  const delPhoto = sliceFrom(
    sql,
    'create or replace function public.delete_vehicle_document_photo',
    'revoke all on function public.delete_vehicle_document_photo',
  );
  assert.match(
    delPhoto,
    /public\.is_ledger_admin\(v_photo\.ledger_id\)\s*or coalesce\(v_photo\.created_by_member_id = v_actor_member_id, false\)/i,
  );
  assert.match(delPhoto, /'storage_path', v_photo\.storage_path/i);

  // Every RPC must be callable by signed-in clients and by nobody else.
  for (const fn of [
    'create_vehicle_document(text, text, date)',
    'update_vehicle_document(uuid, text, date)',
    'delete_vehicle_document(uuid)',
    'add_vehicle_document_photo(uuid, text)',
    'delete_vehicle_document_photo(uuid)',
  ]) {
    const esc = fn.replace(/[()]/g, '\\$&');
    assert.match(sql, new RegExp(`revoke all on function public\\.${esc} from public;`, 'i'));
    assert.match(sql, new RegExp(`revoke all on function public\\.${esc} from anon;`, 'i'));
    assert.match(sql, new RegExp(`grant execute on function public\\.${esc} to authenticated;`, 'i'));
  }

  // ── (4) storage half: prod-only, private, hardened ──────────────────────────
  const storage = sliceFrom(
    sql,
    "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\n    values (\n      'vehicle-documents'",
    'end\n$$;',
  );
  assert.match(storage, /'vehicle-documents', 'vehicle-documents', false, 5242880/i, 'the document bucket must stay PRIVATE');
  assert.match(storage, /array\['image\/jpeg', 'image\/png', 'image\/webp'\]/i);

  const uploadPolicy = sliceFrom(
    sql,
    'create policy "Vehicle documents are writable by workspace members"',
    'drop policy if exists "Vehicle documents are deletable by workspace members"',
  );
  assert.match(uploadPolicy, /cardinality\(storage\.foldername\(name\)\) = 2/i);
  assert.match(uploadPolicy, /from public\.vehicle_documents vd/i);
  assert.match(uploadPolicy, /vd\.ledger_id = \(storage\.foldername\(name\)\)\[1\]/i);
  assert.match(uploadPolicy, /vd\.id::text = \(storage\.foldername\(name\)\)\[2\]/i);

  const deletePolicy = sliceFrom(sql, 'create policy "Vehicle documents are deletable by workspace members"', 'end\n$$;');
  assert.match(deletePolicy, /owner_id::text = auth\.uid\(\)::text/i);
  assert.match(deletePolicy, /public\.is_ledger_admin\(\(storage\.foldername\(name\)\)\[1\]\)/i);

  // ── (5) the two re-declarations keep every sibling branch ───────────────────
  const quota = sliceFrom(
    sql,
    'create or replace function public.enforce_storage_upload_quota',
    '-- ── 6. Orphan sweep reader',
  );
  assert.match(quota, /if new\.bucket_id = 'fuel-receipts' then\s*v_limit := 3;/i, 'the 184 fuel-receipt cap must survive the 201 re-declaration');
  assert.match(quota, /elsif new\.bucket_id = 'incident-photos' then\s*v_limit := 10;/i, 'the 184 incident-photo cap must survive the 201 re-declaration');
  assert.match(quota, /elsif new\.bucket_id = 'vehicle-documents' then\s*v_limit := 5;/i);
  assert.match(
    quota,
    /perform pg_advisory_xact_lock\(hashtext\(new\.bucket_id \|\| ':' \|\| v_ledger \|\| '\/' \|\| v_entity\)\);/i,
    "184's advisory lock is what makes the cap race-free — a re-declaration that drops it silently restores the TOCTOU",
  );

  const reader = sliceFrom(
    sql,
    'create or replace function public.list_registered_storage_paths',
    'revoke all on function public.list_registered_storage_paths',
  );
  for (const table of ['fuel_payment_receipts', 'vehicle_incident_photos', 'vehicle_document_photos']) {
    assert.match(
      reader,
      new RegExp(`p_table = '${table}'`, 'i'),
      `list_registered_storage_paths must keep answering for ${table} — the orphan sweep deletes NOTHING for a ` +
        'bucket whose registered set it cannot read, so a dropped branch leaks objects instead of failing loudly',
    );
  }
  const readerGrants = sql.slice(sql.lastIndexOf('create or replace function public.list_registered_storage_paths'));
  assert.match(readerGrants, /grant execute on function public\.list_registered_storage_paths\(text, text, integer\) to service_role;/i);
  assert.match(readerGrants, /revoke all on function public\.list_registered_storage_paths\(text, text, integer\) from authenticated;/i);
  assert.doesNotMatch(
    readerGrants,
    /grant execute on function public\.list_registered_storage_paths\(text, text, integer\) to authenticated;/i,
    'the registered-path reader stays service_role only — it returns storage paths, i.e. two identifiers per row',
  );
}

// ── (6) no ledger_events row, and no storage.objects reference outside the guard ──
const migrationBody = migration.slice(0, migration.indexOf('insert into public.fuel_ledger_schema_migrations'));
assert.doesNotMatch(
  migrationBody,
  /insert into public\.ledger_events/i,
  'migration 201 deliberately writes no ledger_events row — adding one is a classification decision (GV-413), not a detail',
);

// Every `storage.` statement outside a plpgsql function body must sit inside the
// schema guard, or the plain-Postgres CI replays break (the migration-138 lesson).
// The two function bodies are exempt for 184's stated reason: plpgsql defers name
// resolution to execution.
{
  // Only `as $$ … $$;` FUNCTION bodies are stripped — the `do $$ … end $$;` guard block
  // itself must stay, because it is the thing being asserted.
  const withoutFunctions = migrationBody.replace(/as \$\$[\s\S]*?\n\$\$;/g, 'as $$FN$$;');
  const guardOpen = withoutFunctions.indexOf(
    "if exists (select 1 from information_schema.schemata where schema_name = 'storage') then",
  );
  assert.ok(guardOpen > 0, 'the storage half must be wrapped in the schema guard');
  const outsideGuard = withoutFunctions.slice(0, guardOpen).replace(/--[^\n]*/g, '');
  assert.doesNotMatch(
    outsideGuard,
    /storage\.(buckets|objects)/i,
    'a bare reference to storage.buckets/storage.objects outside the guard breaks every plain-Postgres replay',
  );
}

console.log(
  'ok - vehicle documents stay RPC-only and members-read, creator-or-admin on edit/delete, prefix-bound by left(), ' +
    'hard-deleted with their paths handed back, capped by the 184 trigger, swept by the 191 reader, and event-free',
);

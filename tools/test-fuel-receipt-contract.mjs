// Anti-drift contract for opt-in fuel receipts and their settled-close retention
// (GVM-537, migration 169).
//
// The two things this pins are OWNER DECISIONS, not implementation details, and both
// are the kind that a later "small tidy-up" can reverse without any other guard
// noticing:
//
//   (1) OPT-IN, ONE PER TANKNING, RPC-ONLY. The table must keep its UNIQUE fuel
//       payment reference (a second attach REPLACES, never accumulates) and must never
//       gain an insert/update/delete grant — a write grant would make the RPC gates
//       (membership, path prefix, uploader-or-admin) optional for anyone with a
//       PostgREST token, which is how a receipt could be attached to another
//       workspace's tankning.
//
//   (3) THE PAYMENT ROW IS THE LOCK ROOT (GV-436, migration 171). Both write RPCs
//       serialize on public.fuel_payments, and `for update` is one phrase that a
//       "tidy-up" removes without changing a single visible behaviour — until two
//       members attach at the same moment, both pass the first-attach gate, and the
//       loser's photo is orphaned in the bucket with no row pointing at it, out of
//       reach of both the client's delete and the settled-close sweep below.
//
//   (2) DELETED AT SETTLED CLOSE — and PAID_PENDING IS NOT SETTLED. The sweep's
//       predicate is one line of SQL that reads almost identically whether or not it
//       treats an unconfirmed claim as final, and the difference is a photo destroyed
//       while the creditor can still dispute the claim it would be argued with
//       (migration 090). The role matrix proves the BEHAVIOUR against a real Postgres;
//       this runs in the dependency-free gate on every commit, in both the migration
//       and the consolidated schema, so the two copies cannot drift apart either.
//
// Mirrors tools/test-incident-photo-storage-contract.mjs, which does the same job for
// the incident-photo bucket this feature is modelled on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/169_fuel_payment_receipts.sql', 'utf8');
const schema = readFileSync('supabase-schema.sql', 'utf8');

const sliceFrom = (sql, start, end) => {
  const from = sql.lastIndexOf(start);
  assert.ok(from >= 0, `expected to find ${JSON.stringify(start)}`);
  const to = sql.indexOf(end, from);
  assert.ok(to > from, `expected to find ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return sql.slice(from, to);
};

for (const sql of [migration, schema]) {
  // ── (1) opt-in, one receipt per tankning, RPC-only ───────────────────────────
  const table = sliceFrom(sql, 'create table if not exists public.fuel_payment_receipts', 'alter table public.fuel_payment_receipts enable row level security');
  assert.match(
    table,
    /fuel_payment_id uuid not null unique references public\.fuel_payments\(id\) on delete cascade/i,
    'the one-receipt-per-tankning rule is the UNIQUE on fuel_payment_id — a replace must not become a second row',
  );
  assert.match(table, /ledger_id text not null references public\.ledgers\(id\) on delete cascade/i);
  assert.match(table, /uploader_member_id uuid references public\.ledger_members\(id\) on delete set null/i);
  assert.match(table, /storage_path text not null unique/i);

  assert.doesNotMatch(
    sql,
    /grant (insert|update|delete)[^;]*on table public\.fuel_payment_receipts/i,
    'the receipt table must stay RPC-only: no client role may write it directly',
  );
  assert.match(sql, /grant select on table public\.fuel_payment_receipts to authenticated;/i);
  assert.match(
    sql,
    /create policy "Ledger members can read fuel payment receipts"[\s\S]*?using \(public\.is_ledger_member\(ledger_id\)\)/i,
  );

  // ── attach: membership + path prefix + uploader-or-admin replace ─────────────
  const attach = sliceFrom(sql, 'create or replace function public.attach_fuel_payment_receipt', 'revoke all on function public.attach_fuel_payment_receipt');
  assert.match(attach, /public\.is_ledger_member\(v_payment\.ledger_id\)/i);
  assert.match(attach, /v_actor_member_id := public\.current_ledger_member_id\(v_payment\.ledger_id\)/i);
  assert.match(attach, /v_payment\.deleted_at is not null/i);
  // left(), never LIKE: a ledger id may contain '_', which LIKE reads as a wildcard.
  assert.match(attach, /left\(p_storage_path, length\(v_expected_prefix\)\) <> v_expected_prefix/i);
  assert.doesNotMatch(attach, /p_storage_path like/i);
  assert.match(
    attach,
    /v_existing\.id is not null and not \(\s*public\.is_ledger_admin\(v_payment\.ledger_id\)\s*or coalesce\(v_existing\.uploader_member_id = v_actor_member_id, false\)/i,
    'overwriting another member\'s receipt must carry the same gate as deleting it',
  );
  assert.match(attach, /on conflict \(fuel_payment_id\) do update/i);
  assert.match(attach, /'replaced_storage_path'/i,
    'the caller deletes the storage object (migration 138\'s coordination), so it must be told which one');

  // ── detach: uploader or workspace admin, and it returns the path to delete ────
  const detach = sliceFrom(sql, 'create or replace function public.detach_fuel_payment_receipt', 'revoke all on function public.detach_fuel_payment_receipt');
  assert.match(
    detach,
    /public\.is_ledger_admin\(v_receipt\.ledger_id\)\s*or coalesce\(v_receipt\.uploader_member_id = v_actor_member_id, false\)/i,
  );
  assert.match(detach, /'storage_path', v_receipt\.storage_path/i);

  // ── storage half stays PROD-ONLY and hardened (139's shape, from day one) ─────
  const storage = sliceFrom(sql, "insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)\n    values (\n      'fuel-receipts'", 'end\n$$;');
  assert.match(storage, /'fuel-receipts', 'fuel-receipts', false, 5242880/i, 'the receipt bucket must stay PRIVATE');
  const uploadPolicy = sliceFrom(sql, 'create policy "Fuel receipts are writable by workspace members"', 'drop policy if exists "Fuel receipts are deletable by workspace members"');
  assert.match(uploadPolicy, /cardinality\(storage\.foldername\(name\)\) = 2/i);
  assert.match(uploadPolicy, /from public\.fuel_payments fp/i);
  assert.match(uploadPolicy, /fp\.id::text = \(storage\.foldername\(name\)\)\[2\]/i);
  const deletePolicy = sliceFrom(sql, 'create policy "Fuel receipts are deletable by workspace members"', 'end\n$$;');
  assert.match(deletePolicy, /owner_id::text = auth\.uid\(\)::text/i);
  assert.match(deletePolicy, /public\.is_ledger_admin\(\(storage\.foldername\(name\)\)\[1\]\)/i);

  // ── (2) the retention predicate, in BOTH halves of the dry-run split ──────────
  const retention = sliceFrom(sql, 'create or replace function public.run_operational_retention', "insert into public.fuel_ledger_schema_migrations");
  const settled = retention.match(
    /sp\.status = 'closed'\s*and not exists \(\s*select 1\s*from public\.settlement_requests sr\s*where sr\.period_id = sp\.id\s*and sr\.status not in \('paid', 'cancelled'\)\s*\)/gi,
  );
  assert.equal(
    settled?.length,
    2,
    'the settled-close predicate must appear in BOTH the dry-run count and the real delete, identically — a dry run that reports a different set than the cron destroys is worse than none',
  );
  // The whole point of the rule: 'requested' and 'paid_pending' are NOT settled.
  assert.doesNotMatch(
    retention,
    /sr\.status not in \([^)]*paid_pending/i,
    'paid_pending must NOT count as settled: migration 090 lets the creditor dispute the claim back to requested, and the receipt is what that argument needs',
  );
  assert.match(retention, /'purgedFuelReceipts', v_purged_fuel_receipts/i);
  assert.match(retention, /'fuelReceiptRetentionRule', 'closed_and_fully_paid'/i);
  // The one SQL-side storage delete on the platform, and it must stay behind the
  // plain-Postgres guard and behind dynamic EXECUTE (migration 138's lesson).
  assert.match(
    retention,
    /if v_purged_fuel_receipts > 0\s*and exists \(select 1 from information_schema\.schemata where schema_name = 'storage'\) then\s*execute 'delete from storage\.objects where bucket_id = ''fuel-receipts'' and name = any\(\$1\)'/i,
  );
  // Comments may talk about storage.objects; CODE may only reach it through that one
  // dynamic EXECUTE. Strip `--` comments and the EXECUTE literal, then nothing is left.
  const retentionCode = retention
    .replace(/--[^\n]*/g, '')
    .replace(/execute 'delete from storage\.objects[^']*(?:''[^']*)*'/i, '');
  assert.doesNotMatch(
    retentionCode,
    /storage\.objects/i,
    'a bare reference to storage.objects in this function would break the plain-Postgres CI replays',
  );

  // 165's classes must all survive the re-declaration (the GV-202 rule, mechanically).
  for (const key of [
    'staleExpoPushTokens', 'expiredLedgerEvents', 'deletedMessages', 'deletedBookings',
    'deletedRecurringTemplates', 'deletedTrips', 'deletedFuelPayments', 'deletedWorkspaceExpenses',
    'deletedVehicleRepairs', 'deletedOwnerActivity', 'purgedWorkspaces', 'deletedRateLimitCounters',
    'purgedNewsletterPending', 'newsletterPendingTtlHours',
  ]) {
    assert.match(retention, new RegExp(`'${key}'`), `run_operational_retention lost ${key} in the migration-169 re-declaration`);
  }
}

// ── (3) GV-436: the payment row is the LOCK ROOT for every receipt write ───────
// Migration 171 re-declares BOTH RPCs off their 169 definitions to close a TOCTOU race.
// The pins below deliberately read the LATEST definition of each function rather than
// 169's: sliceFrom() takes the LAST match, which in supabase-schema.sql is 171's mirror
// (appended at the end — last definition wins on replay), and the migration side is read
// from migration 171's own file for the same reason. Pinning 169 here would certify the
// version that has the bug.
const locking = readFileSync('supabase/migrations/171_receipt_rpc_locking.sql', 'utf8');

for (const [label, sql] of [['migration 171', locking], ['supabase-schema.sql', schema]]) {
  const attach = sliceFrom(sql, 'create or replace function public.attach_fuel_payment_receipt', 'revoke all on function public.attach_fuel_payment_receipt');
  assert.match(
    attach,
    /select \* into v_payment\s*from public\.fuel_payments fp\s*where fp\.id = p_fuel_payment_id\s*for update;/i,
    `${label}: attach must take the payment row FOR UPDATE. Without it two members both read ` +
      '"no receipt yet", both pass the first-attach gate, and the second upsert silently replaces the ' +
      "first — orphaning a storage object that only 'replaced_storage_path' could have got deleted",
  );

  const detach = sliceFrom(sql, 'create or replace function public.detach_fuel_payment_receipt', 'revoke all on function public.detach_fuel_payment_receipt');
  assert.match(
    detach,
    /perform 1\s*from public\.fuel_payments fp\s*where fp\.id = v_payment_id\s*for update;/i,
    `${label}: detach must take the SAME lock root as attach — the fuel_payments row — or the two RPCs ` +
      'exclude only their own twins',
  );
  // Lock-then-RE-READ ordering: the unlocked read exists ONLY to find the lock root, and
  // every authorization decision is made against the copy read AFTER the lock.
  const lockAt = detach.search(/perform 1\s*from public\.fuel_payments fp/i);
  const rereadAt = detach.search(/select \* into v_receipt\s*from public\.fuel_payment_receipts fpr/i);
  const gateAt = detach.search(/public\.is_ledger_admin\(v_receipt\.ledger_id\)/i);
  const deleteAt = detach.search(/delete from public\.fuel_payment_receipts fpr/i);
  assert.ok(lockAt > 0 && rereadAt > lockAt, `${label}: detach must RE-READ the receipt AFTER taking the lock`);
  assert.ok(
    gateAt > rereadAt && deleteAt > rereadAt,
    `${label}: detach's uploader-or-admin gate and its delete must be decided against the RE-READ copy — ` +
      'authorizing against a row a concurrent attach may already have replaced is the whole bug',
  );
  assert.match(
    detach,
    /select fpr\.fuel_payment_id into v_payment_id/i,
    `${label}: the unlocked first read must take ONLY the fuel_payment_id (the receipt's UNIQUE key, which a ` +
      'replace cannot change) — anything else read there is a decision made before the lock',
  );
}

// Same signatures as 169, so 171 is create-or-replace and no client changes: a DROP here
// would open a PGRST203/PGRST202 window for a shipped GVM-537 build.
assert.doesNotMatch(
  locking,
  /drop function[^\n]*fuel_payment_receipt/i,
  'migration 171 changes no signature — dropping either RPC would break shipped clients for no reason',
);
for (const fn of ['attach_fuel_payment_receipt(uuid, text)', 'detach_fuel_payment_receipt(uuid)']) {
  assert.match(locking, new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, '\\$&')} from public;`, 'i'));
  assert.match(locking, new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, '\\$&')} from anon;`, 'i'));
  assert.match(locking, new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, '\\$&')} to authenticated;`, 'i'));
}

// No new event_type: attaching a receipt is not feed news (see the migration header).
const migrationBody = migration.slice(0, migration.indexOf('insert into public.fuel_ledger_schema_migrations'));
assert.doesNotMatch(
  migrationBody,
  /insert into public\.ledger_events/i,
  'migration 169 deliberately writes no ledger_events row — adding one is a classification decision (GV-413), not a detail',
);

console.log('ok - fuel receipts stay opt-in, one per tankning, RPC-only, serialized on the fuel_payments lock root, and die at settled close (paid_pending does not count)');

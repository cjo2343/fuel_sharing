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

// No new event_type: attaching a receipt is not feed news (see the migration header).
const migrationBody = migration.slice(0, migration.indexOf('insert into public.fuel_ledger_schema_migrations'));
assert.doesNotMatch(
  migrationBody,
  /insert into public\.ledger_events/i,
  'migration 169 deliberately writes no ledger_events row — adding one is a classification decision (GV-413), not a detail',
);

console.log('ok - fuel receipts stay opt-in, one per tankning, RPC-only, and die at settled close (paid_pending does not count)');

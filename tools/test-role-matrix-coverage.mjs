// Unit test for the scanners behind the role-matrix coverage check (GV-379).
//
// The coverage check is only worth having if it recognises the exact defect it was
// written for and stays quiet on look-alikes, so both directions are asserted here.
// It runs Docker-free and sibling-free, which matters twice: a broken scanner then
// reports as a broken scanner rather than as a repo full of dead RPCs, and the logic
// stays covered in fuel_sharing's own CI, where neither Docker's replayed database nor
// the client repos are available. Same reasoning as tools/test-markup-hex-scan.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { coverageExceptions } from './role-matrix-coverage-allowlist.mjs';
import { exercisedFunctions, findClientCallers, lineCallsFunction } from './lib/rpc-call-scan.mjs';

// ── What the guard exercises ────────────────────────────────────────────────
{
  // The three shapes the role-matrix guard invokes RPCs from — a CASES entry, the SQL
  // fixture, and a hand-rolled concurrency block — must all read as exercised.
  const source = `
    rpcCase({ name: 'x', actor: A, op: "perform public.set_ledger_member_active_admin('w', id, false)", expect: 'ok' }),
    const seed = \`select public.create_private_ledger_workspace('Bil', 'a@b.dk');\`;
    const close = psql("select public.close_settlement_period('w', p, s);");
  `;
  const found = exercisedFunctions(source);
  assert.ok(found.has('set_ledger_member_active_admin'));
  assert.ok(found.has('create_private_ledger_workspace'));
  assert.ok(found.has('close_settlement_period'));
}

// A function named only in prose is DISCUSSED, not exercised. Getting this wrong would
// mark every function the long header essay mentions as covered — which would in turn
// declare them all dead, since none has a client call site from this repo.
{
  const commentary = [
    '// GV-277 built the feature on public.set_ledger_member_active_admin(), which is dead.',
    '  -- close_settlement_period calls public.calculate_period_entry_fingerprint(a, b) in-SQL.',
    ' * The trigger public.enforce_settlement_entry_lock() rejects the write.',
  ].join('\n');
  assert.equal(exercisedFunctions(commentary).size, 0);
}

// Comment stripping must not swallow real code that merely follows a comment line.
{
  const mixed = '// exercises the admin toggle below\nperform public.upsert_ledger_member_admin(a, b);';
  assert.deepEqual([...exercisedFunctions(mixed)], ['upsert_ledger_member_admin']);
}

// ── What counts as a client call ────────────────────────────────────────────
// Both conventions in the two clients. Missing either one would silently mark that
// convention's targets dead — the precise failure this check exists to prevent.
assert.ok(lineCallsFunction("  return supabase.rpc('upsert_ledger_member_admin', payload);", 'upsert_ledger_member_admin'));
assert.ok(lineCallsFunction("  due = await sbRpc(env, 'claim_due_confirm_reminders', { p_limit: 200 });", 'claim_due_confirm_reminders'));
assert.ok(lineCallsFunction('  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/check_owner_rate_limit`, {', 'check_owner_rate_limit'));
// The lifecycle endpoint calls sbRpc(env, rpc, args) with a VARIABLE; the names are
// still literals at the table that defines them, which is what keeps them visible.
assert.ok(lineCallsFunction("  'soft-delete': { rpc: 'admin_soft_delete_workspace', audit: 'owner.workspace.decommission' },", 'admin_soft_delete_workspace'));

// Prose naming an RPC is not a call. This is exactly how set_ledger_member_active_admin
// could look alive: several client files mention RPC names while explaining behaviour.
assert.equal(lineCallsFunction("  // the backend (apply_payment_status_action) stores that id in metadata.", 'apply_payment_status_action'), false);
assert.equal(lineCallsFunction("   *  a ledger-wide delete, `production_activity_reset`, was dropped", 'production_activity_reset'), false);
// A longer name that merely contains a shorter one is not a call to the shorter one.
assert.equal(lineCallsFunction("  supabase.rpc('transition_settlement_requests_status', a);", 'transition_settlement_request_status'), false);

// ── The repo scan ───────────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv379-'));
  fs.mkdirSync(path.join(dir, 'src/types'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'src/helpers.ts'), "await supabase.rpc('upsert_ledger_member_admin', { p: 1 });\n");
  // The vendored generated types declare EVERY RPC in the schema. Counting them would
  // make every function look called and the whole check a no-op.
  fs.writeFileSync(path.join(dir, 'src/types/database.generated.ts'), 'set_ledger_member_active_admin: { Args: {} }\n');
  fs.writeFileSync(path.join(dir, 'src/types/database.ts'), "rpc('set_ledger_member_active_admin')\n");
  // Dependency trees are not client code.
  fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), "rpc('set_ledger_member_active_admin')\n");

  const hits = findClientCallers(dir, ['upsert_ledger_member_admin', 'set_ledger_member_active_admin']);
  assert.equal(hits.get('upsert_ledger_member_admin').length, 1);
  assert.equal(hits.get('upsert_ledger_member_admin')[0].file, 'src/helpers.ts');
  assert.equal(hits.get('upsert_ledger_member_admin')[0].line, 1);
  assert.deepEqual(hits.get('set_ledger_member_active_admin'), [], 'generated types and node_modules must never count as call sites');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── The reviewed-exception list ─────────────────────────────────────────────
// Shape and expiry are re-checked against the live database by the guard itself; what
// is asserted here is what can be known without Docker, so a malformed entry is caught
// on every commit rather than only in the heavy job.
{
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const seen = new Set();
  for (const [i, entry] of coverageExceptions.entries()) {
    const where = `coverageExceptions[${i}]`;
    assert.match(entry.fn ?? '', /^[a-z0-9_]+$/, `${where}: fn must be an unqualified function name`);
    assert.ok(!seen.has(entry.fn), `${where}: duplicate entry for ${entry.fn}`);
    seen.add(entry.fn);
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.trim().length >= 40,
      `${where} (${entry.fn}): reason must explain the exception to a reviewer with no context`,
    );
    assert.match(entry.reviewBy ?? '', ISO_DATE, `${where} (${entry.fn}): reviewBy must be YYYY-MM-DD`);
    assert.ok(
      Number.isFinite(Date.parse(`${entry.reviewBy}T00:00:00Z`)),
      `${where} (${entry.fn}): reviewBy must be a real date`,
    );
  }
}

// The guard's own source must still exercise every function the list excuses — a
// promise the allow-list makes that is checkable without Docker. Catches an entry left
// behind when its case is deleted, in the cheap job rather than the heavy one.
{
  const guard = fs.readFileSync(new URL('./test-rls-role-matrix.mjs', import.meta.url), 'utf8');
  const exercised = exercisedFunctions(guard);
  for (const entry of coverageExceptions) {
    assert.ok(
      exercised.has(entry.fn),
      `role-matrix-coverage-allowlist.mjs (${entry.fn}): STALE — the role-matrix guard no longer exercises it. Delete the entry.`,
    );
  }
}

console.log(`✅ role-matrix coverage scanners OK (${coverageExceptions.length} reviewed exception(s) checked).`);

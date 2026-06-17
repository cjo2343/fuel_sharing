import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");

function sliceFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function testFullReconciliationLedgerPayloadHasSlug() {
  const fn = sliceFunction(app, "syncNormalizedTablesFromJson");
  assert.match(fn, /const ledgerPayload = \{[\s\S]*?id: ledgerId,[\s\S]*?slug: String\(ledgerId \|\| getConfiguredLedgerId\(\)\)\.trim\(\) \|\| getConfiguredLedgerId\(\)/);
  assert.match(fn, /await upsertLedgerSettings\(ledgerPayload\)/);
  assert.ok(
    fn.indexOf("slug: String(ledgerId || getConfiguredLedgerId()).trim() || getConfiguredLedgerId()") < fn.indexOf("await upsertLedgerSettings(ledgerPayload)"),
    "full JSON-to-table reconciliation must set ledgers.slug before the guarded ledger upsert"
  );
}

function testAdvancedStressStillUsesFullReconciliationGuard() {
  assert.match(app, /markNormalizedReconciliationDirty\("advanced-stress"\)/);
  assert.match(app, /await saveSupabaseState\(\{ reason: "advanced-stress" \}\)/);
  assert.match(app, /Refusing to upsert ledgers without slug/);
}

testFullReconciliationLedgerPayloadHasSlug();
testAdvancedStressStillUsesFullReconciliationGuard();
console.log("Advanced stress ledger slug guard check passed.");

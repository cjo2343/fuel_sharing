import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("app.js", "utf8");
const adminTools = readFileSync("admin-tools.js", "utf8");

function bodyOfFunction(source, functionName) {
  const start = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const paramsEnd = source.indexOf(")", start);
  const braceStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, index + 1);
    }
  }
  throw new Error(`Could not parse ${functionName}`);
}

function testMemberManagementFailsClosedWhenRpcMissing() {
  const saveManagedMember = bodyOfFunction(app, "saveManagedMember");
  const setManagedMemberActive = bodyOfFunction(app, "setManagedMemberActive");
  const addManagedMember = bodyOfFunction(app, "addManagedMember");
  for (const source of [saveManagedMember, setManagedMemberActive, addManagedMember]) {
    assert.match(source, /Apply the latest Supabase schema/);
    assert.doesNotMatch(source, /\.from\("ledger_members"\)\s*\.(insert|update|upsert|delete)/s);
  }
  assert.match(app, /upsert_ledger_member_admin/);
  assert.match(app, /set_ledger_member_active_admin/);
}

function testGeneratedTestRowPurgeFailsClosedWhenRpcMissing() {
  const purgeFunction = bodyOfFunction(adminTools, "purgeSoftDeletedGeneratedTestRows");
  assert.match(purgeFunction, /purge_generated_test_rows/);
  assert.match(purgeFunction, /Apply the latest Supabase schema/);
  assert.doesNotMatch(purgeFunction, /\.from\("trips"\)\s*\.delete/s);
  assert.doesNotMatch(purgeFunction, /\.from\("fuel_payments"\)\s*\.delete/s);
}

testMemberManagementFailsClosedWhenRpcMissing();
console.log("ok - testMemberManagementFailsClosedWhenRpcMissing");
testGeneratedTestRowPurgeFailsClosedWhenRpcMissing();
console.log("ok - testGeneratedTestRowPurgeFailsClosedWhenRpcMissing");

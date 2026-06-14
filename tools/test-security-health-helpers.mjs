#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadHelpers() {
  const context = { window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('security-health-helpers.js', 'utf8'), context, { filename: 'security-health-helpers.js' });
  return context.window.FuelSecurityHealth;
}

function testMissingRpcErrorDetection() {
  const helper = loadHelpers();
  assert.equal(helper.isMissingHealthcheckRpcError({ code: 'PGRST202', message: 'Could not find the function' }), true);
  assert.equal(helper.isMissingHealthcheckRpcError({ code: '40001', message: 'Open settlement period was not found' }), false);
}

function testRpcProbeNormalization() {
  const helper = loadHelpers();
  const expected = helper.normalizeHealthcheckRpcResult({ data: { ok: true, close_settlement_period_exists: true, ledger_id: 'main-car' } });
  assert.equal(expected.ok, true);
  assert.match(expected.detail, /close_settlement_period exists/);

  const missingHealthcheck = helper.normalizeHealthcheckRpcResult({ error: { code: 'PGRST202', message: 'Could not find fuel_ledger_healthcheck' } });
  assert.equal(missingHealthcheck.ok, false);
  assert.match(missingHealthcheck.detail, /fuel_ledger_healthcheck is missing/);

  const missingClose = helper.normalizeHealthcheckRpcResult({ data: { ok: true, close_settlement_period_exists: false } });
  assert.equal(missingClose.ok, false);
  assert.match(missingClose.detail, /close_settlement_period is missing/);
}

function testLocalSecurityChecks() {
  const helper = loadHelpers();
  const local = helper.buildLocalSecurityChecks({ hasSupabaseConfig: false });
  assert.equal(local.every((check) => check.ok), true);
  assert.equal(local.some((check) => check.name === 'Local-only mode is explicit'), true);

  const hosted = helper.buildLocalSecurityChecks({
    hasSupabaseConfig: true,
    hasSession: true,
    hasMemberProfile: true,
    isAdmin: true,
    normalizedTableStatus: { checked: true, ok: true, message: 'healthy' }
  });
  assert.equal(hosted.every((check) => check.ok), true, JSON.stringify(hosted));
}

function testSupabaseSecurityScenarioChecks() {
  const helper = loadHelpers();
  const checks = helper.buildSupabaseSecurityChecks({
    status: {
      checked: true,
      checks: [
        { ok: true, name: 'Session is fresh' },
        { ok: true, name: 'RPC exists' }
      ]
    }
  });
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));
  assert.equal(checks.some((check) => check.name === 'Supabase security health passed'), true);

  const missing = helper.buildSupabaseSecurityChecks({ status: { checked: false } });
  assert.equal(missing[0].ok, false);
}

const tests = [
  testMissingRpcErrorDetection,
  testRpcProbeNormalization,
  testLocalSecurityChecks,
  testSupabaseSecurityScenarioChecks
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

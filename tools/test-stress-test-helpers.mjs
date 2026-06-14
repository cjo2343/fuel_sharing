#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadHelpers() {
  const context = { window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('stress-test-helpers.js', 'utf8'), context, { filename: 'stress-test-helpers.js' });
  return context.window.FuelTestLab;
}

function testGeneratedSummaryAndDetection() {
  const lab = loadHelpers();
  const state = {
    members: ['Christian', 'Marie'],
    trips: [{ id: 'auto-test-trip-1', driver: 'Christian', startKm: 1, endKm: 2, participants: ['Christian'] }],
    fuel: [{ id: 'fuel-real', payer: 'Christian', amount: 10 }, { id: 'fuel-2', station: '[AUTO TEST] station', payer: 'Marie', amount: 20 }],
    bookings: [{ id: 'booking-1', purpose: '[AUTO TEST] generated booking' }],
    closedPeriods: [],
    paymentStatuses: { 'auto-test-payment': { status: 'requested' } }
  };
  const summary = lab.generatedDataSummary(state);
  assert.equal(summary.trips, 1);
  assert.equal(summary.fuel, 1);
  assert.equal(summary.bookings, 1);
  assert.equal(summary.paymentStatuses, 1);
  assert.equal(summary.total, 4);
}

function testInvariantChecksPassForBalancedLedger() {
  const lab = loadHelpers();
  const state = {
    members: ['Christian', 'Marie'],
    trips: [{ id: 'trip-1', driver: 'Christian', startKm: 100, endKm: 120, participants: ['Christian', 'Marie'] }],
    fuel: [{ id: 'fuel-1', payer: 'Christian', amount: 100 }],
    bookings: [],
    closedPeriods: [],
    paymentStatuses: {}
  };
  const ledger = {
    totalPaid: 100,
    people: [
      { name: 'Christian', cost: 50, paid: 100, balance: 50 },
      { name: 'Marie', cost: 50, paid: 0, balance: -50 }
    ],
    settlements: [{ from: 'Marie', to: 'Christian', amount: 50 }]
  };
  const checks = lab.runStateInvariantChecks({ state, ledger });
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));
}

function testInvariantChecksCatchBadData() {
  const lab = loadHelpers();
  const state = {
    members: ['Christian'],
    trips: [
      { id: 'trip-1', driver: 'Unknown', startKm: 200, endKm: 100, participants: ['Unknown'] },
      { id: 'trip-1', driver: 'Christian', startKm: 1, endKm: 2, participants: ['Christian'] }
    ],
    fuel: [{ id: 'fuel-1', payer: 'Unknown', amount: 10 }],
    bookings: [],
    closedPeriods: [],
    paymentStatuses: {}
  };
  const ledger = { totalPaid: 10, people: [{ name: 'Christian', cost: 0, paid: 0, balance: 2 }], settlements: [{ from: 'Christian', to: 'Christian', amount: -1 }] };
  const checks = lab.runStateInvariantChecks({ state, ledger });
  assert.equal(checks.some((check) => !check.ok && check.name === 'Trip IDs are unique'), true);
  assert.equal(checks.some((check) => !check.ok && check.name === 'Trip distances are non-negative'), true);
  assert.equal(checks.some((check) => !check.ok && check.name === 'Trip people are known members'), true);
  assert.equal(checks.some((check) => !check.ok && check.name === 'Fuel payers are known members'), true);
  assert.equal(checks.some((check) => !check.ok && check.name === 'Ledger net balances sum to 0.00'), true);
}

function testReportRenderingEscapesHtml() {
  const lab = loadHelpers();
  const report = lab.buildTestLabReport({
    id: 'abc',
    scenario: '<bad>',
    checks: [{ ok: false, name: '<script>', detail: 'x > y' }]
  });
  const html = lab.renderReportHtml(report);
  assert.equal(report.ok, false);
  assert.match(html, /&lt;bad&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
}

const tests = [
  testGeneratedSummaryAndDetection,
  testInvariantChecksPassForBalancedLedger,
  testInvariantChecksCatchBadData,
  testReportRenderingEscapesHtml
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

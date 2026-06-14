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
      { name: 'Christian', tripCost: 50, fuelPaid: 100, net: 50, balance: 50 },
      { name: 'Marie', tripCost: 50, fuelPaid: 0, net: -50, balance: -50 }
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

function testReportIncludesSyncMetadata() {
  const lab = loadHelpers();
  const report = lab.buildTestLabReport({
    id: 'report-1',
    createdBy: 'Christian',
    browser: 'UnitTest',
    syncedAt: '2026-06-14T18:45:00.000Z',
    checks: [{ ok: true, name: 'ok' }]
  });
  assert.equal(report.createdBy, 'Christian');
  assert.equal(report.browser, 'UnitTest');
  assert.equal(report.syncedAt, '2026-06-14T18:45:00.000Z');
  const html = lab.renderReportHtml(report);
  assert.match(html, /Christian/);
  assert.match(html, /synced/);
}

function testReportRenderingIsCompactAndExpandable() {
  const lab = loadHelpers();
  const report = lab.buildTestLabReport({
    id: 'compact-report',
    scenario: 'full-test-lab',
    scenarios: [
      { id: 'ledger', name: 'Ledger invariants', ok: false, passedCount: 1, failedCount: 1 },
      { id: 'runtime', name: 'Runtime/PWA metadata', ok: true, passedCount: 3, failedCount: 0 }
    ],
    checks: [
      { ok: true, scenario: 'Runtime/PWA metadata', name: 'Build info is loaded' },
      { ok: false, scenario: 'Ledger invariants', name: 'Rounded trip costs match fuel paid', detail: '0.00 vs 1800.00' }
    ]
  });
  const html = lab.renderReportHtml(report);
  assert.match(html, /Failed checks/);
  assert.match(html, /Show all 2 checks/);
  assert.match(html, /test-lab-scenario-chips/);
  assert.match(html, /Rounded trip costs match fuel paid/);
}

function testRuntimePwaUnavailableCacheMetadataIsNotHardFailure() {
  const lab = loadHelpers();
  const checks = lab.runRuntimePwaChecks({
    buildInfo: { version: 'test', expectedServiceWorkerCache: 'fuel-ledger-test' },
    runtimeGlobals: { FuelLedgerModel: {}, FuelLocationPrivacy: {}, FuelPeriodClosing: {}, FuelTestLab: {}, permissionHelpers: {} }
  });
  assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks));
  assert.equal(checks.some((check) => check.name === 'Service worker cache metadata is available'), true);
}


function testScenarioMatrixCoversExpandedLogic() {
  const lab = loadHelpers();
  const state = {
    members: ['Christian', 'Marie'],
    trips: [{ id: 'trip-1', driver: 'Christian', startKm: 100, endKm: 120, participants: ['Christian', 'Marie'] }],
    fuel: [{ id: 'fuel-1', payer: 'Christian', amount: 100, liters: 8 }],
    bookings: [{ id: 'booking-1', member: 'Christian', start: '2026-06-14T10:00', end: '2026-06-14T11:00' }],
    closedPeriods: [],
    paymentStatuses: {},
    testLabReports: [{ id: 'previous-report', syncedAt: '2026-06-14T18:45:00.000Z' }]
  };
  const ledger = {
    totalPaid: 100,
    people: [
      { name: 'Christian', cost: 50, paid: 100, balance: 50 },
      { name: 'Marie', cost: 50, paid: 0, balance: -50 }
    ],
    settlements: [{ from: 'Marie', to: 'Christian', amount: 50 }]
  };
  const permissionHelpers = {
    canManageTripEntryForProfile: (entry, profile) => profile.role === 'admin' || entry.driver === profile.name,
    canManageFuelEntryForProfile: (entry, profile) => profile.role === 'admin' || entry.payer === profile.name,
    canManageBookingEntryForProfile: (entry, profile) => profile.role === 'admin' || entry.member === profile.name,
    canManageSettlementRequestForProfile: (settlement, profile) => profile.role === 'admin' || settlement.to === profile.name,
    canMarkSettlementPaidForProfile: (settlement, profile) => profile.role === 'admin' || settlement.from === profile.name,
    summarizeMemberAdminProtection: () => ({ canDeactivate: false, canDemote: false })
  };
  const locationPrivacy = {
    buildFuelLocationPayload: (input = {}) => {
      if (input.mode === 'no-coordinates') return { location: null, stationInfo: null };
      if (input.mode === 'full') return { location: { latitude: 1, longitude: 2 }, stationInfo: { latitude: 3, longitude: 4 } };
      return { location: null, stationInfo: { latitude: 3, longitude: 4 } };
    },
    inferFuelLocationPrivacyMode: (fuel) => fuel.location ? 'full' : 'station-only'
  };
  const dataStore = {
    validateBackupPayload: (payload) => payload?.state?.members?.length ? { ok: true, errors: [] } : { ok: false, errors: ['bad'] }
  };
  const scenarios = lab.runScenarioMatrixChecks({
    state,
    ledger,
    permissionHelpers,
    locationPrivacy,
    dataStore,
    transition: (previous, next) => previous === 'open' && next === 'paid' ? false : !(previous === 'paid' && next === 'requested'),
    buildInfo: { version: 'test', serviceWorkerCache: 'cache', expectedServiceWorkerCache: 'cache' },
    securityHealthHelper: { buildSupabaseSecurityChecks: ({ status }) => status.checked ? [{ ok: true, name: 'Security checked' }] : [{ ok: false, name: 'Security missing' }] },
    supabaseSecurityStatus: { checked: true, checks: [{ ok: true, name: 'RPC available' }] },
    runtimeGlobals: { FuelLedgerModel: {}, FuelLocationPrivacy: {}, FuelPeriodClosing: {}, FuelTestLab: {}, permissionHelpers: {} }
  });
  assert.equal(JSON.stringify(scenarios.map((item) => item.id)), JSON.stringify(['ledger', 'payments', 'permissions', 'backup', 'privacy', 'bookings', 'sync', 'security', 'runtime']));
  assert.equal(scenarios.every((scenario) => scenario.failedCount === 0), true, JSON.stringify(scenarios));
  const flattened = lab.flattenScenarioChecks(scenarios);
  assert.equal(flattened.length > scenarios.length, true);
  assert.equal(flattened.every((check) => check.scenario), true);
}

const tests = [
  testGeneratedSummaryAndDetection,
  testInvariantChecksPassForBalancedLedger,
  testInvariantChecksCatchBadData,
  testReportRenderingEscapesHtml,
  testReportIncludesSyncMetadata,
  testReportRenderingIsCompactAndExpandable,
  testRuntimePwaUnavailableCacheMetadataIsNotHardFailure,
  testScenarioMatrixCoversExpandedLogic
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

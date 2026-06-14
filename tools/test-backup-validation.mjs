import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadDataStoreContext() {
  const context = vm.createContext({
    console,
    window: {
      clearTimeout: () => undefined,
      setTimeout: () => 0,
      crypto: { randomUUID: () => "test-id" }
    },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined
    },
    structuredClone: (value) => JSON.parse(JSON.stringify(value))
  });
  vm.runInContext(readFileSync("data-store.js", "utf8"), context, { filename: "data-store.js" });
  return context.window.FuelDataStore;
}

function testValidBackupWrapperIsAccepted() {
  const dataStore = loadDataStoreContext();
  const result = dataStore.validateBackupPayload({
    exportedAt: "2026-06-14T00:00:00.000Z",
    app: "Fuel Ledger",
    version: 1,
    state: {
      members: ["Christian", "Marie"],
      trips: [{ driver: "Christian", startKm: 100, endKm: 150, participants: ["Christian", "Marie"] }],
      fuel: [{ payer: "Christian", amount: "200", liters: "10" }],
      closedPeriods: []
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.state.members.length, 2);
}

function testMissingMembersIsRejected() {
  const dataStore = loadDataStoreContext();
  const result = dataStore.validateBackupPayload({ trips: [], fuel: [] });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /at least one member/);
}

function testMalformedCollectionsAreRejected() {
  const dataStore = loadDataStoreContext();
  const result = dataStore.validateBackupPayload({
    members: ["Christian"],
    trips: {},
    fuel: "bad",
    closedPeriods: [{ settlements: {} }]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /trips/);
  assert.match(result.errors.join(" "), /fuel/);
  assert.match(result.errors.join(" "), /settlements/);
}

function testInvalidTripAndFuelValuesAreRejected() {
  const dataStore = loadDataStoreContext();
  const result = dataStore.validateBackupPayload({
    members: ["Christian", "Marie"],
    trips: [{ driver: "Christian", startKm: 200, endKm: 100, participants: "Christian" }],
    fuel: [{ payer: "Christian", amount: -1, liters: "abc" }],
    closedPeriods: []
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /ends before it starts/);
  assert.match(result.errors.join(" "), /participants/);
  assert.match(result.errors.join(" "), /non-negative numeric amount/);
  assert.match(result.errors.join(" "), /liters/);
}

function testUnknownPeopleAreWarningsNotErrors() {
  const dataStore = loadDataStoreContext();
  const result = dataStore.validateBackupPayload({
    members: ["Christian"],
    trips: [{ driver: "Unknown", startKm: 100, endKm: 150, participants: ["Christian", "Unknown"] }],
    fuel: [{ payer: "Someone", amount: 50, liters: 3 }],
    closedPeriods: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join(" "), /unknown driver/i);
  assert.match(result.warnings.join(" "), /unknown payer/i);
}

const tests = [
  testValidBackupWrapperIsAccepted,
  testMissingMembersIsRejected,
  testMalformedCollectionsAreRejected,
  testInvalidTripAndFuelValuesAreRejected,
  testUnknownPeopleAreWarningsNotErrors
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

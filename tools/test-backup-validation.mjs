import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadDataStoreContext({ realTimers = false } = {}) {
  const context = vm.createContext({
    console,
    window: {
      clearTimeout: realTimers ? clearTimeout : () => undefined,
      setTimeout: realTimers ? setTimeout : () => 0,
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

async function testRemoteSaveQueueSerializesAsyncSaves() {
  const dataStore = loadDataStoreContext({ realTimers: true });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const resolvers = [];
  const queue = dataStore.createRemoteSaveQueue(() => new Promise((resolve) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    resolvers.push(() => {
      active -= 1;
      resolve();
    });
  }), 0);

  queue();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);

  queue();
  queue();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, "queued saves should not overlap an active remote save");

  resolvers.shift()();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2, "coalesced save should run after the active save finishes");
  assert.equal(maxActive, 1);

  resolvers.shift()();
}

const tests = [
  testValidBackupWrapperIsAccepted,
  testMissingMembersIsRejected,
  testMalformedCollectionsAreRejected,
  testInvalidTripAndFuelValuesAreRejected,
  testUnknownPeopleAreWarningsNotErrors,
  testRemoteSaveQueueSerializesAsyncSaves
];

for (const test of tests) {
  await test();
  console.log(`ok - ${test.name}`);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadSettlementContext(overrides = {}) {
  const defaults = {
    fuelConsumption: 5.3,
    fuelFallbackPrice: 14.5,
    fuelWarningThreshold: 70
  };
  const baseState = {
    members: ["Christian", "Marie", "Jonas"],
    trips: [],
    fuel: [],
    closedPeriods: [],
    fuelConsumption: defaults.fuelConsumption,
    fuelFallbackPrice: defaults.fuelFallbackPrice,
    fuelWarningThreshold: defaults.fuelWarningThreshold,
    ...overrides
  };

  const context = vm.createContext({
    console,
    state: baseState,
    defaults,
    latestFuelPrice: null,
    getLedgerPeriod: () => ({ start: "2026-01-01", end: "2026-01-31" })
  });

  vm.runInContext(readFileSync("utils.js", "utf8"), context, { filename: "utils.js" });
  vm.runInContext(readFileSync("settlement-calculations.js", "utf8"), context, {
    filename: "settlement-calculations.js"
  });
  return context;
}

function testSharedTripCreatesSingleSettlement() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: 1000,
        endKm: 1100,
        participants: ["Christian", "Marie"]
      }
    ],
    fuel: [{ id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: 200, liters: 10 }]
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.people.Christian.km, 50);
  assert.equal(ledger.people.Marie.km, 50);
  assert.equal(ledger.people.Christian.fuelPaid, 200);
  assert.equal(ledger.people.Christian.tripCost, 100);
  assert.equal(ledger.people.Marie.tripCost, 100);
  assert.equal(ledger.people.Christian.net, 100);
  assert.equal(ledger.people.Marie.net, -100);
  assert.deepEqual(plain(ledger.settlements), [{ from: "Marie", to: "Christian", amount: 100 }]);
}

function testParticipantDeduplicationAndUnknownParticipantFiltering() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: 0,
        endKm: 90,
        participants: ["Christian", "Christian", "Unknown"]
      }
    ],
    fuel: [{ id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: 90, liters: 6 }]
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.people.Christian.km, 90);
  assert.equal(ledger.totalShareKm, 90);
  assert.equal(ledger.people.Marie.km, 0);
  assert.deepEqual(plain(ledger.settlements), []);
}

function testStringFuelAmountsAndUnknownPayersAreSafe() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: "1000",
        endKm: "1100",
        participants: ["Christian", "Marie"]
      }
    ],
    fuel: [
      { id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: "100", liters: "5" },
      { id: "fuel-2", payer: "Christian", date: "2026-01-06", amount: "50", liters: "2.5" },
      { id: "fuel-3", payer: "Unknown", date: "2026-01-07", amount: "999", liters: "50" }
    ]
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.people.Christian.fuelPaid, 150);
  assert.equal(ledger.totalPaid, 150);
  assert.equal(ledger.fuelByPerson.Christian, 150);
  assert.equal(ledger.fuelByPerson.Unknown, undefined);
  assert.deepEqual(plain(ledger.settlements), [{ from: "Marie", to: "Christian", amount: 75 }]);
}

function testNegativeTripDistanceDoesNotReduceBalances() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: 1100,
        endKm: 1000,
        participants: ["Christian", "Marie"]
      }
    ],
    fuel: [{ id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: 100, liters: 5 }]
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.totalTripKm, 0);
  assert.equal(ledger.totalShareKm, 0);
  assert.equal(ledger.people.Christian.tripCost, 0);
  assert.deepEqual(plain(ledger.settlements), [{ from: "Marie", to: "Christian", amount: 0 }].filter((item) => item.amount > 0));
}

function testHistoricalStatsTolerateMissingClosedPeriods() {
  const context = loadSettlementContext({
    closedPeriods: null,
    trips: [{ driver: "Christian", date: "2026-01-05", startKm: 0, endKm: 100, participants: ["Christian"] }],
    fuel: [{ payer: "Christian", date: "2026-01-05", amount: 200, liters: 10 }]
  });

  const stats = context.calculateHistoricalFuelStats({ currentTrips: context.state.trips, currentFuel: context.state.fuel });

  assert.equal(stats.totalTripKm, 100);
  assert.equal(stats.totalPaid, 200);
  assert.equal(stats.totalLiters, 10);
  assert.equal(stats.costPerKm, 2);
  assert.equal(stats.litersPer100Km, 10);
}

const tests = [
  testSharedTripCreatesSingleSettlement,
  testParticipantDeduplicationAndUnknownParticipantFiltering,
  testStringFuelAmountsAndUnknownPayersAreSafe,
  testNegativeTripDistanceDoesNotReduceBalances,
  testHistoricalStatsTolerateMissingClosedPeriods
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

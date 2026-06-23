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

function testFullTankToFullTankConsumptionIgnoresFirstFill() {
  // A large first brim fill (60 L) fuels driving before the timeline starts, so
  // total/total would read high. Full-to-full counts only the closing brim fill
  // (30 L over 600 km) and the partial in between: (10 + 30) / 600 km = 6.67.
  const context = loadSettlementContext({
    trips: [{ driver: "Christian", date: "2026-01-05", startKm: 1000, endKm: 1600, participants: ["Christian"] }],
    fuel: [
      { id: "f1", payer: "Christian", date: "2026-01-01", amount: 900, liters: 60, odometer: 1000, fullTank: true },
      { id: "f2", payer: "Christian", date: "2026-01-10", amount: 150, liters: 10, odometer: 1300 },
      { id: "f3", payer: "Christian", date: "2026-01-20", amount: 450, liters: 30, odometer: 1600, fullTank: true }
    ]
  });

  const stats = context.calculateHistoricalFuelStats({ currentTrips: context.state.trips, currentFuel: context.state.fuel });

  assert.equal(stats.consumptionMethod, "full-to-full");
  assert.equal(stats.fullTankSegments, 1);
  assert.equal(stats.fullTankSegmentKm, 600);
  assert.equal(stats.litersPer100Km, 6.7); // (10 + 30) / 600 * 100 rounded, not 100/600*100
  assert.equal(stats.litersPer100KmRough, context.round(100 / 600 * 100));
}

function testConsumptionFallsBackToRoughWithoutFullTankPair() {
  const context = loadSettlementContext({
    trips: [{ driver: "Christian", date: "2026-01-05", startKm: 0, endKm: 200, participants: ["Christian"] }],
    fuel: [{ id: "f1", payer: "Christian", date: "2026-01-05", amount: 200, liters: 12, odometer: 200, fullTank: true }]
  });

  const stats = context.calculateHistoricalFuelStats({ currentTrips: context.state.trips, currentFuel: context.state.fuel });

  assert.equal(stats.consumptionMethod, "rough");
  assert.equal(stats.fullTankSegments, 0);
  assert.equal(stats.litersPer100Km, 6); // 12 / 200 * 100, total/total fallback
}

function testMalformedTripAndFuelArraysAreSafe() {
  const context = loadSettlementContext({
    trips: null,
    fuel: null
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.totalTripKm, 0);
  assert.equal(ledger.totalPaid, 0);
  assert.deepEqual(plain(ledger.settlements), []);
}

function testReceiptMetricsIgnoreUnknownFuelPayers() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: 0,
        endKm: 100,
        participants: ["Christian"]
      }
    ],
    fuel: [
      { id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: 100, liters: 5 },
      { id: "fuel-2", payer: "Unknown", date: "2026-01-06", amount: 900, liters: 45 }
    ]
  });

  const ledger = context.calculateLedger();

  assert.equal(ledger.totalPaid, 100);
  assert.equal(ledger.totalFuelLiters, 5);
  assert.equal(ledger.receiptPricePerLiter, 20);
}

function testPaymentStatusTransitionsBlockUnsafeJumps() {
  const context = loadSettlementContext();

  assert.equal(context.isValidPaymentStatusTransition("open", "requested"), true);
  assert.equal(context.isValidPaymentStatusTransition("requested", "paid"), true);
  assert.equal(context.isValidPaymentStatusTransition("requested", "open"), true);
  assert.equal(context.isValidPaymentStatusTransition("paid", "open"), true);
  assert.equal(context.isValidPaymentStatusTransition("open", "paid"), false);
  assert.equal(context.isValidPaymentStatusTransition("paid", "requested"), false);
  assert.equal(context.paymentStatusTransitionMessage("open", "paid"), "Request the payment before marking it paid.");
}

function testSettlementProgressIsSafeAndRounded() {
  const context = loadSettlementContext();
  const settlements = [
    { from: "Marie", to: "Christian", amount: "10.005", status: "requested" },
    { from: "Jonas", to: "Christian", amount: "20", status: "paid" },
    { from: "Unknown", to: "Christian", amount: "bad", status: "paid" },
    { from: "Marie", to: "Jonas", amount: -5, status: "open" }
  ];

  const progress = context.summarizeSettlementProgress(settlements);

  assert.equal(progress.totalCount, 4);
  assert.equal(progress.totalAmount, 30.01);
  assert.equal(progress.requestedCount, 1);
  assert.equal(progress.requestedAmount, 10.01);
  assert.equal(progress.paidCount, 2);
  assert.equal(progress.paidAmount, 20);
  assert.equal(progress.openCount, 1);
  assert.equal(progress.openAmount, 0);
  assert.deepEqual(plain(context.summarizeSettlementProgress(null)), {
    totalCount: 0,
    totalAmount: 0,
    requestedCount: 0,
    requestedAmount: 0,
    paidCount: 0,
    paidAmount: 0,
    openCount: 0,
    openAmount: 0
  });
}

function testTripCostRoundingBalancesToTotalPaid() {
  const context = loadSettlementContext({
    trips: [
      {
        id: "trip-1",
        driver: "Christian",
        date: "2026-01-05",
        startKm: 0,
        endKm: 3,
        participants: ["Christian", "Marie", "Jonas"]
      }
    ],
    fuel: [{ id: "fuel-1", payer: "Christian", date: "2026-01-05", amount: 100, liters: 5 }]
  });

  const ledger = context.calculateLedger();
  const people = Object.values(ledger.people);
  const tripCostTotal = people.reduce((sum, person) => context.roundMoney(sum + person.tripCost), 0);
  const netTotal = people.reduce((sum, person) => context.roundMoney(sum + person.net), 0);
  const settlementTotal = ledger.settlements.reduce((sum, settlement) => context.roundMoney(sum + settlement.amount), 0);

  assert.equal(tripCostTotal, 100);
  assert.equal(netTotal, 0);
  assert.equal(settlementTotal, 66.66);
  assert.deepEqual(people.map((person) => person.tripCost).sort((a, b) => b - a), [33.34, 33.33, 33.33]);
}

function testAllocateRoundedMoneyHandlesMalformedInputs() {
  const context = loadSettlementContext();

  assert.deepEqual(plain(context.allocateRoundedMoney(null, 10)), {});
  assert.deepEqual(plain(context.allocateRoundedMoney([{ name: "Christian", amount: "bad" }], 0)), { Christian: 0 });
  assert.deepEqual(plain(context.allocateRoundedMoney([
    { name: "Christian", amount: 0.333 },
    { name: "Marie", amount: 0.333 },
    { name: "Jonas", amount: 0.333 }
  ], 1)), { Christian: 0.34, Marie: 0.33, Jonas: 0.33 });
}

const tests = [
  testSharedTripCreatesSingleSettlement,
  testParticipantDeduplicationAndUnknownParticipantFiltering,
  testStringFuelAmountsAndUnknownPayersAreSafe,
  testNegativeTripDistanceDoesNotReduceBalances,
  testHistoricalStatsTolerateMissingClosedPeriods,
  testFullTankToFullTankConsumptionIgnoresFirstFill,
  testConsumptionFallsBackToRoughWithoutFullTankPair,
  testMalformedTripAndFuelArraysAreSafe,
  testReceiptMetricsIgnoreUnknownFuelPayers,
  testTripCostRoundingBalancesToTotalPaid,
  testAllocateRoundedMoneyHandlesMalformedInputs,
  testPaymentStatusTransitionsBlockUnsafeJumps,
  testSettlementProgressIsSafeAndRounded
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { window: {}, Object, Array, Number, String, Set, console };
vm.createContext(context);
vm.runInContext(readFileSync("ledger-model.js", "utf8"), context, { filename: "ledger-model.js" });
const model = context.window.FuelLedgerModel;

function testModelHelpersExposeExpectedKeys() {
  assert.deepEqual([...model.COLLECTION_KEYS], ["members", "trips", "fuel", "bookings", "closedPeriods"]);
  assert.deepEqual([...model.RECORD_KEYS], ["memberProfiles", "paymentStatuses"]);
  assert.equal(model.isPlainObject({}), true);
  assert.equal(model.isPlainObject([]), false);
}

function testStateSummaryIsSafeForMalformedState() {
  const summary = model.summarizeStateShape({
    members: ["Christian", "Marie", "Christian"],
    trips: [{ id: "t1" }],
    fuel: "bad",
    bookings: null,
    closedPeriods: [{ id: "p1" }],
    memberProfiles: { Christian: { isAdmin: true } },
    paymentStatuses: null
  });

  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    members: 3,
    uniqueMembers: 2,
    trips: 1,
    fuel: 0,
    bookings: 0,
    closedPeriods: 1,
    memberProfiles: 1,
    paymentStatuses: 0
  });
}

function testCoreShapeValidationAcceptsValidLedger() {
  const result = model.validateCoreStateShape({
    members: ["Christian", "Marie"],
    trips: [{ driver: "Christian", startKm: "100", endKm: 150, participants: ["Christian", "Marie"] }],
    fuel: [{ payer: "Marie", amount: "200.50", liters: "12.5", odometer: "150" }],
    bookings: [],
    closedPeriods: [],
    memberProfiles: { Christian: { email: "christian@example.com", isAdmin: true } },
    paymentStatuses: {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.errors)), []);
  assert.equal(result.summary.uniqueMembers, 2);
}

function testCoreShapeValidationRejectsBadShapes() {
  const result = model.validateCoreStateShape({
    members: ["Christian", " Christian "],
    trips: [{ startKm: "abc", endKm: 10, participants: "Christian" }],
    fuel: [{ amount: "nope", liters: "also-nope" }],
    bookings: {},
    closedPeriods: [],
    memberProfiles: [],
    paymentStatuses: []
  });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('"bookings" must be an array')));
  assert(result.errors.some((error) => error.includes('"memberProfiles" must be an object')));
  assert(result.errors.some((error) => error.includes("members must be unique")));
  assert(result.errors.some((error) => error.includes("startKm must be numeric")));
  assert(result.errors.some((error) => error.includes("participants must be an array")));
  assert(result.errors.some((error) => error.includes("amount must be numeric")));
}

for (const test of [
  testModelHelpersExposeExpectedKeys,
  testStateSummaryIsSafeForMalformedState,
  testCoreShapeValidationAcceptsValidLedger,
  testCoreShapeValidationRejectsBadShapes
]) {
  test();
  console.log(`ok - ${test.name}`);
}

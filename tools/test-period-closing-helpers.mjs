import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { window: {}, Object, Array, Number, String, Set, JSON, console };
vm.createContext(context);
vm.runInContext(readFileSync("period-closing-helpers.js", "utf8"), context, { filename: "period-closing-helpers.js" });
const helpers = context.window.FuelPeriodClosing;

function testFingerprintIsStableForEntryOrder() {
  const first = helpers.periodEntryFingerprint(
    [{ id: "trip-b" }, { id: "trip-a" }],
    [{ id: "fuel-b" }, { id: "fuel-a" }]
  );
  const second = helpers.periodEntryFingerprint(
    [{ id: "trip-a" }, { id: "trip-b" }],
    [{ id: "fuel-a" }, { id: "fuel-b" }]
  );
  assert.equal(first, second);
  assert.match(first, /trip-a/);
  assert.match(first, /fuel-b/);
}

function testReadinessBlocksUnsafePeriodClose() {
  const result = helpers.getClosePeriodReadiness({
    isAdmin: false,
    trips: [{ id: "trip-1" }],
    fuel: [{ id: "fuel-1" }],
    progress: { openCount: 2 },
    options: {}
  });

  assert.equal(result.ok, false);
  assert.equal(helpers.assertKnownBlockers(result), true);
  assert(result.blockers.some((blocker) => blocker.reason === "permission"));
  assert(result.blockers.some((blocker) => blocker.reason === "open-payments"));
  assert.match(result.firstMessage, /Only an admin/);
}

function testReadinessAllowsRequestedButUnpaidPayments() {
  const result = helpers.getClosePeriodReadiness({
    isAdmin: true,
    trips: [{ id: "trip-1" }],
    fuel: [{ id: "fuel-1" }],
    progress: { totalCount: 1, requestedCount: 1, openCount: 0 },
    options: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.progress.requestedCount, 1);
}

function testDuplicateSnapshotsAreBlocked() {
  const trips = [{ id: "trip-1" }];
  const fuel = [{ id: "fuel-1" }];
  const existing = [{ id: "period-1", entryFingerprint: helpers.periodEntryFingerprint(trips, fuel) }];

  const result = helpers.getClosePeriodReadiness({
    isAdmin: true,
    trips,
    fuel,
    closedPeriods: existing,
    progress: { openCount: 0 },
    options: {}
  });

  assert.equal(result.ok, false);
  assert(result.blockers.some((blocker) => blocker.reason === "duplicate"));
}

function testBusyCloseIsBlocked() {
  const result = helpers.getClosePeriodReadiness({
    isAdmin: true,
    closingInProgress: true,
    trips: [{ id: "trip-1" }],
    fuel: [],
    progress: { openCount: 0 },
    options: {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].reason, "busy");
}

for (const test of [
  testFingerprintIsStableForEntryOrder,
  testReadinessBlocksUnsafePeriodClose,
  testReadinessAllowsRequestedButUnpaidPayments,
  testDuplicateSnapshotsAreBlocked,
  testBusyCloseIsBlocked
]) {
  test();
  console.log(`ok - ${test.name}`);
}

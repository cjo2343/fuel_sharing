import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadHelpers() {
  const context = { window: {}, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('booking-calendar.js', 'utf8'), context);
  return context.window.FuelBookingCalendar;
}

const helpers = loadHelpers();
const describe = helpers.describeBookingStatus;
const now = Date.parse('2026-06-14T12:00:00Z');

function booking(overrides = {}) {
  return {
    id: 'booking-1',
    start: '2026-06-14T10:00:00Z',
    end: '2026-06-14T11:00:00Z',
    member: 'Christian',
    ...overrides
  };
}

function testCompletedBookingNeedsTrip() {
  const status = describe(booking(), { nowMs: now, canLogTrip: true });
  assert.equal(status.status, 'completed-needs-trip');
  assert.equal(status.label, 'Needs trip log');
  assert.equal(status.attention, true);
  assert.equal(status.canLogTrip, true);
}

function testLoggedBookingHidesLogAction() {
  const status = describe(booking(), {
    nowMs: now,
    trip: { id: 'trip-1', logRef: '#TRIP01', sourceBookingId: 'booking-1' },
    canLogTrip: true
  });
  assert.equal(status.status, 'trip-logged');
  assert.equal(status.label, 'Trip logged');
  assert.equal(status.canLogTrip, false);
}

function testMultiDayLoggedBookingRequiresFuel() {
  const status = describe(booking({ start: '2026-06-13T10:00:00Z', end: '2026-06-14T11:00:00Z' }), {
    nowMs: now,
    trip: { id: 'trip-2', logRef: '#TRIP02', sourceBookingId: 'booking-1' }
  });
  assert.equal(status.status, 'trip-logged-missing-fuel');
  assert.equal(status.label, 'Missing fuel');
  assert.equal(status.attention, true);
}

function testFuelLinkedStatus() {
  const status = describe(booking({ start: '2026-06-13T10:00:00Z', end: '2026-06-14T11:00:00Z' }), {
    nowMs: now,
    trip: { id: 'trip-2', logRef: '#TRIP02', sourceBookingId: 'booking-1' },
    fullTankFuel: { id: 'fuel-1', fullTank: true }
  });
  assert.equal(status.status, 'trip-logged-fuel-linked');
  assert.equal(status.label, 'Trip + fuel linked');
  assert.equal(status.attention, false);
}

function testUpcomingAndActiveStatuses() {
  assert.equal(describe(booking({ start: '2026-06-15T10:00:00Z', end: '2026-06-15T11:00:00Z' }), { nowMs: now }).status, 'upcoming');
  assert.equal(describe(booking({ start: '2026-06-14T11:00:00Z', end: '2026-06-14T13:00:00Z' }), { nowMs: now }).status, 'active');
}

for (const test of [
  testCompletedBookingNeedsTrip,
  testLoggedBookingHidesLogAction,
  testMultiDayLoggedBookingRequiresFuel,
  testFuelLinkedStatus,
  testUpcomingAndActiveStatuses
]) {
  test();
  console.log(`ok - ${test.name}`);
}

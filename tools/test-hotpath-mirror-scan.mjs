// Unit test for the scanner behind tools/check-hotpath-mirror.mjs (GV-393).
//
//   node tools/test-hotpath-mirror-scan.mjs   (also run by `npm run validate`)
//
// Lives here for the same reason test-markup-hex-scan.mjs, test-role-matrix-coverage
// .mjs and test-tracker-insert-scan.mjs do: check-hotpath-mirror.mjs only does real
// work where govehlo-mobile is checked out, which is the umbrella workflow and a dev
// machine — never fuel_sharing's own CI. Without this, its logic would go unexercised
// on nearly every commit, and a broken scraper would read as "the mirror is fine".
//
// The scanner it tests replaced a guard that compared hotpaths.mjs to its own
// hardcoded copy of the same values. So the thing this file most needs to prove is
// the property that guard lacked: that the checker FAILS on real drift, and that it
// fails LOUDLY rather than silently passing when it cannot parse the gateway.

import assert from "node:assert/strict";
import {
  extractProjection,
  extractEventExclusions,
  readAppliesSoftDeleteFilter,
  compareMirror,
  MirrorScanError,
} from "./check-hotpath-mirror.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  FAIL - ${name}\n    ${e.message}`);
  }
}

// A miniature but shape-faithful stand-in for ledger-data-gateway.ts.
const GATEWAY = `
export const SETTLEMENT_REQUEST_COLUMNS =
  'id,ledger_id,amount,status,created_at,paid_claimed_at';
export const SETTLEMENT_PERIOD_COLUMNS =
  'id,ledger_id,status,label';

        timed('trips', client.from('trips').select('*').eq('ledger_id', ledgerId).is('deleted_at', null)),
        timed('settlements', client.from('settlement_requests').select(SETTLEMENT_REQUEST_COLUMNS)),
        // Deliberately NO deleted_at filter (GVM-388)
        timed('bookings', client.from('car_bookings').select('*').eq('ledger_id', ledgerId).order('start_at')),
        timed('events', client.from('ledger_events').select('*').not('event_type', 'in', '(a_sent,b_sent)')),
        timed('repairs', client.from('vehicle_repairs').select('*').is('deleted_at', null)),
        timed('fuel', client.from('fuel_payments').select('*').is('deleted_at', null)),
`;

// A hotpaths module that correctly mirrors the fixture above.
function goodHotpaths() {
  return {
    SETTLEMENT_REQUEST_COLUMNS: "id,ledger_id,amount,status,created_at,paid_claimed_at",
    SETTLEMENT_PERIOD_COLUMNS: "id,ledger_id,status,label",
    EVENT_TYPE_EXCLUDE: ["a_sent", "b_sent"],
    ledgerReadRequests: () => [
      { label: "read:trips", query: "select=*&ledger_id=eq.X&deleted_at=is.null" },
      { label: "read:fuel", query: "select=*&ledger_id=eq.X&deleted_at=is.null" },
      { label: "read:bookings", query: "select=*&ledger_id=eq.X&order=start_at.desc" },
      { label: "read:repairs", query: "select=*&ledger_id=eq.X&deleted_at=is.null" },
    ],
  };
}

console.log("\nhot-path mirror scanner");

// ── Extractors ──
test("extractProjection reads a multi-line projection constant", () => {
  assert.equal(
    extractProjection(GATEWAY, "SETTLEMENT_REQUEST_COLUMNS"),
    "id,ledger_id,amount,status,created_at,paid_claimed_at",
  );
});

test("extractEventExclusions reads the not-in filter", () => {
  assert.deepEqual(extractEventExclusions(GATEWAY), ["a_sent", "b_sent"]);
});

test("readAppliesSoftDeleteFilter distinguishes trips (filters) from bookings (does not)", () => {
  assert.equal(readAppliesSoftDeleteFilter(GATEWAY, "trips"), true);
  assert.equal(readAppliesSoftDeleteFilter(GATEWAY, "car_bookings"), false);
});

// ── The scanner must THROW, not shrug, on an unreadable gateway ──
test("an unparseable gateway raises MirrorScanError (never a silent pass)", () => {
  assert.throws(() => extractProjection("const X = 1;", "SETTLEMENT_REQUEST_COLUMNS"), MirrorScanError);
  assert.throws(() => extractEventExclusions("const X = 1;"), MirrorScanError);
  assert.throws(() => readAppliesSoftDeleteFilter("const X = 1;", "trips"), MirrorScanError);
});

// ── compareMirror: green when it matches ──
test("compareMirror reports no problems for a faithful mirror", () => {
  assert.deepEqual(compareMirror(GATEWAY, goodHotpaths()), []);
});

// ── compareMirror: RED on each real drift class ──
test("compareMirror catches a dropped projection column (the 12-vs-17 bug)", () => {
  const h = goodHotpaths();
  h.SETTLEMENT_REQUEST_COLUMNS = "id,ledger_id,amount,status";
  const problems = compareMirror(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SETTLEMENT_REQUEST_COLUMNS drifted/);
  assert.match(problems[0], /MISSING from hotpaths: created_at, paid_claimed_at/);
});

test("compareMirror catches a soft-delete filter the gateway does NOT apply (the GVM-388 bug)", () => {
  const h = goodHotpaths();
  const base = h.ledgerReadRequests;
  h.ledgerReadRequests = () =>
    base().map((r) =>
      r.label === "read:bookings" ? { ...r, query: `${r.query}&deleted_at=is.null` } : r,
    );
  const problems = compareMirror(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:bookings soft-delete filter drifted/);
  assert.match(problems[0], /Remove &deleted_at=is\.null/);
});

test("compareMirror catches a MISSING soft-delete filter the gateway DOES apply", () => {
  const h = goodHotpaths();
  const base = h.ledgerReadRequests;
  h.ledgerReadRequests = () =>
    base().map((r) =>
      r.label === "read:trips" ? { ...r, query: r.query.replace("&deleted_at=is.null", "") } : r,
    );
  const problems = compareMirror(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Add &deleted_at=is\.null/);
});

test("compareMirror catches drifted event-type exclusions", () => {
  const h = goodHotpaths();
  h.EVENT_TYPE_EXCLUDE = ["a_sent"];
  const problems = compareMirror(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /EVENT_TYPE_EXCLUDE drifted/);
});

test("compareMirror catches a read the gateway has but hotpaths lost entirely", () => {
  const h = goodHotpaths();
  const base = h.ledgerReadRequests;
  h.ledgerReadRequests = () => base().filter((r) => r.label !== "read:repairs");
  const problems = compareMirror(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no read labelled read:repairs/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

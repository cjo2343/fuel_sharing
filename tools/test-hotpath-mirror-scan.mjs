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
  extractOrdering,
  extractLimit,
  extractNumericConstants,
  readAppliesDynamicFilter,
  parseMirrorQuery,
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

// A miniature but shape-faithful stand-in for ledger-data-gateway.ts: the same
// `fanOut` block, all twelve reads in the same order, the same `scoped(...)` window on
// trips/fuel, and the same `.order()` / `.limit()` chains written in the gateway's own
// idiom (`SETTLE_ROW_CAP + 1`, `.single()` on the ledger row).
const GATEWAY = `
export const SETTLEMENT_REQUEST_COLUMNS =
  'id,ledger_id,amount,status,created_at,paid_claimed_at';
export const SETTLEMENT_PERIOD_COLUMNS =
  'id,ledger_id,status,label';

  const fanOut = async (ledgerId, window, wants, timed) => {
    const tripsWindow = windowFilter('trip_date', window);
    const fuelWindow = windowFilter('payment_date', window);
    const [a] = await Promise.all([
      timed('ledger', client.from('ledgers').select('*').eq('id', ledgerId).single()),
      timed('members', client.from('ledger_members').select('*').eq('is_active', true).order('name')),
      timed('periods', client.from('settlement_periods').select(SETTLEMENT_PERIOD_COLUMNS)
        .order('opened_at', { ascending: false })),
      timed('trips', scoped(client.from('trips').select('*').is('deleted_at', null), tripsWindow)
        .order('trip_date', { ascending: false }).order('id', { ascending: false })
        .limit(SETTLE_ROW_CAP + 1)),
      timed('fuel', scoped(client.from('fuel_payments').select('*').is('deleted_at', null), fuelWindow)
        .order('payment_date', { ascending: false }).order('id', { ascending: false })
        .limit(SETTLE_ROW_CAP + 1)),
      timed('settlements', client.from('settlement_requests').select(SETTLEMENT_REQUEST_COLUMNS)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(SETTLEMENT_REQUEST_ROW_CAP + 1)),
      // Deliberately NO deleted_at filter (GVM-388)
      timed('bookings', client.from('car_bookings').select('*').eq('ledger_id', ledgerId)
        .order('start_at', { ascending: false }).order('id', { ascending: false })
        .limit(BOOKING_ROW_CAP + 1)),
      timed('events', client.from('ledger_events').select('*')
        .not('event_type', 'in', '(a_sent,b_sent)')
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(FEED_PAGE_SIZE)),
      timed('repairs', client.from('vehicle_repairs').select('*').is('deleted_at', null)
        .order('repair_date', { ascending: false }).order('id', { ascending: false })
        .limit(REPAIR_ROW_CAP + 1)),
      timed('messages', client.from('messages').select('*').is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(FEED_PAGE_SIZE)),
      timed('expenses', client.from('workspace_expenses').select('*').is('deleted_at', null)
        .order('expense_date', { ascending: false }).order('id', { ascending: false })
        .limit(EXPENSE_ROW_CAP + 1)),
      timed('recurring', client.from('recurring_expenses').select('*').is('deleted_at', null)
        .order('next_due_date', { ascending: true }).order('id', { ascending: true })
        .limit(RECURRING_ROW_CAP + 1)),
    ]);
  };

  const load = async (ledgerId, isCurrent) => {
    // Reads BELOW the fan-out must not be scraped as part of it — this one is the
    // Historik page fetcher's shape, with a different limit on the very same table.
    client.from('trips').select('*').order('trip_date', { ascending: false }).limit(HISTORY_PAGE_SIZE);
  };
`;

// The gateway's cap constants, as settlement-data-guard.ts / feed-pagination.ts state
// them — the same source strings extractNumericConstants reads in the real repo.
const CONSTANTS = extractNumericConstants(`
export const SETTLE_ROW_CAP = 500;
export const SETTLEMENT_REQUEST_ROW_CAP = 500;
export const BOOKING_ROW_CAP = 1000;
export const REPAIR_ROW_CAP = 500;
export const EXPENSE_ROW_CAP = 500;
export const RECURRING_ROW_CAP = 200;
export const FEED_PAGE_SIZE = 50;
`);

// A hotpaths module that correctly mirrors the fixture above.
function goodHotpaths() {
  return {
    SETTLEMENT_REQUEST_COLUMNS: "id,ledger_id,amount,status,created_at,paid_claimed_at",
    SETTLEMENT_PERIOD_COLUMNS: "id,ledger_id,status,label",
    EVENT_TYPE_EXCLUDE: ["a_sent", "b_sent"],
    SETTLE_ROW_CAP: 500,
    SETTLEMENT_REQUEST_ROW_CAP: 500,
    BOOKING_ROW_CAP: 1000,
    REPAIR_ROW_CAP: 500,
    EXPENSE_ROW_CAP: 500,
    RECURRING_ROW_CAP: 200,
    ledgerReadRequests: () => [
      { label: "read:ledger", query: "select=*&id=eq.X&limit=1" },
      { label: "read:members", query: "select=*&ledger_id=eq.X&is_active=eq.true&order=name.asc" },
      { label: "read:periods", query: "select=id,ledger_id,status,label&ledger_id=eq.X&order=opened_at.desc" },
      { label: "read:trips", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=trip_date.desc,id.desc&limit=501" },
      { label: "read:fuel", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=payment_date.desc,id.desc&limit=501" },
      { label: "read:settlements", query: "select=id&ledger_id=eq.X&order=created_at.desc,id.desc&limit=501" },
      { label: "read:bookings", query: "select=*&ledger_id=eq.X&order=start_at.desc,id.desc&limit=1001" },
      { label: "read:events", query: "select=*&ledger_id=eq.X&order=created_at.desc,id.desc&limit=50" },
      { label: "read:repairs", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=repair_date.desc,id.desc&limit=501" },
      { label: "read:messages", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=created_at.desc,id.desc&limit=50" },
      { label: "read:expenses", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=expense_date.desc,id.desc&limit=501" },
      { label: "read:recurring", query: "select=*&ledger_id=eq.X&deleted_at=is.null&order=next_due_date.asc,id.asc&limit=201" },
    ],
  };
}

/** compareMirror with the fixture's constants — the runner passes the real ones. */
function compare(gateway, hotpaths) {
  return compareMirror(gateway, hotpaths, CONSTANTS);
}

/** goodHotpaths() with one read's query rewritten. */
function withQuery(hotpaths, label, rewrite) {
  const base = hotpaths.ledgerReadRequests;
  hotpaths.ledgerReadRequests = () =>
    base().map((r) => (r.label === label ? { ...r, query: rewrite(r.query) } : r));
  return hotpaths;
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
  assert.deepEqual(compare(GATEWAY, goodHotpaths()), []);
});

// ── compareMirror: RED on each real drift class ──
test("compareMirror catches a dropped projection column (the 12-vs-17 bug)", () => {
  const h = goodHotpaths();
  h.SETTLEMENT_REQUEST_COLUMNS = "id,ledger_id,amount,status";
  const problems = compare(GATEWAY, h);
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
  const problems = compare(GATEWAY, h);
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
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Add &deleted_at=is\.null/);
});

test("compareMirror catches drifted event-type exclusions", () => {
  const h = goodHotpaths();
  h.EVENT_TYPE_EXCLUDE = ["a_sent"];
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /EVENT_TYPE_EXCLUDE drifted/);
});

test("compareMirror catches a read the gateway has but hotpaths lost entirely", () => {
  const h = goodHotpaths();
  const base = h.ledgerReadRequests;
  h.ledgerReadRequests = () => base().filter((r) => r.label !== "read:repairs");
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no read labelled read:repairs/);
});

// ── GV-484: ordering and limit ──────────────────────────────────────────────
// The blind spot that let GVM-572's caps drift past a green check. Everything below
// is a drift the checker used to call "ok - hotpaths.mjs mirrors …".

test("extractOrdering reads the column list, in order, with .order('name') as ascending", () => {
  assert.deepEqual(extractOrdering(GATEWAY, "trips"), ["trip_date.desc", "id.desc"]);
  assert.deepEqual(extractOrdering(GATEWAY, "recurring_expenses"), ["next_due_date.asc", "id.asc"]);
  assert.deepEqual(extractOrdering(GATEWAY, "ledger_members"), ["name.asc"]);
  assert.deepEqual(extractOrdering(GATEWAY, "ledgers"), []);
});

test("extractLimit resolves `CAP + 1`, a bare constant, and `.single()` as 1", () => {
  assert.equal(extractLimit(GATEWAY, "trips", CONSTANTS), 501);
  assert.equal(extractLimit(GATEWAY, "car_bookings", CONSTANTS), 1001);
  assert.equal(extractLimit(GATEWAY, "recurring_expenses", CONSTANTS), 201);
  assert.equal(extractLimit(GATEWAY, "ledger_events", CONSTANTS), 50);
  assert.equal(extractLimit(GATEWAY, "ledgers", CONSTANTS), 1);
  assert.equal(extractLimit(GATEWAY, "ledger_members", CONSTANTS), null);
});

test("an unresolvable limit constant raises MirrorScanError (never a silent NaN)", () => {
  assert.throws(() => extractLimit(GATEWAY, "trips", new Map()), MirrorScanError);
});

test("the scrape stops at the end of the fan-out (a later read of the same table is not it)", () => {
  // The fixture's `load` re-reads trips with HISTORY_PAGE_SIZE. If that leaked into
  // the fan-out slice, the limit would be unresolvable and the ordering would grow a
  // third column — so this passing is the boundary working.
  assert.equal(extractLimit(GATEWAY, "trips", CONSTANTS), 501);
  assert.deepEqual(extractOrdering(GATEWAY, "trips"), ["trip_date.desc", "id.desc"]);
});

test("parseMirrorQuery splits the order list and reads the limit", () => {
  const q = parseMirrorQuery("select=*&ledger_id=eq.X&order=trip_date.desc,id.desc&limit=501");
  assert.deepEqual(q.order, ["trip_date.desc", "id.desc"]);
  assert.equal(q.limit, 501);
  assert.equal(q.hasOrFilter, false);
  assert.equal(parseMirrorQuery("select=*").limit, null);
});

test("compareMirror catches a limit BELOW the gateway's (the GVM-572 cap drift)", () => {
  const h = withQuery(goodHotpaths(), "read:bookings", (q) => q.replace("limit=1001", "limit=501"));
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:bookings LIMIT drifted/);
  assert.match(problems[0], /gateway: {2}1001/);
  assert.match(problems[0], /hotpaths: 501/);
  assert.match(problems[0], /under-measures the payload/);
});

test("compareMirror catches a MISSING limit (a read the mirror left uncapped)", () => {
  const h = withQuery(goodHotpaths(), "read:settlements", (q) => q.replace("&limit=501", ""));
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:settlements LIMIT drifted/);
  assert.match(problems[0], /hotpaths: none/);
});

test("compareMirror catches a limit the gateway does NOT have", () => {
  const h = withQuery(goodHotpaths(), "read:members", (q) => `${q}&limit=200`);
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:members LIMIT drifted/);
  assert.match(problems[0], /no limit at all/);
});

test("compareMirror catches a dropped id tiebreak (Historik's keyset paging)", () => {
  const h = withQuery(goodHotpaths(), "read:trips", (q) =>
    q.replace("order=trip_date.desc,id.desc", "order=trip_date.desc"),
  );
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:trips ORDERING drifted/);
  assert.match(problems[0], /gateway: {2}trip_date\.desc,id\.desc/);
});

test("compareMirror catches a FLIPPED direction (recurring is ascending on purpose)", () => {
  const h = withQuery(goodHotpaths(), "read:recurring", (q) =>
    q.replace("order=next_due_date.asc,id.asc", "order=next_due_date.desc,id.desc"),
  );
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:recurring ORDERING drifted/);
});

test("compareMirror catches an ordering hotpaths invented (gateway has none)", () => {
  const h = withQuery(goodHotpaths(), "read:ledger", (q) => `${q}&order=id.asc`);
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:ledger ORDERING drifted/);
  assert.match(problems[0], /gateway: {2}\(no ordering\)/);
});

test("compareMirror catches a drifted cap CONSTANT by name", () => {
  const h = goodHotpaths();
  h.BOOKING_ROW_CAP = 500;
  const problems = compare(GATEWAY, h);
  // The limit it sends is still 1001, so only the constant is named.
  assert.equal(problems.length, 1);
  assert.match(problems[0], /BOOKING_ROW_CAP drifted: .*says 1000, hotpaths\.mjs says 500/);
});

// ── The GVM-559 window exemption, handled rather than ignored ────────────────
test("readAppliesDynamicFilter sees the scoped() window on trips/fuel and nowhere else", () => {
  assert.equal(readAppliesDynamicFilter(GATEWAY, "trips"), true);
  assert.equal(readAppliesDynamicFilter(GATEWAY, "fuel_payments"), true);
  assert.equal(readAppliesDynamicFilter(GATEWAY, "car_bookings"), false);
  assert.equal(readAppliesDynamicFilter(GATEWAY, "workspace_expenses"), false);
});

test("the GVM-559 window is exempt: trips/fuel order+limit still compared, `or=` not required", () => {
  // goodHotpaths mirrors neither window filter and is green — that IS the exemption.
  assert.deepEqual(compare(GATEWAY, goodHotpaths()), []);
});

test("compareMirror rejects an `or=` filter hotpaths grew on an exempt read", () => {
  const h = withQuery(goodHotpaths(), "read:fuel", (q) => `${q}&or=(payment_date.gte.2026-01-01)`);
  const problems = compare(GATEWAY, h);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:fuel: hotpaths carries an `or=` filter/);
});

test("compareMirror flags a NEW dynamic filter on a read that is not exempt", () => {
  const gateway = GATEWAY.replace(
    "timed('expenses', client.from('workspace_expenses').select('*').is('deleted_at', null)",
    "timed('expenses', client.from('workspace_expenses').select('*').is('deleted_at', null).or('x.gte.1')",
  );
  const problems = compare(gateway, goodHotpaths());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /read:expenses: the gateway now applies a DYNAMIC filter/);
  assert.match(problems[0], /windowExempt: true/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

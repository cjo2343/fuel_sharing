// Anti-drift contract for the booking caps — booked days + horizon (GVM-463).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// Migration 159 makes two workspace settings ENFORCED, which is the deliberate break
// from migration 152: that one stores a number and lets the client decide, this one
// rejects the write. The whole value of the change is that a stale client, a replayed
// offline write, or a direct PostgREST call cannot over-book — and the only way to
// know that is still true is to ask a real Postgres to refuse a real booking.
//
// A regex over the SQL would certify nothing here. Every mistake this file exists to
// catch leaves the migration looking exactly right and changes the answer:
//
//   • counting NIGHTS instead of calendar days (end − start rather than the inclusive
//     day span) — a mistake that is invisible until a booking spans midnight, and
//     the number then disagrees with the "N dage" the booking sheet showed a second
//     earlier;
//   • an off-by-one on either boundary — refusing the booking that sits exactly ON
//     the cap, or accepting the one a day past the horizon;
//   • counting the row being EDITED twice, so shrinking a booking is refused;
//   • and the one that would actually hurt live data: enforcing a cap that is NULL,
//     i.e. turning the feature on for every workspace that never asked for it.
//
// That last one is why the off-by-default pin below is not a formality. Both columns
// are NULL for every existing group, so "null changes nothing" is the promise that
// keeps this migration safe to apply, and it is pinned as an EQUALITY against the
// pre-migration behaviour rather than as an absence of errors.
//
// ── Docker ──────────────────────────────────────────────────────────────────────
// Real enforcement needs a real Postgres, so this replays supabase-schema.sql into a
// disposable container. Docker-free machines get a loud warning and a pass — the same
// contract test-fuel-stop-verdict-contract.mjs uses — so `npm run validate` stays
// dependency-free. CI runs it with --strict, where a skip is a failure.
//
//   node tools/test-booking-caps-contract.mjs            # warn when Docker is absent
//   node tools/test-booking-caps-contract.mjs --strict   # CI: unchecked = failure

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const CONTAINER = `govehlo-booking-caps-${process.pid}`;
const DB = "bookingcaps";

let checked = 0;

function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  const message =
    "booking caps contract: Docker is unavailable, so the SQL was NOT executed. " +
    "The day/horizon enforcement in migration 159 is unverified on this run.";
  if (strict) {
    process.stderr.write(`\n❌ ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n⚠️  ${message}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`\n❌ booking caps contract: ${message}\n`);
  removeContainer(CONTAINER);
  process.exit(1);
}

try {
  startPostgres(CONTAINER, ROOT);
  createDbWithPrelude(CONTAINER, DB);
} catch (error) {
  fail(error.message);
}

const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

// ── Fixtures ───────────────────────────────────────────────────────────────────
// One workspace, one open period, an admin (Anna) and a plain member (Bo). Anna is
// admin so the same fixture can exercise the setter RPCs; Bo exists to prove the
// caps are counted PER MEMBER rather than per workspace.
const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
const PERIOD = "20000000-0000-0000-0000-000000000001";

const seed = `
insert into public.ledgers (id, name, slug) values ('caps', 'Caps test', 'caps');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${M(1)}', 'caps', 'Anna', 'anna@test.dk', 'admin',  true),
  ('${M(2)}', 'caps', 'Bo',   'bo@test.dk',   'member', true);

-- The period is opened well in the past, so nothing below is excluded by the
-- period-start floor and each case tests only the rule it names. The floor itself
-- gets its own case at the end, with a period opened deliberately late.
insert into public.settlement_periods (id, ledger_id, status, label, opened_at)
values ('${PERIOD}', 'caps', 'open', 'Open', now() - interval '60 days');
`;
if (psql(CONTAINER, DB, ["-c", seed]).status !== 0) fail("Seeding ledger/members/period failed");

// Every `psql -c` is its own SESSION, so set_config(..., false) does not survive to
// the next call — the JWT claims have to travel WITH the statement that needs them,
// or the membership gate under test never fires and everything silently runs as the
// operator.
function as(email, sql) {
  return psql(CONTAINER, DB, [
    "-c",
    `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
  ]);
}

function asValue(email, sql) {
  const res = psql(CONTAINER, DB, [
    "-t",
    "-A",
    "-c",
    `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${sql}`,
  ]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
  // The set_config select prints its own row first; the value we want is the last one.
  return res.stdout.trim().split("\n").pop().trim();
}

function run(sql) {
  const res = psql(CONTAINER, DB, ["-c", sql]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
  return res;
}

// Danish local dates, because that is the timezone the rule is written in — using the
// host's or the container's UTC date would make the boundary cases pass or fail by
// accident depending on the hour the suite runs.
const dkDate = (offsetDays) =>
  `((now() at time zone 'Europe/Copenhagen')::date + ${offsetDays})`;

/** Run `sql` and return the SQLSTATE it raises, or 'OK' when it succeeds. */
function sqlstateOf(email, sql) {
  const wrapped = `
do $$
begin
  ${sql}
  raise notice 'GVSTATE:OK';
exception when others then
  raise notice 'GVSTATE:%', sqlstate;
end $$;`;
  const res = psql(CONTAINER, DB, [
    "-c",
    `select set_config('request.jwt.claims', '{"email":"${email}","role":"authenticated"}', false);\n${wrapped}`,
  ]);
  if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${wrapped}`);
  const match = `${res.stdout}\n${res.stderr}`.match(/GVSTATE:(\S+)/);
  if (!match) fail(`Could not read a SQLSTATE back from:\n${wrapped}`);
  return match[1];
}

function bookState({ legacy, member = M(1), fromDay, toDay, fromTime = "09:00", toTime = "18:00", actor = "anna@test.dk" }) {
  return sqlstateOf(
    actor,
    `perform public.upsert_car_booking(
       'caps',
       '${legacy}',
       '${member}',
       ((${dkDate(fromDay)} + time '${fromTime}') at time zone 'Europe/Copenhagen'),
       ((${dkDate(toDay)} + time '${toTime}') at time zone 'Europe/Copenhagen'),
       null, null, null, null);`,
  );
}

function clearBookings() {
  run("delete from public.car_bookings; delete from public.ledger_events;");
}

function setCaps({ days = null, horizon = null }) {
  run(
    `update public.ledgers
        set booking_max_days_per_member = ${days === null ? "null" : days},
            booking_horizon_days = ${horizon === null ? "null" : horizon}
      where id = 'caps';`,
  );
}

const bookedDays = (member = M(1)) =>
  Number(asValue("anna@test.dk", `select public.booked_days_in_open_period('caps', '${member}');`));

const bookingCount = () =>
  Number(
    psql(CONTAINER, DB, ["-t", "-A", "-c", "select count(*) from public.car_bookings where deleted_at is null;"])
      .stdout.trim(),
  );

process.stdout.write("\nBooking caps (real Postgres, consolidated schema):\n");

// ═══════════════════════════════════════════════════════════════════════════════
// 1. OFF BY DEFAULT — the promise that makes this migration safe to apply
// ═══════════════════════════════════════════════════════════════════════════════
// Asserted as an EQUALITY (every booking saved, no error, rows present) rather than
// as "no exception was raised", because a cap that silently swallowed a write would
// also raise no exception.

clearBookings();
setCaps({ days: null, horizon: null });

pin("both caps NULL: the columns exist and are NULL for a workspace that never opted in", () => {
  const row = psql(CONTAINER, DB, [
    "-t",
    "-A",
    "-c",
    "select coalesce(booking_max_days_per_member::text,'NULL') || '/' || coalesce(booking_horizon_days::text,'NULL') from public.ledgers where id='caps';",
  ]).stdout.trim();
  assert.equal(row, "NULL/NULL", "a fresh ledger must carry no caps at all");
});

pin("both caps NULL: a 30-day booking 500 days out is accepted — nothing is enforced", () => {
  // Deliberately absurd on BOTH dimensions at once. If either check fired while its
  // column is null, this is the case that catches it.
  const state = bookState({ legacy: "off-1", fromDay: 500, toDay: 530 });
  assert.equal(state, "OK", "with both caps off no booking may ever be refused by them");
  assert.equal(bookingCount(), 1, "and the row must actually be there, not silently dropped");
});

pin("both caps NULL: many bookings, many days, all accepted", () => {
  for (let i = 0; i < 6; i++) {
    const state = bookState({ legacy: `off-bulk-${i}`, fromDay: 600 + i * 10, toDay: 600 + i * 10 + 5 });
    assert.equal(state, "OK", `booking ${i} must be accepted with the caps off`);
  }
  assert.equal(bookingCount(), 7, "every one of them is stored");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE DAY COUNT — calendar days, inclusive, distinct, spanning midnight
// ═══════════════════════════════════════════════════════════════════════════════
// This is the half a NIGHTS implementation gets wrong, and it gets it wrong by
// exactly one on every case below except the first.

clearBookings();
setCaps({ days: null, horizon: null });

pin("a booking inside ONE day counts 1 day", () => {
  assert.equal(bookState({ legacy: "d-1", fromDay: 1, toDay: 1, fromTime: "09:00", toTime: "18:00" }), "OK");
  assert.equal(bookedDays(), 1, "09:00–18:00 on one date is one booked day");
});

pin("a booking that SPANS MIDNIGHT counts 2 days, not 1 night", () => {
  // The discriminating case. Nights would say 1 here and days say 2, and the whole
  // rest of the file agrees with days because the booking sheet's own summary does.
  clearBookings();
  assert.equal(bookState({ legacy: "d-2", fromDay: 1, toDay: 2, fromTime: "22:00", toTime: "06:00" }), "OK");
  assert.equal(bookedDays(), 2, "22:00 to 06:00 next morning holds the car on two calendar days");
});

pin("a three-night booking counts FOUR days — the inclusive span, not the difference", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "d-3", fromDay: 10, toDay: 13 }), "OK");
  assert.equal(bookedDays(), 4, "day 10, 11, 12 and 13 are all held");
});

pin("two bookings on the SAME day count 1 — days are distinct, not summed", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "d-4a", fromDay: 20, toDay: 20, fromTime: "07:00", toTime: "09:00" }), "OK");
  assert.equal(bookState({ legacy: "d-4b", fromDay: 20, toDay: 20, fromTime: "17:00", toTime: "19:00" }), "OK");
  assert.equal(bookedDays(), 1, "a day already held is not held twice");
});

pin("adjacent bookings sharing an end/start date count that date ONCE", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "d-5a", fromDay: 30, toDay: 31, fromTime: "09:00", toTime: "12:00" }), "OK");
  assert.equal(bookState({ legacy: "d-5b", fromDay: 31, toDay: 32, fromTime: "14:00", toTime: "18:00" }), "OK");
  assert.equal(bookedDays(), 3, "days 30, 31, 32 — the shared day 31 is one day, so 3 not 4");
});

pin("another member's bookings are not counted", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "d-6a", member: M(1), fromDay: 40, toDay: 42 }), "OK");
  assert.equal(bookState({ legacy: "d-6b", member: M(2), fromDay: 50, toDay: 55, actor: "bo@test.dk" }), "OK");
  assert.equal(bookedDays(M(1)), 3, "Anna holds her own three days");
  assert.equal(bookedDays(M(2)), 6, "Bo holds his own six, and neither sees the other's");
});

pin("a soft-deleted booking stops counting", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "d-7", fromDay: 60, toDay: 64 }), "OK");
  assert.equal(bookedDays(), 5);
  run("update public.car_bookings set deleted_at = now() where legacy_id = 'd-7';");
  assert.equal(bookedDays(), 0, "a cancelled booking releases the days it held");
});

pin("days BEFORE the open period's start are excluded — the allowance resets at close", () => {
  clearBookings();
  // Move the period start forward so a backdated booking straddles it: a booking
  // covering day −5 … day +1 contributes only the days on or after the period start.
  run(`update public.settlement_periods
          set opened_at = ((now() at time zone 'Europe/Copenhagen')::date at time zone 'Europe/Copenhagen')
        where id = '${PERIOD}';`);
  assert.equal(bookState({ legacy: "d-8", fromDay: -5, toDay: 1 }), "OK");
  assert.equal(
    bookedDays(),
    2,
    "the seven-day window contributes only today and tomorrow, the two days inside the period",
  );
  run(`update public.settlement_periods set opened_at = now() - interval '60 days' where id = '${PERIOD}';`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. THE DAY CAP BOUNDARY — on the cap is fine, one past it is refused
// ═══════════════════════════════════════════════════════════════════════════════

clearBookings();
setCaps({ days: 5, horizon: null });

pin("exactly ON the day cap is ACCEPTED", () => {
  // 5 days with a cap of 5. An off-by-one that used >= would refuse this.
  assert.equal(bookState({ legacy: "c-1", fromDay: 1, toDay: 5 }), "OK");
  assert.equal(bookedDays(), 5, "and it is really stored, holding the full allowance");
});

pin("ONE day past the cap is REFUSED with errcode GV46D", () => {
  clearBookings();
  const state = bookState({ legacy: "c-2", fromDay: 1, toDay: 6 });
  assert.equal(state, "GV46D", "six days against a cap of five must raise the day-cap code");
  assert.equal(bookingCount(), 0, "and nothing may be written");
});

pin("the cap counts the member's OTHER bookings too, not just this one", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "c-3a", fromDay: 1, toDay: 3 }), "OK", "three days, under the cap");
  assert.equal(bookState({ legacy: "c-3b", fromDay: 10, toDay: 11 }), "OK", "two more makes exactly five");
  assert.equal(bookedDays(), 5);
  assert.equal(
    bookState({ legacy: "c-3c", fromDay: 20, toDay: 20 }),
    "GV46D",
    "the sixth day is refused even though the booking itself is one day long",
  );
});

pin("the cap is PER MEMBER — Bo is unaffected by Anna's full allowance", () => {
  // Anna is still holding her five from the case above.
  assert.equal(bookedDays(M(1)), 5);
  assert.equal(
    bookState({ legacy: "c-4", member: M(2), fromDay: 30, toDay: 34, actor: "bo@test.dk" }),
    "OK",
    "a per-workspace count would refuse this",
  );
});

pin("EDITING a booking does not count its old and new windows together", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "c-5", fromDay: 1, toDay: 5 }), "OK", "five days, exactly on the cap");
  // Re-save the SAME legacy id with a SHORTER window. Without exclude_booking_id the
  // count would be 5 (old) + 3 (new) and this would be refused.
  assert.equal(
    bookState({ legacy: "c-5", fromDay: 1, toDay: 3 }),
    "OK",
    "shrinking a booking must never be refused by the cap it already fits",
  );
  assert.equal(bookedDays(), 3, "and the shorter window is what is now held");
});

pin("editing a booking to EXCEED the cap is still refused", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "c-6", fromDay: 1, toDay: 3 }), "OK");
  assert.equal(
    bookState({ legacy: "c-6", fromDay: 1, toDay: 9 }),
    "GV46D",
    "the exclusion must not become a way to grow a booking past the cap",
  );
  assert.equal(bookedDays(), 3, "the original window survives the rejected edit");
});

pin("an ADMIN is not exempt from the day cap", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "c-7", fromDay: 1, toDay: 9, actor: "anna@test.dk" }), "GV46D");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. THE HORIZON BOUNDARY — day N ok, day N+1 blocked
// ═══════════════════════════════════════════════════════════════════════════════

clearBookings();
setCaps({ days: null, horizon: 30 });

pin("a booking starting on day N (the last permitted date) is ACCEPTED", () => {
  assert.equal(bookState({ legacy: "h-1", fromDay: 30, toDay: 30 }), "OK");
});

pin("day N at 23:59 is still ACCEPTED — the bound is a DATE, not a timestamp offset", () => {
  // The case that separates a date comparison from `now() + interval 'N days'`: under
  // an offset this booking is beyond the horizon whenever the suite runs before 23:59.
  clearBookings();
  assert.equal(bookState({ legacy: "h-2", fromDay: 30, toDay: 31, fromTime: "23:59", toTime: "02:00" }), "OK");
});

pin("day N+1 is REFUSED with errcode GV46H", () => {
  clearBookings();
  const state = bookState({ legacy: "h-3", fromDay: 31, toDay: 31 });
  assert.equal(state, "GV46H", "one day past the horizon must raise the horizon code");
  assert.equal(bookingCount(), 0, "and nothing may be written");
});

pin("day N+1 at 00:00 is REFUSED too — no partial-day grace at the boundary", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "h-4", fromDay: 31, toDay: 31, fromTime: "00:00", toTime: "01:00" }), "GV46H");
});

pin("the horizon judges the START, so a long booking may END beyond it", () => {
  // Deliberate: the rule is about how far ahead a claim is PLANTED, not how long it
  // runs. Length is the other cap's job, and conflating them would refuse the summer
  // holiday that starts tomorrow.
  clearBookings();
  assert.equal(bookState({ legacy: "h-5", fromDay: 29, toDay: 90 }), "OK");
});

pin("BACKDATING is untouched by the horizon", () => {
  clearBookings();
  assert.equal(
    bookState({ legacy: "h-6", fromDay: -20, toDay: -19 }),
    "OK",
    "a forward-only bound must never catch a past date",
  );
});

pin("an ADMIN is not exempt from the horizon", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "h-7", fromDay: 400, toDay: 400, actor: "anna@test.dk" }), "GV46H");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. BOTH AT ONCE, and the codes stay distinguishable
// ═══════════════════════════════════════════════════════════════════════════════

clearBookings();
setCaps({ days: 5, horizon: 30 });

pin("with both on, a booking that violates only the horizon reports GV46H", () => {
  assert.equal(bookState({ legacy: "b-1", fromDay: 100, toDay: 100 }), "GV46H");
});

pin("with both on, a booking that violates only the day cap reports GV46D", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "b-2", fromDay: 1, toDay: 10 }), "GV46D");
});

pin("a booking inside both caps is accepted with both on", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "b-3", fromDay: 2, toDay: 4 }), "OK");
  assert.equal(bookingCount(), 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. THE SETTER RPCs — admin-gated, null clears, event on real change only
// ═══════════════════════════════════════════════════════════════════════════════

clearBookings();
setCaps({ days: null, horizon: null });

const capValue = (column) =>
  psql(CONTAINER, DB, ["-t", "-A", "-c", `select coalesce(${column}::text, 'NULL') from public.ledgers where id='caps';`])
    .stdout.trim();

const eventCount = () =>
  Number(
    psql(CONTAINER, DB, [
      "-t",
      "-A",
      "-c",
      "select count(*) from public.ledger_events where event_type='settings_changed';",
    ]).stdout.trim(),
  );

pin("an admin can set the day cap, and it writes one settings_changed event", () => {
  run("delete from public.ledger_events;");
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_max_days_per_member('caps', 7, null, null);"), "OK");
  assert.equal(capValue("booking_max_days_per_member"), "7");
  assert.equal(eventCount(), 1, "the feed insert is also what live-syncs the rule to other members");
});

pin("re-saving the SAME number writes NO second event", () => {
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_max_days_per_member('caps', 7, null, null);"), "OK");
  assert.equal(eventCount(), 1, "`is distinct from` must suppress the no-op");
});

pin("NULL clears the day cap — the thing update_ledger_settings could never express", () => {
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_max_days_per_member('caps', null, null, null);"), "OK");
  assert.equal(capValue("booking_max_days_per_member"), "NULL", "null is a real value here, not 'leave it alone'");
  assert.equal(eventCount(), 2, "clearing the cap is a real change and belongs in the feed");
});

pin("a NON-admin cannot set either cap (42501)", () => {
  assert.equal(sqlstateOf("bo@test.dk", "perform public.set_booking_max_days_per_member('caps', 3, null, null);"), "42501");
  assert.equal(sqlstateOf("bo@test.dk", "perform public.set_booking_horizon_days('caps', 3, null, null);"), "42501");
});

pin("out-of-range values are refused as sentences (22023), not raw constraint violations", () => {
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_max_days_per_member('caps', 0, null, null);"), "22023");
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_max_days_per_member('caps', 366, null, null);"), "22023");
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_horizon_days('caps', 0, null, null);"), "22023");
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_horizon_days('caps', 731, null, null);"), "22023");
});

pin("the horizon setter round-trips and clears the same way", () => {
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_horizon_days('caps', 45, null, null);"), "OK");
  assert.equal(capValue("booking_horizon_days"), "45");
  assert.equal(sqlstateOf("anna@test.dk", "perform public.set_booking_horizon_days('caps', null, null, null);"), "OK");
  assert.equal(capValue("booking_horizon_days"), "NULL");
});

pin("a stranger cannot count another workspace's booked days (42501)", () => {
  assert.equal(
    sqlstateOf("stranger@test.dk", "perform public.booked_days_in_open_period('caps', '" + M(1) + "');"),
    "42501",
    "the helper is security definer, so it must gate membership itself",
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. THE ABSOLUTE DURATION CEILING — 92 days, a constant, not a setting (GV-426)
// ═══════════════════════════════════════════════════════════════════════════════
// Migration 162. Until it landed, `end > start` was the only length rule and a booking
// running to 2031 was a valid booking. The ceiling is measured the SAME way the day
// count is — inclusive calendar days in Europe/Copenhagen — so the number in the
// refusal and the "N dage" the booking sheet prints above the form agree. A nights
// implementation, or an `interval '92 days'` comparison against the two timestamps,
// is off by exactly one at the boundary, which is what the two cases either side of
// 92 are here to catch.

clearBookings();
setCaps({ days: null, horizon: null });

pin("a booking spanning exactly 92 days is ACCEPTED", () => {
  // Day 1 through day 92 inclusive is 92 days. `>` not `>=`, so the ceiling itself is
  // reachable — same convention as the day cap one section up.
  assert.equal(bookState({ legacy: "v-1", fromDay: 1, toDay: 92 }), "OK");
  assert.equal(bookingCount(), 1, "and it is really stored");
  assert.equal(bookedDays(), 92, "the count agrees with the ceiling's own arithmetic");
});

pin("a booking spanning 93 days is REFUSED with errcode GV46V", () => {
  clearBookings();
  assert.equal(
    bookState({ legacy: "v-2", fromDay: 1, toDay: 93 }),
    "GV46V",
    "one day past the ceiling must raise the duration code, not the day cap's",
  );
  assert.equal(bookingCount(), 0, "and nothing may be written");
});

pin("the boundary is measured in COPENHAGEN calendar days, not in 24-hour blocks", () => {
  // 92 calendar days that are SHORTER than 92×24h: 00:05 on day 1 to 23:55 on day 92
  // is 91 days 23:50 of elapsed time, so an `end - start > interval '92 days'` test
  // accepts it — and so does this, because it is 92 calendar days. The discriminating
  // half is the next assertion.
  clearBookings();
  assert.equal(
    bookState({ legacy: "v-3", fromDay: 1, toDay: 92, fromTime: "00:05", toTime: "23:55" }),
    "OK",
  );
  // And now 93 calendar days that are barely LONGER than 92×24h: 23:55 on day 1 to
  // 00:05 on day 93 is 92 days 00:10 elapsed. An interval test would call this 92-and-a-
  // bit and let it through on a rounding; the calendar-day count says 93 and refuses.
  clearBookings();
  assert.equal(
    bookState({ legacy: "v-4", fromDay: 1, toDay: 93, fromTime: "23:55", toTime: "00:05" }),
    "GV46V",
    "an elapsed-time comparison would accept this; inclusive calendar days must not",
  );
});

pin("a booking inside ONE day is 1 day, not 0 — the count is inclusive at both ends", () => {
  // The other end of the same arithmetic. A nights implementation makes this 0 and
  // then everything below 92 passes for the wrong reason.
  clearBookings();
  assert.equal(bookState({ legacy: "v-5", fromDay: 1, toDay: 1, fromTime: "09:00", toTime: "18:00" }), "OK");
  assert.equal(bookedDays(), 1);
});

pin("the ceiling applies with BOTH caps off — it is a sanity bound, not a workspace rule", () => {
  clearBookings();
  setCaps({ days: null, horizon: null });
  assert.equal(
    bookState({ legacy: "v-6", fromDay: 1, toDay: 400 }),
    "GV46V",
    "no group has opted into anything here; a years-long booking must still be refused",
  );
  assert.equal(bookingCount(), 0);
});

pin("an ADMIN is not exempt from the duration ceiling", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "v-7", fromDay: 1, toDay: 200, actor: "anna@test.dk" }), "GV46V");
});

pin("BACKDATING is bounded too — a long window in the past is refused the same way", () => {
  clearBookings();
  assert.equal(bookState({ legacy: "v-8", fromDay: -200, toDay: -1 }), "GV46V");
  assert.equal(bookState({ legacy: "v-9", fromDay: -92, toDay: -1 }), "OK", "92 days back still fits");
});

pin("the ceiling is judged BEFORE the horizon, so an over-long booking says GV46V", () => {
  // With a tight horizon both rules fire on a far-future 400-day booking. The duration
  // check sits with the window validation, ahead of every lookup, so the code the user
  // sees names the thing they can actually fix by editing the form.
  clearBookings();
  setCaps({ days: null, horizon: 30 });
  assert.equal(bookState({ legacy: "v-10", fromDay: 100, toDay: 500 }), "GV46V");
  setCaps({ days: null, horizon: null });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. THE CAP COUNT UNDER A REAL INTERLEAVING (GV-426)
// ═══════════════════════════════════════════════════════════════════════════════
// The defect migration 162 closes only exists while two saves OVERLAP, so this has to
// produce the overlap rather than approximate it. Two calls in a ROW pass under the
// broken implementation too: the second reads a committed row and counts correctly.
//
// The advisory lock migration 063 added is keyed on the BOOKING
// (ledger || ':booking:' || legacy_id), so two saves with DIFFERENT legacy ids take
// different locks and never wait for each other, while the cap counts across every
// booking the MEMBER holds. Both read the count before either inserts, both see room,
// both are written. Migration 162 adds a second lock keyed on (ledger, member), taken
// only when the cap is on.
//
//   A: begin; save booking 'race-a' (3 days)   → passes the count, holds the member lock
//   B: begin; save booking 'race-b' (3 days)   → sent async, blocks on A's member lock
//   (assert B really is blocked — otherwise the two never overlapped and this proves
//    nothing)
//   A: commit                                  → B unblocks, re-counts, sees A's 3 days
//   B: refused with GV46D
//
// Without the member lock B never waits, counts 0 + 3 = 3 against a cap of 5, and both
// bookings are stored — six booked days in a workspace that set the ceiling at five.
//
// dblink gives two extra sessions from inside one psql call, and dblink_send_query is
// asynchronous, which is what makes the interleaving deterministic. Cribbed from
// test-fuel-stop-verdict-contract.mjs's GV-415 probe.

clearBookings();
setCaps({ days: 5, horizon: null });

if (psql(CONTAINER, DB, ["-c", "create extension if not exists dblink;"]).status !== 0) {
  fail("Could not set up the interleaving probe (dblink unavailable?).");
}

// The RPC raises on refusal, and an exception crossing dblink_get_result would abort
// the probe. So each side calls a wrapper that converts the outcome into a value.
const bookHelper = `
create or replace function public.gv426_try_book(
  legacy text,
  from_day integer,
  to_day integer
)
returns text
language plpgsql
as $helper$
begin
  perform public.upsert_car_booking(
    'caps',
    legacy,
    '${M(1)}',
    ((((now() at time zone 'Europe/Copenhagen')::date + from_day) + time '09:00') at time zone 'Europe/Copenhagen'),
    ((((now() at time zone 'Europe/Copenhagen')::date + to_day) + time '18:00') at time zone 'Europe/Copenhagen'),
    null, null, null, null);
  return 'OK';
exception when others then
  return sqlstate;
end;
$helper$;`;
if (psql(CONTAINER, DB, ["-c", bookHelper]).status !== 0) fail("Could not create the booking helper.");

// Each dblink session is its own backend with its own GUCs, so the JWT claims have to
// be SET on the connection or the membership gate never fires there.
const CLAIMS = `set request.jwt.claims = ''{"email":"anna@test.dk","role":"authenticated"}''`;

const raceProbe = `
create or replace function public.gv426_race_probe(winner_call text, loser_call text)
returns jsonb
language plpgsql
as $probe$
declare
  winner_result text;
  loser_result text;
  blocked integer := 0;
  attempts integer := 0;
begin
  perform dblink_connect('gv426_a', 'dbname=' || current_database());
  perform dblink_connect('gv426_b', 'dbname=' || current_database());
  perform dblink_exec('gv426_a', '${CLAIMS}');
  perform dblink_exec('gv426_b', '${CLAIMS}');
  perform dblink_exec('gv426_a', 'begin');
  perform dblink_exec('gv426_b', 'begin');

  -- A saves and stays open, so its transaction-scoped advisory locks are still held.
  select r into winner_result from dblink('gv426_a', winner_call) as w(r text);

  -- B saves too. Asynchronous, so it can sit on A's lock while we watch.
  perform dblink_send_query('gv426_b', loser_call);

  -- Wait until B is demonstrably blocked. pg_stat_activity is snapshotted per
  -- transaction, so the snapshot has to be cleared on every pass or this loop reads
  -- the same stale row 100 times.
  while attempts < 100 and blocked = 0 loop
    perform pg_sleep(0.1);
    perform pg_stat_clear_snapshot();
    select count(*) into blocked
    from pg_stat_activity a
    where a.datname = current_database()
      and a.pid <> pg_backend_pid()
      and a.wait_event_type = 'Lock'
      and a.query like '%gv426_try_book%';
    attempts := attempts + 1;
  end loop;

  perform dblink_exec('gv426_a', 'commit');

  select r into loser_result from dblink_get_result('gv426_b') as l(r text);
  -- libpq hands back one result per send; the empty trailing one has to be drained or
  -- the next command on that connection errors with "another command is already in
  -- progress".
  perform * from dblink_get_result('gv426_b') as l(r text);
  perform dblink_exec('gv426_b', 'commit');
  perform dblink_disconnect('gv426_a');
  perform dblink_disconnect('gv426_b');

  return jsonb_build_object(
    'winner', winner_result,
    'loser', loser_result,
    'loser_blocked_on_winner', blocked > 0
  );
end;
$probe$;`;
if (psql(CONTAINER, DB, ["-c", raceProbe]).status !== 0) fail("Could not create the interleaving probe.");

const race = JSON.parse(
  psql(CONTAINER, DB, [
    "-t",
    "-A",
    "-c",
    `select public.gv426_race_probe(
       $$select public.gv426_try_book('race-a', 1, 3)$$,
       $$select public.gv426_try_book('race-b', 10, 12)$$
     )::text;`,
  ]).stdout.trim(),
);

pin("two CONCURRENT bookings for one member really do overlap on the member lock", () => {
  assert.equal(
    race.loser_blocked_on_winner,
    true,
    "the second save never waited on the first, so the two never overlapped and this run proves " +
      "nothing about the race. Sequential saves pass under the unlocked implementation too.",
  );
});

pin("the loser is refused with GV46D — the cap cannot be walked past by two writers", () => {
  assert.equal(race.winner, "OK", "the first save fits the cap and must land");
  assert.equal(
    race.loser,
    "GV46D",
    "three days plus three days is six against a cap of five. Without the member-scoped lock the " +
      "loser counts against a snapshot taken before the winner committed, sees 3, and is saved.",
  );
});

pin("only ONE of the two concurrent bookings is stored, and the cap is intact", () => {
  assert.equal(bookingCount(), 1, "a second row here is the over-booking the lock exists to prevent");
  assert.equal(bookedDays(), 3, "the member holds three days, not six, against a cap of five");
});

// ── The other half of the promise: a cap-less workspace gains NO contention ────
// The lock has to be free for every group that never opted in, or migration 162 pays
// for a rule almost nobody has turned on with serialization everybody feels. Proved
// two ways: by counting the advisory locks the session actually holds, and by trying
// the member key from another session — the session-level and transaction-level
// advisory functions share one lock space, so a successful try is proof the key is
// not held rather than proof of a lock count.

const MEMBER_KEY = `caps:bookingcap:${M(1)}`;

const lockProbe = `
create or replace function public.gv426_lock_probe(call_sql text, member_key text)
returns jsonb
language plpgsql
as $probe$
declare
  probe_pid integer;
  advisory_locks integer;
  member_key_free boolean;
begin
  perform dblink_connect('gv426_lp', 'dbname=' || current_database());
  perform dblink_exec('gv426_lp', '${CLAIMS}');
  perform dblink_exec('gv426_lp', 'begin');
  select p into probe_pid from dblink('gv426_lp', 'select pg_backend_pid()') as t(p integer);
  perform * from dblink('gv426_lp', call_sql) as t(r text);

  select count(*)::integer into advisory_locks
  from pg_locks
  where locktype = 'advisory' and pid = probe_pid and granted;

  select pg_try_advisory_lock(hashtext(member_key)) into member_key_free;
  if member_key_free then
    perform pg_advisory_unlock(hashtext(member_key));
  end if;

  -- Nothing the probe wrote is kept; the point was only which locks were taken.
  perform dblink_exec('gv426_lp', 'rollback');
  perform dblink_disconnect('gv426_lp');

  return jsonb_build_object('advisory_locks', advisory_locks, 'member_key_free', member_key_free);
end;
$probe$;`;
if (psql(CONTAINER, DB, ["-c", lockProbe]).status !== 0) fail("Could not create the lock probe.");

const lockProbeRun = (legacy) =>
  JSON.parse(
    psql(CONTAINER, DB, [
      "-t",
      "-A",
      "-c",
      `select public.gv426_lock_probe(
         $$select public.gv426_try_book('${legacy}', 1, 2)$$,
         '${MEMBER_KEY}'
       )::text;`,
    ]).stdout.trim(),
  );

clearBookings();
setCaps({ days: null, horizon: null });

pin("with the day cap NULL the member lock is NOT taken — no new contention for anyone", () => {
  const probe = lockProbeRun("lock-off");
  assert.equal(
    probe.advisory_locks,
    1,
    "a cap-less save must hold exactly the ONE per-booking lock migration 063 added. Two here means " +
      "the member lock escaped its branch and every group in the product now serializes on it.",
  );
  assert.equal(
    probe.member_key_free,
    true,
    "and the (ledger, member) key specifically must be free — session and transaction advisory locks " +
      "share one space, so another session can take it while the save is still open",
  );
});

setCaps({ days: 30, horizon: null });

pin("with the day cap SET the member lock IS taken, on the (ledger, member) key", () => {
  const probe = lockProbeRun("lock-on");
  assert.equal(
    probe.advisory_locks,
    2,
    "the per-booking lock plus the member lock. One here means the count is still unserialized.",
  );
  assert.equal(
    probe.member_key_free,
    false,
    `pg_try_advisory_lock(hashtext('${MEMBER_KEY}')) must FAIL while the save is open. This is the ` +
      "key identity check: a lock on any other key would still make the count above 2.",
  );
});

setCaps({ days: null, horizon: null });
clearBookings();

// ── Part 9: the static half ────────────────────────────────────────────────────
// The equivalence checker proves the migration and supabase-schema.sql replay
// identically; this proves the shape is the INTENDED one rather than identically
// wrong in both, which is the failure a replay diff cannot see.

const migration = readFileSync(path.join(ROOT, "supabase/migrations/159_booking_day_and_horizon_caps.sql"), "utf8");

pin("migration 159 declares both columns as NULLABLE with no default", () => {
  assert.match(
    migration,
    /add column if not exists booking_max_days_per_member integer,\s*\n\s*add column if not exists booking_horizon_days integer;/,
    "a NOT NULL or a DEFAULT here would turn the feature on for every existing workspace",
  );
  assert.doesNotMatch(
    migration,
    /booking_(max_days_per_member|horizon_days) integer\s+(not null|default)/i,
    "neither column may carry a default",
  );
});

pin("no backfill statement touches the new columns", () => {
  assert.doesNotMatch(
    migration,
    /update public\.ledgers\s+set booking_(max_days_per_member|horizon_days)\s*=\s*\d/i,
    "a backfill would silently opt every existing group in",
  );
});

pin("the two errcodes are distinct and are the documented ones", () => {
  assert.ok(migration.includes("errcode = 'GV46D'"), "the day cap must raise GV46D");
  assert.ok(migration.includes("errcode = 'GV46H'"), "the horizon must raise GV46H");
});

// Migration 162's static half (GV-426). The lock-count pins above prove the member
// lock is conditional by observation; this proves it is conditional by CONSTRUCTION,
// which is the version that survives someone rewriting the branch.

const lockMigration = readFileSync(
  path.join(ROOT, "supabase/migrations/162_booking_cap_lock_and_duration.sql"),
  "utf8",
);

pin("migration 162 raises GV46V for the duration ceiling, and names 92 in the Danish message", () => {
  assert.ok(lockMigration.includes("errcode = 'GV46V'"), "the duration ceiling must raise GV46V");
  assert.match(
    lockMigration,
    /raise exception 'Bookingen varer % dage, og en booking kan højst vare 92 dage'/,
    "the refusal has to name the limit — a bare 'for lang' leaves the user guessing what fits",
  );
});

pin("92 is a hard constant: no column, no setter RPC, nothing a workspace can change", () => {
  assert.doesNotMatch(
    lockMigration,
    /alter table[\s\S]{0,200}booking_max_duration|set_booking_max_duration/i,
    "the ceiling is a sanity bound, not a policy. A setting would need a ceiling of its own.",
  );
});

pin("the member lock sits INSIDE the `cap_max_days is not null` branch", () => {
  // The branch is what keeps every cap-less workspace free of new contention. Matched
  // as "the branch opens, and the next advisory lock is the member one, with no `end
  // if` in between" so the lock cannot be hoisted out without this failing.
  const branch = lockMigration.match(
    /if cap_max_days is not null then([\s\S]*?)would_hold_days := public\.booked_days_in_open_period\(/,
  );
  assert.ok(branch, "the day-cap branch must still open before the count");
  assert.match(
    branch[1],
    /perform pg_advisory_xact_lock\(hashtext\(target_ledger_id \|\| ':bookingcap:' \|\| booking_member_id::text\)\);/,
    "the (ledger, member) lock must be taken inside the branch and before the count",
  );
  assert.doesNotMatch(branch[1], /end if;/, "nothing may close the branch between the lock and the count");
});

pin("the member key is DISTINCT from the per-booking key", () => {
  assert.ok(
    lockMigration.includes("':booking:' || legacy_booking_id"),
    "the per-booking lock from migration 063 must survive",
  );
  assert.ok(
    lockMigration.includes("':bookingcap:' || booking_member_id::text"),
    "and the member lock must use its own infix, or the two key spaces collide",
  );
});

pin("the GV-421 conflict guard still sits AHEAD of the caps", () => {
  const guard = lockMigration.indexOf("errcode = 'GV42B'");
  const dayCap = lockMigration.indexOf("errcode = 'GV46D'");
  const horizon = lockMigration.indexOf("errcode = 'GV46H'");
  assert.ok(guard > 0 && dayCap > 0 && horizon > 0, "all three codes must still be in the function");
  assert.ok(
    guard < horizon && guard < dayCap,
    'migration 160 put the precondition first on purpose: "loftet er nået" is the wrong sentence ' +
      "for a row that simply moved",
  );
});

pin("the duration check is judged before any ledger lookup", () => {
  const duration = lockMigration.indexOf("errcode = 'GV46V'");
  const membership = lockMigration.indexOf("public.is_ledger_member(target_ledger_id)");
  assert.ok(duration > 0 && membership > 0);
  assert.ok(
    duration < membership,
    "it judges only the two timestamps the caller sent, so it needs no lookup and leaks nothing",
  );
});

removeContainer(CONTAINER);

process.stdout.write(
  `\nok - booking caps contract: ${checked} checks. Both caps are OFF by default and byte-identical when null; ` +
    `a day is an inclusive calendar day in Europe/Copenhagen counted DISTINCT within the open period; ` +
    `the day cap accepts exactly ON the cap and refuses one past it with GV46D; the horizon accepts day N ` +
    `at any hour and refuses day N+1 with GV46H; backdating is untouched. A booking spans at most 92 ` +
    `inclusive Copenhagen days (GV46V at 93, with both caps off, for admins and for backdating alike), ` +
    `and the day cap survives a REAL interleaving: the second of two concurrent saves blocks on the ` +
    `(ledger, member) advisory lock and is refused, while a cap-less workspace takes no member lock at all.\n`,
);

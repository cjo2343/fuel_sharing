// Unit test for the scanner behind tools/check-ledger-event-classification.mjs (GV-413).
//
//   node tools/test-ledger-event-classification-scan.mjs   (also run by `npm run validate`)
//
// The guard this tests exists because three reminder-audit event types reached members'
// Activity feeds without anything failing. A guard built to catch that has one failure
// mode worse than not existing: passing whether or not the thing it guards is true. So
// the properties this file proves, in order of importance, are
//
//   1. it FAILS on an unclassified event type — including one hidden behind a PL/pgSQL
//      variable or a CASE expression, which is how a tenth of the real INSERTs are written;
//   2. it PASSES for EITHER honest answer — audit (EVENT_TYPE_EXCLUDE) or feed
//      (FEED_VISIBLE_EVENT_TYPES). A guard that only accepts one of them is an opinion,
//      not a control;
//   3. it THROWS on SQL it cannot read, rather than reporting an empty scan as a clean one.
//
// Everything else here is scaffolding for those three.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVENT_TYPE_EXCLUDE } from "./load-rehearsal/lib/hotpaths.mjs";
import {
  EventScanError,
  stripSqlComments,
  splitTopLevel,
  extractLiteralAlternatives,
  enclosingBody,
  assignedExpressions,
  scanSqlSource,
  scanWebSource,
  collectEventTypes,
  classify,
  orderSources,
} from "./check-ledger-event-classification.mjs";

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

// A miniature but shape-faithful stand-in for a migration: one plain literal INSERT
// (the migration 051 shape), one INSERT ... SELECT (the migration 118 shape) and one
// that writes a variable resolved through a CASE (the migration 087 shape).
const MIGRATION = `
-- Migration 999: fixture
-- insert into public.ledger_events — this line is a COMMENT and must be ignored.
create or replace function public.log_a(event_title text)
returns void language plpgsql as $$
begin
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, 'alpha_created', event_title, '', actor_member_id, null,
    jsonb_build_object('a', 1)
  );
end;
$$;

create or replace function public.log_b(next_status text)
returns void language plpgsql as $$
declare
  event_type_value text;
begin
  event_type_value := case
    when next_status = 'requested' then 'beta_requested'
    else 'beta_other'
  end;
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  ) values (
    target_ledger_id, event_type_value, 'Titel', '', actor_member_id, null, '{}'::jsonb
  );
end;
$$;

create or replace function public.log_c()
returns integer language sql as $$
  insert into public.ledger_events (
    ledger_id, event_type, title, body, actor_member_id, actor_email, metadata
  )
  select c.ledger_id, 'gamma_sent', 'Påmindelse sendt', '', null, null,
         jsonb_build_object('outcome', c.outcome)
  from confirmed c;
$$;
`;

const WEB_SOURCE = `
      if (count > 0) {
        await sbInsert(env, 'ledger_events', {
          ledger_id: id,
          event_type: 'operator_did_something',
          title: 'Operatøren gjorde noget',
        });
      }
`;

function scanFixture(sql = MIGRATION) {
  return scanSqlSource(sql, "supabase/migrations/999_fixture.sql");
}

// The register as it would stand with every fixture type classified as visible.
const REGISTER = {
  excluded: ["gamma_sent"],
  visible: ["alpha_created", "beta_requested", "beta_other"],
};

console.log("\nledger_events classification scanner");

// ── Small helpers ──
test("stripSqlComments drops line comments but keeps string literals intact", () => {
  assert.equal(stripSqlComments("select 'a--b' -- trailing\nfrom t").trim(), "select 'a--b' \nfrom t".trim());
});

test("stripSqlComments drops block comments", () => {
  assert.equal(stripSqlComments("select /* insert into public.ledger_events */ 1").replace(/\s+/g, " "), "select 1");
});

test("splitTopLevel ignores commas inside parens and quotes", () => {
  assert.deepEqual(splitTopLevel("a, f(b, c), 'd,e'"), ["a", "f(b, c)", "'d,e'"]);
});

test("orderSources puts the earliest migration first and the consolidated schema last", () => {
  assert.deepEqual(
    orderSources(["supabase-schema.sql", "supabase/migrations/118_x.sql", "supabase/migrations/051_y.sql"]),
    ["supabase/migrations/051_y.sql", "supabase/migrations/118_x.sql", "supabase-schema.sql"],
  );
});

// ── Literal resolution ──
test("extractLiteralAlternatives reads a bare literal", () => {
  assert.deepEqual(extractLiteralAlternatives("'trip_created'"), { literals: ["trip_created"], unresolved: [] });
});

test("extractLiteralAlternatives reads every branch of a CASE", () => {
  const r = extractLiteralAlternatives("case when x then 'a' when y then 'b' else 'c' end");
  assert.deepEqual(r.literals.sort(), ["a", "b", "c"]);
  assert.deepEqual(r.unresolved, []);
});

test("extractLiteralAlternatives reports a concatenated type as UNRESOLVED, not as nothing", () => {
  const r = extractLiteralAlternatives("case when x then 'a' else 'settlement_' || normalized_status end");
  assert.deepEqual(r.literals, ["a"]);
  assert.deepEqual(r.unresolved, ["'settlement_' || normalized_status"]);
});

test("assignedExpressions finds := assignments and declare initialisers", () => {
  const body = "declare v text := 'one'; begin v := 'two'; end";
  assert.deepEqual(assignedExpressions(body, "v").sort(), ["'one'", "'two'"]);
});

test("enclosingBody scopes a variable to the function that writes the event", () => {
  const sql = "as $$ declare v text; begin v := 'first'; end $$;\nas $$ declare v text; begin v := 'second'; end $$;";
  assert.match(enclosingBody(sql, sql.indexOf("'second'")), /second/);
  assert.doesNotMatch(enclosingBody(sql, sql.indexOf("'second'")), /first/);
});

// ── The SQL scan ──
test("scanSqlSource finds all three INSERT shapes and resolves each event type", () => {
  const sites = scanFixture();
  assert.equal(sites.length, 3);
  const literals = sites.flatMap((s) => s.literals).sort();
  assert.deepEqual(literals, ["alpha_created", "beta_other", "beta_requested", "gamma_sent"]);
});

test("scanSqlSource does NOT count the INSERT written in a comment", () => {
  // The fixture's header contains the literal phrase in a `--` comment. Three real
  // sites, not four — a scanner that counted the comment would also be reading prose
  // for event types.
  assert.equal(scanFixture().length, 3);
});

test("scanWebSource reads govehlo-web's direct insert", () => {
  const sites = scanWebSource(WEB_SOURCE, "govehlo-web/api/x.js");
  assert.deepEqual(sites.map((s) => s.literals), [["operator_did_something"]]);
});

// ── Unreadable SQL is an ERROR, never a pass ──
test("an INSERT with no column list raises EventScanError", () => {
  assert.throws(() => scanSqlSource("insert into public.ledger_events values (1, 'x');"), EventScanError);
});

test("an INSERT that never names event_type raises EventScanError", () => {
  assert.throws(
    () => scanSqlSource("insert into public.ledger_events (ledger_id, title) values (1, 'x');"),
    EventScanError,
  );
});

test("an INSERT writing an unassigned variable raises EventScanError", () => {
  assert.throws(
    () => scanSqlSource("insert into public.ledger_events (ledger_id, event_type) values (1, mystery_var);"),
    EventScanError,
  );
});

test("an sbInsert with no literal event_type raises EventScanError", () => {
  assert.throws(() => scanWebSource("await sbInsert(env, 'ledger_events', { ledger_id: id });"), EventScanError);
});

// ── collectEventTypes: computed expressions must be declared ──
test("an undeclared computed expression is reported, not silently dropped", () => {
  const sql = MIGRATION.replace("else 'beta_other'", "else 'beta_' || next_status");
  const { types, undeclaredExpressions } = collectEventTypes(scanFixture(sql), {});
  assert.equal(undeclaredExpressions.length, 1);
  assert.equal(undeclaredExpressions[0].expression, "'beta_' || next_status");
  assert.equal(undeclaredExpressions[0].via, "event_type_value");
  assert.equal(types.has("beta_other"), false);
});

test("a declared computed expression contributes its concrete types", () => {
  const sql = MIGRATION.replace("else 'beta_other'", "else 'beta_' || next_status");
  const { types, undeclaredExpressions } = collectEventTypes(scanFixture(sql), {
    "'beta_' || next_status": ["beta_open", "beta_cancelled"],
  });
  assert.deepEqual(undeclaredExpressions, []);
  assert.equal(types.has("beta_open"), true);
  assert.equal(types.has("beta_cancelled"), true);
});

test("a declared expression nothing writes any more is reported as stale", () => {
  const { staleExpressions } = collectEventTypes(scanFixture(), { "'x_' || y": ["x_a"] });
  assert.deepEqual(staleExpressions, ["'x_' || y"]);
});

// ── classify: the property the whole ticket turns on ──
test("a fully classified register is clean", () => {
  const { types } = collectEventTypes(scanFixture(), {});
  const result = classify(types, REGISTER);
  assert.deepEqual(result.unclassified, []);
  assert.deepEqual(result.both, []);
  assert.deepEqual(result.staleVisible, []);
});

test("a NEW event type in neither list FAILS, named, with the file it came from", () => {
  const sql = MIGRATION.replace("'alpha_created'", "'delta_leaked'");
  const { types } = collectEventTypes(scanFixture(sql), {});
  const { unclassified } = classify(types, REGISTER);
  assert.deepEqual(unclassified.map((u) => u.type), ["delta_leaked"]);
  assert.deepEqual(unclassified[0].sources, ["supabase/migrations/999_fixture.sql"]);
});

test("...and PASSES once it is called AUDIT (EVENT_TYPE_EXCLUDE)", () => {
  const sql = MIGRATION.replace("'alpha_created'", "'delta_leaked'");
  const { types } = collectEventTypes(scanFixture(sql), {});
  const { unclassified } = classify(types, {
    excluded: [...REGISTER.excluded, "delta_leaked"],
    visible: REGISTER.visible.filter((t) => t !== "alpha_created"),
  });
  assert.deepEqual(unclassified, []);
});

test("...and PASSES once it is called FEED (FEED_VISIBLE_EVENT_TYPES)", () => {
  // The one the ticket calls out: if this fails, the guard is an opinion about where
  // new events belong rather than a control that a decision was made at all.
  const sql = MIGRATION.replace("'alpha_created'", "'delta_leaked'");
  const { types } = collectEventTypes(scanFixture(sql), {});
  const { unclassified } = classify(types, {
    excluded: REGISTER.excluded,
    visible: [...REGISTER.visible.filter((t) => t !== "alpha_created"), "delta_leaked"],
  });
  assert.deepEqual(unclassified, []);
});

test("a type hidden behind a CASE branch is caught too", () => {
  const sql = MIGRATION.replace("'beta_other'", "'beta_leaked'");
  const { types } = collectEventTypes(scanFixture(sql), {});
  const { unclassified } = classify(types, REGISTER);
  assert.deepEqual(unclassified.map((u) => u.type), ["beta_leaked"]);
});

test("a type in BOTH lists fails — the audit filter wins, so 'visible' would be a lie", () => {
  const { types } = collectEventTypes(scanFixture(), {});
  const { both } = classify(types, { excluded: ["gamma_sent"], visible: [...REGISTER.visible, "gamma_sent"] });
  assert.deepEqual(both, ["gamma_sent"]);
});

test("a visible entry nothing writes any more is reported as stale", () => {
  const { types } = collectEventTypes(scanFixture(), {});
  const { staleVisible } = classify(types, { ...REGISTER, visible: [...REGISTER.visible, "ancient_type"] });
  assert.deepEqual(staleVisible, ["ancient_type"]);
});

test("a type whose writer was NOT scanned is exempt from the stale check, not failed", () => {
  // Found by running the guard in a tree with no sibling repos: without the exemption
  // it reported operator_data_removed — written by govehlo-web, correctly registered —
  // as "nothing writes this any more", i.e. it failed the register for being right.
  const { types } = collectEventTypes(scanFixture(), {});
  const visible = [...REGISTER.visible, "operator_did_something"];
  assert.deepEqual(classify(types, { ...REGISTER, visible }).staleVisible, ["operator_did_something"]);
  assert.deepEqual(
    classify(types, { ...REGISTER, visible, staleExempt: ["operator_did_something"] }).staleVisible,
    [],
  );
});

// ── The historical case: migration 118 ──
test("the guard would have caught confirm_reminder_sent at migration 118", () => {
  // Replays the real regression against the real migration file rather than a fixture:
  // migration 118 introduced confirm_reminder_sent, it never reached EVENT_TYPE_EXCLUDE,
  // and it has been visible in every member's feed ever since (GVM-490).
  //
  // `excluded` is the LIVE EVENT_TYPE_EXCLUDE, not a reconstruction of the 2026-era
  // list — the point is that even today, with four sibling *_reminder_sent types
  // filtered out, this one is in neither list. `visible: []` stands in for a tree where
  // GV-413's register does not yet name it.
  const sites = scanSqlSource(
    readFileSync(new URL("../supabase/migrations/118_confirm_receipt_reminders.sql", import.meta.url), "utf8"),
    "supabase/migrations/118_confirm_receipt_reminders.sql",
  );
  const { types } = collectEventTypes(sites, {});
  const { unclassified } = classify(types, { excluded: EVENT_TYPE_EXCLUDE, visible: [] });
  assert.deepEqual(unclassified.map((u) => u.type), ["confirm_reminder_sent"]);
  assert.deepEqual(unclassified[0].sources, ["supabase/migrations/118_confirm_receipt_reminders.sql"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

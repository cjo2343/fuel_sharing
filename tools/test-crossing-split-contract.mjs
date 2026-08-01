// Anti-drift contract for the bro/færge crossing split (GVM-415).
//
// ── Why this file exists ────────────────────────────────────────────────────────
// A crossing cost is settled by TWO independent implementations of the same rule:
// public.calculate_period_settlement (migration 157) and govehlo-mobile's
// src/lib/settlement-calc.ts. That is the third pair of copies in this engine — fuel,
// expenses and repairs each already exist twice — and the previous two taught the same
// lesson: two copies of money arithmetic with nothing holding them together do not
// diverge loudly. They diverge by øre, silently, and the only symptom is a close that
// the server rejects with "Snapshot member amounts do not match", or worse, a close the
// server ACCEPTS because the difference sat under the 0,02 kr tolerance while the
// balances everyone read were wrong.
//
// The crossing rule is unusually easy to get wrong on one side only, because it is the
// one split in the engine that follows NEITHER of the two rules already in the file:
//
//   • its universe is the TRIP's assignees, not the workspace's active members. A
//     member who was not in the car owes nothing, even though they owe a share of every
//     expense and every repair in the same period.
//   • its weights are EQUAL, always. It does not read ledgers.repairs_split_mode and it
//     does not read expense_split_defaults, and it is never km-weighted — a bridge toll
//     is charged per vehicle, so the passenger who was dropped off first paid to cross
//     it just as much as the driver did.
//
// Either of those, implemented as "like repairs" on one side and "like the decision" on
// the other, produces a plausible number on both sides and a wrong one on one.
//
// ── What is pinned ──────────────────────────────────────────────────────────────
// Part 1 (Docker): the SQL's ACTUAL arithmetic, against a real Postgres replay of
// supabase-schema.sql. A regex over the SQL would happily pass a mutation that changes
// the answer — the whole point of the 250,00 kr / 3 case below is that 83,34+83,33+83,33
// is the only correct answer and every plausible mistake (km weights, workspace-wide
// split, per-member rounding, a flipped tie-break) produces a different one.
//
// Part 2 (static): that migration 157 and supabase-schema.sql agree — the equivalence
// checker proves the two replay identically, this proves the shape is the intended one
// rather than identically wrong in both.
//
// Part 3 (cross-repo): that govehlo-mobile's settlement-calc.ts and period-snapshot.ts
// carry the mirror. See the note on modes below — this half is the paired-merge alarm.
//
// ── Modes ───────────────────────────────────────────────────────────────────────
//   node tools/test-crossing-split-contract.mjs            # warn on what it cannot check
//   node tools/test-crossing-split-contract.mjs --strict   # umbrella: unchecked = failure
//
// Two things can be uncheckable, and they warn for different reasons:
//
//   1. No Docker → the SQL was not executed. Same contract as
//      test-fuel-stop-verdict-contract.mjs, so `npm run validate` stays dependency-free.
//   2. govehlo-mobile absent, OR present with NO crossing support at all → the mobile
//      twin of this change has not landed yet. Same tolerate-missing convention as
//      check-hotpath-mirror.mjs and check-token-drift.mjs.
//
// Case 2 is deliberately narrow. "No crossing support at all" is the pre-twin state and
// warns; a PARTIAL mirror — crossingPaid but no crossingShare, a splitByWeights call
// with km weights, a fingerprint that forgot the øre — is real drift and FAILS HARD even
// without --strict, because that is the state this file exists to catch. The umbrella
// runs --strict, so the platform PR's umbrella run stays RED until govehlo-mobile's twin
// merges. That is the paired-merge discipline working, not a check to relax: the SQL's
// trips fingerprint changes format in the same migration, so a client that has not
// shipped the mirror cannot close a period at all.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDbWithPrelude, psql, removeContainer, startPostgres } from "./lib/replay-container.mjs";

const STRICT = process.argv.includes("--strict");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = `govehlo-crossing-split-${process.pid}`;
const DB = "crossing";

const warnings = [];
function warn(title, message) {
  if (STRICT) {
    process.stderr.write(`\n::error title=${title}::${message} (--strict)\n`);
    process.exit(1);
  }
  warnings.push(message);
  process.stdout.write(`::warning title=${title}::${message}\n`);
}

let checked = 0;
function pin(label, fn) {
  fn();
  checked += 1;
  process.stdout.write(`  ok - ${label}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2 (first, because it needs nothing): the SQL's SHAPE
// ═══════════════════════════════════════════════════════════════════════════════
// Both files must carry it. check-schema-equivalence proves they REPLAY the same;
// only this says the thing they both replay is the thing GVM-415 decided.
const MIGRATION = join(ROOT, "supabase", "migrations", "157_trip_crossing_cost.sql");
const MIGRATION_158 = join(ROOT, "supabase", "migrations", "158_crossing_provided_contract.sql");
const CONSOLIDATED = join(ROOT, "supabase-schema.sql");

const consolidatedSql = readFileSync(CONSOLIDATED, "utf8");

const sqlSources = {
  "migration 157": readFileSync(MIGRATION, "utf8"),
  "supabase-schema.sql": consolidatedSql,
};

// The consolidated schema contains every historical definition, so a bare search for
// "crossing" there proves nothing about which definition WINS. Slice from the 157 header
// to the end: last definition wins on replay, so that tail is the live one.
function liveSql(name) {
  const source = sqlSources[name];
  if (name === "migration 157") return source;
  const idx = source.lastIndexOf("-- Migration 157:");
  assert.notEqual(idx, -1, "supabase-schema.sql is missing the migration 157 mirror block");
  return source.slice(idx);
}

// GV-417 re-declared the three trip-writing RPCs AGAIN, so 157's copies of them are no
// longer the live ones and pinning the write path against 157 would pin a superseded
// definition — the exact "reads text that is not the live code" failure the notes above
// warn about. The settlement and fingerprint pins above stay on 157 (158 does not touch
// either); everything about the write path is read from 158 and from the consolidated
// schema's 158 tail.
const writePathSources = {
  "migration 158": readFileSync(MIGRATION_158, "utf8"),
  "supabase-schema.sql (158 tail)": (() => {
    const idx = consolidatedSql.lastIndexOf("-- Migration 158:");
    assert.notEqual(idx, -1, "supabase-schema.sql is missing the migration 158 mirror block");
    return consolidatedSql.slice(idx);
  })(),
};

process.stdout.write("\nSQL shape (migration 157 + its supabase-schema.sql mirror):\n");
for (const name of Object.keys(sqlSources)) {
  const sql = liveSql(name);

  pin(`${name}: the crossing splits over the TRIP's assignees, not the active members`, () => {
    const cte = sql.slice(sql.indexOf("period_crossings as ("), sql.indexOf("crossing_share as ("));
    assert.notEqual(cte.length, 0, "period_crossings CTE not found");
    // The universe is trip_assignees — the very CTE the km split already resolved
    // (active participants, driver fallback). `cross join active_members`, which is how
    // the expense and repair chains build THEIR universe, must not appear here.
    assert.match(cte, /from trip_assignees ta/i);
    assert.match(cte, /unnest\(pc\.assignees\)/i);
    assert.doesNotMatch(
      cte,
      /cross join active_members/i,
      "a crossing must NOT split over the workspace's active members — only over the people on that trip",
    );
  });

  pin(`${name}: the crossing split is EQUAL — never km-weighted, never the Afregning rule`, () => {
    const cte = sql.slice(sql.indexOf("crossing_cents as ("), sql.indexOf("crossing_lr as ("));
    assert.notEqual(cte.length, 0, "crossing_cents CTE not found");
    // Equal shares are expressed as a plain division by the assignee count. Anything
    // reading km_sum, repairs_split_mode or a weight column here is a different rule.
    assert.match(cte, /round\(pc\.cost_dkk \* 100\) \/ array_length\(pc\.assignees, 1\)::numeric/i);
    assert.doesNotMatch(cte, /km_sum/i, "a crossing is a flat per-trip cost, never km-weighted");
    assert.doesNotMatch(cte, /repairs_split_mode|\bmode\b/i, "a crossing does not follow the workspace Afregning rule");
  });

  pin(`${name}: largest-remainder in integer øre, ties by member id ASCENDING`, () => {
    const cte = sql.slice(sql.indexOf("crossing_lr as ("), sql.indexOf("crossing_share as ("));
    assert.match(cte, /floor\(cl\.exact_cents\)/i);
    assert.match(cte, /order by cl\.exact_cents - floor\(cl\.exact_cents\) desc, cl\.member_id asc/i);
    assert.match(cte, /partition by cl\.trip_id/i);
  });

  pin(`${name}: the payer is coalesce(crossing_paid_by_member_id, driver_member_id)`, () => {
    assert.match(sql, /coalesce\(t\.crossing_paid_by_member_id, t\.driver_member_id\) as crossing_payer_member_id/i);
    assert.match(sql, /from period_crossings pc\s*\n\s*group by pc\.payer_member_id/i);
  });

  pin(`${name}: an INACTIVE crossing payer joins settlement_members credit-only (GV-274)`, () => {
    const cte = sql.slice(sql.indexOf("settlement_members as ("), sql.indexOf("per_member as ("));
    assert.match(cte, /or am\.id in \(select cp\.member_id from crossing_paid cp\)/i);
  });

  pin(`${name}: crossingPaid / crossingShare / totalCrossings reach the JSON`, () => {
    assert.match(sql, /'totalCrossings', t\.total_crossings,/);
    assert.match(sql, /'crossingPaid', pm\.crossing_paid,/);
    assert.match(sql, /'crossingShare', pm\.crossing_share,/);
  });

  pin(`${name}: net = fuelPaid + expensePaid + repairPaid + crossingPaid − tripCost − expenseShare − repairShare − crossingShare`, () => {
    assert.match(
      sql,
      /then round\(pm\.fuel_paid \+ pm\.expense_paid \+ pm\.repair_paid \+ pm\.crossing_paid - round\(pm\.km \* \(t\.total_paid \/ t\.total_km\), 2\) - pm\.expense_share - pm\.repair_share - pm\.crossing_share, 2\)/,
    );
    assert.match(
      sql,
      /else round\(pm\.fuel_paid \+ pm\.expense_paid \+ pm\.repair_paid \+ pm\.crossing_paid - pm\.expense_share - pm\.repair_share - pm\.crossing_share, 2\)/,
    );
  });

  pin(`${name}: the entry fingerprint emits trips as ["<id>",<øre>] pairs`, () => {
    const fp = sql.slice(sql.indexOf("create or replace function public.calculate_period_entry_fingerprint"));
    assert.match(fp, /'\{"trips":\['/);
    assert.match(fp, /round\(coalesce\(t\.crossing_cost_dkk, 0\) \* 100\)::bigint::text/i);
    assert.match(fp, /order by t\.id::text collate "C"/i);
  });

}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2b: the WRITE path's shape — migration 158 (GV-417)
// ═══════════════════════════════════════════════════════════════════════════════
process.stdout.write("\nSQL shape (migration 158 + its supabase-schema.sql mirror):\n");
for (const [name, sql] of Object.entries(writePathSources)) {
  pin(`${name}: each RPC drops its 157 signature before creating the wider one`, () => {
    // create-or-replace with a different parameter list makes a second overload, and
    // PostgREST cannot resolve between two candidates whose extra params all default
    // (the migration 156 lesson, which 157 learned and 158 has to learn again — the
    // signature it drops here is the one 157 created). Every one of the three must
    // DROP first, and restate its ACL, because DROP + CREATE resets the grants.
    for (const [fn, oldSig] of [
      [
        "upsert_trip_with_participants",
        "text, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text",
      ],
      [
        "upsert_booking_trip_with_participants",
        "text, uuid, uuid, text, uuid, date, numeric, numeric, text, uuid[], numeric, text, uuid, text, text",
      ],
      ["complete_booking_trip_with_fuel", null],
    ]) {
      const dropRe = oldSig
        ? new RegExp(`drop function if exists public\\.${fn}\\(${oldSig.replace(/[[\]]/g, "\\$&")}\\);`)
        : new RegExp(`drop function if exists public\\.complete_booking_trip_with_fuel\\(`);
      assert.match(sql, dropRe, `${fn} must drop the exact signature migration 157 created`);
      assert.match(
        sql,
        new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]{0,300}?\\) from anon;`),
        `${fn} must restate the anon revoke after DROP + CREATE (migration 148)`,
      );
      assert.match(
        sql,
        new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]{0,300}?\\) to authenticated;`),
        `${fn} must restate its authenticated grant after DROP + CREATE`,
      );
    }
  });

  const tripRpc = sql.slice(
    sql.indexOf("create or replace function public.upsert_trip_with_participants"),
    sql.indexOf("create or replace function public.upsert_booking_trip_with_participants"),
  );

  pin(`${name}: crossing_provided is the LAST parameter of all three RPCs`, () => {
    // Last, i.e. AFTER the trailing event params, so every positional caller — this
    // file's own fixtures, the functional suites, the RPCs calling each other — keeps
    // its argument order and simply omits the new one. A flag inserted anywhere else
    // silently re-points somebody's arguments.
    for (const [fn, lastExisting] of [
      ["upsert_trip_with_participants", "event_body text default null"],
      ["upsert_booking_trip_with_participants", "event_body text default null"],
      ["complete_booking_trip_with_fuel", "fuel_event_body text default null"],
    ]) {
      assert.match(
        sql,
        new RegExp(
          `create or replace function public\\.${fn}\\([\\s\\S]*?${lastExisting},\\s*\\n\\s*crossing_provided boolean default false\\s*\\n\\)`,
        ),
        `${fn} must take crossing_provided as its last parameter, after the event params`,
      );
    }
  });

  pin(`${name}: without the flag, the UPDATE path PRESERVES each crossing column`, () => {
    // The GV-417 defect itself: 157 wrote `crossing_cost_dkk = excluded.crossing_cost_dkk`
    // unconditionally, so a client whose build predates the crossing UI — every argument
    // defaulted to null — erased a crossing a newer device had logged, just by editing
    // the trip or retrying a queued write. In ON CONFLICT DO UPDATE the surviving row is
    // referenced by the TABLE name, so `else trips.x` is "keep what is there".
    for (const column of ["crossing_cost_dkk", "crossing_note", "crossing_paid_by_member_id"]) {
      assert.match(
        tripRpc,
        new RegExp(
          `${column} = case when crossing_provided then excluded\\.${column} else trips\\.${column} end,`,
        ),
        `${column} must be preserved, per column, when the caller sent no crossing`,
      );
      assert.doesNotMatch(
        tripRpc,
        new RegExp(`^\\s*${column} = excluded\\.${column},`, "m"),
        `${column} must never be written unconditionally from excluded — that is the GV-417 defect`,
      );
    }
  });

  pin(`${name}: with the flag, a null/zero cost still stores no orphaned note or payer`, () => {
    // Migration 157's semantics, unchanged, but now reachable only through the guard —
    // so the clearing behaviour must sit INSIDE `if crossing_provided then`, not beside
    // it. Read the guarded block by its own boundaries rather than the whole function.
    const guardStart = tripRpc.indexOf("if crossing_provided then");
    assert.notEqual(guardStart, -1, "the crossing normalisation must be guarded by crossing_provided");
    const guarded = tripRpc.slice(guardStart, tripRpc.indexOf("perform pg_advisory_xact_lock"));
    assert.match(guarded, /if crossing_cost_value is not null and crossing_cost_value < 0 then/);
    assert.match(
      guarded,
      /if crossing_cost_value is null or round\(crossing_cost_value, 2\) = 0 then\s*\n\s*resolved_crossing_cost := null;\s*\n\s*resolved_crossing_note := null;\s*\n\s*resolved_crossing_payer := null;/,
    );
    assert.match(guarded, /resolved_crossing_payer := coalesce\(crossing_paid_by, driver_member_id\);/);
    assert.match(guarded, /Crossing payer must be an active member of this workspace/);
  });

  pin(`${name}: the two booking RPCs FORWARD the flag rather than defaulting it away`, () => {
    const bookingRpc = sql.slice(
      sql.indexOf("create or replace function public.upsert_booking_trip_with_participants"),
      sql.indexOf("create or replace function public.complete_booking_trip_with_fuel"),
    );
    // Both completion paths route through the canonical trip upsert, so a booking
    // completion that dropped the flag on the floor would re-open the same hole for
    // exactly the calls (retry, re-completion) most likely to hit an existing trip.
    assert.match(
      bookingRpc,
      /public\.upsert_trip_with_participants\([\s\S]*?event_body,\s*\n\s*crossing_provided\s*\n\s*\);/,
      "upsert_booking_trip_with_participants must forward crossing_provided to the trip upsert",
    );
    const fuelRpc = sql.slice(sql.indexOf("create or replace function public.complete_booking_trip_with_fuel"));
    assert.match(
      fuelRpc,
      /public\.upsert_booking_trip_with_participants\([\s\S]*?trip_event_body,\s*\n\s*crossing_provided\s*\n\s*\);/,
      "complete_booking_trip_with_fuel must forward crossing_provided to the booking trip upsert",
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 3: the mobile mirror
// ═══════════════════════════════════════════════════════════════════════════════
// CROSSING_CONTRACT_MOBILE_ROOT repoints the sibling lookup at another checkout of
// govehlo-mobile. It exists so this file's own pins can be proved — pointed at a
// scratch copy carrying a deliberate mutation, a pin that does not fail is a pin that
// is not holding — without ever writing into the real sibling repo. Nothing in CI sets
// it; the default is the checkout next to fuel_sharing, exactly as before.
const MOBILE_ROOT = process.env.CROSSING_CONTRACT_MOBILE_ROOT || join(ROOT, "..", "govehlo-mobile");
const MOBILE = join(MOBILE_ROOT, "src", "lib");
const CALC = join(MOBILE, "settlement-calc.ts");
const SNAPSHOT = join(MOBILE, "period-snapshot.ts");

// ── Why every slice below is measured from a construct, never from an offset ─────
// The first version of this file read the crossing fold as `calc.slice(idx, idx + 4000)`
// where idx was the FIRST match of /crossing/i. That match is `crossingPaid` in the
// PersonLedger type near the top of the file, ~8.600 chars before the fold it meant to
// read; it only ever passed because the named crossingSplit helper happened to land
// inside the window with ~2.000 chars of headroom. Both failure directions were live,
// and GV-416 reproduced both against scratch copies of the real file:
//
//   • false RED — 5.000 chars of new prose, either prepended as a file header that
//     happens to say "crossing" (which re-anchors idx to the top) or added anywhere
//     between the type and the helper, push the helper past the window. The behaviour
//     never changed; the contract goes red anyway.
//   • false GREEN, the dangerous half — the window does not have to contain the LIVE
//     code, only text that satisfies the regexes. A doc comment restating the rule for
//     readers of the type satisfies them. So does the crossingSplit helper itself once
//     the fold has been changed to call splitByWeights inline with km weights, leaving
//     the correct helper sitting there, orphaned, being read by the pin. That mutation
//     — the exact drift this file exists to catch — passed the old pin.
//
// So: find the thing, then read from the thing.
//
// A brace-balanced read of the function whose header matches `header`, from the header
// to its closing brace, or null if there is no such function. Naive about braces inside
// string literals — fine for these two functions, neither of which contains one, and a
// contract test that mis-reads a body fails loudly rather than silently passing.
function functionSource(src, header) {
  const match = src.match(header);
  if (!match) return null;
  const open = src.indexOf("{", match.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && (depth -= 1) === 0) return src.slice(match.index, i + 1);
  }
  return null;
}

function checkMobileMirror() {
  if (!existsSync(CALC) || !existsSync(SNAPSHOT)) {
    warn(
      "Crossing mirror not checked",
      `govehlo-mobile not found at ${MOBILE} — settlement-calc.ts and period-snapshot.ts were NOT ` +
        `compared against the SQL. Check out the sibling repo next to fuel_sharing to run this half.`,
    );
    return;
  }

  const calc = readFileSync(CALC, "utf8");
  const snapshot = readFileSync(SNAPSHOT, "utf8");

  // The pre-twin state: no crossing support anywhere on the mobile side. Warn (this is
  // the platform PR shipping first) rather than fail, but make it loud, and make
  // --strict — i.e. the umbrella — treat it as the blocking paired-merge alarm it is.
  if (!/crossing/i.test(calc) && !/crossing/i.test(snapshot)) {
    warn(
      "Crossing mirror not landed",
      `govehlo-mobile's settlement-calc.ts and period-snapshot.ts carry NO crossing support yet, so the ` +
        `SQL half of GVM-415 is unmirrored. This is expected while the platform PR is open and BLOCKING ` +
        `once it merges: migration 157 also changes the entry fingerprint's trips component to ` +
        `["<id>",<øre>] pairs, so until periodEntryFingerprint mirrors it, every close from a shipped ` +
        `client is rejected with "Entries changed since this close was prepared".`,
    );
    return;
  }

  process.stdout.write("\nMobile mirror (govehlo-mobile settlement-calc.ts + period-snapshot.ts):\n");

  pin("settlement-calc.ts: PersonLedger carries crossingPaid and crossingShare", () => {
    assert.match(calc, /crossingPaid:\s*number/);
    assert.match(calc, /crossingShare:\s*number/);
    assert.match(calc, /blankLedger[\s\S]{0,400}?crossingPaid:\s*0[\s\S]{0,120}?crossingShare:\s*0/);
  });

  pin("settlement-calc.ts: the split uses splitByWeights with EQUAL weights over the trip's assignees", () => {
    // Followed as dataflow, in two hops, so that neither hop depends on where in the
    // file anything sits.
    //
    // Hop 1 — the fold. `.crossingShare +=` is executable: it cannot occur in the
    // PersonLedger type, in a comment about the rule, or anywhere else that merely
    // mentions a crossing, so it IS the fold and nothing else. Read back a short window
    // FROM it (200 chars, i.e. the fold's own statement and the line or two above,
    // whether it is written as a one-liner or an opened block) for the map being
    // iterated, and take its name — whatever that name happens to be.
    const foldIdx = calc.search(/\.crossingShare\s*\+=/);
    assert.notEqual(foldIdx, -1, "settlement-calc.ts folds nothing into crossingShare — the crossing never lands on anybody");
    const iterated = [...calc.slice(Math.max(0, foldIdx - 200), foldIdx).matchAll(/\bof\s+([\w.]+)\s*\)/g)];
    assert.notEqual(
      iterated.length,
      0,
      "crossingShare is not folded from an iterated share map — the split cannot be traced to a splitter",
    );
    const shares = iterated[iterated.length - 1][1];

    // Hop 2 — where that map is BUILT. A named helper (today: crossingSplit) or
    // splitByWeights called inline are both legitimate; either way the weights are read
    // from the construction the fold actually consumes, so a second, correct
    // splitByWeights call elsewhere in the file cannot stand in for this one.
    //
    // The LAST assignment above the fold, not the first in the file: `shares` is a
    // thoroughly reused local — the expense fold, the repair fold and splitByWeights'
    // own internals all bind it — and the one in scope at the fold is the nearest one
    // above it. Anchored on the fold again, so this stays position-independent.
    const assignments = [
      ...calc.slice(0, foldIdx).matchAll(new RegExp(`\\b${shares}\\b[^=\\n]*=\\s*([A-Za-z_$][\\w$]*)\\(`, "g")),
    ];
    assert.notEqual(
      assignments.length,
      0,
      `settlement-calc.ts never assigns ${shares} above the fold — the crossing shares come from nowhere`,
    );
    const built = assignments[assignments.length - 1];
    const builder = built[1];
    const weights =
      builder === "splitByWeights"
        ? calc.slice(built.index, calc.indexOf(";", built.index) + 1)
        : functionSource(calc, new RegExp(`function ${builder}\\s*\\(`));
    assert.ok(weights, `${builder}() builds the crossing shares but is not defined in settlement-calc.ts`);

    // The weights themselves: the assignee list at weight 1 each — not
    // people.get(id)!.km, and not memberIds (the workspace-wide universe the
    // expense/repair folds use). Required ADJACENT to the splitByWeights call, so an
    // equal-weight expression that is computed and then ignored does not satisfy it.
    assert.match(
      weights,
      /splitByWeights\(\s*[\w.]+\s*,\s*assignees\.map\(\s*(\w+)\s*=>\s*\[\s*\1\s*,\s*1\s*\]/,
      "crossing weights must be 1 per ASSIGNEE (equal split over the people on that trip), passed straight " +
        "into splitByWeights — the same largest-remainder helper the SQL mirrors",
    );
    assert.doesNotMatch(
      weights,
      /\bkm\b/i,
      "a crossing is a flat per-trip cost: nothing in the expression that weights it may read km",
    );
  });

  pin("settlement-calc.ts: the payer is the crossing payer falling back to the driver", () => {
    assert.match(
      calc,
      /crossing_paid_by_member_id\s*\?\?\s*[\w.]*\bdriver_member_id\b/,
      "the credited payer must be coalesce(crossing_paid_by_member_id, driver_member_id), matching the SQL",
    );
    assert.match(calc, /\.crossingPaid\s*\+=/);
    assert.match(calc, /\.crossingShare\s*\+=/);
  });

  pin("settlement-calc.ts: net extends symmetrically and totalCrossings is summarised", () => {
    assert.match(
      calc,
      /p\.net = round\(p\.fuelPaid \+ p\.expensePaid \+ p\.repairPaid \+ p\.crossingPaid - p\.tripCost - p\.expenseShare - p\.repairShare - p\.crossingShare\)/,
    );
    assert.match(calc, /totalCrossings/);
  });

  pin("period-snapshot.ts: the fingerprint's trips component is [id, øre] pairs", () => {
    // The function's own braces, not "from its name to the end of the file" — otherwise
    // a later function's arithmetic can satisfy pins meant for this one.
    const fn = functionSource(snapshot, /export function periodEntryFingerprint\s*\(/);
    assert.ok(fn, "period-snapshot.ts no longer exports periodEntryFingerprint");
    // Same shape the repair pairs already use: Math.round(kr * 100), sorted by id.
    assert.match(fn, /Math\.round\(\(Number\([\w.]+\) \|\| 0\) \* 100\)/);

    // Bound to the construction, not to a name. Asserting `tripPairs` appears somewhere
    // and that the øre arithmetic appears somewhere let a mutation through that KEPT the
    // name `tripPairs` while emitting bare ids: the øre assertion was satisfied by the
    // REPAIR pairs on the next line, and the name assertion by the hollowed-out variable.
    // So read the trip pairs as one expression — derived from `trips`, each entry an id
    // beside Math.round on that entry's crossingCost — capture whatever it is called,
    // and require the `trips` key to be that. Renaming it is then free; hollowing it out
    // is not, and neither is pointing `trips` at something else.
    const pairs = fn.match(
      /const\s+(\w+)[^=\n]*=\s*trips\b[\s\S]{0,40}?\.map\(\s*(\w+)\s*=>\s*\[\s*String\(\s*\2\s*\.id[\s\S]{0,60}?,\s*Math\.round\(\(\s*Number\(\s*\2\.crossingCost\s*\)\s*\|\|\s*0\s*\)\s*\*\s*100\)\s*\]/,
    );
    assert.ok(
      pairs,
      "the trips fingerprint component must be built from `trips` as [id, Math.round(crossingCost * 100)] " +
        "pairs — migration 157 emits [\"<id>\",<øre>], so a component that carries no crossing cost cannot " +
        "match the server no matter what the variable holding it is called",
    );
    assert.match(
      fn,
      new RegExp(`trips:\\s*${pairs[1]}\\b`),
      `the fingerprint's trips key must be the ${pairs[1]} pairs construction itself, not some other value`,
    );
    assert.doesNotMatch(
      fn,
      /trips:\s*norm\(tripIds\)/,
      "trips are no longer bare ids — migration 157 emits [\"<id>\",<øre>] pairs so a crossing-cost edit busts a prepared close",
    );
  });
}

checkMobileMirror();

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: the arithmetic, on a real Postgres
// ═══════════════════════════════════════════════════════════════════════════════
let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}

if (!dockerUp) {
  warn(
    "Crossing arithmetic not checked",
    "Docker is unavailable, so calculate_period_settlement was NOT executed. The 250,00 kr / 3 " +
      "øre-exact case and the payer/inactive-payer cases were skipped on this run.",
  );
} else {
  let finished = false;
  process.on("exit", () => {
    if (!finished) removeContainer(CONTAINER);
  });

  function fail(message) {
    process.stderr.write(`\n❌ crossing split contract: ${message}\n`);
    removeContainer(CONTAINER);
    process.exit(1);
  }

  function run(sql) {
    const res = psql(CONTAINER, DB, ["-t", "-A", "-c", sql]);
    if (res.status !== 0) fail(`psql failed:\n${res.stderr}\n--- SQL ---\n${sql}`);
    return res.stdout.trim();
  }

  try {
    startPostgres(CONTAINER, ROOT);
    createDbWithPrelude(CONTAINER, DB);
  } catch (error) {
    fail(error.message);
  }

  const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
  if (applied.status !== 0) fail(`Consolidated schema failed to apply:\n${applied.stderr}`);

  // ── Fixtures ─────────────────────────────────────────────────────────────────
  // Member ids ascend in text order m1 < m2 < m3 < m4, which is exactly the
  // largest-remainder tie-break, so "the extra øre lands on m1" is a statement the
  // fixture can prove rather than a coincidence of whatever uuids got generated.
  const M = (n) => `10000000-0000-0000-0000-00000000000${n}`;
  const seed = `
insert into public.ledgers (id, name, slug) values ('cross', 'Crossing test', 'cross');

insert into public.ledger_members (id, ledger_id, name, email, role, is_active) values
  ('${M(1)}', 'cross', 'Anna',  'anna@test.dk',  'admin',  true),
  ('${M(2)}', 'cross', 'Bo',    'bo@test.dk',    'member', true),
  ('${M(3)}', 'cross', 'Clara', 'clara@test.dk', 'member', true),
  ('${M(4)}', 'cross', 'David', 'david@test.dk', 'member', true),
  ('${M(5)}', 'cross', 'Emil',  'emil@test.dk',  'member', false);

insert into public.settlement_periods (id, ledger_id, status, label)
values ('20000000-0000-0000-0000-000000000001', 'cross', 'open', 'Open');
`;
  if (psql(CONTAINER, DB, ["-c", seed]).status !== 0) fail("Seeding members/period failed");

  const PERIOD = "20000000-0000-0000-0000-000000000001";
  const settlement = () =>
    JSON.parse(run(`select public.calculate_period_settlement('cross', '${PERIOD}')::text;`));
  const fingerprint = () =>
    run(`select public.calculate_period_entry_fingerprint('cross', '${PERIOD}');`);
  const person = (result, id) => result.people.find((p) => p.id === id);

  function resetTrips() {
    if (psql(CONTAINER, DB, ["-c", "delete from public.trip_participants; delete from public.trips;"]).status !== 0) {
      fail("Could not reset the trip fixtures");
    }
  }

  function addTrip({ id, driver, participants, startKm = 0, endKm = 100, cost = null, note = null, payer = null }) {
    const sql = `
insert into public.trips (id, ledger_id, period_id, driver_member_id, trip_date, start_km, end_km,
                          crossing_cost_dkk, crossing_note, crossing_paid_by_member_id)
values ('${id}', 'cross', '${PERIOD}', '${driver}', current_date, ${startKm}, ${endKm},
        ${cost === null ? "null" : cost}, ${note === null ? "null" : `'${note}'`},
        ${payer === null ? "null" : `'${payer}'`});
insert into public.trip_participants (trip_id, member_id)
select '${id}', unnest(array[${participants.map((p) => `'${p}'::uuid`).join(",")}]);
`;
    if (psql(CONTAINER, DB, ["-c", sql]).status !== 0) fail(`Could not insert trip ${id}`);
  }

  // Every psql -c is its own SESSION, so a `set_config(..., false)` in one call is gone
  // by the next. The JWT claims therefore have to travel WITH the statement that needs
  // them; anything else silently runs as the operator and the membership gate under test
  // never fires.
  const asAnna = (sql) =>
    psql(CONTAINER, DB, [
      "-c",
      `select set_config('request.jwt.claims', '{"email":"anna@test.dk","role":"authenticated"}', false);\n${sql}`,
    ]);

  process.stdout.write("\nCrossing arithmetic (real Postgres, consolidated schema):\n");

  // ── 1. The øre-exact equal split ──────────────────────────────────────────────
  // 250,00 kr over three people is the case the whole rule turns on: 25000 øre / 3 is
  // 8333,33…, so somebody must take the leftover øre and WHICH somebody is the
  // tie-break. Every plausible mistake lands somewhere else — per-member rounding gives
  // 83,33 × 3 = 249,99 (0,01 kr short, and the period stops netting to zero), km weights
  // give a lopsided split, splitting workspace-wide gives 62,50 × 4.
  //
  // The 800 km solo trip in front of it exists ONLY to make that second mistake visible
  // here. Without it all three riders carry identical km, so a km-weighted implementation
  // returns the very same 83,34 / 83,33 / 83,33 and this case certifies nothing about the
  // weights. With it, Anna carries 833,33 km to Bo's and Clara's 33,33, so km weights
  // would hand her ~236 kr of the ferry.
  resetTrips();
  addTrip({
    id: "30000000-0000-0000-0000-000000000000",
    driver: M(1),
    participants: [M(1)],
    startKm: 0,
    endKm: 800,
  });
  addTrip({
    id: "30000000-0000-0000-0000-000000000001",
    driver: M(1),
    participants: [M(1), M(2), M(3)],
    startKm: 800,
    endKm: 900,
    cost: 250.0,
    note: "Storebaeltsbroen",
  });

  pin("250,00 kr over 3 participants → 83,34 / 83,33 / 83,33, the extra øre to the LOWEST member id", () => {
    const s = settlement();
    assert.equal(person(s, M(1)).crossingShare, 83.34, "the lowest member id takes the leftover øre");
    assert.equal(person(s, M(2)).crossingShare, 83.33);
    assert.equal(person(s, M(3)).crossingShare, 83.33);
    const total = [M(1), M(2), M(3)].reduce((sum, id) => sum + person(s, id).crossingShare, 0);
    assert.equal(Math.round(total * 100) / 100, 250.0, "the shares must sum EXACTLY to the crossing cost");
  });

  pin("the driver is credited crossingPaid, and totalCrossings reports the sum", () => {
    const s = settlement();
    assert.equal(person(s, M(1)).crossingPaid, 250.0);
    assert.equal(person(s, M(2)).crossingPaid, 0);
    assert.equal(s.totalCrossings, 250.0);
  });

  pin("a workspace member who was NOT in the car owes nothing", () => {
    // The decisive difference from expenses and repairs, which David WOULD share.
    const s = settlement();
    assert.equal(person(s, M(4)).crossingShare, 0);
  });

  pin("every net sums to zero — the crossing moves money without creating any", () => {
    const s = settlement();
    const sum = s.people.reduce((acc, p) => acc + p.net, 0);
    assert.ok(Math.abs(sum) < 0.005, `nets must net out, got ${sum}`);
  });

  // ── 2. Not km-weighted ────────────────────────────────────────────────────────
  // Anna drives 900 km alone; the crossing trip is 100 km with Anna and Bo. If the
  // crossing were weighted by km — the way efter_koersel repairs are — Anna would carry
  // ~95% of it. It is a flat toll, so it is 50/50.
  resetTrips();
  addTrip({ id: "30000000-0000-0000-0000-000000000002", driver: M(1), participants: [M(1)], startKm: 0, endKm: 900 });
  addTrip({
    id: "30000000-0000-0000-0000-000000000003",
    driver: M(1),
    participants: [M(1), M(2)],
    startKm: 900,
    endKm: 1000,
    cost: 100.0,
  });

  pin("a crossing is NEVER km-weighted: 100,00 kr splits 50/50 despite a 9:1 km imbalance", () => {
    const s = settlement();
    assert.equal(person(s, M(1)).crossingShare, 50.0);
    assert.equal(person(s, M(2)).crossingShare, 50.0);
  });

  // ── 3. Payer ≠ driver ─────────────────────────────────────────────────────────
  resetTrips();
  addTrip({
    id: "30000000-0000-0000-0000-000000000004",
    driver: M(1),
    participants: [M(1), M(2)],
    cost: 100.0,
    payer: M(2),
  });

  pin("an explicit payer is credited instead of the driver, and still owes their own share", () => {
    const s = settlement();
    assert.equal(person(s, M(2)).crossingPaid, 100.0);
    assert.equal(person(s, M(1)).crossingPaid, 0);
    assert.equal(person(s, M(2)).crossingShare, 50.0);
    assert.equal(person(s, M(2)).net, 50.0, "Bo paid 100 and owes 50, so he is owed 50");
    assert.equal(person(s, M(1)).net, -50.0);
  });

  // ── 4. Inactive payer, credit-only (GV-274) ───────────────────────────────────
  // Emil has left the workspace but his card paid for the ferry. He must still be
  // credited — the alternative is that the money silently vanishes from the period —
  // and he must carry no share, because he is not in the split universe.
  resetTrips();
  addTrip({
    id: "30000000-0000-0000-0000-000000000005",
    driver: M(1),
    participants: [M(1), M(2)],
    cost: 100.0,
    payer: M(5),
  });

  pin("an INACTIVE crossing payer appears credit-only: crossingPaid = cost, crossingShare = 0, net = +cost", () => {
    const s = settlement();
    const emil = person(s, M(5));
    assert.ok(emil, "an inactive member who paid a crossing must still appear in the settlement");
    assert.equal(emil.crossingPaid, 100.0);
    assert.equal(emil.crossingShare, 0);
    assert.equal(emil.net, 100.0);
    assert.equal(person(s, M(1)).crossingShare, 50.0);
    assert.equal(person(s, M(2)).crossingShare, 50.0);
    const sum = s.people.reduce((acc, p) => acc + p.net, 0);
    assert.ok(Math.abs(sum) < 0.005, `nets must still net out with an inactive payer, got ${sum}`);
  });

  // ── 5. The entry fingerprint ──────────────────────────────────────────────────
  resetTrips();
  const TRIP_A = "30000000-0000-0000-0000-00000000000a";
  const TRIP_B = "30000000-0000-0000-0000-00000000000b";
  addTrip({ id: TRIP_A, driver: M(1), participants: [M(1)], cost: 250.0 });
  addTrip({ id: TRIP_B, driver: M(1), participants: [M(1)] });

  pin('trips are ["<id>",<øre>] pairs — a crossing-free trip carries 0, not a missing entry', () => {
    const parsed = JSON.parse(fingerprint());
    assert.deepEqual(parsed.trips, [
      [TRIP_A, 25000],
      [TRIP_B, 0],
    ]);
  });

  pin("editing ONLY a crossing cost busts the fingerprint (the amount guard cannot see it)", () => {
    const before = fingerprint();
    const beforeSettlement = settlement();
    if (
      psql(CONTAINER, DB, [
        "-c",
        `update public.trips set crossing_cost_dkk = 260.00 where id = '${TRIP_A}';`,
      ]).status !== 0
    ) {
      fail("Could not edit the crossing cost");
    }
    const after = fingerprint();
    const afterSettlement = settlement();
    assert.notEqual(before, after, "a crossing-cost edit MUST change the entry fingerprint");
    // ...and it is invisible to the close's amount guard, which is why the fingerprint
    // has to carry it: neither totalKm nor totalPaid moved.
    assert.equal(beforeSettlement.totalKm, afterSettlement.totalKm);
    assert.equal(beforeSettlement.totalPaid, afterSettlement.totalPaid);
  });

  // ── 6. The RPC write path ─────────────────────────────────────────────────────
  // Every call below is written the way its CLIENT writes it. A crossing-aware client
  // always ends its argument list with `true` (GV-417); an old build ends at the event
  // params and never mentions the flag at all. Those two shapes are the whole contract,
  // so the fixtures use them literally rather than passing a variable.
  const crossingRow = (legacyId) =>
    run(
      `select coalesce(crossing_cost_dkk::text,'-'), coalesce(crossing_note,'-'), coalesce(crossing_paid_by_member_id::text,'-')
       from public.trips where ledger_id = 'cross' and legacy_id = '${legacyId}';`,
    ).split("|");

  resetTrips();
  pin("upsert_trip_with_participants persists the crossing and defaults the payer to the driver", () => {
    const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-1', '${M(1)}', current_date, 0, 120, 'Aarhus',
           array['${M(1)}'::uuid, '${M(2)}'::uuid],
           250.00, '  Storebaeltsbroen - retur  ', null, 'Tur', '120 km', true);`);
    if (res.status !== 0) fail(`saving a trip with a crossing failed:\n${res.stderr}`);
    const row = crossingRow("legacy-1");
    assert.equal(row[0], "250.00");
    assert.equal(row[1], "Storebaeltsbroen - retur", "the note is trimmed, not stored raw");
    assert.equal(row[2], M(1), "a null payer defaults to the driver");
  });

  pin("GV-417: an OLD client editing the same trip PRESERVES the crossing it cannot see", () => {
    // The regression this migration exists for. The call is exactly what a build from
    // before the crossing UI emits — the argument list simply ends at the event params —
    // and it edits the trip (new note, new end km) the way such a build would. Before
    // migration 158 this wrote three nulls over a crossing another device had logged.
    const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-1', '${M(1)}', current_date, 0, 140, 'Aarhus og retur',
           array['${M(1)}'::uuid, '${M(2)}'::uuid],
           null, null, null, 'Tur', '140 km');`);
    if (res.status !== 0) fail(`an old client's trip edit failed:\n${res.stderr}`);
    const row = crossingRow("legacy-1");
    assert.deepEqual(
      row,
      ["250.00", "Storebaeltsbroen - retur", M(1)],
      "a caller that sent no crossing must leave all three crossing columns untouched",
    );
    // ...and the rest of the edit still landed, or "preserve" would just mean "ignore".
    assert.equal(Number(run(`select end_km from public.trips where legacy_id = 'legacy-1';`)), 140);
  });

  pin("GV-417: an OLD client CREATING a trip stores no crossing (nothing to preserve)", () => {
    const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-old-new', '${M(1)}', current_date, 0, 30, null,
           array['${M(1)}'::uuid], null, null, null, 'Tur', '30 km');`);
    if (res.status !== 0) fail(`an old client's new trip failed:\n${res.stderr}`);
    assert.deepEqual(crossingRow("legacy-old-new"), ["-", "-", "-"]);
  });

  pin("re-saving WITH crossing_provided and no crossing clears the cost, the note and the payer together", () => {
    const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-1', '${M(1)}', current_date, 0, 120, 'Aarhus',
           array['${M(1)}'::uuid, '${M(2)}'::uuid],
           null, null, null, 'Tur', '120 km', true);`);
    if (res.status !== 0) fail(`re-saving the trip without a crossing failed:\n${res.stderr}`);
    const row = run(
      `select coalesce(crossing_cost_dkk::text,'-'), coalesce(crossing_note,'-'), coalesce(crossing_paid_by_member_id::text,'-')
       from public.trips where ledger_id = 'cross' and legacy_id = 'legacy-1';`,
    ).split("|");
    assert.deepEqual(row, ["-", "-", "-"], "removing a crossing must leave no orphaned note or payer");
  });

  pin("a negative crossing cost is rejected, and a non-member payer cannot be credited", () => {
    for (const [args, why] of [
      [`-10, null, null`, "negative cost"],
      [`50, null, '10000000-0000-0000-0000-000000000005'::uuid`, "inactive payer"],
    ]) {
      const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-bad', '${M(1)}', current_date, 0, 10, null,
           array['${M(1)}'::uuid], ${args}, null, null, true);`);
      assert.notEqual(res.status, 0, `${why} must be rejected`);
    }
  });

  pin("GV-417: without the flag the crossing arguments are IGNORED, not validated", () => {
    // The deliberate corollary of skipping normalisation: with crossing_provided false
    // the three crossing arguments carry no information, so a cost that WOULD be
    // rejected is not rejected — it is simply not read, and nothing is stored. Pinned
    // because it is the one surprising edge of the contract: anything that means to
    // send a crossing must send the flag with it.
    const res = asAnna(`select public.upsert_trip_with_participants(
           'cross', '${PERIOD}', 'legacy-ignored', '${M(1)}', current_date, 0, 10, null,
           array['${M(1)}'::uuid], -10, 'ignored', null, null, null);`);
    assert.equal(res.status, 0, "a crossing argument sent without the flag must not raise");
    assert.deepEqual(
      crossingRow("legacy-ignored"),
      ["-", "-", "-"],
      "and it must not be stored either — the flag is what makes a crossing argument real",
    );
  });

  finished = true;
  removeContainer(CONTAINER);
}

// ═══════════════════════════════════════════════════════════════════════════════
process.stdout.write(
  `\nok - crossing split contract: ${checked} checks. A bro/færge crossing splits EQUALLY over the ` +
    `trip's own assignees, credits coalesce(payer, driver), and rides the same integer-øre ` +
    `largest-remainder chain as expenses and repairs.\n`,
);
if (warnings.length) {
  process.stdout.write(`⚠️  ${warnings.length} part(s) not checked on this run. CI runs this with --strict.\n`);
}

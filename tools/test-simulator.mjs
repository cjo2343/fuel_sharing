#!/usr/bin/env node
// Smoke test for the GV-471 workspace simulator.
//
//   npm run test:simulator            (needs Docker)
//   npm run test:simulator -- --strict
//
// This does NOT try to be the simulator. A fuzzer's value is in long unscripted runs,
// and pinning one to an assertion would turn it into a very slow contract test. What
// this pins is that the HARNESS still works, in both directions:
//
//   1. a short clean run finishes, produces a journal, and reports no NEW violation —
//      "new" meaning one that is not in run.mjs's reviewed KNOWN_FINDINGS list, so the
//      already-surfaced settlement gap does not make this red forever while a genuine
//      regression still would;
//   2. the same run with --chaos reports EXACTLY ONE NEW violation, and it is the
//      injected one. Without this half the first half is worthless: an oracle that never
//      fires passes every clean run there is. ("New" for the same reason as above — the
//      chaos run also re-surfaces the reviewed finding, and counting that would make the
//      self-test depend on whether a fixture happened to log fuel before a trip.)
//
// GV-478 Phase B adds three more again, about behavioural realism — see the halves at
// the bottom of this file. In short: a default run must actually EXERCISE the new
// behaviour (a feature that is enabled but never fires is a feature nobody is testing),
// the digest must survive it, and Phase A's shape must still be reachable by flag.
//
// GV-471 Phase A adds three more, all about the client-parity oracle:
//
//   3. it ran at all — and when govehlo-mobile is absent (which is every CI job here,
//      including the nightly fuzz) that the SKIP path works: muted cells, a stated
//      reason, and a run that still passes. Both directions are asserted, because a
//      parity check that silently reports green when it did nothing is worse than none;
//   4. enabling it does not move the action stream. Parity is oracle-side and draws no
//      PRNG, so the determinism digest must be byte-identical with --no-parity — the
//      property that keeps every repro command in this repo true;
//   5. --chaos-parity, the parity oracle's own --chaos: one row dropped from the CLIENT's
//      copy of the rows (never from the database) must produce exactly one new violation.
//
// DOCKER. The simulator hosts its own Postgres 17 container, so this cannot run without
// Docker. Like every other Docker-backed guard in tools/, it warns loudly and exits 0
// when Docker is absent (so a Docker-free CI job is not red for a reason its author
// cannot act on) and fails under --strict. It is deliberately NOT in
// tools/run-validations.mjs: `npm run validate` is dependency-free by contract.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestOf, readJournal } from "./simulator/lib/journal.mjs";
// Imported rather than re-derived so the test and the tool can never disagree about
// WHERE the sibling repo is — including under the SIMULATOR_MOBILE_ROOT override, which
// is how the skip path is proved without moving anything on disk.
import { MOBILE_ROOT } from "./simulator/lib/client-parity.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIOLATIONS = path.join(REPO, "tools", "simulator", "out", "violations.json");
const JOURNAL = path.join(REPO, "tools", "simulator", "out", "journal.jsonl");
const strict = process.argv.includes("--strict");

// Fixed configuration for every half: small enough to run in seconds, long enough to
// close periods, hand cars over and reach the entry lock.
//
// THE SEED IS CHOSEN, NOT ARBITRARY, and it has now been chosen twice. GV-478 moved it
// from 4711 to 101 for one reason: at 4711 neither workspace draws the Offline-pendleren,
// and a self-test that never exercises the offline queue would let that whole feature rot
// silently. GV-479 moved it again, from 101 to 1717, for the same KIND of reason and not
// out of taste: adding the fifth contention scenario (double_completion) changes the
// weighted draw inside buildScenario and therefore the ENTIRE downstream PRNG stream, and
// at 101 the new stream stopped flushing its offline burst and never drew the new scenario
// at all. 1717 was picked by replaying nineteen candidate seeds against every assertion
// below: it queues offline writes AND flushes them backdated, draws double_completion —
// whose contender is refused by migration 197's own guard, so the new rule is executed and
// not merely listed — and still produces duplicates, a fat finger refused by migration
// 195, a period close and thirteen guards inside 60 ticks, in both the default shape and
// Phase A's. That last clause is the one that eliminates most candidates: Phase A's shape
// asserts exactly one action line per tick, and an offline burst under THAT configuration
// adds a line per flushed statement. Re-run the same search whenever a change to the
// action pool, the persona pool or the scenario list moves the stream again — a seed is
// far cheaper to re-pick than an assertion is to weaken. THE EPOCH IS LOAD-BEARING TOO:
// the day/week rhythm keys off the simulated weekday, so an unpinned epoch would make this
// file's assertions depend on the day it ran.
const BASE = [
  "tools/simulator/run.mjs",
  "--workspaces", "2",
  "--members", "4",
  "--ticks", "60",
  "--seed", "1717",
  "--oracle-every", "20",
  "--epoch", "2026-06-01",
  "--headless",
];

/** Action lines of the journal the last run wrote. */
function actionsOf(records) {
  return records.filter((line) => line.kind === "action");
}

function dockerAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

if (!dockerAvailable()) {
  const message = "test-simulator: Docker is not available — the simulator hosts its own Postgres 17 container, so the run was NOT exercised.";
  if (strict) {
    console.error(`❌ ${message} (--strict)`);
    process.exit(1);
  }
  console.warn(`⚠ ${message}`);
  process.exit(0);
}

function runSimulator(extraArgs, label) {
  console.log(`⏳ ${label}: node ${[...BASE, ...extraArgs].join(" ")}`);
  const result = spawnSync("node", [...BASE, ...extraArgs], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${label}: could not start the simulator (${result.error.message})`);
  if (!existsSync(VIOLATIONS)) fail(`${label}: the run wrote no violations.json — it did not reach the end.\n${tail(result.stdout)}\n${tail(result.stderr)}`);
  return { ...result, report: JSON.parse(readFileSync(VIOLATIONS, "utf8")) };
}

function tail(text, lines = 25) {
  return String(text ?? "").split("\n").slice(-lines).join("\n");
}

function fail(message) {
  console.error(`\n❌ test-simulator: ${message}`);
  process.exit(1);
}

// ── 1. Clean run ─────────────────────────────────────────────────────────────
const clean = runSimulator([], "clean run");
if (clean.report.newViolationCount !== 0) {
  fail(
    `clean run reported ${clean.report.newViolationCount} NEW violation(s):\n` +
    `${JSON.stringify(clean.report.violations.filter((v) => !v.known), null, 2)}\n` +
    `repro: ${clean.report.repro}`,
  );
}
if (clean.status !== 0) fail(`clean run exited ${clean.status} with no new violations:\n${tail(clean.stdout)}\n${tail(clean.stderr)}`);

// ONE LINE PER TICK STOPPED BEING TRUE IN PHASE B, on purpose: a duplicate send is its
// own line, a contention scenario is three, an offline burst is one per flushed
// statement. What must still hold is that EVERY tick produced at least one line — that
// is what keeps a tick number in a violation report meaningful.
const cleanRecords = readJournal(JOURNAL);
const actionLines = actionsOf(cleanRecords);
const ticksSeen = new Set(actionLines.map((line) => line.tick));
if (ticksSeen.size !== 60) fail(`clean run journalled actions for ${ticksSeen.size} distinct ticks, expected all 60.`);
if (actionLines.length < 60) fail(`clean run journalled ${actionLines.length} action lines for 60 ticks.`);

const outcomes = actionLines.map((line) => line.outcome);
const guards = outcomes.filter((o) => o === "guard").length;
if (guards === 0) fail("clean run produced zero guard outcomes — the fuzz never reached an edge, so the run proves nothing.");
console.log(`✅ clean run: ${actionLines.length} actions over 60 ticks, ${outcomes.filter((o) => o === "ok").length} ok, ${guards} guard, 0 new violations` +
  `${clean.report.knownFindingCount > 0 ? ` (${clean.report.knownFindingCount} known finding[s])` : ""}.`);

// ── 1b. Client parity: it ran, or it skipped — never silently neither ────────
//
// Which branch is asserted is decided by the filesystem, not by a flag, because that is
// what decides it at run time too. `npm run test:simulator` is therefore meaningful on a
// dev machine WITH the sibling repo (parity really compared numbers) and in this repo's
// CI WITHOUT it (parity really skipped, and the run still passed).
const siblingPresent = existsSync(path.join(MOBILE_ROOT, "src", "lib", "settlement-calc.ts"));
const cleanJournal = cleanRecords;
const cleanDigest = digestOf(cleanJournal);
const parityLoad = cleanJournal.find((line) => line.kind === "parity" && line.phase === "load");
if (!parityLoad) fail("clean run journalled no `parity` load line — the parity oracle did not even report its own availability.");

const parityCells = cleanJournal
  .filter((line) => line.kind === "oracle")
  .flatMap((line) => line.results ?? [])
  .filter((result) => result.invariant === "client_parity");
if (parityCells.length === 0) fail("clean run swept no client_parity cell — the invariant is missing from the oracle.");

if (siblingPresent) {
  if (!parityLoad.available) {
    fail(`govehlo-mobile is at ${MOBILE_ROOT} but the parity oracle reported unavailable: ${parityLoad.reason}`);
  }
  const loadedModules = (parityLoad.modules ?? []).filter((m) => m.loaded);
  if (loadedModules.length === 0) fail("the parity oracle reported available but imported no mobile module.");
  const skipped = parityCells.filter((cell) => cell.skipped);
  if (skipped.length > 0) fail(`${skipped.length} client_parity cell(s) reported skipped with the sibling repo present.`);
  // A parity check over zero periods is vacuously green, which is the one way this
  // could pass while proving nothing. At least one sweep must have compared a period.
  const compared = parityCells.reduce((sum, cell) => sum + (cell.detail?.periods?.length ?? 0), 0);
  if (compared === 0) fail("client parity was available but compared zero periods — the check was vacuous.");
  const newParity = (clean.report.violations ?? []).filter((v) => !v.known && v.invariant === "client_parity");
  if (newParity.length > 0) {
    fail(`clean run found ${newParity.length} NEW client-parity violation(s):\n${JSON.stringify(newParity, null, 2)}`);
  }
  console.log(`✅ client parity: ran govehlo-mobile's own modules (${loadedModules.map((m) => m.file).join(", ")}) over ${compared} period-sweep(s), zero new divergences.`);
} else {
  if (parityLoad.available) fail(`govehlo-mobile is absent from ${MOBILE_ROOT} but the parity oracle reported available.`);
  const notSkipped = parityCells.filter((cell) => !cell.skipped);
  if (notSkipped.length > 0) fail(`${notSkipped.length} client_parity cell(s) were not marked skipped with the sibling repo absent — a skipped check must never read as green.`);
  if (parityCells.some((cell) => !cell.ok)) fail("a skipped client_parity cell reported a failure — the skip path must not fail a run.");
  console.log(`✅ client parity: correctly skipped (${parityLoad.reason}) — ${parityCells.length} muted cell(s), run still green.`);
}

// ── 1c. Determinism: parity must not move the action stream ──────────────────
//
// Parity is oracle-side and draws nothing from the PRNG, so the same seed must produce
// the byte-identical action journal with it on and with it off. This is the property
// every `repro:` line in this repo's violation reports depends on.
const noParity = runSimulator(["--no-parity"], "determinism run (--no-parity)");
if (noParity.status !== 0) fail(`determinism run exited ${noParity.status}:\n${tail(noParity.stdout)}\n${tail(noParity.stderr)}`);
const noParityDigest = digestOf(readJournal(JOURNAL));
if (noParityDigest !== cleanDigest) {
  fail(
    "the determinism digest changed when client parity was disabled — parity is consuming a decision:\n" +
    `  with parity: ${cleanDigest}\n  without:     ${noParityDigest}`,
  );
}
console.log(`✅ determinism: identical action digest with and without parity (${cleanDigest.slice(0, 16)}…).`);

// ── 1d. GV-478 Phase B: the behaviour actually happened ──────────────────────
//
// A flag that is on and never fires is a feature nobody is testing. These read the
// CLEAN run's journal — no extra container — and assert that each of the four
// behavioural features left its fingerprint on it. All four are pinned by the seed, so
// a failure here means the behaviour changed, not that the dice went the other way.

// (1) The day and week rhythm: every action line carries the simulated weekday and
//     clock, and a 60-tick run at this seed spans several days and more than one phase.
const withClock = actionLines.filter((line) => typeof line.simClock === "string" && /^(man|tir|ons|tor|fre|lør|søn) \d\d:\d\d$/.test(line.simClock));
if (withClock.length !== actionLines.length) {
  fail(`${actionLines.length - withClock.length} action line(s) carry no simulated weekday/clock — the rhythm is not being journalled.`);
}
const phases = new Set(actionLines.map((line) => line.simPhase).filter(Boolean));
if (phases.size < 2) fail(`the whole run happened in one phase of the day (${[...phases]}) — the rhythm is not moving the clock.`);
console.log(`✅ rhythm: every line stamped with a weekday and clock; ${phases.size} phases of the day visited (${[...phases].join(", ")}).`);

// (2) The offline persona: at least one write was decided while offline, and the burst
//     that followed carried it to the database backdated.
const queued = actionLines.filter((line) => line.offline === "queued");
const flushed = actionLines.filter((line) => line.offline === "flush");
if (queued.length === 0) fail("no action was queued offline — the Offline-pendleren never went out of range (has the persona pool or the seed changed?).");
if (flushed.length === 0) fail(`${queued.length} action(s) were queued offline but none was ever flushed — the burst never happened.`);
const backdated = flushed.filter((line) => Number(line.queuedTicks) > 0);
if (backdated.length === 0) fail("the offline burst flushed statements that had waited zero ticks — nothing arrived late, which is the entire point.");
console.log(`✅ offline persona: ${queued.length} statement(s) queued, ${flushed.length} flushed in a burst, longest wait ${Math.max(...flushed.map((l) => Number(l.queuedTicks) || 0))} ticks.`);

// (3) Duplicate sends: at least one pair, and every duplicate carries its expectation.
const duplicates = actionLines.filter((line) => line.dup === true);
if (duplicates.length === 0) fail("the clean run sent no duplicate at all — either the draw or the catalogue stopped working.");
const unlabelled = duplicates.filter((line) => !line.dupExpect);
if (unlabelled.length > 0) fail(`${unlabelled.length} duplicate line(s) carry no dupExpect — the duplicate was sent without an expectation to judge it against.`);
for (const line of duplicates) {
  // The whole point of the idempotent half: the schema said no second row, so there
  // must be no second row. A violation would already have failed the run above; this
  // catches the case where the delta was recorded but not acted on.
  if (line.dupExpect === "idempotent" && Number(line.dupRowDelta) > 0) {
    fail(`a duplicate of ${line.action} created ${line.dupRowDelta} row(s) but was not reported as a duplicate_hazard.`);
  }
}
console.log(`✅ duplicates: ${duplicates.length} re-sent action(s) (${duplicates.map((l) => `${l.action}:${l.dupExpect}`).join(", ")}), no unguarded second row.`);

// (4) Contention: at least one lockstep scenario ran to completion on two sessions, and
//     the contender met the lock rather than sailing through it.
const scenarioLines = actionLines.filter((line) => line.scenario);
if (scenarioLines.length === 0) fail("the clean run ran no contention scenario — interleaving is on but never fired.");
const contenders = scenarioLines.filter((line) => line.step === "contender");
if (contenders.length === 0) fail("contention scenarios ran but journalled no contender step.");
if (!scenarioLines.some((line) => line.session > 0)) {
  fail("every contention line came from session 0 — the holder never used a second session, so nothing was actually contended.");
}
const contended = contenders.filter((line) => line.outcome === "contention").length;
if (contended === 0) {
  fail(`${contenders.length} contender step(s) ran and none hit the lock (outcomes: ${contenders.map((l) => l.outcome).join(", ")}) — either the holder failed every time or lock_timeout is not being applied.`);
}
// The fifth scenario, pinned by name (GV-479). Two members completing the same booking is
// the collision the Phase B README listed as deliberately uncovered until migration 197
// decided what should happen; a scenario that is in the list but never drawn on the one
// seed this file runs would leave that decision untested while looking covered.
const doubleCompletion = scenarioLines.filter((line) => line.scenario === "double_completion");
if (doubleCompletion.length === 0) {
  fail(
    `no double_completion scenario ran (drawn: ${[...new Set(scenarioLines.map((l) => l.scenario))].join(", ") || "none"}) — ` +
    "migration 197's guard is unexercised on this seed. Re-pick the seed (see the note on BASE), do not delete this check.",
  );
}
const doubleContenders = doubleCompletion.filter((line) => line.step === "contender");
// Both are expected outcomes and the run visits whichever the state of the booking makes
// true: `contention` when the booking had no trip yet and the contender queued on the
// car_bookings row, `guard` when it was already completed and GV-479 refused both sessions.
// `ok` would already have been recorded as an interleave_hazard above.
if (doubleContenders.some((line) => !["contention", "guard"].includes(line.outcome))) {
  fail(`a double_completion contender ended ${doubleContenders.map((l) => l.outcome).join(", ")} — expected contention or guard.`);
}
console.log(`✅ contention: ${scenarioLines.length / 3} scenario(s) over ${new Set(scenarioLines.map((l) => l.session)).size} sessions, ${contended} contender(s) serialised by the lock` +
  ` (double_completion ran ${doubleCompletion.length / 3}×: ${doubleContenders.map((l) => l.outcome).join(", ")}).`);

// (5) The fat finger, since migration 195 (GV-475) put a plausibility guard on
//     upsert_booking_handover: the ten-times odometer is in the DEFAULT mix now, and it
//     may never be accepted. A success poisons ledgers.max_handover_odometer forever and
//     no invariant can see it, which is why the assertion lives here.
const fatFinger = actionLines.filter((line) => line.action === "save_handover_fat_finger");
const accepted = fatFinger.filter((line) => line.outcome === "ok");
if (accepted.length > 0) {
  fail(`${accepted.length} ten-times-odometer handover(s) were ACCEPTED — migration 195's plausibility guard is not holding.`);
}
if (fatFinger.length > 0) {
  const plausibility = fatFinger.filter((line) => line.guardKind === "odometer_plausibility").length;
  if (plausibility === 0) {
    fail(`${fatFinger.length} fat-finger handover(s) were refused, but never by the plausibility guard (${fatFinger.map((l) => l.guardKind).join(", ")}) — the run is not reaching migration 195's check.`);
  }
  console.log(`✅ fat finger: ${fatFinger.length} ten-times odometer(s) attempted, ${plausibility} refused by migration 195's plausibility guard, 0 accepted.`);
}

// ── 1e. Determinism with everything on ───────────────────────────────────────
//
// The --no-parity run above proves parity draws no PRNG. This proves the stronger and
// more obvious thing GV-478 needed: the SAME command, twice, with duplicates,
// interleaving over two sessions and the offline queue all live, produces the identical
// digest. Two sessions are the risk — an OS-scheduled race would land here as a flake —
// so this half is what says the lockstep really is lockstep.
const repeat = runSimulator([], "determinism run (identical flags, second time)");
if (repeat.status !== 0) fail(`repeat run exited ${repeat.status}:\n${tail(repeat.stdout)}\n${tail(repeat.stderr)}`);
const repeatDigest = digestOf(readJournal(JOURNAL));
if (repeatDigest !== cleanDigest) {
  fail(
    "the same command produced two different action digests with interleaving and duplicates on:\n" +
    `  first:  ${cleanDigest}\n  second: ${repeatDigest}\n` +
    "Something in the contention or duplicate path is reading the wall clock or the OS scheduler.",
  );
}
console.log(`✅ determinism: the identical command twice, two sessions and all, same digest (${repeatDigest.slice(0, 16)}…).`);

// ── 1f. Phase A's shape is still reachable ───────────────────────────────────
//
// The four features are defaults, not obligations. `--flat-clock --no-dup
// --no-interleave --sessions 1` must still run clean — it is what an A/B against the
// rhythm uses, and it is the configuration a bisect falls back to when a Phase B
// feature is the suspect.
const phaseAShape = runSimulator(
  ["--flat-clock", "--no-dup", "--no-interleave", "--sessions", "1"],
  "Phase A shape (--flat-clock --no-dup --no-interleave --sessions 1)",
);
if (phaseAShape.status !== 0) fail(`Phase A shape exited ${phaseAShape.status}:\n${tail(phaseAShape.stdout)}\n${tail(phaseAShape.stderr)}`);
if (phaseAShape.report.newViolationCount !== 0) {
  fail(`Phase A shape reported ${phaseAShape.report.newViolationCount} NEW violation(s):\n${JSON.stringify(phaseAShape.report.violations.filter((v) => !v.known), null, 2)}`);
}
const flatLines = actionsOf(readJournal(JOURNAL));
if (flatLines.length !== 60) fail(`Phase A shape journalled ${flatLines.length} action lines, expected exactly one per tick (60).`);
if (flatLines.some((line) => line.dup)) fail("--no-dup still sent a duplicate.");
if (flatLines.some((line) => line.scenario)) fail("--no-interleave still ran a contention scenario.");
if (flatLines.some((line) => (line.session ?? 0) !== 0)) fail("--sessions 1 still used a second session.");
if (flatLines.some((line) => line.simPhase !== null)) fail("--flat-clock still applied the rhythm's time-of-day weighting.");
if (flatLines.filter((line) => line.outcome === "guard").length === 0) fail("Phase A shape produced zero guards.");
console.log(`✅ Phase A shape: 60 actions, one per tick, no duplicates, no scenarios, one session, flat clock, still green.`);

// ── 1g. GV-480 Phase C: the dashboard's phone data, and its cost ─────────────
//
// The mission-control phone panels are fed by a `state` journal line the oracle sweep
// writes (run.mjs's workspaceViews()). Nothing in the harness reads it back, so if it
// ever stopped carrying per-member nets the only symptom would be a dashboard quietly
// showing "–" for every member — the shipped-feature-goes-dark failure this repo keeps
// hitting. Both halves below are read off the CLEAN run's journal, already in memory.
//
// The second half is the one that matters most: REMOVING every `state` line must not
// change the determinism digest. That is the whole Phase C contract in one assertion —
// the line is display-only, and no repro command in any violation report moved because
// of it.
const stateLines = cleanRecords.filter((line) => line.kind === "state");
if (stateLines.length === 0) {
  fail("the clean run journalled no `state` line — mission control's phone panels have nothing to replay from.");
}
const lastState = stateLines[stateLines.length - 1];
if ((lastState.workspaces ?? []).length !== 2) {
  fail(`the last \`state\` line covers ${(lastState.workspaces ?? []).length} workspace(s), expected 2.`);
}
const phoneMembers = (lastState.workspaces ?? []).flatMap((ws) => ws.members ?? []);
if (phoneMembers.length !== 8) fail(`the last \`state\` line carries ${phoneMembers.length} member(s), expected 2 × 4.`);
if (!phoneMembers.some((m) => m.admin)) fail("no member in the `state` line is marked admin — the phone panels cannot mark one.");
if (phoneMembers.some((m) => !m.personaLabel)) fail("a member in the `state` line carries no persona label.");
// A settled workspace legitimately nets everyone to zero, so the assertion is that the
// nets were MEASURED (a number, not null), not that somebody owes something.
const measured = phoneMembers.filter((m) => typeof m.net === "number");
if (measured.length === 0) {
  fail("no member in the last `state` line has a measured net — the phones would show a dash for everybody.");
}
const digestWithoutState = digestOf(cleanRecords.filter((line) => line.kind !== "state"));
if (digestWithoutState !== cleanDigest) {
  fail(
    "removing the `state` lines changed the determinism digest — the Phase C display snapshot is NOT display-only:\n" +
    `  with them:    ${cleanDigest}\n  without them: ${digestWithoutState}`,
  );
}
console.log(`✅ phone data: ${stateLines.length} \`state\` line(s), ${measured.length}/${phoneMembers.length} members with a measured net, and the digest is identical without them.`);

// ── 2. Chaos run: the oracle's self-test ─────────────────────────────────────
const chaos = runSimulator(["--chaos"], "chaos run");
const chaosViolations = (chaos.report.violations ?? []).filter((v) => !v.known);
if (chaosViolations.length !== 1) {
  fail(`chaos run reported ${chaosViolations.length} NEW violation(s), expected exactly 1:\n${JSON.stringify(chaosViolations, null, 2)}`);
}
if (chaosViolations[0].invariant !== "handover_mirror") {
  fail(`chaos run flagged ${chaosViolations[0].invariant}, expected handover_mirror (the injected corruption).`);
}
if (chaos.status === 0) fail("chaos run exited 0 — a --headless run with a violation must exit non-zero.");
console.log(`✅ chaos run: exactly 1 new violation (${chaosViolations[0].invariant}, workspace ${chaosViolations[0].ws}), exit ${chaos.status}` +
  `${chaos.report.knownFindingCount > 0 ? `, plus ${chaos.report.knownFindingCount} known finding[s]` : ""}.`);

// ── 3. Chaos-parity run: the PARITY oracle's self-test ───────────────────────
//
// Same argument as --chaos, one level up. --chaos corrupts a column, which proves the
// database-side invariants fire; it says nothing about the comparison between the client
// and the server, because both engines would read the corrupted column and agree. So
// this perturbs the CLIENT's copy of the rows instead — drops one live row before the
// mobile modules see it — and the parity oracle must notice exactly that.
//
// Only meaningful with the sibling repo present. Absent, there is no parity oracle to
// self-test, and asserting anything would be asserting the skip path twice.
if (siblingPresent) {
  const chaosParity = runSimulator(["--chaos-parity"], "chaos-parity run");
  const found = (chaosParity.report.violations ?? []).filter((v) => !v.known);
  if (found.length !== 1) {
    fail(`chaos-parity run reported ${found.length} NEW violation(s), expected exactly 1:\n${JSON.stringify(found, null, 2)}`);
  }
  if (found[0].invariant !== "client_parity") {
    fail(`chaos-parity run flagged ${found[0].invariant}, expected client_parity (the perturbed client input).`);
  }
  if (!found[0].detail?.perturbed) {
    fail("chaos-parity run flagged client_parity but recorded no perturbation — it caught something else, which is a genuine finding, not a passing self-test.");
  }
  if (chaosParity.status === 0) fail("chaos-parity run exited 0 — a --headless run with a violation must exit non-zero.");
  const dropped = found[0].detail.perturbed;
  console.log(`✅ chaos-parity run: exactly 1 new violation (client_parity, workspace ${found[0].ws}) after dropping one ${dropped.label} from the client's rows; first divergence ${JSON.stringify(found[0].detail.first)}.`);
} else {
  console.log("ℹ  chaos-parity: skipped — govehlo-mobile is absent, so there is no parity oracle to self-test.");
}

console.log("\n✅ test-simulator: the harness detects nothing when nothing is wrong, the injected corruption when something is, and it does both while a rhythm, an offline queue, duplicate sends and two contending sessions are live.");

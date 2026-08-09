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

// Fixed configuration for both halves: small enough to run in seconds, long enough to
// close periods, hand cars over and reach the entry lock.
const BASE = [
  "tools/simulator/run.mjs",
  "--workspaces", "2",
  "--members", "4",
  "--ticks", "60",
  "--seed", "4711",
  "--oracle-every", "20",
  "--epoch", "2026-06-01",
  "--headless",
];

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

const journalLines = readFileSync(JOURNAL, "utf8").split("\n").filter((l) => l.trim() !== "");
const actionLines = journalLines.filter((l) => JSON.parse(l).kind === "action");
if (actionLines.length !== 60) fail(`clean run journalled ${actionLines.length} actions, expected one per tick (60).`);

const outcomes = actionLines.map((l) => JSON.parse(l).outcome);
const guards = outcomes.filter((o) => o === "guard").length;
if (guards === 0) fail("clean run produced zero guard outcomes — the fuzz never reached an edge, so the run proves nothing.");
console.log(`✅ clean run: 60 actions, ${outcomes.filter((o) => o === "ok").length} ok, ${guards} guard, 0 new violations` +
  `${clean.report.knownFindingCount > 0 ? ` (${clean.report.knownFindingCount} known finding[s])` : ""}.`);

// ── 1b. Client parity: it ran, or it skipped — never silently neither ────────
//
// Which branch is asserted is decided by the filesystem, not by a flag, because that is
// what decides it at run time too. `npm run test:simulator` is therefore meaningful on a
// dev machine WITH the sibling repo (parity really compared numbers) and in this repo's
// CI WITHOUT it (parity really skipped, and the run still passed).
const siblingPresent = existsSync(path.join(MOBILE_ROOT, "src", "lib", "settlement-calc.ts"));
const cleanJournal = readJournal(JOURNAL);
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

console.log("\n✅ test-simulator: the harness detects nothing when nothing is wrong, and the injected corruption when something is.");

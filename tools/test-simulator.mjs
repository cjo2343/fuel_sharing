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
// DOCKER. The simulator hosts its own Postgres 17 container, so this cannot run without
// Docker. Like every other Docker-backed guard in tools/, it warns loudly and exits 0
// when Docker is absent (so a Docker-free CI job is not red for a reason its author
// cannot act on) and fails under --strict. It is deliberately NOT in
// tools/run-validations.mjs: `npm run validate` is dependency-free by contract.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("\n✅ test-simulator: the harness detects nothing when nothing is wrong, and the injected corruption when something is.");

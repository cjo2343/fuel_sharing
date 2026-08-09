// GV-471 / GV-478 — the VehloShare workspace simulator.
//
//   node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 42
//                                [--serve [port]] [--headless] [--oracle-every 25]
//                                [--chaos] [--chaos-parity] [--no-parity] [--keep]
//                                [--sessions 2] [--flat-clock] [--no-dup]
//                                [--no-interleave] [--no-offline]
//
//   node tools/simulator/run.mjs --help
//
// WHAT THIS IS FOR. Every other guard in tools/ asserts a SCRIPTED sequence: this RPC,
// then that one, then this assertion. They are excellent at the bug you already thought
// of. They are structurally unable to find the other kind — an edit that lands against
// a period somebody else just closed, a booking whose end time moves after its handover
// was written, a delete that arrives after a settlement was requested, four members
// interleaving across four workspaces for four hundred moves. This runs those sequences
// nobody wrote down, against the real RPC surface, and watches seven invariants while it
// does.
//
// DETERMINISM IS THE PRODUCT. A fuzzer that cannot hand back a reproduction is a
// rumour generator. Every decision comes from the seeded PRNG in lib/prng.mjs and a
// simulated clock; a violation prints the exact command that reproduces it.
//
// SAFETY / GDPR. There is no env file, no connection string and no URL anywhere in this
// tool — the only database it can address is a disposable Postgres container it starts
// itself, torn down on exit. Every name, email and place is synthetic Danish fixture
// text on the .invalid TLD, which by RFC 6761 can never resolve. Nothing here can reach
// production, and no production data can reach it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  startPostgres,
  createDbWithPrelude,
  removeContainer,
  psql,
} from "../lib/replay-container.mjs";
import { LOCAL_PRELUDE } from "../load-rehearsal/lib/pg-local.mjs";
import { buildCloseSnapshot, computeSettlementsFromNets } from "../load-rehearsal/lib/fixtures.mjs";

import { Prng, SimClock, defaultEpoch } from "./lib/prng.mjs";
import { PERSONAS, assignPersonas, JOINER_PERSONAS, JOINER_PERSONAS_WITH_OFFLINE } from "./lib/personas.mjs";
import { ACTIONS, classifyRejection, isLockTimeout, duplicateExpectation } from "./lib/actions.mjs";
import { runOracle, INVARIANTS } from "./lib/oracle.mjs";
import { Journal, digestOf } from "./lib/journal.mjs";
import { startServer } from "./lib/server.mjs";
import { SessionPool, SIM_SCRATCH_DDL, actionSql, claimsFor, lit, uuidLit } from "./lib/db.mjs";
import { loadClientModules, MOBILE_ROOT } from "./lib/client-parity.mjs";
import {
  RhythmClock, rhythmEpoch, rhythmBudgetMinutes, modulateWeights, firedRules, clockLabel,
} from "./lib/rhythm.mjs";
import { buildScenario, runScenario, LOCK_TIMEOUT_MS } from "./lib/interleave.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(REPO, "tools", "simulator", "out");
const DB = "simulator";

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.flags.add(key);
    } else {
      out.values[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const num = (key, fallback) => (args.values[key] !== undefined ? Number(args.values[key]) : fallback);
const has = (key) => args.flags.has(key) || args.values[key] !== undefined;

if (args.flags.has("help") || args.values.help !== undefined) {
  printHelp();
  process.exit(0);
}

const config = {
  workspaces: num("workspaces", 3),
  members: num("members", 4),
  ticks: num("ticks", 200),
  seed: num("seed", 42),
  oracleEvery: num("oracle-every", 25),
  chaos: has("chaos"),
  // Phase A. On by default — a parity check nobody runs is a comment. `--no-parity`
  // turns it off, which is how the determinism proof compares the two action streams.
  parity: !has("no-parity"),
  chaosParity: has("chaos-parity"),
  // ── GV-478 Phase B, all four ON by default ───────────────────────────────────
  // Each has an off switch, and the four of them together restore Phase A's shape for
  // an A/B comparison. They do NOT restore Phase A's digests: migration 195's odometer
  // plausibility guard also moved save_handover_fat_finger into the default persona
  // mixes, and a weight is a weight.
  rhythm: !has("flat-clock"),
  dup: !has("no-dup"),
  interleave: !has("no-interleave"),
  offline: !has("no-offline"),
  sessions: Math.max(1, num("sessions", 2)),
  headless: has("headless"),
  keep: has("keep"),
  serve: has("serve") && !has("headless"),
  port: num("serve", 8471),
};
if (Number.isNaN(config.port)) config.port = 8471;
// One session cannot contend with itself, and pretending otherwise would report a
// feature as active while it silently did nothing.
if (config.sessions < 2 && config.interleave) {
  config.interleave = false;
  console.warn("⚠  --sessions 1: contention scenarios need a second session, so interleaving is off for this run.");
}

const EPOCH = args.values.epoch
  ? new Date(`${args.values.epoch}T00:00:00Z`)
  : (config.rhythm ? rhythmEpoch(config.ticks) : defaultEpoch(config.ticks));
const CONTAINER = `govehlo-sim-${process.pid}`;

// How often an ordinary action is sent TWICE (feature 3) and how often a tick becomes a
// lockstep contention scenario instead of an action (feature 4). Both are drawn from the
// workspace's own PRNG stream, so both are part of the digest and of the repro.
const DUP_CHANCE = 1 / 12;
const INTERLEAVE_CHANCE = 0.08;

// The one-line reproduction, printed with every violation and stored in violations.json.
//
// --epoch was always here; since GV-478 it is LOAD-BEARING rather than cosmetic. The
// rhythm keys off the simulated weekday and hour, so the action stream now depends on
// where the epoch falls in the week. A repro without it is not a repro.
const REPRO = [
  "node tools/simulator/run.mjs",
  `--workspaces ${config.workspaces}`,
  `--members ${config.members}`,
  `--ticks ${config.ticks}`,
  `--seed ${config.seed}`,
  `--oracle-every ${config.oracleEvery}`,
  `--epoch ${EPOCH.toISOString().slice(0, 10)}`,
  `--sessions ${config.sessions}`,
  config.chaos ? "--chaos" : "",
  config.chaosParity ? "--chaos-parity" : "",
  config.parity ? "" : "--no-parity",
  config.rhythm ? "" : "--flat-clock",
  config.dup ? "" : "--no-dup",
  config.interleave ? "" : "--no-interleave",
  config.offline ? "" : "--no-offline",
  "--headless",
].filter(Boolean).join(" ");

function printHelp() {
  console.log(`
The VehloShare workspace simulator (GV-471 · GV-478)

  node tools/simulator/run.mjs [options]

Shape of the run
  --workspaces N       how many workspaces to seed            (default 3)
  --members N          members per workspace                  (default 4)
  --ticks N            actions to attempt                     (default 200)
  --seed N             the seed everything is drawn from      (default 42)
  --oracle-every N     invariant sweep interval, 0 = never    (default 25)
  --epoch YYYY-MM-DD   first tick's simulated date. Defaults to far enough in the
                       past that the run finishes before the real present. PIN IT in
                       any repro: the day/week rhythm keys off the simulated weekday.

Behavioural realism (GV-478 Phase B — all four ON by default)
  --flat-clock         restore Phase A's uniform 1-6 h tick and drop the time-of-day
                       weighting, for an A/B against the rhythm
  --no-dup             stop re-sending ~1 action in 12 as a duplicate
  --no-interleave      stop running lockstep contention scenarios
  --no-offline         drop the sixth persona (Offline-pendleren) from the pool
  --sessions N         psql sessions held against the container (default 2). 1 turns
                       interleaving off, since one session cannot contend with itself.

Self-tests and output
  --chaos              inject one known corruption; the oracle must flag exactly it
  --chaos-parity       drop one row from the CLIENT's copy; parity must flag exactly it
  --no-parity          skip the client-parity oracle entirely
  --serve [port]       live mission control on 127.0.0.1 (default 8471)
  --headless           no dashboard, and exit non-zero on a NEW violation
  --keep               leave the Postgres container running for inspection
  --help               this text

Safety: the only database this tool can address is a disposable container it starts
itself. There is no env file, no connection string and no URL anywhere in it.
`);
}

// ── Reviewed findings (the repo's GVM-437 pattern, applied to a fuzzer) ──────
//
// A finding this tool has ALREADY surfaced, that a person has read, and that is not
// this PR's job to fix. It is still detected, still printed loudly, still written to
// violations.json — it just does not fail the run, so `npm run test:simulator` keeps
// meaning "the harness works and nothing NEW appeared".
//
// Each entry needs a narrow `match`. A broad one (any zero_sum failure) would quietly
// swallow the next real settlement bug, which is the whole reason the invariant exists.
//
// GV-471-F1 — fuel paid in a period with zero kilometres credited to nobody's debit —
// lived here from the tool's first run until migration 194 (GV-472) fixed it, and its
// entry was deleted with the fix rather than left behind as a silencer. The pattern
// stays: when this fuzzer surfaces something a person has read and that is not the
// current PR's job, it goes here with a narrow match and comes out again when it is
// fixed. The historical repro for F1 is kept in README.md, not here.
//
// GV-471-F2 below is Phase A's first finding, surfaced by the client-parity oracle on
// its first long run. It is a CLIENT-vs-SERVER disagreement, not a corruption: the
// database is self-consistent and the period still nets to zero, but a member's phone
// and the server's own settlement figure can print amounts one øre apart. It is not
// this PR's job to fix (the fix is a migration, and this PR ships no SQL), the close's
// 0,02 kr per-member gate already absorbs it so no close can be blocked by it, and the
// README records the mechanism and the repro. See there before widening this match.
const KNOWN_FINDINGS = [
  {
    id: "GV-471-F2",
    title:
      "tripCost lands one øre apart when km × totalPaid / totalKm is an exact half-øre: " +
      "Postgres divides FIRST into a 16-digit numeric (product falls just below the tie, rounds down) " +
      "while the client divides first in a double (product falls just above, rounds up).",
    // NARROW on purpose, in three independent ways: only the client_parity invariant,
    // only the two fields the fuel rate feeds, and only a difference of ONE øre. The
    // length check matters as much as the rest — `mismatches` is truncated at 40, so
    // without it a hundred-mismatch divergence whose first forty happened to be one-øre
    // tripCosts would be laundered into this entry.
    match: (violation) =>
      violation.kind === "invariant" &&
      violation.invariant === "client_parity" &&
      Array.isArray(violation.detail?.mismatches) &&
      violation.detail.mismatches.length > 0 &&
      violation.detail.mismatches.length === violation.detail.mismatchCount &&
      violation.detail.mismatches.every(
        (m) =>
          (m.field === "person.tripCost" || m.field === "person.net") &&
          Math.abs(Number(m.client) - Number(m.server)) <= 0.010000001,
      ),
  },
];

// ── Fixture vocabulary (synthetic, Danish) ───────────────────────────────────
const FIRST_NAMES = [
  "Frederik", "Emma", "Lars", "Sofie", "Mikkel", "Ida", "Jonas", "Freja",
  "Anders", "Clara", "Rasmus", "Astrid",
];
const WORKSPACE_NAMES = [
  "Delebilen paa Noerrebro", "Familiebilen", "Kollegiebilen", "Sommerhusbilen",
  "Nabobilen", "Foreningsbilen", "Studiebilen", "Landsbybilen",
];

const journal = new Journal(path.join(OUT_DIR, "journal.jsonl"));
const violations = [];
const violationKeys = new Set();
/** Every outcome class, listed once so a run always reports all of them — a counter
 *  that only appears when it is non-zero is a counter nobody notices is missing. */
const OUTCOMES = ["ok", "guard", "contention", "dup-tolerated", "queued", "error"];
const counters = Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
const guardCounts = new Map();
const actionCounts = new Map();
const rpcStats = new Map();
const invariantState = new Map();
// GV-478 tallies, reported at the end and shown on the dashboard: they are how a reader
// knows the three behavioural features actually fired rather than merely being enabled.
const phaseB = {
  duplicatesSent: 0,
  duplicatesAbsorbed: 0,
  duplicatesTolerated: 0,
  scenariosRun: 0,
  scenariosByOutcome: {},
  offlineBursts: 0,
  offlineQueued: 0,
  offlineFlushed: 0,
  offlineStale: 0,
};

const sessions = new SessionPool(CONTAINER, DB, config.sessions);
const db = sessions.primary;
const rootRng = new Prng(config.seed);
const clock = config.rhythm
  ? new RhythmClock(EPOCH, rootRng.fork("clock"), { budgetMinutes: rhythmBudgetMinutes(config.ticks) })
  : new SimClock(EPOCH, rootRng.fork("clock"));
const workspaces = [];
let currentTick = 0;
let server = null;
// The client-parity oracle's state: whether govehlo-mobile's modules loaded, and the
// one-shot arming for --chaos-parity. Populated in main(); null means "not attempted".
let parity = null;

// ── Main ─────────────────────────────────────────────────────────────────────

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\n❌ Simulator failed: ${err.stack || err.message}`);
  exitCode = 1;
} finally {
  sessions.stopAll();
  if (config.keep) {
    console.log(`ℹ️  --keep: container ${CONTAINER} left running (psql: docker exec -it ${CONTAINER} psql -U postgres -d ${DB}).`);
  } else {
    removeContainer(CONTAINER);
  }
}

if (server) {
  console.log(`\nℹ️  Dashboard still serving at ${server.url} — the journal replays from the start. Ctrl-C to stop.`);
} else {
  process.exit(exitCode);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  banner();

  if (config.serve) {
    server = await startServer({ port: config.port, journalPath: journal.path, getState: snapshot });
    console.log(`🖥️  Mission control: ${server.url}`);
  }

  journal.write({
    kind: "run",
    seed: config.seed,
    config: {
      workspaces: config.workspaces,
      members: config.members,
      ticks: config.ticks,
      oracleEvery: config.oracleEvery,
      chaos: config.chaos,
      chaosParity: config.chaosParity,
      parity: config.parity,
      rhythm: config.rhythm,
      dup: config.dup,
      interleave: config.interleave,
      offline: config.offline,
      sessions: config.sessions,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
    },
    epoch: EPOCH.toISOString(),
    repro: REPRO,
    invariants: INVARIANTS,
  });

  await prepareParity();

  console.log("⏳ Booting disposable Postgres 17 and applying supabase-schema.sql…");
  const schemaSeconds = bootDatabase();
  console.log(`   schema applied in ${schemaSeconds.toFixed(1)}s.`);
  sessions.startAll();
  await db.exec(SIM_SCRATCH_DDL, "simulator scratch DDL");

  await seed();
  note(`Seeded ${workspaces.length} workspaces × ${config.members} members through the production onboarding RPCs.`);

  if (config.chaos) await injectChaos();

  const started = Date.now();
  for (let tick = 1; tick <= config.ticks; tick += 1) {
    currentTick = tick;
    clock.advance();
    await runTick(tick);
    if (config.oracleEvery > 0 && tick % config.oracleEvery === 0) await sweep(tick);
    if (!config.headless && tick % 25 === 0) {
      process.stdout.write(`\r   tick ${tick}/${config.ticks}  ok ${counters.ok}  guard ${counters.guard}  error ${counters.error}   `);
    }
  }
  if (!config.headless) process.stdout.write("\n");

  await sweep(config.ticks, { final: true });
  const wallSeconds = (Date.now() - started) / 1000;

  journal.write({
    kind: "end",
    counters: { ...counters },
    violations: violations.length,
    newViolations: newViolations().length,
    wallSeconds,
  });
  writeViolations();
  report(wallSeconds, schemaSeconds);

  // A self-test that had nothing to corrupt proved nothing, and silently passing would
  // be the worst possible outcome for a check whose entire job is to fail on demand.
  if (config.chaosParity && !parity?.perturb?.applied) {
    throw new Error("--chaos-parity found no live trip, fuel or expense row to drop from the client's copy — the self-test did not run.");
  }

  if (newViolations().length > 0) exitCode = 1;
}

function banner() {
  console.log("");
  console.log("── VehloShare workspace simulator (GV-471) ─────────────────");
  console.log(`  seed=${config.seed}  workspaces=${config.workspaces}  members=${config.members}  ticks=${config.ticks}`);
  console.log(`  oracle every ${config.oracleEvery} ticks  ·  simulated epoch ${EPOCH.toISOString().slice(0, 10)}`);
  console.log(`  rhythm ${config.rhythm ? "on" : "OFF (--flat-clock)"}  ·  duplicates ${config.dup ? "on" : "OFF"}  ·  interleave ${config.interleave ? `on (${config.sessions} sessions)` : "OFF"}  ·  offline persona ${config.offline ? "on" : "OFF"}`);
  if (config.chaos) console.log("  --chaos: one known corruption will be injected to prove the oracle detects it.");
  if (config.chaosParity) console.log("  --chaos-parity: one row will be dropped from the CLIENT's copy to prove the parity oracle detects it.");
  console.log("────────────────────────────────────────────────────────────");
}

// ── Client parity: load govehlo-mobile's real calculation modules ────────────
//
// Loud on the way in, in every channel a reader might be looking at: the console, the
// journal (its own `parity` line kind, which the dashboard reads for the header pill),
// and — because a skipped check that looks green is worse than no check — a muted
// `client_parity` cell on the invariant wall for every workspace.
async function prepareParity() {
  if (!config.parity) {
    parity = { available: false, reason: "--no-parity", report: [] };
  } else {
    const loaded = await loadClientModules();
    parity = { ...loaded, perturb: config.chaosParity ? { applied: null } : null };
  }
  journal.write({
    kind: "parity",
    phase: "load",
    available: parity.available,
    reason: parity.reason ?? null,
    mobileRoot: MOBILE_ROOT,
    modules: parity.report ?? [],
  });
  if (parity.available) {
    const loadedFiles = parity.report.filter((m) => m.loaded).map((m) => m.file);
    note(`Klient-paritet: kører govehlo-mobiles egne moduler (${loadedFiles.join(", ")}).`);
    for (const module of parity.report.filter((m) => !m.loaded)) {
      console.warn(`⚠  client parity: ${module.file} did not load — ${module.error}`);
    }
  } else {
    console.warn(`\n⚠  CLIENT PARITY SKIPPED: ${parity.reason}`);
    console.warn("   The invariant wall shows 'Klient-paritet' as ikke tilgængelig, not as green.\n");
    note(`Klient-paritet ikke tilgængelig: ${parity.reason}`);
  }
  if (config.chaosParity && !parity.available) {
    throw new Error("--chaos-parity was requested but the parity oracle is unavailable — the self-test would prove nothing.");
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

function bootDatabase() {
  startPostgres(CONTAINER, REPO);
  createDbWithPrelude(CONTAINER, DB);
  const prelude = psql(CONTAINER, DB, ["-c", LOCAL_PRELUDE]);
  if (prelude.status !== 0) throw new Error(`local prelude failed:\n${prelude.stderr}`);
  const startedAt = Date.now();
  const applied = psql(CONTAINER, DB, ["-f", "/work/supabase-schema.sql"]);
  if (applied.status !== 0) {
    throw new Error(`schema apply failed:\n${(applied.stderr || "").trim().slice(-4000)}`);
  }
  return (Date.now() - startedAt) / 1000;
}

// ── Seeding, through the production onboarding RPCs ──────────────────────────
//
// auth.users is the single object with no production write path (the hosted load
// rehearsal uses the Auth admin API for exactly the same reason). Everything else —
// the workspace, the join code, every membership — goes through the RPC a client calls.

function subFor(index) {
  return `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`;
}

async function seed() {
  const users = [];
  for (let w = 0; w < config.workspaces; w += 1) {
    for (let m = 0; m < config.members; m += 1) {
      const index = w * config.members + m;
      users.push({
        index,
        sub: subFor(index),
        // .invalid can never resolve (RFC 6761) — no synthetic address can ever be mailed.
        email: `sim-${index}@vehloshare.invalid`,
        baseName: FIRST_NAMES[index % FIRST_NAMES.length],
      });
    }
  }
  const values = users.map((u) => `(${uuidLit(u.sub)}, ${lit(u.email)})`).join(",\n");
  await db.exec(
    `insert into auth.users (id, email) values\n${values}\non conflict (id) do nothing;`,
    "create synthetic auth users",
  );

  for (let w = 0; w < config.workspaces; w += 1) {
    const rng = rootRng.fork(`ws-${w}`);
    const personas = assignPersonas(config.members, rng, {
      pool: config.offline ? JOINER_PERSONAS_WITH_OFFLINE : JOINER_PERSONAS,
    });
    const members = [];
    for (let slot = 0; slot < config.members; slot += 1) {
      const user = users[w * config.members + slot];
      members.push({
        slot,
        sub: user.sub,
        email: user.email,
        baseName: user.baseName,
        name: `${user.baseName} ${String.fromCharCode(65 + w)}`,
        persona: personas[slot],
        memberId: null,
        active: true,
      });
    }

    const name = `${WORKSPACE_NAMES[w % WORKSPACE_NAMES.length]} ${w + 1}`;
    const owner = members[0];
    const created = await callAs(owner, `select to_jsonb(sim_ws) from public.create_private_ledger_workspace(${lit(name)}) sim_ws limit 1`);
    if (!created.ok) throw new Error(`seed workspace ${w}: ${created.message}`);
    const ledgerId = created.result.ledger_id;
    owner.memberId = created.result.admin_member_id;

    // create_private_ledger_workspace derives the admin's display name from their
    // email local part ("sim-0"), which is right for a real signup and wrong for a
    // fixture nobody can read. Give the owner the same kind of name the joiners get.
    await callAs(owner, `select to_jsonb(sim_named) from public.set_member_name(
        target_ledger_id => ${lit(ledgerId)},
        target_member_id => ${uuidLit(owner.memberId)},
        new_name => ${lit(owner.name)},
        event_title => ${lit("Navn opdateret")},
        event_body => ${lit(owner.name)}) sim_named limit 1`);

    const code = await callAs(owner, `select to_jsonb(public.get_workspace_join_code(${lit(ledgerId)}))`);
    if (!code.ok) throw new Error(`seed join code ${w}: ${code.message}`);

    for (let slot = 1; slot < config.members; slot += 1) {
      const member = members[slot];
      const joined = await callAs(
        member,
        `select to_jsonb(sim_join) from public.redeem_ledger_invite(${lit(code.result)}, ${lit(member.name)}) sim_join limit 1`,
      );
      if (!joined.ok) throw new Error(`seed member ${w}/${slot}: ${joined.message}`);
      member.memberId = joined.result.member_id;
    }

    const ws = {
      index: w,
      name,
      ledgerId,
      members,
      openPeriodId: null,
      closedPeriodIds: [],
      trips: [],
      fuel: [],
      bookings: [],
      expenses: [],
      recurring: [],
      repairs: [],
      requests: [],
      balances: [],
      odometer: 40000 + w * 1500,
      // Kilometres driven since the last logged fill. The rhythm's `thirsty` rule reads
      // it (lib/rhythm.mjs) so a tankning follows the driving instead of a die roll.
      kmSinceFuel: 0,
      counters: {},
      rng,
      lastAction: null,
      lastOutcome: null,
    };
    await refreshOpenPeriod(ws);

    // Two admin settings every real workspace has before anyone logs anything: the
    // tank baseline (migration 092) and the repairs split rule (GVM-307).
    await callAs(owner, `select public.set_tank_baseline(
        target_ledger_id => ${lit(ledgerId)},
        odometer_value => ${ws.odometer},
        fraction_value => 0.75,
        event_title => ${lit("Tankniveau sat")},
        event_body => ${lit("75 %")})`);
    await callAs(owner, `select jsonb_build_object('ok', true) from (select public.update_ledger_settings(
        target_ledger_id => ${lit(ledgerId)},
        settlement_mode_value => null,
        expense_split_defaults_value => null,
        vehicle_info_value => null,
        repairs_split_mode_value => ${lit(rng.pick(["ligeligt", "efter_koersel"]))})) sim_void`);

    workspaces.push(ws);
  }
}

async function refreshOpenPeriod(ws) {
  const value = await db.value(
    `select id from public.settlement_periods
      where ledger_id = ${lit(ws.ledgerId)} and status = 'open' and closed_at is null
      order by opened_at desc limit 1;`,
    "read open period",
  );
  ws.openPeriodId = value;
  return value;
}

// ── The tick loop ────────────────────────────────────────────────────────────
//
// One tick is ONE of three things, decided in this order and every branch drawn from
// the workspace's PRNG stream:
//
//   1. an OFFLINE FLUSH, when the actor is the offline commuter and their queue has
//      come back into range (GV-478 feature 2);
//   2. a CONTENTION SCENARIO, at INTERLEAVE_CHANCE (feature 4);
//   3. an ordinary action — possibly sent twice (feature 3), possibly queued instead of
//      sent (feature 2 again).
//
// Every branch journals at least one `action` line, so the digest covers all of it and
// tick numbers stay meaningful even though a tick is no longer one statement.

async function runTick(tick) {
  const ws = pickWorkspace();
  const actor = ws.rng.pick(ws.members.filter((m) => m.active)) ?? ws.members[0];
  const persona = PERSONAS[actor.persona];
  const ctx = makeContext(ws, actor.slot);

  // ── 1. The offline commuter ────────────────────────────────────────────────
  const offlinePolicy = config.offline ? persona.offline : null;
  let queueing = false;
  let offlineState = null;
  if (offlinePolicy) {
    offlineState = actor.offlineState ?? (actor.offlineState = { until: 0, queue: [] });
    if (offlineState.queue.length > 0 && tick > offlineState.until) {
      await flushOfflineQueue(tick, ws, actor, offlineState);
      return;
    }
    if (offlineState.queue.length === 0 && ws.rng.bool(offlinePolicy.chance)) {
      offlineState.until = tick + ws.rng.int(offlinePolicy.minTicks, offlinePolicy.maxTicks);
      phaseB.offlineBursts += 1;
    }
    queueing = tick <= offlineState.until && offlineState.queue.length < offlinePolicy.maxQueued;
    ctx.offline = queueing;
  }

  // ── 2. A lockstep contention scenario, instead of an action ────────────────
  if (config.interleave && !queueing && ws.rng.bool(INTERLEAVE_CHANCE)) {
    const ran = await runContention(tick, ws, ctx);
    if (ran) return;
  }

  // ── 3. An ordinary action ──────────────────────────────────────────────────
  //
  // Weighted choice with fallback: an action whose preconditions are not met is
  // discarded and the remaining weights are re-rolled. post_message always builds, so
  // a tick always produces at least one journal line.
  //
  // The rhythm multiplies those weights by the time of day, the weekday and the
  // month's edge before the draw (lib/rhythm.mjs). It never touches the persona's own
  // map — a modulated pool is a new array — so `--flat-clock` really is Phase A's mix.
  const baseline = Object.entries(persona.weights).filter(([name]) => ACTIONS[name]);
  const rhythm = config.rhythm ? clock.context({ kmSinceFuel: ws.kmSinceFuel ?? 0 }) : null;
  const pool = rhythm ? modulateWeights(baseline, rhythm) : baseline;

  let chosen = null;
  let built = null;
  for (let attempt = 0; attempt < 6 && pool.length > 0; attempt += 1) {
    const name = ws.rng.weighted(pool);
    const index = pool.findIndex(([candidate]) => candidate === name);
    pool.splice(index, 1);
    // eslint-disable-next-line no-await-in-loop -- the tick loop is intentionally serial
    const candidate = await ACTIONS[name].build(ctx);
    if (candidate) { chosen = name; built = candidate; break; }
  }
  if (!built) {
    chosen = "post_message";
    built = await ACTIONS.post_message.build(ctx);
  }

  const effectiveActor = built.actorOverride !== undefined && built.actorOverride !== null
    ? ws.members.find((m) => m.slot === built.actorOverride) ?? actor
    : actor;
  const sql = actionSql(claimsFor(effectiveActor), built.inner);

  // ── The offline queue: decided now, sent much later ────────────────────────
  //
  // The SQL is frozen here, with the simulated timestamps of THIS moment and — for an
  // edit — the row version the phone could see at THIS moment (lib/actions.mjs's
  // offlineToken). That is the whole point: when the burst lands, the entry is
  // backdated relative to everything the workspace did in between, and its precondition
  // token may describe a version of the row that no longer exists.
  if (queueing) {
    offlineState.queue.push({
      action: chosen,
      sql,
      built,
      actor: effectiveActor,
      decidedTick: tick,
      decidedSim: clock.now().toISOString(),
      decidedOffset: clock.offsetMinutes(),
      staleToken: Boolean(built.detail?.offlineToken),
    });
    phaseB.offlineQueued += 1;
    journalAction({
      tick,
      ws,
      actor: effectiveActor,
      action: chosen,
      outcome: "queued",
      offline: "queued",
      step: `offline-queue@${offlineState.until}`,
      detail: built.detail ?? null,
      ms: 0,
      rhythm,
    });
    return;
  }

  const first = await sendAction(sql);
  await applyIfOk(built, first);
  journalAction({
    tick, ws, actor: effectiveActor, action: chosen, rhythm,
    outcome: first.outcome, guardKind: first.guardKind, sqlstate: first.sqlstate,
    message: first.message, ms: first.ms, detail: built.detail ?? null,
  });
  recordActionViolation(tick, ws, effectiveActor, chosen, first, built);

  // A hostile action whose whole point is that the database must refuse it. Today the
  // only one is the fat-finger odometer, which migration 195 turned into a guard: if it
  // ever SUCCEEDS again the mirror is being poisoned and the run must say so, whatever
  // the invariants think (they cannot see it — both engines faithfully report the
  // poisoned floor, which is exactly why this check is here and not in the oracle).
  if (built.mustNotSucceed && first.outcome === "ok") {
    recordViolation({
      key: `guard-missing:${chosen}`,
      kind: "guard-missing",
      tick,
      ws: ws.index,
      action: chosen,
      actor: effectiveActor.name,
      persona: effectiveActor.persona,
      message: `${chosen} succeeded, but the schema is supposed to refuse it (${built.mustNotSucceed}).`,
      detail: built.detail ?? null,
    });
  }

  // ── The duplicate send ─────────────────────────────────────────────────────
  if (config.dup) await maybeDuplicate({ tick, ws, actor: effectiveActor, action: chosen, sql, built, rhythm });
}

/** The per-tick context every action builder receives. */
function makeContext(ws, actorSlot) {
  return {
    rng: ws.rng,
    ws,
    sim: clock,
    actorSlot,
    offline: false,
    settlementPairs,
    buildCloseProgram,
    refreshOpenPeriod,
    readUpdatedAt,
  };
}

/**
 * The row version a member's phone could see right now — the offline queue's
 * precondition token (GV-478 feature 2).
 *
 * A read in the decision path, which is fine and already the norm here: the database's
 * state at a given tick is itself a function of the seed, so a replay reads the same
 * value. The table list is a hard allow-list rather than an interpolation, because
 * `public.${table}` with a caller-supplied name is how a helper like this becomes an
 * injection point the next time somebody extends it.
 */
const PRECONDITION_TABLES = new Set(["trips", "fuel_payments", "car_bookings"]);
async function readUpdatedAt(table, id) {
  if (!id || !PRECONDITION_TABLES.has(table)) return null;
  try {
    return await db.value(`select updated_at from public.${table} where id = ${uuidLit(id)};`, "read updated_at");
  } catch {
    return null;
  }
}

/** Send one prepared statement and classify the reply. The single place that knows how
 *  a sim_exec answer becomes an outcome. */
async function sendAction(sql) {
  const res = await db.send(sql);
  if (res.stderr) {
    // psql itself complained: a malformed statement or a transaction that could not
    // commit. Never an expected rejection — sim_exec turns those into data.
    return { outcome: "error", message: res.stderr.slice(0, 1200), ms: res.ms, sqlstate: null, guardKind: null, payload: null };
  }
  let payload = null;
  try {
    payload = JSON.parse(res.lines[0]);
  } catch {
    return { outcome: "error", message: `unparseable reply: ${(res.lines[0] ?? "").slice(0, 400)}`, ms: res.ms, sqlstate: null, guardKind: null, payload: null };
  }
  if (payload.ok) return { outcome: "ok", ms: res.ms, sqlstate: null, guardKind: null, message: null, payload };
  if (isLockTimeout(payload.sqlstate, payload.message)) {
    return { outcome: "contention", ms: res.ms, sqlstate: payload.sqlstate, guardKind: null, message: payload.message, payload };
  }
  const guardKind = classifyRejection(payload.sqlstate, payload.message);
  return { outcome: guardKind ? "guard" : "error", guardKind, sqlstate: payload.sqlstate, message: payload.message, ms: res.ms, payload };
}

async function applyIfOk(built, result) {
  if (result.outcome === "ok") await built.apply?.(result.payload?.result ?? null);
}

/** Counters, per-action stats, the journal line, and the workspace's "last action". */
function journalAction({
  tick, ws, actor, action, outcome, guardKind = null, sqlstate = null, message = null,
  ms = 0, detail = null, dup = false, session = 0, step = null, scenario = null,
  offline = null, rhythm = null, extra = null,
}) {
  counters[outcome] = (counters[outcome] ?? 0) + 1;
  actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  if (guardKind) guardCounts.set(guardKind, (guardCounts.get(guardKind) ?? 0) + 1);
  const stat = rpcStats.get(action) ?? { count: 0, totalMs: 0, maxMs: 0, samples: [] };
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  stat.samples.push(ms);
  if (stat.samples.length > 40) stat.samples.shift();
  rpcStats.set(action, stat);

  ws.lastAction = action;
  ws.lastOutcome = outcome;

  const now = clock.now();
  journal.write({
    kind: "action",
    tick,
    simTime: now.toISOString(),
    simOffsetMin: clock.offsetMinutes(),
    // GV-478: the rhythm, in the journal and therefore on the dashboard. Derived from
    // the epoch, so it is NOT in the determinism digest — simOffsetMin is the
    // epoch-independent half, and it already is.
    simClock: clockLabel(now),
    simPhase: rhythm?.phase ?? null,
    rhythmRules: rhythm ? firedRules(rhythm) : null,
    ws: ws.index,
    wsName: ws.name,
    actorSlot: actor.slot,
    actor: actor.name,
    persona: actor.persona,
    session,
    action,
    step,
    scenario,
    dup,
    offline,
    outcome,
    guardKind,
    sqlstate,
    ms,
    detail,
    message: message ? String(message).slice(0, 400) : null,
    ...(extra ?? {}),
  });
}

function recordActionViolation(tick, ws, actor, action, result, built, extra = {}) {
  if (result.outcome !== "error") return;
  recordViolation({
    key: `action:${action}:${result.sqlstate ?? "harness"}`,
    kind: "unclassified-rejection",
    tick,
    ws: ws.index,
    action,
    actor: actor.name,
    persona: actor.persona,
    sqlstate: result.sqlstate,
    message: result.message ? String(result.message).slice(0, 1200) : null,
    detail: built?.detail ?? null,
    ...extra,
  });
}

// ── Feature 2: the offline burst ─────────────────────────────────────────────
//
// Everything the phone decided while it was out of range, sent in one go, in decision
// order, in a single tick. The entries arrive backdated relative to everything the
// workspace wrote in between, which is the shape real offline sync has and the shape
// nothing else in this repo produces.
async function flushOfflineQueue(tick, ws, actor, state) {
  const entries = state.queue.splice(0, state.queue.length);
  state.until = 0;
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop -- the burst is ordered on purpose
    const result = await sendAction(entry.sql);
    // eslint-disable-next-line no-await-in-loop
    await applyIfOk(entry.built, result);
    phaseB.offlineFlushed += 1;
    if (entry.staleToken && result.guardKind === "stale_precondition") phaseB.offlineStale += 1;
    journalAction({
      tick,
      ws,
      actor: entry.actor,
      action: entry.action,
      outcome: result.outcome,
      guardKind: result.guardKind,
      sqlstate: result.sqlstate,
      message: result.message,
      ms: result.ms,
      detail: entry.built.detail ?? null,
      offline: "flush",
      // The decision tick is in the digest through `step`: two runs of one seed must
      // agree not only on what was flushed but on how long it had been waiting.
      step: `offline-flush@${entry.decidedTick}`,
      extra: { decidedTick: entry.decidedTick, decidedSim: entry.decidedSim, queuedTicks: tick - entry.decidedTick },
    });
    recordActionViolation(tick, ws, entry.actor, entry.action, result, entry.built, { offline: "flush", decidedTick: entry.decidedTick });
  }
}

// ── Feature 3: the duplicate send ────────────────────────────────────────────
//
// Sends the IDENTICAL statement a second time, immediately, and asks the database
// whether that made a second row. See DUPLICATE_CATALOGUE in lib/actions.mjs for what
// each action is expected to do and why — every entry there was read out of
// supabase-schema.sql.
//
// The duplicate's own `apply` is deliberately NOT run. For an idempotent action there is
// nothing new to record, and for a tolerated one the second row is left UNTRACKED by the
// harness on purpose: it is exactly what a double-tap leaves behind in production, the
// oracle reads the database rather than the harness's model, and a phantom entry in the
// model would make later edits address a row the member never created.
async function maybeDuplicate({ tick, ws, actor, action, sql, built, rhythm }) {
  const plan = duplicateExpectation(action);
  if (!plan) return;
  if (!ws.rng.bool(DUP_CHANCE)) return;

  const before = await probeRows(plan, ws, built.detail);
  const result = await sendAction(sql);
  const after = await probeRows(plan, ws, built.detail);
  const delta = before === null || after === null ? null : after - before;

  let outcome = result.outcome;
  if (plan.expect === "tolerated" && outcome === "ok" && delta !== null && delta > 0) {
    outcome = "dup-tolerated";
    phaseB.duplicatesTolerated += 1;
  } else if (outcome === "ok" || outcome === "guard") {
    phaseB.duplicatesAbsorbed += 1;
  }
  phaseB.duplicatesSent += 1;

  journalAction({
    tick, ws, actor, action, rhythm,
    outcome,
    guardKind: result.guardKind,
    sqlstate: result.sqlstate,
    message: result.message,
    ms: result.ms,
    detail: built.detail ?? null,
    dup: true,
    step: `dup:${plan.expect}`,
    extra: { dupExpect: plan.expect, dupRowDelta: delta },
  });
  recordActionViolation(tick, ws, actor, action, result, built, { dup: true });

  // The finding this feature exists to produce: the schema promised the second send
  // could not create a row, and it did.
  if (plan.expect === "idempotent" && delta !== null && delta > 0) {
    recordViolation({
      key: `duplicate:${action}`,
      kind: "duplicate_hazard",
      tick,
      ws: ws.index,
      action,
      actor: actor.name,
      persona: actor.persona,
      message: `re-sending ${action} created ${delta} extra row(s), but ${plan.why}`,
      detail: { expect: plan.expect, why: plan.why, rowsBefore: before, rowsAfter: after, action: built.detail ?? null },
    });
  }
}

/** Count the rows the action creates. Null when the probe could not be answered, which
 *  makes the duplicate un-judged rather than falsely clean. */
async function probeRows(plan, ws, detail) {
  try {
    const value = await db.value(`${plan.probe(ws, detail ?? {})};`, `duplicate probe ${plan.action}`);
    const count = Number(value);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

// ── Feature 4: the lockstep contention scenario ──────────────────────────────
//
// Three sub-steps, three journal lines, one PRNG-chosen resolution. See
// lib/interleave.mjs for the templates and for why the contender runs under
// SET LOCAL lock_timeout.
async function runContention(tick, ws, ctx) {
  const scenario = await buildScenario(ctx);
  if (!scenario) return false;
  const holderSessionIndex = sessions.size > 2 ? ws.rng.int(1, sessions.size - 1) : 1;

  const outcome = await runScenario({
    scenario,
    ws,
    sessions,
    rng: ws.rng,
    holderSessionIndex,
    onStep: async (step, sessionIndex, actorSlot, result, label) => {
      const actor = ws.members.find((m) => m.slot === actorSlot) ?? ws.members[0];
      journalAction({
        tick, ws, actor,
        action: `interleave_${scenario.id}`,
        outcome: result.outcome,
        guardKind: result.guardKind ?? null,
        sqlstate: result.sqlstate ?? null,
        message: result.message ?? null,
        ms: result.ms ?? 0,
        detail: { ...(scenario.detail ?? {}), label },
        session: sessionIndex,
        step,
        scenario: scenario.id,
      });
      if (result.outcome === "error") {
        recordActionViolation(tick, ws, actor, `interleave_${scenario.id}`, result, null, { step, session: sessionIndex });
      }
    },
  });

  phaseB.scenariosRun += 1;
  const key = outcome.steps.contender.outcome;
  phaseB.scenariosByOutcome[key] = (phaseB.scenariosByOutcome[key] ?? 0) + 1;

  if (outcome.hazard) {
    recordViolation({
      key: `interleave:${scenario.id}`,
      kind: "interleave_hazard",
      tick,
      ws: ws.index,
      action: `interleave_${scenario.id}`,
      message: outcome.hazard,
      detail: {
        scenario: scenario.id,
        danish: scenario.danish,
        lock: scenario.lock,
        holder: { slot: scenario.holder.slot, outcome: outcome.steps.holder.outcome },
        contender: { slot: scenario.contender.slot, outcome: outcome.steps.contender.outcome },
        resolution: outcome.steps.resolution,
        ...(scenario.detail ?? {}),
      },
    });
  }

  // Belt and braces: a scenario that threw between the holder's statement and its
  // resolution would leave a transaction — and its locks — open for the oracle sweep.
  await sessions.rollbackSecondaries();
  return true;
}

// Workspaces are visited in proportion to their size, so a run with unequal member
// counts still spreads its ticks the way real traffic would.
function pickWorkspace() {
  const entries = workspaces.map((ws) => [ws, ws.members.filter((m) => m.active).length || 1]);
  return rootRng.weighted(entries) ?? workspaces[0];
}

// ── Settlement helpers the actions call ──────────────────────────────────────

async function settlementPairs(ws, periodId) {
  if (!periodId) return [];
  const admin = ws.members[0];
  const calc = await callAs(admin, `select public.calculate_period_settlement(${lit(ws.ledgerId)}, ${uuidLit(periodId)})`);
  if (!calc.ok || !calc.result) return [];
  return computeSettlementsFromNets(calc.result.people ?? []);
}

async function buildCloseProgram(ws) {
  if (!ws.openPeriodId) return null;
  const admin = ws.members[0];
  const calc = await callAs(admin, `select public.calculate_period_settlement(${lit(ws.ledgerId)}, ${uuidLit(ws.openPeriodId)})`);
  if (!calc.ok || !calc.result) return null;
  const fingerprint = await callAs(admin, `select to_jsonb(public.calculate_period_entry_fingerprint(${lit(ws.ledgerId)}, ${uuidLit(ws.openPeriodId)}))`);
  const snapshot = buildCloseSnapshot(calc.result);
  // The fingerprint is what makes oracle invariant 2 possible: the close STORES it in
  // snapshot_json, so a later sweep can recompute and prove nothing moved inside the
  // closed period. buildCloseSnapshot omits it on purpose for the load rehearsal (a
  // client that cannot hash must still be able to close); here the server computed it,
  // so there is no client/server hashing mismatch to avoid.
  if (fingerprint.ok && typeof fingerprint.result === "string") snapshot.entryFingerprint = fingerprint.result;
  return {
    snapshot,
    requests: snapshot.settlements
      .filter((s) => Number(s.amount) > 0)
      .map((s) => ({
        target_ledger_id: ws.ledgerId,
        target_open_period_id: ws.openPeriodId,
        payer_member_id: s.fromId,
        recipient_member_id: s.toId,
        amount_value: s.amount,
        currency_value: s.currency ?? "DKK",
        next_status: "requested",
      })),
  };
}

/** Run one statement as a member and return sim_exec's verdict. */
async function callAs(member, innerSql) {
  const res = await db.send(actionSql(claimsFor(member), innerSql));
  if (res.stderr) return { ok: false, message: res.stderr.slice(0, 800) };
  const payload = JSON.parse(res.lines[0]);
  return payload.ok
    ? { ok: true, result: payload.result }
    : { ok: false, sqlstate: payload.sqlstate, message: payload.message };
}

// ── Oracle sweeps ────────────────────────────────────────────────────────────

async function sweep(tick, { final = false } = {}) {
  // An open transaction on a secondary session holds locks the sweep's own reads would
  // sit behind. Scenarios always resolve their own, so this is belt and braces.
  await sessions.rollbackSecondaries();
  const results = await runOracle(db, workspaces, { parity });
  // Parity gets its own journal line as well as its cell on the wall: the wall says
  // green/red/muted, this says WHAT was compared — which periods, how many members,
  // and (when it is red) the first disagreeing field. A reader tailing the journal
  // should not have to open the dashboard to see that.
  const parityResults = results.filter((r) => r.invariant === "client_parity");
  if (parityResults.length > 0) {
    journal.write({
      kind: "parity",
      phase: "sweep",
      tick,
      simTime: clock.now().toISOString(),
      available: Boolean(parity?.available),
      results: parityResults.map((r) => ({
        ws: r.ws,
        ok: r.ok,
        skipped: Boolean(r.skipped),
        periods: r.detail?.periods?.length ?? 0,
        mismatchCount: r.detail?.mismatchCount ?? 0,
        first: r.detail?.first ?? null,
      })),
    });
  }
  for (const result of results) {
    invariantState.set(`${result.invariant}:${result.ws}`, result);
    if (!result.ok) {
      recordViolation({
        key: `oracle:${result.invariant}:${result.ws}`,
        kind: "invariant",
        invariant: result.invariant,
        tick,
        ws: result.ws,
        detail: result.detail,
      });
    }
  }
  journal.write({
    kind: "oracle",
    tick,
    simTime: clock.now().toISOString(),
    simOffsetMin: clock.offsetMinutes(),
    final,
    results,
  });
}

// ── Chaos: the oracle's self-test ────────────────────────────────────────────
//
// One deliberate corruption, injected with service-role SQL that bypasses every RPC,
// purely so the run can prove the oracle notices. It targets migration 193's mirror.
//
// NOTE ON THE OBVIOUS CHOICE: pushing max_handover_odometer ABOVE the true maximum is
// NOT a corruption — 193 makes that column deliberately monotone, so a value above the
// table's max is exactly what an edited-down or deleted handover leaves behind, and the
// oracle asserts `mirror >= table max` for precisely that reason. The detectable
// corruption is the fraction pair, which 193 recomputes rather than ratchets.
async function injectChaos() {
  const ws = workspaces[0];
  await db.exec(
    `update public.ledgers
        set latest_handover_fraction = 0.42,
            latest_handover_observed_at = ${lit(EPOCH.toISOString())}::timestamptz,
            max_handover_odometer = 999999
      where id = ${lit(ws.ledgerId)};`,
    "chaos injection",
  );
  note(`--chaos: corrupted the migration-193 handover mirror on workspace ${ws.index} (${ws.name}).`);
  // Sweep immediately: the mirror trigger heals the fraction pair the moment anyone
  // saves a handover in this workspace, so detection must not depend on the run's
  // luck. Violations are keyed by (invariant, workspace), so a corruption that
  // survives several sweeps is still exactly one violation.
  await sweep(0);
}

// ── Violations ───────────────────────────────────────────────────────────────

function recordViolation(violation) {
  if (violationKeys.has(violation.key)) return;
  violationKeys.add(violation.key);
  const known = KNOWN_FINDINGS.find((finding) => finding.match(violation)) ?? null;
  const record = {
    ...violation,
    seed: config.seed,
    repro: REPRO,
    known: known ? { id: known.id, title: known.title } : null,
  };
  violations.push(record);
  // The journal line's own `kind` must stay "violation" — spreading the record after it
  // would overwrite it with the record's kind ("invariant" / "unclassified-rejection")
  // and the dashboard's stream would never see a violation at all.
  journal.write({ ...record, kind: "violation", violationKind: violation.kind });
  const badge = known ? `📓 known finding ${known.id}` : "🚨";
  console.error(`\n${badge} ${violation.kind}: ${violation.invariant ?? violation.action} (workspace ${violation.ws}, tick ${violation.tick})`);
  if (known) console.error(`   ${known.title}`);
  if (violation.message) console.error(`   ${violation.message.split("\n")[0]}`);
  console.error(`   repro: ${REPRO}`);
}

/** Violations nobody has reviewed yet — the only ones that fail a run. */
function newViolations() {
  return violations.filter((v) => !v.known);
}

function writeViolations() {
  const payload = {
    seed: config.seed,
    epoch: EPOCH.toISOString().slice(0, 10),
    config: { ...config },
    repro: REPRO,
    violationCount: violations.length,
    newViolationCount: newViolations().length,
    knownFindingCount: violations.length - newViolations().length,
    violations,
    // The tail is the context a reader needs and cannot reconstruct: what the fifty
    // moves before the failure actually were.
    journalTail: journal.tail(50),
  };
  writeFileSync(path.join(OUT_DIR, "violations.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function note(text) {
  journal.write({ kind: "note", tick: currentTick, text });
  if (!config.headless) console.log(`   ${text}`);
}

function snapshot() {
  return {
    seed: config.seed,
    epoch: EPOCH.toISOString(),
    tick: currentTick,
    ticks: config.ticks,
    simTime: clock.now().toISOString(),
    counters: { ...counters },
    simClock: clockLabel(clock.now()),
    phaseB: {
      ...phaseB,
      rhythm: config.rhythm,
      dup: config.dup,
      interleave: config.interleave,
      offline: config.offline,
      sessions: config.sessions,
    },
    guardCounts: Object.fromEntries(guardCounts),
    actionCounts: Object.fromEntries(actionCounts),
    rpc: [...rpcStats.entries()].map(([action, stat]) => ({
      action,
      count: stat.count,
      avgMs: Math.round((stat.totalMs / stat.count) * 100) / 100,
      maxMs: stat.maxMs,
      samples: stat.samples,
    })),
    invariants: [...invariantState.values()],
    // Client parity's availability, for the dashboard header. A wall cell can only say
    // muted; this says WHY, and which of govehlo-mobile's modules were actually run.
    parity: parity
      ? {
        available: parity.available,
        reason: parity.reason ?? null,
        modules: parity.report ?? [],
        perturbed: parity.perturb?.applied ?? null,
      }
      : null,
    violations,
    repro: REPRO,
    workspaces: workspaces.map((ws) => ({
      index: ws.index,
      name: ws.name,
      ledgerId: ws.ledgerId,
      openPeriodId: ws.openPeriodId,
      closedPeriods: ws.closedPeriodIds.length,
      lastAction: ws.lastAction,
      lastOutcome: ws.lastOutcome,
      odometer: Math.round(ws.odometer),
      counts: {
        trips: ws.trips.filter((t) => !t.deleted).length,
        fuel: ws.fuel.filter((f) => !f.deleted).length,
        bookings: ws.bookings.filter((b) => !b.cancelled).length,
        expenses: ws.expenses.filter((e) => !e.deleted).length,
        repairs: ws.repairs.length,
      },
      members: ws.members.map((m) => ({
        slot: m.slot,
        name: m.name,
        persona: m.persona,
        personaLabel: PERSONAS[m.persona]?.danish ?? m.persona,
      })),
      requests: ws.requests.map((r) => ({ amount: r.amount, status: r.status })),
      // Per-member nets from the most recent oracle sweep (see lib/oracle.mjs).
      balances: (ws.balances ?? []).map((b) => ({ name: b.name, net: b.net, km: b.km })),
    })),
  };
}

function report(wallSeconds, schemaSeconds) {
  const total = counters.ok + counters.guard + counters.error;
  console.log("");
  console.log("── Simulator run ───────────────────────────────────────────");
  console.log(`  seed ${config.seed} · ${config.workspaces} workspaces × ${config.members} members · ${config.ticks} ticks`);
  console.log(`  schema apply ${schemaSeconds.toFixed(1)}s · run ${wallSeconds.toFixed(1)}s · ${(total / Math.max(wallSeconds, 0.001)).toFixed(1)} actions/s`);
  console.log(`  simulated span ${EPOCH.toISOString().slice(0, 10)} → ${clock.now().toISOString().slice(0, 10)} (${Math.round(clock.offsetMinutes() / 60)} h)`);
  console.log("");
  console.log(`  outcomes:   ${OUTCOMES.map((name) => `${name} ${counters[name] ?? 0}`).join("   ")}`);
  console.log("");
  console.log("  behavioural realism (GV-478 Phase B):");
  console.log(`     rhythm                   ${config.rhythm ? `on · ${clock.now().toISOString().slice(0, 10)} ${clockLabel(clock.now())} at the last tick` : "off (--flat-clock)"}`);
  console.log(`     duplicates sent          ${phaseB.duplicatesSent} (${phaseB.duplicatesAbsorbed} absorbed by the schema, ${phaseB.duplicatesTolerated} created a second row)`);
  console.log(`     contention scenarios     ${phaseB.scenariosRun}${phaseB.scenariosRun > 0 ? ` · contender ${Object.entries(phaseB.scenariosByOutcome).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
  console.log(`     offline bursts           ${phaseB.offlineBursts} · ${phaseB.offlineQueued} statements queued, ${phaseB.offlineFlushed} flushed, ${phaseB.offlineStale} refused on a stale token`);
  console.log("");
  console.log("  guard kinds (an expected rejection is the fuzz reaching an edge):");
  for (const [kind, count] of [...guardCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${kind.padEnd(24)} ${String(count).padStart(5)}`);
  }
  console.log("");
  console.log("  actions (count · avg ms · max ms):");
  for (const [action, stat] of [...rpcStats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`     ${action.padEnd(28)} ${String(stat.count).padStart(5)} ${(stat.totalMs / stat.count).toFixed(1).padStart(8)} ${String(stat.maxMs).padStart(7)}`);
  }
  console.log("");
  const failed = [...invariantState.values()].filter((r) => !r.ok);
  const skippedCells = [...invariantState.values()].filter((r) => r.skipped).length;
  console.log(`  invariants: ${invariantState.size} cells checked, ${failed.length} failing${skippedCells > 0 ? `, ${skippedCells} not available` : ""}`);
  for (const invariant of INVARIANTS) {
    const cells = [...invariantState.values()].filter((r) => r.invariant === invariant);
    const bad = cells.filter((r) => !r.ok).length;
    const skipped = cells.filter((r) => r.skipped).length;
    // A skipped cell must never read as a pass. `–` is the muted state the dashboard
    // paints too, and the reason is printed once underneath rather than per workspace.
    const glyph = skipped === cells.length && cells.length > 0 ? "–" : bad === 0 ? "✓" : "✗";
    const tally = skipped === cells.length && cells.length > 0
      ? "ikke tilgængelig"
      : `${cells.length - bad}/${cells.length} workspaces green${skipped > 0 ? ` (${skipped} not available)` : ""}`;
    console.log(`     ${glyph} ${invariant.padEnd(24)} ${tally}`);
  }
  if (parity && !parity.available) console.log(`       client parity: ${parity.reason}`);
  if (parity?.perturb?.applied) {
    const applied = parity.perturb.applied;
    console.log(`       --chaos-parity: dropped one ${applied.label} (${applied.id}) from workspace ${applied.ws}'s CLIENT rows.`);
  }
  console.log("");
  console.log(`  determinism digest (actions only): ${digestOf(journal.lines)}`);
  console.log(`  journal:    tools/simulator/out/journal.jsonl (${journal.lines.length} lines)`);
  const fresh = newViolations();
  const known = violations.length - fresh.length;
  if (violations.length > 0) {
    console.log(`  violations: ${fresh.length} new, ${known} known → tools/simulator/out/violations.json`);
    for (const v of violations) {
      console.log(`     ${v.known ? `known ${v.known.id}` : "NEW"}  ${v.invariant ?? v.action} (workspace ${v.ws}, tick ${v.tick})`);
    }
    console.log(`  repro:      ${REPRO}`);
  } else {
    console.log("  violations: none");
  }
  console.log("────────────────────────────────────────────────────────────");
}

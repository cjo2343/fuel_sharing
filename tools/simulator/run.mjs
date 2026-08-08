// GV-471 — the VehloShare workspace simulator.
//
//   node tools/simulator/run.mjs --workspaces 4 --members 4 --ticks 400 --seed 42
//                                [--serve [port]] [--headless] [--oracle-every 25]
//                                [--chaos] [--keep]
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

import { Prng, SimClock, defaultEpoch, hashSeed } from "./lib/prng.mjs";
import { PERSONAS, assignPersonas } from "./lib/personas.mjs";
import { ACTIONS, classifyRejection } from "./lib/actions.mjs";
import { runOracle, INVARIANTS } from "./lib/oracle.mjs";
import { Journal, digestOf } from "./lib/journal.mjs";
import { startServer } from "./lib/server.mjs";
import { PsqlSession, SIM_SCRATCH_DDL, actionSql, claimsFor, lit, uuidLit } from "./lib/db.mjs";

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

const config = {
  workspaces: num("workspaces", 3),
  members: num("members", 4),
  ticks: num("ticks", 200),
  seed: num("seed", 42),
  oracleEvery: num("oracle-every", 25),
  chaos: has("chaos"),
  headless: has("headless"),
  keep: has("keep"),
  serve: has("serve") && !has("headless"),
  port: num("serve", 8471),
};
if (Number.isNaN(config.port)) config.port = 8471;

const EPOCH = args.values.epoch ? new Date(`${args.values.epoch}T00:00:00Z`) : defaultEpoch(config.ticks);
const CONTAINER = `govehlo-sim-${process.pid}`;

// The one-line reproduction, printed with every violation and stored in violations.json.
const REPRO = [
  "node tools/simulator/run.mjs",
  `--workspaces ${config.workspaces}`,
  `--members ${config.members}`,
  `--ticks ${config.ticks}`,
  `--seed ${config.seed}`,
  `--oracle-every ${config.oracleEvery}`,
  `--epoch ${EPOCH.toISOString().slice(0, 10)}`,
  config.chaos ? "--chaos" : "",
  "--headless",
].filter(Boolean).join(" ");

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
const counters = { ok: 0, guard: 0, error: 0 };
const guardCounts = new Map();
const actionCounts = new Map();
const rpcStats = new Map();
const invariantState = new Map();

const db = new PsqlSession(CONTAINER, DB);
const rootRng = new Prng(config.seed);
const clock = new SimClock(EPOCH, rootRng.fork("clock"));
const workspaces = [];
let currentTick = 0;
let server = null;

// ── Main ─────────────────────────────────────────────────────────────────────

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\n❌ Simulator failed: ${err.stack || err.message}`);
  exitCode = 1;
} finally {
  db.stop();
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
    },
    epoch: EPOCH.toISOString(),
    repro: REPRO,
    invariants: INVARIANTS,
  });

  console.log("⏳ Booting disposable Postgres 17 and applying supabase-schema.sql…");
  const schemaSeconds = bootDatabase();
  console.log(`   schema applied in ${schemaSeconds.toFixed(1)}s.`);
  db.start();
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

  journal.write({ kind: "end", counters: { ...counters }, violations: violations.length, wallSeconds });
  writeViolations();
  report(wallSeconds, schemaSeconds);

  if (violations.length > 0) exitCode = 1;
}

function banner() {
  console.log("");
  console.log("── VehloShare workspace simulator (GV-471) ─────────────────");
  console.log(`  seed=${config.seed}  workspaces=${config.workspaces}  members=${config.members}  ticks=${config.ticks}`);
  console.log(`  oracle every ${config.oracleEvery} ticks  ·  simulated epoch ${EPOCH.toISOString().slice(0, 10)}`);
  if (config.chaos) console.log("  --chaos: one known corruption will be injected to prove the oracle detects it.");
  console.log("────────────────────────────────────────────────────────────");
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
    const personas = assignPersonas(config.members, rng);
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
      odometer: 40000 + w * 1500,
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

async function runTick(tick) {
  const ws = pickWorkspace();
  const actor = ws.rng.pick(ws.members.filter((m) => m.active)) ?? ws.members[0];
  const persona = PERSONAS[actor.persona];

  const ctx = {
    rng: ws.rng,
    ws,
    sim: clock,
    actorSlot: actor.slot,
    settlementPairs,
    buildCloseProgram,
    refreshOpenPeriod,
  };

  // Weighted choice with fallback: an action whose preconditions are not met is
  // discarded and the remaining weights are re-rolled. post_message always builds, so
  // every tick produces exactly one journal line and tick numbers stay meaningful.
  const pool = Object.entries(persona.weights).filter(([name]) => ACTIONS[name]);
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
  const res = await db.send(sql);

  let outcome = "ok";
  let guardKind = null;
  let message = null;
  let sqlstate = null;
  let payload = null;

  if (res.stderr) {
    // psql itself complained: a malformed statement or a transaction that could not
    // commit. Never an expected rejection — sim_exec turns those into data.
    outcome = "error";
    message = res.stderr.slice(0, 1200);
  } else {
    try {
      payload = JSON.parse(res.lines[0]);
    } catch {
      outcome = "error";
      message = `unparseable reply: ${(res.lines[0] ?? "").slice(0, 400)}`;
    }
  }

  if (outcome !== "error" && payload) {
    if (payload.ok) {
      await built.apply?.(payload.result ?? null);
    } else {
      sqlstate = payload.sqlstate;
      message = payload.message;
      guardKind = classifyRejection(payload.sqlstate, payload.message);
      outcome = guardKind ? "guard" : "error";
    }
  }

  counters[outcome] += 1;
  actionCounts.set(chosen, (actionCounts.get(chosen) ?? 0) + 1);
  if (guardKind) guardCounts.set(guardKind, (guardCounts.get(guardKind) ?? 0) + 1);
  const stat = rpcStats.get(chosen) ?? { count: 0, totalMs: 0, maxMs: 0, samples: [] };
  stat.count += 1;
  stat.totalMs += res.ms;
  stat.maxMs = Math.max(stat.maxMs, res.ms);
  stat.samples.push(res.ms);
  if (stat.samples.length > 40) stat.samples.shift();
  rpcStats.set(chosen, stat);

  ws.lastAction = chosen;
  ws.lastOutcome = outcome;

  journal.write({
    kind: "action",
    tick,
    simTime: clock.now().toISOString(),
    simOffsetMin: clock.offsetMinutes(),
    ws: ws.index,
    wsName: ws.name,
    actorSlot: effectiveActor.slot,
    actor: effectiveActor.name,
    persona: effectiveActor.persona,
    action: chosen,
    outcome,
    guardKind,
    sqlstate,
    ms: res.ms,
    detail: built.detail ?? null,
    message: message ? String(message).slice(0, 400) : null,
  });

  if (outcome === "error") {
    recordViolation({
      key: `action:${chosen}:${sqlstate ?? "harness"}`,
      kind: "unclassified-rejection",
      tick,
      ws: ws.index,
      action: chosen,
      actor: effectiveActor.name,
      persona: effectiveActor.persona,
      sqlstate,
      message: message ? String(message).slice(0, 1200) : null,
      detail: built.detail ?? null,
    });
  }
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
  const results = await runOracle(db, workspaces);
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
  const record = { ...violation, seed: config.seed, repro: REPRO };
  violations.push(record);
  journal.write({ kind: "violation", ...record });
  console.error(`\n🚨 ${violation.kind}: ${violation.invariant ?? violation.action} (workspace ${violation.ws}, tick ${violation.tick})`);
  if (violation.message) console.error(`   ${violation.message.split("\n")[0]}`);
  console.error(`   repro: ${REPRO}`);
}

function writeViolations() {
  const payload = {
    seed: config.seed,
    epoch: EPOCH.toISOString().slice(0, 10),
    config: { ...config },
    repro: REPRO,
    violationCount: violations.length,
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
  console.log(`  outcomes:   ok ${counters.ok}   guard ${counters.guard}   error ${counters.error}`);
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
  console.log(`  invariants: ${invariantState.size} cells checked, ${failed.length} failing`);
  for (const invariant of INVARIANTS) {
    const cells = [...invariantState.values()].filter((r) => r.invariant === invariant);
    const bad = cells.filter((r) => !r.ok).length;
    console.log(`     ${bad === 0 ? "✓" : "✗"} ${invariant.padEnd(24)} ${cells.length - bad}/${cells.length} workspaces green`);
  }
  console.log("");
  console.log(`  determinism digest (actions only): ${digestOf(journal.lines)}`);
  console.log(`  journal:    tools/simulator/out/journal.jsonl (${journal.lines.length} lines)`);
  if (violations.length > 0) {
    console.log(`  violations: ${violations.length} → tools/simulator/out/violations.json`);
    console.log(`  repro:      ${REPRO}`);
  } else {
    console.log("  violations: none");
  }
  console.log("────────────────────────────────────────────────────────────");
}

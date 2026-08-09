// The client-parity oracle (GV-471 Phase A).
//
// WHAT THIS IS FOR. Every guard in this repo that claims to protect the mobile client
// from the SQL does it by READING the mobile source: check-hotpath-mirror.mjs diffs a
// column list, test-crossing-split-contract.mjs greps settlement-calc.ts for the
// arithmetic it expects to find, test-fuel-stop-verdict-contract.mjs transcribes the
// client's scenarios into SQL by hand. A regex over a TypeScript file can tell you a
// line still looks right. It cannot tell you the two engines still produce the same
// number, which is the only property anybody cares about — and the pin drift GV-473 had
// to heal, plus GV-472's zero-km divergence, were both exactly that failure.
//
// So this module does the other thing: it IMPORTS govehlo-mobile's real, unmodified
// calculation modules and RUNS them, on the simulator's own database rows, and diffs
// every number a member would see against what `calculate_period_settlement` says. When
// the simulator writes a row, the question stops being "does the SQL still net to zero"
// and becomes "would Emma's phone and the server agree about what Emma owes".
//
// ── How TypeScript gets loaded without a build step, a dependency, or a flag ──
//
// The three modules we want are plain, dependency-free, erasable-syntax-only TypeScript.
// Node can run that, but two things are in the way:
//
//   1. Type stripping is on by default only from Node 22.18 / 23.6. Rather than depend
//      on the runtime's default (and rather than make `npm run sim:run` carry a flag
//      that a nightly workflow we must not edit would not carry), a `load` hook does the
//      stripping explicitly with `module.stripTypeScriptTypes`, which is present from
//      Node 22.13 / 23.2 whether or not the default is on.
//   2. The mobile repo resolves `@/…` through a tsconfig path alias and writes relative
//      imports without an extension — both are bundler conventions Node does not follow.
//      A `resolve` hook maps `@/x` → `<mobile>/src/x` and appends `.ts`.
//
// Both hooks are registered through `module.registerHooks` (Node 22.15 / 23.5+), which
// is synchronous and in-thread, so there is no worker, no child process and no
// serialisation boundary between the parity check and the modules it calls. The resolve
// hook only ever fires for a specifier coming FROM a `.ts` file or starting with `@/`;
// nothing in this repo is either, so it cannot affect the simulator's own imports.
//
// If the Node running us is older than that, or the sibling repo is absent, or a module
// fails to import, the parity oracle SKIPS with a loud warning — the same
// tolerate-missing convention check-hotpath-mirror.mjs uses, and a hard requirement for
// .github/workflows/nightly-simulator.yml, which checks out this repo alone.
//
// SAFETY. Read-only in both directions: the sibling repo is imported, never written, and
// every query here is a `select`. Nothing in this module consumes a PRNG draw, so the
// action stream — and therefore the determinism digest — is byte-identical with parity
// on or off.

import nodeModule from "node:module";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { lit } from "./db.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// Resolved the way every other cross-repo tool here resolves it (see
// tools/check-hotpath-mirror.mjs and tools/test-crossing-split-contract.mjs): the
// sibling directory name is still the pre-rename `govehlo-mobile` on purpose — see the
// note at the top of CLAUDE.md. The env override exists so the skip path can be proved
// without moving anything.
export const MOBILE_ROOT = process.env.SIMULATOR_MOBILE_ROOT || path.join(REPO, "..", "govehlo-mobile");
const MOBILE_SRC = path.join(MOBILE_ROOT, "src");

// Every module we ask for, in load order. `required` marks the one the oracle cannot do
// its job without; the rest each add a check and degrade to "not loaded" on their own.
const WANTED = [
  {
    key: "settlementCalc",
    file: "lib/settlement-calc.ts",
    required: true,
    exports: ["calculateSettlements", "toExpenseInputs", "toRepairInputs", "scopeRepairsToPeriod"],
    gives: "settlement parity (fuelRate, totals, per-member net/tripCost/shares, deferredFuel)",
  },
  {
    key: "periodBalance",
    file: "lib/period-balance.ts",
    required: false,
    exports: ["periodSettlement"],
    gives: "the app's own period scoping, rather than a transcription of it",
  },
  {
    key: "periodSnapshot",
    file: "lib/period-snapshot.ts",
    required: false,
    exports: ["periodEntryFingerprint"],
    gives: "entry-fingerprint parity (the close's staleness gate)",
  },
  {
    key: "odometer",
    file: "lib/odometer.ts",
    required: false,
    exports: ["deriveOdometer"],
    gives: "odometer-floor parity against migration 193's handover mirror",
  },
];

let hooksInstalled = false;

/** Register the resolve/load hooks once. Returns null on success, a reason on failure. */
function installHooks() {
  if (hooksInstalled) return null;
  if (typeof nodeModule.registerHooks !== "function" || typeof nodeModule.stripTypeScriptTypes !== "function") {
    return `this Node (${process.version}) has no module.registerHooks + module.stripTypeScriptTypes — Node 22.15 / 23.5 or newer is needed to import the mobile TypeScript in-process`;
  }
  const srcUrlPrefix = pathToFileURL(path.join(MOBILE_SRC, "/")).href;
  try {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        // Only ever rewrite what the mobile repo's bundler conventions produce: an
        // `@/…` alias, or an extensionless relative import made FROM a .ts file.
        let spec = specifier;
        if (spec.startsWith("@/")) {
          spec = new URL(spec.slice(2), srcUrlPrefix).href;
        } else if (!spec.startsWith(".") || !String(context?.parentURL ?? "").endsWith(".ts")) {
          return nextResolve(specifier, context);
        }
        if (!/\.[cm]?[jt]sx?$/.test(spec)) spec += ".ts";
        return nextResolve(spec, context);
      },
      load(url, context, nextLoad) {
        if (url.startsWith("file:") && url.endsWith(".ts")) {
          const source = readFileSync(fileURLToPath(url), "utf8");
          return {
            format: "module",
            shortCircuit: true,
            // `mode: "strip"` erases types and refuses anything non-erasable (enums,
            // namespaces, parameter properties), which is precisely the guarantee we
            // want: a module that would need transformation fails to load and is
            // reported, rather than being silently mistranslated.
            source: nodeModule.stripTypeScriptTypes(source, { mode: "strip" }),
          };
        }
        return nextLoad(url, context);
      },
    });
  } catch (err) {
    return `registering the TypeScript import hooks failed: ${err.message}`;
  }
  hooksInstalled = true;
  return null;
}

/**
 * Load govehlo-mobile's calculation modules.
 *
 * Never throws. Returns `{ available, reason, modules, report }`, where `report` names
 * every module tried and why it did or did not load — the module-loadability finding is
 * part of the output, not a comment somebody has to keep true by hand.
 */
export async function loadClientModules() {
  const report = [];
  if (!existsSync(MOBILE_SRC)) {
    return {
      available: false,
      reason: `govehlo-mobile not found at ${MOBILE_ROOT} — client parity was NOT checked`,
      modules: {},
      report,
    };
  }
  const hookProblem = installHooks();
  if (hookProblem) {
    return { available: false, reason: `${hookProblem} — client parity was NOT checked`, modules: {}, report };
  }

  const modules = {};
  let requiredProblem = null;
  for (const want of WANTED) {
    const file = path.join(MOBILE_SRC, want.file);
    if (!existsSync(file)) {
      report.push({ file: want.file, loaded: false, error: "file does not exist in the sibling repo" });
      if (want.required) requiredProblem = `${want.file} does not exist in ${MOBILE_ROOT}`;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- four imports, once per run
      const loaded = await import(pathToFileURL(file).href);
      const missing = want.exports.filter((name) => typeof loaded[name] !== "function");
      if (missing.length > 0) {
        report.push({ file: want.file, loaded: false, error: `imported, but does not export ${missing.join(", ")}` });
        if (want.required) requiredProblem = `${want.file} is missing ${missing.join(", ")}`;
        continue;
      }
      modules[want.key] = loaded;
      report.push({ file: want.file, loaded: true, gives: want.gives });
    } catch (err) {
      report.push({ file: want.file, loaded: false, error: String(err.message ?? err).split("\n")[0].slice(0, 300) });
      if (want.required) requiredProblem = `${want.file} could not be imported: ${String(err.message ?? err).split("\n")[0]}`;
    }
  }

  if (requiredProblem) {
    return { available: false, reason: `${requiredProblem} — client parity was NOT checked`, modules, report };
  }
  return { available: true, reason: null, modules, report };
}

// ── Reading the rows a member's app would hold ───────────────────────────────
//
// One round trip per workspace. The column shapes are the mobile gateway's
// (govehlo-mobile/src/store/ledger-data-gateway.ts): live rows only — `deleted_at is
// null` on trips, fuel, expenses and repairs, exactly the four `.is('deleted_at', null)`
// filters the gateway carries.
//
// TWO DELIBERATE DEVIATIONS from the gateway, both narrowing to arithmetic:
//
//   · MEMBERS. The gateway loads `.eq('is_active', true)`. This loads every member and
//     lets `calculateSettlements` apply its own is_active filter, which is what the SQL's
//     active_members CTE does. That keeps both engines on ONE universe, so a difference
//     is arithmetic and not a row-selection choice. The gateway's active-only load does
//     mean an inactive payer's GV-274 credit is invisible in the app — a real gap, but a
//     product decision about what to fetch, not a calculation divergence, so it is
//     reported as a note (`gatewayActiveOnlyGap`) and never as a violation.
//   · WINDOWING. The gateway bounds trips/fuel by a date window and a row cap (GVM-559).
//     A simulator workspace is far inside both, so no window is applied here; a windowed
//     read could only ever hide rows and would turn a genuine mismatch into a pass.
export async function readParityRows(db, ws) {
  const id = lit(ws.ledgerId);
  return db.json(
    `select jsonb_build_object(
       'ledger', (select jsonb_build_object(
                    'id', l.id,
                    'expense_split_defaults', l.expense_split_defaults,
                    'repairs_split_mode', l.repairs_split_mode,
                    'tank_baseline_odometer', l.tank_baseline_odometer,
                    'max_handover_odometer', l.max_handover_odometer,
                    'vehicle_info', l.vehicle_info)
                   from public.ledgers l where l.id = ${id}),
       'members', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', m.id, 'name', m.name, 'is_active', m.is_active) order by m.id), '[]'::jsonb)
                   from public.ledger_members m where m.ledger_id = ${id}),
       'trips', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', t.id,
                    'period_id', t.period_id,
                    'start_km', t.start_km,
                    'end_km', t.end_km,
                    'driver_member_id', t.driver_member_id,
                    'crossing_cost_dkk', t.crossing_cost_dkk,
                    'crossing_paid_by_member_id', t.crossing_paid_by_member_id,
                    'participants', (select coalesce(jsonb_agg(jsonb_build_object('member_id', tp.member_id)
                                                               order by tp.member_id), '[]'::jsonb)
                                       from public.trip_participants tp where tp.trip_id = t.id)
                  ) order by t.id), '[]'::jsonb)
                 from public.trips t
                where t.ledger_id = ${id} and t.deleted_at is null),
       'fuelPayments', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', f.id,
                    'period_id', f.period_id,
                    'payer_member_id', f.payer_member_id,
                    'amount', f.amount,
                    'odometer', f.odometer) order by f.id), '[]'::jsonb)
                 from public.fuel_payments f
                where f.ledger_id = ${id} and f.deleted_at is null),
       'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', e.id,
                    'period_id', e.period_id,
                    'amount_dkk', e.amount_dkk,
                    'category', e.category,
                    'paid_by_member_id', e.paid_by_member_id,
                    'split_rule', e.split_rule,
                    'split_config', e.split_config) order by e.id), '[]'::jsonb)
                 from public.workspace_expenses e
                where e.ledger_id = ${id} and e.deleted_at is null),
       'vehicleRepairs', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', r.id,
                    'period_id', r.period_id,
                    'created_at', r.created_at,
                    'cost_dkk', r.cost_dkk,
                    'created_by_member_id', r.created_by_member_id,
                    'paid_by_member_id', r.paid_by_member_id) order by r.id), '[]'::jsonb)
                 from public.vehicle_repairs r
                where r.ledger_id = ${id} and r.deleted_at is null),
       'periods', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', sp.id,
                    'status', sp.status,
                    'opened_at', sp.opened_at,
                    'closed_at', sp.closed_at,
                    'server', public.calculate_period_settlement(sp.ledger_id, sp.id),
                    'serverFingerprint', public.calculate_period_entry_fingerprint(sp.ledger_id, sp.id))
                  order by sp.opened_at), '[]'::jsonb)
                 from public.settlement_periods sp
                where sp.ledger_id = ${id} and sp.status in ('open', 'queued')),
       'odometerCeiling', (select greatest(
                    coalesce((l.vehicle_info ->> 'syn_mileage')::numeric, 0),
                    coalesce(l.tank_baseline_odometer, 0),
                    coalesce(l.max_handover_odometer, 0),
                    coalesce((select max(t.end_km) from public.trips t
                               where t.ledger_id = l.id and t.deleted_at is null), 0),
                    coalesce((select max(f.odometer) from public.fuel_payments f
                               where f.ledger_id = l.id and f.deleted_at is null), 0))
                   from public.ledgers l where l.id = ${id}));`,
    "client parity rows",
  );
}

// ── The diff ─────────────────────────────────────────────────────────────────

// Both sides round money to two decimals — the SQL in `numeric`, the client in binary
// doubles — so a comparison must be immune to representation dust while still catching
// a single øre. Half an øre is the whole gap: nothing legitimate lands there, and any
// real divergence is at least 0,01 kr.
const KR_EPSILON = 0.005;

function near(a, b) {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0)) <= KR_EPSILON + 1e-9;
}

function num(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** The per-member fields both engines publish, in the order a reader wants them. */
const PERSON_FIELDS = ["km", "fuelPaid", "tripCost", "expensePaid", "expenseShare", "repairPaid", "repairShare", "crossingPaid", "crossingShare", "net"];
const TOTAL_FIELDS = ["fuelRate", "totalKm", "totalPaid", "totalExpenses", "totalRepairs", "totalCrossings"];

/**
 * Scope a ledger's rows to one period and run the client engine over them.
 *
 * When period-balance.ts imported, this IS the app's own `periodSettlement` — the same
 * function Hjem and Afregn call, so the scoping is not a transcription that can drift.
 * The fallback below is that function's body, kept only for the case where
 * period-balance.ts stops importing cleanly; if it is ever reached the parity result
 * says so, because a silent fallback is how a mirror rots.
 */
function clientSettlement(modules, rows, period) {
  const calc = modules.settlementCalc;
  const activePeriod = { id: period.id, opened_at: period.opened_at ?? null };
  const splitDefaults = rows.ledger?.expense_split_defaults ?? {};
  const repairsSplitMode = rows.ledger?.repairs_split_mode ?? null;
  const input = {
    activePeriod,
    members: rows.members,
    trips: rows.trips,
    fuelPayments: rows.fuelPayments,
    expenses: rows.expenses,
    vehicleRepairs: rows.vehicleRepairs,
    splitDefaults,
    repairsSplitMode,
  };
  if (modules.periodBalance) {
    return { via: "period-balance.ts", ...modules.periodBalance.periodSettlement(input) };
  }
  const periodId = activePeriod.id;
  const trips = rows.trips.filter((t) => t.period_id === periodId);
  const fuelPayments = rows.fuelPayments.filter((f) => f.period_id === periodId);
  const expenses = rows.expenses.filter((e) => e.period_id === periodId);
  const repairs = calc.scopeRepairsToPeriod(rows.vehicleRepairs, activePeriod.opened_at, null, periodId);
  return {
    via: "settlement-calc.ts (period-balance.ts unavailable)",
    periodId,
    trips,
    fuelPayments,
    expenses,
    repairs,
    summary: calc.calculateSettlements(
      rows.members, trips, fuelPayments, calc.toExpenseInputs(expenses), splitDefaults,
      calc.toRepairInputs(repairs), repairsSplitMode,
    ),
  };
}

/**
 * Perturb the rows handed to the CLIENT — never the database.
 *
 * This is `--chaos-parity`: the parity oracle's own self-test. An oracle that cannot be
 * made to fire passes every clean run there is, and unlike `--chaos` (which corrupts a
 * real column) this one has to corrupt the comparison itself, because that is where a
 * parity bug lives. Drops exactly one row, in a fixed priority order so the same seed
 * perturbs the same thing; returns what it dropped, or null when there was nothing to
 * drop (which the caller must treat as a failed self-test, not a pass).
 */
export function perturbClientRows(rows) {
  const livePeriodIds = new Set((rows.periods ?? []).map((p) => p.id));
  for (const [collection, label] of [["fuelPayments", "fuel payment"], ["trips", "trip"], ["expenses", "expense"]]) {
    const index = rows[collection].findIndex((row) => livePeriodIds.has(row.period_id));
    if (index >= 0) {
      const [dropped] = rows[collection].splice(index, 1);
      return { collection, label, id: dropped.id };
    }
  }
  return null;
}

/**
 * Compare, per live period, what the mobile client would display against what
 * `calculate_period_settlement` answers.
 *
 * Returns `{ ok, detail }` in the shape lib/oracle.mjs's other invariants return, so the
 * dashboard's invariant wall and the violation report need no special case.
 */
export function diffSettlementParity(modules, rows) {
  const mismatches = [];
  const notes = [];
  const periods = [];

  for (const period of rows.periods ?? []) {
    const server = period.server ?? {};
    const client = clientSettlement(modules, rows, period);
    const summary = client.summary;
    const scope = { period: period.id, status: period.status };

    for (const field of TOTAL_FIELDS) {
      if (!near(summary[field], server[field])) {
        mismatches.push({ ...scope, field, client: num(summary[field]), server: num(server[field]) });
      }
    }

    // deferredFuel (migration 194 / GVM-564) is a presence-and-total check: whether the
    // period set fuel aside at all is the thing a member sees, and it is the exact bug
    // GV-472 fixed, so a disagreement about presence matters as much as one about kroner.
    const serverDeferred = server.deferredFuel ?? null;
    const clientDeferred = summary.deferredFuel ?? null;
    if (Boolean(serverDeferred) !== Boolean(clientDeferred)) {
      mismatches.push({
        ...scope,
        field: "deferredFuel.present",
        client: Boolean(clientDeferred),
        server: Boolean(serverDeferred),
      });
    } else if (serverDeferred && !near(clientDeferred.total, serverDeferred.total)) {
      mismatches.push({
        ...scope,
        field: "deferredFuel.total",
        client: num(clientDeferred.total),
        server: num(serverDeferred.total),
      });
    }

    const serverPeople = new Map((server.people ?? []).map((p) => [p.id, p]));
    const clientPeople = summary.balances;
    for (const [id, person] of serverPeople) {
      const mine = clientPeople.get(id);
      if (!mine) {
        // The client engine dropped a member the server settles. With the simulator's
        // always-active membership this can only be a real divergence; the one benign
        // cause (an inactive credit-only payer) is filtered out above.
        mismatches.push({ ...scope, member: person.name, memberId: id, field: "member.present", client: false, server: true });
        continue;
      }
      for (const field of PERSON_FIELDS) {
        if (!near(mine[field], person[field])) {
          mismatches.push({
            ...scope,
            member: person.name,
            memberId: id,
            field: `person.${field}`,
            client: num(mine[field]),
            server: num(person[field]),
          });
        }
      }
    }
    for (const [id] of clientPeople) {
      if (!serverPeople.has(id)) {
        mismatches.push({ ...scope, memberId: id, field: "member.present", client: true, server: false });
      }
    }

    // The gateway's active-only member load (see readParityRows) means a member the
    // SQL retains credit-only would not be on anyone's phone. Worth saying out loud,
    // never worth failing a run over — it is a fetch decision, not arithmetic.
    const inactiveSettled = rows.members
      .filter((m) => !m.is_active && serverPeople.has(m.id))
      .map((m) => m.id);
    if (inactiveSettled.length > 0) notes.push({ gatewayActiveOnlyGap: inactiveSettled, period: period.id });

    // Entry fingerprint: the string close_settlement_period compares to decide whether a
    // prepared close is stale. Byte-identical or the close is rejected, so this is the
    // one field where "close enough" is meaningless.
    let fingerprint = null;
    if (modules.periodSnapshot && typeof period.serverFingerprint === "string") {
      const clientFingerprint = modules.periodSnapshot.periodEntryFingerprint(
        client.trips.map((t) => ({ id: t.id, crossingCost: t.crossing_cost_dkk })),
        client.fuelPayments.map((f) => f.id),
        client.expenses.map((e) => e.id),
        client.repairs.map((r) => ({ id: r.id, amount: r.cost_dkk })),
      );
      fingerprint = clientFingerprint === period.serverFingerprint;
      if (!fingerprint) {
        mismatches.push({
          ...scope,
          field: "entryFingerprint",
          client: clientFingerprint.slice(0, 400),
          server: String(period.serverFingerprint).slice(0, 400),
        });
      }
    }

    periods.push({
      period: period.id,
      status: period.status,
      via: client.via,
      people: serverPeople.size,
      trips: client.trips.length,
      fuel: client.fuelPayments.length,
      expenses: client.expenses.length,
      repairs: client.repairs.length,
      fingerprintChecked: fingerprint !== null,
    });
  }

  return { mismatches, notes, periods };
}

/**
 * The odometer floor, checked against the two facts that bound it.
 *
 * Deliberately an inequality pair and not a re-derivation: a second copy of
 * `deriveOdometer`'s max() would agree with the first by construction and prove nothing.
 * What can actually go wrong is the number leaving its bounds —
 *
 *   FLOOR:   migration 193 makes `ledgers.max_handover_odometer` monotone and
 *            `deriveOdometer` reads it as a candidate, so the derived reading can never
 *            legitimately sit below it. Below the floor means a handover reading a driver
 *            typed has stopped counting, and the next prefill hands them a number the car
 *            passed weeks ago.
 *   CEILING: the greatest of the five sources, computed independently in SQL
 *            (`odometerCeiling` above). Above it means the client invented kilometres.
 */
export function diffOdometerParity(modules, rows) {
  if (!modules.odometer) return null;
  const derived = modules.odometer.deriveOdometer({
    ledger: rows.ledger,
    trips: rows.trips,
    fuelPayments: rows.fuelPayments,
  });
  const value = Number(derived.confirmed.value);
  const floor = Number(rows.ledger?.max_handover_odometer ?? 0);
  const ceiling = Number(rows.odometerCeiling ?? 0);
  const problems = [];
  if (value < floor) problems.push(`derived odometer ${value} is below ledgers.max_handover_odometer ${floor}`);
  if (value > ceiling) problems.push(`derived odometer ${value} is above the greatest source ${ceiling}`);
  return { problems, value, source: derived.confirmed.source, floor, ceiling };
}

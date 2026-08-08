// The invariant oracle (GV-471).
//
// The tick loop can only see what the database TOLD it: an RPC returned, or it raised.
// That catches crashes and unclassified rejections, and misses the whole interesting
// class — the write that SUCCEEDS and leaves the data wrong. This module is the other
// half: every --oracle-every ticks it stops the world and asks seven questions of the
// database itself, with no claims set (which is operator context, per
// public.is_operator_context) except where the question IS about RLS.
//
// Each invariant returns one row per workspace, so the dashboard's invariant wall is
// literally this module's output.

import { FEED_VISIBLE_EVENT_TYPES } from "../../ledger-event-visibility.mjs";
import { EVENT_TYPE_EXCLUDE } from "../../load-rehearsal/lib/hotpaths.mjs";
import { lit, claimsFor } from "./db.mjs";

export const INVARIANTS = [
  "zero_sum",
  "closed_fingerprint",
  "handover_mirror",
  "participant_denorm",
  "rls_isolation",
  "event_classification",
  "recurring_integrity",
];

export const INVARIANT_LABELS = {
  zero_sum: "Nulsum pr. periode",
  closed_fingerprint: "Lukket periode uændret",
  handover_mirror: "Overdragelses-spejl (193)",
  participant_denorm: "Deltager-ledger (192)",
  rls_isolation: "RLS-isolation",
  event_classification: "Hændelser klassificeret",
  recurring_integrity: "Faste udgifter unikke",
};

// ── 1. Zero sum ──────────────────────────────────────────────────────────────
//
// TOLERANCE, and why it is not zero. Expenses, repairs and crossings each run a
// largest-remainder integer-øre split, so those three sum EXACTLY. The fuel share does
// not: tripCost is `round(km * (totalPaid / totalKm), 2)` per member, an independent
// rounding per person, so the sum of the tripCosts can miss totalPaid by up to half an
// øre per member. The function's own comments call netting to zero the goal (the
// crossing CTE skips a trip with no assignees precisely "so the period still nets to
// zero"), so a non-zero residue is expected only within that rounding bound. Anything
// beyond n × 0,005 kr is arithmetic that lost money, and is a violation.
async function zeroSum(db, ws) {
  const payload = await db.json(
    `select coalesce(jsonb_agg(jsonb_build_object(
              'period', sp.id, 'status', sp.status,
              'people', coalesce(jsonb_array_length(calc.payload -> 'people'), 0),
              'net_sum', coalesce((select sum((p ->> 'net')::numeric)
                                     from jsonb_array_elements(calc.payload -> 'people') p), 0))), '[]'::jsonb)
       from public.settlement_periods sp
       cross join lateral (select public.calculate_period_settlement(sp.ledger_id, sp.id) as payload) calc
      where sp.ledger_id = ${lit(ws.ledgerId)}
        and sp.status in ('open', 'queued');`,
    "oracle zero_sum",
  );
  const bad = [];
  let maxDust = 0;
  for (const row of payload) {
    const netSum = Number(row.net_sum);
    const tolerance = Number(row.people) * 0.005;
    maxDust = Math.max(maxDust, Math.abs(netSum));
    if (Math.abs(netSum) > tolerance + 1e-9) {
      bad.push({ period: row.period, status: row.status, netSum, tolerance, people: row.people });
    }
  }
  return {
    ok: bad.length === 0,
    detail: bad.length > 0
      ? { failed: bad }
      : { periods: payload.length, maxResidueKr: Math.round(maxDust * 100) / 100 },
  };
}

// ── 2. Closed-period immutability ────────────────────────────────────────────
//
// The close STORES the server's entryFingerprint in snapshot_json. Recomputing it now
// and finding it changed means an entry moved inside a closed period — the exact thing
// the settlement-entry lock exists to prevent, and the one corruption that would never
// surface as an error to any caller.
async function closedFingerprint(db, ws) {
  const payload = await db.json(
    `select coalesce(jsonb_agg(jsonb_build_object(
              'period', sp.id,
              'stored', sp.snapshot_json ->> 'entryFingerprint',
              'recomputed', public.calculate_period_entry_fingerprint(sp.ledger_id, sp.id))), '[]'::jsonb)
       from public.settlement_periods sp
      where sp.ledger_id = ${lit(ws.ledgerId)}
        and sp.status = 'closed'
        and sp.snapshot_json ->> 'entryFingerprint' is not null;`,
    "oracle closed_fingerprint",
  );
  const bad = payload.filter((row) => row.stored !== row.recomputed);
  return {
    ok: bad.length === 0,
    detail: bad.length > 0 ? { failed: bad } : { closedPeriods: payload.length },
  };
}

// ── 3. Migration 193's handover mirror ───────────────────────────────────────
//
// max_handover_odometer is MONOTONE by design (an edited-down or deleted handover does
// not retract a reading that was made), so the assertion is `>= the table's max`, never
// `=`. The fraction pair is a plain recompute and must match exactly — including after
// migration 189's restamp moves an observed_at, which is what makes this worth checking
// on a fuzzer that edits booking windows.
async function handoverMirror(db, ws) {
  const payload = await db.json(
    `select jsonb_build_object(
              'mirror_odo', l.max_handover_odometer,
              'table_odo', (select max(h.end_odometer) from public.booking_handovers h where h.ledger_id = l.id),
              'mirror_fraction', l.latest_handover_fraction,
              'mirror_observed_at', l.latest_handover_observed_at,
              'fresh', (select jsonb_build_object('fraction', h.fuel_fraction, 'observed_at', h.observed_at)
                          from public.booking_handovers h
                         where h.ledger_id = l.id and h.fuel_fraction is not null
                         order by h.observed_at desc, h.id desc
                         limit 1))
       from public.ledgers l
      where l.id = ${lit(ws.ledgerId)};`,
    "oracle handover_mirror",
  );
  const problems = [];
  const tableOdo = payload.table_odo === null ? null : Number(payload.table_odo);
  const mirrorOdo = payload.mirror_odo === null ? null : Number(payload.mirror_odo);
  if (tableOdo !== null && (mirrorOdo === null || mirrorOdo < tableOdo)) {
    problems.push(`max_handover_odometer ${mirrorOdo} is below the table maximum ${tableOdo}`);
  }
  const freshFraction = payload.fresh?.fraction ?? null;
  const freshObserved = payload.fresh?.observed_at ?? null;
  if (numeq(payload.mirror_fraction, freshFraction) === false) {
    problems.push(`latest_handover_fraction ${payload.mirror_fraction} != recompute ${freshFraction}`);
  }
  if (String(payload.mirror_observed_at ?? "") !== String(freshObserved ?? "")) {
    problems.push(`latest_handover_observed_at ${payload.mirror_observed_at} != recompute ${freshObserved}`);
  }
  return { ok: problems.length === 0, detail: problems.length > 0 ? { problems, payload } : { mirrorOdo, tableOdo } };
}

function numeq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

// ── 4. Migration 192's denormalised ledger_id ────────────────────────────────
//
// The read policy on trip_participants now answers from the row itself. If the stamping
// trigger ever missed a write, that row is either invisible to its own workspace or —
// far worse — visible to another one.
async function participantDenorm(db, ws) {
  const payload = await db.json(
    `select jsonb_build_object(
              'rows', count(*),
              'mismatched', count(*) filter (where tp.ledger_id is distinct from t.ledger_id))
       from public.trip_participants tp
       join public.trips t on t.id = tp.trip_id
      where t.ledger_id = ${lit(ws.ledgerId)};`,
    "oracle participant_denorm",
  );
  return {
    ok: Number(payload.mismatched) === 0,
    detail: { rows: Number(payload.rows), mismatched: Number(payload.mismatched) },
  };
}

// ── 5. RLS isolation ─────────────────────────────────────────────────────────
//
// Every other invariant runs in operator context, where RLS is irrelevant. This one is
// the opposite: a real member of workspace A, as role `authenticated`, counting rows
// that belong to workspace B across every table that carries workspace data. The answer
// must be 0 everywhere, table by table — a single number would hide which table leaked.
const ISOLATION_TABLES = [
  "trips",
  "fuel_payments",
  "workspace_expenses",
  "car_bookings",
  "booking_handovers",
  "ledger_events",
  "settlement_periods",
  "settlement_requests",
  "vehicle_repairs",
  "messages",
  "recurring_expenses",
];

async function rlsIsolation(db, ws, other) {
  if (!other) return { ok: true, detail: { skipped: "single-workspace run" } };
  const member = ws.members.find((m) => m.active) ?? ws.members[0];
  const counts = ISOLATION_TABLES
    .map((table) => `'${table}', (select count(*) from public.${table} where ledger_id = ${lit(other.ledgerId)})`)
    .join(",\n              ");
  const sql = [
    "begin;",
    `do $simclaims$ begin perform set_config('request.jwt.claims', ${lit(claimsFor(member))}, true); end $simclaims$;`,
    "set local role authenticated;",
    `select jsonb_build_object(\n              ${counts});`,
    "commit;",
  ].join("\n");
  const res = await db.send(sql);
  if (res.stderr) {
    return { ok: false, detail: { error: res.stderr.slice(0, 800), foreignWorkspace: other.index } };
  }
  const payload = JSON.parse(res.lines[0]);
  const leaked = Object.entries(payload).filter(([, count]) => Number(count) !== 0);
  return {
    ok: leaked.length === 0,
    detail: leaked.length > 0
      ? { foreignWorkspace: other.index, leaked: Object.fromEntries(leaked) }
      : { foreignWorkspace: other.index, tables: ISOLATION_TABLES.length },
  };
}

// ── 6. Event classification ──────────────────────────────────────────────────
//
// GV-413's rule, asserted against rows that a RUN actually wrote rather than against
// the SQL that could write them: the mobile Activity feed has no allow-list, so an
// event_type in neither register is a row every member sees with no client change.
const CLASSIFIED = new Set([...FEED_VISIBLE_EVENT_TYPES, ...EVENT_TYPE_EXCLUDE]);

async function eventClassification(db, ws) {
  const payload = await db.json(
    `select coalesce(jsonb_agg(distinct e.event_type), '[]'::jsonb)
       from public.ledger_events e
      where e.ledger_id = ${lit(ws.ledgerId)};`,
    "oracle event_classification",
  );
  const unknown = payload.filter((type) => !CLASSIFIED.has(type));
  return {
    ok: unknown.length === 0,
    detail: unknown.length > 0 ? { unknown } : { distinctTypes: payload.length },
  };
}

// ── 7. Recurring materialisation ─────────────────────────────────────────────
//
// One row per (template, occurrence), backed by workspace_expenses_recurrence_uq. Both
// halves are checked: the duplicate count AND that the index is still there — a
// duplicate can only appear if the index went away, and a guard that only counts
// duplicates would pass a schema that had quietly dropped its own protection.
async function recurringIntegrity(db, ws) {
  const payload = await db.json(
    `select jsonb_build_object(
              'duplicates', (select count(*) from (
                 select we.recurring_expense_id, we.occurrence_date
                   from public.workspace_expenses we
                  where we.ledger_id = ${lit(ws.ledgerId)}
                    and we.recurring_expense_id is not null
                  group by 1, 2 having count(*) > 1) d),
              'index_present', exists (
                 select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'workspace_expenses_recurrence_uq'),
              'generated', (select count(*) from public.workspace_expenses we
                             where we.ledger_id = ${lit(ws.ledgerId)}
                               and we.recurring_expense_id is not null));`,
    "oracle recurring_integrity",
  );
  const ok = Number(payload.duplicates) === 0 && payload.index_present === true;
  return { ok, detail: payload };
}

/**
 * Run every invariant against every workspace.
 *
 * Returns [{ invariant, ws, ok, detail }]. The caller journals them and turns the
 * failures into violations; nothing here writes or exits.
 */
export async function runOracle(db, workspaces) {
  const results = [];
  for (let i = 0; i < workspaces.length; i += 1) {
    const ws = workspaces[i];
    const other = workspaces.length > 1 ? workspaces[(i + 1) % workspaces.length] : null;
    const checks = [
      ["zero_sum", () => zeroSum(db, ws)],
      ["closed_fingerprint", () => closedFingerprint(db, ws)],
      ["handover_mirror", () => handoverMirror(db, ws)],
      ["participant_denorm", () => participantDenorm(db, ws)],
      ["rls_isolation", () => rlsIsolation(db, ws, other)],
      ["event_classification", () => eventClassification(db, ws)],
      ["recurring_integrity", () => recurringIntegrity(db, ws)],
    ];
    for (const [invariant, run] of checks) {
      try {
        const outcome = await run();
        results.push({ invariant, ws: ws.index, ok: outcome.ok, detail: outcome.detail });
      } catch (err) {
        results.push({ invariant, ws: ws.index, ok: false, detail: { threw: String(err.message).slice(0, 800) } });
      }
    }
  }
  return results;
}

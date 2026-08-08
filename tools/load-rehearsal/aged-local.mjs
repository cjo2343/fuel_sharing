// GV-438 — load exercise 2: the AGED workspace, measured locally.
//
//   npm run load:aged -- [--seed 42] [--small 3] [--aged-periods 12]
//                        [--aged-trips 200] [--aged-messages 150] [--iters 25]
//                        [--keep] [--dry-run]
//
// GVM-533 proved throughput (326 req/s, zero errors) but its fixture was 12 SMALL
// workspaces with ~10 trips each and — because the seeder's close step always
// raised 42501 — ZERO closed periods. So it could not answer the question the
// external review actually asked, and GVM-535 inherited: the mobile client's
// workspace load is a fan-out of UNBOUNDED selects, and the activity feed and the
// history reads grow with TIME rather than with group size. At what history size
// does that start to hurt, what fetch cap makes sense, and would an index help?
//
// This harness answers it. On a disposable Postgres 17 container (the canonical
// replay image) it seeds ONE aged workspace — years of history, thousands of trips
// and messages, a closed period per month — through the SAME production RPCs a
// client calls, impersonating members with request.jwt.claims. Then it measures the
// gateway's own reads (translated from lib/hotpaths.mjs, so they stay the mirror)
// as role `authenticated` with RLS applied, at checkpoints as the history grows,
// and finally EXPLAINs the two reads that matter.
//
// Server-side execution time only — no PostgREST, no network. The absolute numbers
// are therefore NOT comparable with GVM-533's end-to-end ones; the scaling curve is
// the evidence. See docs/operations/load-rehearsal-evidence.md.
//
// There is no --env and no URL: the only database this can reach is the container
// it starts itself, so it cannot touch production by construction.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { parseArgs, percentile, DEFAULT_EMAIL_DOMAIN } from "./lib/common.mjs";
import {
  buildFixturePlan,
  buildCloseProgram,
  AGED_DEFAULTS,
  tripArgs,
  fuelArgs,
  bookingArgs,
  expenseArgs,
  recurringArgs,
  messageArgs,
} from "./lib/fixtures.mjs";
import { ledgerReadRequests, tripParticipantsRequest, EVENT_TYPE_EXCLUDE } from "./lib/hotpaths.mjs";
import { postgrestToSql, withLimit } from "./lib/hotpaths-sql.mjs";
import {
  bootDatabase,
  exec,
  queryLines,
  queryValue,
  queryJson,
  jsonLiteral,
  claimsFor,
  setClaimsSql,
  removeContainer,
} from "./lib/pg-local.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = parseArgs(process.argv.slice(2), { flags: ["keep", "dry-run"] });
const seed = Number(args.seed ?? 42);
const smallWorkspaces = Number(args.small ?? 3);
const iters = Number(args.iters ?? 25);
const keep = Boolean(args.keep);
const dryRun = Boolean(args["dry-run"]);
const outPath = args.out ?? null;
const DB = "loadrehearsal";
// Iterations discarded per read before percentiles — the first executions pay for
// plan caching and cold shared buffers, which is not what a steady-state client sees.
const WARMUP = 3;
const CONTAINER = `govehlo-load-aged-${process.pid}`;

const agedCfg = {
  members: Number(args["aged-members"] ?? AGED_DEFAULTS.members),
  periods: Number(args["aged-periods"] ?? AGED_DEFAULTS.periods),
  tripsPerPeriod: Number(args["aged-trips"] ?? AGED_DEFAULTS.tripsPerPeriod),
  fuelPerPeriod: Number(args["aged-fuel"] ?? AGED_DEFAULTS.fuelPerPeriod),
  messagesPerPeriod: Number(args["aged-messages"] ?? AGED_DEFAULTS.messagesPerPeriod),
};

const plan = buildFixturePlan({
  seed,
  workspaces: smallWorkspaces,
  emailDomain: DEFAULT_EMAIL_DOMAIN,
  aged: agedCfg,
});

// A deterministic synthetic auth id per user index (the container has no GoTrue).
function subFor(userIndex) {
  return `00000000-0000-4000-8000-${String(userIndex).padStart(12, "0")}`;
}

const CANDIDATE_INDEXES = [
  {
    name: "ledger_events_feed_idx",
    // The feed read's ORDER BY matches ledger_events_ledger_created_idx, but its
    // event_type exclusion does not, so the planner reads every event row for the
    // workspace and top-N sorts. A partial index whose predicate IS the gateway's
    // filter lets it walk the index in order and stop at the limit.
    ddl: `create index ledger_events_feed_idx on public.ledger_events (ledger_id, created_at desc)
          where event_type not in (${EVENT_TYPE_EXCLUDE.map((t) => `'${t}'`).join(", ")});`,
    targets: ["read:events"],
  },
  // trips_ledger_trip_date_idx graduated from candidate to schema (migration 190,
  // GV-438 → PR #265): it now arrives with supabase-schema.sql, so the baseline
  // numbers already include it and re-creating it here would collide.
  {
    name: "fuel_payments_ledger_payment_date_idx",
    ddl: `create index fuel_payments_ledger_payment_date_idx on public.fuel_payments (ledger_id, payment_date desc)
          where deleted_at is null;`,
    targets: ["read:fuel"],
  },
  {
    name: "settlement_periods_ledger_opened_idx",
    // settlement_periods has no ledger_id index at all: the history read is a Seq
    // Scan whose RLS predicate is evaluated per row of the WHOLE table, so its cost
    // grows with the number of workspaces on the platform, not with this workspace.
    ddl: `create index settlement_periods_ledger_opened_idx on public.settlement_periods (ledger_id, opened_at desc);`,
    targets: ["read:periods"],
  },
];

if (dryRun) {
  printDryRun();
  process.exit(0);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`❌ Aged local run failed: ${err.stack || err.message}`);
  exitCode = 1;
} finally {
  if (keep) {
    console.log(`ℹ️  --keep: container ${CONTAINER} left running (psql: docker exec -it ${CONTAINER} psql -U postgres -d ${DB}).`);
  } else {
    removeContainer(CONTAINER);
  }
}
process.exit(exitCode);

async function main() {
  const evidence = { seed, aged: agedCfg, smallWorkspaces, iters, checkpoints: [], final: null, explain: {} };

  console.log(`⏳ Booting disposable Postgres + applying supabase-schema.sql (fresh-install validation)…`);
  const schemaSeconds = bootDatabase({ container: CONTAINER, repoDir: REPO, db: DB });
  evidence.schemaApplySeconds = Number(schemaSeconds.toFixed(1));
  console.log(`   schema applied cleanly in ${schemaSeconds.toFixed(1)}s.`);

  createAuthUsers();

  const agedPlan = plan.workspaces.find((ws) => ws.aged);
  for (const ws of plan.workspaces) {
    const started = Date.now();
    const isAged = Boolean(ws.aged);
    console.log(`⏳ Seeding ${isAged ? "AGED " : ""}workspace "${ws.name}" (${ws.memberCount} members, ${ws.periods.length} period(s))…`);
    await seedWorkspace(ws, { evidence, measureCheckpoints: isAged });
    console.log(`   done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  }

  // ── Final measurement against the aged workspace ──────────────────────────
  const ledgerId = ledgerIdOf(agedPlan.workspaceIndex);
  const owner = identity(agedPlan, 0);
  analyzeDatabase();
  evidence.final = {
    counts: countsFor(ledgerId),
    reads: measureReads(ledgerId, owner, { iters, includeVariants: true }),
  };
  evidence.explain = {
    "read:events": explainRead(ledgerId, owner, "read:events"),
    "read:messages": explainRead(ledgerId, owner, "read:messages"),
    "read:trips": explainRead(ledgerId, owner, "read:trips"),
    "read:periods": explainRead(ledgerId, owner, "read:periods"),
    "read:participants": explainRead(ledgerId, owner, "read:participants"),
  };
  evidence.indexes = indexesOn(["ledger_events", "messages", "trips", "settlement_periods", "trip_participants", "fuel_payments"]);
  evidence.withCandidateIndexes = probeCandidateIndexes(ledgerId, owner);

  printEvidence(evidence);
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`ℹ️  Wrote machine-readable evidence to ${outPath}`);
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

// Auth users are the one object with no production RPC (the hosted seeder uses the
// Auth admin API for exactly the same reason). Everything else below goes through
// the real RPCs.
function createAuthUsers() {
  const rows = plan.users.map((u) => ({ id: subFor(u.index), email: u.email }));
  exec(
    CONTAINER,
    DB,
    `insert into auth.users (id, email)
     select (r->>'id')::uuid, r->>'email'
     from jsonb_array_elements(${jsonLiteral(rows)}::jsonb) as r
     on conflict (id) do nothing;`,
    "create auth users",
  );
  console.log(`   auth users: ${rows.length} synthetic identities.`);
}

function identity(ws, slot) {
  const member = ws.members[slot];
  return { sub: subFor(member.userIndex), email: member.email, name: member.name };
}

function ledgerIdOf(workspaceIndex) {
  return queryValue(
    CONTAINER,
    DB,
    `select v from public.load_rehearsal_state where k = 'ws:${workspaceIndex}:ledger';`,
    "read ledger id",
  );
}

async function seedWorkspace(ws, { evidence, measureCheckpoints }) {
  // 1. Owner creates the workspace, everyone else joins through redeem_ledger_invite.
  const onboarding = {
    workspaceIndex: ws.workspaceIndex,
    name: ws.name,
    owner: { ...identity(ws, 0), slot: 0 },
    joiners: ws.members.slice(1).map((m) => ({ ...identity(ws, m.slot), slot: m.slot, displayName: m.name })),
  };
  exec(CONTAINER, DB, onboardingSql(onboarding), `onboarding ${ws.name}`);

  const ledgerId = ledgerIdOf(ws.workspaceIndex);
  const memberIds = new Map(
    queryLines(
      CONTAINER,
      DB,
      `select slot, member_id from public.load_rehearsal_members where workspace_index = ${ws.workspaceIndex} order by slot;`,
      "read member ids",
    ).map((line) => {
      const [slot, memberId] = line.split("\t");
      return [Number(slot), memberId];
    }),
  );

  const owner = identity(ws, 0);

  for (let p = 0; p < ws.periods.length; p++) {
    const period = ws.periods[p];
    const openPeriodId = openPeriodOf(ledgerId);
    if (!openPeriodId) throw new Error(`${ws.name}: no open settlement period`);

    const entries = [];
    period.trips.forEach((trip, t) => {
      const driverMemberId = memberIds.get(trip.driverSlot);
      const participantMemberIds = [...new Set(trip.participantSlots.map((s) => memberIds.get(s)).filter(Boolean))];
      entries.push({
        kind: "trip",
        claims: claimsFor(identity(ws, trip.driverSlot)),
        args: tripArgs({
          ledgerId,
          openPeriodId,
          legacyId: `s${seed}-w${ws.workspaceIndex}-p${p}-t${t}`,
          driverMemberId,
          participantMemberIds,
          trip,
        }),
      });
    });
    period.fuel.forEach((fuel, f) => {
      entries.push({
        kind: "fuel",
        claims: claimsFor(identity(ws, fuel.payerSlot)),
        args: fuelArgs({
          ledgerId,
          openPeriodId,
          legacyId: `s${seed}-w${ws.workspaceIndex}-p${p}-f${f}`,
          payerMemberId: memberIds.get(fuel.payerSlot),
          fuel,
        }),
      });
    });
    for (const expense of period.expenses) {
      entries.push({
        kind: "expense",
        claims: claimsFor(owner),
        args: expenseArgs({
          ledgerId,
          openPeriodId,
          paidByMemberId: memberIds.get(expense.paidBySlot) ?? memberIds.get(0),
          expense,
        }),
      });
    }
    for (const message of period.messages ?? []) {
      entries.push({
        kind: "message",
        claims: claimsFor(identity(ws, message.senderSlot)),
        args: messageArgs({ ledgerId, message }),
      });
    }

    runEntries(entries, `${ws.name} period ${p + 1}/${ws.periods.length}`);

    if (period.closeAfter) {
      closePeriod(ledgerId, openPeriodId, owner, `${ws.name} period ${p + 1}`);
    }

    if (measureCheckpoints) {
      analyzeDatabase();
      const counts = countsFor(ledgerId);
      const reads = measureReads(ledgerId, owner, { iters: Math.max(8, Math.round(iters / 2)) });
      evidence.checkpoints.push({ period: p + 1, counts, reads });
      console.log(
        `   checkpoint ${p + 1}: ${counts.trips} trips, ${counts.events} events, ${counts.messages} messages, ` +
          `${counts.closedPeriods} closed periods → feed p95 ${pick(reads, "read:events").p95} ms, ` +
          `trips p95 ${pick(reads, "read:trips").p95} ms, history p95 ${pick(reads, "read:periods").p95} ms`,
      );
    }
  }

  // Standing costs + bookings, exactly as the hosted seeder orders them.
  const tail = [];
  for (const recurring of ws.recurring) {
    tail.push({
      kind: "recurring",
      claims: claimsFor(owner),
      args: recurringArgs({ ledgerId, paidByMemberId: memberIds.get(0), recurring }),
    });
  }
  ws.bookings.forEach((booking, b) => {
    tail.push({
      kind: "booking",
      claims: claimsFor(identity(ws, booking.memberSlot)),
      args: bookingArgs({
        ledgerId,
        legacyId: `s${seed}-w${ws.workspaceIndex}-b${b}`,
        bookingMemberId: memberIds.get(booking.memberSlot),
        booking,
      }),
    });
  });
  for (const message of ws.messages) {
    tail.push({
      kind: "message",
      claims: claimsFor(identity(ws, message.senderSlot)),
      args: messageArgs({ ledgerId, message }),
    });
  }
  runEntries(tail, `${ws.name} standing costs + bookings`);
}

function openPeriodOf(ledgerId) {
  return queryValue(
    CONTAINER,
    DB,
    `select id from public.settlement_periods where ledger_id = '${ledgerId}' and status = 'open' and closed_at is null order by opened_at desc limit 1;`,
    "read open period",
  );
}

// The close sequence, driven by the SHARED buildCloseProgram: request every
// outstanding pair at its current amount, THEN close. Identical to what the hosted
// seeder does over HTTP — see lib/fixtures.mjs for why the request step is not
// optional (42501, the GVM-533 blocker).
function closePeriod(ledgerId, periodId, owner, what) {
  const calc = queryJson(
    CONTAINER,
    DB,
    `${setClaimsSql(owner)}
     select public.calculate_period_settlement('${ledgerId}', '${periodId}'::uuid);`,
    `${what}: calculate_period_settlement`,
  );
  if (!calc) throw new Error(`${what}: calculate_period_settlement returned nothing`);

  const program = buildCloseProgram(calc, { ledgerId, periodId });
  const payload = {
    claims: claimsFor(owner),
    ledgerId,
    periodId,
    requests: program.requests.map((r) => r.args),
    snapshot: program.snapshot,
  };
  exec(CONTAINER, DB, closeSql(payload), `${what}: close`);
}

// One psql round trip per batch: a PL/pgSQL loop over the batch's JSON that sets
// each entry's JWT claims and calls the same RPC the mobile app calls.
function runEntries(entries, what) {
  if (entries.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    exec(CONTAINER, DB, entriesSql(entries.slice(i, i + CHUNK)), `${what} [${i + 1}..${Math.min(i + CHUNK, entries.length)}]`);
  }
}

function entriesSql(entries) {
  return `
do $$
declare
  v_batch jsonb := ${jsonLiteral(entries)}::jsonb;
  e jsonb;
  a jsonb;
begin
  for e in select value from jsonb_array_elements(v_batch) loop
    perform set_config('request.jwt.claims', e->>'claims', false);
    a := e->'args';
    case e->>'kind'
      when 'trip' then
        perform public.upsert_trip_with_participants(
          target_ledger_id => a->>'target_ledger_id',
          target_open_period_id => (a->>'target_open_period_id')::uuid,
          legacy_trip_id => a->>'legacy_trip_id',
          driver_member_id => (a->>'driver_member_id')::uuid,
          trip_date_value => (a->>'trip_date_value')::date,
          start_km_value => (a->>'start_km_value')::numeric,
          end_km_value => (a->>'end_km_value')::numeric,
          note_value => a->>'note_value',
          participant_member_ids => (select coalesce(array_agg(x::uuid), array[]::uuid[]) from jsonb_array_elements_text(a->'participant_member_ids') x),
          event_title => a->>'event_title',
          event_body => a->>'event_body');
      when 'fuel' then
        perform public.upsert_fuel_payment(
          target_ledger_id => a->>'target_ledger_id',
          target_open_period_id => (a->>'target_open_period_id')::uuid,
          legacy_fuel_id => a->>'legacy_fuel_id',
          payer_member_id => (a->>'payer_member_id')::uuid,
          payment_date_value => (a->>'payment_date_value')::date,
          amount_value => (a->>'amount_value')::numeric,
          currency_value => a->>'currency_value',
          liters_value => (a->>'liters_value')::numeric,
          price_per_liter_value => (a->>'price_per_liter_value')::numeric,
          odometer_value => (a->>'odometer_value')::numeric,
          station_name_value => a->>'station_name_value',
          station_brand_value => a->>'station_brand_value',
          full_tank_value => (a->>'full_tank_value')::boolean,
          event_title => a->>'event_title',
          event_body => a->>'event_body');
      when 'expense' then
        perform public.upsert_workspace_expense(
          target_ledger_id => a->>'target_ledger_id',
          target_open_period_id => (a->>'target_open_period_id')::uuid,
          expense_id_value => null,
          category_value => a->>'category_value',
          description_value => a->>'description_value',
          amount_value => (a->>'amount_value')::numeric,
          expense_date_value => (a->>'expense_date_value')::date,
          split_rule_value => a->>'split_rule_value',
          split_config_value => null,
          paid_by_value => (a->>'paid_by_value')::uuid,
          event_title => a->>'event_title',
          event_body => a->>'event_body');
      when 'recurring' then
        perform public.upsert_recurring_expense(
          target_ledger_id => a->>'target_ledger_id',
          recurring_id_value => null,
          category_value => a->>'category_value',
          description_value => a->>'description_value',
          amount_value => (a->>'amount_value')::numeric,
          cadence_value => a->>'cadence_value',
          next_due_date_value => (a->>'next_due_date_value')::date,
          split_rule_value => a->>'split_rule_value',
          split_config_value => null,
          paid_by_value => (a->>'paid_by_value')::uuid,
          is_active_value => (a->>'is_active_value')::boolean,
          event_title => a->>'event_title',
          event_body => a->>'event_body');
      when 'booking' then
        perform public.upsert_car_booking(
          target_ledger_id => a->>'target_ledger_id',
          legacy_booking_id => a->>'legacy_booking_id',
          booking_member_id => (a->>'booking_member_id')::uuid,
          start_at_value => (a->>'start_at_value')::timestamptz,
          end_at_value => (a->>'end_at_value')::timestamptz,
          purpose_value => a->>'purpose_value',
          event_title => a->>'event_title',
          event_body => a->>'event_body',
          fuel_stop_value => null);
      when 'message' then
        perform public.post_message(
          target_ledger_id => a->>'target_ledger_id',
          body_value => a->>'body_value');
      else
        raise exception 'unknown seed entry kind %', e->>'kind';
    end case;
  end loop;
end $$;
`;
}

function onboardingSql(o) {
  return `
do $$
declare
  v jsonb := ${jsonLiteral(o)}::jsonb;
  j jsonb;
  v_ledger text;
  v_admin uuid;
  v_code text;
  v_member uuid;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v->'owner'->>'sub', 'email', v->'owner'->>'email', 'role', 'authenticated')::text, false);

  select w.ledger_id, w.admin_member_id into v_ledger, v_admin
  from public.create_private_ledger_workspace(v->>'name') w;

  insert into public.load_rehearsal_state (k, v)
  values ('ws:' || (v->>'workspaceIndex') || ':ledger', v_ledger)
  on conflict (k) do update set v = excluded.v;

  insert into public.load_rehearsal_members (workspace_index, slot, member_id, sub, email)
  values ((v->>'workspaceIndex')::int, 0, v_admin, (v->'owner'->>'sub')::uuid, v->'owner'->>'email')
  on conflict (workspace_index, slot) do update set member_id = excluded.member_id;

  v_code := public.get_workspace_join_code(v_ledger);

  for j in select value from jsonb_array_elements(v->'joiners') loop
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', j->>'sub', 'email', j->>'email', 'role', 'authenticated')::text, false);
    select r.member_id into v_member
    from public.redeem_ledger_invite(v_code, j->>'displayName') r;
    insert into public.load_rehearsal_members (workspace_index, slot, member_id, sub, email)
    values ((v->>'workspaceIndex')::int, (j->>'slot')::int, v_member, (j->>'sub')::uuid, j->>'email')
    on conflict (workspace_index, slot) do update set member_id = excluded.member_id;
  end loop;
end $$;
`;
}

function closeSql(payload) {
  return `
do $$
declare
  v jsonb := ${jsonLiteral(payload)}::jsonb;
  r jsonb;
begin
  perform set_config('request.jwt.claims', v->>'claims', false);

  -- Every outstanding pair is requested at its CURRENT amount first; the close
  -- gate (42501) rejects the period otherwise.
  for r in select value from jsonb_array_elements(v->'requests') loop
    perform public.upsert_settlement_request_status(
      target_ledger_id => r->>'target_ledger_id',
      target_open_period_id => (r->>'target_open_period_id')::uuid,
      payer_member_id => (r->>'payer_member_id')::uuid,
      recipient_member_id => (r->>'recipient_member_id')::uuid,
      amount_value => (r->>'amount_value')::numeric,
      currency_value => r->>'currency_value',
      next_status => r->>'next_status',
      current_pair_keys => array[]::text[],
      p_note => null);
  end loop;

  perform public.close_settlement_period(v->>'ledgerId', (v->>'periodId')::uuid, v->'snapshot');
end $$;
`;
}

// ── Candidate indexes (PROPOSED, never applied to the product schema) ────────
//
// GV-438 measures these; it does NOT ship them. No migration is written here and
// supabase/migrations + supabase-schema.sql are untouched — the recommendation
// lands in docs/operations/load-rehearsal-evidence.md and the orchestrator decides
// whether a migration follows. They are created ONLY inside the disposable
// container, after the baseline numbers are taken, so the same reads can be
// measured with and without them.

function probeCandidateIndexes(ledgerId, who) {
  console.log("⏳ Probing candidate indexes (container only — nothing is written to the schema)…");
  exec(CONTAINER, DB, CANDIDATE_INDEXES.map((i) => i.ddl).join("\n"), "create candidate indexes");
  analyzeDatabase();
  return {
    candidates: CANDIDATE_INDEXES.map((i) => ({ name: i.name, ddl: i.ddl.replace(/\s+/g, " ").trim(), targets: i.targets })),
    reads: measureReads(ledgerId, who, { iters, includeVariants: true }),
    explain: {
      "read:events": explainRead(ledgerId, who, "read:events"),
      "read:trips": explainRead(ledgerId, who, "read:trips"),
      "read:periods": explainRead(ledgerId, who, "read:periods"),
      "read:participants": explainRead(ledgerId, who, "read:participants"),
    },
  };
}

// Real Postgres autovacuums; a container seeded in 30 seconds has not. Refresh the
// statistics before every measurement round so the plans are the ones a live
// database would choose, not artefacts of a cold catalog.
function analyzeDatabase() {
  exec(CONTAINER, DB, "analyze;", "analyze");
}

// ── Measurement ──────────────────────────────────────────────────────────────

// The gateway's own reads, plus (optionally) capped variants of the ones that grow
// over time — the GVM-535 question expressed as a measurement.
function readSet(ledgerId, { includeVariants = false } = {}) {
  const reads = ledgerReadRequests(ledgerId);
  const tripIds = queryLines(
    CONTAINER,
    DB,
    `select id from public.trips where ledger_id = '${ledgerId}' and deleted_at is null order by trip_date desc limit 200;`,
    "read trip ids",
  );
  const set = [...reads];
  if (tripIds.length > 0) set.push(tripParticipantsRequest(tripIds));
  if (includeVariants) {
    const byLabel = (l) => reads.find((r) => r.label === l);
    set.push(withLimit(byLabel("read:events"), 30));
    set.push(withLimit(byLabel("read:messages"), 50));
    set.push(withLimit(byLabel("read:trips"), 100));
    set.push(withLimit(byLabel("read:periods"), 6));
    set.push(withLimit(byLabel("read:settlements"), 50));
    set.push(withLimit(byLabel("read:bookings"), 50));
    // The dependent participants read is driven by the TRIPS read's id list, so a
    // trips cap halves it for free — measure that rather than assert it.
    if (tripIds.length > 100) {
      set.push({ ...tripParticipantsRequest(tripIds.slice(0, 100)), label: "read:participants@100" });
    }
    // A PROPOSED shape, not the mirror: the same trips read scoped to the open
    // period, which is the only period the settlement split actually needs.
    const openPeriodId = openPeriodOf(ledgerId);
    if (openPeriodId) {
      set.push({
        label: "read:trips@period",
        table: "trips",
        query: `select=*&ledger_id=eq.${encodeURIComponent(ledgerId)}&period_id=eq.${openPeriodId}&deleted_at=is.null&order=trip_date.desc&limit=501`,
      });
    }
  }
  return set;
}

// Every read is executed inside the database as role `authenticated` with the
// member's claims set, so RLS is part of what is measured (it is part of what a
// real request pays for). clock_timestamp() around a plain EXECUTE — the rows are
// produced and discarded, so nothing is optimised away.
function measureReads(ledgerId, who, { iters: n = 25, includeVariants = false } = {}) {
  const set = readSet(ledgerId, { includeVariants });
  const script = [
    setClaimsSql(who),
    `create function pg_temp.measure(p_label text, p_sql text, p_iters int)
     returns table (label text, ms double precision)
     language plpgsql as $fn$
     declare i int; t0 timestamptz;
     begin
       for i in 1..p_iters loop
         t0 := clock_timestamp();
         execute p_sql;
         label := p_label;
         ms := extract(epoch from (clock_timestamp() - t0)) * 1000;
         return next;
       end loop;
     end $fn$;`,
    "set role authenticated;",
    ...set.map((r) => `select * from pg_temp.measure('${r.label}', $measured$${postgrestToSql(r)}$measured$, ${n + WARMUP});`),
    "reset role;",
  ].join("\n");

  const lines = queryLines(CONTAINER, DB, script, "measure reads");
  const byLabel = new Map();
  for (const line of lines) {
    const [label, ms] = line.split("\t");
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(Number(ms));
  }

  const rows = [];
  for (const r of set) {
    const all = byLabel.get(r.label) ?? [];
    const xs = all.slice(WARMUP);
    rows.push({
      label: r.label,
      rows: rowCount(r, who),
      count: xs.length,
      p50: round2(percentile(xs, 50)),
      p95: round2(percentile(xs, 95)),
      p99: round2(percentile(xs, 99)),
      max: round2(xs.length ? Math.max(...xs) : 0),
    });
  }
  return rows;
}

function rowCount(request, who) {
  const value = queryValue(
    CONTAINER,
    DB,
    `${setClaimsSql(who)}
     set role authenticated;
     select count(*) from (${postgrestToSql(request)}) q;
     reset role;`,
    `row count ${request.label}`,
  );
  return Number(value);
}

function explainRead(ledgerId, who, label) {
  const request = readSet(ledgerId, { includeVariants: true }).find((r) => r.label === label);
  if (!request) return null;
  return queryLines(
    CONTAINER,
    DB,
    `${setClaimsSql(who)}
     set role authenticated;
     explain (analyze, buffers, costs off, timing off, summary off) ${postgrestToSql(request)};
     reset role;`,
    `explain ${label}`,
  ).map((l) => {
    // The participants read carries 200 trip ids, so its Index Cond alone is ~8 KB
    // of uuids. Keep the plan readable — the node types and row counts are the
    // evidence, not the literal list.
    const line = l.trim();
    return line.length > 200 ? `${line.slice(0, 200)}… [truncated]` : line;
  });
}

function indexesOn(tables) {
  const list = tables.map((t) => `'${t}'`).join(", ");
  return queryLines(
    CONTAINER,
    DB,
    `select tablename || ' :: ' || indexdef from pg_indexes where schemaname = 'public' and tablename in (${list}) order by tablename, indexname;`,
    "read indexes",
  );
}

function countsFor(ledgerId) {
  const line = queryLines(
    CONTAINER,
    DB,
    `select (select count(*) from public.trips where ledger_id = '${ledgerId}'),
            (select count(*) from public.ledger_events where ledger_id = '${ledgerId}'),
            (select count(*) from public.messages where ledger_id = '${ledgerId}'),
            (select count(*) from public.settlement_periods where ledger_id = '${ledgerId}' and status = 'closed'),
            (select count(*) from public.settlement_requests where ledger_id = '${ledgerId}'),
            (select count(*) from public.fuel_payments where ledger_id = '${ledgerId}'),
            (select count(*) from public.car_bookings where ledger_id = '${ledgerId}');`,
    "counts",
  )[0].split("\t");
  return {
    trips: Number(line[0]),
    events: Number(line[1]),
    messages: Number(line[2]),
    closedPeriods: Number(line[3]),
    settlementRequests: Number(line[4]),
    fuel: Number(line[5]),
    bookings: Number(line[6]),
  };
}

function pick(reads, label) {
  return reads.find((r) => r.label === label) ?? { p50: 0, p95: 0 };
}

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

// ── Evidence block ───────────────────────────────────────────────────────────
function printEvidence(evidence) {
  const c = evidence.final.counts;
  console.log("");
  console.log("── Load exercise 2 — aged workspace (GV-438) ───────────────");
  console.log(`  harness:     disposable Postgres 17 (server-side execution time; no PostgREST, no network)`);
  console.log(`  schema:      supabase-schema.sql applied cleanly in ${evidence.schemaApplySeconds}s`);
  console.log(`  fixture:     ${evidence.smallWorkspaces} small workspaces + 1 AGED workspace (seed=${evidence.seed})`);
  console.log(`  aged size:   ${c.trips} trips, ${c.events} ledger_events, ${c.messages} messages, ${c.fuel} fuel, ${c.bookings} bookings`);
  console.log(`               ${c.closedPeriods} CLOSED periods, ${c.settlementRequests} settlement requests`);
  console.log("");
  console.log(`  Per-read latency, RLS applied, ${evidence.iters} iterations each (ms):`);
  console.log("  endpoint                          rows      p50      p95      p99      max");
  console.log("  ----------------------------------------------------------------------------");
  for (const r of evidence.final.reads) {
    console.log(
      `  ${r.label.padEnd(32)} ${String(r.rows).padStart(5)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.max).padStart(8)}`,
    );
  }
  console.log("");
  console.log("  Growth curve (per checkpoint — one closed period each):");
  console.log("  events  msgs  trips  closed |  feed p95   trips p95  history p95  msgs p95");
  console.log("  ----------------------------------------------------------------------------");
  for (const cp of evidence.checkpoints) {
    console.log(
      `  ${String(cp.counts.events).padStart(6)} ${String(cp.counts.messages).padStart(5)} ${String(cp.counts.trips).padStart(6)} ${String(cp.counts.closedPeriods).padStart(7)} | ` +
        `${String(pick(cp.reads, "read:events").p95).padStart(9)} ${String(pick(cp.reads, "read:trips").p95).padStart(11)} ${String(pick(cp.reads, "read:periods").p95).padStart(12)} ${String(pick(cp.reads, "read:messages").p95).padStart(9)}`,
    );
  }
  console.log("");
  for (const [label, lines] of Object.entries(evidence.explain)) {
    if (!lines) continue;
    console.log(`  EXPLAIN ${label}:`);
    for (const l of lines) console.log(`     ${l}`);
  }
  console.log("");
  console.log("  Candidate indexes — PROPOSED ONLY, created in the container after the numbers above:");
  for (const c of evidence.withCandidateIndexes.candidates) {
    console.log(`     ${c.name}`);
    console.log(`       ${c.ddl}`);
  }
  console.log("");
  console.log("  Same reads WITH the candidate indexes (ms):");
  console.log("  endpoint                          rows      p50      p95   Δp95 vs baseline");
  console.log("  ----------------------------------------------------------------------------");
  for (const r of evidence.withCandidateIndexes.reads) {
    const before = evidence.final.reads.find((b) => b.label === r.label);
    const delta = before ? `${round2(r.p95 - before.p95)} (${before.p95} → ${r.p95})` : "";
    console.log(`  ${r.label.padEnd(32)} ${String(r.rows).padStart(5)} ${String(r.p50).padStart(8)} ${String(r.p95).padStart(8)}   ${delta}`);
  }
  console.log("");
  for (const [label, lines] of Object.entries(evidence.withCandidateIndexes.explain)) {
    if (!lines) continue;
    console.log(`  EXPLAIN ${label} (with candidate indexes):`);
    for (const l of lines) console.log(`     ${l}`);
  }
  console.log("");
  console.log("  Indexes present on the measured tables (baseline, before the candidates):");
  for (const i of evidence.indexes) console.log(`     ${i}`);
  console.log("────────────────────────────────────────────────────────────");
}

// ── Dry run ──────────────────────────────────────────────────────────────────
function printDryRun() {
  const aged = plan.workspaces.find((ws) => ws.aged);
  const trips = aged.periods.reduce((n, p) => n + p.trips.length, 0);
  const messages = aged.periods.reduce((n, p) => n + (p.messages ?? []).length, 0);
  console.log("── load:aged --dry-run (no Docker, no network) ─────────────");
  console.log(`  seed=${seed}  small=${smallWorkspaces}  iters=${iters}`);
  console.log(`  aged workspace "${aged.name}": ${aged.memberCount} members, ${aged.periods.length} periods ` +
    `(${aged.periods.filter((p) => p.closeAfter).length} closed via request-then-close), ${trips} trips, ${messages} messages, ` +
    `${aged.periods.reduce((n, p) => n + p.fuel.length, 0)} fuel, ${aged.bookings.length} bookings`);
  console.log("");
  console.log("  Reads measured (translated from lib/hotpaths.mjs — the gateway mirror):");
  for (const r of ledgerReadRequests("<aged-slug>")) {
    console.log(`   • ${r.label.padEnd(18)} ${postgrestToSql(r)}`);
  }
  console.log("");
  console.log("  Capped variants measured alongside them (the GVM-535 question):");
  const reads = ledgerReadRequests("<aged-slug>");
  for (const [label, limit] of [["read:events", 30], ["read:messages", 50], ["read:trips", 100], ["read:periods", 6], ["read:settlements", 50], ["read:bookings", 50]]) {
    console.log(`   • ${`${label}@${limit}`.padEnd(21)} ${postgrestToSql(withLimit(reads.find((r) => r.label === label), limit))}`);
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("Dry run only — no container was started.");
}

// GV-317 load rehearsal — step 2: seed the fixture.
//
//   npm run load:seed -- --env /path/to/rehearsal.env [--seed 42] [--workspaces 20]
//                        [--concurrency 4] [--aged] [--dry-run]
//                        [--signin-budget 30] [--signin-window 300]
//                        [--state ~/.vehloshare-rehearsal-seed-state.json]
//                        [--ignore-state]
//
// Creates ~100 auth users and ~20 workspaces (2–8 members each) of synthetic
// Danish fixture data on the THROWAWAY project, then fills each workspace with
// trips (odometer chains), fuel payments, a couple of recurring + one-off
// expenses, bookings, chat messages, and — for roughly every third workspace — a
// CLOSED settlement period via the real close RPC so settlement math has history.
//
// Seeding strategy (which write path per object, and why):
//   • auth users            — Auth admin REST API (service role). No production
//                             equivalent exists; this is the only way to mint users.
//   • workspace creation     — PRODUCTION flow: the owner signs in (password grant)
//                             and calls create_private_ledger_workspace as themselves.
//   • memberships (join)     — PRODUCTION flow: each member signs in and calls
//                             redeem_ledger_invite with the owner's join code, exactly
//                             like onboarding. (No direct ledger_members inserts.)
//   • trips / fuel / bookings/
//     expenses / recurring /
//     messages               — PRODUCTION flow: the acting member calls the same
//                             transactional RPCs the mobile app uses.
//   • closed periods         — PRODUCTION flow: calculate_period_settlement (server)
//                             → build the matching snapshot → REQUEST every outstanding
//                             pair at its current amount (upsert_settlement_request_status)
//                             → close_settlement_period. The request step is not optional:
//                             the close gate raises 42501 without it (GV-438; it is why the
//                             GVM-533 rehearsal reported `periods closed: 0`).
//
// Every object is created through the real RPCs a client would call — no
// service-role table inserts were needed, so RLS + business rules are exercised
// end to end. The only service-role use is minting the auth users.
//
// Deterministic (`--seed`) and resumable: re-running skips already-created users
// and recovers existing workspaces/memberships via list_my_ledgers, so a run
// interrupted by a rate-limit can be resumed. Concurrency is modest and every
// request backs off on 429 to stay under free-tier limits.
//
// GV-494 — the sign-in budget (exercise-1 findings T1/T3, both FIXED here):
//
//   • Sign-ins are BUDGETED, not discovered. Supabase Auth allows ~30 password
//     grants per 5 minutes per IP and the dashboard cannot raise it (T4), so every
//     sign-in takes a slot from a sliding window (`--signin-budget`, default 30,
//     per `--signin-window` seconds, default 300) and the seeder PAUSES with a
//     countdown when the window is full instead of firing calls that will 429. A
//     real 429 still parks every sign-in for Retry-After (or a full window).
//     Before this, a pass burned the whole window inside the first two workspaces
//     and 429'd through the remaining eighteen (T1).
//   • A completed workspace is SKIPPED on the next pass, with ZERO sign-ins. The
//     old resume recovered state through list_my_ledgers, which needs a token, so
//     each retry spent its budget re-verifying built workspaces and plateaued at
//     10–12 of 20 across 13+ rounds (T3). Completion markers live in a small JSON
//     state file kept OUTSIDE the repo — `--state <file>`, default
//     `~/.vehloshare-rehearsal-seed-state.json`; `--ignore-state` re-verifies
//     everything the old way. A marker is keyed on project + seed + email domain
//     and carries a signature of the planned contents, so it never lets a changed
//     fixture (or a different project) skip work that was not done.
//   • One sign-in per member per pass — sessions are cached by email.
//
// A full 20-workspace pass is therefore ~110 sign-ins ≈ 4 windows ≈ 15–20 min in
// ONE pass; the estimate is printed up front so the run is not mistaken for a hang.
//
// --aged (GV-438) appends ONE aged workspace to the run: ~2 years of history,
// thousands of trips and messages, and a closed period per month, so the reads
// that grow over TIME rather than with workspace size can be measured. Knobs:
// --aged-members / --aged-periods / --aged-trips / --aged-fuel / --aged-messages.
// Budget the sign-in cost: Supabase Auth allows ~30 sign-ins per 5 min per IP
// whatever the dashboard says (GVM-533 finding T4), and the aged workspace costs
// exactly `members` sign-ins — its volume rides on tokens already held.
//
// --dry-run builds the plan and prints real request payloads WITHOUT any network,
// so the request shapes can be reviewed before a live run.

import {
  loadEnv,
  parseArgs,
  makeSupabase,
  createAuthUser,
  signInWithPassword,
  rpcCall,
  restGet,
  runPool,
  DEFAULT_EMAIL_DOMAIN,
} from "./lib/common.mjs";
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
import {
  SignInBudget,
  SessionCache,
  formatSignInEstimate,
  formatDuration,
  DEFAULT_SIGNIN_BUDGET,
  DEFAULT_SIGNIN_WINDOW_S,
} from "./lib/signin-budget.mjs";
import {
  SeedState,
  defaultSeedStatePath,
  assertStateOutsideRepo,
  projectRefFromUrl,
  workspaceSignature,
  workspaceStateKey,
} from "./lib/seed-state.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = parseArgs(process.argv.slice(2), { flags: ["dry-run", "aged", "ignore-state"] });
const seed = Number(args.seed ?? 42);
const workspaces = Number(args.workspaces ?? 20);
const concurrency = Number(args.concurrency ?? 4);
const emailDomain = args["email-domain"] ?? DEFAULT_EMAIL_DOMAIN;
const dryRun = Boolean(args["dry-run"]);

// GV-494: the sign-in budget. Defaults mirror the limit exercise 1 measured
// empirically (~30 per 5 min per IP), NOT the dashboard's setting (finding T4).
const signinBudget = Number(args["signin-budget"] ?? DEFAULT_SIGNIN_BUDGET);
const signinWindowS = Number(args["signin-window"] ?? DEFAULT_SIGNIN_WINDOW_S);
const signinWindowMs = signinWindowS * 1000;
if (!Number.isFinite(signinBudget) || signinBudget <= 0 || !Number.isFinite(signinWindowS) || signinWindowS <= 0) {
  console.error("❌ --signin-budget and --signin-window must both be positive numbers (defaults: 30 per 300 s).");
  process.exit(1);
}

// GV-494: the resume state file. Always outside the repo tree.
let statePath;
try {
  statePath = assertStateOutsideRepo(args.state ?? defaultSeedStatePath(), REPO_ROOT);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const ignoreState = Boolean(args["ignore-state"]);

// How many times one member's sign-in may be re-attempted after a real 429 before
// the workspace is failed. Declared up here because `await main()` runs before the
// bottom of this module is evaluated — a const down there is still in its TDZ.
const SIGNIN_ATTEMPTS = 4;

// GV-438: --aged appends ONE aged workspace (years of history, thousands of
// trips/messages, a closed period per month) after the small ones. The knobs let
// an operator shrink it for a smoke pass; the defaults are what exercise 2 ran.
const aged = args.aged
  ? {
      members: Number(args["aged-members"] ?? AGED_DEFAULTS.members),
      periods: Number(args["aged-periods"] ?? AGED_DEFAULTS.periods),
      tripsPerPeriod: Number(args["aged-trips"] ?? AGED_DEFAULTS.tripsPerPeriod),
      fuelPerPeriod: Number(args["aged-fuel"] ?? AGED_DEFAULTS.fuelPerPeriod),
      messagesPerPeriod: Number(args["aged-messages"] ?? AGED_DEFAULTS.messagesPerPeriod),
    }
  : null;

const plan = buildFixturePlan({ seed, workspaces, emailDomain, aged });

if (dryRun) {
  runDryRun(plan);
  process.exit(0);
}

let env;
try {
  env = loadEnv(args.env, ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const supa = makeSupabase(env);

// GV-494: one shared budget + one shared session cache for the whole pass. The
// pool workers all take their slots from these, so `--concurrency` no longer
// decides how fast the Auth limit is hit.
const budget = new SignInBudget({
  budget: signinBudget,
  windowMs: signinWindowMs,
  onWait: ({ remainingMs, spent }) =>
    console.log(`   ⏳ sign-in budget spent (${signinBudget}/${signinWindowS} s, ${spent} so far) — next slot in ${formatDuration(remainingMs)}…`),
});
const sessions = new SessionCache();
const projectRef = projectRefFromUrl(env.SUPABASE_URL);
const state = SeedState.load({ filePath: statePath, ignoreExisting: ignoreState });

await main().catch((err) => {
  console.error(`❌ Seed failed: ${err.stack || err.message}`);
  process.exit(1);
});

async function main() {
  const counters = {
    usersCreated: 0,
    usersExisting: 0,
    usersFailed: 0,
    workspacesCreated: 0,
    workspacesFailed: 0,
    workspacesSkipped: 0,
    workspacesPartial: 0,
    memberships: 0,
    trips: 0,
    fuel: 0,
    expenses: 0,
    recurring: 0,
    bookings: 0,
    messages: 0,
    settlementsRequested: 0,
    periodsClosed: 0,
    warnings: [],
  };

  console.log(`⏳ Seeding fixture: ${plan.totalUsers} users, ${plan.workspaceCount} workspaces (seed=${seed}, concurrency=${concurrency}).`);

  // ── 1. Auth users (service role) ──────────────────────────────────────────
  console.log("⏳ Creating auth users…");
  await runPool(plan.users, concurrency, async (user) => {
    const res = await createAuthUser(supa, { email: user.email, password: user.password });
    if (res.ok) {
      counters.usersCreated++;
    } else if (res.status === 422 || res.status === 409 || /already been registered|already exists/i.test(res.text)) {
      // Resumable: the user already exists from a prior run. Their password is
      // deterministic, so sign-in still works.
      counters.usersExisting++;
    } else {
      counters.usersFailed++;
      counters.warnings.push(`create user ${user.email}: ${describeError(res)}`);
    }
  });
  console.log(`   users: ${counters.usersCreated} created, ${counters.usersExisting} already existed, ${counters.usersFailed} failed.`);

  // ── 2. Workspaces (production join flow + write RPCs) ─────────────────────
  //
  // GV-494: a workspace a previous pass finished is skipped BEFORE any sign-in,
  // and the remaining sign-ins are budgeted, so one pass can walk all 20 instead
  // of plateauing at 10–12 (findings T1/T3).
  const pending = plan.workspaces.filter((ws) => !isComplete(ws));
  const skipped = plan.workspaces.length - pending.length;
  counters.workspacesSkipped = skipped;
  const pendingSignIns = pending.reduce((n, ws) => n + ws.memberCount, 0);

  console.log(`⏳ Building workspaces… ${pending.length} to build, ${skipped} already complete (skipped, 0 sign-ins).`);
  console.log(`   sign-in plan: ${formatSignInEstimate({ count: pendingSignIns, budget: signinBudget, windowMs: signinWindowMs })}`);
  console.log(`   state file:   ${statePath}${ignoreState ? " (--ignore-state: nothing is skipped this pass)" : ""}`);

  await runPool(pending, concurrency, async (ws) => {
    const warningsBefore = counters.warnings.length;
    try {
      await seedWorkspace(ws, counters);
      counters.workspacesCreated++;
      if (counters.warnings.length === warningsBefore) {
        // Only a clean workspace earns a marker — a partial one must be revisited
        // by the next pass, or the skip would hide missing rows for good.
        state.markComplete(stateKeyFor(ws), {
          signature: workspaceSignature(ws),
          workspace: ws.name,
          members: ws.memberCount,
        });
        state.save();
      } else {
        counters.workspacesPartial++;
      }
    } catch (err) {
      counters.workspacesFailed++;
      counters.warnings.push(`workspace ${ws.name}: ${err.message}`);
      console.warn(`   ⚠️  ${ws.name}: ${err.message}`);
    }
  });

  printSummary(counters);
  if (counters.workspacesFailed > 0 || counters.usersFailed > 0) {
    console.error("⚠️  Seed completed with failures (see warnings above).");
    process.exit(1);
  }
  console.log("✅ Seed complete. Next: npm run load:run -- --env <file>");
}

function stateKeyFor(ws) {
  return workspaceStateKey({ projectRef, seed, emailDomain, name: ws.name });
}

function isComplete(ws) {
  return state.isComplete(stateKeyFor(ws), workspaceSignature(ws));
}

// Sign in and return an access token (throws on failure).
//
// GV-494: every grant takes a slot from the shared sign-in budget FIRST, so the
// seeder waits for the window instead of burning it, and a member is only ever
// signed in once per pass (SessionCache). httpJson's own 429 retry is switched off
// here on purpose — the budget owns the backoff, and a silent retry underneath it
// would spend slots the budget does not know about.
async function signIn(member) {
  return sessions.get(member.email, () => mintToken(member));
}

async function mintToken(member) {
  for (let attempt = 1; attempt <= SIGNIN_ATTEMPTS; attempt++) {
    await budget.acquire(member.email);
    const res = await signInWithPassword(supa, { email: member.email, password: member.password }, { retries: 0 });
    if (res.ok && res.json?.access_token) return res.json.access_token;
    if (res.status === 429) {
      // The limiter said no despite the budget (a co-running tool, a shared IP, or
      // a window we mis-measured). Park EVERY sign-in for Retry-After — or a full
      // window when the platform did not say — and try again.
      const waitMs = budget.noteRateLimited({ retryAfterMs: res.retryAfterMs });
      console.warn(`   ⏳ Auth 429 on sign-in ${attempt}/${SIGNIN_ATTEMPTS} — pausing all sign-ins for ${formatDuration(waitMs)}.`);
      continue;
    }
    throw new Error(`sign-in failed for ${member.email}: ${describeError(res)}`);
  }
  throw new Error(
    `sign-in for ${member.email} kept hitting the Auth rate limit after ${SIGNIN_ATTEMPTS} attempts ` +
      `(budget ${signinBudget}/${signinWindowS} s) — lower --signin-budget and resume; completed workspaces are skipped.`,
  );
}

async function seedWorkspace(ws, counters) {
  const owner = ws.members[0];
  const ownerToken = await signIn(owner);

  // Create the workspace as the owner (or recover it on a resume).
  let ledgerId;
  const slotMemberId = new Array(ws.memberCount).fill(null);
  const slotToken = new Array(ws.memberCount).fill(null);
  slotToken[0] = ownerToken;

  const createRes = await rpcCall(supa, ownerToken, "create_private_ledger_workspace", {
    workspace_name: ws.name,
  });
  if (createRes.ok && Array.isArray(createRes.json) && createRes.json[0]) {
    ledgerId = createRes.json[0].ledger_id;
    slotMemberId[0] = createRes.json[0].admin_member_id;
  } else if (createRes.status === 409 || /already in use/i.test(createRes.text) || createRes.json?.code === "23505") {
    // Resume: recover the existing workspace via the owner's own membership.
    const mine = await rpcCall(supa, ownerToken, "list_my_ledgers", {});
    const row = Array.isArray(mine.json) ? mine.json.find((r) => r.name === ws.name) || mine.json[0] : null;
    if (!row) throw new Error(`could not recover existing workspace: ${describeError(createRes)}`);
    ledgerId = row.ledger_id;
    slotMemberId[0] = row.member_id;
  } else {
    throw new Error(`create workspace: ${describeError(createRes)}`);
  }

  // Owner mints the stable join code.
  const codeRes = await rpcCall(supa, ownerToken, "get_workspace_join_code", { target_ledger_id: ledgerId });
  if (!codeRes.ok) throw new Error(`get join code: ${describeError(codeRes)}`);
  const joinCode = typeof codeRes.json === "string" ? codeRes.json : String(codeRes.json);

  // Each remaining member joins via the real redeem flow.
  for (let slot = 1; slot < ws.memberCount; slot++) {
    const member = ws.members[slot];
    const token = await signIn(member);
    slotToken[slot] = token;
    const redeemRes = await rpcCall(supa, token, "redeem_ledger_invite", {
      invite_code: joinCode,
      display_name: member.name,
    });
    if (redeemRes.ok && Array.isArray(redeemRes.json) && redeemRes.json[0]) {
      slotMemberId[slot] = redeemRes.json[0].member_id;
      counters.memberships++;
    } else {
      // Resume: already a member → recover their member id.
      const mine = await rpcCall(supa, token, "list_my_ledgers", {});
      const row = Array.isArray(mine.json) ? mine.json.find((r) => r.ledger_id === ledgerId) : null;
      if (row) {
        slotMemberId[slot] = row.member_id;
        counters.memberships++;
      } else {
        counters.warnings.push(`redeem ${member.email} → ${ws.name}: ${describeError(redeemRes)}`);
      }
    }
  }

  const memberId = (slot) => slotMemberId[slot];
  const tokenFor = (slot) => slotToken[slot] ?? ownerToken;

  let openPeriodId = await fetchOpenPeriodId(ownerToken, ledgerId);
  if (!openPeriodId) throw new Error("no open settlement period after creation");

  // ── Period batches (some are closed to leave history) ───────────────────
  for (const period of ws.periods) {
    for (let t = 0; t < period.trips.length; t++) {
      const trip = period.trips[t];
      const driverId = memberId(trip.driverSlot);
      if (!driverId) continue;
      const participantMemberIds = [...new Set(trip.participantSlots.map(memberId).filter(Boolean))];
      const res = await rpcCall(supa, tokenFor(trip.driverSlot), "upsert_trip_with_participants",
        tripArgs({
          ledgerId,
          openPeriodId,
          legacyId: `s${seed}-w${ws.workspaceIndex}-p${ws.periods.indexOf(period)}-t${t}`,
          driverMemberId: driverId,
          participantMemberIds,
          trip,
        }));
      if (res.ok) counters.trips++;
      else counters.warnings.push(`trip ${ws.name}: ${describeError(res)}`);
    }

    for (let f = 0; f < period.fuel.length; f++) {
      const fuel = period.fuel[f];
      const payerId = memberId(fuel.payerSlot);
      if (!payerId) continue;
      const res = await rpcCall(supa, tokenFor(fuel.payerSlot), "upsert_fuel_payment",
        fuelArgs({
          ledgerId,
          openPeriodId,
          legacyId: `s${seed}-w${ws.workspaceIndex}-p${ws.periods.indexOf(period)}-f${f}`,
          payerMemberId: payerId,
          fuel,
        }));
      if (res.ok) counters.fuel++;
      else counters.warnings.push(`fuel ${ws.name}: ${describeError(res)}`);
    }

    for (const expense of period.expenses) {
      const paidById = memberId(expense.paidBySlot) ?? memberId(0);
      const res = await rpcCall(supa, ownerToken, "upsert_workspace_expense",
        expenseArgs({ ledgerId, openPeriodId, paidByMemberId: paidById, expense }));
      if (res.ok) counters.expenses++;
      else counters.warnings.push(`expense ${ws.name}: ${describeError(res)}`);
    }

    for (const message of period.messages ?? []) {
      const res = await rpcCall(supa, tokenFor(message.senderSlot), "post_message", messageArgs({ ledgerId, message }));
      if (res.ok) counters.messages++;
      else counters.warnings.push(`message ${ws.name}: ${describeError(res)}`);
    }

    if (period.closeAfter) {
      const closed = await closePeriod(ownerToken, ledgerId, openPeriodId, counters);
      if (closed.ok) {
        counters.periodsClosed++;
        const next = await fetchOpenPeriodId(ownerToken, ledgerId);
        if (next) openPeriodId = next;
      } else {
        counters.warnings.push(`close period ${ws.name}: ${closed.reason}`);
      }
    }
  }

  // ── Standing costs, bookings, messages ───────────────────────────────────
  for (const recurring of ws.recurring) {
    const res = await rpcCall(supa, ownerToken, "upsert_recurring_expense",
      recurringArgs({ ledgerId, paidByMemberId: memberId(0), recurring }));
    if (res.ok) counters.recurring++;
    else counters.warnings.push(`recurring ${ws.name}: ${describeError(res)}`);
  }

  for (let b = 0; b < ws.bookings.length; b++) {
    const booking = ws.bookings[b];
    const bmId = memberId(booking.memberSlot);
    if (!bmId) continue;
    const res = await rpcCall(supa, tokenFor(booking.memberSlot), "upsert_car_booking",
      bookingArgs({ ledgerId, legacyId: `s${seed}-w${ws.workspaceIndex}-b${b}`, bookingMemberId: bmId, booking }));
    if (res.ok) counters.bookings++;
    else counters.warnings.push(`booking ${ws.name}: ${describeError(res)}`);
  }

  for (const message of ws.messages) {
    const res = await rpcCall(supa, tokenFor(message.senderSlot), "post_message", messageArgs({ ledgerId, message }));
    if (res.ok) counters.messages++;
    else counters.warnings.push(`message ${ws.name}: ${describeError(res)}`);
  }
}

async function fetchOpenPeriodId(token, ledgerId) {
  const res = await restGet(supa, token, "settlement_periods",
    `select=id&ledger_id=eq.${encodeURIComponent(ledgerId)}&status=eq.open&limit=1`);
  if (res.ok && Array.isArray(res.json) && res.json[0]) return res.json[0].id;
  return null;
}

// Close the open period the way a client must (GV-438):
//
//   1. ask the server for the canonical settlement,
//   2. build the snapshot the close RPC validates against,
//   3. REQUEST every outstanding pair at its current amount, and only then
//   4. call the real close RPC.
//
// Step 3 is the fix. Without it the close RPC raises 42501 ("All settlements must
// be requested at their current amounts before this period can be closed"), which
// is why the GVM-533 rehearsal reported `periods closed: 0`. The owner is the
// ledger admin, so they may drive each pair's request; the amounts come from
// buildCloseProgram, which derives them from the server's own nets with the same
// pairing the request trigger recomputes, so they match to the cent.
async function closePeriod(token, ledgerId, periodId, counters) {
  const calc = await rpcCall(supa, token, "calculate_period_settlement", {
    target_ledger_id: ledgerId,
    target_period_id: periodId,
  });
  if (!calc.ok || !calc.json) return { ok: false, reason: `calc: ${describeError(calc)}` };

  const program = buildCloseProgram(calc.json, { ledgerId, periodId });

  for (const request of program.requests) {
    const res = await rpcCall(supa, token, request.rpc, request.args);
    if (!res.ok) {
      return {
        ok: false,
        reason: `request settlement ${request.settlement.amount} kr: ${describeError(res)}`,
      };
    }
    if (counters) counters.settlementsRequested++;
  }

  const res = await rpcCall(supa, token, program.close.rpc, program.close.args);
  if (!res.ok) return { ok: false, reason: describeError(res) };
  return { ok: true, requested: program.requests.length };
}

function describeError(res) {
  if (res.json && (res.json.message || res.json.msg || res.json.error_description)) {
    const m = res.json.message || res.json.msg || res.json.error_description;
    return `HTTP ${res.status} ${res.json.code ? `[${res.json.code}] ` : ""}${m}`;
  }
  return `HTTP ${res.status} ${(res.text || "").slice(0, 200)}`;
}

function printSummary(c) {
  console.log("");
  console.log("── Seed summary ────────────────────────────────────────────");
  console.log(`  auth users:        ${c.usersCreated} created, ${c.usersExisting} existing, ${c.usersFailed} failed`);
  console.log(`  workspaces:        ${c.workspacesCreated} ok, ${c.workspacesFailed} failed, ${c.workspacesSkipped} skipped (already complete), ${c.workspacesPartial} partial (will be retried)`);
  const b = budget.summary();
  console.log(`  sign-ins:          ${b.spent} (${sessions.hits} reused), ${formatDuration(b.waitedMs)} paused for the budget, ${b.rateLimited} × HTTP 429`);
  console.log(`  state file:        ${statePath} (${state.completedCount} workspace(s) marked complete)`);
  console.log(`  memberships:       ${c.memberships} joined (via redeem_ledger_invite)`);
  console.log(`  trips:             ${c.trips}`);
  console.log(`  fuel payments:     ${c.fuel}`);
  console.log(`  one-off expenses:  ${c.expenses}`);
  console.log(`  recurring:         ${c.recurring}`);
  console.log(`  bookings:          ${c.bookings}`);
  console.log(`  messages:          ${c.messages}`);
  console.log(`  settlements req.:  ${c.settlementsRequested} (requested at current amounts before each close)`);
  console.log(`  periods closed:    ${c.periodsClosed}`);
  if (c.warnings.length > 0) {
    console.log(`  warnings:          ${c.warnings.length}`);
    for (const w of c.warnings.slice(0, 20)) console.log(`     · ${w}`);
    if (c.warnings.length > 20) console.log(`     · … and ${c.warnings.length - 20} more`);
  }
  console.log("────────────────────────────────────────────────────────────");
}

// ── Dry run ──────────────────────────────────────────────────────────────────
function runDryRun(plan) {
  const totals = plan.workspaces.reduce(
    (acc, ws) => {
      for (const p of ws.periods) {
        acc.trips += p.trips.length;
        acc.fuel += p.fuel.length;
        acc.expenses += p.expenses.length;
        if (p.closeAfter) acc.closed++;
      }
      for (const p of ws.periods) acc.messages += (p.messages ?? []).length;
      acc.recurring += ws.recurring.length;
      acc.bookings += ws.bookings.length;
      acc.messages += ws.messages.length;
      return acc;
    },
    { trips: 0, fuel: 0, expenses: 0, closed: 0, recurring: 0, bookings: 0, messages: 0 },
  );

  const plannedSignIns = plan.workspaces.reduce((n, ws) => n + ws.memberCount, 0);

  console.log("── seed --dry-run (no network) ─────────────────────────────");
  console.log(`  seed=${plan.seed}  workspaces=${plan.workspaceCount}  users=${plan.totalUsers}  emailDomain=${plan.emailDomain}`);
  console.log(`  sign-in budget:    ${signinBudget} per ${signinWindowS} s (sliding window; pauses rather than 429s)`);
  console.log(`  sign-in plan:      ${formatSignInEstimate({ count: plannedSignIns, budget: signinBudget, windowMs: signinWindowMs })} — for a FRESH project; complete workspaces cost 0`);
  console.log(`  state file:        ${statePath} (per project+seed+domain; skips completed workspaces with no sign-in)`);
  const sizes = plan.workspaces.map((w) => w.memberCount);
  console.log(`  workspace sizes:   [${sizes.join(", ")}]  (min ${Math.min(...sizes)}, max ${Math.max(...sizes)})`);
  console.log(`  planned entries:   ${totals.trips} trips, ${totals.fuel} fuel, ${totals.expenses} expenses, ${totals.recurring} recurring, ${totals.bookings} bookings, ${totals.messages} messages`);
  console.log(`  closed periods:    ${totals.closed} (each: request every outstanding settlement, then close_settlement_period)`);
  if (plan.aged) {
    const agedWs = plan.workspaces.find((w) => w.aged);
    const agedTrips = agedWs.periods.reduce((n, p) => n + p.trips.length, 0);
    const agedMsgs = agedWs.periods.reduce((n, p) => n + (p.messages ?? []).length, 0);
    console.log(`  aged workspace:    "${agedWs.name}" — ${agedWs.memberCount} members, ${agedWs.periods.length} periods (${agedWs.periods.filter((p) => p.closeAfter).length} closed), ${agedTrips} trips, ${agedMsgs} messages`);
  }
  console.log("");
  console.log("  deterministic identities (first 3 users; load.mjs derives the same):");
  for (const u of plan.users.slice(0, 3)) {
    console.log(`     · ${u.email}  /  ${u.password}  (${u.name})`);
  }

  const ws = plan.workspaces[0];
  const trip = ws.periods[0].trips[0];
  const fuel = ws.periods[0].fuel[0];
  console.log("");
  console.log(`  sample request payloads for workspace "${ws.name}" (ids are placeholders — real ids come from the RPC responses):`);
  console.log("   1) create_private_ledger_workspace →", JSON.stringify({ workspace_name: ws.name }));
  console.log("   2) get_workspace_join_code         →", JSON.stringify({ target_ledger_id: "<slug>" }));
  console.log("   3) redeem_ledger_invite            →", JSON.stringify({ invite_code: "<GV-XXXX>", display_name: ws.members[1]?.name ?? "<name>" }));
  if (trip) {
    console.log("   4) upsert_trip_with_participants   →",
      JSON.stringify(tripArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "s..-w0-p0-t0", driverMemberId: "<member-uuid>", participantMemberIds: ["<member-uuid>"], trip })));
  }
  if (fuel) {
    console.log("   5) upsert_fuel_payment             →",
      JSON.stringify(fuelArgs({ ledgerId: "<slug>", openPeriodId: "<period-uuid>", legacyId: "s..-w0-p0-f0", payerMemberId: "<member-uuid>", fuel })));
  }

  // Exercise the close PROGRAM against a MOCK server result so the required
  // sequence — request every outstanding pair at its current amount, THEN close —
  // is visible without a live calculate_period_settlement call.
  const mockComputed = {
    totalKm: 420,
    totalPaid: 900.5,
    people: [
      { id: "aaaa", name: "Frederik", km: 300, fuelPaid: 900.5, net: 257.5 },
      { id: "bbbb", name: "Emma", km: 120, fuelPaid: 0, net: -257.5 },
    ],
  };
  const mockProgram = buildCloseProgram(mockComputed, { ledgerId: "<slug>", periodId: "<period-uuid>" });
  console.log(`   6) close sequence (built from a mock calculate_period_settlement result) — ${mockProgram.requests.length} request(s) FIRST, then the close:`);
  for (const r of mockProgram.requests) {
    console.log(`      · ${r.rpc}  `, JSON.stringify(r.args));
  }
  console.log(`      · ${mockProgram.close.rpc}  `, JSON.stringify(mockProgram.close.args));
  console.log("────────────────────────────────────────────────────────────");
  console.log("Dry run only — no users, workspaces, or rows were created.");
}

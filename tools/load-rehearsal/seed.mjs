// GV-317 load rehearsal — step 2: seed the fixture.
//
//   npm run load:seed -- --env /path/to/rehearsal.env [--seed 42] [--workspaces 20]
//                        [--concurrency 4] [--dry-run]
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
//                             → build the matching snapshot → close_settlement_period.
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
  buildCloseSnapshot,
  tripArgs,
  fuelArgs,
  bookingArgs,
  expenseArgs,
  recurringArgs,
  messageArgs,
} from "./lib/fixtures.mjs";

const args = parseArgs(process.argv.slice(2), { flags: ["dry-run"] });
const seed = Number(args.seed ?? 42);
const workspaces = Number(args.workspaces ?? 20);
const concurrency = Number(args.concurrency ?? 4);
const emailDomain = args["email-domain"] ?? DEFAULT_EMAIL_DOMAIN;
const dryRun = Boolean(args["dry-run"]);

const plan = buildFixturePlan({ seed, workspaces, emailDomain });

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
    memberships: 0,
    trips: 0,
    fuel: 0,
    expenses: 0,
    recurring: 0,
    bookings: 0,
    messages: 0,
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
  console.log("⏳ Building workspaces…");
  await runPool(plan.workspaces, concurrency, async (ws) => {
    try {
      await seedWorkspace(ws, counters);
      counters.workspacesCreated++;
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

// Sign in and return an access token (throws on failure).
async function signIn(member) {
  const res = await signInWithPassword(supa, { email: member.email, password: member.password });
  if (!res.ok || !res.json?.access_token) {
    throw new Error(`sign-in failed for ${member.email}: ${describeError(res)}`);
  }
  return res.json.access_token;
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

    if (period.closeAfter) {
      const closed = await closePeriod(ownerToken, ledgerId, openPeriodId);
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

// Close the open period: ask the server for the canonical settlement, build the
// snapshot it validates against, and call the real close RPC.
async function closePeriod(token, ledgerId, periodId) {
  const calc = await rpcCall(supa, token, "calculate_period_settlement", {
    target_ledger_id: ledgerId,
    target_period_id: periodId,
  });
  if (!calc.ok || !calc.json) return { ok: false, reason: `calc: ${describeError(calc)}` };
  const snapshot = buildCloseSnapshot(calc.json);
  const res = await rpcCall(supa, token, "close_settlement_period", {
    target_ledger_id: ledgerId,
    target_period_id: periodId,
    period_snapshot: snapshot,
  });
  if (!res.ok) return { ok: false, reason: describeError(res) };
  return { ok: true };
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
  console.log(`  workspaces:        ${c.workspacesCreated} ok, ${c.workspacesFailed} failed`);
  console.log(`  memberships:       ${c.memberships} joined (via redeem_ledger_invite)`);
  console.log(`  trips:             ${c.trips}`);
  console.log(`  fuel payments:     ${c.fuel}`);
  console.log(`  one-off expenses:  ${c.expenses}`);
  console.log(`  recurring:         ${c.recurring}`);
  console.log(`  bookings:          ${c.bookings}`);
  console.log(`  messages:          ${c.messages}`);
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
      acc.recurring += ws.recurring.length;
      acc.bookings += ws.bookings.length;
      acc.messages += ws.messages.length;
      return acc;
    },
    { trips: 0, fuel: 0, expenses: 0, closed: 0, recurring: 0, bookings: 0, messages: 0 },
  );

  console.log("── seed --dry-run (no network) ─────────────────────────────");
  console.log(`  seed=${plan.seed}  workspaces=${plan.workspaceCount}  users=${plan.totalUsers}  emailDomain=${plan.emailDomain}`);
  const sizes = plan.workspaces.map((w) => w.memberCount);
  console.log(`  workspace sizes:   [${sizes.join(", ")}]  (min ${Math.min(...sizes)}, max ${Math.max(...sizes)})`);
  console.log(`  planned entries:   ${totals.trips} trips, ${totals.fuel} fuel, ${totals.expenses} expenses, ${totals.recurring} recurring, ${totals.bookings} bookings, ${totals.messages} messages`);
  console.log(`  closed periods:    ${totals.closed} (settlement history via close_settlement_period)`);
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

  // Exercise the close-snapshot builder against a MOCK server result so its logic
  // is visible without a live calculate_period_settlement call.
  const mockComputed = {
    totalKm: 420,
    totalPaid: 900.5,
    people: [
      { id: "aaaa", name: "Frederik", km: 300, fuelPaid: 900.5, net: 257.5 },
      { id: "bbbb", name: "Emma", km: 120, fuelPaid: 0, net: -257.5 },
    ],
  };
  console.log("   6) close_settlement_period snapshot (built from a mock calculate_period_settlement result):");
  console.log("      ", JSON.stringify(buildCloseSnapshot(mockComputed)));
  console.log("────────────────────────────────────────────────────────────");
  console.log("Dry run only — no users, workspaces, or rows were created.");
}

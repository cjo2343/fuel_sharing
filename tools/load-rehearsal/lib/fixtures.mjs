// Deterministic fixture generation for the load rehearsal (GV-317).
//
// buildFixturePlan(seed, workspaces) is a PURE function: given the same seed it
// always produces the same plan (users, workspaces, memberships, and the domain
// entries per settlement period). seed.mjs walks the plan and materialises it
// through the real production RPCs; the unit tests assert its determinism.
//
// The plan describes WHAT to create, not HOW — member ids/period ids are only
// known at seed time (they come back from the RPCs), so entries reference members
// by SLOT (index within the workspace) which seed.mjs resolves to real ids.

import { makeRng, userEmail, userPassword, DEFAULT_EMAIL_DOMAIN } from "./common.mjs";

// Realistic Danish names / places — synthetic, no real people (GDPR).
const FIRST_NAMES = [
  "Frederik", "Emma", "William", "Ida", "Oscar", "Sofia", "Lucas", "Freja",
  "Malthe", "Clara", "Noah", "Alma", "Victor", "Anna", "Oliver", "Laura",
  "Karl", "Ella", "Alfred", "Josefine", "Mikkel", "Mette", "Lars", "Anne",
  "Søren", "Camilla", "Jens", "Louise", "Peter", "Sara",
];
const LAST_NAMES = [
  "Nielsen", "Jensen", "Hansen", "Pedersen", "Andersen", "Christensen",
  "Larsen", "Sørensen", "Rasmussen", "Jørgensen", "Petersen", "Madsen",
  "Kristensen", "Olsen", "Thomsen", "Christiansen", "Poulsen", "Møller",
];
const CITIES = [
  "Aarhus", "København", "Odense", "Aalborg", "Esbjerg", "Randers", "Kolding",
  "Horsens", "Vejle", "Roskilde", "Herning", "Silkeborg", "Næstved",
  "Fredericia", "Viborg", "Køge", "Holstebro", "Slagelse", "Hillerød", "Sønderborg",
];
const STATION_BRANDS = ["Circle K", "Shell", "OK", "Q8", "Uno-X", "F24", "Ingo"];
const TRIP_NOTES = [
  "Indkøb", "Til arbejde", "Weekendtur", "Hente børn", "Genbrugsplads",
  "Besøg hos familie", "Sommerhus", "Lufthavn", null, null,
];
const BOOKING_PURPOSES = ["Weekendtur", "Flytning", "Ferie", "Indkøb", "Møde", null];
const EXPENSE_CATEGORIES = ["carwash", "parking", "toll", "accessories", "other"];
const RECURRING = [
  { category: "insurance", description: "Bilforsikring", amountDkk: 480, cadence: "monthly" },
  { category: "tax", description: "Grøn ejerafgift", amountDkk: 1120, cadence: "semiannual" },
  { category: "subscription", description: "Vejhjælp", amountDkk: 99, cadence: "monthly" },
];

// A fixed anchor so dates are deterministic (a pure function of the seed). The
// open settlement period has no date bounds, so any valid date is accepted.
const ANCHOR_ISO = "2026-07-01";

function isoDateMinusDays(baseIso, days) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoTsPlus(baseIso, dayOffset, hour) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

// Build one period's worth of domain entries. `startOdo` seeds the odometer chain
// so end_km of trip N is start_km of trip N+1 (monotonic, like a real logbook).
function buildPeriodEntries(rng, memberCount, startOdo, dayBase) {
  const slots = Array.from({ length: memberCount }, (_, i) => i);
  const tripCount = rng.int(4, 12);
  const trips = [];
  let odo = startOdo;
  for (let t = 0; t < tripCount; t++) {
    const distance = rng.int(6, 140);
    const startKm = odo;
    const endKm = odo + distance;
    odo = endKm;
    const driverSlot = rng.pick(slots);
    // A distinct subset of members split the trip; the driver always rides.
    const others = rng.sample(
      slots.filter((s) => s !== driverSlot),
      rng.int(0, Math.max(0, memberCount - 1)),
    );
    const participantSlots = [driverSlot, ...others];
    trips.push({
      driverSlot,
      participantSlots,
      startKm,
      endKm,
      tripDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 20)),
      note: rng.pick(TRIP_NOTES),
    });
  }

  const fuelCount = rng.int(2, 6);
  const fuel = [];
  let fuelOdo = startOdo;
  for (let f = 0; f < fuelCount; f++) {
    fuelOdo += rng.int(80, 400);
    const liters = rng.int(20, 55) + rng.int(0, 9) / 10;
    const pricePerLiter = 12 + rng.int(0, 40) / 10; // 12.0–16.0 kr/L
    const amount = Math.round(liters * pricePerLiter * 100) / 100;
    fuel.push({
      payerSlot: rng.pick(slots),
      amount,
      liters: Math.round(liters * 100) / 100,
      pricePerLiter: Math.round(pricePerLiter * 100) / 100,
      odometer: Math.min(fuelOdo, odo),
      stationBrand: rng.pick(STATION_BRANDS),
      fullTank: rng.rand() < 0.6,
      paymentDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 20)),
    });
  }

  // A couple of one-off shared expenses (folded into the settlement).
  const expenseCount = rng.int(0, 2);
  const expenses = [];
  for (let e = 0; e < expenseCount; e++) {
    expenses.push({
      category: rng.pick(EXPENSE_CATEGORIES),
      description: "Delt udgift",
      amountDkk: rng.int(50, 600),
      expenseDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 20)),
      paidBySlot: rng.pick(slots),
    });
  }

  return { trips, fuel, expenses, endOdo: odo };
}

// Build the full deterministic plan.
//
// `aged` (GV-438) appends ONE aged workspace after the small ones: years of
// history, thousands of trips/messages and SEVERAL closed periods, so the reads
// that grow over time (activity feed, trips, history) can be measured against
// something a launch-day workspace will only look like in a year. It is APPENDED
// with its own PRNG stream and its users are appended after the flat pool, so
// turning it on leaves every small workspace and every existing user index
// byte-identical (the determinism tests pin this).
export function buildFixturePlan({ seed = 42, workspaces = 20, emailDomain = DEFAULT_EMAIL_DOMAIN, aged = null } = {}) {
  const rng = makeRng(seed);

  // Workspace sizes 2–8 (a small shared-car group).
  const sizes = Array.from({ length: workspaces }, () => rng.int(2, 8));
  const totalUsers = sizes.reduce((a, b) => a + b, 0);

  // Flat user pool. Each user is one auth identity, assigned to exactly one
  // workspace (a member of one shared car), matching how the beta actually looks.
  const users = [];
  for (let i = 0; i < totalUsers; i++) {
    users.push({
      index: i,
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      email: userEmail(i, emailDomain),
      password: userPassword(i, seed),
    });
  }

  const workspacePlans = [];
  let ptr = 0;
  for (let w = 0; w < workspaces; w++) {
    const size = sizes[w];
    const memberUserIndexes = [];
    for (let k = 0; k < size; k++) memberUserIndexes.push(ptr++);
    const city = CITIES[w % CITIES.length];
    // Slot 0 = owner (creates the workspace + holds the join code).
    const members = memberUserIndexes.map((userIndex, slot) => ({
      slot,
      userIndex,
      name: users[userIndex].name,
      email: users[userIndex].email,
      password: users[userIndex].password,
    }));

    // Roughly every third workspace gets a closed period so settlement history
    // exists. Its "period 0" is closed after seeding; a fresh "current" period
    // then receives more entries and stays open.
    const hasClosedPeriod = w % 3 === 0;
    const startOdo = 30000 + rng.int(0, 60000);

    const periods = [];
    if (hasClosedPeriod) {
      const closed = buildPeriodEntries(rng, size, startOdo, 40);
      periods.push({ closeAfter: true, ...closed });
      const current = buildPeriodEntries(rng, size, closed.endOdo, 5);
      periods.push({ closeAfter: false, ...current });
    } else {
      const current = buildPeriodEntries(rng, size, startOdo, 5);
      periods.push({ closeAfter: false, ...current });
    }

    // A couple of standing costs (admin-managed recurring templates).
    const recurring = rng.sample(RECURRING, rng.int(1, 2)).map((r) => ({
      ...r,
      nextDueDate: isoDateMinusDays(ANCHOR_ISO, -rng.int(1, 25)), // future due date
    }));

    // A few bookings + chat messages for feed/realtime realism. Booking days are
    // DISTINCT: prevent_overlapping_car_bookings rejects a second booking on a day
    // already taken, and two draws landing on the same day is exactly the kind of
    // fixture defect that shows up as an unexplained seeding warning.
    const bookingDays = rng.sample(Array.from({ length: 20 }, (_, i) => i + 1), rng.int(1, 4));
    const bookings = bookingDays.map((dayOffset) => {
      const memberSlot = rng.int(0, size - 1);
      return {
        memberSlot,
        startAt: isoTsPlus(ANCHOR_ISO, dayOffset, 9),
        endAt: isoTsPlus(ANCHOR_ISO, dayOffset, 17),
        purpose: rng.pick(BOOKING_PURPOSES),
      };
    });
    const messages = Array.from({ length: rng.int(2, 6) }, () => ({
      senderSlot: rng.int(0, size - 1),
      body: rng.pick([
        "Husk at tanke op inden weekenden",
        "Jeg har booket bilen på lørdag",
        "Tak for turen!",
        "Hvem kører til mødet i morgen?",
        "Bilen står ladt op",
        "Jeg har lagt kvitteringen ind",
      ]),
    }));

    workspacePlans.push({
      workspaceIndex: w,
      name: `Delebil ${city} ${String(w + 1).padStart(2, "0")}`,
      city,
      memberCount: size,
      members,
      periods,
      recurring,
      bookings,
      messages,
    });
  }

  if (aged) {
    const agedWs = buildAgedWorkspacePlan({
      seed,
      emailDomain,
      workspaceIndex: workspaces,
      userIndexOffset: users.length,
      ...(aged === true ? {} : aged),
    });
    users.push(...agedWs.users);
    workspacePlans.push(agedWs.workspace);
  }

  return {
    seed,
    emailDomain,
    totalUsers: users.length,
    workspaceCount: workspacePlans.length,
    users,
    workspaces: workspacePlans,
    aged: aged ? workspacePlans[workspacePlans.length - 1].name : null,
  };
}

// ── Aged workspace (GV-438) ──────────────────────────────────────────────────
// The GVM-533 rehearsal only ever held ~10 trips and ZERO closed periods per
// workspace, so it could not answer GVM-535's question: at what history size do
// the unbounded reads start to hurt? These defaults produce roughly two years of
// a busy shared car — thousands of trips, thousands of messages, and a closed
// period per month — which is what the exercise-2 measurements run against.
export const AGED_DEFAULTS = {
  members: 6,
  periods: 12, // 11 closed + 1 still open
  tripsPerPeriod: 200,
  fuelPerPeriod: 30,
  expensesPerPeriod: 4,
  messagesPerPeriod: 150,
  bookingsPerPeriod: 6,
};

// One aged workspace plan, shaped exactly like a small-workspace plan (so seed.mjs
// walks it with the same loop) plus `aged: true` and per-period `messages`.
export function buildAgedWorkspacePlan({
  seed = 42,
  emailDomain = DEFAULT_EMAIL_DOMAIN,
  workspaceIndex = 0,
  userIndexOffset = 0,
  ...knobs
} = {}) {
  const cfg = { ...AGED_DEFAULTS, ...knobs };
  // A separate stream (seed ^ a constant) so the aged workspace never perturbs
  // the small-workspace plans built off the main stream.
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);

  const users = [];
  for (let k = 0; k < cfg.members; k++) {
    const index = userIndexOffset + k;
    users.push({
      index,
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      email: userEmail(index, emailDomain),
      password: userPassword(index, seed),
    });
  }
  const members = users.map((u, slot) => ({
    slot,
    userIndex: u.index,
    name: u.name,
    email: u.email,
    password: u.password,
  }));

  const periods = [];
  let odo = 120000 + rng.int(0, 40000);
  for (let p = 0; p < cfg.periods; p++) {
    // Oldest period first; each period is one ~30-day month further back.
    const dayBase = (cfg.periods - p) * 30;
    const entries = buildAgedPeriodEntries(rng, cfg, odo, dayBase);
    odo = entries.endOdo;
    periods.push({
      // Every period but the last is closed through the real close sequence
      // (request every outstanding settlement at its current amount, then close).
      closeAfter: p < cfg.periods - 1,
      ...entries,
    });
  }

  const recurring = RECURRING.map((r) => ({
    ...r,
    nextDueDate: isoDateMinusDays(ANCHOR_ISO, -rng.int(1, 25)),
  }));

  // One booking every few days going back through the history, never two on the
  // same day (prevent_overlapping_car_bookings).
  const bookings = Array.from({ length: cfg.bookingsPerPeriod * cfg.periods }, (_, b) => {
    const memberSlot = rng.int(0, cfg.members - 1);
    const dayOffset = 20 - b * 4;
    return {
      memberSlot,
      startAt: isoTsPlus(ANCHOR_ISO, dayOffset, 9),
      endAt: isoTsPlus(ANCHOR_ISO, dayOffset, 17),
      purpose: rng.pick(BOOKING_PURPOSES),
    };
  });

  return {
    users,
    workspace: {
      workspaceIndex,
      aged: true,
      name: `Delebil Aldret ${String(workspaceIndex + 1).padStart(2, "0")}`,
      city: "Aarhus",
      memberCount: cfg.members,
      members,
      periods,
      recurring,
      bookings,
      messages: [], // aged chat is per-period so it interleaves with the history
    },
  };
}

// Like buildPeriodEntries but with explicit counts (not rng 4–12) and its own
// chat, because the aged workspace's whole point is volume.
function buildAgedPeriodEntries(rng, cfg, startOdo, dayBase) {
  const slots = Array.from({ length: cfg.members }, (_, i) => i);
  const trips = [];
  let odo = startOdo;
  for (let t = 0; t < cfg.tripsPerPeriod; t++) {
    const distance = rng.int(6, 140);
    const startKm = odo;
    const endKm = odo + distance;
    odo = endKm;
    const driverSlot = rng.pick(slots);
    const others = rng.sample(
      slots.filter((s) => s !== driverSlot),
      rng.int(0, cfg.members - 1),
    );
    trips.push({
      driverSlot,
      participantSlots: [driverSlot, ...others],
      startKm,
      endKm,
      tripDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 29)),
      note: rng.pick(TRIP_NOTES),
    });
  }

  const fuel = [];
  let fuelOdo = startOdo;
  const fuelStep = Math.max(1, Math.floor((odo - startOdo) / (cfg.fuelPerPeriod + 1)));
  for (let f = 0; f < cfg.fuelPerPeriod; f++) {
    fuelOdo += fuelStep;
    const liters = rng.int(20, 55) + rng.int(0, 9) / 10;
    const pricePerLiter = 12 + rng.int(0, 40) / 10;
    fuel.push({
      payerSlot: rng.pick(slots),
      amount: Math.round(liters * pricePerLiter * 100) / 100,
      liters: Math.round(liters * 100) / 100,
      pricePerLiter: Math.round(pricePerLiter * 100) / 100,
      odometer: Math.min(fuelOdo, odo),
      stationBrand: rng.pick(STATION_BRANDS),
      fullTank: rng.rand() < 0.6,
      paymentDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 29)),
    });
  }

  const expenses = Array.from({ length: cfg.expensesPerPeriod }, () => ({
    category: rng.pick(EXPENSE_CATEGORIES),
    description: "Delt udgift",
    amountDkk: rng.int(50, 600),
    expenseDate: isoDateMinusDays(ANCHOR_ISO, dayBase + rng.int(0, 29)),
    paidBySlot: rng.pick(slots),
  }));

  const messages = Array.from({ length: cfg.messagesPerPeriod }, () => ({
    senderSlot: rng.int(0, cfg.members - 1),
    body: rng.pick([
      "Husk at tanke op inden weekenden",
      "Jeg har booket bilen på lørdag",
      "Tak for turen!",
      "Hvem kører til mødet i morgen?",
      "Bilen står ladt op",
      "Jeg har lagt kvitteringen ind",
    ]),
  }));

  return { trips, fuel, expenses, messages, endOdo: odo };
}

// ── Settlement close support ─────────────────────────────────────────────────

// Greedy largest-debtor → largest-creditor pairing from each member's net
// (net > 0 = owed money / creditor; net < 0 = owes / debtor). Produces a
// settlement set whose per-member flow (outflow - inflow) equals -net, which is
// exactly what close_settlement_period's integrity gate (c) checks.
export function computeSettlementsFromNets(people) {
  const debtors = people
    .filter((p) => Number(p.net) < -0.005)
    .map((p) => ({ id: String(p.id), amt: -Number(p.net) }));
  const creditors = people
    .filter((p) => Number(p.net) > 0.005)
    .map((p) => ({ id: String(p.id), amt: Number(p.net) }));
  debtors.sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  creditors.sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));

  const settlements = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].amt, creditors[j].amt);
    const rounded = Math.round(amt * 100) / 100;
    if (rounded > 0) {
      settlements.push({
        fromId: debtors[i].id,
        toId: creditors[j].id,
        amount: rounded,
        currency: "DKK",
      });
    }
    debtors[i].amt -= amt;
    creditors[j].amt -= amt;
    if (debtors[i].amt <= 0.005) i++;
    if (creditors[j].amt <= 0.005) j++;
  }
  return settlements;
}

// Build the period snapshot close_settlement_period validates against the server's
// own calculate_period_settlement result. We copy the server's figures verbatim
// (so per-member km/fuelPaid/net match to the cent) and derive settlements from
// the server nets. entryFingerprint is deliberately OMITTED — the RPC null-skips
// the fingerprint gate then, avoiding any client/server hashing mismatch.
export function buildCloseSnapshot(computed) {
  const people = (computed.people || []).map((p) => ({
    id: p.id,
    name: p.name,
    km: p.km,
    fuelPaid: p.fuelPaid,
    net: p.net,
  }));
  return {
    totalKm: computed.totalKm ?? 0,
    totalPaid: computed.totalPaid ?? 0,
    people,
    settlements: computeSettlementsFromNets(people),
  };
}

// ── Close program: request every settlement, THEN close (GV-438) ─────────────
//
// The GVM-533 rehearsal's close step always failed with 42501 — "All settlements
// must be requested at their current amounts before this period can be closed."
// That gate (migration 141's close_settlement_period_unlocked, off the 117/098
// lineage) walks the snapshot's settlements and, unless the workspace has
// rule_require_requests_before_close explicitly false, demands for EACH pair that
// moves money a settlement_requests row for the period with
//
//   status not in ('open','cancelled')  AND  amount = round(<snapshot amount>, 2)
//
// so a fixture cannot fake period history by skipping the request step. The
// amount must be exact in both directions: enforce_settlement_request_exact_amount
// (migration 117) recomputes the pair amount server-side with the same greedy
// largest-debtor/largest-creditor pairing computeSettlementsFromNets uses and
// rejects any request that disagrees, so the snapshot amount and the requested
// amount are necessarily the same number.
//
// buildCloseProgram is that sequence as data: the snapshot to close with, and the
// request payloads to send FIRST, in order. Both the HTTP seeder and the local
// aged harness consume it, so there is exactly one description of the sequence.
export const SETTLEMENT_REQUEST_RPC = "upsert_settlement_request_status";
export const CLOSE_PERIOD_RPC = "close_settlement_period";

export function settlementRequestArgs({ ledgerId, periodId, settlement }) {
  return {
    target_ledger_id: ledgerId,
    target_open_period_id: periodId,
    payer_member_id: settlement.fromId,
    recipient_member_id: settlement.toId,
    amount_value: settlement.amount,
    currency_value: settlement.currency ?? "DKK",
    next_status: "requested",
    // Server-side ignored since GV-259 (the RPC derives the valid pairs itself);
    // sent as the client sends it.
    current_pair_keys: [],
    p_note: null,
  };
}

export function closePeriodArgs({ ledgerId, periodId, snapshot }) {
  return {
    target_ledger_id: ledgerId,
    target_period_id: periodId,
    period_snapshot: snapshot,
  };
}

// { snapshot, requests[], close } — requests MUST all be sent (and succeed)
// before `close`, which is the whole point of this helper.
export function buildCloseProgram(computed, { ledgerId, periodId }) {
  const snapshot = buildCloseSnapshot(computed);
  const requests = snapshot.settlements
    .filter((s) => Number(s.amount) > 0)
    .map((settlement) => ({
      rpc: SETTLEMENT_REQUEST_RPC,
      settlement,
      args: settlementRequestArgs({ ledgerId, periodId, settlement }),
    }));
  return {
    snapshot,
    requests,
    close: { rpc: CLOSE_PERIOD_RPC, args: closePeriodArgs({ ledgerId, periodId, snapshot }) },
  };
}

// ── RPC payload builders (shared by seed + dry-run) ──────────────────────────
// These build the exact argument objects the mobile helpers send, so the dry-run
// prints real wire payloads.

export function tripArgs({ ledgerId, openPeriodId, legacyId, driverMemberId, participantMemberIds, trip }) {
  return {
    target_ledger_id: ledgerId,
    target_open_period_id: openPeriodId,
    legacy_trip_id: legacyId,
    driver_member_id: driverMemberId,
    trip_date_value: trip.tripDate,
    start_km_value: trip.startKm,
    end_km_value: trip.endKm,
    note_value: trip.note,
    participant_member_ids: participantMemberIds,
    event_title: "Ny tur logget",
    event_body: `${Math.round(trip.endKm - trip.startKm)} km`,
  };
}

export function fuelArgs({ ledgerId, openPeriodId, legacyId, payerMemberId, fuel }) {
  return {
    target_ledger_id: ledgerId,
    target_open_period_id: openPeriodId,
    legacy_fuel_id: legacyId,
    payer_member_id: payerMemberId,
    payment_date_value: fuel.paymentDate,
    amount_value: fuel.amount,
    currency_value: "DKK",
    liters_value: fuel.liters,
    price_per_liter_value: fuel.pricePerLiter,
    odometer_value: fuel.odometer,
    station_name_value: fuel.stationBrand,
    station_brand_value: fuel.stationBrand,
    // No coordinate slots: migration 151 (GV-400) dropped station_lat/station_lng
    // from fuel_payments and the four accepted-and-ignored coordinate params from
    // this RPC, so an extra key here would be PGRST202 — mirrors supabase-helpers.ts.
    full_tank_value: fuel.fullTank,
    event_title: "Optankning registreret",
    event_body: `${fuel.amount} kr`,
  };
}

export function bookingArgs({ ledgerId, legacyId, bookingMemberId, booking }) {
  return {
    target_ledger_id: ledgerId,
    legacy_booking_id: legacyId,
    booking_member_id: bookingMemberId,
    start_at_value: booking.startAt,
    end_at_value: booking.endAt,
    purpose_value: booking.purpose,
    event_title: "Booking oprettet",
    event_body: booking.purpose ?? "Reserveret",
    fuel_stop_value: null,
  };
}

export function expenseArgs({ ledgerId, openPeriodId, paidByMemberId, expense }) {
  return {
    target_ledger_id: ledgerId,
    target_open_period_id: openPeriodId,
    expense_id_value: null,
    category_value: expense.category,
    description_value: expense.description,
    amount_value: expense.amountDkk,
    expense_date_value: expense.expenseDate,
    split_rule_value: "equal",
    split_config_value: null,
    paid_by_value: paidByMemberId,
    event_title: "Udgift tilføjet",
    event_body: `${expense.amountDkk} kr`,
  };
}

export function recurringArgs({ ledgerId, paidByMemberId, recurring }) {
  return {
    target_ledger_id: ledgerId,
    recurring_id_value: null,
    category_value: recurring.category,
    description_value: recurring.description,
    amount_value: recurring.amountDkk,
    cadence_value: recurring.cadence,
    next_due_date_value: recurring.nextDueDate,
    split_rule_value: "equal",
    split_config_value: null,
    paid_by_value: paidByMemberId,
    is_active_value: true,
    event_title: "Fast udgift oprettet",
    event_body: recurring.description,
  };
}

export function messageArgs({ ledgerId, message }) {
  return { target_ledger_id: ledgerId, body_value: message.body };
}

// ── GV-493: the write paths added since exercise 1 ───────────────────────────

// Migration 201's vehicle document archive. Mirrors govehlo-mobile's
// buildCreateVehicleDocumentArgs / addVehicleDocumentPhoto — three args and two, and the
// photo's `p_` prefixes are the RPC's own, not a typo.
export function vehicleDocumentArgs({ ledgerId, title, expiryDate = null }) {
  return {
    target_ledger_id: ledgerId,
    document_title: title,
    document_expiry: expiryDate,
  };
}

// The storage_path must sit under the literal `<ledger_id>/<document_id>/` prefix — the
// RPC compares it with left(), not LIKE, because a ledger id can contain '_'. The object
// itself is never uploaded from here (see hotpaths.mjs), so this registers a page row
// whose object does not exist: harmless on a throwaway project that is deleted after the
// run, and exactly what govehlo-web's daily orphan sweep exists for in production.
export function vehicleDocumentPhotoArgs({ ledgerId, documentId, token }) {
  return {
    p_document_id: documentId,
    p_storage_path: `${ledgerId}/${documentId}/${token}.jpg`,
  };
}

// Migration 202/207's "Jeg er på vej". The 051/052 pattern: trailing event_title /
// event_body, and the client passes them ONLY on the first call of a share — with a
// title the RPC writes the feed-visible `on_my_way_started`, without one the audit-only
// `on_my_way_updated`. Passing a title on every refresh is what turns one drive home
// into eight feed entries, so `first` is not cosmetic.
export function onMyWaySetArgs({ ledgerId, legacyBookingId, etaMinutes, first = true }) {
  return {
    target_ledger_id: ledgerId,
    legacy_booking_id: legacyBookingId,
    eta_minutes: etaMinutes,
    event_title: first ? "På vej" : null,
    event_body: first ? `Ankommer om ca. ${etaMinutes} min.` : null,
  };
}

export function onMyWayClearArgs({ ledgerId, legacyBookingId }) {
  return { target_ledger_id: ledgerId, legacy_booking_id: legacyBookingId };
}

// A future booking for a sharer to be on the way to (GV-493). The fixture's own bookings
// are anchored at 2026-07-01 and every one of them has ENDED by now, and migration 202
// refuses a share on a booking that is over ("Bookingen er slut") — so a run performed
// any time after that window has no eligible booking to share and would report a phase
// that silently did nothing. The harness therefore prefers a real fixture booking the VU
// owns and that is still running, and falls back to creating one through the SAME
// upsert_car_booking RPC the app uses.
//
// The day offset is derived from the VU index so two sharers in one workspace never draw
// the same day — prevent_overlapping_car_bookings would refuse the second — and the whole
// window sits far enough ahead of `now` that a long run cannot outlive it.
export function sharerBookingWindow({ index, now = Date.now() }) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() + 14 + index);
  start.setUTCHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setUTCHours(17, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: end.toISOString(), purpose: "Load rehearsal" };
}

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
export function buildFixturePlan({ seed = 42, workspaces = 20, emailDomain = DEFAULT_EMAIL_DOMAIN } = {}) {
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

    // A few bookings + chat messages for feed/realtime realism.
    const bookings = Array.from({ length: rng.int(1, 4) }, () => {
      const memberSlot = rng.int(0, size - 1);
      const dayOffset = rng.int(1, 20);
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

  return { seed, emailDomain, totalUsers, workspaceCount: workspaces, users, workspaces: workspacePlans };
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

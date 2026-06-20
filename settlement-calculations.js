// Settlement and payment calculation helpers.
// Loaded before app.js; functions intentionally remain global for the current non-module app.

function calculateLedger() {
  const members = getKnownMembers();
  const people = createPeopleLedger(members);
  const trips = getStateArray("trips");
  const fuelPayments = getStateArray("fuel");

  for (const trip of trips) {
    applyTripToPeopleLedger(people, trip);
  }

  for (const fuel of fuelPayments) {
    applyFuelToPeopleLedger(people, fuel);
  }

  const totalTripKm = calculateTotalTripKm(trips);
  const fuelByPerson = createZeroMap(members);
  const fuelLitersByPerson = createZeroMap(members);
  for (const fuel of fuelPayments) {
    if (fuelByPerson[fuel.payer] !== undefined) {
      fuelByPerson[fuel.payer] = roundMoney(fuelByPerson[fuel.payer] + safeNumber(fuel.amount));
      fuelLitersByPerson[fuel.payer] = round(fuelLitersByPerson[fuel.payer] + safeNumber(fuel.liters));
    }
  }
  const totalFuelLiters = round(Object.values(fuelLitersByPerson).reduce((sum, liters) => sum + safeNumber(liters), 0));
  const totalReceiptFuelPaid = roundMoney(fuelPayments.reduce((sum, fuel) => sum + knownMemberAmount(fuel, members), 0));
  const receiptPricePerLiter = totalFuelLiters > 0 ? roundMoney(totalReceiptFuelPaid / totalFuelLiters) : 0;
  const receiptConsumption = totalFuelLiters > 0 && totalTripKm > 0 ? round(totalFuelLiters / totalTripKm * 100) : 0;
  const receiptKmPerLiter = totalFuelLiters > 0 && totalTripKm > 0 ? round(totalTripKm / totalFuelLiters) : 0;

  let totalKm = 0;
  let totalPaid = 0;

  for (const person of Object.values(people)) {
    person.km = round(person.km);
    person.fuelPaid = roundMoney(person.fuelPaid);
    totalKm += person.km;
    totalPaid += person.fuelPaid;
  }

  const fuelRate = totalKm > 0 ? totalPaid / totalKm : 0;
  const tripCostsByPerson = allocateRoundedMoney(
    Object.entries(people).map(([name, person]) => ({ name, amount: person.km * fuelRate })),
    totalKm > 0 ? totalPaid : 0
  );
  let totalCost = 0;

  for (const [name, person] of Object.entries(people)) {
    person.tripCost = tripCostsByPerson[name] || 0;
    person.net = roundMoney(person.fuelPaid - person.tripCost);
    totalCost += person.tripCost;
  }

  const fuelEstimate = calculateFuelEstimate({ totalTripKm: round(totalTripKm), totalPaid: roundMoney(totalPaid) });
  const historicalFuelStats = calculateHistoricalFuelStats({
    currentTrips: trips,
    currentFuel: fuelPayments
  });

  return {
    people,
    totalTripKm,
    totalShareKm: round(totalKm),
    totalKm: round(totalKm),
    fuelByPerson,
    fuelLitersByPerson,
    totalFuelLiters,
    receiptPricePerLiter,
    receiptConsumption,
    receiptKmPerLiter,
    historicalFuelStats,
    fuelPayments: [...fuelPayments].sort(byNewest),
    fuelEstimate,
    fuelRate,
    totalCost: roundMoney(totalCost),
    totalPaid: roundMoney(totalPaid),
    period: getLedgerPeriod(),
    settlements: buildSettlements(people)
  };
}

function getKnownMembers() {
  return Array.isArray(state.members) ? state.members.filter((member) => typeof member === "string" && member.trim()) : [];
}

function getStateArray(key) {
  return Array.isArray(state[key]) ? state[key] : [];
}

function createZeroMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function createPeopleLedger(members) {
  return Object.fromEntries(
    members.map((member) => [
      member,
      {
        km: 0,
        tripCost: 0,
        fuelPaid: 0,
        net: 0
      }
    ])
  );
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function calculateTripKm(trip) {
  return Math.max(0, safeNumber(trip?.endKm) - safeNumber(trip?.startKm));
}

function calculateTotalTripKm(trips) {
  return round(trips.reduce((sum, trip) => sum + calculateTripKm(trip), 0));
}

function getKnownTripParticipants(trip, people) {
  return getTripParticipants(trip).filter((member) => people[member]);
}

function applyTripToPeopleLedger(people, trip) {
  const km = calculateTripKm(trip);
  const participants = getKnownTripParticipants(trip, people);
  const assignedMembers = participants.length > 0 ? participants : [trip?.driver].filter((member) => people[member]);
  if (assignedMembers.length === 0) return;

  const shareKm = km / assignedMembers.length;
  for (const participant of assignedMembers) {
    people[participant].km += shareKm;
  }
}

function applyFuelToPeopleLedger(people, fuel) {
  if (people[fuel?.payer]) {
    people[fuel.payer].fuelPaid += safeNumber(fuel.amount);
  }
}

function knownMemberAmount(fuel, members) {
  return members.includes(fuel?.payer) ? safeNumber(fuel.amount) : 0;
}


function allocateRoundedMoney(items, expectedTotal) {
  const targetCents = moneyToCents(expectedTotal);
  const normalized = Array.isArray(items) ? items : [];
  if (targetCents <= 0 || normalized.length === 0) {
    return Object.fromEntries(normalized.map((item) => [item.name, 0]));
  }

  const rows = normalized.map((item, index) => {
    const rawCents = Math.max(0, safeNumber(item?.amount) * 100);
    const floorCents = Math.floor(rawCents);
    return {
      name: item?.name,
      index,
      cents: floorCents,
      remainder: rawCents - floorCents
    };
  });

  let assignedCents = rows.reduce((sum, row) => sum + row.cents, 0);
  let centsToAssign = targetCents - assignedCents;

  if (centsToAssign > 0) {
    const byRemainder = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let i = 0; i < centsToAssign; i += 1) {
      byRemainder[i % byRemainder.length].cents += 1;
    }
  } else if (centsToAssign < 0) {
    const bySmallestRemainder = [...rows].sort((a, b) => a.remainder - b.remainder || b.index - a.index);
    for (let i = 0; i < Math.abs(centsToAssign); i += 1) {
      const row = bySmallestRemainder[i % bySmallestRemainder.length];
      if (row.cents > 0) row.cents -= 1;
    }
  }

  return Object.fromEntries(rows.map((row) => [row.name, centsToMoney(row.cents)]));
}

function moneyToCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function centsToMoney(cents) {
  // Removing .toFixed(2) returns this back into a Number for the tests
  return Math.round(cents) / 100;
}

function calculateHistoricalFuelStats({ currentTrips = [], currentFuel = [] } = {}) {
  const periods = [
    { trips: currentTrips, fuel: currentFuel },
    ...(Array.isArray(state.closedPeriods) ? state.closedPeriods : []).map((period) => ({
      trips: Array.isArray(period.trips) ? period.trips : [],
      fuel: Array.isArray(period.fuel) ? period.fuel : [],
      totalTripKm: Number(period.totalTripKm || 0),
      totalPaid: Number(period.totalPaid || 0)
    }))
  ];

  let totalTripKm = 0;
  let totalPaid = 0;
  let totalLiters = 0;
  let totalAmountWithLiters = 0;
  let fuelLogsWithLiters = 0;
  let periodsWithTripKm = 0;
  let periodsWithLiters = 0;

  for (const period of periods) {
    const trips = Array.isArray(period.trips) ? period.trips : [];
    const fuel = Array.isArray(period.fuel) ? period.fuel : [];
    const periodTripKm = safeNumber(period.totalTripKm || trips.reduce((sum, trip) => sum + calculateTripKm(trip), 0));
    const periodPaid = safeNumber(period.totalPaid || fuel.reduce((sum, item) => sum + safeNumber(item.amount), 0));
    const periodLiters = fuel.reduce((sum, item) => sum + safeNumber(item.liters), 0);

    if (periodTripKm > 0) {
      totalTripKm += periodTripKm;
      totalPaid += periodPaid;
      periodsWithTripKm += 1;
    }

    if (periodTripKm > 0 && periodLiters > 0) {
      totalLiters += periodLiters;
      periodsWithLiters += 1;
    }

    for (const item of fuel) {
      const liters = safeNumber(item.liters);
      const amount = safeNumber(item.amount);
      if (liters > 0 && amount > 0) {
        totalAmountWithLiters += amount;
        fuelLogsWithLiters += 1;
      }
    }
  }

  return {
    totalTripKm: round(totalTripKm),
    totalPaid: roundMoney(totalPaid),
    totalLiters: round(totalLiters),
    costPerKm: totalTripKm > 0 ? roundMoney(totalPaid / totalTripKm) : 0,
    pricePerLiter: totalLiters > 0 ? roundMoney(totalAmountWithLiters / totalLiters) : 0,
    litersPer100Km: totalLiters > 0 && totalTripKm > 0 ? round(totalLiters / totalTripKm * 100) : 0,
    kmPerLiter: totalLiters > 0 && totalTripKm > 0 ? round(totalTripKm / totalLiters) : 0,
    fuelLogsWithLiters,
    periodsWithTripKm,
    periodsWithLiters
  };
}


function summarizeSettlementProgress(settlements, statusForSettlement) {
  const list = Array.isArray(settlements) ? settlements : [];
  return list.reduce(
    (acc, item) => {
      const amount = Math.max(0, safeNumber(item?.amount));
      const status = normalizePaymentStatus(typeof statusForSettlement === "function" ? statusForSettlement(item) : item?.status);
      acc.totalCount += 1;
      acc.totalAmount = roundMoney(acc.totalAmount + amount);
      if (status === "paid") {
        acc.paidCount += 1;
        acc.paidAmount = roundMoney(acc.paidAmount + amount);
      } else if (status === "requested") {
        acc.requestedCount += 1;
        acc.requestedAmount = roundMoney(acc.requestedAmount + amount);
      } else {
        acc.openCount += 1;
        acc.openAmount = roundMoney(acc.openAmount + amount);
      }
      return acc;
    },
    { totalCount: 0, totalAmount: 0, requestedCount: 0, requestedAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 }
  );
}

function calculateFuelEstimate(ledger) {
  const totalTripKm = safeNumber(ledger.totalTripKm);
  const totalPaid = safeNumber(ledger.totalPaid);
  const consumption = Math.max(0.1, safeNumber(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, safeNumber(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? safeNumber(latestFuelPrice.price) : 0;
  const pricePerLiter = livePrice || fallbackPrice;
  const source = livePrice ? "live" : "fallback";
  const threshold = Math.min(100, Math.max(1, safeNumber(state.fuelWarningThreshold) || defaults.fuelWarningThreshold));
  const highThreshold = 140;
  const liters = totalTripKm * consumption / 100;
  const expectedCost = roundMoney(liters * pricePerLiter);
  const coveragePercent = expectedCost > 0 ? round(totalPaid / expectedCost * 100) : 100;
  const minimumRequired = expectedCost * threshold / 100;
  const maximumExpected = expectedCost * highThreshold / 100;
  const missingAmount = expectedCost > 0 && totalPaid < minimumRequired ? roundMoney(minimumRequired - totalPaid) : 0;
  const excessAmount = expectedCost > 0 && totalPaid > maximumExpected ? roundMoney(totalPaid - maximumExpected) : 0;
  const warningLevel = missingAmount > 0 ? "low" : excessAmount > 0 ? "high" : "ok";
  return {
    hasEstimate: totalTripKm > 0 && pricePerLiter > 0 && consumption > 0,
    consumption,
    pricePerLiter,
    source,
    expectedCost,
    coveragePercent,
    threshold,
    highThreshold,
    minimumRequired: roundMoney(minimumRequired),
    maximumExpected: roundMoney(maximumExpected),
    missingAmount,
    excessAmount,
    warningLevel
  };
}

function buildSettlements(people) {
  const debtors = [];
  const creditors = [];

  for (const [name, person] of Object.entries(people)) {
    if (person.net < -0.005) debtors.push({ name, amount: Math.abs(person.net) });
    if (person.net > 0.005) creditors.push({ name, amount: person.net });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = roundMoney(Math.min(debtor.amount, creditor.amount));

    if (amount > 0) {
      settlements.push({ from: debtor.name, to: creditor.name, amount });
    }

    debtor.amount = roundMoney(debtor.amount - amount);
    creditor.amount = roundMoney(creditor.amount - amount);

    if (debtor.amount <= 0.005) debtorIndex += 1;
    if (creditor.amount <= 0.005) creditorIndex += 1;
  }

  return settlements;
}

function getTripParticipants(trip) {
  if (Array.isArray(trip.participants) && trip.participants.length > 0) {
    return [...new Set(trip.participants)];
  }

  return trip.driver ? [trip.driver] : [];
}

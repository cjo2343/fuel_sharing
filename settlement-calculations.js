// Settlement and payment calculation helpers.
// Loaded before app.js; functions intentionally remain global for the current non-module app.

function calculateLedger() {
  const people = Object.fromEntries(
    state.members.map((member) => [
      member,
      {
        km: 0,
        tripCost: 0,
        fuelPaid: 0,
        net: 0
      }
    ])
  );

  for (const trip of state.trips) {
    const km = trip.endKm - trip.startKm;
    const participants = getTripParticipants(trip).filter((member) => people[member]);
    const shareKm = participants.length > 0 ? km / participants.length : km;

    for (const participant of participants.length > 0 ? participants : [trip.driver]) {
      if (people[participant]) people[participant].km += shareKm;
    }
  }

  for (const fuel of state.fuel) {
    people[fuel.payer].fuelPaid += fuel.amount;
  }

  const totalTripKm = round(
    state.trips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm) - Number(trip.startKm)), 0)
  );
  const fuelByPerson = Object.fromEntries(state.members.map((member) => [member, 0]));
  const fuelLitersByPerson = Object.fromEntries(state.members.map((member) => [member, 0]));
  for (const fuel of state.fuel) {
    if (fuelByPerson[fuel.payer] !== undefined) {
      fuelByPerson[fuel.payer] = roundMoney(fuelByPerson[fuel.payer] + Number(fuel.amount || 0));
      fuelLitersByPerson[fuel.payer] = round(fuelLitersByPerson[fuel.payer] + Number(fuel.liters || 0));
    }
  }
  const totalFuelLiters = round(Object.values(fuelLitersByPerson).reduce((sum, liters) => sum + Number(liters || 0), 0));
  const receiptPricePerLiter = totalFuelLiters > 0 ? roundMoney(state.fuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0) / totalFuelLiters) : 0;
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
  let totalCost = 0;

  for (const person of Object.values(people)) {
    person.tripCost = roundMoney(person.km * fuelRate);
    person.net = roundMoney(person.fuelPaid - person.tripCost);
    totalCost += person.tripCost;
  }

  const fuelEstimate = calculateFuelEstimate({ totalTripKm: round(totalTripKm), totalPaid: roundMoney(totalPaid) });
  const historicalFuelStats = calculateHistoricalFuelStats({
    currentTrips: state.trips,
    currentFuel: state.fuel
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
    fuelPayments: [...state.fuel].sort(byNewest),
    fuelEstimate,
    fuelRate,
    totalCost: roundMoney(totalCost),
    totalPaid: roundMoney(totalPaid),
    period: getLedgerPeriod(),
    settlements: buildSettlements(people)
  };
}

function calculateHistoricalFuelStats({ currentTrips = [], currentFuel = [] } = {}) {
  const periods = [
    { trips: currentTrips, fuel: currentFuel },
    ...state.closedPeriods.map((period) => ({
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
    const periodTripKm = Number(period.totalTripKm || trips.reduce((sum, trip) => {
      return sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    }, 0));
    const periodPaid = Number(period.totalPaid || fuel.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const periodLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);

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
      const liters = Number(item.liters || 0);
      const amount = Number(item.amount || 0);
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

function calculateFuelEstimate(ledger) {
  const totalTripKm = Number(ledger.totalTripKm || 0);
  const totalPaid = Number(ledger.totalPaid || 0);
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? Number(latestFuelPrice.price) : 0;
  const pricePerLiter = livePrice || fallbackPrice;
  const source = livePrice ? "live" : "fallback";
  const threshold = Math.min(100, Math.max(1, Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold));
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

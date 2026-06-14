// Shared ledger data model typedefs and small shape helpers.
// Loaded before data-store/app modules; functions intentionally remain framework-neutral.

/**
 * @typedef {Object} MemberProfile
 * @property {string=} email
 * @property {boolean=} active
 * @property {boolean=} isAdmin
 * @property {string=} displayName
 */

/**
 * @typedef {Object} TripEntry
 * @property {string=} id
 * @property {string} driver
 * @property {string=} date
 * @property {number|string} startKm
 * @property {number|string} endKm
 * @property {string[]=} participants
 * @property {string=} note
 * @property {string=} bookingId
 */

/**
 * @typedef {Object} FuelEntry
 * @property {string=} id
 * @property {string} payer
 * @property {string=} date
 * @property {number|string} amount
 * @property {number|string=} liters
 * @property {number|string=} odometer
 * @property {string=} station
 * @property {boolean=} fullTank
 * @property {{ latitude: number, longitude: number }|null=} location
 * @property {{ name?: string, brand?: string, latitude?: number, longitude?: number }|null=} stationInfo
 * @property {"station-only"|"no-coordinates"|"full"=} locationPrivacyMode
 */

/**
 * @typedef {Object} BookingEntry
 * @property {string=} id
 * @property {string} member
 * @property {string} start
 * @property {string} end
 * @property {string=} purpose
 * @property {string=} status
 */

/**
 * @typedef {Object} SettlementPayment
 * @property {string} from
 * @property {string} to
 * @property {number|string} amount
 */

/**
 * @typedef {Object} ClosedPeriod
 * @property {string=} id
 * @property {string=} closedAt
 * @property {TripEntry[]=} trips
 * @property {FuelEntry[]=} fuel
 * @property {SettlementPayment[]=} settlements
 * @property {number|string=} totalTripKm
 * @property {number|string=} totalPaid
 */

/**
 * @typedef {Object} LedgerState
 * @property {string[]} members
 * @property {TripEntry[]} trips
 * @property {FuelEntry[]} fuel
 * @property {BookingEntry[]} bookings
 * @property {ClosedPeriod[]} closedPeriods
 * @property {Record<string, MemberProfile>=} memberProfiles
 * @property {Record<string, string>=} paymentStatuses
 */

(function () {
  const COLLECTION_KEYS = Object.freeze(["members", "trips", "fuel", "bookings", "closedPeriods"]);
  const RECORD_KEYS = Object.freeze(["memberProfiles", "paymentStatuses"]);

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asRecord(value) {
    return isPlainObject(value) ? value : {};
  }

  function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number);
  }

  function memberNamesFromState(state) {
    return asArray(state?.members).filter(nonEmptyString).map((member) => member.trim());
  }

  function uniqueMemberNamesFromState(state) {
    return [...new Set(memberNamesFromState(state))];
  }

  function collectionFromState(state, key) {
    return COLLECTION_KEYS.includes(key) ? asArray(state?.[key]) : [];
  }

  function recordFromState(state, key) {
    return RECORD_KEYS.includes(key) ? asRecord(state?.[key]) : {};
  }

  function summarizeStateShape(state) {
    return {
      members: collectionFromState(state, "members").length,
      uniqueMembers: uniqueMemberNamesFromState(state).length,
      trips: collectionFromState(state, "trips").length,
      fuel: collectionFromState(state, "fuel").length,
      bookings: collectionFromState(state, "bookings").length,
      closedPeriods: collectionFromState(state, "closedPeriods").length,
      memberProfiles: Object.keys(recordFromState(state, "memberProfiles")).length,
      paymentStatuses: Object.keys(recordFromState(state, "paymentStatuses")).length
    };
  }

  function validateCoreStateShape(state) {
    const errors = [];
    if (!isPlainObject(state)) {
      return { ok: false, errors: ["Ledger state must be an object."], summary: summarizeStateShape({}) };
    }

    for (const key of COLLECTION_KEYS) {
      if (state[key] !== undefined && !Array.isArray(state[key])) {
        errors.push(`State field \"${key}\" must be an array when present.`);
      }
    }
    for (const key of RECORD_KEYS) {
      if (state[key] !== undefined && !isPlainObject(state[key])) {
        errors.push(`State field \"${key}\" must be an object when present.`);
      }
    }

    const members = memberNamesFromState(state);
    if (members.length === 0) errors.push("State must include at least one named member.");
    if (new Set(members).size !== members.length) errors.push("State members must be unique after trimming whitespace.");

    for (const [index, trip] of collectionFromState(state, "trips").entries()) {
      if (!isPlainObject(trip)) {
        errors.push(`Trip #${index + 1} must be an object.`);
        continue;
      }
      if (trip.startKm !== undefined && !finiteNumber(trip.startKm)) errors.push(`Trip #${index + 1} startKm must be numeric when present.`);
      if (trip.endKm !== undefined && !finiteNumber(trip.endKm)) errors.push(`Trip #${index + 1} endKm must be numeric when present.`);
      if (trip.participants !== undefined && !Array.isArray(trip.participants)) errors.push(`Trip #${index + 1} participants must be an array when present.`);
    }

    for (const [index, fuel] of collectionFromState(state, "fuel").entries()) {
      if (!isPlainObject(fuel)) {
        errors.push(`Fuel entry #${index + 1} must be an object.`);
        continue;
      }
      if (fuel.amount !== undefined && !finiteNumber(fuel.amount)) errors.push(`Fuel entry #${index + 1} amount must be numeric when present.`);
      if (fuel.liters !== undefined && fuel.liters !== "" && !finiteNumber(fuel.liters)) errors.push(`Fuel entry #${index + 1} liters must be numeric when present.`);
      if (fuel.odometer !== undefined && fuel.odometer !== "" && !finiteNumber(fuel.odometer)) errors.push(`Fuel entry #${index + 1} odometer must be numeric when present.`);
    }

    return { ok: errors.length === 0, errors, summary: summarizeStateShape(state) };
  }

  window.FuelLedgerModel = Object.freeze({
    COLLECTION_KEYS,
    RECORD_KEYS,
    isPlainObject,
    asArray,
    asRecord,
    nonEmptyString,
    finiteNumber,
    memberNamesFromState,
    uniqueMemberNamesFromState,
    collectionFromState,
    recordFromState,
    summarizeStateShape,
    validateCoreStateShape
  });
})();

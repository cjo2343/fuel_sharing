(function () {
  // 1. Configure localForage to prefer IndexedDB (only if in a real browser)
  if (typeof localforage !== 'undefined') {
    localforage.config({
      name: 'FuelLedger',
      storeName: 'app_state',
      description: 'Offline storage for Fuel Ledger data'
    });
  }

  // 2. Make load async and include the legacy migration path
  async function loadLocalState({ storageKey, defaults, normalizeState }) {
    try {
      let saved = await localforage.getItem(storageKey);

      // Legacy Migration: If IndexedDB is empty, check localStorage
      if (saved === null) {
        const legacyData = window.localStorage.getItem(storageKey);
        if (legacyData !== null) {
          saved = JSON.parse(legacyData);
          // Migrate to IndexedDB and clean up localStorage so we don't hold double data
          await localforage.setItem(storageKey, saved);
          window.localStorage.removeItem(storageKey);
        }
      }

      return normalizeState(saved || structuredClone(defaults));
    } catch (error) {
      console.error("IndexedDB load failed, falling back to defaults:", error);
      return structuredClone(defaults);
    }
  }

  // 3. Make saves async and wrap in try/catch to prevent quota crashes
  async function saveLocalState({ storageKey, state, afterSave }) {
    try {
      await localforage.setItem(storageKey, state);
      if (typeof afterSave === "function") afterSave();
    } catch (error) {
      console.error("IndexedDB save failed (Quota Exceeded?):", error);
    }
  }

  async function writeLocalState({ storageKey, state }) {
    try {
      await localforage.setItem(storageKey, state);
    } catch (error) {
      console.error("IndexedDB write blocked:", error);
    }
  }

  function makeClientId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createRemoteSaveQueue(saveRemoteState, delayMs = 250) {
    let timer;
    let inFlight = false;
    let rerunRequested = false;

    function runRemoteSave() {
      timer = null;
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      inFlight = true;
      Promise.resolve()
        .then(() => saveRemoteState())
        .catch((error) => {
          console.error("Queued remote save failed", error);
        })
        .finally(() => {
          inFlight = false;
          if (rerunRequested) {
            rerunRequested = false;
            queueRemoteSave();
          }
        });
    }

    function queueRemoteSave() {
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(runRemoteSave, delayMs);
    }
    queueRemoteSave.cancel = function cancelRemoteSave() {
      window.clearTimeout(timer);
      timer = null;
      rerunRequested = false;
    };
    return queueRemoteSave;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }


// 4. Secure the Backup Validation (XSS Prevention)
  function validateBackupPayload(parsed) {
    const errors = [];
    const warnings = [];
    if (!isPlainObject(parsed)) {
      return { ok: false, state: null, errors: ["Backup must be a JSON object."], warnings };
    }

    const candidate = isPlainObject(parsed.state) ? parsed.state : parsed;
    if (!isPlainObject(candidate)) {
      return { ok: false, state: null, errors: ["Backup state must be a JSON object."], warnings };
    }

    if (!Array.isArray(candidate.members) || candidate.members.length === 0) {
      errors.push("Backup must include at least one member.");
    } else {
      const seen = new Set();
      candidate.members.forEach((member, index) => {
        const name = typeof member === "string" ? member.trim() : "";
        if (!name) errors.push(`Member #${index + 1} must have a name.`);
        if (name && seen.has(name)) errors.push(`Member "${name}" appears more than once.`);
        seen.add(name);
      });
    }

    for (const key of ["trips", "fuel", "bookings", "closedPeriods"]) {
      if (candidate[key] !== undefined && !Array.isArray(candidate[key])) {
        errors.push(`Backup field "${key}" must be an array when present.`);
      }
    }

    const knownMembers = new Set(Array.isArray(candidate.members) ? candidate.members.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()) : []);

    if (Array.isArray(candidate.trips)) {
      candidate.trips.forEach((trip, index) => {
        if (!isPlainObject(trip)) {
          errors.push(`Trip #${index + 1} must be an object.`);
          return;
        }
        const startKm = Number(trip.startKm);
        const endKm = Number(trip.endKm);
        if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) {
          errors.push(`Trip #${index + 1} must have numeric start and end odometer values.`);
        } else if (endKm < startKm) {
          errors.push(`Trip #${index + 1} ends before it starts on the odometer.`);
        }
        if (trip.driver && !knownMembers.has(String(trip.driver).trim())) {
          warnings.push(`Trip #${index + 1} has an unknown driver: ${trip.driver}.`);
        }
        // --- RESTORED PARTICIPANTS VALIDATION ---
        if (trip.participants !== undefined && !Array.isArray(trip.participants)) {
          errors.push(`Trip #${index + 1} participants must be an array when present.`);
        }
      });
    }

    if (Array.isArray(candidate.fuel)) {
      candidate.fuel.forEach((fuel, index) => {
        if (!isPlainObject(fuel)) {
          errors.push(`Fuel entry #${index + 1} must be an object.`);
          return;
        }
        const amount = Number(fuel.amount);
        if (!Number.isFinite(amount) || amount < 0) {
          errors.push(`Fuel entry #${index + 1} must have a non-negative numeric amount.`);
        }
        if (fuel.liters !== undefined && fuel.liters !== "") {
          const liters = Number(fuel.liters);
          if (!Number.isFinite(liters) || liters < 0) errors.push(`Fuel entry #${index + 1} liters must be a non-negative number when present.`);
        }
        if (fuel.payer && !knownMembers.has(String(fuel.payer).trim())) {
          warnings.push(`Fuel entry #${index + 1} has an unknown payer: ${fuel.payer}.`);
        }
      });
    }

    if (Array.isArray(candidate.closedPeriods)) {
      candidate.closedPeriods.forEach((period, index) => {
        if (!isPlainObject(period)) {
          errors.push(`Closed period #${index + 1} must be an object.`);
          return;
        }
        for (const key of ["trips", "fuel", "settlements", "auditLog"]) {
          if (period[key] !== undefined && !Array.isArray(period[key])) {
            errors.push(`Closed period #${index + 1} field "${key}" must be an array when present.`);
          }
        }
      });
    }

    if (errors.length > 0) {
        return { ok: false, state: null, errors, warnings };
    }

    // 5. Build a STRICT sanitized copy of the state
    const sanitizedState = {
        currency: String(candidate.currency || "DKK"),
        members: candidate.members.map(m => String(m).trim()),
        memberProfiles: isPlainObject(candidate.memberProfiles) ? candidate.memberProfiles : {},
        paymentStatuses: isPlainObject(candidate.paymentStatuses) ? candidate.paymentStatuses : {},
        lastOdometer: candidate.lastOdometer ? Number(candidate.lastOdometer) : "",
        fuelType: String(candidate.fuelType || "diesel"),
        fuelConsumption: Number(candidate.fuelConsumption || 5.3),
        fuelTankCapacity: Number(candidate.fuelTankCapacity || 55),
        fuelFallbackPrice: Number(candidate.fuelFallbackPrice || 14.5),
        fuelWarningThreshold: Number(candidate.fuelWarningThreshold || 70),

        trips: (candidate.trips || []).map(t => ({
            ...t,
            note: t.note ? String(t.note).slice(0, 1000) : "",
            participants: Array.isArray(t.participants) ? t.participants : [] // Pass through participants safely
        })),
        fuel: (candidate.fuel || []).map(f => ({
            ...f,
            station_name: f.station_name ? String(f.station_name).slice(0, 200) : ""
        })),
        bookings: Array.isArray(candidate.bookings) ? candidate.bookings : [],
        closedPeriods: Array.isArray(candidate.closedPeriods) ? candidate.closedPeriods : []
    };

    return { ok: true, state: sanitizedState, errors: [], warnings };
  }

  window.FuelDataStore = {
    loadLocalState,
    saveLocalState,
    writeLocalState,
    makeClientId,
    createRemoteSaveQueue,
    validateBackupPayload
  };
})();

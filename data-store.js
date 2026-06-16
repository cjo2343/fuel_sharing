(function () {
  function loadLocalState({ storageKey, defaults, normalizeState }) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return normalizeState(saved);
    } catch (error) {
      return structuredClone(defaults);
    }
  }

  function saveLocalState({ storageKey, state, afterSave }) {
    localStorage.setItem(storageKey, JSON.stringify(state));
    if (typeof afterSave === "function") afterSave();
  }

  function writeLocalState({ storageKey, state }) {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function makeClientId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createRemoteSaveQueue(saveRemoteState, delayMs = 250) {
    let timer;
    function queueRemoteSave() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        saveRemoteState();
      }, delayMs);
    }
    queueRemoteSave.cancel = function cancelRemoteSave() {
      window.clearTimeout(timer);
      timer = null;
    };
    return queueRemoteSave;
  }



  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

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
        if (name && seen.has(name)) errors.push(`Member \"${name}\" appears more than once.`);
        seen.add(name);
      });
    }

    for (const key of ["trips", "fuel", "bookings", "closedPeriods"]) {
      if (candidate[key] !== undefined && !Array.isArray(candidate[key])) {
        errors.push(`Backup field \"${key}\" must be an array when present.`);
      }
    }

    if (candidate.memberProfiles !== undefined && !isPlainObject(candidate.memberProfiles)) {
      errors.push('Backup field "memberProfiles" must be an object when present.');
    }
    if (candidate.paymentStatuses !== undefined && !isPlainObject(candidate.paymentStatuses)) {
      errors.push('Backup field "paymentStatuses" must be an object when present.');
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
            errors.push(`Closed period #${index + 1} field \"${key}\" must be an array when present.`);
          }
        }
      });
    }

    return { ok: errors.length === 0, state: candidate, errors, warnings };
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

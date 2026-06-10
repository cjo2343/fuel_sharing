(function () {
  function loadLocalState({ storageKey, defaults, normalizeState }) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return normalizeState(saved);
    } catch {
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
    return function queueRemoteSave() {
      window.clearTimeout(timer);
      timer = window.setTimeout(saveRemoteState, delayMs);
    };
  }

  window.FuelDataStore = {
    loadLocalState,
    saveLocalState,
    writeLocalState,
    makeClientId,
    createRemoteSaveQueue
  };
})();

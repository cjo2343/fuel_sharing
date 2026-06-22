(function () {
  function normalizeWorkspaceUrlId(value) {
    return String(value || "").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  }

  function normalizeWorkspaceIdentifier(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeWorkspaceRole(role) {
    return String(role || "member").trim().toLowerCase() === "admin" ? "admin" : "member";
  }

  function workspaceRoleRank(role) {
    return normalizeWorkspaceRole(role) === "admin" ? 2 : 1;
  }

  function getWorkspaceLedgerIdentityKey(ledger = {}) {
    const directLedgerId = String(ledger.ledger_id || ledger.ledgerId || ledger.workspace_id || ledger.workspaceId || "").trim();
    const slug = String(ledger.slug || ledger.ledger_slug || ledger.workspace_slug || "").trim();
    const name = String(ledger.name || ledger.ledger_name || ledger.workspace_name || "").trim();
    const fallbackId = String(ledger.id || "").trim();
    if (directLedgerId) return directLedgerId;
    if (slug) return slug;
    if (fallbackId && (name || slug || ledger.role || ledger.member_id)) return fallbackId;
    return "";
  }

  function normalizeWorkspaceLedgerRow(ledger = {}) {
    const ledgerId = getWorkspaceLedgerIdentityKey(ledger);
    if (!ledgerId) return null;
    const slug = String(ledger.slug || ledger.ledger_slug || ledger.workspace_slug || ledgerId).trim();
    const name = String(ledger.name || ledger.ledger_name || ledger.workspace_name || slug || ledgerId).trim();
    const memberId = String(ledger.member_id || ledger.memberId || ledger.ledger_member_id || "").trim();
    return {
      ...ledger,
      ledger_id: ledgerId,
      slug,
      name,
      role: normalizeWorkspaceRole(ledger.role),
      member_id: memberId
    };
  }

  function mergeWorkspaceLedgerRows(existing, candidate) {
    if (!existing) return candidate;
    const existingRank = workspaceRoleRank(existing.role);
    const candidateRank = workspaceRoleRank(candidate.role);
    const winner = candidateRank > existingRank ? candidate : existing;
    const loser = winner === candidate ? existing : candidate;
    return {
      ...loser,
      ...winner,
      ledger_id: winner.ledger_id || loser.ledger_id,
      slug: winner.slug || loser.slug,
      name: winner.name || loser.name,
      role: candidateRank > existingRank ? candidate.role : existing.role,
      member_id: winner.member_id || loser.member_id || ""
    };
  }

  function normalizeWorkspaceLedgerList(ledgers = [], options = {}) {
    const configuredLedgerId = String(options.configuredLedgerId || "").trim();
    const byKey = new Map();
    (Array.isArray(ledgers) ? ledgers : []).forEach((rawLedger) => {
      const ledger = normalizeWorkspaceLedgerRow(rawLedger);
      if (!ledger) return;
      const identityParts = [ledger.ledger_id, ledger.slug].map(normalizeWorkspaceIdentifier).filter(Boolean);
      const key = identityParts.find((part) => byKey.has(part)) || normalizeWorkspaceIdentifier(ledger.ledger_id || ledger.slug);
      if (!key) return;
      const merged = mergeWorkspaceLedgerRows(byKey.get(key), ledger);
      const mergedKeys = [merged.ledger_id, merged.slug].map(normalizeWorkspaceIdentifier).filter(Boolean);
      mergedKeys.forEach((mergedKey) => byKey.set(mergedKey, merged));
      byKey.set(key, merged);
    });
    const uniqueByLedgerId = new Map();
    Array.from(byKey.values()).forEach((ledger) => {
      const canonicalKey = normalizeWorkspaceIdentifier(ledger.ledger_id || ledger.slug);
      if (!canonicalKey) return;
      uniqueByLedgerId.set(canonicalKey, mergeWorkspaceLedgerRows(uniqueByLedgerId.get(canonicalKey), ledger));
    });
    return Array.from(uniqueByLedgerId.values()).sort((a, b) => {
      const aPrimary = configuredLedgerId && a.ledger_id === configuredLedgerId ? 0 : 1;
      const bPrimary = configuredLedgerId && b.ledger_id === configuredLedgerId ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return String(a.name || a.slug || a.ledger_id).localeCompare(String(b.name || b.slug || b.ledger_id));
    });
  }

  function getWorkspaceIdentityValues(ledger = {}) {
    return [ledger.ledger_id, ledger.ledgerId, ledger.id, ledger.slug]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
  }

  function getWorkspaceIdentityLookupKeys(value) {
    const rawValue = String(value || "").trim();
    if (!rawValue) return [];
    const urlValue = normalizeWorkspaceUrlId(rawValue);
    return [rawValue, normalizeWorkspaceIdentifier(rawValue), urlValue, normalizeWorkspaceIdentifier(urlValue)]
      .map((key) => String(key || "").trim())
      .filter(Boolean)
      .filter((key, index, keys) => keys.indexOf(key) === index);
  }

  function buildWorkspaceIdentityLookup(ledgers = []) {
    const lookup = new Map();
    ledgers.forEach((ledger) => {
      getWorkspaceIdentityValues(ledger).forEach((value) => {
        getWorkspaceIdentityLookupKeys(value).forEach((key) => {
          if (!lookup.has(key)) lookup.set(key, ledger);
        });
      });
    });
    return lookup;
  }

  function resolveWorkspaceIdentityToLedgerId(value, ledgers = []) {
    const normalized = normalizeWorkspaceUrlId(value || "");
    if (!normalized) return "";
    const lookup = buildWorkspaceIdentityLookup(ledgers);
    const match = getWorkspaceIdentityLookupKeys(value || normalized)
      .map((key) => lookup.get(key))
      .find(Boolean);
    return String(match?.ledger_id || match?.ledgerId || match?.id || normalized).trim();
  }

  function createWorkspaceSessionSnapshot(options = {}) {
    const selectedWorkspaceId = String(options.selectedWorkspaceId || options.configuredLedgerId || "").trim();
    const selectedWorkspaceLabel = String(options.selectedWorkspaceLabel || selectedWorkspaceId || "Current workspace").trim();
    const loadedWorkspaceId = String(options.loadedWorkspaceId || selectedWorkspaceId || options.configuredLedgerId || "").trim();
    const loadedWorkspaceLabel = String(options.loadedWorkspaceLabel || loadedWorkspaceId || "Current workspace").trim();
    const workspaceMismatch = Boolean(selectedWorkspaceId && loadedWorkspaceId && selectedWorkspaceId !== loadedWorkspaceId);
    const loadStatus = options.activeWorkspaceLoadInProgress
      ? "loading"
      : workspaceMismatch
        ? "not_loaded"
        : "loaded";
    return {
      selectedWorkspaceId,
      selectedWorkspaceLabel,
      loadedWorkspaceId,
      loadedWorkspaceLabel,
      workspaceMismatch,
      loadStatus,
      loadStartedAt: Number(options.activeWorkspaceLoadStartedAt || 0),
      loadingLedgerId: String(options.activeWorkspaceLoadLedgerId || "")
    };
  }

  window.FuelWorkspaceSession = Object.freeze({
    normalizeWorkspaceUrlId,
    normalizeWorkspaceIdentifier,
    normalizeWorkspaceRole,
    workspaceRoleRank,
    getWorkspaceLedgerIdentityKey,
    normalizeWorkspaceLedgerRow,
    mergeWorkspaceLedgerRows,
    normalizeWorkspaceLedgerList,
    getWorkspaceIdentityValues,
    getWorkspaceIdentityLookupKeys,
    buildWorkspaceIdentityLookup,
    resolveWorkspaceIdentityToLedgerId,
    createWorkspaceSessionSnapshot
  });
})();

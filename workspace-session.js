(function () {
  "use strict";

  function asText(value) {
    return String(value || "").trim();
  }

  function unique(values) {
    return values
      .map((value) => asText(value))
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
  }

  function normalizeWorkspaceUrlId(value) {
    return asText(value).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  }

  function normalizeWorkspaceIdentifier(value) {
    return asText(value).toLowerCase();
  }

  function normalizeWorkspaceRole(role) {
    return normalizeWorkspaceIdentifier(role || "member") === "admin" ? "admin" : "member";
  }

  function workspaceRoleRank(role) {
    return normalizeWorkspaceRole(role) === "admin" ? 2 : 1;
  }

  function getWorkspaceIdentityValues(ledger) {
    const row = ledger && typeof ledger === "object" ? ledger : {};
    return unique([row.ledger_id, row.ledgerId, row.id, row.slug]);
  }

  function getWorkspaceIdentityLookupKeys(value) {
    const rawValue = asText(value);
    if (!rawValue) return [];
    const urlValue = normalizeWorkspaceUrlId(rawValue);
    return unique([
      rawValue,
      normalizeWorkspaceIdentifier(rawValue),
      urlValue,
      normalizeWorkspaceIdentifier(urlValue)
    ]);
  }

  function buildWorkspaceIdentityLookup(ledgers) {
    const lookup = new Map();
    (Array.isArray(ledgers) ? ledgers : []).forEach((ledger) => {
      getWorkspaceIdentityValues(ledger).forEach((value) => {
        getWorkspaceIdentityLookupKeys(value).forEach((key) => {
          if (!lookup.has(key)) lookup.set(key, ledger);
        });
      });
    });
    return lookup;
  }

  function resolveWorkspaceIdentityToLedgerId(value, ledgers) {
    const normalized = normalizeWorkspaceUrlId(value || "");
    if (!normalized) return "";
    const lookup = buildWorkspaceIdentityLookup(ledgers);
    const match = getWorkspaceIdentityLookupKeys(value || normalized)
      .map((key) => lookup.get(key))
      .find(Boolean);
    return asText(match && (match.ledger_id || match.ledgerId || match.id)) || normalized;
  }

  function getWorkspaceLedgerIdentityKey(ledger) {
    const row = ledger && typeof ledger === "object" ? ledger : {};
    const directLedgerId = asText(row.ledger_id || row.ledgerId || row.workspace_id || row.workspaceId);
    const slug = asText(row.slug || row.ledger_slug || row.workspace_slug);
    const name = asText(row.name || row.ledger_name || row.workspace_name);
    const fallbackId = asText(row.id);
    if (directLedgerId) return directLedgerId;
    if (slug) return slug;
    if (fallbackId && (name || slug || row.role || row.member_id)) return fallbackId;
    return "";
  }

  function normalizeWorkspaceLedgerRow(ledger) {
    const row = ledger && typeof ledger === "object" ? ledger : {};
    const ledgerId = getWorkspaceLedgerIdentityKey(row);
    if (!ledgerId) return null;
    const slug = asText(row.slug || row.ledger_slug || row.workspace_slug || ledgerId);
    const name = asText(row.name || row.ledger_name || row.workspace_name || slug || ledgerId);
    const memberId = asText(row.member_id || row.memberId || row.ledger_member_id);
    return Object.assign({}, row, {
      ledger_id: ledgerId,
      slug,
      name,
      role: normalizeWorkspaceRole(row.role),
      member_id: memberId
    });
  }

  function mergeWorkspaceLedgerRows(existing, candidate) {
    if (!existing) return candidate;
    const existingRank = workspaceRoleRank(existing.role);
    const candidateRank = workspaceRoleRank(candidate.role);
    const winner = candidateRank > existingRank ? candidate : existing;
    const loser = winner === candidate ? existing : candidate;
    return Object.assign({}, loser, winner, {
      ledger_id: winner.ledger_id || loser.ledger_id,
      slug: winner.slug || loser.slug,
      name: winner.name || loser.name,
      role: candidateRank > existingRank ? candidate.role : existing.role,
      member_id: winner.member_id || loser.member_id || ""
    });
  }

  function normalizeWorkspaceLedgerList(ledgers, options) {
    const settings = options && typeof options === "object" ? options : {};
    const configuredLedgerId = asText(settings.configuredLedgerId);
    const byKey = new Map();
    (Array.isArray(ledgers) ? ledgers : []).forEach((rawLedger) => {
      const ledger = normalizeWorkspaceLedgerRow(rawLedger);
      if (!ledger) return;
      const identityParts = [ledger.ledger_id, ledger.slug].map(normalizeWorkspaceIdentifier).filter(Boolean);
      const key = identityParts.find((part) => byKey.has(part)) || normalizeWorkspaceIdentifier(ledger.ledger_id || ledger.slug);
      if (!key) return;
      const existing = byKey.get(key);
      const merged = mergeWorkspaceLedgerRows(existing, ledger);
      const mergedKeys = [
        existing && existing.ledger_id,
        existing && existing.slug,
        ledger.ledger_id,
        ledger.slug,
        merged.ledger_id,
        merged.slug,
        key
      ].map(normalizeWorkspaceIdentifier).filter(Boolean);
      mergedKeys.forEach((mergedKey) => byKey.set(mergedKey, merged));
    });
    return Array.from(new Set(Array.from(byKey.values()))).sort((a, b) => {
      const aPrimary = configuredLedgerId && a.ledger_id === configuredLedgerId ? 0 : 1;
      const bPrimary = configuredLedgerId && b.ledger_id === configuredLedgerId ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return asText(a.name || a.slug || a.ledger_id).localeCompare(asText(b.name || b.slug || b.ledger_id));
    });
  }

  function createWorkspaceSnapshot(meta) {
    const data = meta && typeof meta === "object" ? meta : {};
    const selectedWorkspaceId = asText(data.selectedWorkspaceId || data.activeWorkspaceId || data.configuredLedgerId);
    const selectedWorkspaceLabel = asText(data.selectedWorkspaceLabel || selectedWorkspaceId || "Current workspace");
    const loadedWorkspaceId = asText(data.loadedWorkspaceId || selectedWorkspaceId || data.configuredLedgerId);
    const loadedWorkspaceLabel = asText(data.loadedWorkspaceLabel || loadedWorkspaceId || selectedWorkspaceLabel || "Current workspace");
    const activeWorkspaceLoadInProgress = Boolean(data.activeWorkspaceLoadInProgress);
    const workspaceMismatch = Boolean(selectedWorkspaceId && loadedWorkspaceId && selectedWorkspaceId !== loadedWorkspaceId);
    const loadStatus = activeWorkspaceLoadInProgress ? "loading" : workspaceMismatch ? "not_loaded" : "loaded";
    return {
      selectedWorkspaceId,
      selectedWorkspaceLabel,
      loadedWorkspaceId,
      loadedWorkspaceLabel,
      workspaceMismatch,
      loadStatus,
      loadStartedAt: Number(data.loadStartedAt || 0) || 0,
      loadingLedgerId: asText(data.loadingLedgerId)
    };
  }

  function isWorkspaceWriteScopeAllowed(scope, options) {
    const data = scope && typeof scope === "object" ? scope : {};
    const settings = options && typeof options === "object" ? options : {};
    const reason = asText(settings.reason || data.reason || "save");
    const ledgerId = asText(data.ledgerId);
    const selectedWorkspaceId = asText(data.selectedWorkspaceId);
    const loadedWorkspaceId = asText(data.loadedWorkspaceId);
    if (!ledgerId) return false;
    if (selectedWorkspaceId && selectedWorkspaceId !== ledgerId) return false;
    if (loadedWorkspaceId && loadedWorkspaceId !== ledgerId && !/member-bootstrap|json mirror backup|audit JSON mirror backup|safety backup|backup/i.test(reason)) {
      return false;
    }
    return true;
  }

  function buildDataIoWorkspaceContext(meta) {
    const snapshot = createWorkspaceSnapshot(meta);
    return Object.assign({}, snapshot, {
      ledgerId: snapshot.loadedWorkspaceId,
      workspaceLabel: snapshot.workspaceMismatch
        ? `${snapshot.selectedWorkspaceLabel} · loaded ${snapshot.loadedWorkspaceLabel}`
        : snapshot.loadedWorkspaceLabel
    });
  }

  window.FuelWorkspaceSession = Object.freeze({
    normalizeWorkspaceUrlId,
    normalizeWorkspaceIdentifier,
    normalizeWorkspaceRole,
    workspaceRoleRank,
    getWorkspaceIdentityValues,
    getWorkspaceIdentityLookupKeys,
    buildWorkspaceIdentityLookup,
    resolveWorkspaceIdentityToLedgerId,
    getWorkspaceLedgerIdentityKey,
    normalizeWorkspaceLedgerRow,
    mergeWorkspaceLedgerRows,
    normalizeWorkspaceLedgerList,
    createWorkspaceSnapshot,
    isWorkspaceWriteScopeAllowed,
    buildDataIoWorkspaceContext
  });
})();

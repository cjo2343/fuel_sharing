const storageKey = "car-share-ledger-v1";
const stationSearchRadiusMeters = 2500;
const defaultFuelPriceWarningRange = Object.freeze({
  minDkkPerLiter: 8,
  maxDkkPerLiter: 25
});
const userKey = "car-share-current-user";
const loginCooldownKey = "car-share-login-cooldown-until";
const pendingLoginEmailKey = "car-share-pending-login-email";
const rememberedLoginEmailKey = "car-share-remembered-login-email";
const pendingWorkspaceInviteCodeKey = "fuel-ledger-pending-workspace-invite-code";
const inviteDeepLinkParamNames = Object.freeze(["invite", "invite_code", "workspaceInvite", "workspace_invite"]);
const workspaceUrlParamNames = Object.freeze(["workspace", "ledger"]);
const loginRequestedFromUrl = new URLSearchParams(window.location.search).has("login");
const apiStateUrl = "/api/state";
const pushConfigUrl = "/api/push-config";
const fuelPriceUrl = "/api/fuel-price";
const pushSubscriptionsUrl = "/api/push-subscriptions";
const sendPushUrl = "/api/send-push";
const paymentActionUrl = "/api/payment-action";
const renderPaymentStatusActionUrl = "/api/payments/status-action";
const renderTripUpsertUrl = "/api/trips/upsert";
const renderFuelUpsertUrl = "/api/fuel/upsert";
const renderBookingUpsertUrl = "/api/bookings/upsert";
const renderBookingDeleteUrl = "/api/bookings/delete";
const renderWriteContextUrl = "/api/context/write";
const renderStateLoadUrl = "/api/state/load";
const renderSettingsSaveUrl = "/api/settings/save";
const renderMemberManagementUrl = "/api/members/manage";
const renderLedgerDirectorySyncUrl = "/api/ledgers/sync";
const renderJsonMirrorBackupUrl = "/api/backups/json-mirror";
const renderAdminTestDataCreateUrl = "/api/admin/test-data/create";
const renderAdminTestDataCleanupUrl = "/api/admin/test-data/cleanup";
const renderRetentionPreviewUrl = "/api/admin/retention/preview";
const renderRetentionCleanupUrl = "/api/admin/retention/cleanup";
const renderAdminHealthUrl = "/api/admin/health";
const renderAdminReportSaveUrl = "/api/admin/reports/save";
const renderAdminSecurityHealthUrl = "/api/admin/security-health";
const renderOwnerActivityUrl = "/api/owner/activity";
const renderVehicleLookupUrl = "/api/vehicle/lookup";
const testLabReportCloudSaveTimeoutMs = 35000;
const tripSaveActionTimeoutMs = 15000;
const fuelSaveActionTimeoutMs = 15000;
const bookingSaveActionTimeoutMs = 15000;
const writeContextActionTimeoutMs = 6000;
const normalizedWriteContextTimeoutMs = 10000;
const paymentStatusActionTimeoutMs = 15000;
const paymentStatusActionNormalizedTimeoutMs = 45000;
const paymentStatusActionBackendStartTimeoutMs = 10000;
const mobilePayReturnKey = "fuel-ledger-mobilepay-return";
const securityHealthCooldownMs = 2 * 60 * 1000;
const generatedTestPrefix = "auto-test-";
const generatedTestMarker = "[AUTO TEST]";
const supabaseHelpers = window.FuelSupabaseHelpers;
const supabaseConfig = supabaseHelpers.getSupabaseConfig();
const configuredLedgerId = supabaseHelpers.getLedgerId(supabaseConfig);
const activeWorkspaceStorageKey = "fuel-ledger-active-workspace-id";
const activeWorkspaceStorageKeyPrefix = `${activeWorkspaceStorageKey}:user:`;
let activeLedgerId = readActiveWorkspaceIdFromCurrentUrl() || localStorage.getItem(activeWorkspaceStorageKey) || configuredLedgerId;
let lastWorkspaceResolution = {
  at: new Date().toISOString(),
  reason: "initial",
  decision: "initial-active-ledger",
  requestedWorkspaceId: readActiveWorkspaceIdFromCurrentUrl() || "",
  selectedWorkspaceId: activeLedgerId || configuredLedgerId,
  detail: "Initial active workspace came from URL, legacy memory, or configured default before membership was loaded."
};
supabaseConfig.activeLedgerId = activeLedgerId;
const hasSupabaseConfig = supabaseHelpers.hasUsableSupabaseConfig(supabaseConfig);
const supabaseClient = supabaseHelpers.createSupabaseClient(supabaseConfig);
const dataStore = window.FuelDataStore;
const notifications = window.FuelNotifications;
const auditLog = window.FuelAuditLog;
const testLab = window.FuelTestLab;
const securityHealth = window.FuelSecurityHealth;
const fuelPriceHelpers = window.FuelPriceHelpers;
let lastTestLabReport = null;
let advancedAdminToolsUnlocked = false;
let advancedAdminToolsRelockTimer = null;
const advancedAdminToolsUnlockTtlMs = 15 * 60 * 1000;
let lastStandaloneSecurityHealthAt = 0;
const queueRemoteSave = dataStore.createRemoteSaveQueue(() => saveRemoteState(), 250);
let auditLogDirty = false;
let suppressNextQueuedRemoteSaveReason = "";
let lastRenderJsonMirrorBackupAt = 0;


function optionalRecordValue(record, key) {
  return record && key !== undefined && key !== null ? record[key] : undefined;
}

function getConfiguredLedgerId() {
  return configuredLedgerId || "main-car";
}

function normalizeWorkspaceUrlId(value) {
  return String(value || "").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function readActiveWorkspaceIdFromCurrentUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    for (const name of workspaceUrlParamNames) {
      const value = normalizeWorkspaceUrlId(params.get(name) || "");
      if (value) return value;
    }
  } catch (error) {
    console.warn("Could not read workspace from URL", error);
  }
  return "";
}

function getActiveWorkspaceStorageKeyForEmail(email = "") {
  const normalized = normalizeEmail(email || "");
  return normalized ? `${activeWorkspaceStorageKeyPrefix}${normalized}` : activeWorkspaceStorageKey;
}

function getCurrentUserWorkspaceStorageKey() {
  return getActiveWorkspaceStorageKeyForEmail(getLoggedInEmail());
}

function readScopedRememberedWorkspaceIdForCurrentUser() {
  const scopedKey = getCurrentUserWorkspaceStorageKey();
  return scopedKey ? normalizeWorkspaceUrlId(localStorage.getItem(scopedKey) || "") : "";
}

function readLegacyRememberedWorkspaceId() {
  return normalizeWorkspaceUrlId(localStorage.getItem(activeWorkspaceStorageKey) || "");
}

function readRememberedWorkspaceIdForCurrentUser() {
  const fromUrl = readActiveWorkspaceIdFromCurrentUrl();
  if (fromUrl) return fromUrl;
  const scoped = readScopedRememberedWorkspaceIdForCurrentUser();
  if (scoped) return scoped;
  return readLegacyRememberedWorkspaceId();
}

function updateWorkspaceResolutionDebug(decision = "observed", detail = "", extra = {}) {
  const urlWorkspaceId = readActiveWorkspaceIdFromCurrentUrl();
  const scopedRememberedWorkspaceId = readScopedRememberedWorkspaceIdForCurrentUser();
  const legacyRememberedWorkspaceId = readLegacyRememberedWorkspaceId();
  const linkedWorkspaces = getWorkspaceLedgerOptions().map((ledger) => ({
    ledgerId: String(ledger.ledger_id || ""),
    slug: String(ledger.slug || ""),
    name: String(ledger.name || ""),
    label: getWorkspaceOptionLabel(ledger),
    role: normalizeWorkspaceRole(ledger.role || "member"),
    primary: String(ledger.ledger_id || "") === String(getConfiguredLedgerId() || "")
  }));
  lastWorkspaceResolution = {
    at: new Date().toISOString(),
    reason: String(extra.reason || "workspace-resolution"),
    decision,
    detail,
    signedInEmail: normalizeEmail(getLoggedInEmail() || ""),
    urlWorkspaceId,
    scopedRememberedWorkspaceId,
    legacyRememberedWorkspaceId,
    configuredLedgerId: getConfiguredLedgerId(),
    activeLedgerId: getActiveLedgerId(),
    selectedWorkspaceId: getWorkspaceSessionSnapshot().selectedWorkspaceId,
    loadedWorkspaceId: getWorkspaceSessionSnapshot().loadedWorkspaceId,
    workspaceMismatch: getWorkspaceSessionSnapshot().workspaceMismatch,
    visibleWorkspaceSelectorId: String(els?.activeWorkspace?.value || ""),
    linkedWorkspaceCount: linkedWorkspaces.length,
    linkedWorkspaces,
    rejectedWorkspaceId: String(extra.rejectedWorkspaceId || ""),
    preferredWorkspaceId: String(extra.preferredWorkspaceId || "")
  };
  return lastWorkspaceResolution;
}

function isConfiguredAppOwnerEmail(email = getLoggedInEmail()) {
  const normalized = normalizeEmail(email || "");
  if (!normalized) return false;
  return getConfiguredAppOwnerEmails().includes(normalized);
}

function chooseWorkspaceFromMembership({ reason = "workspace-resolution", preferredLedgerId = "" } = {}) {
  const ledgers = getWorkspaceLedgerOptions();
  if (!supabaseClient || !currentSession || !ledgers.length) {
    updateWorkspaceResolutionDebug("membership-not-loaded", "Workspace membership is not loaded yet; keeping the current active workspace.", { reason });
    return false;
  }
  const linkedIds = new Set(ledgers.map((ledger) => String(ledger.ledger_id || "")).filter(Boolean));
  const nonDefaultLedgers = ledgers.filter((ledger) => String(ledger.ledger_id || "") && String(ledger.ledger_id || "") !== String(getConfiguredLedgerId() || ""));
  const explicitPreferred = normalizeWorkspaceUrlId(preferredLedgerId || "");
  const urlWorkspaceId = readActiveWorkspaceIdFromCurrentUrl();
  const scopedRememberedWorkspaceId = readScopedRememberedWorkspaceIdForCurrentUser();
  const legacyRememberedWorkspaceId = readLegacyRememberedWorkspaceId();
  const activeBefore = getActiveLedgerId();
  const signedInIsAppOwner = isConfiguredAppOwnerEmail();
  let target = "";
  let decision = "keep-current";
  let detail = "Keeping the current active workspace.";
  let rejectedWorkspaceId = "";

  if (explicitPreferred && linkedIds.has(explicitPreferred)) {
    target = explicitPreferred;
    decision = "explicit-preferred-linked";
    detail = `Using explicit preferred workspace ${explicitPreferred}.`;
  } else if (explicitPreferred) {
    rejectedWorkspaceId = explicitPreferred;
  }

  if (!target && urlWorkspaceId && linkedIds.has(urlWorkspaceId)) {
    target = urlWorkspaceId;
    decision = "url-workspace-linked";
    detail = `Using workspace from URL: ${urlWorkspaceId}.`;
  } else if (!target && urlWorkspaceId) {
    rejectedWorkspaceId = urlWorkspaceId;
    decision = "url-workspace-not-linked";
    detail = `URL requested ${urlWorkspaceId}, but it is not linked to the signed-in user.`;
  }

  if (!target && scopedRememberedWorkspaceId && scopedRememberedWorkspaceId !== getConfiguredLedgerId() && linkedIds.has(scopedRememberedWorkspaceId)) {
    target = scopedRememberedWorkspaceId;
    decision = "user-remembered-non-default-linked";
    detail = `Using user-scoped remembered workspace ${scopedRememberedWorkspaceId}.`;
  }

  if (!target && !urlWorkspaceId && !signedInIsAppOwner && nonDefaultLedgers.length === 1) {
    target = String(nonDefaultLedgers[0].ledger_id || "");
    decision = "single-non-default-workspace";
    detail = `Signed-in non-owner has one non-default workspace (${target}); preferring it over the default workspace.`;
  }

  if (!target && scopedRememberedWorkspaceId && linkedIds.has(scopedRememberedWorkspaceId)) {
    target = scopedRememberedWorkspaceId;
    decision = "user-remembered-linked";
    detail = `Using user-scoped remembered workspace ${scopedRememberedWorkspaceId}.`;
  }

  if (!target && legacyRememberedWorkspaceId && linkedIds.has(legacyRememberedWorkspaceId) && !scopedRememberedWorkspaceId) {
    target = legacyRememberedWorkspaceId;
    decision = "legacy-remembered-linked";
    detail = `Using legacy remembered workspace ${legacyRememberedWorkspaceId}.`;
  }

  if (!target && linkedIds.has(activeBefore)) {
    target = activeBefore;
    decision = "current-active-linked";
    detail = `Current active workspace ${activeBefore} is linked; keeping it.`;
  }

  if (!target && ledgers.length === 1) {
    target = String(ledgers[0].ledger_id || "");
    decision = "only-linked-workspace";
    detail = `Only one workspace is linked; using ${target}.`;
  }

  if (!target) {
    const lastConfirmedMatch = ledgers.find((ledger) => String(ledger.ledger_id || "") === String(lastConfirmedWorkspaceLedgerId || ""));
    const fallback = lastConfirmedMatch || ledgers[0];
    target = String(fallback?.ledger_id || getConfiguredLedgerId());
    decision = lastConfirmedMatch ? "last-confirmed-linked" : "first-linked-fallback";
    detail = `Falling back to ${target} after membership resolution.`;
  }

  if (target && target !== activeBefore) {
    setActiveLedgerId(target, { persist: true, updateUrl: true });
    recordSupabaseLoadEvent("workspace-resolution", `${reason}: ${activeBefore || "none"} -> ${target} (${decision})`);
  } else {
    recordSupabaseLoadEvent("workspace-resolution", `${reason}: kept ${target || activeBefore || "none"} (${decision})`);
  }
  updateWorkspaceResolutionDebug(decision, detail, { reason, preferredWorkspaceId: explicitPreferred, rejectedWorkspaceId });
  return target !== activeBefore;
}

function applyWorkspacePreferenceForCurrentUser(reason = "workspace-preference") {
  const preferred = readRememberedWorkspaceIdForCurrentUser();
  if (!preferred || preferred === getActiveLedgerId()) {
    updateWorkspaceResolutionDebug(preferred ? "preference-already-active" : "no-preference", preferred ? `Workspace preference ${preferred} is already active.` : "No URL or remembered workspace preference was found.", { reason, preferredWorkspaceId: preferred });
    return false;
  }
  const previous = getActiveLedgerId();
  setActiveLedgerId(preferred, { persist: true, updateUrl: true });
  updateWorkspaceResolutionDebug("preference-applied-before-membership", `Applied ${preferred} before membership list was loaded.`, { reason, preferredWorkspaceId: preferred });
  recordSupabaseLoadEvent("workspace-preference-applied", `${reason}: ${previous || "none"} -> ${preferred}`);
  return true;
}

function writeActiveWorkspaceToCurrentUrl(ledgerId) {
  if (!window.history || !window.history.replaceState) return;
  const normalized = normalizeWorkspaceUrlId(ledgerId || getConfiguredLedgerId());
  if (!normalized) return;
  try {
    const url = new URL(window.location.href);
    const currentWorkspace = workspaceUrlParamNames.map((name) => normalizeWorkspaceUrlId(url.searchParams.get(name) || "")).find(Boolean) || "";
    workspaceUrlParamNames.forEach((name) => url.searchParams.delete(name));
    url.searchParams.set("workspace", normalized);
    if (currentWorkspace !== normalized || !window.location.search.includes(`workspace=${encodeURIComponent(normalized)}`)) {
      window.history.replaceState(window.history.state, document.title, url.toString());
    }
  } catch (error) {
    console.warn("Could not write workspace to URL", error);
  }
}

function removeWorkspaceScopeFromUrlObject(url) {
  workspaceUrlParamNames.forEach((name) => url.searchParams.delete(name));
  return url;
}

function getActiveLedgerId() {
  return activeLedgerId || getConfiguredLedgerId();
}

function getWorkspaceLabelByLedgerId(ledgerId) {
  const normalized = String(ledgerId || "").trim();
  if (!normalized) return "Current workspace";
  const match = getWorkspaceLedgerOptions().find((ledger) => String(ledger.ledger_id || "") === normalized);
  return match ? getWorkspaceOptionLabel(match) : normalized;
}

function getLoadedWorkspaceId() {
  return String(lastConfirmedWorkspaceLedgerId || getActiveLedgerId() || getConfiguredLedgerId()).trim();
}

function getLoadedWorkspaceLabel() {
  const loadedId = getLoadedWorkspaceId();
  if (lastConfirmedWorkspaceLabel && String(lastConfirmedWorkspaceLedgerId || "") === loadedId) return lastConfirmedWorkspaceLabel;
  return getWorkspaceLabelByLedgerId(loadedId);
}

function getWorkspaceSessionSnapshot(meta = {}) {
  const selectedWorkspaceId = String(meta.selectedWorkspaceId || getActiveLedgerId() || getConfiguredLedgerId()).trim();
  const selectedWorkspaceLabel = String(meta.selectedWorkspaceLabel || getWorkspaceLabelByLedgerId(selectedWorkspaceId)).trim();
  const loadedWorkspaceId = String(meta.loadedWorkspaceId || getLoadedWorkspaceId()).trim();
  const loadedWorkspaceLabel = String(meta.loadedWorkspaceLabel || getLoadedWorkspaceLabel()).trim();
  const workspaceMismatch = Boolean(selectedWorkspaceId && loadedWorkspaceId && selectedWorkspaceId !== loadedWorkspaceId);
  const loadStatus = activeWorkspaceLoadInProgress
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
    loadStartedAt: activeWorkspaceLoadStartedAt || 0,
    loadingLedgerId: activeWorkspaceLoadLedgerId || ""
  };
}

function normalizeWorkspaceRole(role) {
  return String(role || "member").trim().toLowerCase() === "admin" ? "admin" : "member";
}

function workspaceRoleRank(role) {
  return normalizeWorkspaceRole(role) === "admin" ? 2 : 1;
}

function normalizeWorkspaceIdentifier(value) {
  return String(value || "").trim().toLowerCase();
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

function normalizeWorkspaceLedgerList(ledgers = []) {
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
  return Array.from(new Set(Array.from(byKey.values()))).sort((a, b) => {
    const aPrimary = a.ledger_id === getConfiguredLedgerId() ? 0 : 1;
    const bPrimary = b.ledger_id === getConfiguredLedgerId() ? 0 : 1;
    if (aPrimary !== bPrimary) return aPrimary - bPrimary;
    return String(a.name || a.slug || a.ledger_id).localeCompare(String(b.name || b.slug || b.ledger_id));
  });
}

function getWorkspaceLedgerOptions() {
  return normalizeWorkspaceLedgerList(workspaceInviteStatus.ledgers);
}

function isLedgerLinkedToCurrentUser(ledgerId) {
  const normalized = String(ledgerId || "").trim();
  if (!normalized) return false;
  if (!supabaseClient || !currentSession) return normalized === getConfiguredLedgerId();
  return getWorkspaceLedgerOptions().some((ledger) => String(ledger.ledger_id || "") === normalized);
}

function setActiveLedgerId(ledgerId, { persist = true, updateUrl = true } = {}) {
  const normalized = String(ledgerId || getConfiguredLedgerId()).trim() || getConfiguredLedgerId();
  activeLedgerId = normalized;
  supabaseConfig.activeLedgerId = normalized;
  if (persist) {
    const scopedKey = getCurrentUserWorkspaceStorageKey();
    localStorage.setItem(scopedKey, normalized);
    if (scopedKey !== activeWorkspaceStorageKey) {
      localStorage.removeItem(activeWorkspaceStorageKey);
    }
  }
  if (updateUrl) writeActiveWorkspaceToCurrentUrl(normalized);
  return activeLedgerId;
}

function makeWorkspaceScopedStorageKey(ledgerId = getActiveLedgerId()) {
  const safeLedgerId = String(ledgerId || getConfiguredLedgerId()).trim().replace(/[^a-z0-9_-]+/gi, "-") || getConfiguredLedgerId();
  return `${storageKey}:${safeLedgerId}`;
}

function markActiveWorkspaceLoading(reason = "workspace-load") {
  activeWorkspaceLoadInProgress = true;
  activeWorkspaceLoadLedgerId = getActiveLedgerId();
  activeWorkspaceLoadStartedAt = Date.now();
  recordSupabaseLoadEvent("workspace-load-start", `${reason}: ${activeWorkspaceLoadLedgerId}`);
}

function markActiveWorkspaceConfirmed(reason = "workspace-load") {
  activeWorkspaceLoadInProgress = false;
  activeWorkspaceLoadLedgerId = "";
  activeWorkspaceLoadStartedAt = 0;
  lastConfirmedWorkspaceLedgerId = getActiveLedgerId();
  lastConfirmedWorkspaceLabel = getCurrentWorkspaceLabel();
  recordSupabaseLoadEvent("workspace-load-confirmed", `${reason}: ${lastConfirmedWorkspaceLabel}`);
}

function markActiveWorkspaceLoadFailed(reason = "workspace-load") {
  activeWorkspaceLoadInProgress = false;
  activeWorkspaceLoadLedgerId = "";
  activeWorkspaceLoadStartedAt = 0;
  recordSupabaseLoadEvent("workspace-load-delayed", `${reason}: ${getCurrentWorkspaceLabel()}`);
}

function isActiveWorkspaceDataConfirmed() {
  if (!supabaseClient) return true;
  if (!currentSession) return false;
  return !activeWorkspaceLoadInProgress && String(lastConfirmedWorkspaceLedgerId || "") === String(getActiveLedgerId() || "");
}

function workspaceActionBlockedMessage(action = "change this workspace") {
  const session = getWorkspaceSessionSnapshot();
  if (session.workspaceMismatch) {
    return `${session.selectedWorkspaceLabel} is selected, but ${session.loadedWorkspaceLabel} is still loaded. Loading ${session.selectedWorkspaceLabel} before you ${action}.`;
  }
  return `Wait for ${session.selectedWorkspaceLabel} to finish loading before you ${action}.`;
}

function recordWorkspaceActionBlocked(source = "workspace-action", action = "change this workspace") {
  const session = getWorkspaceSessionSnapshot();
  recordDataIoDiagnostic("blocked", {
    source,
    route: "workspace-session",
    operation: "blocked",
    ok: false,
    resultCode: "WORKSPACE_NOT_LOADED",
    statusCode: "WORKSPACE_NOT_LOADED",
    code: "WORKSPACE_NOT_LOADED",
    detail: `${session.selectedWorkspaceLabel} is selected, but ${session.loadedWorkspaceLabel} is still loaded; blocked ${action}.`,
    ledgerId: session.loadedWorkspaceId,
    selectedWorkspaceId: session.selectedWorkspaceId,
    selectedWorkspaceLabel: session.selectedWorkspaceLabel,
    loadedWorkspaceId: session.loadedWorkspaceId,
    loadedWorkspaceLabel: session.loadedWorkspaceLabel,
    workspaceMismatch: session.workspaceMismatch,
    workspaceLabel: session.workspaceMismatch ? `${session.selectedWorkspaceLabel} · loaded ${session.loadedWorkspaceLabel}` : session.loadedWorkspaceLabel
  });
}

function requestActiveWorkspaceReload(reason = "workspace-action-blocked") {
  if (!supabaseClient || !currentSession) return;
  const targetLedgerId = getActiveLedgerId();
  const loadingSameWorkspace = activeWorkspaceLoadInProgress && String(activeWorkspaceLoadLedgerId || "") === String(targetLedgerId || "");
  const loadingAgeMs = activeWorkspaceLoadStartedAt ? Date.now() - Number(activeWorkspaceLoadStartedAt) : 0;
  if (workspaceSessionRecoveryInFlight || supabaseLoadInFlight) return;
  if (activeWorkspaceLoadInProgress && loadingSameWorkspace && loadingAgeMs < 10000) return;
  if (activeWorkspaceLoadInProgress && loadingSameWorkspace && loadingAgeMs >= 10000) {
    recordDataIoDiagnostic("timeout", {
      source: "workspace-session",
      route: "workspace-session",
      operation: "load",
      ok: false,
      resultCode: "WORKSPACE_SESSION_RETRY_AFTER_STALE_LOADING",
      statusCode: "WORKSPACE_SESSION_RETRY_AFTER_STALE_LOADING",
      code: "WORKSPACE_SESSION_RETRY_AFTER_STALE_LOADING",
      detail: `${getWorkspaceLabelByLedgerId(targetLedgerId)} was still locked after ${Math.round(loadingAgeMs / 1000)}s; starting a fresh bounded workspace load.`,
      ledgerId: getLoadedWorkspaceId(),
      selectedWorkspaceId: targetLedgerId,
      selectedWorkspaceLabel: getWorkspaceLabelByLedgerId(targetLedgerId),
      loadedWorkspaceId: getLoadedWorkspaceId(),
      loadedWorkspaceLabel: getLoadedWorkspaceLabel(),
      workspaceMismatch: String(targetLedgerId || "") !== String(getLoadedWorkspaceId() || ""),
      workspaceLabel: `${getWorkspaceLabelByLedgerId(targetLedgerId)} · loaded ${getLoadedWorkspaceLabel()}`
    });
    activeWorkspaceLoadInProgress = false;
    activeWorkspaceLoadLedgerId = "";
    activeWorkspaceLoadStartedAt = 0;
  } else if (activeWorkspaceLoadInProgress) {
    return;
  }
  workspaceSessionRecoveryInFlight = true;
  window.setTimeout(async () => {
    try {
      markActiveWorkspaceLoading(`workspace-session-retry:${reason}`);
      await loadSupabaseStateWithTimeout(
        { force: true, manual: true, reason: `workspace-session-retry:${reason}:${targetLedgerId}` },
        supabaseStartupLoadTimeoutMs,
        `Loading ${getWorkspaceLabelByLedgerId(targetLedgerId)} is delayed. You are still viewing ${getLoadedWorkspaceLabel()}.`
      );
    } finally {
      workspaceSessionRecoveryInFlight = false;
      render();
    }
  }, 0);
}


function maybeRecordSettingsWorkspaceLocked() {
  if (!supabaseClient || !currentSession) return;
  if (isActiveWorkspaceDataConfirmed()) return;
  // Startup/loading is not a failure. Only record a blocked row after a load has stopped
  // without confirming the requested workspace, otherwise Settings looks broken while
  // the normal first workspace load is still in progress.
  if (activeWorkspaceLoadInProgress || supabaseLoadInFlight || startupHydrationActive) return;
  const selectedWorkspaceId = getActiveLedgerId();
  const session = getWorkspaceSessionSnapshot({
    selectedWorkspaceId,
    selectedWorkspaceLabel: getWorkspaceLabelByLedgerId(selectedWorkspaceId)
  });
  const signature = `${session.selectedWorkspaceId}|${session.loadedWorkspaceId}|${session.loadStatus}`;
  const now = Date.now();
  if (signature === lastSettingsWorkspaceLockSignature && now - Number(lastSettingsWorkspaceLockRecordedAt || 0) < 15000) return;
  lastSettingsWorkspaceLockSignature = signature;
  lastSettingsWorkspaceLockRecordedAt = now;
  const baseMeta = {
    route: "workspace-session",
    operation: "blocked",
    ok: false,
    resultCode: "WORKSPACE_NOT_LOADED",
    statusCode: "WORKSPACE_NOT_LOADED",
    code: "WORKSPACE_NOT_LOADED",
    ledgerId: session.loadedWorkspaceId,
    selectedWorkspaceId: session.selectedWorkspaceId,
    selectedWorkspaceLabel: session.selectedWorkspaceLabel,
    loadedWorkspaceId: session.loadedWorkspaceId,
    loadedWorkspaceLabel: session.loadedWorkspaceLabel,
    workspaceMismatch: session.workspaceMismatch,
    workspaceLabel: session.workspaceMismatch ? `${session.selectedWorkspaceLabel} · loaded ${session.loadedWorkspaceLabel}` : session.loadedWorkspaceLabel
  };
  recordDataIoDiagnostic("blocked", {
    ...baseMeta,
    source: "settings-edit",
    detail: `${session.selectedWorkspaceLabel} settings are locked until that workspace data is loaded. ${session.loadedWorkspaceLabel} remains the last confirmed workspace.`
  });
  recordDataIoDiagnostic("blocked", {
    ...baseMeta,
    source: "vehicle-lookup",
    detail: `Vehicle lookup is blocked until ${session.selectedWorkspaceLabel} is loaded. ${session.loadedWorkspaceLabel} remains the last confirmed workspace.`
  });
  requestActiveWorkspaceReload("settings-lock");
}

function assertActiveWorkspaceDataConfirmed(action = "change this workspace", source = "workspace-action") {
  if (isActiveWorkspaceDataConfirmed()) return true;
  const message = workspaceActionBlockedMessage(action);
  recordWorkspaceActionBlocked(source, action);
  requestActiveWorkspaceReload(source);
  showUserError(message);
  showAppMessage(message, "warning", { timeoutMs: 6500 });
  return false;
}

function makeWorkspaceLoadingState() {
  return normalizeState({
    ...structuredClone(defaults),
    members: [],
    memberProfiles: {},
    trips: [],
    fuel: [],
    bookings: [],
    paymentStatuses: {},
    auditLog: [],
    closedPeriods: [],
    currentPeriodId: "",
    vehiclePlate: "",
    vehicleInfo: null,
    updatedAt: new Date().toISOString()
  });
}

function reconcileActiveLedgerSelection({ allowWhileLoading = false, reason = "workspace-reconcile", preferredLedgerId = "" } = {}) {
  if (supabaseClient && currentSession && !allowWhileLoading && (!workspaceInviteStatus.loaded || workspaceInviteStatus.loading)) {
    setActiveLedgerId(activeLedgerId, { persist: true });
    updateWorkspaceResolutionDebug("membership-loading", "Workspace membership is still loading; keeping the current active workspace for now.", { reason });
    return false;
  }
  if (supabaseClient && currentSession && getWorkspaceLedgerOptions().length) {
    return chooseWorkspaceFromMembership({ reason, preferredLedgerId });
  }
  if (!supabaseClient || !currentSession) {
    if (!isLedgerLinkedToCurrentUser(activeLedgerId)) {
      const previousLedgerId = activeLedgerId;
      setActiveLedgerId(getConfiguredLedgerId(), { persist: true });
      updateWorkspaceResolutionDebug("signed-out-default", `Signed-out/unlinked workspace ${previousLedgerId || "unknown"} repaired to the configured default.`, { reason, rejectedWorkspaceId: previousLedgerId });
      return true;
    }
    setActiveLedgerId(activeLedgerId, { persist: true });
    updateWorkspaceResolutionDebug("signed-out-keep-current", "Signed-out/local mode kept the current active workspace.", { reason });
  }
  return false;
}

function getWorkspaceOptionLabel(ledger) {
  const name = String(ledger?.name || "").trim();
  const slug = String(ledger?.slug || ledger?.ledger_id || "").trim();
  if (!name && !slug) return "Current workspace";
  if (!name || name === slug) return slug || name;
  return `${name} (${slug})`;
}

function getLinkedWorkspaceForActiveLedger() {
  const current = getActiveLedgerId();
  return getWorkspaceLedgerOptions().find((ledger) => String(ledger.ledger_id || "") === String(current || "")) || null;
}

function inferAuthBoundMemberName(email) {
  const local = String(email || "").split("@")[0] || "";
  return local.trim() || "Signed-in member";
}

function getAuthBoundMemberProfileFallback() {
  const email = getLoggedInEmail();
  if (!email) return null;
  const workspace = getLinkedWorkspaceForActiveLedger();
  if (!workspace) return null;
  return {
    name: inferAuthBoundMemberName(email),
    email,
    role: workspace.role === "admin" ? "admin" : "member",
    mobilepayPhone: "",
    authBound: true,
    fallback: true
  };
}

function getSignedInDisplayProfile() {
  const profile = getCurrentMemberProfile();
  if (profile) return profile;
  const email = getLoggedInEmail();
  if (!email) return null;
  return {
    name: inferAuthBoundMemberName(email),
    email,
    role: "member",
    mobilepayPhone: "",
    authBound: true,
    pendingInvite: true
  };
}

function resetAuthBoundMemberProfile() {
  authBoundMemberProfile = null;
  authBoundMemberProfileLedgerId = "";
  authBoundMemberProfileLoaded = false;
}

async function refreshAuthBoundMemberProfile() {
  resetAuthBoundMemberProfile();
  const email = getLoggedInEmail();
  const ledgerId = getActiveLedgerId();
  if (!supabaseClient || !currentSession || !email || !ledgerId) return null;
  try {
    const { data, error } = await supabaseClient
      .from("ledger_members")
      .select("id,name,email,role,is_active,mobilepay_phone,created_at")
      .eq("ledger_id", ledgerId)
      .eq("is_active", true)
      .ilike("email", email)
      .order("role", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) throw error;
    authBoundMemberProfileLoaded = true;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;
    const dataRow = rows.find((row) => normalizeWorkspaceRole(row.role) === "admin") || rows[0];
    if (rows.length > 1) {
      recordSupabaseLoadEvent("workspace-member-duplicate-collapsed", `${ledgerId}: ${rows.length} active rows for signed-in email`);
    }
    authBoundMemberProfileLedgerId = ledgerId;
    authBoundMemberProfile = {
      name: dataRow.name || inferAuthBoundMemberName(email),
      email,
      role: dataRow.role === "admin" ? "admin" : "member",
      mobilepayPhone: normalizePhone(dataRow.mobilepay_phone || ""),
      authBound: true
    };
    return authBoundMemberProfile;
  } catch (error) {
    console.warn("Could not refresh signed-in member profile", error);
    return null;
  }
}

function renderActiveWorkspaceSelector() {
  if (!els.activeWorkspace) return;
  const ledgers = getWorkspaceLedgerOptions();
  const current = getActiveLedgerId();
  const currentKnown = ledgers.some((ledger) => String(ledger.ledger_id || "") === current);
  const loading = Boolean(workspaceInviteStatus.loading || (supabaseClient && currentSession && !workspaceInviteStatus.loaded));
  let options = [];
  if (ledgers.length) {
    options = currentKnown ? ledgers : [{ ledger_id: current, name: loading ? `Loading ${current}` : `Unconfirmed ${current}`, slug: current, role: "member", unconfirmed: true }, ...ledgers];
  } else {
    options = [{ ledger_id: current, name: loading ? `Loading ${current}` : `Unconfirmed ${current}`, slug: current, role: "member", unconfirmed: true }];
  }
  const seenOptionKeys = new Set();
  const safeOptions = [];
  options.forEach((rawLedger) => {
    const ledger = normalizeWorkspaceLedgerRow(rawLedger) || rawLedger;
    const id = String(ledger.ledger_id || "");
    const label = getWorkspaceOptionLabel(ledger);
    const optionKey = normalizeWorkspaceIdentifier(id || label);
    if (!optionKey || seenOptionKeys.has(optionKey)) return;
    seenOptionKeys.add(optionKey);
    safeOptions.push({ ...ledger, ledger_id: id, label });
  });
  els.activeWorkspace.innerHTML = safeOptions.map((ledger) => {
    const id = String(ledger.ledger_id || "");
    const role = ledger.role ? ` · ${ledger.role}` : "";
    const suffix = ledger.unconfirmed ? " · loading" : role;
    return `<option value="${escapeHtml(id)}" ${id === current ? "selected" : ""}>${escapeHtml(ledger.label + suffix)}</option>`;
  }).join("");
  els.activeWorkspace.disabled = !supabaseClient || !currentSession || loading || safeOptions.length <= 1;
}

async function switchActiveWorkspace(ledgerId, source = "workspace-selector") {
  const targetLedgerId = String(ledgerId || "").trim();
  const alreadySelected = targetLedgerId && targetLedgerId === getActiveLedgerId();
  if (!targetLedgerId) return;
  if (alreadySelected && isActiveWorkspaceDataConfirmed()) return;
  if (supabaseClient && currentSession && (!workspaceInviteStatus.loaded || workspaceInviteStatus.loading)) {
    showUserError("Workspace list is still loading. Wait for it to finish before switching workspace.");
    renderActiveWorkspaceSelector();
    return;
  }
  if (!isLedgerLinkedToCurrentUser(targetLedgerId)) {
    recordDataIoDiagnostic("blocked", {
      source: "workspace-switch",
      route: "member-action",
      operation: "switch",
      resultCode: "WORKSPACE_SWITCH_BLOCKED",
      ok: false,
      detail: "Workspace is not linked to the signed-in email."
    });
    showUserError("You can only switch to workspaces linked to your signed-in email.");
    renderActiveWorkspaceSelector();
    return;
  }
  const operationId = createDataIoOperationId("workspace-switch", "switch");
  const beforeSession = getWorkspaceSessionSnapshot({ selectedWorkspaceId: targetLedgerId, selectedWorkspaceLabel: getWorkspaceLabelByLedgerId(targetLedgerId) });
  const traceMeta = {
    source: "workspace-switch",
    route: "member-action",
    operation: "switch",
    operationId,
    ledgerId: beforeSession.loadedWorkspaceId,
    selectedWorkspaceId: beforeSession.selectedWorkspaceId,
    selectedWorkspaceLabel: beforeSession.selectedWorkspaceLabel,
    loadedWorkspaceId: beforeSession.loadedWorkspaceId,
    loadedWorkspaceLabel: beforeSession.loadedWorkspaceLabel,
    workspaceMismatch: beforeSession.workspaceMismatch,
    workspaceLabel: beforeSession.workspaceMismatch ? `${beforeSession.selectedWorkspaceLabel} · loaded ${beforeSession.loadedWorkspaceLabel}` : beforeSession.loadedWorkspaceLabel,
    detail: alreadySelected ? `Retry loading selected workspace ${targetLedgerId}` : `Switch workspace to ${targetLedgerId}`
  };
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: alreadySelected ? "WORKSPACE_LOAD_RETRY_STARTED" : "WORKSPACE_SWITCH_STARTED" });
  setActiveLedgerId(targetLedgerId, { persist: true });
  markActiveWorkspaceLoading(source);
  state = makeWorkspaceLoadingState();
  await refreshAuthBoundMemberProfile();
  workspaceInviteStatus.loaded = false;
  workspaceInviteStatus.invites = [];
  normalizedTableStatus = { checked: false, ok: false, message: `Loading isolated workspace data for ${getCurrentWorkspaceLabel()}. Editing is locked until this workspace is confirmed.` };
  setSyncStatus("Switching workspace", { source });
  showAppMessage(`Loading workspace ${getCurrentWorkspaceLabel()}…`, "info", { timeoutMs: 3500 });
  render();
  unsubscribeFromLedgerEvents();
  unsubscribeFromSupabaseState();
  subscribeToLedgerEvents();
  subscribeToSupabaseState({ force: true });
  const loaded = await loadSupabaseStateWithTimeout(
    { force: true, manual: true, reason: `workspace-switch:${source}:${targetLedgerId}` },
    supabaseStartupLoadTimeoutMs,
    "Workspace switch sync is delayed. You can keep using local data and try Sync now."
  );
  if (loaded) {
    markActiveWorkspaceConfirmed(source);
    const confirmedSession = getWorkspaceSessionSnapshot();
    recordDataIoDiagnostic("success", {
      ...traceMeta,
      ok: true,
      resultCode: alreadySelected ? "WORKSPACE_LOAD_RETRY_CONFIRMED" : "WORKSPACE_SWITCHED",
      ledgerId: confirmedSession.loadedWorkspaceId,
      selectedWorkspaceId: confirmedSession.selectedWorkspaceId,
      selectedWorkspaceLabel: confirmedSession.selectedWorkspaceLabel,
      loadedWorkspaceId: confirmedSession.loadedWorkspaceId,
      loadedWorkspaceLabel: confirmedSession.loadedWorkspaceLabel,
      workspaceMismatch: false,
      workspaceLabel: confirmedSession.loadedWorkspaceLabel,
      detail: `${confirmedSession.selectedWorkspaceLabel} data is confirmed and safe to edit.`
    });
    showAppMessage(`Switched to ${getCurrentWorkspaceLabel()}. Workspace data is loaded and safe to edit.`, "success", { timeoutMs: 4500 });
    scheduleWorkspaceInviteRefresh(`switch-confirmed:${source}`);
  } else {
    markActiveWorkspaceLoadFailed(source);
    const delayedSession = getWorkspaceSessionSnapshot({ selectedWorkspaceId: targetLedgerId, selectedWorkspaceLabel: getWorkspaceLabelByLedgerId(targetLedgerId) });
    recordDataIoDiagnostic("timeout", {
      ...traceMeta,
      ok: false,
      resultCode: "WORKSPACE_SWITCH_LOAD_DELAYED",
      ledgerId: delayedSession.loadedWorkspaceId,
      selectedWorkspaceId: delayedSession.selectedWorkspaceId,
      selectedWorkspaceLabel: delayedSession.selectedWorkspaceLabel,
      loadedWorkspaceId: delayedSession.loadedWorkspaceId,
      loadedWorkspaceLabel: delayedSession.loadedWorkspaceLabel,
      workspaceMismatch: delayedSession.workspaceMismatch,
      workspaceLabel: delayedSession.workspaceMismatch ? `${delayedSession.selectedWorkspaceLabel} · loaded ${delayedSession.loadedWorkspaceLabel}` : delayedSession.loadedWorkspaceLabel,
      detail: `${delayedSession.selectedWorkspaceLabel} is selected, but ${delayedSession.loadedWorkspaceLabel} remains loaded; editing stays locked.`
    });
    showUserError(`${delayedSession.selectedWorkspaceLabel} is selected, but its data has not loaded yet. You are still viewing ${delayedSession.loadedWorkspaceLabel}. Try Sync now before editing.`);
  }
}

function getMobilePayReturnPrompt(key) {
  try {
    const prompt = JSON.parse(localStorage.getItem(mobilePayReturnKey) || "null");
    if (!prompt || prompt.key !== key) return null;
    if (Date.now() - Number(prompt.openedAt || 0) > 30 * 60 * 1000) {
      localStorage.removeItem(mobilePayReturnKey);
      return null;
    }
    return prompt;
  } catch (error) {
    localStorage.removeItem(mobilePayReturnKey);
    return null;
  }
}

function rememberMobilePayReturnPrompt(settlement) {
  if (!settlement) return;
  try {
    localStorage.setItem(
      mobilePayReturnKey,
      JSON.stringify({
        key: settlementKey(settlement),
        amount: formatPaymentAmountOnly(settlement.amount),
        to: settlement.to,
        openedAt: Date.now()
      })
    );
  } catch (error) {
    // Ignore storage errors. The payment still happens in MobilePay.
  }
}

function clearMobilePayReturnPrompt(key) {
  const prompt = getMobilePayReturnPrompt(key);
  if (prompt) localStorage.removeItem(mobilePayReturnKey);
}

function openMobilePayApp(settlement) {
  rememberMobilePayReturnPrompt(settlement);
  window.location.href = "mobilepay://";
}

function fuelPriceHelperDeps(source = state) {
  return {
    state: source,
    latestFuelPrice,
    fallbackRange: defaultFuelPriceWarningRange,
    formatNumber,
    formatMoneyFor,
    formatDate,
    escapeHtml,
    roundMoney
  };
}

function getFuelPriceWarningRange(source = state) {
  return fuelPriceHelpers.getFuelPriceWarningRange(source, fuelPriceHelperDeps(source));
}

function isFuelPriceOutsideWarningRange(pricePerLiter, source = state) {
  return fuelPriceHelpers.isFuelPriceOutsideWarningRange(pricePerLiter, source, fuelPriceHelperDeps(source));
}

function formatFuelPriceWarningRange(source = state) {
  return fuelPriceHelpers.formatFuelPriceWarningRange(source, fuelPriceHelperDeps(source));
}


function formatFuelAmountLitersAndPrice(fuel, currency = state.currency) {
  return fuelPriceHelpers.formatFuelAmountLitersAndPrice(fuel, { ...fuelPriceHelperDeps(state), currency });
}


function getFuelReceiptTimestamp(fuel = {}) {
  return fuelPriceHelpers.getFuelReceiptTimestamp(fuel);
}

function getSuggestedFuelPricePerLiter({ amount = 0, liters = 0, excludeFuelId = "" } = {}) {
  return fuelPriceHelpers.getSuggestedFuelPricePerLiter({ amount, liters, excludeFuelId }, fuelPriceHelperDeps(state));
}

function buildFuelPriceCorrection({ amount = 0, liters = 0, excludeFuelId = "" } = {}) {
  return fuelPriceHelpers.buildFuelPriceCorrection({ amount, liters, excludeFuelId }, fuelPriceHelperDeps(state));
}

function renderFuelPriceCorrectionPanel(message, correction) {
  if (!els.fuelCorrectionPanel || !correction) return;
  const suggestedAmount = Math.max(0, Number(correction.suggestedAmount) || 0);
  els.fuelCorrectionPanel.dataset.suggestedAmount = String(suggestedAmount);
  delete els.fuelCorrectionPanel.dataset.suggestedLiters;
  delete els.fuelCorrectionPanel.dataset.suggestedOdometer;
  const priceMathLine = correction.amount > 0 && correction.liters > 0
    ? `<li>${formatMoneyFor(correction.amount, state.currency)} ÷ ${formatNumber(correction.liters)} L = <strong>${formatMoneyFor(correction.pricePerLiter, state.currency)}/L</strong>.</li>`
    : "";
  const suggestedAmountLine = suggestedAmount > 0
    ? `<li>${formatNumber(correction.liters)} L × ${formatMoneyFor(correction.suggestedPricePerLiter, state.currency)}/L = <strong>${formatMoneyFor(suggestedAmount, state.currency)}</strong>.</li>`
    : "";
  const suggestedAction = suggestedAmount > 0
    ? `<button class="subtle-button compact-button" type="button" data-fuel-correction-action="set-amount">Keep ${formatNumber(correction.liters)} L → set amount to ${formatMoneyFor(suggestedAmount, state.currency)}</button>`
    : "";
  els.fuelCorrectionPanel.innerHTML = `
    <strong>Fuel price needs a correction</strong>
    <p>${escapeHtml(message)}</p>
    <small>Suggested amount uses the first valid reference available: current valid form price, latest valid historical receipt, live fuel price estimate, then warning-range midpoint.</small>
    <div class="fuel-correction-math" aria-label="Fuel price correction calculation">
      <strong>Why this amount?</strong>
      <ul>
        ${priceMathLine}
        <li>Reference price: <strong>${formatMoneyFor(correction.suggestedPricePerLiter, state.currency)}/L</strong> from ${escapeHtml(correction.suggestedPriceLabel)}.</li>
        <li>${escapeHtml(correction.suggestedPriceDetail || "")}</li>
        ${suggestedAmountLine}
      </ul>
    </div>
    <div class="fuel-correction-actions">
      ${suggestedAction}
      <button class="subtle-button compact-button" type="button" data-fuel-correction-action="dismiss">Edit manually</button>
    </div>
  `;
  els.fuelCorrectionPanel.classList.remove("hidden");
  els.fuelCorrectionPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function validateFuelLogInput({ amount, liters }, options = {}) {
  return fuelPriceHelpers.validateFuelLogInput({ amount, liters, excludeFuelId: options.excludeFuelId }, fuelPriceHelperDeps(state));
}

const defaults = {
  currency: "DKK",
  members: ["Christian", "Emilie", "Jonas", "Marie"],
  memberProfiles: {
    Christian: { email: "", role: "admin", mobilepayPhone: "" },
    Emilie: { email: "", role: "member", mobilepayPhone: "" },
    Jonas: { email: "", role: "member", mobilepayPhone: "" },
    Marie: { email: "", role: "member", mobilepayPhone: "" }
  },
  trips: [],
  bookings: [],
  fuel: [],
  paymentStatuses: {},
  auditLog: [],
  currentPeriodId: "",
  closedPeriods: [],
  testLabReports: [],
  lastOdometer: "",
  fuelType: "diesel",
  fuelConsumption: 5.3,
  fuelTankCapacity: 55,
  fuelFallbackPrice: 14.5,
  fuelPriceWarningMinDkkPerLiter: defaultFuelPriceWarningRange.minDkkPerLiter,
  fuelPriceWarningMaxDkkPerLiter: defaultFuelPriceWarningRange.maxDkkPerLiter,
  fuelWarningThreshold: 70,
  paymentRemindersEnabled: true,
  paymentReminderAfterDays: 3,
  paymentReminderRepeatDays: 3,
  paymentReminderMaxCount: 3,
  vehiclePlate: "",
  vehicleInfo: null,
  vehicleLookupSource: "manual",
  vehicleLookupAt: "",
  carSettingsVersion: 3,
  updatedAt: ""
};

let state = structuredClone(defaults);
let closingPeriodInProgress = false;
let suppressNormalizedBookingWrites = false;
let currentUser = localStorage.getItem(userKey) || "";
let currentSession = null;
let authBoundMemberProfile = null;
let authBoundMemberProfileLedgerId = "";
let authBoundMemberProfileLoaded = false;
let loginCooldownTimer;
const closedPeriodFilters = {
  query: "",
  status: "all",
  sort: "newest"
};
const expandedClosedPeriodIds = new Set();
let editingTripId = null;
let editingFuelId = null;
let editingBookingId = null;
let pendingTripBookingContext = null;
let pendingFuelTripContext = null;
let supabaseStateChannel = null;
let supabaseStateChannelLedgerId = "";
let ledgerEventsChannel = null;
let ledgerEventsChannelLedgerId = "";
const ledgerEventNotificationIds = new Set();
let lastLedgerEventPublishAt = 0;
const ledgerEventPublishCooldownMs = 30000;
let ledgerEventAutoSyncTimer = null;
let lastLedgerEventAutoSyncAt = 0;
const ledgerEventAutoSyncDebounceMs = 2500;
const ledgerEventAutoSyncCooldownMs = 20000;
let hiddenRealtimePauseTimer = null;
const hiddenRealtimePauseDelayMs = 60 * 1000;
let ignoreRealtimeUntil = 0;
const liveSyncStorageKey = `${storageKey}:liveSyncEnabled`;
let liveSyncEnabled = localStorage.getItem(liveSyncStorageKey) === "true";
const testLabReportCloudStorageKey = `${storageKey}:testLabCloudReportOptIn`;
let testLabCloudReportOptIn = localStorage.getItem(testLabReportCloudStorageKey) === "true";
let supabaseLoadInFlight = false;
let supabaseLoadStartedAt = 0;
let supabaseLoadToken = 0;
let lastSupabaseLoadAt = 0;
const supabaseLoadCooldownMs = 60 * 1000;
const supabaseFocusReloadCooldownMs = 2 * 60 * 1000;
let lastFocusSyncAttemptAt = 0;
const recentHealthyFocusSyncGraceMs = 2 * 60 * 1000;
const supabaseStartupLoadTimeoutMs = 15000;
const startupHydrationGraceMs = 12000;
const syncDelayHealthyGraceMs = 10 * 60 * 1000;
const visibleSyncingFailsafeMs = 30000;
const visibleSavingFailsafeMs = 20000;
let visibleSyncingStartedAt = 0;
let visibleSyncingSource = "";
let visibleSyncingFailsafeTimer = null;
let visibleSavingStartedAt = 0;
let visibleSavingSource = "";
let visibleSavingFailsafeTimer = null;
let startupHydrationActive = false;
let startupHydrationStartedAt = 0;
let startupHydrationReason = "";
let activeWorkspaceLoadInProgress = false;
let activeWorkspaceLoadLedgerId = "";
let activeWorkspaceLoadStartedAt = 0;
let lastConfirmedWorkspaceLedgerId = "";
let lastConfirmedWorkspaceLabel = "";
let workspaceSessionRecoveryInFlight = false;
let lastSettingsWorkspaceLockSignature = "";
let lastSettingsWorkspaceLockRecordedAt = 0;

const foregroundOperationStaleMs = 20000;
const foregroundOperations = new Map();
let foregroundOperationCounter = 0;
let foregroundOperationWatchdogTimer = null;

const visibleSyncBackgroundSources = new Set([
  "admin-diagnostics",
  "auth-initial_session",
  "auth-session_updated",
  "auth-token_refreshed",
  "focus-refresh",
  "ledger-event",
  "manual-admin",
  "realtime",
  "realtime-refresh",
  "service-worker",
  "supabase-realtime",
  "visibilitychange",
  "window-focus"
]);
const visibleSyncForegroundPrefixes = [
  "critical-action:",
  "manual-",
  "startup",
  "workspace-"
];
function normalizeVisibleSyncSource(source, label = "") {
  return String(source || label || "unknown-visible-sync").trim() || "unknown-visible-sync";
}
function isBackgroundVisibleSyncSource(source) {
  const normalized = normalizeVisibleSyncSource(source).toLowerCase();
  if (visibleSyncBackgroundSources.has(normalized)) return true;
  return /(^|[-:])(background|focus|realtime|service-worker|admin-diagnostics)([-:]|$)/.test(normalized);
}
function isForegroundVisibleSyncSource(source) {
  const normalized = normalizeVisibleSyncSource(source).toLowerCase();
  return visibleSyncForegroundPrefixes.some((prefix) => normalized.startsWith(prefix));
}
function shouldAllowVisibleSyncStatus(label, source) {
  const normalizedLabel = String(label || "").toLowerCase();
  const normalizedSource = normalizeVisibleSyncSource(source, label);
  if (normalizedLabel !== "saving" && normalizedLabel !== "syncing") return true;
  if (isBackgroundVisibleSyncSource(normalizedSource)) return false;
  // Unknown foreground writes still pass, but they are recorded so the next
  // bug report names the source instead of just saying Saving/Syncing.
  return true;
}


function beginStartupHydration(reason = "startup") {
  if (!supabaseClient || !currentSession) return;
  startupHydrationActive = true;
  startupHydrationStartedAt = Date.now();
  startupHydrationReason = String(reason || "startup");
  document.body.classList.add("startup-hydrating");
  recordSyncDiagnostic("startup-hydration-start", startupHydrationReason, { reason: startupHydrationReason });
}

function finishStartupHydration(reason = "complete") {
  if (!startupHydrationActive) return;
  const ageMs = Date.now() - Number(startupHydrationStartedAt || Date.now());
  startupHydrationActive = false;
  startupHydrationStartedAt = 0;
  startupHydrationReason = "";
  document.body.classList.remove("startup-hydrating");
  recordSyncDiagnostic("startup-hydration-clear", String(reason || "complete"), { reason, ageMs });
}

function isStartupHydrating() {
  if (!supabaseClient || !currentSession || !startupHydrationActive) return false;
  const ageMs = Date.now() - Number(startupHydrationStartedAt || Date.now());
  return ageMs < startupHydrationGraceMs || supabaseLoadInFlight;
}

function shouldSuppressStartupHydrationDelay() {
  if (!supabaseClient || !currentSession || !startupHydrationActive) return false;
  const ageMs = Date.now() - Number(startupHydrationStartedAt || Date.now());
  return ageMs < startupHydrationGraceMs;
}


function createForegroundOperationId(source = "foreground") {
  foregroundOperationCounter += 1;
  const safeSource = normalizeVisibleSyncSource(source, "foreground").replace(/[^a-z0-9_-]/gi, "-").slice(0, 48) || "foreground";
  return `${safeSource}-${Date.now().toString(36)}-${foregroundOperationCounter.toString(36)}`;
}

function foregroundOperationList(referenceTime = Date.now()) {
  purgeStaleForegroundOperations("list", referenceTime);
  return Array.from(foregroundOperations.values())
    .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
}

function latestForegroundOperation(referenceTime = Date.now()) {
  return foregroundOperationList(referenceTime)[0] || null;
}

function hasActiveForegroundOperation(referenceTime = Date.now()) {
  return foregroundOperationList(referenceTime).length > 0;
}

function foregroundOperationSummary(referenceTime = Date.now()) {
  const active = foregroundOperationList(referenceTime);
  if (!active.length) return "No foreground save is active.";
  return active
    .map((operation) => {
      const ageSeconds = Math.max(0, Math.round((referenceTime - Number(operation.startedAt || referenceTime)) / 1000));
      return `${operation.source || "foreground"} (${ageSeconds}s)`;
    })
    .join(", ");
}

function scheduleForegroundOperationWatchdog() {
  if (foregroundOperationWatchdogTimer) window.clearTimeout(foregroundOperationWatchdogTimer);
  if (!foregroundOperations.size) {
    foregroundOperationWatchdogTimer = null;
    return;
  }
  foregroundOperationWatchdogTimer = window.setTimeout(() => {
    purgeStaleForegroundOperations("watchdog");
    if (!foregroundOperations.size && els.syncStatus && String(els.syncStatus.dataset.status || "") === "saving") {
      clearStaleVisibleSavingStatus("foreground-watchdog");
    } else {
      scheduleForegroundOperationWatchdog();
    }
    renderSupabaseLoadMonitor();
  }, foregroundOperationStaleMs + 250);
}

function beginForegroundOperation(source = "foreground-write", meta = {}) {
  const normalizedSource = normalizeVisibleSyncSource(source, "foreground-write");
  const now = Date.now();
  purgeStaleForegroundOperations("begin", now);
  const existing = Array.from(foregroundOperations.values()).find((operation) => operation.source === normalizedSource);
  if (existing) {
    existing.lastSeenAt = now;
    scheduleForegroundOperationWatchdog();
    return existing.id;
  }
  const id = meta.id || createForegroundOperationId(normalizedSource);
  foregroundOperations.set(id, {
    id,
    source: normalizedSource,
    detail: meta.detail || "",
    startedAt: now,
    lastSeenAt: now
  });
  recordSupabaseLoadEvent("foreground-operation-start", normalizedSource);
  recordSyncDiagnostic("foreground-operation-start", normalizedSource, { source: normalizedSource, operationId: id });
  scheduleForegroundOperationWatchdog();
  renderSupabaseLoadMonitor();
  return id;
}

function finishForegroundOperation(id, reason = "foreground-operation-finished") {
  if (!id || !foregroundOperations.has(id)) return false;
  const operation = foregroundOperations.get(id);
  foregroundOperations.delete(id);
  const ageMs = Date.now() - Number(operation.startedAt || Date.now());
  recordSupabaseLoadEvent("foreground-operation-finished", `${operation.source}; ${reason}`);
  recordSyncDiagnostic("foreground-operation-finished", `${operation.source} finished: ${reason}`, { source: operation.source, operationId: id, ageMs });
  scheduleForegroundOperationWatchdog();
  renderSupabaseLoadMonitor();
  return true;
}

function finishForegroundOperationsBySource(source = "", reason = "foreground-operation-finished") {
  const normalizedSource = normalizeVisibleSyncSource(source, "foreground-write");
  let cleared = 0;
  Array.from(foregroundOperations.entries()).forEach(([id, operation]) => {
    if (!source || operation.source === normalizedSource) {
      if (finishForegroundOperation(id, reason)) cleared += 1;
    }
  });
  return cleared;
}

function finishAllForegroundOperations(reason = "foreground-operation-finished") {
  let cleared = 0;
  Array.from(foregroundOperations.keys()).forEach((id) => {
    if (finishForegroundOperation(id, reason)) cleared += 1;
  });
  return cleared;
}

function purgeStaleForegroundOperations(reason = "stale", referenceTime = Date.now()) {
  let cleared = 0;
  Array.from(foregroundOperations.entries()).forEach(([id, operation]) => {
    const ageMs = referenceTime - Number(operation.startedAt || referenceTime);
    if (ageMs >= foregroundOperationStaleMs) {
      foregroundOperations.delete(id);
      cleared += 1;
      recordSupabaseLoadEvent("foreground-operation-timeout", `${operation.source}; ${Math.round(ageMs / 1000)}s; ${reason}`);
      recordSyncDiagnostic("foreground-operation-timeout", `${operation.source} was auto-cleared after ${Math.round(ageMs / 1000)}s.`, { source: operation.source, operationId: id, ageMs, reason });
    }
  });
  if (cleared) scheduleForegroundOperationWatchdog();
  return cleared;
}
function recordBlockedVisibleSyncStatus(label, source, options = {}) {
  const normalizedSource = normalizeVisibleSyncSource(source, label);
  const detail = `${normalizedSource} attempted to show visible ${String(label || "sync")} from a background/diagnostic path.`;
  recordSupabaseLoadEvent("visible-sync-status-blocked", detail);
  recordSyncDiagnostic("visible-sync-status-blocked", detail, { label, source: normalizedSource, ...options });
}
const workspaceInviteRequestTimeoutMs = 15000;
const supabaseAuthRefreshSyncCooldownMs = 5 * 60 * 1000;
let lastAuthCloudSyncUserKey = "";
let lastAuthCloudSyncAt = 0;
let lastAuthCloudSyncEventAt = 0;
const supabaseStaleLoadMs = 45000;
let periodCloseRpcArmUntil = 0;
let deferredInstallPrompt = null;
let pushSupported = false;
let pushEnabled = false;
let latestFuelPrice = null;
let fuelPriceTimer = null;
const fuelPriceRefreshIntervalMs = 60 * 60 * 1000;
const fuelPriceFetchTimeoutMs = 3500;
const vehicleLookupTimeoutMs = 20000;
let fuelPriceInFlight = false;
let lastCloudSaveAt = "";
let lastCloudSyncAt = "";
let lastJsonMirrorSaveAt = "";
let lastNormalizedTableLoadAt = 0;
let cachedPaymentWriteContext = null;
const paymentWriteContextCacheMaxAgeMs = 10 * 60 * 1000;
const reconciliationFreshLoadMaxAgeMs = 5 * 60 * 1000;
let lastSyncError = "";
let lastCloudRetryAt = "";
let lastSyncDiagnostic = null;
const syncDiagnostics = [];
let lastDataIoDiagnostic = null;
const dataIoDiagnostics = [];
let dataIoOperationCounter = 0;
const activeAdminToolOperations = new Set();
const dataIoOperationStaleMs = 15000;
const longAdminToolDataIoOperationStaleMs = 45000;
const standaloneSecurityHealthProbeTimeoutMs = 6000;

function createDataIoOperationId(source = "data-io") {
  dataIoOperationCounter += 1;
  const safeSource = String(source || "data-io").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40) || "data-io";
  return `${safeSource}-${Date.now().toString(36)}-${dataIoOperationCounter.toString(36)}`;
}

function summarizeDataIoTarget(meta = {}) {
  return meta.endpoint || meta.rpc || meta.table || meta.route || meta.source || "unknown";
}

function normalizeDataIoOperationStaleMs(value, fallback = dataIoOperationStaleMs) {
  const staleMs = Number(value);
  if (!Number.isFinite(staleMs) || staleMs <= 0) return fallback;
  return Math.max(1000, Math.round(staleMs));
}

function dataIoSignature(entry = {}) {
  if (entry.operationId) return `op:${entry.operationId}`;
  return [
    entry.source || "unknown",
    entry.route || "unknown",
    entry.table || "",
    entry.rpc || "",
    entry.endpoint || "",
    entry.operation || ""
  ].join("|");
}

function dataIoStatusForPhase(phase, ok) {
  const normalizedPhase = String(phase || "");
  if (/timeout/i.test(normalizedPhase)) return "timeout";
  if (/skip/i.test(normalizedPhase)) return "skipped";
  if (/blocked|error|exception|fail/i.test(normalizedPhase)) return "failed";
  if (ok || normalizedPhase === "success") return "ok";
  return "active";
}

function formatDataIoDiagnosticLine(entry = {}) {
  const target = entry.table ? ` → ${entry.table}` : entry.rpc ? ` → ${entry.rpc}` : entry.endpoint ? ` → ${entry.endpoint}` : "";
  const detail = entry.detail || entry.error?.message || entry.phase || "No detail";
  return `${entry.source || "unknown"} via ${entry.route || "unknown"}${target} — ${detail}`;
}

function formatDataIoOperationLine(operation = {}) {
  const entry = operation.latest || operation.start || {};
  const target = entry.table ? ` → ${entry.table}` : entry.rpc ? ` → ${entry.rpc}` : entry.endpoint ? ` → ${entry.endpoint}` : "";
  const status = operation.status || dataIoStatusForPhase(entry.phase, entry.ok);
  const duration = Number.isFinite(operation.durationMs) ? ` · ${operation.durationMs} ms` : "";
  const code = operation.finish?.resultCode || operation.finish?.code || operation.latest?.resultCode || operation.latest?.code || operation.start?.resultCode || operation.start?.code || "";
  const codeText = code ? ` · code ${code}` : "";
  const detail = operation.finish?.detail || operation.finish?.error?.message || operation.start?.detail || operation.start?.error?.message || "";
  return `${entry.source || "unknown"} via ${entry.route || "unknown"}${target} — ${status}${duration}${codeText}${detail ? ` · ${detail}` : ""}`;
}

let adminUiBatchDepth = 0;
let adminUiRenderPending = false;
let adminUiLoadMonitorPending = false;
let adminUiRenderFrame = null;

function canUseAnimationFrame() {
  return typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
}

function flushAdminUiBatch() {
  if (adminUiBatchDepth > 0) return;
  if (adminUiLoadMonitorPending) {
    adminUiLoadMonitorPending = false;
    renderSupabaseLoadMonitor();
  }
  if (adminUiRenderPending) {
    adminUiRenderPending = false;
    render();
  }
}

function scheduleAdminUiBatchFlush() {
  if (adminUiBatchDepth > 0) return;
  if (!adminUiRenderPending && !adminUiLoadMonitorPending) return;
  if (adminUiRenderFrame) return;
  const run = () => {
    adminUiRenderFrame = null;
    flushAdminUiBatch();
  };
  if (canUseAnimationFrame()) {
    adminUiRenderFrame = window.requestAnimationFrame(run);
  } else {
    setTimeout(run, 0);
  }
}

function scheduleSupabaseLoadMonitorRender() {
  if (adminUiBatchDepth > 0) {
    adminUiLoadMonitorPending = true;
    return;
  }
  renderSupabaseLoadMonitor();
}

async function withAdminUiBatch(action) {
  adminUiBatchDepth += 1;
  try {
    return await action();
  } finally {
    adminUiBatchDepth = Math.max(0, adminUiBatchDepth - 1);
    scheduleAdminUiBatchFlush();
  }
}

function dataIoResultCodeFor(phase, ok, meta = {}) {
  const error = summarizeSupabaseError(meta.error);
  const explicit = meta.resultCode || meta.statusCode || meta.code || meta.httpStatus || meta.httpStatusCode || meta.status;
  if (explicit) return String(explicit);
  if (error?.code) return String(error.code);
  if (error?.name === "AbortError" || /timed out|timeout/i.test(error?.message || "")) return "TIMEOUT";
  const normalizedPhase = String(phase || "data-io").toLowerCase();
  if (normalizedPhase === "start") return "STARTED";
  if (normalizedPhase === "skip") return "SKIPPED";
  if (normalizedPhase === "timeout") return "TIMEOUT";
  if (normalizedPhase === "exception") return "EXCEPTION";
  if (normalizedPhase === "error") return "ERROR";
  if (normalizedPhase === "blocked") return "BLOCKED";
  if (ok === true || normalizedPhase === "success") return "OK";
  return normalizedPhase.toUpperCase();
}

function recordDataIoDiagnostic(phase, meta = {}) {
  const summarizedError = summarizeSupabaseError(meta.error);
  const resultCode = dataIoResultCodeFor(phase, meta.ok === true, meta);
  const workspaceContext = buildDataIoWorkspaceContext(meta);
  const diagnostic = {
    at: new Date().toISOString(),
    phase: String(phase || "data-io"),
    source: String(meta.source || "unknown"),
    route: String(meta.route || "unknown"),
    table: meta.table || "",
    rpc: meta.rpc || "",
    endpoint: meta.endpoint || "",
    operation: meta.operation || "",
    operationId: meta.operationId || "",
    detail: meta.detail || "",
    ok: meta.ok === true,
    code: resultCode,
    resultCode,
    statusCode: resultCode,
    errorCode: summarizedError?.code || "",
    ledgerId: meta.ledgerId || workspaceContext.loadedWorkspaceId || (supabaseHelpers?.getLedgerId ? supabaseHelpers.getLedgerId(supabaseConfig) : ""),
    activeLedgerId,
    selectedWorkspaceId: workspaceContext.selectedWorkspaceId,
    selectedWorkspaceLabel: workspaceContext.selectedWorkspaceLabel,
    loadedWorkspaceId: workspaceContext.loadedWorkspaceId,
    loadedWorkspaceLabel: workspaceContext.loadedWorkspaceLabel,
    workspaceMismatch: workspaceContext.workspaceMismatch,
    workspaceLabel: workspaceContext.workspaceLabel,
    hasSession: Boolean(currentSession),
    pendingLocalChanges,
    error: summarizedError,
    staleAfterMs: normalizeDataIoOperationStaleMs(meta.staleAfterMs)
  };
  lastDataIoDiagnostic = diagnostic;
  dataIoDiagnostics.push(diagnostic);
  while (dataIoDiagnostics.length > 80) dataIoDiagnostics.shift();
  const target = summarizeDataIoTarget(diagnostic);
  const normalizedDiagnosticPhase = String(diagnostic.phase || "data-io").toLowerCase();
  const label = diagnostic.ok && normalizedDiagnosticPhase === "success"
    ? `data-io:${diagnostic.source}:ok`
    : `data-io:${diagnostic.source}:${normalizedDiagnosticPhase}`;
  const detail = diagnostic.detail || diagnostic.error?.message || `${diagnostic.route} ${target}`;
  recordSupabaseLoadEvent(label, detail, { dataIo: true });
  if (!diagnostic.ok && /fail|error|timeout|blocked/i.test(diagnostic.phase)) {
    recordSyncDiagnostic("data-io-failure", `${diagnostic.source} via ${diagnostic.route} failed at ${target}: ${diagnostic.error?.message || diagnostic.detail || "unknown error"}`, {
      source: diagnostic.source,
      route: diagnostic.route,
      table: diagnostic.table,
      rpc: diagnostic.rpc,
      endpoint: diagnostic.endpoint,
      operation: diagnostic.operation,
      error: meta.error
    });
  }
  scheduleSupabaseLoadMonitorRender();
  return diagnostic;
}

async function traceDataIo(meta, operation) {
  const operationId = meta.operationId || createDataIoOperationId(meta.source);
  const tracedMeta = { ...meta, operationId };
  recordDataIoDiagnostic("start", { ...tracedMeta, ok: true });
  try {
    const result = await operation();
    const error = result?.error || null;
    if (error) {
      recordDataIoDiagnostic("error", { ...tracedMeta, error });
    } else {
      recordDataIoDiagnostic("success", { ...tracedMeta, ok: true });
    }
    return result;
  } catch (error) {
    recordDataIoDiagnostic("exception", { ...tracedMeta, error });
    throw error;
  }
}

function normalizeAdminToolSource(source = "admin-tool") {
  return String(source || "admin-tool").trim() || "admin-tool";
}

function makeAdminToolDiagnosticMeta(source, detail = "", operation = "run", options = {}) {
  return {
    source: `admin-tool:${normalizeAdminToolSource(source)}`,
    route: "admin-tool",
    operation,
    detail,
    ok: true,
    staleAfterMs: normalizeDataIoOperationStaleMs(options.staleAfterMs)
  };
}

function normalizeAdminToolResult(result) {
  if (result && typeof result === "object" && result.error) return result;
  if (result && typeof result === "object" && result.ok === false && !result.skipped) {
    const error = result.error || new Error(result.message || "Admin tool did not complete successfully.");
    return { ...result, error };
  }
  return result;
}

async function runTracedAdminToolAction(action) {
  const result = await action();
  return normalizeAdminToolResult(result);
}

async function traceAdminToolOperation(source, detail, action, { operation = "run", staleAfterMs = dataIoOperationStaleMs } = {}) {
  const normalizedSource = normalizeAdminToolSource(source);
  if (activeAdminToolOperations.has(normalizedSource)) {
    const skipDetail = `${detail || normalizedSource} skipped because the same admin tool is already running.`;
    recordAdminToolSkip(normalizedSource, skipDetail, { operation });
    if (typeof showUserWarning === "function") showUserWarning("That admin action is already running. Wait for it to finish before running it again.");
    return { ok: false, skipped: true, reason: "admin-tool-already-running", source: normalizedSource };
  }
  activeAdminToolOperations.add(normalizedSource);
  try {
    return await withAdminUiBatch(() => traceDataIo(makeAdminToolDiagnosticMeta(normalizedSource, detail, operation, { staleAfterMs }), () => runTracedAdminToolAction(action)));
  } finally {
    activeAdminToolOperations.delete(normalizedSource);
  }
}

function recordAdminToolSkip(source, detail, { operation = "run" } = {}) {
  recordDataIoDiagnostic("skip", { ...makeAdminToolDiagnosticMeta(source, detail, operation), ok: false });
}

function normalizeMemberActionSource(source) {
  return String(source || "member-action").trim().replace(/[^a-z0-9:-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "member-action";
}

function makeMemberActionDiagnosticMeta(source, detail, operation = "run", extras = {}) {
  const normalizedSource = normalizeMemberActionSource(source);
  return {
    source: normalizedSource,
    route: extras.route || "member-action",
    endpoint: extras.endpoint || "",
    rpc: extras.rpc || "",
    operation,
    operationId: extras.operationId || createDataIoOperationId(normalizedSource, operation),
    resultCode: extras.resultCode || "MEMBER_ACTION_STARTED",
    detail: detail || normalizedSource,
    staleAfterMs: extras.staleAfterMs || dataIoOperationStaleMs,
    ok: true
  };
}

function recordMemberActionSkip(source, detail, { operation = "run" } = {}) {
  const normalizedSource = normalizeMemberActionSource(source);
  recordDataIoDiagnostic("skip", {
    ...makeMemberActionDiagnosticMeta(normalizedSource, `${detail || normalizedSource} skipped because the same member action is already running.`, operation, { resultCode: "MEMBER_ACTION_SKIPPED" }),
    ok: false
  });
}

async function traceMemberActionOperation(source, detail, action, { operation = "run", staleAfterMs = dataIoOperationStaleMs } = {}) {
  const normalizedSource = normalizeMemberActionSource(source);
  if (activeMemberActionOperations.has(normalizedSource)) {
    recordMemberActionSkip(normalizedSource, detail, { operation });
    if (typeof showUserWarning === "function") showUserWarning("That action is already running. Wait for it to finish before trying again.");
    return { ok: false, skipped: true, reason: "member-action-already-running", source: normalizedSource };
  }
  activeMemberActionOperations.add(normalizedSource);
  try {
    return await traceDataIo(makeMemberActionDiagnosticMeta(normalizedSource, detail, operation, { staleAfterMs }), action);
  } finally {
    activeMemberActionOperations.delete(normalizedSource);
  }
}

const legacyDataIoGroupLabelsForGuardrails = "Member actions · Sync/load/write actions";
// Guardrail compatibility: vehicle-lookup|settings-save|trip-save|fuel-save|trips-delete|fuel-delete|bookings-delete business actions used to return "Member actions".
// Guardrail compatibility: state-load|write-context infrastructure rows used to return "Sync/load/write actions".

function dataIoOperationGroup(operation = {}) {
  const entry = operation.latest || operation.start || operation.finish || {};
  const source = String(entry.source || "").toLowerCase();
  const route = String(entry.route || "").toLowerCase();
  const rpc = String(entry.rpc || "").toLowerCase();
  const endpoint = String(entry.endpoint || "").toLowerCase();
  if (/state-load|write-context/.test(source) || /\/api\/state\/load|\/api\/context\/write/.test(endpoint)) return "Core loading";
  if (/workspace-tools-refresh|workspace-switch|workspace-invite|invite-email|member-profile|profile-setup/.test(source) || /list_my_ledgers|create_private_ledger_workspace|redeem_ledger_invite|update_own_ledger_member_profile|check_ledger_invite_email/.test(rpc)) return "Workspace & invites";
  if (/vehicle-lookup|settings-save/.test(source) || /\/api\/vehicle\/lookup|\/api\/settings\/save/.test(endpoint)) return "Vehicle & settings";
  if (/trip|fuel|booking|payment|settlement/.test(source) || /\/api\/(trips|fuel|bookings|payments)\//.test(endpoint)) return "Trips, fuel, bookings & payments";
  if (source.startsWith("admin-tool:") || source.startsWith("admin-") || /retention|security-health|admin-report|admin-test-data|normalized-test-data|json-mirror-backup/.test(source)) return "Admin diagnostics";
  if (source === "owner-activity") return "Admin diagnostics";
  if (route === "render-api") return "Core loading";
  return "Background noise";
}

function dataIoOperationHasIssue(operation = {}) {
  const status = String(operation.status || "").toLowerCase();
  return /failed|timeout|blocked/.test(status);
}

function dataIoOperationFriendlyName(operation = {}) {
  const entry = operation.latest || operation.start || operation.finish || {};
  const source = String(entry.source || "unknown");
  const map = {
    "state-load": "Load workspace data",
    "workspace-tools-refresh": "Refresh workspace list/invites",
    "workspace-switch": "Switch workspace",
    "vehicle-lookup": "Lookup vehicle",
    "settings-save": "Save settings",
    "owner-activity": "Load owner activity",
    "admin-render-health": "Check Render admin health",
    "admin-tool:render-admin-health": "Run Render admin health",
    "workspace-invite-create": "Create invite",
    "workspace-invite-redeem": "Redeem invite",
    "invite-email-preflight": "Check invite email"
  };
  return map[source] || source.replace(/^admin-tool:/, "Admin: ").replace(/-/g, " ");
}

function ownerActivityFriendlyAction(action = "") {
  const normalized = String(action || "activity").toLowerCase();
  const map = {
    "state-load": "Workspace opened",
    "members-list": "Members viewed",
    "vehicle-lookup": "Vehicle lookup",
    "settings-save": "Settings saved",
    "trip-upsert": "Trip saved",
    "fuel-upsert": "Fuel saved",
    "booking-upsert": "Booking saved",
    "payment-status-action": "Payment updated"
  };
  return map[normalized] || String(action || "activity").replace(/-/g, " ");
}

function dataIoOperationTargetLabel(operation = {}) {
  const entry = operation.latest || operation.start || operation.finish || {};
  return entry.endpoint || entry.rpc || entry.table || entry.operation || "";
}

function dataIoSectionSummary(operations = []) {
  const total = operations.length;
  const issues = operations.filter(dataIoOperationHasIssue).length;
  const active = operations.filter((operation) => String(operation.status || "") === "active").length;
  const ok = operations.filter((operation) => String(operation.status || "") === "ok").length;
  const skipped = operations.filter((operation) => String(operation.status || "") === "skipped").length;
  return `${total} action${total === 1 ? "" : "s"} · ${ok} ok${skipped ? ` · ${skipped} skipped` : ""}${active ? ` · ${active} running` : ""}${issues ? ` · ${issues} need review` : ""}`;
}

function renderDataIoGroupedSections() {
  const groups = Array.from(latestDataIoOperationsByGroup(10).entries());
  if (!groups.length) return "";
  const preferredOrder = ["Core loading", "Workspace & invites", "Vehicle & settings", "Trips, fuel, bookings & payments", "Admin diagnostics", "Background noise"];
  groups.sort((a, b) => preferredOrder.indexOf(a[0]) - preferredOrder.indexOf(b[0]));
  return groups.map(([group, operations]) => {
    const hasIssue = operations.some(dataIoOperationHasIssue);
    const open = hasIssue || group === "Core loading" || group === "Workspace & invites" || group === "Vehicle & settings";
    return `
      <details class="admin-diagnostics-section" ${open ? "open" : ""}>
        <summary>${escapeHtml(group)} <span class="entry-meta">${escapeHtml(dataIoSectionSummary(operations))}</span></summary>
        <div class="admin-operation-list">
          ${operations.map((operation) => {
            const entry = operation.latest || operation.start || operation.finish || {};
            const finish = operation.finish || operation.latest || entry;
            const timeSource = operation.finish || operation.start || entry;
            const status = operation.status || dataIoStatusForPhase(entry.phase, entry.ok);
            const duration = Number.isFinite(operation.durationMs) ? formatDurationMs(operation.durationMs) : status === "active" ? "active" : "instant";
            const code = finish.resultCode || finish.code || entry.resultCode || entry.code || "";
            const target = dataIoOperationTargetLabel(operation);
            const detail = finish.detail || finish.error?.message || entry.detail || "";
            return `<article class="admin-operation-row ${escapeHtml(status)}"><div><strong>${escapeHtml(dataIoOperationFriendlyName(operation))}</strong><small>${target ? `${escapeHtml(target)} · ` : ""}${code ? `code ${escapeHtml(code)}` : ""}</small>${entry.workspaceLabel || entry.activeLedgerId ? `<small>Workspace: ${escapeHtml(entry.workspaceLabel || entry.activeLedgerId || "current")}</small>` : ""}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div><span>${escapeHtml(status)}</span><small>${escapeHtml(new Date(timeSource.at || entry.at).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))} · ${escapeHtml(duration)}</small></article>`;
          }).join("")}
        </div>
      </details>`;
  }).join("");
}

function latestDataIoOperationsByGroup(limitPerGroup = 8) {
  const groups = new Map();
  latestDataIoOperations(40).forEach((operation) => {
    const group = dataIoOperationGroup(operation);
    if (!groups.has(group)) groups.set(group, []);
    if (groups.get(group).length < limitPerGroup) groups.get(group).push(operation);
  });
  return groups;
}

function latestDataIoDiagnostics(limit = 6) {
  return dataIoDiagnostics.slice(-limit).reverse();
}

function latestDataIoOperations(limit = 6) {
  const operations = [];
  const openBySignature = new Map();
  dataIoDiagnostics.forEach((entry) => {
    const signature = dataIoSignature(entry);
    const atMs = Date.parse(entry.at || "");
    if (entry.phase === "start") {
      const operation = {
        signature,
        start: entry,
        finish: null,
        latest: entry,
        status: "active",
        durationMs: null,
        startedAtMs: Number.isFinite(atMs) ? atMs : 0,
        finishedAtMs: null,
        staleAfterMs: normalizeDataIoOperationStaleMs(entry.staleAfterMs)
      };
      operations.push(operation);
      openBySignature.set(signature, operation);
      return;
    }
    const open = openBySignature.get(signature);
    if (open && !open.finish) {
      open.finish = entry;
      open.latest = entry;
      open.status = dataIoStatusForPhase(entry.phase, entry.ok);
      open.staleAfterMs = normalizeDataIoOperationStaleMs(entry.staleAfterMs, open.staleAfterMs);
      const startMs = Date.parse(open.start?.at || "");
      if (Number.isFinite(startMs) && Number.isFinite(atMs)) {
        open.durationMs = Math.max(0, Math.round(atMs - startMs));
        open.finishedAtMs = atMs;
      }
      openBySignature.delete(signature);
      return;
    }
    operations.push({
      signature,
      start: null,
      finish: entry,
      latest: entry,
      status: dataIoStatusForPhase(entry.phase, entry.ok),
      durationMs: null,
      startedAtMs: Number.isFinite(atMs) ? atMs : 0,
      finishedAtMs: Number.isFinite(atMs) ? atMs : null,
      staleAfterMs: normalizeDataIoOperationStaleMs(entry.staleAfterMs)
    });
  });
  const now = Date.now();
  operations.forEach((operation) => {
    if (operation.status !== "active") return;
    const startedAtMs = Number(operation.startedAtMs || Date.parse(operation.start?.at || ""));
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return;
    const ageMs = now - startedAtMs;
    const staleAfterMs = normalizeDataIoOperationStaleMs(operation.staleAfterMs || operation.start?.staleAfterMs);
    if (ageMs >= staleAfterMs) {
      operation.status = "timeout";
      operation.durationMs = Math.max(0, Math.round(ageMs));
      operation.finishedAtMs = now;
      operation.latest = operation.finish || operation.start || operation.latest;
    }
  });
  return operations
    .slice()
    .sort((a, b) => (b.finishedAtMs || b.startedAtMs || 0) - (a.finishedAtMs || a.startedAtMs || 0))
    .slice(0, limit);
}

function isOptionalOwnerActivityOperation(operation = {}) {
  const entry = operation.latest || operation.start || operation.finish || {};
  return String(entry.source || "").toLowerCase() === "owner-activity";
}

function isOptionalWorkspaceToolsOperation(operation = {}) {
  const entry = operation.latest || operation.start || operation.finish || {};
  const source = String(entry.source || "").toLowerCase();
  return source === "workspace-tools-refresh";
}

function isOptionalAdminPanelOperation(operation = {}) {
  return isOptionalOwnerActivityOperation(operation) || isOptionalWorkspaceToolsOperation(operation);
}

function isOptionalOwnerActivityDiagnostic(entry = {}) {
  return String(entry.source || "").toLowerCase() === "owner-activity";
}

function isOptionalWorkspaceToolsDiagnostic(entry = {}) {
  return String(entry.source || "").toLowerCase() === "workspace-tools-refresh";
}

function isOptionalAdminPanelDiagnostic(entry = {}) {
  return isOptionalOwnerActivityDiagnostic(entry) || isOptionalWorkspaceToolsDiagnostic(entry);
}

function latestDataIoDiagnostic({ includeOptionalAdminAudit = false } = {}) {
  const diagnostics = latestDataIoDiagnostics(30);
  return (includeOptionalAdminAudit ? diagnostics : diagnostics.filter((entry) => !isOptionalAdminPanelDiagnostic(entry)))[0] || null;
}

function latestDataIoOperation({ includeOptionalAdminAudit = false } = {}) {
  const operations = latestDataIoOperations(12);
  return (includeOptionalAdminAudit ? operations : operations.filter((operation) => !isOptionalAdminPanelOperation(operation)))[0] || null;
}

function hasActiveDataIoOperation(referenceTime = Date.now(), maxAgeMs = dataIoOperationStaleMs) {
  return latestDataIoOperations(12).some((operation) => {
    if (operation.status !== "active") return false;
    const startedAtMs = Number(operation.startedAtMs || Date.parse(operation.start?.at || ""));
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return true;
    return referenceTime - startedAtMs < maxAgeMs;
  });
}

function hasForegroundWriteInFlight(referenceTime = Date.now()) {
  return hasActiveForegroundOperation(referenceTime) || pendingSettlementRequestKeys.size > 0 || hasActiveDataIoOperation(referenceTime, dataIoOperationStaleMs);
}

function shouldDeferBackgroundCloudLoad(reason = "background", referenceTime = Date.now()) {
  const normalizedReason = String(reason || "background");
  const isBackgroundReason = /window-focus|focus|ledger-event-auto-sync|realtime|visibility|background/.test(normalizedReason);
  if (!isBackgroundReason) return false;
  if (hasForegroundWriteInFlight(referenceTime)) return true;
  return false;
}

function latestSupabaseActivityGroups(limit = 8) {
  const grouped = [];
  const byKey = new Map();
  getSupabaseLoadEvents(30 * 60 * 1000).forEach((entry) => {
    const key = `${entry.label || ""}|${entry.detail || ""}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        label: entry.label || "activity",
        detail: entry.detail || "",
        count: 0,
        firstAt: entry.at,
        lastAt: entry.at
      };
      byKey.set(key, group);
      grouped.push(group);
    }
    group.count += 1;
    group.lastAt = entry.at;
  });
  return grouped
    .sort((a, b) => Date.parse(b.lastAt || "") - Date.parse(a.lastAt || ""))
    .slice(0, limit);
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs)) return "";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)} s`;
}

function summarizeSupabaseError(error) {
  if (!error) return null;
  return {
    message: String(error.message || error.error_description || error.details || error.hint || error || "Unknown Supabase error"),
    code: error.code || error.status || error.statusCode || "",
    details: error.details || error.error_description || "",
    hint: error.hint || "",
    name: error.name || ""
  };
}

function recordSyncDiagnostic(stage, detail = "", extra = {}) {
  const diagnostic = {
    at: new Date().toISOString(),
    stage: String(stage || "sync"),
    detail: String(detail || ""),
    ledgerId: supabaseHelpers?.getLedgerId ? supabaseHelpers.getLedgerId(supabaseConfig) : "",
    activeLedgerId,
    hasSupabaseClient: Boolean(supabaseClient),
    hasSession: Boolean(currentSession),
    userEmail: currentSession?.user?.email || "",
    pendingLocalChanges,
    lastCloudSyncAt,
    lastCloudSaveAt,
    normalizedReadModeActive,
    normalizedTableOk: normalizedTableStatus?.ok === true,
    supabaseLoadInFlight,
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    error: summarizeSupabaseError(extra.error),
    ...Object.fromEntries(Object.entries(extra || {}).filter(([key]) => key !== "error"))
  };
  lastSyncDiagnostic = diagnostic;
  syncDiagnostics.push(diagnostic);
  while (syncDiagnostics.length > 20) syncDiagnostics.shift();
  recordSupabaseLoadEvent(`sync-diagnostic:${diagnostic.stage}`, diagnostic.detail || diagnostic.error?.message || "", { diagnostic: true });
  renderSupabaseLoadMonitor();
  return diagnostic;
}

function latestSyncDiagnostics(limit = 5) {
  return syncDiagnostics.slice(-limit).reverse();
}

function hasRecentHealthyCloudSync(referenceTime = Date.now(), graceMs = syncDelayHealthyGraceMs) {
  const lastHealthySyncMs = Date.parse(lastCloudSyncAt || lastCloudSaveAt || "");
  return Number.isFinite(lastHealthySyncMs) && referenceTime - lastHealthySyncMs <= graceMs;
}

function shouldSurfaceBackgroundSyncDelay(referenceTime = Date.now()) {
  return !hasRecentHealthyCloudSync(referenceTime, syncDelayHealthyGraceMs);
}

function shouldSurfaceManualSyncDelay(referenceTime = Date.now()) {
  return !hasRecentHealthyCloudSync(referenceTime, syncDelayHealthyGraceMs);
}

function isRecoverableSyncDelayMessage(message = "") {
  return /sync is delayed|sync timed out|taking longer|did not complete|background sync|manual cloud sync/i.test(String(message || ""));
}

function hasRecentHardSyncFailure(limit = 6) {
  return latestSyncDiagnostics(limit).some((entry) => /^(save-error|load-error|json-mirror-load-error|normalized-table-fallback)$/i.test(String(entry.stage || "")));
}

function clearRecoverableSyncDelayAfterHealthySync(reason = "healthy-sync") {
  if (!lastSyncError && !lastCloudRetryAt) return false;
  if (pendingLocalChanges > 0) return false;
  if (!hasRecentHealthyCloudSync(Date.now(), syncDelayHealthyGraceMs)) return false;
  if (!isRecoverableSyncDelayMessage(lastSyncError || "Cloud sync is delayed.")) return false;
  if (hasRecentHardSyncFailure()) return false;
  clearSyncDelay(reason);
  if (els.syncStatus && String(els.syncStatus.dataset.status || "") === "delayed") {
    setSyncStatus(normalizedReadModeActive ? "Tables" : "Cloud");
  }
  recordSupabaseLoadEvent("stale-sync-delay-suppressed", reason);
  return true;
}

function getHealthySyncStatusLabel() {
  if (!supabaseClient || !currentSession) return "Login";
  return normalizedReadModeActive ? "Tables" : "Cloud";
}

function restoreHealthySyncStatusAfterQuietSync(reason = "quiet-sync") {
  if (els.syncStatus && ["saving", "syncing"].includes(String(els.syncStatus.dataset.status || ""))) {
    setSyncStatus(getHealthySyncStatusLabel());
  }
  clearSyncDelay(reason);
  renderSyncHealthBanner();
}

function clearVisibleSavingFailsafe() {
  if (visibleSavingFailsafeTimer) {
    window.clearTimeout(visibleSavingFailsafeTimer);
    visibleSavingFailsafeTimer = null;
  }
}

function scheduleVisibleSavingFailsafe(source = "saving") {
  if (!els.syncStatus) return;
  clearVisibleSavingFailsafe();
  visibleSavingFailsafeTimer = window.setTimeout(() => {
    clearStaleVisibleSavingStatus(`failsafe:${source}`);
  }, visibleSavingFailsafeMs);
}

function clearStaleVisibleSavingStatus(reason = "saving-failsafe") {
  if (!els.syncStatus || String(els.syncStatus.dataset.status || "") !== "saving") return false;
  purgeStaleForegroundOperations(reason);
  const savingAgeMs = visibleSavingStartedAt ? Date.now() - visibleSavingStartedAt : visibleSavingFailsafeMs;
  const foregroundWriteActive = hasActiveForegroundOperation();
  if (foregroundWriteActive && savingAgeMs < visibleSavingFailsafeMs) {
    scheduleVisibleSavingFailsafe(reason);
    recordSyncDiagnostic("saving-failsafe-wait", "Saving badge is still tied to an active foreground operation.", { reason, savingAgeMs, activeForeground: foregroundOperationSummary(), visibleSavingSource });
    return false;
  }
  finishAllForegroundOperations(`saving-stale-cleared:${reason}`);
  clearSyncDelay(`saving-stale-cleared:${reason}`);
  setSyncStatus(getHealthySyncStatusLabel());
  recordSupabaseLoadEvent("saving-stale-cleared", reason);
  recordSyncDiagnostic("saving-stale-cleared", "Stale visible Saving state was cleared automatically.", { reason, savingAgeMs, foregroundWriteActive, activeForeground: foregroundOperationSummary(), visibleSavingSource });
  renderSupabaseLoadMonitor();
  return true;
}

function clearVisibleSyncingFailsafe() {
  if (visibleSyncingFailsafeTimer) {
    window.clearTimeout(visibleSyncingFailsafeTimer);
    visibleSyncingFailsafeTimer = null;
  }
}

function scheduleVisibleSyncingFailsafe(source = "syncing") {
  if (!els.syncStatus) return;
  clearVisibleSyncingFailsafe();
  visibleSyncingFailsafeTimer = window.setTimeout(() => {
    clearStaleVisibleSyncingStatus(`failsafe:${source}`);
  }, visibleSyncingFailsafeMs);
}

function clearStaleVisibleSyncingStatus(reason = "syncing-failsafe") {
  if (!els.syncStatus || String(els.syncStatus.dataset.status || "") !== "syncing") return false;
  const now = Date.now();
  const syncingAgeMs = visibleSyncingStartedAt ? now - visibleSyncingStartedAt : visibleSyncingFailsafeMs;
  const activeLoadAgeMs = supabaseLoadInFlight ? now - Number(supabaseLoadStartedAt || 0) : 0;
  if (supabaseLoadInFlight && activeLoadAgeMs > 0 && activeLoadAgeMs < supabaseStaleLoadMs) {
    scheduleVisibleSyncingFailsafe(reason);
    recordSyncDiagnostic("syncing-failsafe-wait", "Syncing badge is still tied to an active cloud load.", { reason, syncingAgeMs, activeLoadAgeMs, visibleSyncingSource });
    return false;
  }
  if (supabaseLoadInFlight && activeLoadAgeMs >= supabaseStaleLoadMs) {
    markSupabaseLoadTimedOut(`visible syncing stale (${reason})`);
  }
  if (lastSyncError && !hasRecentHealthyCloudSync(now, syncDelayHealthyGraceMs)) {
    setSyncStatus("Delayed");
  } else {
    clearSyncDelay(`syncing-stale-cleared:${reason}`);
    setSyncStatus(getHealthySyncStatusLabel());
  }
  recordSupabaseLoadEvent("syncing-stale-cleared", reason);
  recordSyncDiagnostic("syncing-stale-cleared", "Stale visible Syncing state was cleared automatically.", { reason, syncingAgeMs, activeLoadAgeMs, visibleSyncingSource });
  renderSupabaseLoadMonitor();
  return true;
}

function clearSyncDelay(reason = "sync-recovered") {
  const hadDelay = Boolean(lastSyncError || lastCloudRetryAt);
  lastSyncError = "";
  lastCloudRetryAt = "";
  if (hadDelay) {
    recordSupabaseLoadEvent("sync-delay-cleared", reason);
  }
}
let pendingLocalChanges = 0;
let lastLocalSaveAt = "";
const jsonMirrorBackupIntervalMs = 30 * 60 * 1000;
const auditJsonMirrorBackupIntervalMs = 5 * 60 * 1000;
let normalizedReconciliationDirty = false;
let jsonMirrorBackupTimer = null;
let normalizedTableStatus = {
  checked: false,
  ok: false,
  message: "Normalized tables have not been checked yet.",
  details: []
};
const supabaseLoadSafety = {
  normalizedCheckInFlight: false,
  normalizedCheckTimer: null,
  lastNormalizedCheckAt: 0,
  normalizedCheckCooldownMs: 60 * 1000,
  securityHealthInFlight: false,
  lastSecurityHealthAt: 0,
  securityHealthCooldownMs: 2 * 60 * 1000,
  testLabReportLoadInFlight: false,
  lastTestLabReportLoadAt: 0,
  testLabReportLoadCooldownMs: 10 * 1000,
  requests: []
};
const requiredAdminSafetyBackupReasons = Object.freeze([
  "reset current period",
  "reset all local data",
  "import backup",
  "close current period",
  "production activity reset",
  "purge soft-deleted generated test rows",
  "remove generated test data",
  "cleanup generated test data",
  "retention cleanup",
  "remove unused test users"
]);
const adminSafetyBackupFreshMs = 60 * 1000;
let lastAdminSafetyBackup = null;

const retentionPolicy = Object.freeze({
  ledgerEventDays: 30,
  testLabReportDays: 30,
  keepLatestTestLabReports: 3,
  cloudTestLabReportDays: 30,
  keepLatestCloudTestLabReports: 10,
  stalePushSubscriptionDays: 180,
  localLoadMonitorEventMinutes: 60,
  maxStoredReportReleaseNotes: 5,
  maxStoredReportDiagnosticRows: 20
});
let lastRetentionCleanupPreview = null;
let renderAdminHealthStatus = {
  checked: false,
  ok: false,
  loading: false,
  message: "Render admin health has not been checked yet.",
  checks: []
};
let ownerActivityStatus = {
  checked: false,
  ok: false,
  loading: false,
  message: "Owner activity has not been loaded yet.",
  rows: [],
  checkedAt: ""
};
let ownerActivityFetchInFlight = false;
let ownerActivityFetchStartedAt = 0;
let ownerActivityInFlightTraceMeta = null;
let lastOwnerActivityFetchAt = 0;
let ownerActivityCooldownUntil = 0;
let lastOwnerActivityTimeoutAt = 0;
let ownerActivityConsecutiveTimeouts = 0;
let lastOwnerActivityCooldownDiagnosticAt = 0;
const ownerActivityFreshMs = 30000;
const ownerActivityTimeoutCooldownBaseMs = 120000;
const ownerActivityTimeoutCooldownMaxMs = 300000;
const ownerActivityVisibleRowLimit = 6;
let ownerActivityAutoPausedUntilManual = false;
let ownerActivityInitialAdminLoadAttempted = false;
let ownerActivityScope = localStorage.getItem("ownerActivityScope") === "all" ? "all" : "current";
let supabaseSecurityStatus = {
  checked: false,
  ok: false,
  mode: "pending",
  message: "Supabase security health has not been checked yet.",
  checks: []
};
let latestHealthcheckRpcPayload = null;
let latestHealthcheckRpcCheckedAt = "";

function normalizeHealthcheckRpcPayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    const first = payload.find(Boolean);
    return normalizeHealthcheckRpcPayload(first);
  }
  if (payload && typeof payload === "object" && payload.fuel_ledger_healthcheck && typeof payload.fuel_ledger_healthcheck === "object") {
    return payload.fuel_ledger_healthcheck;
  }
  return payload && typeof payload === "object" ? payload : null;
}

function rememberHealthcheckRpcPayload(payload, checkedAt = new Date().toISOString()) {
  const normalized = normalizeHealthcheckRpcPayload(payload);
  if (!normalized) return null;
  latestHealthcheckRpcPayload = normalized;
  latestHealthcheckRpcCheckedAt = checkedAt;
  return latestHealthcheckRpcPayload;
}
let databaseDiagnosticsStatus = {
  checked: false,
  loading: false,
  error: "",
  rows: []
};
let memberManagementStatus = {
  loaded: false,
  loading: false,
  error: "",
  rows: []
};
let workspaceInviteStatus = {
  loaded: false,
  loading: false,
  error: "",
  ledgers: [],
  rawLedgers: [],
  invites: [],
  lastCreatedInvite: null
};
let workspaceMembershipProbeStatus = {
  checked: false,
  ok: false,
  loading: false,
  error: "",
  reason: "not-checked",
  signedInEmail: "",
  rows: []
};
let workspaceInviteRefreshPromise = null;
let workspaceInviteRefreshQueued = false;
let lastWorkspaceInviteRefreshAt = 0;
const workspaceInviteRefreshFreshMs = 5000;
const activeMemberActionOperations = new Set();
let normalizedReadModeActive = false;
const pendingSettlementRequestKeys = new Set();
const viewStorageKey = "fuel-ledger-active-view";
let activeView = localStorage.getItem(viewStorageKey) || "log";
const bookingCalendarViewStorageKey = "fuel-ledger-booking-calendar-view";
let bookingCalendarView = localStorage.getItem(bookingCalendarViewStorageKey) || "list";
const historySectionStorageKey = "fuel-ledger-history-section";
let activeHistorySection = localStorage.getItem(historySectionStorageKey) || "booking";
let tripPlannerBookingDraft = null;
const paymentSectionStorageKey = "fuel-ledger-payment-section";
let activePaymentSection = localStorage.getItem(paymentSectionStorageKey) || "all";

const els = {
  totalKm: document.querySelector("#totalKm"),
  fuelRate: document.querySelector("#fuelRate"),
  totalCost: document.querySelector("#totalCost"),
  totalPaid: document.querySelector("#totalPaid"),
  sectionTabs: Array.from(document.querySelectorAll("[data-view-tab]")),
  viewSections: Array.from(document.querySelectorAll("[data-view]")),
  historySectionTabs: Array.from(document.querySelectorAll("[data-history-section-tab]")),
  historySections: Array.from(document.querySelectorAll("[data-history-section]")),
  paymentSectionTabs: Array.from(document.querySelectorAll("[data-payment-section-tab]")),
  authPanel: document.querySelector("#authPanel"),
  loginForm: document.querySelector("#loginForm"),
  otpForm: document.querySelector("#otpForm"),
  loginEmail: document.querySelector("#loginEmail"),
  loginInviteCode: document.querySelector("#loginInviteCode"),
  loginInviteHint: document.querySelector("#loginInviteHint"),
  loginCode: document.querySelector("#loginCode"),
  authMessage: document.querySelector("#authMessage"),
  signOut: document.querySelector("#signOut"),
  currentUser: document.querySelector("#currentUser"),
  activeWorkspace: document.querySelector("#activeWorkspace"),
  topbarWorkspaceScope: document.querySelector("#topbarWorkspaceScope"),
  syncStatus: document.querySelector("#syncStatus"),
  syncDetail: document.querySelector("#syncDetail"),
  syncNow: document.querySelector("#syncNow"),
  syncHealthBanner: document.querySelector("#syncHealthBanner"),
  tripDriver: document.querySelector("#tripDriver"),
  bookingMember: document.querySelector("#bookingMember"),
  fuelPayer: document.querySelector("#fuelPayer"),
  tripDate: document.querySelector("#tripDate"),
  pendingLogList: document.querySelector("#pendingLogList"),
  bookingStart: document.querySelector("#bookingStart"),
  bookingEnd: document.querySelector("#bookingEnd"),
  bookingPurpose: document.querySelector("#bookingPurpose"),
  tripParticipants: document.querySelector("#tripParticipants"),
  fuelDate: document.querySelector("#fuelDate"),
  startKm: document.querySelector("#startKm"),
  endKm: document.querySelector("#endKm"),
  tripNote: document.querySelector("#tripNote"),
  tripCorrectionPanel: document.querySelector("#tripCorrectionPanel"),
  fuelAmount: document.querySelector("#fuelAmount"),
  fuelLiters: document.querySelector("#fuelLiters"),
  fuelOdometer: document.querySelector("#fuelOdometer"),
  fuelStation: document.querySelector("#fuelStation"),
  fuelLocationPrivacyMode: document.querySelector("#fuelLocationPrivacyMode"),
  useFuelLocation: document.querySelector("#useFuelLocation"),
  nearbyFuelStations: document.querySelector("#nearbyFuelStations"),
  stationResults: document.querySelector("#stationResults"),
  fuelLocationStatus: document.querySelector("#fuelLocationStatus"),
  fuelLatitude: document.querySelector("#fuelLatitude"),
  fuelLongitude: document.querySelector("#fuelLongitude"),
  fuelStationLatitude: document.querySelector("#fuelStationLatitude"),
  fuelStationLongitude: document.querySelector("#fuelStationLongitude"),
  fuelStationBrand: document.querySelector("#fuelStationBrand"),
  fuelFullTank: document.querySelector("#fuelFullTank"),
  fuelCorrectionPanel: document.querySelector("#fuelCorrectionPanel"),
  periodEntryLock: document.querySelector("#periodEntryLock"),
  tripLogPanel: document.querySelector("#tripLogPanel"),
  tripBookingContext: document.querySelector("#tripBookingContext"),
  fuelLogPanel: document.querySelector("#fuelLogPanel"),
  fuelTripContext: document.querySelector("#fuelTripContext"),
  currency: document.querySelector("#currency"),
  fuelType: document.querySelector("#fuelType"),
  fuelConsumption: document.querySelector("#fuelConsumption"),
  fuelTankCapacity: document.querySelector("#fuelTankCapacity"),
  fuelFallbackPrice: document.querySelector("#fuelFallbackPrice"),
  fuelPriceWarningMin: document.querySelector("#fuelPriceWarningMin"),
  fuelPriceWarningMax: document.querySelector("#fuelPriceWarningMax"),
  fuelWarningThreshold: document.querySelector("#fuelWarningThreshold"),
  vehiclePlate: document.querySelector("#vehiclePlate"),
  vehicleLookupButton: document.querySelector("#vehicleLookupButton"),
  vehicleLookupStatus: document.querySelector("#vehicleLookupStatus"),
  vehicleLookupSummary: document.querySelector("#vehicleLookupSummary"),
  paymentRemindersEnabled: document.querySelector("#paymentRemindersEnabled"),
  paymentReminderAfterDays: document.querySelector("#paymentReminderAfterDays"),
  paymentReminderRepeatDays: document.querySelector("#paymentReminderRepeatDays"),
  paymentReminderMaxCount: document.querySelector("#paymentReminderMaxCount"),
  members: document.querySelector("#members"),
  tripForm: document.querySelector("#tripForm"),
  tripSubmit: document.querySelector("#tripSubmit"),
  cancelTripEdit: document.querySelector("#cancelTripEdit"),
  bookingForm: document.querySelector("#bookingForm"),
  bookingSubmit: document.querySelector("#bookingSubmit"),
  cancelBookingEdit: document.querySelector("#cancelBookingEdit"),
  bookingCalendar: document.querySelector("#bookingCalendar"),
  bookingActivityLog: document.querySelector("#bookingActivityLog"),
  bookingConflictNotice: document.querySelector("#bookingConflictNotice"),
  bookingAvailabilityPreview: document.querySelector("#bookingAvailabilityPreview"),
  bookingDateHints: document.querySelector("#bookingDateHints"),
  fuelForm: document.querySelector("#fuelForm"),
  fuelSubmit: document.querySelector("#fuelSubmit"),
  cancelFuelEdit: document.querySelector("#cancelFuelEdit"),
  tripEstimatorForm: document.querySelector("#tripEstimatorForm"),
  tripEstimateDistance: document.querySelector("#tripEstimateDistance"),
  tripEstimateStart: document.querySelector("#tripEstimateStart"),
  tripEstimateDestination: document.querySelector("#tripEstimateDestination"),
  tripEstimatorParticipants: document.querySelector("#tripEstimatorParticipants"),
  tripEstimateResult: document.querySelector("#tripEstimateResult"),
  workspaceScopeSummary: document.querySelector("#workspaceScopeSummary"),
  fuelIntelligence: document.querySelector("#fuelIntelligence"),
  stationInsights: document.querySelector("#stationInsights"),
  smartPredictions: document.querySelector("#smartPredictions"),
  monthlyMemberSummaries: document.querySelector("#monthlyMemberSummaries"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsPanel: document.querySelector(".settings-panel"),
  settlementWarning: document.querySelector("#settlementWarning"),
  paymentOverview: document.querySelector("#paymentOverview"),
  unpaidPaymentSummary: document.querySelector("#unpaidPaymentSummary"),
  unpaidPaymentList: document.querySelector("#unpaidPaymentList"),
  auditLog: document.querySelector("#auditLog"),
  memberActionPanel: document.querySelector("#memberActionPanel"),
  periodBreakdown: document.querySelector("#periodBreakdown"),
  settlements: document.querySelector("#settlements"),
  peopleBalances: document.querySelector("#peopleBalances"),
  tripList: document.querySelector("#tripList"),
  fuelList: document.querySelector("#fuelList"),
  closePeriod: document.querySelector("#closePeriod"),
  periodSearch: document.querySelector("#periodSearch"),
  periodStatusFilter: document.querySelector("#periodStatusFilter"),
  periodSort: document.querySelector("#periodSort"),
  clearPeriodFilters: document.querySelector("#clearPeriodFilters"),
  periodArchiveSummary: document.querySelector("#periodArchiveSummary"),
  periodList: document.querySelector("#periodList"),
  resetPeriod: document.querySelector("#resetPeriod"),
  resetData: document.querySelector("#resetData"),
  dataToolsPanel: document.querySelector(".data-tools-panel"),
  dataToolsMessage: document.querySelector("#dataToolsMessage"),
  systemHealthPanel: document.querySelector(".system-health-panel"),
  systemHealthSummary: document.querySelector("#systemHealthSummary"),
  systemHealthList: document.querySelector("#systemHealthList"),
  databaseDiagnosticsPanel: document.querySelector(".database-diagnostics-panel"),
  databaseDiagnosticsList: document.querySelector("#databaseDiagnosticsList"),
  refreshDatabaseDiagnostics: document.querySelector("#refreshDatabaseDiagnostics"),
  memberManagementPanel: document.querySelector(".member-management-panel"),
  memberManagementForm: document.querySelector("#memberManagementForm"),
  memberManagementList: document.querySelector("#memberManagementList"),
  memberManagementMessage: document.querySelector("#memberManagementMessage"),
  refreshMembers: document.querySelector("#refreshMembers"),
  newMemberName: document.querySelector("#newMemberName"),
  newMemberEmail: document.querySelector("#newMemberEmail"),
  newMemberMobilePayPhone: document.querySelector("#newMemberMobilePayPhone"),
  newMemberRole: document.querySelector("#newMemberRole"),
  workspaceInvitesPanel: document.querySelector(".workspace-invites-panel"),
  refreshWorkspaceInvites: document.querySelector("#refreshWorkspaceInvites"),
  createWorkspaceForm: document.querySelector("#createWorkspaceForm"),
  newWorkspaceName: document.querySelector("#newWorkspaceName"),
  newWorkspaceSlug: document.querySelector("#newWorkspaceSlug"),
  createWorkspaceMessage: document.querySelector("#createWorkspaceMessage"),
  createInviteForm: document.querySelector("#createInviteForm"),
  inviteEmail: document.querySelector("#inviteEmail"),
  inviteRole: document.querySelector("#inviteRole"),
  inviteExpiresHours: document.querySelector("#inviteExpiresHours"),
  inviteMaxUses: document.querySelector("#inviteMaxUses"),
  createdInviteResult: document.querySelector("#createdInviteResult"),
  inviteWorkspaceScope: document.querySelector("#inviteWorkspaceScope"),
  workspaceList: document.querySelector("#workspaceList"),
  inviteList: document.querySelector("#inviteList"),
  workspaceInvitesMessage: document.querySelector("#workspaceInvitesMessage"),
  inviteRedemptionPanel: document.querySelector("#inviteRedemptionPanel"),
  redeemInviteForm: document.querySelector("#redeemInviteForm"),
  redeemInviteCode: document.querySelector("#redeemInviteCode"),
  redeemInviteButton: document.querySelector("#redeemInviteButton"),
  redeemInviteMessage: document.querySelector("#redeemInviteMessage"),
  memberProfileSetupPanel: document.querySelector("#memberProfileSetupPanel"),
  memberProfileSetupForm: document.querySelector("#memberProfileSetupForm"),
  memberProfileSetupIntro: document.querySelector("#memberProfileSetupIntro"),
  memberProfileEmail: document.querySelector("#memberProfileEmail"),
  memberProfileName: document.querySelector("#memberProfileName"),
  memberProfileMobilePayPhone: document.querySelector("#memberProfileMobilePayPhone"),
  saveMemberProfileSetup: document.querySelector("#saveMemberProfileSetup"),
  memberProfileSetupMessage: document.querySelector("#memberProfileSetupMessage"),
  saveJsonBackupNow: document.querySelector("#saveJsonBackupNow"),
  cleanStaleRequests: document.querySelector("#cleanStaleRequests"),
  productionActivityReset: document.querySelector("#productionActivityReset"),
  exportLedger: document.querySelector("#exportLedger"),
  importLedger: document.querySelector("#importLedger"),
  importLedgerFile: document.querySelector("#importLedgerFile"),
  downloadCsv: document.querySelector("#downloadCsv"),
  downloadPeriodReport: document.querySelector("#downloadPeriodReport"),
  removeTestUsers: document.querySelector("#removeTestUsers"),
  addTestTrip: document.querySelector("#addTestTrip"),
  addTestFuel: document.querySelector("#addTestFuel"),
  removeTestData: document.querySelector("#removeTestData"),
  purgeSoftDeletedTestRows: document.querySelector("#purgeSoftDeletedTestRows"),
  runStressTest: document.querySelector("#runStressTest"),
  runFullTestLab: document.querySelector("#runFullTestLab"),
  runScenarioMatrix: document.querySelector("#runScenarioMatrix"),
  runPaymentScenario: document.querySelector("#runPaymentScenario"),
  runBackupScenario: document.querySelector("#runBackupScenario"),
  runPrivacyScenario: document.querySelector("#runPrivacyScenario"),
  runRuntimeScenario: document.querySelector("#runRuntimeScenario"),
  runSecurityScenario: document.querySelector("#runSecurityScenario"),
  unlockAdvancedAdminTools: document.querySelector("#unlockAdvancedAdminTools"),
  advancedAdminToolsStatus: document.querySelector("#advancedAdminToolsStatus"),
  advancedAdminToolsPanel: document.querySelector(".admin-advanced-tools"),
  runRapidSaveTest: document.querySelector("#runRapidSaveTest"),
  exportTestLabReport: document.querySelector("#exportTestLabReport"),
  saveTestLabReportCloud: document.querySelector("#saveTestLabReportCloud"),
  cleanupTestLabData: document.querySelector("#cleanupTestLabData"),
  testLabReport: document.querySelector("#testLabReport"),
  adminGuardrailOverview: document.querySelector("#adminGuardrailOverview"),
  supabaseLoadMonitor: document.querySelector("#supabaseLoadMonitor"),
  refreshSupabaseLoadMonitor: document.querySelector("#refreshSupabaseLoadMonitor"),
  exportSupabaseLoadReport: document.querySelector("#exportSupabaseLoadReport"),
  syncNowAdmin: document.querySelector("#syncNowAdmin"),
  toggleLiveSync: document.querySelector("#toggleLiveSync"),
  previewRetentionCleanup: document.querySelector("#previewRetentionCleanup"),
  runRetentionCleanup: document.querySelector("#runRetentionCleanup"),
  retentionCleanupSummary: document.querySelector("#retentionCleanupSummary"),
  checkRenderAdminHealth: document.querySelector("#checkRenderAdminHealth"),
  refreshAboutBuildInfo: document.querySelector("#refreshAboutBuildInfo"),
  refreshBuildInfo: document.querySelector("#refreshBuildInfo"),
  pwaPanel: document.querySelector("#pwaPanel"),
  pwaMessage: document.querySelector("#pwaMessage"),
  installApp: document.querySelector("#installApp"),
  enablePush: document.querySelector("#enablePush"),
  emptyTemplate: document.querySelector("#emptyTemplate")
};

const bookingCalendarController = window.FuelBookingCalendar.createBookingCalendarController({
  els,
  getState: () => state,
  getBookingCalendarView: () => bookingCalendarView,
  setBookingCalendarViewValue: (view) => { bookingCalendarView = view; },
  bookingCalendarViewStorageKey,
  escapeHtml,
  localDateString,
  renderPermissionNote,
  canManageBookingEntry,
  canCreateTripFromBooking,
  findTripForBooking,
  findFullTankFuelForTrip,
  describeBookingPermissionMessage: (...args) => describeBookingPermissionMessage(...args),
  describeCurrentActor,
  formatNumber,
  formatTypedLogRef
});

const renderBookings = bookingCalendarController.renderBookings;
const setBookingCalendarView = bookingCalendarController.setBookingCalendarView;
const setBookingCalendarAnchor = bookingCalendarController.setBookingCalendarAnchor;
const renderBookingConflictNotice = bookingCalendarController.renderBookingConflictNotice;
const renderBookingAvailabilityPreview = bookingCalendarController.renderBookingAvailabilityPreview;
const clearBookingAvailabilityPreview = bookingCalendarController.clearBookingAvailabilityPreview;
const validateBookingInput = bookingCalendarController.validateBookingInput;
const findBookingConflict = bookingCalendarController.findBookingConflict;
const bookingStartMs = bookingCalendarController.bookingStartMs;
const bookingEndMs = bookingCalendarController.bookingEndMs;
const normalizeBookingDateTime = bookingCalendarController.normalizeBookingDateTime;
const bookingDateTimeToIso = bookingCalendarController.bookingDateTimeToIso;
const isBookingOverlapError = bookingCalendarController.isBookingOverlapError;
const isMissingBookingTableError = bookingCalendarController.isMissingBookingTableError;
const toDateTimeLocalInputValue = bookingCalendarController.toDateTimeLocalInputValue;
const formatBookingRange = bookingCalendarController.formatBookingRange;
const parseBookingDate = bookingCalendarController.parseBookingDate;
const describeBookingAuditChanges = bookingCalendarController.describeBookingAuditChanges;
const describeBookingPermissionMessage = bookingCalendarController.describeBookingPermissionMessage;

async function initApp() {
  // 1. Wait for IndexedDB to fetch our saved data
  state = await loadState();

  // 2. Now boot up the app UI with the real data
  state.lastOdometer = getLatestOdometer();
  setDefaultDates();
  initializeInviteDeepLink();
  render();

  initializeSync()
    .then(() => {
      handleStartupDeepLinks({ silent: true });
      return runAutomaticPaymentReminders();
    })
    .catch((error) => console.warn("Automatic payment reminder check failed", error));

  initializePwa();
  refreshFuelPriceEstimate();
}

// 3. Kick off the asynchronous boot sequence!
initApp();
window.addEventListener("hashchange", () => handleStartupDeepLinks());

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-sync-health-action]")) return;
  focusSyncHealthAction();
});

document.addEventListener("click", (event) => {
  const scopeButton = event.target.closest("[data-owner-activity-scope]");
  if (scopeButton) {
    event.preventDefault();
    if (!requireGlobalAdminToolsPermission("Change owner activity scope")) return;
    ownerActivityScope = scopeButton.dataset.ownerActivityScope === "all" ? "all" : "current";
    localStorage.setItem("ownerActivityScope", ownerActivityScope);
    refreshOwnerActivity({ force: true, silent: false, bypassCooldown: true, reason: `manual-scope-${ownerActivityScope}` }).catch((error) => {
      setDataToolsMessage(`Owner activity refresh failed: ${error?.message || error}`);
    });
    return;
  }
  const button = event.target.closest("[data-owner-activity-refresh]");
  if (!button) return;
  event.preventDefault();
  if (!requireGlobalAdminToolsPermission("Refresh owner activity")) return;
  refreshOwnerActivity({ force: true, silent: false, bypassCooldown: true, reason: "manual-refresh" }).catch((error) => {
    setDataToolsMessage(`Owner activity refresh failed: ${error?.message || error}`);
  });
});

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  rememberLoginInviteCode();
  await sendLoginLink();
});

els.loginInviteCode?.addEventListener("input", () => {
  rememberLoginInviteCode();
});

els.memberProfileName?.addEventListener("input", () => {
  els.memberProfileName.dataset.touched = "true";
});

els.memberProfileMobilePayPhone?.addEventListener("input", () => {
  els.memberProfileMobilePayPhone.dataset.touched = "true";
});

els.otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await verifyLoginCode();
});

els.signOut.addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  currentSession = null;
  resetAuthBoundMemberProfile();
  unsubscribeFromLedgerEvents();
  updateAuthUi();
});

if (els.installApp) {
  els.installApp.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updatePwaUi();
  });
}

if (els.enablePush) {
  els.enablePush.addEventListener("click", async () => {
    await enablePushNotifications();
  });
}

els.currentUser.addEventListener("change", () => {
  currentUser = els.currentUser.value;
  localStorage.setItem(userKey, currentUser);
  renderPeopleSelectors();
});

els.tripDriver.addEventListener("change", () => {
  ensureSelectedTripDriverParticipant();
});

if (els.bookingForm) {
  els.bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canUseAppAsMember()) {
      showUserError("Your email is not assigned to a member yet. Ask an admin to add it.");
      return;
    }

    const bookingId = editingBookingId || crypto.randomUUID();
    const existingBooking = editingBookingId ? state.bookings.find((booking) => booking.id === editingBookingId) : null;
    const bookingPayload = {
      id: bookingId,
      logRef: existingBooking?.logRef || createLogRef(bookingId),
      member: els.bookingMember.value,
      start: normalizeBookingDateTime(els.bookingStart.value),
      end: normalizeBookingDateTime(els.bookingEnd.value),
      purpose: els.bookingPurpose.value.trim(),
      createdBy: currentUser || els.bookingMember.value,
      plannedDistanceKm: tripPlannerBookingDraft?.distanceKm || existingBooking?.plannedDistanceKm || null,
      routeFrom: tripPlannerBookingDraft?.routeFrom || existingBooking?.routeFrom || "",
      routeTo: tripPlannerBookingDraft?.routeTo || existingBooking?.routeTo || "",
      plannedParticipants: Array.isArray(tripPlannerBookingDraft?.participants) ? tripPlannerBookingDraft.participants : (Array.isArray(existingBooking?.plannedParticipants) ? existingBooking.plannedParticipants : [])
    };

    const validation = validateBookingInput(bookingPayload, editingBookingId);
    if (!validation.ok) {
      showUserError(validation.message);
      renderBookingAvailabilityPreview(bookingPayload, editingBookingId);
      return;
    }

    const normalizedBookingSaved = await saveBookingToNormalizedTablesFirst(bookingPayload);
    if (!normalizedBookingSaved) return;

    const previousBooking = editingBookingId ? state.bookings.find((booking) => booking.id === editingBookingId) : null;
    const isNewBooking = !editingBookingId;
    if (editingBookingId) {
      state.bookings = state.bookings.map((booking) => booking.id === editingBookingId ? bookingPayload : booking);
    } else {
      state.bookings.push(bookingPayload);
    }

    addAuditEntry({
      type: editingBookingId ? "booking_updated" : "booking_created",
      entityType: "booking",
      entityId: bookingPayload.id,
      summary: `${formatLogRef(bookingPayload)} · ${bookingPayload.member} · ${formatBookingRange(bookingPayload)}`,
      detail: editingBookingId ? describeBookingAuditChanges(previousBooking, bookingPayload) : (bookingPayload.purpose || ""),
      metadata: buildBookingAuditMetadata(bookingPayload)
    });

    setBookingCalendarAnchor(bookingPayload.start);
    editingBookingId = null;
    tripPlannerBookingDraft = null;
    els.bookingForm.reset();
    setDefaultBookingTimes();
    clearBookingAvailabilityPreview(previousBooking ? "Booking updated. Choose another time to check availability." : "Booking saved. Choose another time to check availability.");
    saveState();
    if (!supabaseClient) {
      if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
      await saveRemoteState();
    }
    updateEditUi();
    render();
    if (isNewBooking) sendBookingPush(bookingPayload).catch((error) => console.warn("Booking push notification failed", error));
    showAppMessage(previousBooking ? `Booking ${formatTypedLogRef(bookingPayload, "booking")} updated.` : `Car booked as ${formatTypedLogRef(bookingPayload, "booking")}.`);
  });
}

[els.bookingMember, els.bookingStart, els.bookingEnd].forEach((input) => {
  if (!input) return;
  input.addEventListener("input", updateBookingAvailabilityPreview);
  input.addEventListener("change", updateBookingAvailabilityPreview);
});


document.addEventListener("click", (event) => {
  const dateHint = event.target.closest("[data-booking-date-hint]");
  if (!dateHint) return;
  event.preventDefault();
  setBookingDateHint(dateHint.dataset.bookingDateHint);
});

els.tripForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canUseAppAsMember()) {
    showUserError("Your email is not assigned to a member yet. Ask an admin to add it.");
    return;
  }
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const start = Number(els.startKm.value);
  const end = Number(els.endKm.value);
  ensureSelectedTripDriverParticipant();
  const activeTripBookingContext = getActiveTripLogContext() || getTripFormBookingContextDataset();
  const participants = getSelectedTripParticipantsForSubmit(activeTripBookingContext);

  if (!validateTripOdometerChronology(start, end)) return;

  if (participants.length === 0) {
    showUserError("Choose at least one person to split the trip with.");
    return;
  }

  if (!validateTripAgainstEstimatedTankRange(start, end, { excludeTripId: editingTripId })) return;

  const tripId = editingTripId || crypto.randomUUID();
  const existingTrip = editingTripId ? state.trips.find((trip) => trip.id === editingTripId) : null;
  const tripPayload = {
    id: tripId,
    logRef: existingTrip?.logRef || activeTripBookingContext?.logRef || createLogRef(tripId),
    sourceBookingId: existingTrip?.sourceBookingId || activeTripBookingContext?.bookingId || null,
    bookingStart: existingTrip?.bookingStart || activeTripBookingContext?.bookingStart || null,
    bookingEnd: existingTrip?.bookingEnd || activeTripBookingContext?.bookingEnd || null,
    driver: els.tripDriver.value,
    participants,
    date: els.tripDate.value,
    startKm: round(start),
    endKm: round(end),
    note: els.tripNote.value.trim()
  };

  const normalizedTripSaved = await saveTripToNormalizedTablesFirst(tripPayload);
  if (!normalizedTripSaved) return;

  const wasEditingTrip = Boolean(editingTripId);
  let previousTrip = null;
  if (editingTripId) {
    const index = state.trips.findIndex((trip) => trip.id === editingTripId);
    previousTrip = index >= 0 ? { ...state.trips[index], participants: [...(state.trips[index].participants || [])] } : null;
    if (index >= 0) state.trips[index] = tripPayload;
    else state.trips.push(tripPayload);
    editingTripId = null;
  } else {
    state.trips.push(tripPayload);
  }
  state.lastOdometer = getLatestOdometer();
  addAuditEntry({
    type: wasEditingTrip ? "trip_updated" : "trip_created",
    entityType: "trip",
    entityId: tripPayload.id,
    summary: `${formatLogRef(tripPayload)} · ${tripPayload.driver} · ${formatNumber(tripPayload.endKm - tripPayload.startKm)} km`,
    detail: wasEditingTrip ? describeTripAuditChanges(previousTrip, tripPayload) : getTripPeriodLabel(tripPayload)
  });

  saveState();
  if (!supabaseClient) {
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
    await saveRemoteState();
  }
  if (!wasEditingTrip && tripPayload.sourceBookingId) {
    pendingFuelTripContext = buildFuelContextFromTrip(tripPayload);
    els.fuelForm?.reset();
    clearFuelLocation();
    prefillFuelFromTripContext(pendingFuelTripContext);
    sendFuelFollowupPush(tripPayload).catch((error) => console.warn("Fuel follow-up notification failed", error));
  }
  clearTripLoggingContext();
  els.tripForm.reset();
  setDefaultDates();
  updateEditUi();
  render();
  if (!wasEditingTrip && pendingFuelTripContext) {
    setTimeout(() => {
      els.fuelLogPanel?.scrollIntoView({ behavior: "smooth", block: "center" });
      els.fuelForm?.scrollIntoView({ behavior: "smooth", block: "center" });
      els.fuelAmount?.focus({ preventScroll: true });
    }, 0);
    showAppMessage(`Trip ${formatTypedLogRef(tripPayload, "trip")} logged. Add the matching fuel receipt when ready.`);
  } else {
    showSaveMessage("Trip", wasEditingTrip);
  }
});

if (els.useFuelLocation) {
  els.useFuelLocation.addEventListener("click", captureFuelLocation);
}

if (els.stationResults) {
  els.stationResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-station-index]");
    if (!button) return;
    const stations = JSON.parse(els.stationResults.dataset.stations || "[]");
    const station = stations[Number(button.dataset.stationIndex)];
    if (station) selectFuelStation(station);
  });
}

if (els.tripEstimateDistance) {
  els.tripEstimateDistance.addEventListener("input", renderTripEstimate);
}

if (els.tripEstimateStart) {
  els.tripEstimateStart.addEventListener("input", renderTripEstimate);
}

if (els.tripEstimateDestination) {
  els.tripEstimateDestination.addEventListener("input", renderTripEstimate);
}

if (els.tripEstimatorParticipants) {
  els.tripEstimatorParticipants.addEventListener("change", renderTripEstimate);
}

if (els.tripEstimateResult) {
  els.tripEstimateResult.addEventListener("click", (event) => {
    const button = event.target.closest("[data-use-plan-for-booking]");
    if (!button) return;
    useTripPlanForBooking();
  });
}

els.fuelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFuelCorrectionPanel();
  if (!canUseAppAsMember()) {
    showUserError("Your email is not assigned to a member yet. Ask an admin to add it.");
    return;
  }
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const amount = Number(els.fuelAmount.value);
  const liters = Number(els.fuelLiters?.value || 0);
  const odometer = Number(els.fuelOdometer?.value || 0);
  const station = els.fuelStation?.value.trim() || "";
  const latitude = Number(els.fuelLatitude?.value || 0);
  const longitude = Number(els.fuelLongitude?.value || 0);
  const stationLatitude = Number(els.fuelStationLatitude?.value || 0);
  const stationLongitude = Number(els.fuelStationLongitude?.value || 0);
  const stationBrand = els.fuelStationBrand?.value.trim() || "";
  const locationPrivacy = window.FuelLocationPrivacy?.buildFuelLocationPayload?.({
    mode: els.fuelLocationPrivacyMode?.value,
    userLatitude: latitude,
    userLongitude: longitude,
    stationLatitude,
    stationLongitude,
    stationName: station,
    stationBrand
  }) || { location: latitude && longitude ? { latitude, longitude } : null, stationInfo: stationLatitude && stationLongitude ? { name: station, brand: stationBrand, latitude: stationLatitude, longitude: stationLongitude } : null };
  const fullTank = Boolean(els.fuelFullTank?.checked);

  const validation = validateFuelLogInput({ amount, liters }, { excludeFuelId: editingFuelId });
  if (!validation.ok) {
    if (validation.correction) renderFuelPriceCorrectionPanel(validation.message, validation.correction);
    else clearFuelCorrectionPanel();
    showUserError(validation.message);
    showAppMessage(validation.message, "error");
    return;
  }

  if (pendingFuelTripContext?.requiredFuel && !fullTank) {
    const message = "Multi-day booking fuel logs must confirm the tank was filled to full.";
    showUserError(message);
    showAppMessage(message, "error");
    const details = document.querySelector("#fuelDetails");
    if (details) details.open = true;
    els.fuelFullTank?.focus();
    return;
  }

  const normalizedLiters = round(liters);
  const fuelDate = els.fuelDate.value;
  if (!validateFuelOdometerChronology({ date: fuelDate, odometer }, { excludeFuelId: editingFuelId })) {
    return;
  }
  if (!validateFuelAgainstEstimatedTankCapacity({ liters: normalizedLiters, odometer, fullTank }, { excludeFuelId: editingFuelId })) {
    return;
  }
  const fuelPayload = {
    id: editingFuelId || crypto.randomUUID(),
    logRef: editingFuelId ? state.fuel.find((fuel) => fuel.id === editingFuelId)?.logRef || pendingFuelTripContext?.logRef || createLogRef(editingFuelId) : pendingFuelTripContext?.logRef || createLogRef(editingFuelId || crypto.randomUUID()),
    sourceTripId: editingFuelId ? state.fuel.find((fuel) => fuel.id === editingFuelId)?.sourceTripId || pendingFuelTripContext?.tripId || null : pendingFuelTripContext?.tripId || null,
    sourceBookingId: editingFuelId ? state.fuel.find((fuel) => fuel.id === editingFuelId)?.sourceBookingId || pendingFuelTripContext?.bookingId || null : pendingFuelTripContext?.bookingId || null,
    bookingStart: editingFuelId ? state.fuel.find((fuel) => fuel.id === editingFuelId)?.bookingStart || pendingFuelTripContext?.bookingStart || null : pendingFuelTripContext?.bookingStart || null,
    bookingEnd: editingFuelId ? state.fuel.find((fuel) => fuel.id === editingFuelId)?.bookingEnd || pendingFuelTripContext?.bookingEnd || null : pendingFuelTripContext?.bookingEnd || null,
    payer: els.fuelPayer.value,
    date: fuelDate,
    amount: roundMoney(amount),
    liters: normalizedLiters,
    pricePerLiter: roundMoney(amount / normalizedLiters),
    odometer: odometer > 0 ? round(odometer) : "",
    station,
    location: locationPrivacy.location,
    stationInfo: locationPrivacy.stationInfo,
    locationPrivacyMode: locationPrivacy.mode || els.fuelLocationPrivacyMode?.value || "station-only",
    fullTank
  };

  const normalizedFuelSaved = await saveFuelToNormalizedTablesFirst(fuelPayload);
  if (!normalizedFuelSaved) return;

  const wasEditingFuel = Boolean(editingFuelId);
  let previousFuel = null;
  if (editingFuelId) {
    const index = state.fuel.findIndex((fuel) => fuel.id === editingFuelId);
    previousFuel = index >= 0 ? { ...state.fuel[index] } : null;
    if (index >= 0) state.fuel[index] = fuelPayload;
    else state.fuel.push(fuelPayload);
    editingFuelId = null;
  } else {
    state.fuel.push(fuelPayload);
  }

  addAuditEntry({
    type: wasEditingFuel ? "fuel_updated" : "fuel_created",
    entityType: "fuel",
    entityId: fuelPayload.id,
    summary: `${formatLogRef(fuelPayload)} · ${fuelPayload.payer} · ${formatFuelAmountLitersAndPrice(fuelPayload)}`,
    detail: wasEditingFuel ? describeFuelAuditChanges(previousFuel, fuelPayload) : `${fuelPayload.sourceTripId ? "Linked trip fuel" : "Fuel log"} · ${fuelPayload.date || ""}${fuelPayload.odometer ? ` · ${formatNumber(fuelPayload.odometer)} km` : ""}`
  });

  saveState();
  clearFuelLoggingContext();
  els.fuelForm.reset();
  clearFuelLocation();
  setDefaultDates();
  updateEditUi();
  render();
  showSaveMessage("Fuel log", wasEditingFuel);
});

function captureFuelLocation() {
  if (!navigator.geolocation) {
    if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "GPS is not available in this browser.";
    return;
  }

  if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Getting location...";
  if (els.useFuelLocation) els.useFuelLocation.disabled = true;
  if (els.stationResults) {
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));
      if (els.fuelLatitude) els.fuelLatitude.value = String(latitude);
      if (els.fuelLongitude) els.fuelLongitude.value = String(longitude);
      if (els.nearbyFuelStations) {
        els.nearbyFuelStations.href = `https://www.google.com/maps/search/tankstationer/@${latitude},${longitude},14z`;
        els.nearbyFuelStations.classList.remove("hidden");
      }

      try {
        if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Looking for nearby stations...";
        const stations = await fetchNearbyFuelStations(latitude, longitude);
        renderFuelStationResults(stations, latitude, longitude);
        if (els.fuelLocationStatus) {
          els.fuelLocationStatus.textContent = stations.length
            ? "Pick the correct station below, or type it manually."
            : "No nearby stations found. You can still type the station manually.";
        }
      } catch (error) {
        if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Could not load nearby stations. You can still type the station manually.";
      } finally {
        if (els.useFuelLocation) els.useFuelLocation.disabled = false;
      }
    },
    () => {
      if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "Could not get location. You can still type the station manually.";
      if (els.useFuelLocation) els.useFuelLocation.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

async function fetchNearbyFuelStations(latitude, longitude) {
  const query = `
    [out:json][timeout:8];
    (
      node["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
      way["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
      relation["amenity"="fuel"](around:${stationSearchRadiusMeters},${latitude},${longitude});
    );
    out center tags 20;
  `;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: query })
  });

  if (!response.ok) throw new Error("Station lookup failed");
  const data = await response.json();
  return (data.elements || [])
    .map((item) => {
      const lat = item.lat ?? item.center?.lat;
      const lon = item.lon ?? item.center?.lon;
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
      const tags = item.tags || {};
      const brand = tags.brand || tags.operator || "";
      const name = tags.name || brand || "Fuel station";
      return {
        id: `${item.type}-${item.id}`,
        name,
        brand,
        latitude: Number(lat),
        longitude: Number(lon),
        distanceMeters: distanceInMeters(latitude, longitude, Number(lat), Number(lon))
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 8);
}

function renderFuelStationResults(stations) {
  if (!els.stationResults) return;

  if (!stations.length) {
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
    els.stationResults.dataset.stations = "[]";
    return;
  }

  els.stationResults.dataset.stations = JSON.stringify(stations);
  els.stationResults.classList.remove("hidden");
  els.stationResults.innerHTML = `
    <div class="station-results-header">Nearby fuel stations</div>
    ${stations
      .map((station, index) => `
        <button class="station-option" type="button" data-station-index="${index}">
          <span>
            <strong>${escapeHtml(station.name)}</strong>
            ${station.brand && station.brand !== station.name ? `<small>${escapeHtml(station.brand)}</small>` : ""}
          </span>
          <b>${formatStationDistance(station.distanceMeters)}</b>
        </button>
      `)
      .join("")}
  `;
}

function selectFuelStation(station) {
  if (els.fuelStation) els.fuelStation.value = station.name;
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = String(Number(station.latitude).toFixed(6));
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = String(Number(station.longitude).toFixed(6));
  if (els.fuelStationBrand) els.fuelStationBrand.value = station.brand || "";
  if (els.fuelLocationStatus) {
    const mode = window.FuelLocationPrivacy?.normalizeLocationPrivacyMode?.(els.fuelLocationPrivacyMode?.value) || "station-only";
    els.fuelLocationStatus.textContent = mode === "no-coordinates"
      ? `${station.name} selected. Coordinates will not be saved.`
      : `${station.name} selected.`;
  }

  if (els.stationResults) {
    for (const option of els.stationResults.querySelectorAll(".station-option")) {
      option.classList.toggle("is-selected", option.dataset.stationIndex === String(JSON.parse(els.stationResults.dataset.stations || "[]").findIndex((item) => item.id === station.id)));
    }
  }
}

function clearFuelLocation() {
  if (els.fuelLatitude) els.fuelLatitude.value = "";
  if (els.fuelLongitude) els.fuelLongitude.value = "";
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = "";
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = "";
  if (els.fuelStationBrand) els.fuelStationBrand.value = "";
  if (els.fuelLocationPrivacyMode) els.fuelLocationPrivacyMode.value = "station-only";
  if (els.fuelLocationStatus) els.fuelLocationStatus.textContent = "";
  if (els.stationResults) {
    els.stationResults.dataset.stations = "[]";
    els.stationResults.classList.add("hidden");
    els.stationResults.replaceChildren();
  }
  if (els.nearbyFuelStations) {
    els.nearbyFuelStations.href = "#";
    els.nearbyFuelStations.classList.add("hidden");
  }
  if (els.useFuelLocation) els.useFuelLocation.disabled = false;
}



els.sectionTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveView(button.dataset.viewTab || "log");
  });
});

els.historySectionTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveHistorySection(button.dataset.historySectionTab || "booking");
  });
});

els.paymentSectionTabs.forEach((button) => {
  button.addEventListener("click", () => {
    setActivePaymentSection(button.dataset.paymentSectionTab || "all");
  });
});

function setActiveHistorySection(section) {
  activeHistorySection = ["booking", "settlement", "archive"].includes(section) ? section : "booking";
  localStorage.setItem(historySectionStorageKey, activeHistorySection);
  renderHistorySections();
}

function renderHistorySections() {
  const allowedSections = new Set(["booking", "settlement", "archive"]);
  if (!allowedSections.has(activeHistorySection)) activeHistorySection = "booking";
  els.historySectionTabs.forEach((button) => {
    const section = button.dataset.historySectionTab || "booking";
    const isActive = section === activeHistorySection;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  els.historySections.forEach((sectionPanel) => {
    sectionPanel.classList.toggle("hidden", sectionPanel.dataset.historySection !== activeHistorySection);
  });
}


function setActivePaymentSection(section) {
  activePaymentSection = ["owe", "owed", "all"].includes(section) ? section : "all";
  localStorage.setItem(paymentSectionStorageKey, activePaymentSection);
  renderPaymentSectionTabs();
  renderUnpaidPayments();
}

function renderPaymentSectionTabs() {
  const allowedSections = new Set(["owe", "owed", "all"]);
  if (!allowedSections.has(activePaymentSection)) activePaymentSection = "all";
  els.paymentSectionTabs.forEach((button) => {
    const section = button.dataset.paymentSectionTab || "all";
    const isActive = section === activePaymentSection;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function setActiveView(view) {
  const requestedView = view || "log";
  activeView = requestedView === "admin" && !canManageSettings() ? "log" : requestedView === "account" && !currentSession ? "log" : requestedView;
  localStorage.setItem(viewStorageKey, activeView);
  render();
  if (activeView === "admin") {
    markOptionalAdminPanelsReadyForManualRefresh("admin-tab-open");
  }
  if (activeView === "account") scheduleWorkspaceInviteRefresh("account-tab-open");
}

function renderSectionNavigation() {
  if (activeView === "admin" && !canManageSettings()) activeView = "log";
  if (activeView === "account" && !currentSession) activeView = "log";
  renderHistorySections();
  els.sectionTabs.forEach((button) => {
    const view = button.dataset.viewTab;
    const isAdminTab = view === "admin";
    const isAccountTab = view === "account";
    button.classList.toggle("hidden", (isAdminTab && !canManageSettings()) || (isAccountTab && !currentSession));
    button.classList.toggle("active", view === activeView);
    button.setAttribute("aria-current", view === activeView ? "page" : "false");
  });
  els.viewSections.forEach((section) => {
    const view = section.dataset.view;
    section.classList.toggle("view-hidden", view !== activeView);
  });
}

els.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canManageSettings()) {
    showUserError("Only an admin can change group settings.");
    return;
  }
  if (!assertActiveWorkspaceDataConfirmed("save settings")) return;

  const parsed = parseMemberSettings(els.members.value);
  const members = parsed.map((member) => member.name);
  const minimumSettingsMembers = currentSession ? 1 : 2;

  if (members.length < minimumSettingsMembers) {
    showUserError(currentSession ? "Add at least one active workspace member." : "Add at least two people.");
    return;
  }

  const previousState = structuredClone(state);

  state.currency = els.currency.value.trim() || defaults.currency;
  state.fuelType = els.fuelType?.value || defaults.fuelType;
  state.fuelConsumption = Math.max(0.1, Number(els.fuelConsumption?.value) || defaults.fuelConsumption);
  state.fuelTankCapacity = Math.max(1, Number(els.fuelTankCapacity?.value) || defaults.fuelTankCapacity);
  state.fuelFallbackPrice = Math.max(0.1, Number(els.fuelFallbackPrice?.value) || defaults.fuelFallbackPrice);
  const minFuelPriceWarning = Math.max(0.1, Number(els.fuelPriceWarningMin?.value) || defaults.fuelPriceWarningMinDkkPerLiter);
  const maxFuelPriceWarning = Math.max(minFuelPriceWarning + 0.1, Number(els.fuelPriceWarningMax?.value) || defaults.fuelPriceWarningMaxDkkPerLiter);
  state.fuelPriceWarningMinDkkPerLiter = round(minFuelPriceWarning);
  state.fuelPriceWarningMaxDkkPerLiter = round(maxFuelPriceWarning);
  state.fuelWarningThreshold = Math.min(100, Math.max(1, Number(els.fuelWarningThreshold?.value) || defaults.fuelWarningThreshold));
  state.vehiclePlate = normalizeVehiclePlateInput(els.vehiclePlate?.value || state.vehiclePlate || "");
  if (state.vehicleInfo && state.vehicleInfo.plate && state.vehiclePlate && normalizeVehiclePlateInput(state.vehicleInfo.plate) !== state.vehiclePlate) {
    state.vehicleInfo = null;
    state.vehicleLookupSource = "manual";
    state.vehicleLookupAt = "";
  }
  state.paymentRemindersEnabled = Boolean(els.paymentRemindersEnabled?.checked);
  const reminderAfterValue = Number(els.paymentReminderAfterDays?.value);
  const reminderRepeatValue = Number(els.paymentReminderRepeatDays?.value);
  const reminderMaxValue = Number(els.paymentReminderMaxCount?.value);
  state.paymentReminderAfterDays = Math.min(90, Math.max(0, Number.isFinite(reminderAfterValue) ? reminderAfterValue : defaults.paymentReminderAfterDays));
  state.paymentReminderRepeatDays = Math.min(90, Math.max(1, Number.isFinite(reminderRepeatValue) ? reminderRepeatValue : defaults.paymentReminderRepeatDays));
  state.paymentReminderMaxCount = Math.min(20, Math.max(1, Number.isFinite(reminderMaxValue) ? reminderMaxValue : defaults.paymentReminderMaxCount));
  state.members = [...new Set(members)];
  state.memberProfiles = Object.fromEntries(
    parsed.map((member, index) => [
      member.name,
      {
        email: member.email,
        role: member.role || (index === 0 && noMemberEmailsConfigured() ? "admin" : "member"),
        mobilepayPhone: normalizePhone(member.mobilepayPhone || member.mobilepay_phone || "")
      }
    ])
  );
  addAuditEntry({
    type: "settings_saved",
    entityType: "settings",
    entityId: getActiveLedgerId(),
    summary: `Group settings saved · ${state.currency} · ${state.fuelType || defaults.fuelType}`,
    detail: `Fuel ${formatNumber(state.fuelConsumption)} L/100 km · tank ${formatNumber(state.fuelTankCapacity)} L · ${state.members.length} active member${state.members.length === 1 ? "" : "s"}`,
    metadata: {
      fuelType: state.fuelType,
      fuelConsumption: state.fuelConsumption,
      fuelTankCapacity: state.fuelTankCapacity,
      memberCount: state.members.length
    }
  });
  state.trips = state.trips.filter((trip) => state.members.includes(trip.driver));
  state.trips = state.trips.map((trip) => ({
    ...trip,
    participants: getTripParticipants(trip).filter((member) => state.members.includes(member))
  }));
  state.fuel = state.fuel.filter((fuel) => state.members.includes(fuel.payer));

  const settingsTraceMeta = {
    source: "settings-save",
    route: supabaseClient ? "render-api" : "remote-state",
    endpoint: supabaseClient ? renderSettingsSaveUrl : "",
    operation: "save",
    operationId: createDataIoOperationId("settings-save", "save"),
    ledgerId: getActiveLedgerId(),
    resultCode: "SETTINGS_SAVE_STARTED",
    detail: "Save group settings"
  };
  recordDataIoDiagnostic("start", { ...settingsTraceMeta, ok: true });
  try {
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
    let settingsSaveResult = null;
    if (supabaseClient) {
      settingsSaveResult = await saveSettingsViaRender({ traceMeta: settingsTraceMeta });
    } else {
      saveState({ queueRemote: false, reason: "group settings explicit save" });
      await saveRemoteState();
      if (lastSyncError) throw new Error(lastSyncError);
    }
    const persistedSummary = settingsSaveResult?.persisted ? formatSettingsPersistedSummary(settingsSaveResult.persisted) : "legacy remote state saved";
    recordDataIoDiagnostic("success", { ...settingsTraceMeta, ok: true, resultCode: "SETTINGS_SAVED", detail: `Saved group settings through backend-owned settings route · ${persistedSummary}` });
    showUserMessage(formatSettingsSavedConfirmation(settingsSaveResult), "success", { timeoutMs: 4200 });
    renderSupabaseLoadMonitor();
    render();
  } catch (error) {
    state = previousState;
    const settingsErrorCode = error?.resultCode || error?.code || (/timeout|timed out/i.test(error?.message || "") ? "SETTINGS_SAVE_TIMEOUT" : "SETTINGS_SAVE_ERROR");
    recordDataIoDiagnostic(/TIMEOUT/i.test(String(settingsErrorCode)) ? "timeout" : "error", { ...settingsTraceMeta, ok: false, error, resultCode: settingsErrorCode });
    showUserError(`Could not save group settings: ${error.message || error}`);
    render();
  }
});

if (els.vehicleLookupButton) {
  els.vehicleLookupButton.addEventListener("click", lookupVehicleByPlateFromUi);
}

els.resetPeriod.addEventListener("click", async () => {
  if (!canManageSettings()) {
    showUserError("Only an admin can reset the current period.");
    return;
  }
  if (state.trips.length === 0 && state.fuel.length === 0) {
    showUserError("There is no current period data to reset.");
    return;
  }
  const resetLedger = calculateLedger();
  const resetTripCount = state.trips.length;
  const resetFuelCount = state.fuel.length;
  const resetPeriodLabel = resetLedger?.period?.label || "Current period";
  const resetTotalCost = resetLedger?.totalCost || 0;
  if (!requireTypedAdminConfirmation({
    phrase: "RESET CURRENT PERIOD",
    title: "Reset current period?",
    detail: `This removes ${resetTripCount} current trip${resetTripCount === 1 ? "" : "s"}, ${resetFuelCount} fuel log${resetFuelCount === 1 ? "" : "s"}, and current payment request statuses for ${resetPeriodLabel}. Settings and archived periods stay unchanged. A backup is exported first.`
  })) return;
  try {
    await exportAdminSafetyBackup("reset current period");
    assertFreshAdminSafetyBackup("reset current period");
  } catch (error) {
    showUserError(error.message || String(error));
    return;
  }
  state.trips = [];
  state.fuel = [];
  state.paymentStatuses = {};
  state.lastOdometer = getLatestOdometer();
  clearTripLoggingContext();
  clearFuelLoggingContext();
  clearCurrentAuditLog();
  showAppMessage(`${resetPeriodLabel} reset. ${resetTripCount} trip${resetTripCount === 1 ? "" : "s"} and ${resetFuelCount} fuel log${resetFuelCount === 1 ? "" : "s"} removed.`);
  markNormalizedReconciliationDirty("reset current period");
  saveState();
  setDefaultDates();
  render();
});

els.resetData.addEventListener("click", async () => {
  if (!canManageSettings()) {
    showUserError("Only an admin can reset data.");
    return;
  }
  if (!requireTypedAdminConfirmation({
    phrase: "RESET ALL LOCAL DATA",
    title: "Reset all local data?",
    detail: "This replaces local members, settings, trips, fuel logs, bookings, payment statuses, and closed periods with defaults. A backup is exported first. In Supabase mode, prefer production activity reset when you only want to clear activity."
  })) return;
  try {
    await exportAdminSafetyBackup("reset all local data");
    assertFreshAdminSafetyBackup("reset all local data");
  } catch (error) {
    showUserError(error.message || String(error));
    return;
  }
  state = structuredClone(defaults);
  clearTripLoggingContext();
  clearFuelLoggingContext();
  markNormalizedReconciliationDirty("reset all local data");
  saveState();
  setDefaultDates();
  render();
});


els.exportLedger?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Export backup")) return;
  exportLedgerBackup();
});

els.importLedger?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Import backup")) return;
  els.importLedgerFile?.click();
});

els.importLedgerFile?.addEventListener("change", async () => {
  if (!requireGlobalAdminToolsPermission("Import backup")) return;
  await importLedgerBackup();
});

els.downloadCsv?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Download CSV")) return;
  downloadLedgerCsv();
});

els.downloadPeriodReport?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Download period report")) return;
  downloadCurrentPeriodReport();
});

els.removeTestUsers?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "remove unused generated/test members",
    phrase: "REMOVE TEST USERS",
    title: "Remove unused generated/test members?",
    detail: "This removes generated/test members that have no ledger activity after taking a safety backup."
  }))) return;
  await traceAdminToolOperation("remove-test-users", "Remove unused generated/test members", removeUnusedTestUsers);
});

els.addTestTrip?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "add generated test trip",
    phrase: "ADD TEST TRIP",
    title: "Add generated test trip?",
    detail: "This writes one clearly marked generated test trip to the live ledger. Use Safe Test Lab for local-only checks."
  }))) return;
  els.addTestTrip.disabled = true;
  try {
    await traceAdminToolOperation("add-test-trip", "Add generated test trip", addGeneratedTestTrip);
  } finally {
    els.addTestTrip.disabled = false;
  }
});

els.addTestFuel?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "add generated test fuel log",
    phrase: "ADD TEST FUEL",
    title: "Add generated test fuel log?",
    detail: "This writes one clearly marked generated test fuel log to the live ledger. Use Safe Test Lab for local-only checks."
  }))) return;
  els.addTestFuel.disabled = true;
  try {
    await traceAdminToolOperation("add-test-fuel", "Add generated test fuel", addGeneratedTestFuel);
  } finally {
    els.addTestFuel.disabled = false;
  }
});

els.removeTestData?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "remove generated test data",
    phrase: "REMOVE TEST DATA",
    title: "Remove generated test data?",
    detail: "This removes only strict generated test entries with the auto-test id prefix after taking a safety backup."
  }))) return;
  await traceAdminToolOperation("remove-test-data", "Remove generated test data", removeGeneratedTestData);
});

els.purgeSoftDeletedTestRows?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "purge soft-deleted generated test rows",
    requireUnlock: true
  }))) return;
  if (!window.FuelAdminTools?.purgeSoftDeletedGeneratedTestRows) {
    setDataToolsMessage("Soft-deleted test row cleanup is not available in this build.");
    return;
  }
  const preview = await window.FuelAdminTools.purgeSoftDeletedGeneratedTestRows({ dryRun: true });
  if (!preview.total) {
    setDataToolsMessage("No soft-deleted generated test rows found in normalized tables.");
    await refreshDatabaseDiagnostics().catch(() => {});
    return;
  }
  const message = [
    `This will permanently delete ${preview.trips} soft-deleted generated test trip row${preview.trips === 1 ? "" : "s"} and ${preview.fuel} soft-deleted generated test fuel row${preview.fuel === 1 ? "" : "s"}.`,
    "",
    "Only rows already marked deleted and carrying the generated test marker are eligible.",
    "Real audit/history rows are left untouched.",
    "",
    "Type PURGE TEST ROWS to continue."
  ].join("\n");
  const typed = prompt(message);
  if (typed !== "PURGE TEST ROWS") {
    setDataToolsMessage("Soft-deleted test row purge cancelled.");
    return;
  }
  els.purgeSoftDeletedTestRows.disabled = true;
  try {
    await exportAdminSafetyBackup("purge soft-deleted generated test rows");
    assertFreshAdminSafetyBackup("purge soft-deleted generated test rows");
    const result = await traceAdminToolOperation("purge-soft-deleted-test-rows", "Purge soft-deleted generated test rows", () => window.FuelAdminTools.purgeSoftDeletedGeneratedTestRows({ dryRun: false }));
    setDataToolsMessage(`Purged ${result.trips} soft-deleted generated test trip row${result.trips === 1 ? "" : "s"} and ${result.fuel} soft-deleted generated test fuel row${result.fuel === 1 ? "" : "s"}.`);
    await refreshDatabaseDiagnostics().catch(() => {});
    await checkNormalizedTablesAgainstCurrentState({ force: true, reason: "admin-action" }).catch(() => {});
  } catch (error) {
    console.warn("Soft-deleted test row purge failed", error);
    setDataToolsMessage(`Could not purge soft-deleted test rows: ${error.message || error}`);
  } finally {
    els.purgeSoftDeletedTestRows.disabled = false;
  }
});

function requireTypedAdminConfirmation({ phrase, title, detail }) {
  if (!canManageSettings()) return false;
  const message = [
    title || "Confirm admin action",
    detail || "This action is restricted to admins.",
    "",
    `Type ${phrase} to continue.`
  ].join("\n");
  const typed = prompt(message);
  return typed === phrase;
}

function normalizeAdminSafetyBackupReason(reason = "admin action") {
  return String(reason || "admin action").trim().toLowerCase();
}

function assertKnownAdminSafetyBackupReason(reason = "admin action") {
  const normalizedReason = normalizeAdminSafetyBackupReason(reason);
  if (!requiredAdminSafetyBackupReasons.includes(normalizedReason)) {
    throw new Error(`Unknown destructive action backup reason: ${reason || "admin action"}`);
  }
  return normalizedReason;
}

function markAdminSafetyBackupSuccess(reason, details = {}) {
  const normalizedReason = assertKnownAdminSafetyBackupReason(reason);
  const now = Date.now();
  lastAdminSafetyBackup = {
    reason: normalizedReason,
    at: now,
    iso: new Date(now).toISOString(),
    local: true,
    cloud: Boolean(details.cloud)
  };
  recordSupabaseLoadEvent("admin-safety-backup-success", normalizedReason, { diagnostic: true });
  return lastAdminSafetyBackup;
}

function assertFreshAdminSafetyBackup(reason = "admin action") {
  const normalizedReason = assertKnownAdminSafetyBackupReason(reason);
  const backup = lastAdminSafetyBackup;
  const ageMs = backup ? Date.now() - Number(backup.at || 0) : Infinity;
  if (!backup || backup.reason !== normalizedReason || ageMs > adminSafetyBackupFreshMs) {
    throw new Error(`Fresh safety backup is required before ${normalizedReason}. Run the action again so the app can take a new backup immediately before continuing.`);
  }
  return true;
}

async function exportAdminSafetyBackup(reason = "admin action") {
  const normalizedReason = assertKnownAdminSafetyBackupReason(reason);
  let cloudBackupSaved = false;
  exportLedgerBackup();
  if (supabaseClient && currentSession && canManageSettings()) {
    try {
      await saveJsonMirrorBackup({ force: true, reason: `${normalizedReason} safety backup` });
      cloudBackupSaved = true;
    } catch (error) {
      console.warn(`Cloud JSON safety backup failed before ${normalizedReason}`, error);
      throw new Error(`Cloud backup failed before ${normalizedReason}: ${error.message || error}`);
    }
  }
  markAdminSafetyBackupSuccess(normalizedReason, { cloud: cloudBackupSaved });
  return assertFreshAdminSafetyBackup(normalizedReason);
}

function redactDiagnosticUrlSecrets(value) {
  return String(value || "").replace(/([?&](?:access_token|refresh_token|accessToken|refreshToken|auth|authorization|jwt|token|apikey|api_key|apiKey|anon_key|anonKey|supabase_key|supabaseKey|service_role|serviceRole|serviceRoleKey|client_secret|clientSecret|key|code|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
}

function redactDiagnosticString(value) {
  return redactDiagnosticUrlSecrets(String(value || ""))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted-token]")
    .replace(/((?:\x22|\x27)?\b(?:access_token|refresh_token|accessToken|refreshToken|api[_-]?key|apiKey|apikey|anon_key|anonKey|supabase_key|supabaseKey|service_role|serviceRole|serviceRoleKey|authorization|auth|jwt|bearer|password|secret|client_secret|clientSecret)(?:\x22|\x27)?\s*[:=]\s*(?:\x22|\x27)?)[^\x22\x27\s,;&}]+/gi, "$1[redacted]")
    .replace(/\+\d[0-9 ()-]{7,}\d/g, "[redacted-phone]")
    .replace(/\b\d{2,4}[ -](?:\d[ -]?){6,}\d\b/g, "[redacted-phone]")
    .replace(/\b-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/g, "[redacted-coordinates]");
}

function isSensitiveDiagnosticKey(key) {
  return /email|phone|mobilepay|latitude|longitude|\b(?:lat|lng|lon)\b|coordinate|location|browser|useragent|user_agent|headers|session|token|authorization|auth|bearer|credential|api[_-]?key|apiKey|apikey|anon[_-]?key|anonKey|supabase[_-]?key|supabaseKey|service[_-]?role|serviceRole|serviceRoleKey|client[_-]?secret|clientSecret|secret|password|cookie|jwt/i.test(String(key || ""));
}

function redactSensitiveDiagnostics(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveDiagnostics(item));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactDiagnosticString(value) : value;
  }
  const redacted = {};
  Object.entries(value).forEach(([key, item]) => {
    if (isSensitiveDiagnosticKey(key)) {
      redacted[key] = "[redacted]";
      return;
    }
    redacted[key] = redactSensitiveDiagnostics(item);
  });
  return redacted;
}

function trimArrayForPrivacy(value, maxItems) {
  if (!Array.isArray(value)) return value;
  const limit = Math.max(0, Number(maxItems) || 0);
  return value.slice(0, limit);
}

function sanitizeStoredDiagnosticReport(value) {
  const report = redactSensitiveDiagnostics(value);
  if (!report || typeof report !== "object" || Array.isArray(report)) return report;
  const sanitized = { ...report };
  delete sanitized.browser;
  delete sanitized.events;
  delete sanitized.dataIoDiagnostics;
  delete sanitized.dataIoOperations;
  delete sanitized.latestDataIoDiagnostic;
  delete sanitized.latestDataIoOperation;
  if (sanitized.buildInfo && typeof sanitized.buildInfo === "object") {
    sanitized.buildInfo = {
      ...sanitized.buildInfo,
      releaseNotes: trimArrayForPrivacy(sanitized.buildInfo.releaseNotes || [], retentionPolicy.maxStoredReportReleaseNotes)
    };
  }
  if (sanitized.summary && typeof sanitized.summary === "object") {
    const summary = { ...sanitized.summary };
    summary.latest = trimArrayForPrivacy(summary.latest || [], retentionPolicy.maxStoredReportDiagnosticRows);
    sanitized.summary = summary;
  }
  if (Array.isArray(sanitized.checks)) {
    sanitized.checks = sanitized.checks.map((check) => redactSensitiveDiagnostics(check));
  }
  sanitized.privacyPruned = true;
  sanitized.privacyPrunedAt = sanitized.privacyPrunedAt || new Date().toISOString();
  return sanitized;
}

function redactTestLabReportForCloud(value) {
  return sanitizeStoredDiagnosticReport(value);
}

function scheduleAdvancedAdminToolsRelock() {
  if (advancedAdminToolsRelockTimer) window.clearTimeout(advancedAdminToolsRelockTimer);
  if (!advancedAdminToolsUnlocked) return;
  advancedAdminToolsRelockTimer = window.setTimeout(() => {
    advancedAdminToolsUnlocked = false;
    advancedAdminToolsRelockTimer = null;
    updateAdvancedAdminToolsUi();
    setDataToolsMessage("Advanced admin tools locked automatically after 15 minutes.");
  }, advancedAdminToolsUnlockTtlMs);
}

function updateAdvancedAdminToolsUi() {
  const canUseGlobalTools = canUseGlobalAdminTools();
  if (!canUseGlobalTools) advancedAdminToolsUnlocked = false;
  if (els.advancedAdminToolsPanel) els.advancedAdminToolsPanel.classList.toggle("hidden", !canUseGlobalTools || !advancedAdminToolsUnlocked);
  if (els.advancedAdminToolsStatus) {
    els.advancedAdminToolsStatus.textContent = !canUseGlobalTools
      ? "Owner diagnostics are hidden from normal users and workspace admins."
      : advancedAdminToolsUnlocked
        ? "Advanced admin/test tools unlocked for this tab for 15 minutes. Use only for generated-data or stress diagnostics."
        : "Advanced admin/test tools are locked.";
  }
  if (els.unlockAdvancedAdminTools) {
    els.unlockAdvancedAdminTools.classList.toggle("hidden", !canUseGlobalTools);
    els.unlockAdvancedAdminTools.textContent = advancedAdminToolsUnlocked ? "Lock advanced admin tools" : "Unlock advanced admin tools";
  }
}

function assertAdvancedAdminToolsUnlocked() {
  if (!requireGlobalAdminToolsPermission("Advanced admin tools")) return false;
  if (advancedAdminToolsUnlocked) return true;
  showUserWarning("Unlock advanced admin tools before running stress/debug actions.");
  setDataToolsMessage("Advanced admin/test tools are locked. Unlock them first, then use typed confirmation.");
  return false;
}

function requireAdvancedAdminAction({ phrase, title, detail, requireUnlock = true } = {}) {
  if (!requireGlobalAdminToolsPermission("Advanced admin action")) return false;
  if (requireUnlock && !assertAdvancedAdminToolsUnlocked()) return false;
  if (!phrase) return true;
  return requireTypedAdminConfirmation({ phrase, title, detail });
}

async function requireRenderVerifiedAdvancedAdminAction({ actionLabel = "advanced admin action", phrase, title, detail, requireUnlock = true } = {}) {
  if (!requireAdvancedAdminAction({ phrase, title, detail, requireUnlock })) return false;
  const status = await checkRenderAdminHealth({ silent: true });
  const checks = Array.isArray(status?.checks) ? status.checks : [];
  const adminCheckOk = checks.some((check) => check?.id === "workspace-admin" && check.ok === true);
  if (!status?.ok || !adminCheckOk) {
    const message = `Render admin verification failed before ${actionLabel}. Run Render admin health, sign in as a workspace admin, then try again.`;
    showUserError(message);
    setDataToolsMessage(message);
    return false;
  }
  setDataToolsMessage(`Render admin verified for ${actionLabel}.`);
  return true;
}

els.unlockAdvancedAdminTools?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Unlock advanced admin tools")) return;
  if (advancedAdminToolsUnlocked) {
    advancedAdminToolsUnlocked = false;
    if (advancedAdminToolsRelockTimer) window.clearTimeout(advancedAdminToolsRelockTimer);
    advancedAdminToolsRelockTimer = null;
    updateAdvancedAdminToolsUi();
    setDataToolsMessage("Advanced admin tools locked.");
    return;
  }
  if (!requireTypedAdminConfirmation({
    phrase: "UNLOCK ADMIN TOOLS",
    title: "Unlock advanced admin tools?",
    detail: "These tools can create cloud load or generated test rows. Safe Test Lab does not require unlocking."
  })) {
    setDataToolsMessage("Advanced admin unlock cancelled.");
    return;
  }
  advancedAdminToolsUnlocked = true;
  scheduleAdvancedAdminToolsRelock();
  updateAdvancedAdminToolsUi();
  setDataToolsMessage("Advanced admin/test tools unlocked for this tab for 15 minutes.");
});

els.runStressTest?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "advanced stress test",
    phrase: "RUN STRESS TEST",
    title: "Run advanced stress test?",
    detail: "This can create generated data and Supabase activity. Use only while diagnosing sync behavior."
  }))) return;
  await traceAdminToolOperation("advanced-stress-test", "Run generated stress test", runGeneratedStressTest);
});

els.runRapidSaveTest?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "rapid save test",
    phrase: "RUN RAPID SAVE TEST",
    title: "Run rapid save test?",
    detail: "This intentionally creates repeated save activity. Use only while Supabase CPU is calm."
  }))) return;
  await traceAdminToolOperation("rapid-save-test", "Run generated rapid save test", runGeneratedRapidSaveTest);
});

els.runFullTestLab?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run full safe Test Lab")) return;
  await traceAdminToolOperation("full-test-lab", "Run full safe Test Lab", runFullTestLabScenario);
});

els.runScenarioMatrix?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run Test Lab scenario matrix")) return;
  await traceAdminToolOperation("scenario-matrix", "Run Test Lab scenario matrix", runTestLabScenarioMatrix);
});

els.runPaymentScenario?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run payment and permission checks")) return;
  await traceAdminToolOperation("payment-permission-checks", "Run payment and permission checks", () => runTestLabScenarioMatrix({
    scenarioName: "payment-permission-checks",
    scenarioFilter: ["payments", "permissions"],
    confirmMessage: "Run payment and permission checks? This does not create production data."
  }));
});

els.runBackupScenario?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run backup/import checks")) return;
  await traceAdminToolOperation("backup-import-checks", "Run backup/import checks", () => runTestLabScenarioMatrix({
    scenarioName: "backup-import-checks",
    scenarioFilter: ["backup"],
    confirmMessage: "Run backup/import validation checks? This does not restore or overwrite data."
  }));
});

els.runPrivacyScenario?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run location privacy checks")) return;
  await traceAdminToolOperation("location-privacy-checks", "Run location privacy checks", () => runTestLabScenarioMatrix({
    scenarioName: "location-privacy-checks",
    scenarioFilter: ["privacy"],
    confirmMessage: "Run location privacy checks? This does not request or save your current GPS location."
  }));
});

els.runRuntimeScenario?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run runtime/PWA checks")) return;
  await traceAdminToolOperation("runtime-pwa-checks", "Run runtime/PWA checks", () => runTestLabScenarioMatrix({
    scenarioName: "runtime-pwa-checks",
    scenarioFilter: ["runtime", "sync"],
    confirmMessage: "Run runtime/PWA and synced-report checks?"
  }));
});

els.runSecurityScenario?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Run live Security Health")) return;
  const remaining = securityHealthCooldownMs - (Date.now() - lastStandaloneSecurityHealthAt);
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    showUserWarning(`Security Health is on cooldown. Try again in about ${seconds} second${seconds === 1 ? "" : "s"}.`);
    return;
  }
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "live Security Health",
    phrase: "RUN SECURITY HEALTH",
    title: "Run live Security Health?",
    detail: "This is cloud-touching. It uses live Supabase checks and should only be run when CPU is calm. Routine Test Lab skips the deep backend probe.",
    requireUnlock: false
  }))) return;
  lastStandaloneSecurityHealthAt = Date.now();
  await traceAdminToolOperation("security-health", "Run live Security Health", () => runStandaloneSecurityHealthScenario({ skipConfirmation: true }), { staleAfterMs: longAdminToolDataIoOperationStaleMs });
});

els.exportTestLabReport?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Export Test Lab report")) return;
  downloadLastTestLabReport();
});

els.saveTestLabReportCloud?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Save Test Lab report to cloud")) return;
  const report = getCurrentTestLabReport();
  if (!report) {
    showUserWarning("Run or export a Test Lab report before saving it to cloud.");
    return { ok: false, skipped: true, reason: "missing-report" };
  }
  if (isHistoricalTestLabReport(report)) {
    showUserWarning("This is a historical saved report. Run Security health or Test Lab again before saving a fresh cloud report.");
    setDataToolsMessage("Historical saved report was not re-saved. Run a fresh check, then save the new report to cloud.");
    return { ok: false, skipped: true, reason: "historical-report" };
  }
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "save Test Lab report to cloud",
    phrase: "SAVE REPORT TO CLOUD",
    title: "Save Test Lab report to cloud?",
    detail: "Routine Test Lab reports stay local. This writes report metadata to shared cloud storage.",
    requireUnlock: false
  }))) return;
  await traceAdminToolOperation("save-test-lab-report-cloud", "Save Test Lab report to cloud", () => saveCurrentTestLabReportToCloud({ skipConfirmation: true }));
});

els.cleanupTestLabData?.addEventListener("click", async () => {
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "clean generated Test Lab data",
    phrase: "CLEAN TEST DATA",
    title: "Clean generated Test Lab data?",
    detail: "This removes entries carrying the generated test marker. Production data should be left untouched."
  }))) return;
  await traceAdminToolOperation("cleanup-test-lab-data", "Clean generated Test Lab data", cleanupGeneratedTestDataWithReport);
});

els.refreshAboutBuildInfo?.addEventListener("click", () => {
  window.FuelBuildInfo?.refreshBuildInfo?.();
});

els.refreshBuildInfo?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Refresh admin version status")) return;
  window.FuelBuildInfo?.refreshBuildInfo?.();
  renderAdminGuardrailOverview();
});

els.refreshSupabaseLoadMonitor?.addEventListener("click", () => {
  if (!requireGlobalAdminToolsPermission("Refresh load monitor")) return;
  renderSupabaseLoadMonitor();
  renderAdminGuardrailOverview();
  setDataToolsMessage("Supabase load monitor refreshed.");
});

els.checkRenderAdminHealth?.addEventListener("click", async () => {
  if (!requireGlobalAdminToolsPermission("Check Render admin health")) return;
  await traceAdminToolOperation("render-admin-health", "Check Render admin health", () => checkRenderAdminHealth());
});

async function handleManualSyncNow(source = "manual") {
  const reason = `manual-${source}`;
  clearRecoverableSyncDelayAfterHealthySync(`${reason}-preflight`);
  clearSyncDelay(`${reason}-start`);
  recordSyncDiagnostic("manual-load-start", reason, { reason, source });
  if (!supabaseClient) {
    await loadRemoteState();
    return;
  }
  if (!currentSession) {
    setSyncStatus("Login");
    showAppMessage("Sign in before syncing shared data.", "warning");
    return;
  }
  const button = source === "admin" ? els.syncNowAdmin : els.syncNow;
  const originalText = button?.textContent || "Sync now";
  if (button) {
    button.disabled = true;
    button.textContent = "Syncing...";
  }
  try {
    const loaded = await loadSupabaseStateWithTimeout(
      { force: true, reason, manual: true },
      supabaseStartupLoadTimeoutMs,
      "Manual cloud sync is delayed. You can keep using local data and try again."
    );
    if (loaded) {
      recordSyncDiagnostic("manual-load-success", reason, { reason, source });
      showAppMessage("Shared data refreshed.");
    } else if (hasRecentHealthyCloudSync()) {
      recordSyncDiagnostic("manual-load-quiet-incomplete", "Manual sync did not finish, but a recent healthy cloud sync exists.", { reason, source });
      restoreHealthySyncStatusAfterQuietSync(`${reason}-recent-healthy`);
      showAppMessage("Shared data was recently refreshed. Background sync is still settling.", "info");
    } else {
      recordSyncDiagnostic("manual-load-incomplete", "Manual sync did not complete and no recent healthy cloud sync was found.", { reason, source });
      showAppMessage("Cloud sync did not complete. You can keep using local data and try again.", "warning");
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

els.syncNow?.addEventListener("click", () => {
  handleManualSyncNow("topbar");
});

els.syncNowAdmin?.addEventListener("click", () => {
  handleManualSyncNow("admin");
});

els.activeWorkspace?.addEventListener("change", (event) => {
  switchActiveWorkspace(event.target.value, "workspace-selector").catch((error) => {
    showUserError(`Could not switch workspace: ${error.message || error}`);
    renderActiveWorkspaceSelector();
  });
});

els.toggleLiveSync?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  liveSyncEnabled = !liveSyncEnabled;
  localStorage.setItem(liveSyncStorageKey, liveSyncEnabled ? "true" : "false");
  recordSupabaseLoadEvent("live-sync-toggle", liveSyncEnabled ? "enabled" : "disabled");
  if (liveSyncEnabled) {
    subscribeToSupabaseState({ force: true });
    setDataToolsMessage("Live Realtime sync enabled for this browser. Use briefly for in-app live updates; leave off if Supabase CPU rises.");
  } else {
    unsubscribeFromSupabaseState();
    setDataToolsMessage("Live Realtime sync disabled. In-app notifications use the lightweight event channel and safe auto-refresh; broad table Realtime remains off.");
  }
  render();
});

els.exportSupabaseLoadReport?.addEventListener("click", () => {
  if (!canManageSettings()) return;
  downloadSupabaseLoadReport();
});

els.previewRetentionCleanup?.addEventListener("click", () => {
  previewRetentionCleanup();
});

els.runRetentionCleanup?.addEventListener("click", () => {
  runRetentionCleanup();
});

els.memberManagementForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canManageSettings()) return;
  await traceAdminToolOperation("add-member", "Add managed member", addManagedMember);
});

els.refreshMembers?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await traceAdminToolOperation("refresh-members", "Refresh member management", refreshMemberManagement);
});

els.refreshWorkspaceInvites?.addEventListener("click", async () => {
  await traceMemberActionOperation("workspace-tools-refresh", "Refresh workspace tools", () => scheduleWorkspaceInviteRefresh("manual-refresh") || Promise.resolve(), { operation: "refresh" });
});

els.createWorkspaceForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createPrivateWorkspaceFromUi();
});

els.createInviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canManageSettings()) return;
  await traceAdminToolOperation("create-invite", "Create workspace invite", createWorkspaceInvite);
});

els.redeemInviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await traceMemberActionOperation("workspace-invite-redeem", "Redeem workspace invite", redeemWorkspaceInvite, { operation: "redeem", staleAfterMs: workspaceInviteRequestTimeoutMs });
});

els.memberProfileSetupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveOwnMemberProfileFromSetup();
});

els.workspaceList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-workspace-action]");
  if (!button) return;
  if (button.dataset.workspaceAction === "switch") {
    await traceMemberActionOperation("workspace-switch", "Switch active workspace", () => switchActiveWorkspace(button.dataset.ledgerId, "workspace-list"), { operation: "switch" });
  }
});

els.inviteList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-invite-action]");
  if (!button || !canManageSettings()) return;
  const row = button.closest("[data-invite-id]");
  if (!row) return;
  if (button.dataset.inviteAction === "revoke") await traceAdminToolOperation("revoke-invite", "Revoke workspace invite", () => revokeWorkspaceInvite(row.dataset.inviteId));
});

els.memberManagementList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-member-action]");
  if (!button || !canManageSettings()) return;
  const row = button.closest("[data-member-id]");
  if (!row) return;
  const action = button.dataset.memberAction;
  if (action === "save") await traceAdminToolOperation("save-member", "Save managed member", () => saveManagedMember(row));
  if (action === "deactivate") await traceAdminToolOperation("deactivate-member", "Deactivate managed member", () => setManagedMemberActive(row, false));
  if (action === "reactivate") await traceAdminToolOperation("reactivate-member", "Reactivate managed member", () => setManagedMemberActive(row, true));
});

els.refreshDatabaseDiagnostics?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await traceAdminToolOperation("refresh-database-diagnostics", "Refresh database diagnostics", async () => {
    await refreshDatabaseDiagnostics();
    await checkNormalizedTablesAgainstCurrentState({ force: true, reason: "manual-refresh" }).catch((error) => {
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not refresh normalized table health: ${error.message || error}`
    };
    render();
    });
  });
});

els.saveJsonBackupNow?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  els.saveJsonBackupNow.disabled = true;
  try {
    await traceAdminToolOperation("save-json-backup", "Save JSON mirror backup", async () => {
      await saveJsonMirrorBackup({ force: true, reason: "manual JSON mirror backup" });
      await refreshDatabaseDiagnostics();
    });
  } finally {
    els.saveJsonBackupNow.disabled = false;
  }
});

els.cleanStaleRequests?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  els.cleanStaleRequests.disabled = true;
  try {
    const cleaned = await traceAdminToolOperation("clean-stale-requests", "Clean stale settlement request rows", cleanStaleSettlementRequests);
    els.authMessage.textContent = cleaned
      ? `Cleaned ${cleaned} stale settlement request row${cleaned === 1 ? "" : "s"}.`
      : "No stale settlement request rows found.";
  } catch (error) {
    els.authMessage.textContent = `Could not clean stale request rows: ${error.message || error}`;
  } finally {
    els.cleanStaleRequests.disabled = false;
    await refreshDatabaseDiagnostics();
    await checkNormalizedTablesAgainstCurrentState({ force: true, reason: "manual-refresh" }).catch((error) => {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not refresh normalized payment request health after cleanup: ${error.message || error}`
      };
      render();
    });
  }
});

els.productionActivityReset?.addEventListener("click", async () => {
  if (!canManageSettings()) return;
  await traceAdminToolOperation("production-activity-reset", "Reset production activity diagnostics", runProductionActivityReset);
});


function getTestActorName() {
  return currentUser || getMemberNames()[0] || "Christian";
}

function getTestParticipantNames(actor) {
  const members = getMemberNames();
  const ordered = [actor, ...members.filter((name) => name !== actor)];
  return Array.from(new Set(ordered)).slice(0, Math.min(2, Math.max(1, ordered.length)));
}

async function persistGeneratedTestDataLocallyAndToCloud(message, options = {}) {
  const renderBacked = options.renderBacked === true;
  const reason = options.reason || (renderBacked ? "admin-test-data Render JSON mirror backup" : "admin-test-data-table-primary");
  state.updatedAt = new Date().toISOString();
  writeLocalState();
  if (supabaseClient && currentSession && renderBacked) {
    saveState({ reason, queueRemote: false });
    try {
      const mirrored = await saveJsonMirrorBackup({ force: true, reason });
      if (mirrored) {
        markRemoteSaveSucceeded("Tables");
        recordSupabaseLoadEvent("browser-full-state-save-skip", "admin generated test data already saved through Render routes and JSON mirror backup");
      }
    } catch (error) {
      console.warn("Generated test data JSON mirror backup failed", error);
      markRemoteSaveFailed(error, "Could not save generated test data JSON mirror backup.");
    }
  } else if (supabaseClient && currentSession) {
    await saveSupabaseState({ reason: "admin-test-data-table-primary" });
    if (pendingLocalChanges > 0) {
      recordSupabaseLoadEvent("admin-test-pending-clear", `${pendingLocalChanges} queued change(s) cleared after table-primary generated-data save`);
      markRemoteSaveSucceeded("Tables");
    }
  } else {
    saveState();
  }
  setDefaultDates();
  render();
  setDataToolsMessage(message);
}

async function createGeneratedTestDataViaRender(type, entry) {
  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const operationId = createDataIoOperationId(`admin-test-data-${type}`);
  const traceMeta = { source: `admin-test-data:${type}`, route: "render-api", endpoint: renderAdminTestDataCreateUrl, operation: "create", operationId };
  if (!currentSession?.access_token || !ledgerId) return { ok: false, shouldFallback: false, backend: "render-api", error: new Error("Sign in and select an active ledger before creating generated Test Lab data.") };

  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, ledgerId });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render admin test data API", 12000));
      }, 12000);
    });
    const fetchPromise = fetch(renderAdminTestDataCreateUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId, type, entry, currency: state.currency || "DKK" })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-admin-test-data-create", `created generated test ${type} via Render admin route`);
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true, ledgerId });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render admin test data create failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    recordDataIoDiagnostic("error", { ...traceMeta, error, ledgerId, detail: `HTTP ${response.status}; Render generated test-data create failed. Browser test-data fallback is disabled.` });
    return { ok: false, error, shouldFallback: false, backend: "render-api" };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render admin test data API", 12000);
    recordDataIoDiagnostic(timedOut ? "timeout" : "exception", { ...traceMeta, error, ledgerId, detail: "Render generated test-data create failed. Browser test-data fallback is disabled." });
    return { ok: false, error, shouldFallback: false, backend: "render-api" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function addGeneratedTestTrip() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const actor = getTestActorName();
  if (!actor) {
    showUserError("Add at least one member before creating test trips.");
    return;
  }

  const start = Number(getLatestOdometer() || 100000) + 1;
  const end = start + 12;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const tripPayload = {
    id: `${generatedTestPrefix}trip-${crypto.randomUUID()}`,
    logRef: createLogRef(`${generatedTestPrefix}trip`),
    driver: actor,
    participants: getTestParticipantNames(actor),
    date: localDateString(),
    startKm: round(start),
    endKm: round(end),
    note: `${generatedTestMarker} generated trip ${stamp}`
  };

  const renderSaved = await createGeneratedTestDataViaRender("trip", tripPayload);
  if (!renderSaved.ok) {
    showUserError(`Could not create generated test trip through Render: ${renderSaved.error?.message || renderSaved.error || "unknown error"}`);
    return;
  }

  state.trips.push(tripPayload);
  state.lastOdometer = getLatestOdometer();
  addAuditEntry({
    type: "trip_created",
    entityType: "trip",
    entityId: tripPayload.id,
    summary: `${formatLogRef(tripPayload)} · ${tripPayload.driver} · ${formatNumber(tripPayload.endKm - tripPayload.startKm)} km`,
    detail: `Generated admin test trip · ${getTripPeriodLabel(tripPayload)}`
  });
  await persistGeneratedTestDataLocallyAndToCloud("Added one generated test trip through the Render admin test-data route. No browser write-context setup is needed.", { renderBacked: true, reason: "admin generated test trip Render JSON mirror backup" });
}

async function addGeneratedTestFuel() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  const actor = getTestActorName();
  if (!actor) {
    showUserError("Add at least one member before creating test fuel logs.");
    return;
  }

  const amount = 123.45;
  const liters = 8.5;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const fuelPayload = {
    id: `${generatedTestPrefix}fuel-${crypto.randomUUID()}`,
    logRef: createLogRef(`${generatedTestPrefix}fuel`),
    payer: actor,
    date: localDateString(),
    amount: roundMoney(amount),
    liters: round(liters),
    pricePerLiter: roundMoney(amount / liters),
    odometer: getLatestOdometer() || "",
    station: `${generatedTestMarker} generated station ${stamp}`,
    location: null,
    stationInfo: null,
    fullTank: false
  };

  const renderSaved = await createGeneratedTestDataViaRender("fuel", fuelPayload);
  if (!renderSaved.ok) {
    showUserError(`Could not create generated test fuel through Render: ${renderSaved.error?.message || renderSaved.error || "unknown error"}`);
    return;
  }

  state.fuel.push(fuelPayload);
  addAuditEntry({
    type: "fuel_created",
    entityType: "fuel",
    entityId: fuelPayload.id,
    summary: `${formatLogRef(fuelPayload)} · ${fuelPayload.payer} · ${formatFuelAmountLitersAndPrice(fuelPayload)}`,
    detail: `Generated admin test fuel log · ${fuelPayload.date || ""}${fuelPayload.odometer ? ` · ${formatNumber(fuelPayload.odometer)} km` : ""}`
  });
  await persistGeneratedTestDataLocallyAndToCloud("Added one generated test fuel log through the Render admin test-data route. No browser write-context setup is needed.", { renderBacked: true, reason: "admin generated test fuel Render JSON mirror backup" });
}

async function removeGeneratedTestData() {
  await exportAdminSafetyBackup("remove generated test data");
  assertFreshAdminSafetyBackup("remove generated test data");
  const cleanup = cleanupGeneratedTestEntriesFromState();
  const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables("remove-generated-test-data");
  const normalizedCleanupMessage = normalizedCleanup?.total ? ` Soft-deleted ${normalizedCleanup.total} generated normalized row${normalizedCleanup.total === 1 ? "" : "s"}.` : "";
  setDataToolsMessage(`${cleanup.message}${normalizedCleanupMessage} Saved local cleanup and Render JSON mirror backup.`);
  suppressNextQueuedRemoteSaveReason = "remove generated test data after Render JSON mirror backup";
  saveState({ reason: "remove generated test data", queueRemote: false });
  try {
    const mirrored = await saveJsonMirrorBackup({ force: true, reason: "remove generated test data cleanup JSON mirror backup" });
    if (mirrored) {
      markRemoteSaveSucceeded("Tables");
      recordSupabaseLoadEvent("browser-full-state-save-skip", "remove generated test data already saved through Render JSON mirror backup");
    }
  } catch (error) {
    console.warn("Cleanup JSON mirror backup failed", error);
    markRemoteSaveFailed(error, "Could not save cleanup JSON mirror backup.");
  }
  setDefaultDates();
  render();
  if (testLab) {
    const report = buildCurrentTestLabReport({
      id: testLab.createTestRunId(),
      scenario: "remove-test-data",
      startedAt: new Date().toISOString(),
      before: cleanup.before,
      generated: cleanup.after,
      cleanup
    });
    renderTestLabReport(report, { persist: false });
  }
}

function isGeneratedTestEntry(entry) {
  if (!entry) return false;
  return String(entry.id || "").startsWith(generatedTestPrefix) ||
    String(entry.note || "").includes(generatedTestMarker) ||
    String(entry.station || "").includes(generatedTestMarker);
}

function isStrictGeneratedTestEntry(entry) {
  if (!entry) return false;
  return String(entry.id || "").startsWith(generatedTestPrefix);
}

function isStrictGeneratedTestStatusKey(key) {
  return String(key || "").includes(generatedTestPrefix);
}

function makeGeneratedTestTrip(index = 0) {
  const members = getMemberNames();
  const actor = members[index % Math.max(1, members.length)] || getTestActorName();
  const others = members.filter((name) => name !== actor);
  const participants = Array.from(new Set([
    actor,
    ...others.slice(index % Math.max(1, others.length), (index % Math.max(1, others.length)) + 2),
    ...others.slice(0, 2)
  ])).slice(0, Math.min(3, Math.max(1, members.length)));
  const start = Number(getLatestOdometer() || 100000) + 1 + (index * 18);
  const distance = 8 + (index % 7) * 11;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  return {
    id: `${generatedTestPrefix}trip-${crypto.randomUUID()}`,
    driver: actor,
    participants,
    date: localDateString(new Date(Date.now() - (index % 5) * 86400000)),
    startKm: round(start),
    endKm: round(start + distance),
    note: `${generatedTestMarker} stress trip ${index + 1} generated ${stamp}`
  };
}

function makeGeneratedTestFuel(index = 0) {
  const members = getMemberNames();
  const actor = members[index % Math.max(1, members.length)] || getTestActorName();
  const liters = 5 + (index % 9) * 2.25;
  const price = 12.75 + (index % 5) * 0.45;
  const amount = roundMoney(liters * price);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  return {
    id: `${generatedTestPrefix}fuel-${crypto.randomUUID()}`,
    payer: actor,
    date: localDateString(new Date(Date.now() - (index % 5) * 86400000)),
    amount,
    liters: round(liters),
    pricePerLiter: roundMoney(amount / liters),
    odometer: round(Number(getLatestOdometer() || 100000) + index * 25),
    station: `${generatedTestMarker} stress station ${index + 1} ${stamp}`,
    location: null,
    stationInfo: null,
    fullTank: index % 3 === 0
  };
}

async function persistGeneratedAdminStateWithRenderMirror(reason, message, { checkTables = true } = {}) {
  const normalizedReason = String(reason || "admin-generated-data").trim() || "admin-generated-data";
  writeLocalState();
  markNormalizedReconciliationDirty(normalizedReason);

  if (supabaseClient && currentSession) {
    try {
      const mirrored = await saveJsonMirrorBackup({ force: true, reason: `${normalizedReason} JSON mirror backup` });
      if (mirrored) {
        suppressNextQueuedRemoteSaveReason = `${normalizedReason} already saved through Render JSON mirror backup`;
        markRemoteSaveSucceeded("Tables");
        recordSupabaseLoadEvent("browser-full-state-save-skip", suppressNextQueuedRemoteSaveReason);
      }
    } catch (error) {
      console.warn(`${normalizedReason} Render JSON mirror backup failed`, error);
      markRemoteSaveFailed(error, `Could not save ${normalizedReason} JSON mirror backup.`);
      throw error;
    }

    if (checkTables) {
      try {
        await checkNormalizedTablesAgainstCurrentState({ force: true, reason: normalizedReason });
      } catch (error) {
        console.warn(`${normalizedReason} normalized table check failed`, error);
      }
    }
  } else {
    saveState({ reason: normalizedReason, queueRemote: false });
  }

  finishForegroundOperationsBySource(normalizedReason, "Render backup path completed");
  finishForegroundOperationsBySource("advanced-stress", "Render backup path completed");
  render();
  setDataToolsMessage(message);
}

async function flushStressSave(label) {
  markNormalizedReconciliationDirty("advanced-stress");
  await persistGeneratedAdminStateWithRenderMirror("advanced-stress", label);
}

async function runGeneratedStressTest() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  if (!confirmUserAction("Run the advanced stress test? This writes temporary generated data to the app and may increase Supabase usage. Use only when diagnosing sync behavior; clean generated data afterwards.")) return;
  const members = getMemberNames();
  if (!members.length) {
    showUserError("Add at least one member before running the stress test.");
    return;
  }

  setDataToolsMessage("Running stress test: generating entries...");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const tripCount = 6;
  const fuelCount = 3;
  for (let i = 0; i < tripCount; i += 1) state.trips.push(makeGeneratedTestTrip(i));
  for (let i = 0; i < fuelCount; i += 1) state.fuel.push(makeGeneratedTestFuel(i));
  state.lastOdometer = getLatestOdometer();

  await flushStressSave(`Stress test added ${tripCount} trips and ${fuelCount} fuel logs. Normalized table check: ${normalizedTableStatus.ok ? "green" : "needs review"}.`);
}

async function runGeneratedRapidSaveTest() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  if (!confirmUserAction("Run the advanced rapid save test? This performs repeated saves and may increase Supabase CPU usage. Use only when diagnosing sync behavior.")) return;
  const members = getMemberNames();
  if (!members.length) {
    showUserError("Add at least one member before running the rapid save test.");
    return;
  }

  for (let i = 0; i < 4; i += 1) {
    setDataToolsMessage(`Rapid save test ${i + 1}/4...`);
    if (i % 2 === 0) state.trips.push(makeGeneratedTestTrip(100 + i));
    else state.fuel.push(makeGeneratedTestFuel(100 + i));
    state.lastOdometer = getLatestOdometer();
    await flushStressSave(`Rapid save test ${i + 1}/4 saved.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  setDataToolsMessage(`Rapid save test complete. Normalized table check: ${normalizedTableStatus.ok ? "green" : "needs review"}.`);
  render();
}

function makeGeneratedTestBooking(index = 0, runId = "") {
  const members = getMemberNames();
  const actor = members[index % Math.max(1, members.length)] || getTestActorName();
  const start = new Date(Date.now() - ((index + 1) * 86400000) + (index % 6) * 3600000);
  const end = new Date(start.getTime() + (90 + (index % 4) * 30) * 60000);
  const id = `${generatedTestPrefix}booking-${crypto.randomUUID()}`;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  return {
    id,
    logRef: createLogRef(id),
    member: actor,
    start: normalizeBookingDateTime(start.toISOString().slice(0, 16)),
    end: normalizeBookingDateTime(end.toISOString().slice(0, 16)),
    purpose: `${generatedTestMarker} ${runId} generated booking ${index + 1} ${stamp}`,
    createdBy: currentUser || actor,
    plannedDistanceKm: 10 + (index % 5) * 7,
    routeFrom: "Test Lab",
    routeTo: "Generated route",
    plannedParticipants: members.slice(0, Math.min(3, members.length)),
    testRunId: runId || ""
  };
}

function tagGeneratedEntry(entry, runId) {
  if (!entry || typeof entry !== "object") return entry;
  entry.testRunId = runId;
  if (entry.note && !String(entry.note).includes(runId)) entry.note = `${entry.note} ${runId}`;
  if (entry.station && !String(entry.station).includes(runId)) entry.station = `${entry.station} ${runId}`;
  return entry;
}

function cleanupGeneratedTestEntriesFromState() {
  const before = testLab?.generatedDataSummary ? testLab.generatedDataSummary(state, { prefix: generatedTestPrefix, marker: generatedTestMarker }) : null;
  const isTest = isStrictGeneratedTestEntry;

  state.trips = (state.trips || []).filter((trip) => !isTest(trip));
  state.fuel = (state.fuel || []).filter((fuel) => !isTest(fuel));
  state.bookings = (state.bookings || []).filter((booking) => !isTest(booking));
  state.closedPeriods = (state.closedPeriods || []).filter((period) => !isTest(period));

  Object.keys(state.paymentStatuses || {}).forEach((key) => {
    if (isStrictGeneratedTestStatusKey(key)) delete state.paymentStatuses[key];
  });

  state.lastOdometer = getLatestOdometer();
  const after = testLab?.generatedDataSummary ? testLab.generatedDataSummary(state, { prefix: generatedTestPrefix, marker: generatedTestMarker }) : null;
  const removed = before && after ? {
    trips: before.trips - after.trips,
    fuel: before.fuel - after.fuel,
    bookings: before.bookings - after.bookings,
    closedPeriods: before.closedPeriods - after.closedPeriods,
    paymentStatuses: before.paymentStatuses - after.paymentStatuses,
    total: before.total - after.total
  } : null;
  return { before, after, removed, message: removed ? `Removed ${removed.total} generated test item(s).` : "Generated test data cleaned." };
}


function isGeneratedNormalizedTripRow(row) {
  return Boolean(row) && (
    String(row.legacy_id || "").startsWith(generatedTestPrefix) ||
    String(row.note || "").includes(generatedTestMarker)
  );
}

function isGeneratedNormalizedFuelRow(row) {
  return Boolean(row) && (
    String(row.legacy_id || "").startsWith(generatedTestPrefix) ||
    String(row.station_name || "").includes(generatedTestMarker)
  );
}

function isGeneratedNormalizedBookingRow(row) {
  return Boolean(row) && (
    String(row.legacy_id || "").startsWith(generatedTestPrefix) ||
    String(row.purpose || "").includes(generatedTestMarker)
  );
}

async function softDeleteGeneratedNormalizedRows(table, rows, source) {
  const ids = (rows || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return 0;
  const result = await traceDataIo(
    { source, route: "direct-table", table, operation: "soft-delete" },
    () => supabaseClient
      .from(table)
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in("id", ids)
  );
  if (result.error) throw result.error;
  return ids.length;
}

async function cleanupGeneratedRowsFromNormalizedTablesViaRender(reason = "cleanup-test-lab-data") {
  if (!supabaseClient || !currentSession || typeof fetch !== "function") return null;
  const ledgerId = getActiveLedgerId();
  if (!ledgerId) return null;
  const source = "normalized-test-data-cleanup";
  const operationId = createDataIoOperationId(source);
  const traceMeta = { source, route: "render-api", endpoint: renderAdminTestDataCleanupUrl, operation: "soft-delete", operationId };
  recordDataIoDiagnostic("start", { ...traceMeta, ledgerId, detail: reason });
  let response;
  let controller = null;
  let timeoutId = 0;
  try {
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render admin cleanup API", 12000));
      }, 12000);
    });
    const fetchPromise = fetch(renderAdminTestDataCleanupUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId, reason })
    });
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (error) {
    recordDataIoDiagnostic(error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError" ? "timeout" : "error", { ...traceMeta, ledgerId, error, detail: "Render cleanup route unavailable. Browser direct-table cleanup fallback is disabled." });
    return null;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { payload = null; }
  if (!response.ok || !payload?.ok) {
    const detail = `HTTP ${response.status}; Render cleanup failed. Browser direct-table cleanup fallback is disabled.`;
    const error = new Error(payload?.error || payload?.message || detail);
    recordDataIoDiagnostic("error", { ...traceMeta, ledgerId, error, detail });
    throw error;
  }
  const counts = payload.counts || {};
  const result = {
    skipped: false,
    trips: Number(counts.trips || 0),
    fuel: Number(counts.fuel || 0),
    bookings: Number(counts.bookings || 0),
    total: Number(counts.total || 0),
    backend: "render"
  };
  recordDataIoDiagnostic("success", { ...traceMeta, ok: true, ledgerId, detail: `soft-deleted ${result.total} generated normalized row(s)` });
  recordSupabaseLoadEvent("render-normalized-test-data-cleanup", `${reason}: soft-deleted ${result.trips} trip(s), ${result.fuel} fuel log(s), ${result.bookings} booking(s) via Render admin route`);
  return result;
}

async function cleanupGeneratedRowsFromNormalizedTables(reason = "cleanup-test-lab-data") {
  const renderResult = await cleanupGeneratedRowsFromNormalizedTablesViaRender(reason);
  if (!renderResult) {
    throw new Error("Render generated Test Lab cleanup route is unavailable. Browser direct-table cleanup fallback is disabled.");
  }
  normalizedTableStatus = {
    checked: true,
    ok: true,
    message: renderResult.total
      ? `Generated Test Lab cleanup soft-deleted ${renderResult.total} generated normalized row${renderResult.total === 1 ? "" : "s"} through Render (${renderResult.trips} trips, ${renderResult.fuel} fuel logs, ${renderResult.bookings} bookings).`
      : "Generated Test Lab cleanup found no generated normalized rows to soft-delete through Render.",
    details: [`Generated normalized cleanup through Render: ${renderResult.trips} trips, ${renderResult.fuel} fuel logs, ${renderResult.bookings} bookings.`]
  };
  return renderResult;
}

function normalizeTestLabReports(value) {
  const reports = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value]
      : [];
  return reports
    .filter((report) => report && typeof report === "object" && !Array.isArray(report))
    .map((report) => sanitizeStoredDiagnosticReport({
      ...report,
      id: String(report.id || "").trim() || `testlab-${Date.now()}`,
      syncedAt: report.syncedAt || report.finishedAt || report.startedAt || new Date().toISOString()
    }))
    .sort((a, b) => Date.parse(b.syncedAt || b.finishedAt || b.startedAt || "") - Date.parse(a.syncedAt || a.finishedAt || a.startedAt || ""))
    .slice(0, retentionPolicy.keepLatestTestLabReports);
}

function getLatestSyncedTestLabReport() {
  const reports = normalizeTestLabReports(state.testLabReports);
  return reports[0] || null;
}

function getCurrentTestLabReport() {
  return lastTestLabReport || getLatestSyncedTestLabReport();
}

function recordSupabaseLoadEvent(label, detail = "", extra = {}) {
  const now = Date.now();
  const event = {
    at: now,
    iso: new Date(now).toISOString(),
    label: String(label || "supabase"),
    detail: String(detail || ""),
    ...extra
  };
  supabaseLoadSafety.requests = (supabaseLoadSafety.requests || [])
    .filter((entry) => now - Number(entry.at || 0) < 30 * 60 * 1000)
    .slice(-299);
  supabaseLoadSafety.requests.push(event);
  return event;
}

function getSupabaseLoadEvents(windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  return (supabaseLoadSafety.requests || [])
    .filter((entry) => now - Number(entry.at || 0) <= windowMs)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

function isSupabaseLoadNoiseEvent(entry = {}) {
  const label = String(entry.label || "");
  if (Boolean(entry.diagnostic) || label.startsWith("sync-diagnostic:")) return true;
  if (entry.dataIo && (/^data-io:admin/i.test(label) || /^data-io:admin-tool:/i.test(label))) return true;
  if (entry.dataIo && /^data-io:(json-mirror-backup|normalized-test-data-cleanup|retention-preview|retention-cleanup):/i.test(label)) return true;
  if (/^admin-tool:/i.test(label) || /^render-admin-health$/i.test(label) || /^render-admin-report-save$/i.test(label)) return true;
  if (/^security-health/i.test(label) || /^normalized-health/i.test(label) || /^test-lab-report/i.test(label)) return true;
  if (/^(render-json-mirror-backup|json-mirror-save|browser-full-state-save-skip)$/i.test(label)) return true;
  if (/^(render-normalized-test-data-cleanup|normalized-reconciliation-dirty|test-lab-local-run)$/i.test(label)) return true;
  if (/^(render-retention-preview|render-retention-cleanup)$/i.test(label)) return true;
  if (/skip$/i.test(label) || /-skip$/i.test(label) || /-disabled$/i.test(label)) return true;
  if (/^realtime-(resumed-visible|paused-hidden|disabled)$/i.test(label)) return true;
  if (/^ledger-events-subscription/i.test(label)) return true;
  return label === "foreground-operation-start"
    || label === "foreground-operation-finished"
    || label === "foreground-operation-timeout"
    || label === "saving-stale-cleared"
    || label === "syncing-stale-cleared"
    || label === "sync-delay-cleared";
}

function supabaseLoadActivityEvents(events = []) {
  return (events || []).filter((entry) => !isSupabaseLoadNoiseEvent(entry));
}

function summarizeSupabaseLoadEvents(events, options = {}) {
  const includeDiagnostics = options.includeDiagnostics === true;
  const byLabel = {};
  for (const entry of events || []) {
    if (!includeDiagnostics && isSupabaseLoadNoiseEvent(entry)) continue;
    const label = entry.label || "supabase";
    byLabel[label] = (byLabel[label] || 0) + 1;
  }
  return byLabel;
}

function getSupabaseLoadSummary({ windowMinutes = 10 } = {}) {
  const now = Date.now();
  const events = getSupabaseLoadEvents(windowMinutes * 60 * 1000);
  const activityEvents = supabaseLoadActivityEvents(events);
  const lastMinute = activityEvents.filter((entry) => now - Number(entry.at || 0) <= 60 * 1000).length;
  const lastFiveMinutes = activityEvents.filter((entry) => now - Number(entry.at || 0) <= 5 * 60 * 1000).length;
  const byLabel = summarizeSupabaseLoadEvents(events);
  const diagnosticByLabel = summarizeSupabaseLoadEvents(events, { includeDiagnostics: true });
  const highActivity = lastMinute >= 20 || (lastMinute >= 10 && lastFiveMinutes >= 50);
  const coolingDown = !highActivity && lastFiveMinutes >= 50;
  return {
    windowMinutes,
    total: activityEvents.length,
    rawTotal: events.length,
    lastMinute,
    lastFiveMinutes,
    highActivity,
    coolingDown,
    byLabel,
    diagnosticByLabel,
    latest: events.slice(0, 25)
  };
}

function supabaseLoadLabel(label) {
  const map = {
    "local-save": "Local saves",
    "server-load": "Local server loads",
    "server-save": "Local server saves",
    "supabase-load": "Supabase loads",
    "supabase-save": "Supabase saves",
    "json-mirror-save": "JSON mirror saves",
    "normalized-table-load": "Normalized table loads",
    "normalized-health-check": "Normalized health checks",
    "security-health": "Security health checks",
    "security-health-live": "Live security probes",
    "realtime-ledger-event": "Realtime ledger events",
    "ledger-event-publish": "Ledger event publishes",
    "ledger-event-notification": "In-app event notifications",
    "ledger-event-failed": "Ledger event failures",
    "ledger-event-skip": "Ledger event skips",
    "ledger-events-subscription": "Event notification channel",
    "ledger-events-subscription-skip": "Event channel reuse",
    "realtime-subscription-skip": "Realtime subscription reuse",
    "focus-sync-start": "Focus sync started",
    "background-sync-incomplete": "Background sync incomplete",
    "realtime-disabled": "Realtime disabled",
    "ledger-event-auto-sync": "Event auto-refresh",
    "ledger-event-auto-sync-scheduled": "Event auto-refresh scheduled",
    "ledger-event-auto-sync-skip": "Event auto-refresh skipped",
    "live-sync-toggle": "Live sync toggle",
    "focus-sync-skip": "Focus sync skipped",
    "supabase-load-skip": "Supabase load skipped",
    "supabase-load-timeout": "Supabase load timeout",
    "supabase-load-stale-result": "Ignored stale Supabase load",
    "realtime-ignored-self-save": "Ignored self realtime events",
    "trip-table-write": "Trip table writes",
    "fuel-table-write": "Fuel table writes",
    "booking-table-write": "Booking table writes",
    "settlement-table-write": "Settlement table writes",
    "test-lab-report-save": "Test Lab report saves",
    "test-lab-report-load": "Test Lab report loads",
    "test-lab-report-load-skip": "Test Lab report load skips",
    "test-lab-report-local-merge": "Test Lab report local merges",
    "test-lab-report-rpc-save": "Test Lab report RPC saves"
  };
  return map[label] || String(label || "Supabase activity").replace(/-/g, " ");
}

function buildSupabaseLoadReport() {
  const summary = getSupabaseLoadSummary({ windowMinutes: 10 });
  return {
    createdAt: new Date().toISOString(),
    buildInfo: window.FUEL_LEDGER_BUILD || null,
    browser: navigator.userAgent,
    appState: {
      hasSupabaseClient: Boolean(supabaseClient),
      hasSession: Boolean(currentSession),
      liveSyncEnabled,
      realtimeChannelActive: Boolean(supabaseStateChannel),
      ledgerEventsRealtimeActive: Boolean(ledgerEventsChannel),
      supabaseLoadInFlight,
      supabaseLoadStartedAt,
      supabaseLoadToken,
      normalizedReadModeActive,
      pendingLocalChanges,
      lastCloudSaveAt,
      lastCloudSyncAt,
      lastJsonMirrorSaveAt,
      lastLocalSaveAt,
      lastSyncError
    },
    workspaceSession: getWorkspaceSessionSnapshot(),
    workspaceResolution: updateWorkspaceResolutionDebug(lastWorkspaceResolution.decision || "observed", lastWorkspaceResolution.detail || "Current workspace resolution snapshot exported.", { reason: "load-report" }),
    workspaceMembershipProbe: workspaceMembershipProbeStatus,
    vehicleLookupReadiness: getVehicleLookupReadinessSnapshot(),
    summary,
    events: getSupabaseLoadEvents(30 * 60 * 1000),
    dataIoDiagnostics: latestDataIoDiagnostics(30),
    dataIoOperations: latestDataIoOperations(30),
    latestDataIoDiagnostic: latestDataIoDiagnostic(),
    latestOptionalAdminDataIoDiagnostic: latestDataIoDiagnostic({ includeOptionalAdminAudit: true }),
    latestDataIoOperation: latestDataIoOperation(),
    normalizedTableStatus,
    supabaseSecurityStatus,
    renderAdminHealthStatus
  };
}

function normalizeOwnerActivityGroupKey(row = {}) {
  return [row.action || row.route || "activity", row.actor_email || "unknown", row.workspace_label || row.ledger_id || "unknown"].join("|");
}

function summarizeOwnerActivityRows(rows = []) {
  const summaryByKey = new Map();
  rows.forEach((row) => {
    const key = normalizeOwnerActivityGroupKey(row);
    const existing = summaryByKey.get(key) || {
      action: ownerActivityFriendlyAction(row.action || row.route || "activity"),
      actor: row.actor_email || "unknown user",
      workspace: row.workspace_label || row.ledger_id || "unknown workspace",
      ok: 0,
      issues: 0,
      count: 0,
      latestAt: row.created_at || "",
      latestSummary: row.summary || row.route || ""
    };
    existing.count += 1;
    if (row.ok === true) existing.ok += 1;
    else existing.issues += 1;
    if (!existing.latestAt || Date.parse(row.created_at || "") > Date.parse(existing.latestAt || "")) {
      existing.latestAt = row.created_at || existing.latestAt;
      existing.latestSummary = row.summary || row.route || existing.latestSummary;
    }
    summaryByKey.set(key, existing);
  });
  return Array.from(summaryByKey.values()).sort((a, b) => Date.parse(b.latestAt || "") - Date.parse(a.latestAt || ""));
}

function formatOwnerActivitySummaryRow(row = {}) {
  const time = row.latestAt ? new Date(row.latestAt).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--";
  const status = row.issues ? `${row.issues} issue${row.issues === 1 ? "" : "s"}` : "OK";
  const statusClass = row.issues ? "failed" : "ok";
  const countText = `${row.count} event${row.count === 1 ? "" : "s"}`;
  return `<article class="admin-operation-row compact ${statusClass}"><div><strong>${escapeHtml(row.action)}</strong><small>${escapeHtml(row.actor)} · ${escapeHtml(row.workspace)}</small><small>${escapeHtml(countText)}${row.latestSummary ? ` · ${escapeHtml(row.latestSummary)}` : ""}</small></div><span>${escapeHtml(status)}</span><small>${escapeHtml(time)}</small></article>`;
}

function formatOwnerActivityRow(row = {}) {
  const time = row.created_at ? new Date(row.created_at).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--";
  const workspace = row.workspace_label || row.ledger_id || "unknown workspace";
  const actor = row.actor_email || "unknown user";
  const status = row.ok === true ? "OK" : "Issue";
  const action = ownerActivityFriendlyAction(row.action || row.route || "activity");
  const code = row.result_code ? ` · ${row.result_code}` : "";
  const duration = Number.isFinite(Number(row.duration_ms)) && Number(row.duration_ms) > 0 ? ` · ${formatDurationMs(Number(row.duration_ms))}` : "";
  const summary = row.summary || row.route || "";
  return `<article class="admin-operation-row compact ${row.ok === true ? "ok" : "failed"}"><div><strong>${escapeHtml(action)}</strong><small>${escapeHtml(actor)} · ${escapeHtml(workspace)}${code}</small>${summary ? `<small>${escapeHtml(summary)}</small>` : ""}</div><span>${escapeHtml(status)}</span><small>${escapeHtml(time)}${escapeHtml(duration)}</small></article>`;
}

function ownerActivityLoadedWorkspaceId() {
  const context = buildDataIoWorkspaceContext();
  return context.loadedWorkspaceId || getActiveLedgerId();
}

function ownerActivityVisibleRows(rows = []) {
  if (ownerActivityScope === "all") return rows;
  const currentWorkspaceId = ownerActivityLoadedWorkspaceId();
  return rows.filter((row) => String(row.ledger_id || "") === String(currentWorkspaceId || ""));
}

function ownerActivityWorkspaceGroups(rows = []) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.ledger_id || row.workspace_label || "unknown";
    const group = groups.get(key) || {
      workspace: row.workspace_label || row.ledger_id || "unknown workspace",
      ledgerId: row.ledger_id || "",
      count: 0,
      users: new Map(),
      latestAt: row.created_at || ""
    };
    group.count += 1;
    const actor = row.actor_email || "unknown user";
    group.users.set(actor, (group.users.get(actor) || 0) + 1);
    if (!group.latestAt || Date.parse(row.created_at || "") > Date.parse(group.latestAt || "")) group.latestAt = row.created_at || group.latestAt;
    groups.set(key, group);
  });
  return Array.from(groups.values()).sort((a, b) => Date.parse(b.latestAt || "") - Date.parse(a.latestAt || ""));
}

function renderOwnerActivityScopeControls() {
  const currentActive = ownerActivityScope !== "all";
  const allActive = ownerActivityScope === "all";
  return `<div class="segmented-control owner-activity-scope" role="group" aria-label="Owner activity scope">
    <button type="button" class="secondary small-button ${currentActive ? "active" : ""}" data-owner-activity-scope="current">Current workspace</button>
    <button type="button" class="secondary small-button ${allActive ? "active" : ""}" data-owner-activity-scope="all">All workspaces</button>
  </div>`;
}

function renderOwnerActivityWorkspaceOverview(rows = []) {
  const groups = ownerActivityWorkspaceGroups(rows);
  if (!groups.length) return "";
  return `<div class="owner-activity-workspace-grid">${groups.map((group) => {
    const users = Array.from(group.users.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([actor, count]) => `${actor} ×${count}`).join(" · ");
    return `<article class="admin-operation-row compact ok"><div><strong>${escapeHtml(group.workspace)}</strong><small>${escapeHtml(group.count)} event${group.count === 1 ? "" : "s"}${users ? ` · ${escapeHtml(users)}` : ""}</small></div><span>Workspace</span></article>`;
  }).join("")}</div>`;
}


function formatOwnerActivityCooldownMessage(now = Date.now()) {
  const remainingMs = Math.max(0, ownerActivityCooldownUntil - now);
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Owner activity is paused for ${remainingSeconds}s after repeated Render timeouts. Core app data is still loaded.`;
}

function recordOwnerActivityCooldownSkip(reason = "background") {
  const now = Date.now();
  if (now - lastOwnerActivityCooldownDiagnosticAt < 60000) return;
  lastOwnerActivityCooldownDiagnosticAt = now;
  const skippedContext = buildDataIoWorkspaceContext();
  recordDataIoDiagnostic("skipped", {
    source: "owner-activity",
    route: "render-api",
    endpoint: renderOwnerActivityUrl,
    operation: "load",
    operationId: createDataIoOperationId("owner-activity", "cooldown"),
    ledgerId: skippedContext.loadedWorkspaceId,
    selectedWorkspaceId: skippedContext.selectedWorkspaceId,
    selectedWorkspaceLabel: skippedContext.selectedWorkspaceLabel,
    loadedWorkspaceId: skippedContext.loadedWorkspaceId,
    loadedWorkspaceLabel: skippedContext.loadedWorkspaceLabel,
    workspaceMismatch: skippedContext.workspaceMismatch,
    ok: true,
    resultCode: "OWNER_ACTIVITY_COOLDOWN",
    detail: `Owner activity refresh skipped during timeout cooldown (${reason}).`,
    staleAfterMs: dataIoOperationStaleMs
  });
}

function applyOwnerActivityTimeoutCooldown() {
  ownerActivityConsecutiveTimeouts += 1;
  lastOwnerActivityTimeoutAt = Date.now();
  const multiplier = Math.min(ownerActivityConsecutiveTimeouts, 3);
  const cooldownMs = Math.min(ownerActivityTimeoutCooldownBaseMs * multiplier, ownerActivityTimeoutCooldownMaxMs);
  ownerActivityCooldownUntil = lastOwnerActivityTimeoutAt + cooldownMs;
  return cooldownMs;
}

function clearOwnerActivityTimeoutCooldown() {
  ownerActivityConsecutiveTimeouts = 0;
  ownerActivityCooldownUntil = 0;
  lastOwnerActivityTimeoutAt = 0;
  ownerActivityAutoPausedUntilManual = false;
}

function markOptionalAdminPanelsReadyForManualRefresh(reason = "admin-open") {
  // Opening Admin should not fire optional network panels that can become red global noise.
  // Core ledger data is already loaded through /api/state/load; workspace/invite lists and
  // owner audit rows are useful admin panels, but they are safe to refresh manually.
  ownerActivityInitialAdminLoadAttempted = true;
  if (ownerActivityStatus && !ownerActivityStatus.checked) {
    ownerActivityStatus.loading = false;
    ownerActivityStatus.message = "Manual refresh";
  }
  return Promise.resolve({ ok: true, reason });
}

function maybeLoadOwnerActivityOnAdminOpen() {
  return markOptionalAdminPanelsReadyForManualRefresh("admin-tab-open");
}

function maybeRefreshOwnerActivityAfterMemberAction({ reason = "member-action", success = true } = {}) {
  if (!success) return Promise.resolve(ownerActivityStatus);
  // Owner Activity is a global app-owner audit log, not a per-action live status feed.
  // Other users and other workspaces may be active at the same time; do not auto-refresh
  // the audit log after normal member actions because that makes ordinary multi-user use
  // look like current-workspace churn. The app owner can refresh it manually when needed.
  recordOwnerActivityCooldownSkip(`${reason}-manual-audit`);
  return Promise.resolve(ownerActivityStatus);
}

function renderOwnerActivityCard() {
  const status = ownerActivityStatus || {};
  const allRows = Array.isArray(status.rows) ? status.rows : [];
  const visibleRows = ownerActivityVisibleRows(allRows);
  const summaryRows = summarizeOwnerActivityRows(visibleRows).slice(0, ownerActivityVisibleRowLimit);
  const recentRows = visibleRows.slice(0, ownerActivityVisibleRowLimit);
  const hiddenCount = Math.max(0, visibleRows.length - recentRows.length);
  const coolingDown = Date.now() < (ownerActivityCooldownUntil || 0);
  const manuallyPaused = ownerActivityAutoPausedUntilManual || status.manualPaused;
  const cardClass = status.loading || coolingDown || manuallyPaused ? "warning" : status.checked ? (status.ok ? "ok" : "issue") : "warning";
  const title = status.loading ? "Loading" : manuallyPaused ? "Manual refresh" : coolingDown ? "Paused" : status.checked ? (status.ok ? `${visibleRows.length} shown` : "Needs review") : "Not loaded";
  const detail = manuallyPaused
    ? "Owner activity auto-refresh is paused. Use Refresh owner activity when you need this optional audit view; core ledger data is still loaded."
    : coolingDown ? formatOwnerActivityCooldownMessage() : status.message || "Global app-owner audit across users and workspaces. This is not the current workspace state.";
  return `
    <article class="admin-metric-card ${cardClass}">
      <span>Owner activity · global audit</span>
      <strong>${escapeHtml(title)}</strong>
      <small>${ownerActivityScope === "all" ? "All workspaces" : "Current workspace only"} · optional admin view</small>
      <p>${escapeHtml(detail)}</p>
      ${renderOwnerActivityScopeControls()}
      <button type="button" class="secondary small-button" data-owner-activity-refresh ${ownerActivityFetchInFlight || status.loading ? "disabled aria-disabled=\"true\"" : ""}>${ownerActivityFetchInFlight || status.loading ? "Refreshing owner activity…" : "Refresh owner activity"}</button>
    </article>
    ${summaryRows.length ? `
      <details class="admin-diagnostics-section owner-activity-section">
        <summary>Owner activity summary <span class="entry-meta">${escapeHtml(summaryRows.length)} grouped · ${escapeHtml(visibleRows.length)} shown · ${escapeHtml(allRows.length)} total${hiddenCount ? ` · ${hiddenCount} hidden` : ""}</span></summary>
        <p class="entry-meta">Rows from other workspaces are normal when viewing all workspaces. They do not change the currently loaded workspace.</p>
        ${renderOwnerActivityWorkspaceOverview(visibleRows)}
        <div class="admin-operation-list compact-list">
          ${summaryRows.map(formatOwnerActivitySummaryRow).join("")}
        </div>
        <details class="admin-nested-details">
          <summary>Show latest raw owner activity rows</summary>
          <div class="admin-operation-list compact-list owner-activity-raw-list">
            ${recentRows.map(formatOwnerActivityRow).join("")}
          </div>
        </details>
      </details>
    ` : ""}
  `;
}

async function refreshOwnerActivity({ force = false, silent = true, bypassCooldown = false, reason = "background" } = {}) {
  if (!canUseGlobalAdminTools()) return ownerActivityStatus;
  const now = Date.now();
  if (!force && ownerActivityAutoPausedUntilManual) {
    ownerActivityStatus = {
      ...ownerActivityStatus,
      checked: true,
      ok: false,
      loading: false,
      manualPaused: true,
      message: "Owner activity auto-refresh is paused after a timeout. Use Refresh owner activity to try again.",
      checkedAt: new Date().toISOString()
    };
    recordOwnerActivityCooldownSkip(`${reason}-manual-pause`);
    return ownerActivityStatus;
  }
  if (!bypassCooldown && now < ownerActivityCooldownUntil) {
    ownerActivityStatus = {
      ...ownerActivityStatus,
      checked: true,
      ok: false,
      loading: false,
      coolingDown: true,
      cooldownUntil: new Date(ownerActivityCooldownUntil).toISOString(),
      message: formatOwnerActivityCooldownMessage(now),
      checkedAt: new Date().toISOString()
    };
    recordOwnerActivityCooldownSkip(reason);
    if (!silent) setDataToolsMessage(ownerActivityStatus.message);
    return ownerActivityStatus;
  }
  if (ownerActivityFetchInFlight) {
    const ageMs = now - (ownerActivityFetchStartedAt || now);
    if (ageMs > dataIoOperationStaleMs) {
      if (ownerActivityInFlightTraceMeta) {
        recordDataIoDiagnostic("timeout", {
          ...ownerActivityInFlightTraceMeta,
          ok: false,
          detail: "Owner activity refresh timed out before a finish row was recorded.",
          resultCode: "OWNER_ACTIVITY_TIMEOUT",
          errorCode: "OWNER_ACTIVITY_TIMEOUT"
        });
      }
      ownerActivityFetchInFlight = false;
      ownerActivityFetchStartedAt = 0;
      ownerActivityInFlightTraceMeta = null;
    } else {
      ownerActivityStatus = {
        ...ownerActivityStatus,
        loading: true,
        message: "Owner activity refresh is already running."
      };
      return ownerActivityStatus;
    }
  }
  if (!force && ownerActivityStatus.checked && now - lastOwnerActivityFetchAt < ownerActivityFreshMs) return ownerActivityStatus;
  ownerActivityFetchInFlight = true;
  ownerActivityFetchStartedAt = Date.now();
  ownerActivityStatus = { ...ownerActivityStatus, loading: true, message: "Loading server-owned owner activity..." };
  if (!silent) setDataToolsMessage(ownerActivityStatus.message);
  renderSupabaseLoadMonitor();
  const operationId = createDataIoOperationId("owner-activity");
  const ownerActivityWorkspaceContext = buildDataIoWorkspaceContext();
  const traceMeta = {
    source: "owner-activity",
    route: "render-api",
    endpoint: renderOwnerActivityUrl,
    operation: "load",
    operationId,
    ledgerId: ownerActivityWorkspaceContext.loadedWorkspaceId,
    selectedWorkspaceId: ownerActivityWorkspaceContext.selectedWorkspaceId,
    selectedWorkspaceLabel: ownerActivityWorkspaceContext.selectedWorkspaceLabel,
    loadedWorkspaceId: ownerActivityWorkspaceContext.loadedWorkspaceId,
    loadedWorkspaceLabel: ownerActivityWorkspaceContext.loadedWorkspaceLabel,
    workspaceMismatch: ownerActivityWorkspaceContext.workspaceMismatch,
    staleAfterMs: dataIoOperationStaleMs
  };
  ownerActivityInFlightTraceMeta = traceMeta;
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, detail: ownerActivityWorkspaceContext.workspaceMismatch ? "Load owner activity (workspace selector differs from loaded workspace)" : "Load owner activity" });
  try {
    const { result } = await callRenderJson(renderOwnerActivityUrl, {
      method: "POST",
      body: ownerActivityScope === "all" ? { limit: 120 } : { limit: 120, ledgerId: ownerActivityLoadedWorkspaceId() },
      timeoutMs: 10000,
      timeoutLabel: "Owner activity load"
    });
    const rows = Array.isArray(result.activity) ? result.activity : [];
    clearOwnerActivityTimeoutCooldown();
    ownerActivityStatus = {
      checked: true,
      ok: true,
      loading: false,
      coolingDown: false,
      cooldownUntil: "",
      message: rows.length ? `Loaded ${rows.length} server-owned activity row${rows.length === 1 ? "" : "s"}${ownerActivityScope === "all" ? " across all workspaces" : " for the current workspace"}.` : `No server-owned owner activity rows yet${ownerActivityScope === "all" ? "" : " for the current workspace"}.`,
      rows,
      checkedAt: new Date().toISOString()
    };
    lastOwnerActivityFetchAt = Date.now();
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, detail: ownerActivityStatus.message, resultCode: "OWNER_ACTIVITY_LOADED" });
    if (!silent) setDataToolsMessage(ownerActivityStatus.message);
  } catch (error) {
    const timedOut = /timeout|timed out|AbortError|PaymentActionTimeoutError/i.test(String(error?.code || error?.name || error?.message || error || ""));
    if (timedOut) {
      applyOwnerActivityTimeoutCooldown();
      ownerActivityAutoPausedUntilManual = true;
    }
    ownerActivityStatus = {
      checked: true,
      ok: false,
      loading: false,
      coolingDown: timedOut,
      cooldownUntil: timedOut && ownerActivityCooldownUntil ? new Date(ownerActivityCooldownUntil).toISOString() : "",
      message: timedOut ? formatOwnerActivityCooldownMessage() : `Owner activity failed: ${error.message || error}`,
      rows: ownerActivityStatus.rows || [],
      checkedAt: new Date().toISOString()
    };
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", { ...traceMeta, ok: false, error, detail: ownerActivityStatus.message, resultCode: timedOut ? "OWNER_ACTIVITY_TIMEOUT" : "OWNER_ACTIVITY_ERROR", errorCode: error?.code || error?.status || "" });
    if (!silent) setDataToolsMessage(ownerActivityStatus.message);
  } finally {
    ownerActivityFetchInFlight = false;
    ownerActivityFetchStartedAt = 0;
    ownerActivityInFlightTraceMeta = null;
    renderSupabaseLoadMonitor();
  }
  return ownerActivityStatus;
}

async function checkRenderAdminHealth({ silent = false } = {}) {
  if (!canUseGlobalAdminTools()) return renderAdminHealthStatus;
  if (typeof fetch !== "function") {
    renderAdminHealthStatus = {
      checked: true,
      ok: false,
      loading: false,
      message: "Render admin health requires browser fetch support.",
      checks: []
    };
    if (!silent) setDataToolsMessage(renderAdminHealthStatus.message);
    renderSupabaseLoadMonitor();
    return renderAdminHealthStatus;
  }
  const ledgerId = getActiveLedgerId();
  const operationId = createDataIoOperationId("admin-render-health");
  const traceMeta = { source: "admin-render-health", route: "render-api", endpoint: renderAdminHealthUrl, operation: "health", operationId, ledgerId };
  renderAdminHealthStatus = { ...renderAdminHealthStatus, loading: true, message: "Checking Render admin backend..." };
  renderSupabaseLoadMonitor();
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, detail: "Render admin health" });
    const { result } = await callRenderJson(renderAdminHealthUrl, {
      method: "POST",
      body: { ledgerId },
      timeoutMs: 12000,
      timeoutLabel: "Render admin health API",
      allowResultOkFalse: true
    });
    const checks = Array.isArray(result.checks) ? result.checks : [];
    renderAdminHealthStatus = {
      checked: true,
      ok: result.ok === true,
      loading: false,
      mode: "render",
      checkedAt: result.checkedAt || new Date().toISOString(),
      ledgerId: result.ledgerId || ledgerId,
      userEmail: result.userEmail || "",
      message: result.summary || (result.ok ? "Render admin backend is healthy." : "Render admin backend needs review."),
      checks,
      lastHealthyAt: result.ok === true ? (result.checkedAt || new Date().toISOString()) : renderAdminHealthStatus.lastHealthyAt || "",
      staleHealthy: false,
      lastAttemptFailed: false
    };
    recordDataIoDiagnostic(result.ok ? "success" : "error", { ...traceMeta, ok: result.ok === true, detail: result.summary || "Render admin health completed" });
    recordSupabaseLoadEvent("render-admin-health", result.ok ? "Render admin health ok" : "Render admin health needs review");
    if (!silent) setDataToolsMessage(result.ok ? "Render admin health is green." : "Render admin health needs review.");
  } catch (error) {
    if (error?.code === "AUTH_REQUIRED") {
      renderAdminHealthStatus = {
        checked: true,
        ok: false,
        loading: false,
        mode: "session",
        checkedAt: new Date().toISOString(),
        ledgerId,
        message: "Sign in before checking Render admin health.",
        checks: [],
        skipped: true
      };
      recordDataIoDiagnostic("skip", {
        ...traceMeta,
        ok: true,
        code: "AUTH_SESSION_NOT_READY",
        detail: "Skipped Render admin health until Supabase session is ready."
      });
      if (!silent) setDataToolsMessage(renderAdminHealthStatus.message);
      return renderAdminHealthStatus;
    }
    if (isRenderAuthRejected({ status: error?.status }, error?.payload, error?.message)) {
      renderAdminHealthStatus = {
        checked: true,
        ok: false,
        loading: false,
        mode: "session",
        checkedAt: new Date().toISOString(),
        ledgerId,
        message: "Render did not accept the current sign-in yet. Refresh or sign in again before running Render admin health.",
        checks: [],
        skipped: true
      };
      recordDataIoDiagnostic("skip", {
        ...traceMeta,
        ok: true,
        code: "RENDER_AUTH_NOT_READY",
        detail: "Render admin health skipped because the backend did not accept the current session."
      });
      if (!silent) setDataToolsMessage(renderAdminHealthStatus.message);
      return renderAdminHealthStatus;
    }
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError" || /timed out|timeout/i.test(String(error?.message || error || ""));
    const previousHealthy = renderAdminHealthStatus && renderAdminHealthStatus.ok === true;
    const failedAt = new Date().toISOString();
    if (timedOut && previousHealthy) {
      const healthyAt = renderAdminHealthStatus.lastHealthyAt || renderAdminHealthStatus.checkedAt || "";
      renderAdminHealthStatus = {
        ...renderAdminHealthStatus,
        checked: true,
        ok: true,
        loading: false,
        mode: "render",
        checkedAt: healthyAt || renderAdminHealthStatus.checkedAt || failedAt,
        lastFailedAt: failedAt,
        lastAttemptFailed: true,
        staleHealthy: true,
        message: `Latest admin health check timed out after 12s. Last healthy check was ${formatAdminTimestamp(healthyAt)}; core app loading remains healthy.`
      };
    } else {
      renderAdminHealthStatus = {
        checked: true,
        ok: false,
        loading: false,
        mode: "render",
        checkedAt: failedAt,
        ledgerId,
        message: `Render admin health failed: ${error.message || error}`,
        checks: [],
        lastAttemptFailed: true,
        staleHealthy: false
      };
    }
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", { ...traceMeta, error, detail: timedOut && previousHealthy ? "Render admin health timed out after a recent healthy check" : "Render admin health failed" });
    if (!silent) setDataToolsMessage(renderAdminHealthStatus.message);
  } finally {
    renderSupabaseLoadMonitor();
  }
  return renderAdminHealthStatus;
}

function renderRenderAdminHealthCard() {
  const status = renderAdminHealthStatus || {};
  const checks = Array.isArray(status.checks) ? status.checks : [];
  const okCount = checks.filter((check) => check.ok === true).length;
  const issueCount = checks.filter((check) => check.ok === false).length;
  const cardClass = status.loading || status.staleHealthy ? "warning" : status.checked ? (status.ok ? "ok" : "issue") : "warning";
  const title = status.loading ? "Checking" : status.staleHealthy ? "Last OK" : status.checked ? (status.ok ? "OK" : "Needs review") : "Not checked";
  const detail = status.message || "Run the Render admin health check before dangerous admin work.";
  return `
    <article class="admin-metric-card ${cardClass}">
      <span>Render admin health</span>
      <strong>${escapeHtml(title)}</strong>
      <small>${checks.length ? `${okCount} ok${issueCount ? ` · ${issueCount} issue${issueCount === 1 ? "" : "s"}` : ""}` : "Backend safety preflight"}</small>
      <p>${escapeHtml(detail)}</p>
    </article>
    ${checks.length ? `
      <details class="admin-diagnostics-section">
        <summary>Render admin health checks</summary>
        <ul class="test-lab-check-list readable-activity-list">
          ${checks.map((check) => `<li><span class="status-chip ${check.ok ? "paid" : "requested"}">${check.ok ? "OK" : "Issue"}</span> <strong>${escapeHtml(check.label || check.id || "Check")}</strong>${check.route ? ` · <code>${escapeHtml(check.route)}</code>` : ""}${check.detail ? ` — ${escapeHtml(check.detail)}` : ""}</li>`).join("")}
        </ul>
      </details>
    ` : ""}
  `;
}

function renderSupabaseLoadMonitor() {
  if (els.toggleLiveSync) {
    els.toggleLiveSync.textContent = liveSyncEnabled ? "Disable live sync" : "Enable live sync";
  }
  if (!els.supabaseLoadMonitor) return;
  const summary = getSupabaseLoadSummary({ windowMinutes: 10 });
  const latestDataIoOp = latestDataIoOperation();
  const recentDataIoOps = latestDataIoOperations(6);
  const topLabels = Object.entries(summary.byLabel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const latest = summary.latest.slice(0, 8);
  const statusClass = summary.highActivity ? "has-warning" : "";
  const statusText = summary.highActivity
    ? "High app-side Supabase activity detected. Export a load report if Supabase CPU is elevated."
    : summary.coolingDown
      ? "Activity was high earlier in the 5-minute window, but the last minute is cooling down."
      : "No high app-side Supabase activity detected in the last 10 minutes.";
  const activityGroups = latestSupabaseActivityGroups(8);
  const healthySyncLabel = lastCloudSyncAt ? new Date(lastCloudSyncAt).toLocaleString("en-DK", { dateStyle: "short", timeStyle: "short" }) : "Not yet";
  const latestOperationStatus = latestDataIoOp?.status || "idle";
  const activeForeground = foregroundOperationList();
  const foregroundSummary = foregroundOperationSummary();
  els.supabaseLoadMonitor.innerHTML = `
    <div class="admin-diagnostics-dashboard">
      <article class="admin-metric-card ${statusClass}">
        <span>App activity</span>
        <strong>${summary.total}</strong>
        <small>${summary.lastMinute} last minute · ${summary.lastFiveMinutes} last 5 minutes</small>
        <p>${escapeHtml(statusText)}</p>
      </article>
      <article class="admin-metric-card ${supabaseLoadInFlight ? "warning" : "ok"}">
        <span>Cloud load</span>
        <strong>${supabaseLoadInFlight ? "Running" : "Idle"}</strong>
        <small>Last confirmed: ${escapeHtml(healthySyncLabel)}</small>
        <p>${lastSyncDiagnostic ? `${escapeHtml(lastSyncDiagnostic.stage)} — ${escapeHtml(lastSyncDiagnostic.detail || lastSyncDiagnostic.error?.message || "No detail")}` : "No recent sync diagnostic."}</p>
      </article>
      <article class="admin-metric-card ${latestOperationStatus === "failed" || latestOperationStatus === "timeout" ? "issue" : latestOperationStatus === "active" ? "warning" : "ok"}">
        <span>Latest data I/O</span>
        <strong>${escapeHtml(latestOperationStatus)}</strong>
        <small>${latestDataIoOp ? escapeHtml(formatDataIoOperationLine(latestDataIoOp)) : "No operation yet"}</small>
        <p>This card ignores optional Admin panels such as workspace/invite refresh and owner audit refresh; those details stay in their sections below.</p>
      </article>
      ${renderRenderAdminHealthCard()}
      ${canUseGlobalAdminTools() ? renderOwnerActivityCard() : ""}
      <article class="admin-metric-card ${activeForeground.length ? "warning" : "ok"}">
        <span>Foreground save</span>
        <strong>${activeForeground.length ? "Active" : "Idle"}</strong>
        <small>${escapeHtml(foregroundSummary)}</small>
        <p>If Saving is visible, this card must name the operation causing it.</p>
      </article>
      <article class="admin-metric-card ${ledgerEventsChannel ? "ok" : "warning"}">
        <span>Realtime</span>
        <strong>${ledgerEventsChannel ? "Event channel" : "Waiting"}</strong>
        <small>${liveSyncEnabled ? "Broad live sync enabled" : "Broad live sync off"}</small>
        <p>Lightweight ledger events are used for hints; core reads/writes do not depend on realtime.</p>
      </article>
    </div>
    ${recentDataIoOps.length ? renderDataIoGroupedSections() : ""}
    ${topLabels.length ? `
      <details class="admin-diagnostics-section">
        <summary>Activity by type</summary>
        <div class="admin-activity-grid">
          ${topLabels.map(([label, count]) => `<article><span>${escapeHtml(supabaseLoadLabel(label))}</span><strong>${count}</strong></article>`).join("")}
        </div>
      </details>
    ` : `<p class="entry-meta">No tracked Supabase/app-sync activity yet in this browser session.</p>`}
    ${activityGroups.length ? `
      <details class="admin-diagnostics-section">
        <summary>Recent grouped activity</summary>
        <ul class="test-lab-check-list readable-activity-list">
          ${activityGroups.map((group) => `<li><strong>${escapeHtml(new Date(group.lastAt).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</strong> · ${escapeHtml(supabaseLoadLabel(group.label))}${group.detail ? ` — ${escapeHtml(group.detail)}` : ""}${group.count > 1 ? ` <b>×${group.count}</b>` : ""}</li>`).join("")}
        </ul>
      </details>
    ` : ""}
  `;
}


function formatAdminTimestamp(value) {
  if (!value) return "Not yet in this session";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-DK", { dateStyle: "short", timeStyle: "short" });
}

function adminGuardrailStatusCard({ title, status, detail, level = "ok" }) {
  return `
    <article class="admin-guardrail-card ${escapeHtml(level)}">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(status)}</p>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}


function getLatestHealthcheckRpcPayload() {
  const checks = Array.isArray(supabaseSecurityStatus?.checks) ? supabaseSecurityStatus.checks : [];
  const healthcheck = checks.find((check) => check?.rpcHealth || /Fuel Ledger healthcheck RPC is available|Critical write RPCs are installed|close_settlement_period RPC is installed/i.test(check?.name || ""));
  const fromStatus = normalizeHealthcheckRpcPayload(healthcheck?.rpcHealth);
  return fromStatus || latestHealthcheckRpcPayload || null;
}

function getRealtimePublicationDiagnostics() {
  if (!supabaseClient) {
    return {
      status: "Local-only mode",
      detail: "Realtime publication health is checked after signing in to Supabase.",
      level: "ok"
    };
  }
  if (!canManageSettings()) {
    return {
      status: "Admin check required",
      detail: "Realtime publication details are shown after an admin runs Security Health.",
      level: "warning"
    };
  }
  const rpcHealth = getLatestHealthcheckRpcPayload();
  if (!supabaseSecurityStatus?.checked && !rpcHealth) {
    return {
      status: "Not checked yet",
      detail: "Run Security Health to see whether only lightweight ledger_events is published for Realtime.",
      level: "warning"
    };
  }
  const publication = rpcHealth?.realtime_publication;
  if (!publication || typeof publication !== "object") {
    return {
      status: "Legacy healthcheck",
      detail: "Apply the Realtime publication health migration to show published table details.",
      level: "warning"
    };
  }
  const extraTables = Array.isArray(publication.extra_tables) ? publication.extra_tables.filter(Boolean) : [];
  const publishedTables = Array.isArray(publication.tables) ? publication.tables.filter(Boolean) : [];
  if (publication.ledger_events_enabled === false) {
    return {
      status: "ledger_events missing",
      detail: "Add public.ledger_events to supabase_realtime so lightweight sync can notify clients without broad table subscriptions.",
      level: "warning"
    };
  }
  if (extraTables.length) {
    return {
      status: `${extraTables.length} extra table${extraTables.length === 1 ? "" : "s"} published`,
      detail: `Consider removing broad Realtime publication for: ${extraTables.join(", ")}. Keep public.ledger_events published.`,
      level: "warning"
    };
  }
  return {
    status: "Narrow publication",
    detail: publishedTables.length
      ? `Realtime publication is limited to ${publishedTables.join(", ")}.`
      : "No public app tables are currently published for Realtime; enable public.ledger_events for lightweight notifications.",
    level: publishedTables.includes("public.ledger_events") ? "ok" : "warning"
  };
}


function getSchemaMigrationDiagnostics() {
  if (!supabaseClient) {
    return {
      status: "Local-only mode",
      detail: "Migration tracking is checked after signing in to Supabase.",
      level: "ok"
    };
  }
  if (!canManageSettings()) {
    return {
      status: "Admin check required",
      detail: "Migration status is shown after an admin runs Security Health.",
      level: "warning"
    };
  }
  const rpcHealth = getLatestHealthcheckRpcPayload();
  if (!supabaseSecurityStatus?.checked && !rpcHealth) {
    return {
      status: "Not checked yet",
      detail: "Run Security Health to confirm every Supabase migration has been applied.",
      level: "warning"
    };
  }
  const migrations = rpcHealth?.schema_migrations && typeof rpcHealth.schema_migrations === "object"
    ? rpcHealth.schema_migrations
    : null;
  if (!migrations) {
    return {
      status: "Legacy healthcheck",
      detail: "Apply the schema migration tracking migration to show missing migration IDs here.",
      level: "warning"
    };
  }
  const missing = Array.isArray(migrations.missing_migrations) ? migrations.missing_migrations.filter(Boolean) : [];
  const futureTracked = Array.isArray(migrations.extra_migrations) ? migrations.extra_migrations.filter(Boolean) : [];
  if (missing.length) {
    return {
      status: `${missing.length} migration${missing.length === 1 ? "" : "s"} missing`,
      detail: `Run missing migration${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      level: "warning"
    };
  }
  const latestApplied = migrations.latest_applied || "unknown";
  const latestExpected = migrations.latest_expected || "unknown";
  return {
    status: "Migrations current",
    detail: latestApplied === latestExpected
      ? `Current through ${latestApplied}.`
      : `Applied ${latestApplied}; expected ${latestExpected}${futureTracked.length ? ` · future tracked: ${futureTracked.join(", ")}` : ""}.`,
    level: "ok"
  };
}

function getSchemaDriftDiagnostics() {
  if (!supabaseClient) {
    return {
      status: "Local-only mode",
      detail: "Schema shape is checked after signing in to Supabase.",
      level: "ok"
    };
  }
  if (!canManageSettings()) {
    return {
      status: "Admin check required",
      detail: "Schema drift details are shown after an admin runs Security Health.",
      level: "warning"
    };
  }
  const rpcHealth = getLatestHealthcheckRpcPayload();
  if (!supabaseSecurityStatus?.checked && !rpcHealth) {
    return {
      status: "Not checked yet",
      detail: "Run Security Health to inspect expected tables, columns, and key policies.",
      level: "warning"
    };
  }
  const drift = rpcHealth?.schema_drift && typeof rpcHealth.schema_drift === "object" ? rpcHealth.schema_drift : null;
  if (!drift) {
    return {
      status: "Legacy healthcheck",
      detail: "Apply the schema drift healthcheck migration to show table, column, and policy drift here.",
      level: "warning"
    };
  }
  const missingTables = Array.isArray(drift.missing_tables) ? drift.missing_tables.filter(Boolean) : [];
  const missingColumns = Array.isArray(drift.missing_columns) ? drift.missing_columns.filter(Boolean) : [];
  const missingPolicies = Array.isArray(drift.missing_policies) ? drift.missing_policies.filter(Boolean) : [];
  const issues = [...missingTables, ...missingColumns, ...missingPolicies];
  if (issues.length) {
    return {
      status: `${issues.length} schema item${issues.length === 1 ? "" : "s"} missing`,
      detail: `Missing: ${issues.slice(0, 5).join(", ")}${issues.length > 5 ? `, and ${issues.length - 5} more` : ""}.`,
      level: "warning"
    };
  }
  return {
    status: "Schema shape OK",
    detail: "Expected tables, columns, and key RLS policies were found by Security Health.",
    level: "ok"
  };
}

function getPublicLaunchReadinessDiagnostics() {
  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const publicLaunchRisks = [];
  if (ledgerId === "main-car") {
    publicLaunchRisks.push("shared main-car ledger");
  }
  if (!supabaseClient) {
    return {
      status: "Local/private only",
      detail: "Public launch readiness is checked after Supabase is configured.",
      level: "warning"
    };
  }
  const rpcHealth = getLatestHealthcheckRpcPayload();
  const workspaceReadiness = rpcHealth?.workspace_readiness && typeof rpcHealth.workspace_readiness === "object"
    ? rpcHealth.workspace_readiness
    : null;
  if (!workspaceReadiness?.abuse_rate_limit_ready) {
    publicLaunchRisks.push("workspace/invite abuse rate-limit migration not confirmed");
  }
  publicLaunchRisks.push("invite-only onboarding still needs real-user testing");
  publicLaunchRisks.push("no public signup rate-limit dashboard yet");
  return {
    status: "Private beta only",
    detail: `Do not advertise broadly yet: ${publicLaunchRisks.join(", ")}. Keep public signup off until workspace/invite onboarding, rate-limit monitoring, and abuse review are proven under real traffic.`,
    level: "warning"
  };
}

function getAdminHealthSummary({ rpcDiagnostics, realtimePublicationDiagnostics, schemaMigrationDiagnostics, schemaDriftDiagnostics, publicLaunchReadinessDiagnostics, normalizedStatus }) {
  const warningTitles = [];
  if (normalizedTableStatus?.checked && !normalizedTableStatus.ok) warningTitles.push("table health");
  if (rpcDiagnostics.level !== "ok") warningTitles.push("RPC availability");
  if (schemaMigrationDiagnostics.level !== "ok") warningTitles.push("migration tracking");
  if (schemaDriftDiagnostics.level !== "ok") warningTitles.push("schema drift");
  if (realtimePublicationDiagnostics.level !== "ok") warningTitles.push("Realtime publication");
  if (publicLaunchReadinessDiagnostics.level !== "ok") warningTitles.push("public launch readiness");
  if (pendingLocalChanges > 0 || lastSyncError) warningTitles.push("sync state");
  if (!warningTitles.length && normalizedStatus === "Healthy") {
    return {
      status: "All core checks look healthy",
      detail: "Cloud tables, RPCs, migrations, schema shape, sync state, backup guardrails, and launch readiness are green from the latest available checks.",
      level: "ok"
    };
  }
  if (!supabaseSecurityStatus?.checked && supabaseClient && canUseGlobalAdminTools()) {
    return {
      status: "Run Security Health for a fresh read",
      detail: "The summary updates after live Supabase health checks finish.",
      level: "warning"
    };
  }
  return {
    status: "Needs review",
    detail: `Check ${warningTitles.join(", ")} before using destructive admin tools.`,
    level: "warning"
  };
}

function getRpcAvailabilityDiagnostics() {
  if (!supabaseClient) {
    return {
      status: "Local-only mode",
      detail: "RPC availability is checked after signing in to Supabase.",
      level: "ok"
    };
  }
  if (!canManageSettings()) {
    return {
      status: "Admin check required",
      detail: "Critical RPC probes are shown after an admin runs Security Health.",
      level: "warning"
    };
  }
  const checks = Array.isArray(supabaseSecurityStatus?.checks) ? supabaseSecurityStatus.checks : [];
  const healthcheck = checks.find((check) => check?.rpcHealth || /Fuel Ledger healthcheck RPC is available|Critical write RPCs are installed|close_settlement_period RPC is installed/i.test(check?.name || ""));
  const rpcHealth = normalizeHealthcheckRpcPayload(healthcheck?.rpcHealth) || latestHealthcheckRpcPayload;
  if (!supabaseSecurityStatus?.checked && !rpcHealth) {
    return {
      status: "Not checked yet",
      detail: "Run Security Health to verify trip, fuel, booking, member, purge, reset, and retention RPC availability.",
      level: "warning"
    };
  }
  const criticalRpcs = rpcHealth && typeof rpcHealth === "object" && rpcHealth.critical_rpcs && typeof rpcHealth.critical_rpcs === "object"
    ? rpcHealth.critical_rpcs
    : null;
  if (!criticalRpcs) {
    return {
      status: healthcheck && healthcheck.ok ? "Legacy healthcheck passed" : "Needs review",
      detail: healthcheck && healthcheck.ok
        ? "Apply the RPC health visibility migration to show all critical RPCs before relying on production write/admin tools."
        : (healthcheck?.detail || "Security Health reported an RPC issue."),
      level: "warning"
    };
  }
  const missing = Object.entries(criticalRpcs)
    .filter(([, exists]) => exists !== true)
    .map(([name]) => name);
  if (missing.length) {
    return {
      status: `${missing.length} RPC${missing.length === 1 ? "" : "s"} missing`,
      detail: `Missing: ${missing.join(", ")}. Apply the latest Supabase schema before using production write/admin tools.`,
      level: "warning"
    };
  }
  return {
    status: "All critical RPCs available",
    detail: `${Object.keys(criticalRpcs).length} RPC-backed write/admin paths verified by Security Health.`,
    level: "ok"
  };
}

function renderAdminGuardrailOverview() {
  if (!els.adminGuardrailOverview) return;
  const build = window.FUEL_LEDGER_BUILD || {};
  const realtimeDetail = document.hidden
    ? "Tab is hidden; realtime is paused/resumed by visibility guardrails."
    : liveSyncEnabled
      ? "Broad Live Sync is enabled; hidden tabs pause it after the safety delay."
      : "Broad Live Sync is off by default; lightweight ledger events handle notifications.";
  const normalizedStatus = normalizedTableStatus?.checked
    ? (normalizedTableStatus.ok ? "Healthy" : "Needs review")
    : "Not checked yet";
  const latestBackupDetail = lastAdminSafetyBackup
    ? `Fresh destructive-action backup: ${formatAdminTimestamp(lastAdminSafetyBackup.iso)} for ${lastAdminSafetyBackup.reason}${lastAdminSafetyBackup.cloud ? " · cloud mirrored" : " · local export"}`
    : "No destructive-action backup has run in this session.";
  const backupDetail = lastJsonMirrorSaveAt
    ? `${latestBackupDetail}. Last JSON safety backup: ${formatAdminTimestamp(lastJsonMirrorSaveAt)}. Fresh backup required immediately before destructive actions.`
    : `${latestBackupDetail}. Safety backups run before destructive admin actions and manual backup saves.`;
  const pendingDetail = pendingLocalChanges > 0
    ? `${pendingLocalChanges} pending local change${pendingLocalChanges === 1 ? "" : "s"}; sync before destructive tools.`
    : `Last confirmed sync: ${formatAdminTimestamp(lastCloudSyncAt || lastCloudSaveAt)}`;
  const rpcDiagnostics = getRpcAvailabilityDiagnostics();
  const realtimePublicationDiagnostics = getRealtimePublicationDiagnostics();
  const schemaMigrationDiagnostics = getSchemaMigrationDiagnostics();
  const schemaDriftDiagnostics = getSchemaDriftDiagnostics();
  const publicLaunchReadinessDiagnostics = getPublicLaunchReadinessDiagnostics();
  const healthSummary = getAdminHealthSummary({
    rpcDiagnostics,
    realtimePublicationDiagnostics,
    schemaMigrationDiagnostics,
    schemaDriftDiagnostics,
    publicLaunchReadinessDiagnostics,
    normalizedStatus
  });

  els.adminGuardrailOverview.innerHTML = `
    <div class="admin-guardrail-grid" data-admin-diagnostics-overview="true">
      ${adminGuardrailStatusCard({
        title: "Overall health",
        status: healthSummary.status,
        detail: healthSummary.detail,
        level: healthSummary.level
      })}
      ${adminGuardrailStatusCard({
        title: "Release",
        status: build.version ? `${build.version} · ${build.buildLabel || "unlabeled"}` : "Build info unavailable",
        detail: build.expectedServiceWorkerCache ? `Expected cache: ${build.expectedServiceWorkerCache}` : "Refresh version status if this looks stale.",
        level: build.version ? "ok" : "warning"
      })}
      ${adminGuardrailStatusCard({
        title: "Realtime",
        status: liveSyncEnabled ? "Live Sync enabled" : "Live Sync off by default",
        detail: realtimeDetail,
        level: liveSyncEnabled ? "warning" : "ok"
      })}
      ${adminGuardrailStatusCard({
        title: "Table health",
        status: normalizedStatus,
        detail: normalizedTableStatus?.message || "Normalized tables are primary; JSON is a safety mirror.",
        level: normalizedTableStatus?.checked && normalizedTableStatus?.ok ? "ok" : "warning"
      })}
      ${adminGuardrailStatusCard({
        title: "RPC availability",
        status: rpcDiagnostics.status,
        detail: rpcDiagnostics.detail,
        level: rpcDiagnostics.level
      })}
      ${adminGuardrailStatusCard({
        title: "Migrations",
        status: schemaMigrationDiagnostics.status,
        detail: schemaMigrationDiagnostics.detail,
        level: schemaMigrationDiagnostics.level
      })}
      ${adminGuardrailStatusCard({
        title: "Schema shape",
        status: schemaDriftDiagnostics.status,
        detail: schemaDriftDiagnostics.detail,
        level: schemaDriftDiagnostics.level
      })}
      ${adminGuardrailStatusCard({
        title: "Realtime publication",
        status: realtimePublicationDiagnostics.status,
        detail: realtimePublicationDiagnostics.detail,
        level: realtimePublicationDiagnostics.level
      })}
      ${adminGuardrailStatusCard({
        title: "Public launch readiness",
        status: publicLaunchReadinessDiagnostics.status,
        detail: publicLaunchReadinessDiagnostics.detail,
        level: publicLaunchReadinessDiagnostics.level
      })}
      ${adminGuardrailStatusCard({
        title: "Backup guardrails",
        status: "Protected destructive actions",
        detail: backupDetail,
        level: lastSyncError ? "warning" : "ok"
      })}
      ${adminGuardrailStatusCard({
        title: "Sync state",
        status: pendingLocalChanges > 0 ? "Pending local changes" : "Ready",
        detail: pendingDetail,
        level: pendingLocalChanges > 0 || lastSyncError ? "warning" : "ok"
      })}
    </div>
  `;
}

function downloadSupabaseLoadReport() {
  const report = redactSensitiveDiagnostics(buildSupabaseLoadReport());
  const stamp = localDateString().replace(/[^0-9-]/g, "") || "today";
  downloadTextFile(`fuel-ledger-supabase-load-report-${stamp}.json`, JSON.stringify(report, null, 2), "application/json");
  setDataToolsMessage("Supabase load report downloaded with privacy redaction applied.");
}


function retentionCutoffIso(days) {
  return new Date(Date.now() - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000).toISOString();
}

function reportRetentionTimestamp(report) {
  const value = report?.syncedAt || report?.finishedAt || report?.startedAt || report?.createdAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildLocalRetentionPreview() {
  const reports = normalizeTestLabReports(state.testLabReports);
  const cutoff = Date.now() - retentionPolicy.testLabReportDays * 24 * 60 * 60 * 1000;
  const removableReports = reports.filter((report, index) => {
    const timestamp = reportRetentionTimestamp(report);
    return index >= retentionPolicy.keepLatestTestLabReports || (timestamp > 0 && timestamp < cutoff);
  });
  const localLoadMonitorCutoff = Date.now() - retentionPolicy.localLoadMonitorEventMinutes * 60 * 1000;
  const oldLoadEvents = getSupabaseLoadEvents(24 * 60 * 60 * 1000).filter((entry) => {
    const timestamp = Date.parse(entry.at || entry.iso || "");
    return Number.isFinite(timestamp) && timestamp < localLoadMonitorCutoff;
  });
  return {
    testLabReports: removableReports.length,
    loadMonitorEvents: oldLoadEvents.length,
    keptTestLabReports: Math.max(0, reports.length - removableReports.length)
  };
}

function applyLocalRetentionCleanup() {
  const reports = normalizeTestLabReports(state.testLabReports);
  const cutoff = Date.now() - retentionPolicy.testLabReportDays * 24 * 60 * 60 * 1000;
  const keptReports = reports.filter((report, index) => {
    const timestamp = reportRetentionTimestamp(report);
    return index < retentionPolicy.keepLatestTestLabReports && !(timestamp > 0 && timestamp < cutoff);
  });
  const removedReports = Math.max(0, reports.length - keptReports.length);
  state.testLabReports = keptReports;
  if (lastTestLabReport && !keptReports.some((report) => report.id === lastTestLabReport.id)) {
    lastTestLabReport = keptReports[0] || null;
  }
  const beforeEvents = (supabaseLoadSafety.requests || []).length;
  const localLoadMonitorCutoff = Date.now() - retentionPolicy.localLoadMonitorEventMinutes * 60 * 1000;
  supabaseLoadSafety.requests = (supabaseLoadSafety.requests || []).filter((entry) => {
    const timestamp = Date.parse(entry.at || entry.iso || "");
    return !Number.isFinite(timestamp) || timestamp >= localLoadMonitorCutoff;
  });
  return {
    testLabReports: removedReports,
    loadMonitorEvents: Math.max(0, beforeEvents - supabaseLoadSafety.requests.length)
  };
}

function buildRetentionBackendPayload() {
  return {
    ledgerId: getActiveLedgerId(),
    eventRetentionDays: retentionPolicy.ledgerEventDays,
    stalePushDays: retentionPolicy.stalePushSubscriptionDays,
    testLabReportDays: retentionPolicy.cloudTestLabReportDays,
    keepLatestTestLabReports: retentionPolicy.keepLatestCloudTestLabReports
  };
}

function normalizeCloudRetentionPreview(data, backend = "supabase-rpc") {
  return {
    available: true,
    ledgerEvents: Number(data?.ledger_events || 0),
    stalePushSubscriptions: Number(data?.global_stale_push_subscriptions || data?.stale_push_subscriptions || 0),
    testLabReports: Number(data?.test_lab_reports || data?.cloud_test_lab_reports || 0),
    keptTestLabReports: Number(data?.kept_test_lab_reports || 0),
    pushSubscriptionScope: data?.push_subscription_scope || "global_user_device_records",
    backend,
    message: backend === "render-api"
      ? "Cloud preview completed through Render. Stale push subscriptions are global user/device records, and old cloud Test Lab reports are pruned while keeping the newest reports."
      : "Cloud preview completed. Stale push subscriptions are global user/device records, and old cloud Test Lab reports are pruned while keeping the newest reports."
  };
}

async function callRetentionAdminRoute({ action, endpoint, operation }) {
  if (!currentSession?.access_token) return { ok: false, shouldFallback: false, error: new Error("Sign in before running Render retention tools.") };
  if (typeof fetch !== "function") return { ok: false, shouldFallback: false, error: new Error("Render retention tools require fetch support.") };
  const payload = buildRetentionBackendPayload();
  if (!payload.ledgerId) return { ok: false, shouldFallback: false, error: new Error("Missing active ledger id for Render retention tools.") };
  const operationId = createDataIoOperationId(`retention-${action}`);
  const traceMeta = { source: `retention-${action}`, route: "render-api", endpoint, operation, operationId, ledgerId: payload.ledgerId };
  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, detail: `Render retention ${action}` });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError(`Render retention ${action} API`, 12000));
      }, 12000);
    });
    const fetchPromise = fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    if (response.ok && result?.ok) {
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true, detail: `Render retention ${action} completed` });
      recordSupabaseLoadEvent(`render-retention-${action}`, `retention ${action} via Render admin route`);
      return { ok: true, result, backend: "render-api" };
    }
    const error = new Error(result?.error || result?.message || text || `Render retention ${action} failed (${response.status})`);
    error.status = response.status;
    recordDataIoDiagnostic("error", {
      ...traceMeta,
      error,
      detail: `HTTP ${response.status}; Render retention ${action} failed. Browser retention RPC fallback is disabled.`
    });
    return { ok: false, shouldFallback: false, error };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", { ...traceMeta, error, detail: `Render retention ${action} failed. Browser retention RPC fallback is disabled.` });
    return { ok: false, shouldFallback: false, error };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function previewRetentionCleanupViaRender() {
  const renderResult = await callRetentionAdminRoute({ action: "preview", endpoint: renderRetentionPreviewUrl, operation: "preview" });
  if (!renderResult.ok) return renderResult;
  return { ok: true, cloud: normalizeCloudRetentionPreview(renderResult.result.preview || {}, "render-api") };
}

async function runRetentionCleanupViaRender() {
  const renderResult = await callRetentionAdminRoute({ action: "cleanup", endpoint: renderRetentionCleanupUrl, operation: "delete" });
  if (!renderResult.ok) return renderResult;
  return { ok: true, cloud: renderResult.result.cleanup || {} };
}

async function fetchRetentionCleanupPreview() {
  const local = buildLocalRetentionPreview();
  const result = {
    local,
    cloud: {
      available: false,
      ledgerEvents: 0,
      stalePushSubscriptions: 0,
      message: "Sign in as admin to preview cloud retention cleanup."
    }
  };
  if (!supabaseClient || !currentSession || !canManageSettings()) return result;

  try {
    const renderPreview = await previewRetentionCleanupViaRender();
    if (renderPreview.ok) {
      result.cloud = renderPreview.cloud;
      return result;
    }
    throw renderPreview.error || new Error("Render retention preview failed.");
  } catch (error) {
    result.cloud = {
      available: false,
      ledgerEvents: 0,
      stalePushSubscriptions: 0,
      message: `Cloud retention preview unavailable: ${error.message || error}`
    };
  }
  return result;
}

function renderRetentionCleanupSummary(preview = lastRetentionCleanupPreview) {
  if (!els.retentionCleanupSummary) return;
  if (!preview) {
    els.retentionCleanupSummary.innerHTML = `<p class="entry-meta">Preview cleanup before deleting temporary/privacy-sensitive records. Real trips, fuel logs, bookings, settlements, and closed periods are never part of this cleanup.</p>`;
    return;
  }
  els.retentionCleanupSummary.innerHTML = `
    <div class="test-lab-report-summary ${preview.cloud?.available === false ? "has-warning" : "ok"}">
      <strong>Retention cleanup preview</strong>
      <p>Deletes only temporary/debug/privacy-sensitive records. Ledger accounting history is kept.</p>
      <ul class="included-fuel-list compact-diagnostics-list">
        <li><span>Old in-app notification events (${retentionPolicy.ledgerEventDays}+ days or expired)</span><b>${Number(preview.cloud?.ledgerEvents || 0)}</b></li>
        <li><span>Global stale push subscriptions (${retentionPolicy.stalePushSubscriptionDays}+ days, user/device scoped)</span><b>${Number(preview.cloud?.stalePushSubscriptions || 0)}</b></li>
        <li><span>Old cloud Test Lab reports (${retentionPolicy.cloudTestLabReportDays}+ days; keeps latest ${retentionPolicy.keepLatestCloudTestLabReports})</span><b>${Number(preview.cloud?.testLabReports || 0)}</b></li>
        <li><span>Old/local Test Lab reports (privacy-pruned; keeps latest ${retentionPolicy.keepLatestTestLabReports})</span><b>${Number(preview.local?.testLabReports || 0)}</b></li>
        <li><span>Old load-monitor events in this browser (${retentionPolicy.localLoadMonitorEventMinutes}+ minutes)</span><b>${Number(preview.local?.loadMonitorEvents || 0)}</b></li>
      </ul>
      <small>${escapeHtml(preview.cloud?.message || "")}</small>
    </div>
  `;
}

async function previewRetentionCleanup() {
  if (!canManageSettings()) return;
  if (els.previewRetentionCleanup) els.previewRetentionCleanup.disabled = true;
  try {
    lastRetentionCleanupPreview = await fetchRetentionCleanupPreview();
    renderRetentionCleanupSummary(lastRetentionCleanupPreview);
    setDataToolsMessage("Retention cleanup preview refreshed.");
  } finally {
    if (els.previewRetentionCleanup) els.previewRetentionCleanup.disabled = false;
  }
}

async function runRetentionCleanup() {
  if (!canManageSettings()) return;
  if (!lastRetentionCleanupPreview) {
    await previewRetentionCleanup();
  }
  const total = Number(lastRetentionCleanupPreview?.cloud?.ledgerEvents || 0)
    + Number(lastRetentionCleanupPreview?.cloud?.stalePushSubscriptions || 0)
    + Number(lastRetentionCleanupPreview?.cloud?.testLabReports || 0)
    + Number(lastRetentionCleanupPreview?.local?.testLabReports || 0)
    + Number(lastRetentionCleanupPreview?.local?.loadMonitorEvents || 0);
  if (!total) {
    setDataToolsMessage("No eligible retention cleanup items found.");
    return;
  }
  if (!requireTypedAdminConfirmation({
    phrase: "CLEAN RETENTION DATA",
    title: "Run retention cleanup?",
    detail: "This deletes old notification events, stale push subscriptions, old cloud/local Test Lab reports, and old local load-monitor entries only. It does not delete trips, fuel logs, bookings, settlements, closed periods, or audit-critical ledger history."
  })) return;

  if (els.runRetentionCleanup) els.runRetentionCleanup.disabled = true;
  try {
    await exportAdminSafetyBackup("retention cleanup");
    assertFreshAdminSafetyBackup("retention cleanup");
    const local = applyLocalRetentionCleanup();
    let cloud = { ledger_events: 0, stale_push_subscriptions: 0, test_lab_reports: 0 };
    if (supabaseClient && currentSession && canManageSettings()) {
      const renderCleanup = await runRetentionCleanupViaRender();
      if (renderCleanup.ok) {
        cloud = renderCleanup.cloud || cloud;
      } else {
        throw renderCleanup.error || new Error("Render retention cleanup failed.");
      }
    }
    writeLocalState();
    render();
    lastRetentionCleanupPreview = await fetchRetentionCleanupPreview();
    renderRetentionCleanupSummary(lastRetentionCleanupPreview);
    setDataToolsMessage(`Retention cleanup complete: removed ${Number(cloud.ledger_events || 0)} old event(s), ${Number(cloud.stale_push_subscriptions || 0)} stale push subscription(s), ${Number(cloud.test_lab_reports || cloud.cloud_test_lab_reports || 0)} cloud Test Lab report(s), ${local.testLabReports} local Test Lab report(s), and ${local.loadMonitorEvents} local load-monitor event(s).`);
  } catch (error) {
    setDataToolsMessage(`Retention cleanup failed: ${error.message || error}`);
  } finally {
    if (els.runRetentionCleanup) els.runRetentionCleanup.disabled = false;
  }
}

function scheduleNormalizedTableCheck({ delayMs = 30000, reason = "scheduled" } = {}) {
  if (!supabaseClient || !currentSession) return;
  if (supabaseLoadSafety.normalizedCheckTimer) return;
  supabaseLoadSafety.normalizedCheckTimer = window.setTimeout(() => {
    supabaseLoadSafety.normalizedCheckTimer = null;
    recordSupabaseLoadEvent("normalized-health-check", reason);
    checkNormalizedTablesAgainstCurrentState({ reason, silent: true }).catch((error) => {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not read normalized tables: ${error.message || error}`
      };
      render();
    });
  }, delayMs);
}

function buildLightweightSecurityHealthStatus(message = "Lightweight security checks completed without backend probes.") {
  const helper = securityHealth || window.FuelSecurityHealth;
  const checks = helper?.buildLocalSecurityChecks ? helper.buildLocalSecurityChecks({
    hasSupabaseConfig,
    hasSession: Boolean(currentSession),
    hasMemberProfile: Boolean(getCurrentMemberProfile()),
    isAdmin: canManageSettings(),
    normalizedTableStatus
  }) : [{ ok: true, name: "Security health helper unavailable", detail: "Backend probes were skipped." }];
  return {
    checked: true,
    ok: !checks.some((check) => !check.ok),
    mode: hasSupabaseConfig ? "lightweight" : "local",
    checkedAt: new Date().toISOString(),
    message,
    checks: [
      ...checks,
      {
        ok: true,
        level: "warning",
        warning: true,
        name: "Deep Supabase backend probe skipped",
        detail: "Skipped during routine Test Lab runs to avoid extra database load. Use Security health directly for a live backend probe."
      }
    ]
  };
}

function createSecurityHealthTimeoutStatus(timeoutMs = 8000) {
  return {
    checked: true,
    ok: true,
    mode: hasSupabaseConfig ? "timeout" : "local",
    checkedAt: new Date().toISOString(),
    message: `Security health backend probes did not finish within ${Math.round(timeoutMs / 1000)} seconds. Treated as a warning/skipped probe; run Security health directly if you want to diagnose the backend probe.`,
    warningCount: 1,
    checks: [{
      ok: true,
      level: "warning",
      warning: true,
      name: "Deep Supabase backend probe timed out",
      detail: `Backend probe timed out after ${Math.round(timeoutMs / 1000)} seconds. Full Test Lab continued; run Security health directly if this repeats.`
    }]
  };
}

async function refreshSupabaseSecurityHealthForTestLab({ timeoutMs = 8000, deep = false, force = false } = {}) {
  if (!deep) {
    supabaseSecurityStatus = buildLightweightSecurityHealthStatus("Routine Test Lab security checks completed; deep backend probe skipped to avoid database load.");
    return supabaseSecurityStatus;
  }

  const now = Date.now();
  if (!force && supabaseSecurityStatus.checked && now - supabaseLoadSafety.lastSecurityHealthAt < supabaseLoadSafety.securityHealthCooldownMs) {
    const remainingSeconds = Math.ceil((supabaseLoadSafety.securityHealthCooldownMs - (now - supabaseLoadSafety.lastSecurityHealthAt)) / 1000);
    return {
      ...supabaseSecurityStatus,
      checks: [
        ...(Array.isArray(supabaseSecurityStatus.checks) ? supabaseSecurityStatus.checks : []),
        {
          ok: true,
          level: "warning",
          warning: true,
          name: "Security health cooldown active",
          detail: `Reused the latest backend health result. Try again in ${remainingSeconds}s to reduce Supabase load.`
        }
      ]
    };
  }

  if (supabaseLoadSafety.securityHealthInFlight) {
    return {
      checked: true,
      ok: true,
      mode: "in-flight",
      checkedAt: new Date().toISOString(),
      message: "A Security Health check is already running.",
      checks: [{ ok: true, level: "warning", warning: true, name: "Security health already running", detail: "Skipped this duplicate request to avoid extra Supabase load." }]
    };
  }

  supabaseLoadSafety.securityHealthInFlight = true;
  supabaseLoadSafety.lastSecurityHealthAt = now;
  recordSupabaseLoadEvent("security-health");
  try {
    const status = await refreshSupabaseSecurityHealth({ silent: true, force, probeTimeoutMs: timeoutMs });
    supabaseSecurityStatus = status && typeof status === "object" ? status : createSecurityHealthTimeoutStatus(timeoutMs);
  } catch (error) {
    supabaseSecurityStatus = {
      checked: true,
      ok: false,
      mode: hasSupabaseConfig ? "supabase" : "local",
      checkedAt: new Date().toISOString(),
      message: `Security health check failed: ${error.message || error}`,
      checks: [{ ok: false, name: "Supabase security health completed", detail: error.message || String(error) }]
    };
  } finally {
    supabaseLoadSafety.securityHealthInFlight = false;
  }
  return supabaseSecurityStatus;
}

function isMissingTestLabReportStoreError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || /test_lab_reports|upsert_test_lab_report/i.test(message) && /not found|schema cache|could not find|does not exist|relation/i.test(message);
}

function isHistoricalTestLabReport(report) {
  return Boolean(report?.historicalReport || report?.reportSource === "cloud-history");
}

function markHistoricalTestLabReport(report, reason = "Loaded from saved cloud report history.") {
  if (!report || typeof report !== "object") return report;
  return {
    ...report,
    historicalReport: true,
    historicalReportReason: report.historicalReportReason || reason,
    reportSource: report.reportSource || "cloud-history"
  };
}

function markCurrentTestLabReport(report, source = "current-run") {
  if (!report || typeof report !== "object") return report;
  const { historicalReport, historicalReportReason, ...rest } = report;
  return {
    ...rest,
    reportSource: source
  };
}

function mergeTestLabReportsIntoState(reports = [], { promote = true } = {}) {
  const existing = normalizeTestLabReports(state.testLabReports);
  const mergedById = new Map();
  [...reports, ...existing].forEach((report) => {
    if (!report || typeof report !== "object") return;
    const normalized = normalizeTestLabReports([report])[0];
    if (!normalized?.id) return;
    mergedById.set(normalized.id, normalized);
  });
  state.testLabReports = normalizeTestLabReports([...mergedById.values()]);
  if (promote || !lastTestLabReport) {
    lastTestLabReport = state.testLabReports[0] || lastTestLabReport;
  }
  return state.testLabReports;
}

async function loadCloudTestLabReports({ force = false, reason = "load normalized Test Lab report history" } = {}) {
  if (!supabaseClient || !currentSession) return false;
  const now = Date.now();
  if (supabaseLoadSafety.testLabReportLoadInFlight) {
    recordSupabaseLoadEvent("test-lab-report-load-skip", "normalized Test Lab report history load already in flight");
    return false;
  }
  if (!force && now - Number(supabaseLoadSafety.lastTestLabReportLoadAt || 0) < supabaseLoadSafety.testLabReportLoadCooldownMs) {
    recordSupabaseLoadEvent("test-lab-report-load-skip", "recent normalized Test Lab report history load reused");
    return true;
  }
  supabaseLoadSafety.testLabReportLoadInFlight = true;
  supabaseLoadSafety.lastTestLabReportLoadAt = now;
  try {
    recordSupabaseLoadEvent("test-lab-report-load", reason);
    const { data, error } = await supabaseClient
      .from("test_lab_reports")
      .select("report_payload,synced_at")
      .eq("ledger_id", supabaseHelpers.getLedgerId(supabaseConfig))
      .order("synced_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    const reports = (data || []).map((row) => markHistoricalTestLabReport({
      ...(row.report_payload || {}),
      syncedAt: row.report_payload?.syncedAt || row.synced_at
    }));
    mergeTestLabReportsIntoState(reports, { promote: !lastTestLabReport });
    writeLocalState();
    return true;
  } catch (error) {
    if (isMissingTestLabReportStoreError(error)) {
      recordSupabaseLoadEvent("test-lab-report-load-skip", "normalized Test Lab report store is not migrated yet");
      return false;
    }
    console.warn("Could not load normalized Test Lab reports", error);
    return false;
  } finally {
    supabaseLoadSafety.testLabReportLoadInFlight = false;
  }
}

function createImmutableTestLabReportId(report = {}) {
  const baseId = String(report.id || "testlab").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "testlab";
  const timestamp = new Date().toISOString().replace(/[^0-9a-z]+/gi, "").toLowerCase();
  const randomPart = Math.random().toString(36).slice(2, 8) || "report";
  return `${baseId}-save-${timestamp}-${randomPart}`;
}

async function saveTestLabReportViaRender(report) {
  if (!currentSession?.access_token || typeof fetch !== "function") return null;
  const ledgerId = getActiveLedgerId();
  const operationId = createDataIoOperationId("admin-report-save");
  const traceMeta = { source: "admin-report-save", route: "render-api", endpoint: renderAdminReportSaveUrl, operation: "upsert", operationId, ledgerId };
  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, detail: "Render report save" });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        const error = new Error(`Render report save timed out after ${Math.round(testLabReportCloudSaveTimeoutMs / 1000)} seconds`);
        error.name = "RenderReportSaveTimeout";
        reject(error);
      }, testLabReportCloudSaveTimeoutMs);
    });
    const fetchPromise = fetch(renderAdminReportSaveUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId, report })
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    if (!response.ok || !result?.ok || !result?.storedReport) {
      const error = new Error(result?.error || result?.message || text || `Render report save failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    recordSupabaseLoadEvent("render-admin-report-save", "saved Test Lab/Security Health report via Render admin route");
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, detail: "Render report save completed" });
    return result.storedReport;
  } catch (error) {
    recordDataIoDiagnostic("error", { ...traceMeta, ok: false, error, detail: "Render report save failed" });
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function saveTestLabReportToCloudStore(report) {
  if (!currentSession?.access_token) return false;
  const reportToStore = sanitizeStoredDiagnosticReport(report);
  const storedReport = await saveTestLabReportViaRender(reportToStore);
  if (!storedReport) return false;
  mergeTestLabReportsIntoState([markCurrentTestLabReport(storedReport, "cloud-save")]);
  writeLocalState();
  recordSupabaseLoadEvent("test-lab-report-local-merge", "merged saved Test Lab report locally after Render report save");
  return true;
}

function persistTestLabReport(report, { sync = false } = {}) {
  if (!report || typeof report !== "object") return null;
  const reportToStore = sanitizeStoredDiagnosticReport(report);
  const enriched = markCurrentTestLabReport({
    ...reportToStore,
    createdBy: reportToStore.createdBy || describeCurrentActor(),
    syncedAt: new Date().toISOString()
  }, sync ? "cloud-save" : "local-run");
  mergeTestLabReportsIntoState([enriched]);
  if (sync || testLabCloudReportOptIn) saveTestLabReportState(enriched);
  return lastTestLabReport;
}

function saveTestLabReportState(report = lastTestLabReport) {
  recordSupabaseLoadEvent("test-lab-report-save", "Manually saved Test Lab report metadata to cloud");
  writeLocalState();
  if (supabaseClient && currentSession) {
    saveTestLabReportToCloudStore(report)
      .then((savedToReportStore) => {
        if (savedToReportStore) {
          markRemoteSaveSucceeded("Reports");
          setDataToolsMessage("Fresh Test Lab report saved as a new normalized cloud history row. Ledger JSON was not rewritten.");
          return;
        }
        throw new Error("Could not save Test Lab report to normalized cloud history. JSON mirror report-save fallback is disabled.");
      })
      .catch((error) => markRemoteSaveFailed(error, "Could not save Test Lab report."));
  } else {
    queueRemoteSave();
  }
}

async function saveCurrentTestLabReportToCloud({ skipConfirmation = false } = {}) {
  const report = getCurrentTestLabReport();
  if (!report) {
    showUserWarning("Run or export a Test Lab report before saving it to cloud.");
    return;
  }
  if (isHistoricalTestLabReport(report)) {
    showUserWarning("This is a historical saved report. Run Security health or Test Lab again before saving a fresh cloud report.");
    setDataToolsMessage("Historical saved report was not re-saved. Run a fresh check, then save the new report to cloud.");
    return;
  }
  if (!skipConfirmation && !requireTypedAdminConfirmation({
    phrase: "SAVE REPORT TO CLOUD",
    title: "Save Test Lab report to cloud?",
    detail: "Routine Test Lab reports stay local. This writes report metadata to shared cloud storage."
  })) return { ok: false, skipped: true, reason: "confirmation-cancelled" };

  if (els.saveTestLabReportCloud) els.saveTestLabReportCloud.disabled = true;
  setDataToolsMessage("Saving fresh Test Lab report to normalized cloud history...");
  try {
    const savedToReportStore = await saveTestLabReportToCloudStore(redactTestLabReportForCloud(report));
    if (savedToReportStore) {
      markRemoteSaveSucceeded("Reports");
      renderTestLabReport(lastTestLabReport, { persist: false });
      render();
      setDataToolsMessage("Fresh Test Lab report saved to normalized cloud history.");
      return { ok: true, destination: "normalized-report-store" };
    }
    throw new Error("Could not save Test Lab report to normalized cloud history. JSON mirror report-save fallback is disabled.");
  } catch (error) {
    markRemoteSaveFailed(error, "Could not save Test Lab report.");
    showUserError(`Could not save Test Lab report: ${error.message || error}`);
    setDataToolsMessage(`Could not save Test Lab report: ${error.message || error}`);
    return { ok: false, error };
  } finally {
    if (els.saveTestLabReportCloud) els.saveTestLabReportCloud.disabled = false;
    testLabCloudReportOptIn = false;
    localStorage.removeItem(testLabReportCloudStorageKey);
  }
}

function startTestLabLoadGuard(label) {
  const startAt = Date.now();
  const startEvents = getSupabaseLoadEvents(5 * 60 * 1000).length;
  recordSupabaseLoadEvent("test-lab-local-run", `${label || "Test Lab"} started in local-only mode`);
  return function finishTestLabLoadGuard() {
    const recentEvents = getSupabaseLoadEvents(5 * 60 * 1000);
    const delta = Math.max(0, recentEvents.length - startEvents);
    if (delta > 8) {
      showUserWarning(`Test Lab noticed ${delta} app-side Supabase event(s) while running. Reports stayed local; avoid cloud diagnostics until CPU is calm.`);
    }
    return { startAt, delta };
  };
}



async function withTestLabReportCloudSaveTimeout(actionPromise, label = "Test Lab report cloud save", timeoutMs = testLabReportCloudSaveTimeoutMs) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      error.name = "TestLabReportCloudSaveTimeout";
      error.isTestLabReportCloudSaveTimeout = true;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([actionPromise, timeoutPromise]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function withSecurityHealthProbeTimeout(label, promise, timeoutMs = 10000) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      error.name = "SecurityHealthProbeTimeout";
      error.isSecurityHealthProbeTimeout = true;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function buildSecurityHealthProbeTimeoutCheck(helper, name, error) {
  const baseDetail = error?.message || String(error || "Security Health probe timed out.");
  const renderHealthOk = Boolean(renderAdminHealthStatus?.checked && renderAdminHealthStatus.ok);
  const detail = renderHealthOk
    ? `${baseDetail}. Render admin health is currently OK, so this is treated as a slow Supabase probe warning rather than a failed backend safety check.`
    : `${baseDetail}. Run Check Render health to separate Render/backend health from a slow Supabase probe.`;
  if (helper?.warn) return helper.warn(name, detail);
  return { ok: true, level: "warning", warning: true, name, detail };
}

async function fetchRenderSecurityHealthChecks({ ledgerId, probeTimeoutMs = 10000 } = {}) {
  if (!currentSession?.access_token || typeof fetch !== "function" || !ledgerId) return null;
  const operationId = createDataIoOperationId("admin-security-health");
  const traceMeta = { source: "admin-security-health", route: "render-api", endpoint: renderAdminSecurityHealthUrl, operation: "health", operationId, ledgerId };
  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, detail: "Render security health" });
    controller = new AbortController();
    const timeoutMs = Math.max(12000, Number(probeTimeoutMs || 0) + 10000);
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render security health API", timeoutMs));
      }, timeoutMs);
    });
    const fetchPromise = fetch(renderAdminSecurityHealthUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId })
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    if (!response.ok || !result) {
      const error = new Error(result?.error || result?.message || text || `Render security health failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const checks = Array.isArray(result.checks) ? result.checks : [];
    recordDataIoDiagnostic(result.ok === true ? "success" : "error", { ...traceMeta, ok: result.ok === true, detail: result.summary || "Render security health completed" });
    recordSupabaseLoadEvent("render-security-health", result.ok ? "Render security health ok" : "Render security health needs review");
    return {
      checked: true,
      ok: result.ok === true,
      mode: "render",
      checkedAt: result.checkedAt || new Date().toISOString(),
      message: result.summary || (result.ok ? "Render security health checks passed." : "Render security health needs review."),
      checks
    };
  } catch (error) {
    recordDataIoDiagnostic("error", { ...traceMeta, ok: false, error, detail: "Render security health failed" });
    return {
      checked: true,
      ok: true,
      mode: "render-fallback",
      checkedAt: new Date().toISOString(),
      message: "Render security health route was unavailable; browser Supabase probes will run as fallback.",
      checks: [buildSecurityHealthProbeTimeoutCheck(securityHealth || window.FuelSecurityHealth, "Render security health route unavailable", { label: "Render security health route", timeoutMs: probeTimeoutMs, message: error.message || String(error) })],
      error
    };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function refreshSupabaseSecurityHealth({ silent = false, force = false, probeTimeoutMs = 10000 } = {}) {
  const checks = [];
  const checkedAt = new Date().toISOString();

  function record(check) {
    checks.push(check);
  }

  const helper = securityHealth || window.FuelSecurityHealth;
  if (!helper) {
    supabaseSecurityStatus = {
      checked: true,
      ok: false,
      mode: "unavailable",
      checkedAt,
      message: "Security health helpers are not loaded.",
      checks: [{ ok: false, name: "Security health helper is loaded", detail: "Refresh the app and try again." }]
    };
    renderAdminGuardrailOverview();
    return supabaseSecurityStatus;
  }

  const now = Date.now();
  if (!force && supabaseSecurityStatus.checked && now - supabaseLoadSafety.lastSecurityHealthAt < supabaseLoadSafety.securityHealthCooldownMs) {
    renderAdminGuardrailOverview();
    if (!silent) setDataToolsMessage(helper.renderSecurityStatusText(supabaseSecurityStatus));
    return supabaseSecurityStatus;
  }
  recordSupabaseLoadEvent("security-health-live");
  supabaseLoadSafety.lastSecurityHealthAt = now;

  const localChecks = helper.buildLocalSecurityChecks({
    hasSupabaseConfig,
    hasSession: Boolean(currentSession),
    hasMemberProfile: Boolean(getCurrentMemberProfile()),
    isAdmin: canManageSettings(),
    normalizedTableStatus
  });
  localChecks.forEach(record);

  if (!hasSupabaseConfig || !supabaseClient) {
    supabaseSecurityStatus = {
      checked: true,
      ok: true,
      mode: "local",
      checkedAt,
      message: "Local-only mode: Supabase backend security checks are not applicable.",
      checks
    };
    renderAdminGuardrailOverview();
    if (!silent) setDataToolsMessage(helper.renderSecurityStatusText(supabaseSecurityStatus));
    return supabaseSecurityStatus;
  }

  if (!currentSession) {
    supabaseSecurityStatus = {
      checked: true,
      ok: false,
      mode: "supabase",
      checkedAt,
      message: "Sign in before running live Supabase security checks.",
      checks
    };
    renderAdminGuardrailOverview();
    if (!silent) setDataToolsMessage(helper.renderSecurityStatusText(supabaseSecurityStatus));
    return supabaseSecurityStatus;
  }

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);

  if (canManageSettings()) {
    const renderSecurityStatus = await fetchRenderSecurityHealthChecks({ ledgerId, probeTimeoutMs });
    if (renderSecurityStatus?.mode === "render") {
      renderSecurityStatus.checks.forEach(record);
      const failed = checks.filter((check) => !check.ok);
      supabaseSecurityStatus = {
        checked: true,
        ok: failed.length === 0,
        mode: "render",
        checkedAt: renderSecurityStatus.checkedAt || checkedAt,
        message: failed.length ? `${failed.length} Supabase security health check(s) need attention.` : "Supabase security health checks passed through Render.",
        checks
      };
      renderAdminGuardrailOverview();
      if (!silent) setDataToolsMessage(helper.renderSecurityStatusText(supabaseSecurityStatus));
      return supabaseSecurityStatus;
    }
    if (renderSecurityStatus?.checks?.length) {
      renderSecurityStatus.checks.forEach(record);
    }

    try {
      if (!(await withSecurityHealthProbeTimeout("Supabase session refresh", hasFreshSupabaseSession(), probeTimeoutMs))) {
        record(helper.fail("Supabase session is fresh", "The session could not be refreshed."));
      } else {
        record(helper.pass("Supabase session is fresh"));
      }
    } catch (error) {
      if (error?.isSecurityHealthProbeTimeout) {
        record(buildSecurityHealthProbeTimeoutCheck(helper, "Supabase session refresh timed out", error));
      } else {
        record(helper.fail("Supabase session is fresh", error.message || String(error)));
      }
    }

    try {
      const members = await withSecurityHealthProbeTimeout("Active ledger members probe", supabaseClient
        .from("ledger_members")
        .select("id,name,email,role,is_active")
        .eq("ledger_id", ledgerId)
        .eq("is_active", true)
        .limit(100), probeTimeoutMs);
      if (members.error) throw members.error;
      record(helper.pass("Active ledger members are readable", `${members.data?.length || 0} active member row(s).`));
      const currentEmail = String(currentSession?.user?.email || "").toLowerCase();
      const currentRow = (members.data || []).find((member) => String(member.email || "").toLowerCase() === currentEmail);
      record(currentRow ? helper.pass("Current Supabase user is linked to an active ledger member", currentRow.name || currentEmail) : helper.fail("Current Supabase user is linked to an active ledger member", currentEmail || "No email found."));
      record(currentRow?.role === "admin" ? helper.pass("Current linked member is admin in normalized tables") : helper.fail("Current linked member is admin in normalized tables", "Admin role is required for backend security checks."));
    } catch (error) {
      if (error?.isSecurityHealthProbeTimeout) {
        record(buildSecurityHealthProbeTimeoutCheck(helper, "Active ledger members probe timed out", error));
      } else {
        record(helper.fail("Active ledger members are readable", error.message || String(error)));
      }
    }

    try {
      const probe = await withSecurityHealthProbeTimeout("Fuel Ledger healthcheck RPC", supabaseClient.rpc("fuel_ledger_healthcheck", {
        target_ledger_id: ledgerId
      }), probeTimeoutMs);
      const normalizedProbe = helper.normalizeHealthcheckRpcResult({
        name: "Fuel Ledger healthcheck RPC is available",
        ok: !probe.error,
        data: probe.data,
        error: probe.error
      });
      normalizedProbe.rpcHealth = rememberHealthcheckRpcPayload(probe.data, checkedAt);
      record(normalizedProbe);
    } catch (error) {
      if (error?.isSecurityHealthProbeTimeout) {
        record(buildSecurityHealthProbeTimeoutCheck(helper, "Fuel Ledger healthcheck RPC timed out", error));
      } else {
        record(helper.normalizeHealthcheckRpcResult({
          name: "Fuel Ledger healthcheck RPC is available",
          error
        }));
      }
    }
  } else {
    record(helper.pass("Admin-only RPC probes were skipped", "The current user is not an admin."));
  }

  const failed = checks.filter((check) => !check.ok);
  supabaseSecurityStatus = {
    checked: true,
    ok: failed.length === 0,
    mode: "supabase",
    checkedAt,
    message: failed.length ? `${failed.length} Supabase security health check(s) need attention.` : "Supabase security health checks passed.",
    checks
  };
  renderAdminGuardrailOverview();
  if (!silent) setDataToolsMessage(helper.renderSecurityStatusText(supabaseSecurityStatus));
  return supabaseSecurityStatus;
}

function renderTestLabReport(report = null, { persist = false } = {}) {
  if (report) {
    lastTestLabReport = persist ? persistTestLabReport(report) : report;
  } else {
    lastTestLabReport = getCurrentTestLabReport();
  }
  if (!els.testLabReport || !testLab?.renderReportHtml) return;
  if (!lastTestLabReport) {
    els.testLabReport.innerHTML = `<p class="entry-meta">No Test Lab report yet. Routine Test Lab reports stay local. Run a check, export it, or manually save the report to cloud.</p>`;
    return;
  }
  const buildInfo = window.FUEL_LEDGER_BUILD || {};
  const reportBuild = lastTestLabReport.buildInfo || {};
  const buildMismatch = reportBuild.expectedServiceWorkerCache && buildInfo.expectedServiceWorkerCache
    && reportBuild.expectedServiceWorkerCache !== buildInfo.expectedServiceWorkerCache;
  const historical = isHistoricalTestLabReport(lastTestLabReport);
  const banner = historical || buildMismatch
    ? `<div class="test-lab-stale-report-banner">
        <strong>Historical saved report</strong>
        <span>${escapeHtml(lastTestLabReport.historicalReportReason || "This report was loaded from saved cloud report history. Run Security health again to replace it with a fresh result.")}${buildMismatch ? ` Current build expects ${escapeHtml(buildInfo.expectedServiceWorkerCache)}; this report used ${escapeHtml(reportBuild.expectedServiceWorkerCache)}.` : ""}</span>
      </div>`
    : "";
  const reportHtml = testLab.renderReportHtml(lastTestLabReport);
  if (historical || buildMismatch) {
    const generatedAt = lastTestLabReport.finishedAt || lastTestLabReport.syncedAt || lastTestLabReport.startedAt || "";
    const generatedLabel = generatedAt ? formatDateTimeShort(generatedAt) : "unknown time";
    const statusLabel = lastTestLabReport.ok ? "passed" : "failed";
    const buildLabel = reportBuild.buildLabel || reportBuild.expectedServiceWorkerCache || "older build";
    els.testLabReport.innerHTML = `${banner}
      <details class="test-lab-historical-details">
        <summary>
          <strong>Historical ${escapeHtml(statusLabel)} report</strong>
          <span>${escapeHtml(generatedLabel)} · ${escapeHtml(buildLabel)}</span>
        </summary>
        ${reportHtml}
      </details>`;
    return;
  }
  els.testLabReport.innerHTML = `${banner}${reportHtml}`;
}

function highlightVisibleEntryCard(type, id, missingMessage) {
  window.setTimeout(() => {
    const card = document.querySelector(`[data-entry-type="${CSS.escape(type)}"][data-entry-id="${CSS.escape(id)}"]`);
    if (!card) {
      showUserWarning(missingMessage);
      return;
    }
    const group = card.closest("details.history-group");
    if (group) group.open = true;
    card.classList.add("entry-card-highlight");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => card.classList.remove("entry-card-highlight"), 4000);
  }, 0);
}

function inspectTestLabEntry(value) {
  const [type, id] = String(value || "").split(":");
  if (!type || !id) return;
  if (type === "fuel") {
    const fuel = state.fuel.find((entry) => entry.id === id);
    if (!fuel) {
      showLogViewForEditing();
      render();
      highlightVisibleEntryCard("fuel", id, "That fuel log is not visible in the current period. It may be archived or deleted.");
      return;
    }
    if (!canManageFuelEntry(fuel)) {
      showPermissionBlocked(describeFuelPermissionMessage(fuel, "edit"));
      return;
    }
    if (!assertCurrentPeriodAllowsMoneyChanges("edit fuel logs")) return;
    startFuelEdit(id);
    showAppMessage(`Fuel log ${formatTypedLogRef(fuel, "fuel")} loaded for editing.`);
    window.setTimeout(() => {
      els.fuelOdometer?.focus();
      els.fuelForm?.classList.add("entry-card-highlight");
      window.setTimeout(() => els.fuelForm?.classList.remove("entry-card-highlight"), 4000);
    }, 0);
    return;
  }
  if (type === "trips" || type === "trip") {
    const trip = state.trips.find((entry) => entry.id === id);
    if (trip && canManageTripEntry(trip) && assertCurrentPeriodAllowsMoneyChanges("edit trip logs")) {
      startTripEdit(id);
      showAppMessage(`Trip ${formatTypedLogRef(trip, "trip")} loaded for editing.`);
      return;
    }
    showLogViewForEditing();
    render();
    highlightVisibleEntryCard("trip", id, "That trip log is not visible in the current period. It may be archived or deleted.");
    return;
  }
  if (type === "bookings" || type === "booking") {
    const booking = state.bookings.find((entry) => entry.id === id);
    if (booking && canManageBookingEntry(booking)) {
      startBookingEdit(id);
      showAppMessage(`Booking ${formatTypedLogRef(booking, "booking")} loaded for editing.`);
      return;
    }
    setActiveView("book");
    highlightVisibleEntryCard("booking", id, "That booking is not visible in the current calendar view. It may be archived or deleted.");
  }
}

function buildCurrentTestLabReport({ id, scenario, startedAt, before, generated, cleanup = null, errors = [], scenarioFilter = null, securityStatus = null, sourceState = null, sourceLedger = null, after = null }) {
  const reportState = sourceState || state;
  const ledger = sourceLedger || calculateLedger();
  const effectiveSecurityStatus = securityStatus || supabaseSecurityStatus;
  const matrixInput = {
    state: reportState,
    ledger,
    buildInfo: window.FuelBuildInfo?.BUILD_INFO || null,
    permissionHelpers: window.permissionHelpers,
    locationPrivacy: window.FuelLocationPrivacy,
    dataStore,
    securityHealthHelper: securityHealth,
    supabaseSecurityStatus: effectiveSecurityStatus,
    transition: typeof isValidPaymentStatusTransition === "function" ? isValidPaymentStatusTransition : null
  };
  let scenarios = testLab?.runScenarioMatrixChecks ? testLab.runScenarioMatrixChecks(matrixInput) : [];
  if (Array.isArray(scenarioFilter) && scenarioFilter.length) {
    const allowed = new Set(scenarioFilter);
    scenarios = scenarios.filter((item) => allowed.has(item.id));
  }
  const checks = testLab?.flattenScenarioChecks
    ? testLab.flattenScenarioChecks(scenarios)
    : (testLab?.runStateInvariantChecks ? testLab.runStateInvariantChecks({ state, ledger }) : []);
  return testLab.buildTestLabReport({
    id,
    scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    buildInfo: window.FuelBuildInfo?.BUILD_INFO || null,
    createdBy: describeCurrentActor(),
    browser: navigator.userAgent || "",
    normalizedTableStatus,
    supabaseSecurityStatus: effectiveSecurityStatus,
    before,
    after: after || testLab.stateSummary(reportState),
    generated,
    cleanup,
    scenarios,
    checks,
    errors
  });
}


async function runTestLabScenarioMatrix({ scenarioName = "scenario-matrix", scenarioFilter = null, confirmMessage = "Run the Test Lab scenario matrix? This creates no production data; it validates app logic and exports a synced report." } = {}) {
  if (!testLab) {
    showUserError("Test Lab helpers are not loaded. Refresh the app and try again.");
    return;
  }
  if (!confirmUserAction(confirmMessage)) return;
  const startedAt = new Date().toISOString();
  const id = testLab.createTestRunId();
  const finishLoadGuard = startTestLabLoadGuard(scenarioName);
  setDataToolsMessage(`Test Lab ${id}: running ${scenarioName} locally...`);
  const securityStatus = buildLightweightSecurityHealthStatus("Targeted Test Lab checks run local-only; live backend probe skipped.");
  const report = buildCurrentTestLabReport({
    id,
    scenario: scenarioName,
    startedAt,
    before: testLab.stateSummary(state),
    generated: testLab.generatedDataSummary(state, { prefix: generatedTestPrefix, marker: generatedTestMarker }),
    scenarioFilter,
    securityStatus
  });
  const loadGuard = finishLoadGuard();
  renderTestLabReport(report, { persist: false });
  setDataToolsMessage(`${scenarioName} complete locally: ${report.passedCount} passed, ${report.failedCount} failed. Cloud events during run: ${loadGuard.delta}.`);
}


async function runStandaloneSecurityHealthScenario({ skipConfirmation = false } = {}) {
  if (!testLab) {
    showUserError("Test Lab helpers are not loaded. Refresh the app and try again.");
    return;
  }
  if (!skipConfirmation && !confirmUserAction("Run live Supabase security health checks? This uses harmless read/probe calls and does not change production data.")) return;
  const startedAt = new Date().toISOString();
  const id = testLab.createTestRunId();
  setDataToolsMessage(`Test Lab ${id}: running Security health checks...`);

  let securityStatus;
  try {
    securityStatus = await refreshSupabaseSecurityHealthForTestLab({ timeoutMs: standaloneSecurityHealthProbeTimeoutMs, deep: true, force: true });
  } catch (error) {
    securityStatus = {
      checked: true,
      ok: false,
      mode: "supabase",
      checkedAt: new Date().toISOString(),
      message: `Security health check failed: ${error.message || error}`,
      checks: [{ ok: false, name: "Supabase security health completed", detail: error.message || String(error) }]
    };
    supabaseSecurityStatus = securityStatus;
  }

  const report = buildCurrentTestLabReport({
    id,
    scenario: "supabase-security-health-checks",
    startedAt,
    before: testLab.stateSummary(state),
    generated: testLab.generatedDataSummary(state, { prefix: generatedTestPrefix, marker: generatedTestMarker }),
    scenarioFilter: ["security"],
    securityStatus
  });
  renderTestLabReport(report, { persist: false });
  renderAdminGuardrailOverview();
  setDataToolsMessage(`Security health complete: ${report.passedCount} passed, ${report.failedCount} failed. Report stayed local unless you save it to cloud.`);
}

async function cleanupGeneratedTestDataWithReport() {
  await exportAdminSafetyBackup("cleanup generated test data");
  assertFreshAdminSafetyBackup("cleanup generated test data");
  const cleanup = cleanupGeneratedTestEntriesFromState();
  const normalizedCleanup = await cleanupGeneratedRowsFromNormalizedTables("cleanup-test-lab-data");
  const normalizedCleanupMessage = normalizedCleanup?.total ? ` Soft-deleted ${normalizedCleanup.total} generated normalized row${normalizedCleanup.total === 1 ? "" : "s"}.` : "";
  await persistGeneratedAdminStateWithRenderMirror("cleanup-test-lab-data", `${cleanup.message}${normalizedCleanupMessage} Saved cleanup through Render JSON mirror backup.`, { checkTables: false });
  const report = buildCurrentTestLabReport({
    id: testLab?.createTestRunId ? testLab.createTestRunId() : `testlab-${Date.now()}`,
    scenario: "cleanup-test-data",
    startedAt: new Date().toISOString(),
    before: cleanup.before,
    generated: cleanup.after,
    cleanup
  });
  renderTestLabReport(report, { persist: false });
}

function cloneForTestLab(value) {
  try {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch (error) {
    return JSON.parse(JSON.stringify(value));
  }
}

function calculateLedgerForState(testState) {
  const originalState = state;
  try {
    state = testState;
    return calculateLedger();
  } finally {
    state = originalState;
  }
}

function buildSafeTestLabState(runId) {
  const testState = cloneForTestLab(state);
  if (!Array.isArray(testState.trips)) testState.trips = [];
  if (!Array.isArray(testState.fuel)) testState.fuel = [];
  if (!Array.isArray(testState.bookings)) testState.bookings = [];
  const isTest = (entry) => testLab?.isTestLabEntry ? testLab.isTestLabEntry(entry, { prefix: generatedTestPrefix, marker: generatedTestMarker }) : isGeneratedTestEntry(entry);
  testState.trips = testState.trips.filter((entry) => !isTest(entry));
  testState.fuel = testState.fuel.filter((entry) => !isTest(entry));
  testState.bookings = testState.bookings.filter((entry) => !isTest(entry));

  const originalState = state;
  try {
    state = testState;
    for (let i = 0; i < 1; i += 1) testState.bookings.push(makeGeneratedTestBooking(i, runId));
    for (let i = 0; i < 3; i += 1) testState.trips.push(tagGeneratedEntry(makeGeneratedTestTrip(300 + i), runId));
    for (let i = 0; i < 2; i += 1) testState.fuel.push(tagGeneratedEntry(makeGeneratedTestFuel(300 + i), runId));
    testState.lastOdometer = getLatestOdometer();
  } finally {
    state = originalState;
  }
  return testState;
}

async function runFullTestLabScenario() {
  if (!assertCurrentPeriodAllowsNewEntries()) return;
  if (!testLab) {
    showUserError("Test Lab helpers are not loaded. Refresh the app and try again.");
    return;
  }
  if (!confirmUserAction("Run the safe Test Lab? This uses a small in-memory generated scenario, saves only the final report, and does not sync temporary trips/fuel/bookings to Supabase.")) return;
  const members = getMemberNames();
  if (!members.length) {
    showUserError("Add at least one member before running the Test Lab.");
    return;
  }

  const runId = testLab.createTestRunId();
  const finishLoadGuard = startTestLabLoadGuard("safe-full-test-lab");
  const startedAt = new Date().toISOString();
  const before = testLab.stateSummary(state);
  const errors = [];
  setDataToolsMessage(`Test Lab ${runId}: building safe in-memory scenario...`);

  let testState = null;
  let testLedger = null;
  let generated = null;
  try {
    testState = buildSafeTestLabState(runId);
    testLedger = calculateLedgerForState(testState);
    generated = testLab.generatedDataSummary(testState, { prefix: generatedTestPrefix, marker: generatedTestMarker });
  } catch (error) {
    console.warn("Test Lab safe scenario failed", error);
    errors.push(error.message || String(error));
    testState = state;
    testLedger = calculateLedger();
    generated = testLab.generatedDataSummary(state, { prefix: generatedTestPrefix, marker: generatedTestMarker });
  }

  setDataToolsMessage(`Test Lab ${runId}: running local-only checks. Live backend probe skipped to protect Supabase.`);
  const securityStatus = buildLightweightSecurityHealthStatus("Safe Test Lab is local-only; live Supabase probes are skipped. Use Security health manually when CPU is calm.");

  const cleanup = {
    before: generated,
    after: { trips: 0, fuel: 0, bookings: 0, closedPeriods: 0, paymentStatuses: 0, total: 0 },
    removed: generated,
    message: "No production data was created; generated scenario ran in memory only."
  };

  const report = buildCurrentTestLabReport({
    id: runId,
    scenario: "safe-full-test-lab",
    startedAt,
    before,
    after: testLab.stateSummary(state),
    generated,
    cleanup,
    errors,
    securityStatus,
    sourceState: testState,
    sourceLedger: testLedger
  });
  const loadGuard = finishLoadGuard();
  renderTestLabReport(report, { persist: false });

  if (report.ok) {
    setDataToolsMessage(`Safe Test Lab passed locally with ${report.warningCount || 0} warning(s). Cloud events during run: ${loadGuard.delta}. Temporary data/report were not synced to Supabase.`);
  } else {
    setDataToolsMessage(`Safe Test Lab found ${report.failedCount} issue(s). Export the local report for details.`);
  }
}

function downloadLastTestLabReport() {
  const report = getCurrentTestLabReport();
  if (!report) {
    showUserWarning("Run a Test Lab scenario before exporting a report.");
    return;
  }
  lastTestLabReport = report;
  renderTestLabReport(null, { persist: false });
  const filename = `fuel-ledger-test-lab-report-${report.id || localDateString()}.json`;
  const exportedReport = redactSensitiveDiagnostics(report);
  downloadTextFile(filename, JSON.stringify(exportedReport, null, 2), "application/json");
  const source = report.syncedAt ? "synced" : "local";
  setDataToolsMessage(`Test Lab report downloaded from ${source} report storage with privacy redaction applied.`);
}



if (els.cancelTripEdit) {
  els.cancelTripEdit.addEventListener("click", () => {
    editingTripId = null;
    clearTripLoggingContext();
    clearTripCorrectionPanel();
    els.tripForm.reset();
    setDefaultDates();
    updateEditUi();
    render();
  });
}

els.tripCorrectionPanel?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-trip-correction-action]");
  if (!button) return;
  applyTripCorrection(button.dataset.tripCorrectionAction);
});

[els.startKm, els.endKm, els.tripDate, els.tripNote].forEach((control) => {
  control?.addEventListener("input", clearTripCorrectionPanel);
  control?.addEventListener("change", clearTripCorrectionPanel);
});

if (els.cancelBookingEdit) {
  els.cancelBookingEdit.addEventListener("click", () => {
    setBookingCalendarAnchor(bookingPayload.start);
    editingBookingId = null;
    els.bookingForm.reset();
    setDefaultBookingTimes();
    renderBookingConflictNotice(null);
    updateEditUi();
    render();
  });
}

if (els.cancelFuelEdit) {
  
els.fuelCorrectionPanel?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-fuel-correction-action]");
  if (!button) return;
  applyFuelCorrection(button.dataset.fuelCorrectionAction);
});

[els.fuelLiters, els.fuelOdometer, els.fuelDate, els.fuelFullTank].forEach((control) => {
  control?.addEventListener("input", clearFuelCorrectionPanel);
  control?.addEventListener("change", clearFuelCorrectionPanel);
});

els.cancelFuelEdit.addEventListener("click", () => {
    editingFuelId = null;
    els.fuelForm.reset();
    clearFuelLocation();
    setDefaultDates();
    updateEditUi();
    render();
  });
}

els.closePeriod.addEventListener("click", () => {
  closeCurrentPeriod();
});

if (els.periodSearch) {
  els.periodSearch.addEventListener("input", () => {
    closedPeriodFilters.query = els.periodSearch.value.trim().toLowerCase();
    renderClosedPeriods();
  });
}

if (els.periodStatusFilter) {
  els.periodStatusFilter.addEventListener("change", () => {
    closedPeriodFilters.status = els.periodStatusFilter.value || "all";
    renderClosedPeriods();
  });
}

if (els.periodSort) {
  els.periodSort.addEventListener("change", () => {
    closedPeriodFilters.sort = els.periodSort.value || "newest";
    renderClosedPeriods();
  });
}

if (els.clearPeriodFilters) {
  els.clearPeriodFilters.addEventListener("click", () => {
    closedPeriodFilters.query = "";
    closedPeriodFilters.status = "all";
    closedPeriodFilters.sort = "newest";
    if (els.periodSearch) els.periodSearch.value = "";
    if (els.periodStatusFilter) els.periodStatusFilter.value = "all";
    if (els.periodSort) els.periodSort.value = "newest";
    renderClosedPeriods();
  });
}

document.addEventListener("toggle", (event) => {
  const card = event.target instanceof Element ? event.target.closest(".archived-period-card[data-period-id]") : null;
  if (!card) return;
  const periodId = card.dataset.periodId;
  if (!periodId) return;
  if (card.open) {
    const needsDetailsRender = card.dataset.lazyClosedPeriod === "true";
    expandedClosedPeriodIds.add(periodId);
    if (needsDetailsRender) {
      renderClosedPeriods();
    }
  } else {
    expandedClosedPeriodIds.delete(periodId);
  }
}, true);

document.addEventListener("click", async (event) => {
  const statusButton = event.target.closest("[data-payment-status]");
  if (statusButton) {
    await updatePaymentStatus(statusButton);
    return;
  }

  const reminderButton = event.target.closest("[data-payment-reminder]");
  if (reminderButton) {
    await sendPaymentReminder(reminderButton);
    return;
  }

  const closedStatusButton = event.target.closest("[data-closed-payment-status]");
  if (closedStatusButton) {
    await updateClosedPaymentStatus(closedStatusButton);
    return;
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    copySettlement(copyButton);
    return;
  }

  const mobilePayButton = event.target.closest("[data-open-mobilepay]");
  if (mobilePayButton) {
    const ledger = calculateLedger();
    const settlement = ledger.settlements.find((item) => settlementKey(item) === mobilePayButton.dataset.paymentKey);
    openMobilePayApp(settlement);
    render();
    return;
  }

  const bookingDayButton = event.target.closest("[data-booking-day]");
  if (bookingDayButton) {
    setBookingQuickDate(Number(bookingDayButton.dataset.bookingDay || 0));
    return;
  }

  const bookingWeekendButton = event.target.closest("[data-booking-weekend]");
  if (bookingWeekendButton) {
    setBookingQuickWeekend();
    return;
  }

  const bookingDurationButton = event.target.closest("[data-booking-duration-hours]");
  if (bookingDurationButton) {
    setBookingDuration(Number(bookingDurationButton.dataset.bookingDurationHours || 2));
    return;
  }

  const bookingAllDayButton = event.target.closest("[data-booking-all-day]");
  if (bookingAllDayButton) {
    setBookingAllDay();
    return;
  }

  const bookingCalendarViewButton = event.target.closest("[data-booking-calendar-view]");
  if (bookingCalendarViewButton) {
    setBookingCalendarView(bookingCalendarViewButton.dataset.bookingCalendarView);
    return;
  }

  const convertBookingButton = event.target.closest("[data-convert-booking-to-trip]");
  if (convertBookingButton) {
    startTripFromBooking(convertBookingButton.dataset.convertBookingToTrip);
    return;
  }

  const completePendingTripButton = event.target.closest("[data-complete-pending-trip]");
  if (completePendingTripButton) {
    startTripFromBooking(completePendingTripButton.dataset.completePendingTrip);
    return;
  }

  const addFuelForTripButton = event.target.closest("[data-add-fuel-for-trip]");
  if (addFuelForTripButton) {
    startFuelFromPendingAction(addFuelForTripButton);
    return;
  }

  const viewArchiveButton = event.target.closest("[data-view-closed-period]");
  if (viewArchiveButton) {
    const periodId = viewArchiveButton.dataset.viewClosedPeriod;
    if (periodId) {
      expandedClosedPeriodIds.add(periodId);
      closedPeriodFilters.query = "";
      closedPeriodFilters.status = "all";
      if (els.periodSearch) els.periodSearch.value = "";
      if (els.periodStatusFilter) els.periodStatusFilter.value = "all";
      setActiveHistorySection("archive");
      setActiveView("history");
      setTimeout(() => {
        const card = document.querySelector(`.archived-period-card[data-period-id="${CSS.escape(periodId)}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    }
    return;
  }

  const archiveCsvButton = event.target.closest("[data-archive-csv]");
  if (archiveCsvButton) {
    downloadClosedPeriodCsv(archiveCsvButton.dataset.archiveCsv);
    return;
  }

  const archiveAuditCsvButton = event.target.closest("[data-archive-audit-csv]");
  if (archiveAuditCsvButton) {
    downloadClosedPeriodAuditCsv(archiveAuditCsvButton.dataset.archiveAuditCsv);
    return;
  }

  const reviewPeriodButton = event.target.closest("[data-review-period]");
  if (reviewPeriodButton) {
    showHistoryForPeriodReview();
    return;
  }

  const inspectButton = event.target.closest("[data-testlab-open-entry]");
  if (inspectButton) {
    inspectTestLabEntry(inspectButton.dataset.testlabOpenEntry);
    return;
  }

  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    editEntry(editButton.dataset.edit);
    return;
  }

  const button = event.target.closest("[data-delete]");
  if (!button) return;

  const [type, id] = button.dataset.delete.split(":");
  const entry = type === "trips"
    ? state.trips.find((item) => item.id === id)
    : type === "bookings"
      ? state.bookings.find((item) => item.id === id)
      : state.fuel.find((item) => item.id === id);
  const canDelete = type === "trips"
    ? canManageTripEntry(entry)
    : type === "bookings"
      ? canManageBookingEntry(entry)
      : canManageFuelEntry(entry);
  if (!canDelete) {
    showPermissionBlocked(type === "trips"
      ? describeTripPermissionMessage(entry, "delete")
      : type === "bookings"
        ? describeBookingPermissionMessage(entry, "delete")
        : describeFuelPermissionMessage(entry, "delete"));
    return;
  }

  if (type !== "bookings") {
    if (!assertCurrentPeriodAllowsMoneyChanges(type === "trips" ? "delete trip logs" : "delete fuel logs")) return;
  }
  const normalizedDeleteSaved = await softDeleteNormalizedEntryFirst(type, id);
  if (!normalizedDeleteSaved) return;
  state[type] = state[type].filter((entry) => entry.id !== id);
  addAuditEntry({
    type: type === "trips" ? "trip_deleted" : type === "bookings" ? "booking_deleted" : "fuel_deleted",
    entityType: type === "trips" ? "trip" : type === "bookings" ? "booking" : "fuel",
    entityId: id,
    summary: type === "trips"
      ? `${entry?.driver || "Trip"} · ${entry ? formatNumber(Number(entry.endKm || 0) - Number(entry.startKm || 0)) : ""} km`
      : type === "bookings"
        ? `${entry ? formatLogRef(entry) : ""} · ${entry?.member || "Booking"} · ${entry ? formatBookingRange(entry) : ""}`
        : `${entry?.payer || "Fuel log"} · ${entry ? formatMoney(entry.amount) : ""}`,
    detail: type === "bookings" ? (entry?.purpose || "") : (entry?.date || ""),
    metadata: type === "bookings" && entry ? buildBookingAuditMetadata(entry) : {}
  });
  if (type === "trips") state.lastOdometer = getLatestOdometer();
  if (editingTripId === id) editingTripId = null;
  if (editingBookingId === id) editingBookingId = null;
  if (editingFuelId === id) editingFuelId = null;
  saveState();
  updateEditUi();
  render();
  showAppMessage(type === "trips" ? "Trip deleted." : type === "bookings" ? "Booking deleted." : "Fuel log deleted.");
});



function describeTripAuditChanges(previousTrip, nextTrip) {
  if (!previousTrip || !nextTrip) return "";
  const changes = [];
  if (previousTrip.driver !== nextTrip.driver) changes.push(`Driver: ${previousTrip.driver || "—"} → ${nextTrip.driver || "—"}`);
  if (previousTrip.date !== nextTrip.date) changes.push(`Date: ${previousTrip.date || "—"} → ${nextTrip.date || "—"}`);
  if (Number(previousTrip.startKm || 0) !== Number(nextTrip.startKm || 0)) changes.push(`Start km: ${formatNumber(previousTrip.startKm || 0)} → ${formatNumber(nextTrip.startKm || 0)}`);
  if (Number(previousTrip.endKm || 0) !== Number(nextTrip.endKm || 0)) changes.push(`End km: ${formatNumber(previousTrip.endKm || 0)} → ${formatNumber(nextTrip.endKm || 0)}`);
  const previousDistance = Number(previousTrip.endKm || 0) - Number(previousTrip.startKm || 0);
  const nextDistance = Number(nextTrip.endKm || 0) - Number(nextTrip.startKm || 0);
  if (previousDistance !== nextDistance) changes.push(`Distance: ${formatNumber(previousDistance)} km → ${formatNumber(nextDistance)} km`);
  const previousParticipants = (previousTrip.participants || []).join(", ");
  const nextParticipants = (nextTrip.participants || []).join(", ");
  if (previousParticipants !== nextParticipants) changes.push(`Participants: ${previousParticipants || "—"} → ${nextParticipants || "—"}`);
  if ((previousTrip.note || "") !== (nextTrip.note || "")) changes.push("Note changed");
  return changes.join(" · ");
}

function describeFuelAuditChanges(previousFuel, nextFuel) {
  if (!previousFuel || !nextFuel) return "";
  const changes = [];
  if (previousFuel.payer !== nextFuel.payer) changes.push(`Payer: ${previousFuel.payer || "—"} → ${nextFuel.payer || "—"}`);
  if (previousFuel.date !== nextFuel.date) changes.push(`Date: ${previousFuel.date || "—"} → ${nextFuel.date || "—"}`);
  if (Number(previousFuel.amount || 0) !== Number(nextFuel.amount || 0)) changes.push(`Amount: ${formatMoney(previousFuel.amount || 0)} → ${formatMoney(nextFuel.amount || 0)}`);
  if (Number(previousFuel.liters || 0) !== Number(nextFuel.liters || 0)) changes.push(`Liters: ${previousFuel.liters || "—"} → ${nextFuel.liters || "—"}`);
  if (Number(previousFuel.odometer || 0) !== Number(nextFuel.odometer || 0)) changes.push(`Odometer: ${previousFuel.odometer || "—"} → ${nextFuel.odometer || "—"}`);
  if ((previousFuel.station || "") !== (nextFuel.station || "")) changes.push(`Station: ${previousFuel.station || "—"} → ${nextFuel.station || "—"}`);
  if (Boolean(previousFuel.fullTank) !== Boolean(nextFuel.fullTank)) changes.push(`Full tank: ${previousFuel.fullTank ? "yes" : "no"} → ${nextFuel.fullTank ? "yes" : "no"}`);
  return changes.join(" · ");
}

function buildPaymentAuditInfo(settlement, previousStatus, nextStatus) {
  const from = settlement?.from || "Someone";
  const to = settlement?.to || "someone";
  const amount = Number(settlement?.amount || 0);
  const currency = settlement?.currency || state.currency || "DKK";
  const amountText = formatMoneyFor(amount, currency);
  const paymentRef = createPaymentRef({ scope: "current", key: settlementKey(settlement || {}), from, to, amount });
  const previousLabel = statusLabel(previousStatus);
  const nextLabel = statusLabel(nextStatus);
  const routeText = `${from} → ${to}`;
  const summary = nextStatus === "paid"
    ? `Payment marked paid · ${from} paid ${to} · ${amountText}`
    : nextStatus === "requested"
      ? `Payment requested · ${routeText} · ${amountText}`
      : `Payment reopened · ${routeText} · ${amountText}`;
  const detail = `${formatPaymentRef(paymentRef)} · Status: ${previousLabel} → ${nextLabel} · ${from} pays ${to} · ${amountText}`;
  return {
    summary,
    detail,
    metadata: {
      from,
      to,
      amount,
      currency,
      paymentRef,
      previousStatus: normalizePaymentStatus(previousStatus),
      nextStatus: normalizePaymentStatus(nextStatus),
      previousStatusLabel: previousLabel,
      nextStatusLabel: nextLabel
    }
  };
}

function buildPaymentReminderAuditInfo(settlement, pushResult = {}, paymentRef = "") {
  const from = settlement?.from || "Someone";
  const to = settlement?.to || "someone";
  const amount = Number(settlement?.amount || 0);
  const currency = settlement?.currency || state.currency || "DKK";
  const amountText = formatMoneyFor(amount, currency);
  const sent = Number(pushResult.sent || 0);
  const failed = Number(pushResult.failed || 0);
  const deliveryText = sent > 0
    ? `Mobile notification sent to ${sent} device${sent === 1 ? "" : "s"}`
    : pushResult.attempted
      ? "No active mobile notification subscription was reached"
      : "Reminder recorded in the app; mobile notification was not available";
  const refText = normalizePaymentRefValue(paymentRef || pushResult.paymentRef || "");
  return {
    summary: `${refText ? `${formatPaymentRef(refText)} · ` : ""}${to} reminded ${from} · ${amountText}`,
    detail: `${refText ? `${formatPaymentRef(refText)} · ` : ""}${from} pays ${to} · ${amountText} · ${deliveryText}`,
    metadata: {
      paymentRef: refText,
      from,
      to,
      amount,
      currency,
      reminderSent: sent,
      reminderFailed: failed,
      reminderAttempted: Boolean(pushResult.attempted),
      reminderReason: pushResult.reason || ""
    }
  };
}

function buildPaymentCloseNoticeAuditInfo(settlement, pushResult = {}, paymentRef = "") {
  const from = settlement?.from || "Someone";
  const to = settlement?.to || "someone";
  const amount = Number(settlement?.amount || 0);
  const currency = settlement?.currency || state.currency || "DKK";
  const amountText = formatMoneyFor(amount, currency);
  const sent = Number(pushResult.sent || 0);
  const failed = Number(pushResult.failed || 0);
  const deliveryText = sent > 0
    ? `Mobile notification sent to ${sent} device${sent === 1 ? "" : "s"}`
    : pushResult.attempted
      ? "No active mobile notification subscription was reached"
      : "Close notice recorded in the app; mobile notification was not available";
  const refText = normalizePaymentRefValue(paymentRef || pushResult.paymentRef || "");
  return {
    summary: `Payment ${refText ? formatPaymentRef(refText) : "pay-unknown"} · ${from} still owes ${to} · ${amountText}`,
    detail: `Payment ${refText ? formatPaymentRef(refText) : "pay-unknown"} · ${from} pays ${to} · ${amountText} · Settlement closed while payment was still requested · ${deliveryText}`,
    metadata: {
      paymentRef: refText,
      from,
      to,
      amount,
      currency,
      closeNoticeSent: sent,
      closeNoticeFailed: failed,
      closeNoticeAttempted: Boolean(pushResult.attempted),
      closeNoticeReason: pushResult.reason || "",
      closeNotice: true
    }
  };
}

async function buildSettlementClosedUnpaidNoticeEntries(ledger, period) {
  const requestedPayments = (ledger?.settlements || [])
    .map((settlement) => ({ settlement, key: settlementKey(settlement) }))
    .filter(({ key }) => normalizePaymentStatus(state.paymentStatuses[key]) === "requested");

  if (!requestedPayments.length) return [];

  const entries = [];
  for (const { settlement, key } of requestedPayments) {
    const closedKey = settlementKeyForPeriod({ ...settlement, paymentKey: key }, period?.id || "closed");
    const paymentRef = createPaymentRef({ scope: "closed", key: closedKey, from: settlement.from, to: settlement.to, amount: settlement.amount });
    const pushResult = await sendPaymentCloseNoticePush(settlement, { paymentRef, url: makePaymentDeepLink(paymentRef, { scope: "closed", periodId: period?.id || "" }) }).catch((error) => {
      console.warn("Settlement-close unpaid payment notification failed", error);
      return { attempted: true, sent: 0, failed: 1, reason: error.message || "send-failed" };
    });
    const auditInfo = buildPaymentCloseNoticeAuditInfo(settlement, pushResult, paymentRef);
    entries.push(makeAuditEntry({
      type: "payment_close_notice_sent",
      entityType: "payment",
      entityId: key,
      summary: auditInfo.summary,
      detail: auditInfo.detail,
      metadata: auditInfo.metadata
    }));
  }
  return entries;
}

function makeAuditEntry(options) {
  return auditLog.createEntry({
    actor: currentUser || currentSession?.user?.email || "Unknown",
    ...options
  });
}

function addAuditEntry(options) {
  auditLogDirty = true;
  state.auditLog = auditLog.normalizeAuditEntries([
    makeAuditEntry(options),
    ...(state.auditLog || [])
  ]);
}

function clearCurrentAuditLog() {
  if (!Array.isArray(state.auditLog) || state.auditLog.length === 0) return;
  const bookingEntries = getBookingActivityEntries(state.auditLog);
  if (bookingEntries.length === state.auditLog.length) return;
  auditLogDirty = true;
  state.auditLog = bookingEntries;
}


function getUnpaidPaymentItems(ledger = calculateLedger()) {
  const isAdmin = canManageSettings();
  const isRelevantToCurrentUser = (item) => isAdmin || item.from === currentUser || item.to === currentUser;
  const currentItems = (Array.isArray(ledger.settlements) ? ledger.settlements : [])
    .map((settlement) => {
      const key = settlementKey(settlement);
      const status = normalizePaymentStatus(state.paymentStatuses[key]);
      if (status !== "requested") return null;
      return {
        scope: "current",
        key,
        from: settlement.from,
        to: settlement.to,
        amount: Number(settlement.amount || 0),
        currency: state.currency,
        status,
        label: "Current settlement",
        settlement,
        canMarkPaid: canMarkSettlementPaid(settlement),
        canSendReminder: canManageSettlementRequest(settlement) || isAdmin,
        actionAttrs: `data-payment-key="${escapeHtml(key)}" data-payment-status="paid"`,
        reminderAttrs: `data-payment-key="${escapeHtml(key)}" data-payment-reminder="true"`
      };
    })
    .filter(Boolean);

  const closedItems = (Array.isArray(state.closedPeriods) ? state.closedPeriods : []).flatMap((period) => {
    const settlements = Array.isArray(period.settlements) ? period.settlements : [];
    return settlements.map((settlement, index) => {
      const status = normalizePaymentStatus(settlement.status);
      if (status !== "requested") return null;
      return {
        scope: "closed",
        key: settlementKeyForPeriod(settlement, period.id || "closed"),
        from: settlement.from,
        to: settlement.to,
        amount: Number(settlement.amount || 0),
        currency: period.currency || state.currency,
        status,
        label: period.label || "Closed period",
        closedAt: period.closedAt,
        periodId: period.id,
        settlementIndex: index,
        periodTrips: Array.isArray(period.trips) ? period.trips : [],
        periodFuel: Array.isArray(period.fuel) ? period.fuel : [],
        settlement,
        canMarkPaid: canMarkSettlementPaid(settlement),
        canSendReminder: canManageSettlementRequest(settlement) || isAdmin,
        actionAttrs: `data-closed-period-id="${escapeHtml(period.id)}" data-closed-settlement-index="${index}" data-closed-payment-status="paid"`,
        reminderAttrs: `data-closed-period-id="${escapeHtml(period.id)}" data-closed-settlement-index="${index}" data-payment-reminder="true"`
      };
    }).filter(Boolean);
  });

  return [...currentItems, ...closedItems]
    .map((item) => ({ ...item, paymentRef: createPaymentRef(item) }))
    .filter(isRelevantToCurrentUser)
    .sort((a, b) => {
    if (a.from === currentUser && b.from !== currentUser) return -1;
    if (b.from === currentUser && a.from !== currentUser) return 1;
    if (a.to === currentUser && b.to !== currentUser) return -1;
    if (b.to === currentUser && a.to !== currentUser) return 1;
    return String(b.closedAt || "").localeCompare(String(a.closedAt || ""));
  });
}

function renderUnpaidPayments(ledger = calculateLedger()) {
  if (!els.unpaidPaymentList || !els.unpaidPaymentSummary) return;
  renderPaymentSectionTabs();
  const items = getUnpaidPaymentItems(ledger);
  const mine = items.filter((item) => item.from === currentUser);
  const owedToMe = items.filter((item) => item.to === currentUser && item.from !== currentUser);
  const totalMine = mine.reduce((sum, item) => sum + item.amount, 0);
  const totalOwedToMe = owedToMe.reduce((sum, item) => sum + item.amount, 0);
  const currency = items[0]?.currency || state.currency;
  const selectedItems = activePaymentSection === "owed" ? owedToMe : activePaymentSection === "all" ? items : mine;
  const selectedLabel = activePaymentSection === "owed" ? "owed to you" : activePaymentSection === "all" ? "unpaid payment" : "you owe";

  els.unpaidPaymentSummary.innerHTML = `
    <button type="button" class="unpaid-summary-card ${activePaymentSection === "owe" ? "primary" : ""}" data-payment-section-tab="owe"><span>You owe</span><b>${mine.length} · ${formatMoneyFor(totalMine, currency)}</b></button>
    <button type="button" class="unpaid-summary-card ${activePaymentSection === "owed" ? "primary" : ""}" data-payment-section-tab="owed"><span>Owed to you</span><b>${owedToMe.length} · ${formatMoneyFor(totalOwedToMe, currency)}</b></button>
    <button type="button" class="unpaid-summary-card ${activePaymentSection === "all" ? "primary" : ""}" data-payment-section-tab="all"><span>Total unpaid</span><b>${items.length}</b></button>
  `;
  els.unpaidPaymentSummary.querySelectorAll("[data-payment-section-tab]").forEach((button) => {
    button.addEventListener("click", () => setActivePaymentSection(button.dataset.paymentSectionTab || "all"));
  });

  if (!items.length) {
    els.unpaidPaymentList.replaceChildren(emptyNode("No unpaid requested payments."));
    return;
  }

  if (!selectedItems.length) {
    els.unpaidPaymentList.replaceChildren(emptyNode(`No ${selectedLabel} items right now.`));
    return;
  }

  els.unpaidPaymentList.innerHTML = selectedItems.map((item) => renderUnpaidPaymentCard(item)).join("");
}


function createStableHash(value) {
  const input = String(value || "payment");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

function createPaymentRef(item) {
  // Payment refs should remain stable when an open settlement payment is later
  // archived into a closed period. Do not include the scope in the hash.
  return `#P${createStableHash(`${item?.key || ""}:${item?.from || ""}:${item?.to || ""}:${item?.amount || 0}`)}`;
}

function compactTypedRefValue(value, prefixes = []) {
  let compact = String(value || "").trim().replace(/^#+/, "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  const sortedPrefixes = [...prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (compact.startsWith(prefix)) {
      compact = compact.slice(prefix.length);
      break;
    }
  }
  return compact;
}

function normalizePaymentRefValue(value) {
  const compact = compactTypedRefValue(value, ["PAY", "P"]);
  return compact ? `#P${compact}` : "";
}

function formatPaymentRef(value) {
  const compact = normalizePaymentRefValue(value).replace(/^#P/, "");
  return compact ? `pay-${compact}` : "pay-unknown";
}

function formatSettlementRef(value) {
  const compact = compactTypedRefValue(value, ["SET", "S", "P", "PAY"]);
  return compact ? `set-${compact}` : "set-unknown";
}

function paymentRefEquals(itemOrRef, rawRef) {
  const left = typeof itemOrRef === "string" ? itemOrRef : (itemOrRef?.paymentRef || createPaymentRef(itemOrRef || {}));
  return normalizePaymentRefValue(left) === normalizePaymentRefValue(rawRef);
}

function makePaymentDeepLink(paymentRef, options = {}) {
  const compact = normalizePaymentRefValue(paymentRef).replace(/^#/, "");
  const path = `${window.location.origin}${window.location.pathname}`;
  if (!compact) return path;
  const params = new URLSearchParams();
  params.set("payment", compact);
  if (options.scope) params.set("scope", options.scope);
  if (options.periodId) params.set("period", options.periodId);
  return `${path}#${params.toString()}`;
}


function getPaymentEvidenceSources(payment, options = {}) {
  const trips = Array.isArray(options.trips) ? options.trips : state.trips;
  const fuel = Array.isArray(options.fuel) ? options.fuel : state.fuel;
  const payer = payment?.from || "";
  const payee = payment?.to || "";
  const payerTrips = trips
    .filter((trip) => getTripParticipants(trip).includes(payer))
    .sort(byNewest);
  const payeeFuel = fuel
    .filter((item) => item.payer === payee)
    .sort(byNewest);
  const relatedBookings = payerTrips
    .map((trip) => findBookingForTrip(trip))
    .filter(Boolean);
  return { payerTrips, payeeFuel, relatedBookings };
}

function summarizePaymentEvidence(payment, options = {}) {
  const currency = options.currency || state.currency;
  const { payerTrips, payeeFuel, relatedBookings } = getPaymentEvidenceSources(payment, options);
  const tripKm = payerTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0);
  const fuelTotal = payeeFuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0);
  const bookingCount = new Set(relatedBookings.map((booking) => booking.id || booking.logRef || booking.start)).size;
  return {
    payerTripCount: payerTrips.length,
    payerTripKm: round(tripKm),
    payeeFuelCount: payeeFuel.length,
    payeeFuelTotal: roundMoney(fuelTotal),
    bookingCount,
    currency
  };
}

function renderPaymentEvidenceSummary(payment, options = {}) {
  const summary = summarizePaymentEvidence(payment, options);
  const pieces = [];
  const chargedKm = Number(options.chargedKm || 0);
  const tripTotalText = `${formatNumber(summary.payerTripKm)} km total`;
  const chargedShareText = chargedKm > 0 && Math.abs(chargedKm - summary.payerTripKm) > 0.01
    ? `, ${formatNumber(chargedKm)} km charged share`
    : "";
  pieces.push(`${summary.payerTripCount} trip${summary.payerTripCount === 1 ? "" : "s"} involving ${escapeHtml(payment.from)} (${tripTotalText}${chargedShareText})`);
  pieces.push(`${summary.payeeFuelCount} fuel log${summary.payeeFuelCount === 1 ? "" : "s"} paid by ${escapeHtml(payment.to)} (${formatMoneyFor(summary.payeeFuelTotal, summary.currency)})`);
  if (summary.bookingCount) pieces.push(`${summary.bookingCount} booking-linked trip${summary.bookingCount === 1 ? "" : "s"}`);
  return pieces.join(" · ");
}


function renderSettlementPaymentStory(payment, ledger, options = {}) {
  const currency = options.currency || state.currency;
  const person = optionalRecordValue(ledger?.people, payment.from) || { km: 0, fuelPaid: 0, tripCost: 0, balance: 0 };
  const receiver = optionalRecordValue(ledger?.people, payment.to) || { fuelPaid: 0, tripCost: 0, balance: 0 };
  const payerShareKm = Number(person.km || 0);
  const payerFuelShare = Number(person.tripCost || person.shareCost || 0);
  const receiverFuelPaid = Number(receiver.fuelPaid || 0);
  const direction = normalizePaymentStatus(state.paymentStatuses[settlementKey(payment)]) === "requested"
    ? "Payment requested"
    : "Final payment";
  return `
    <div class="settlement-story">
      <span class="settlement-story-label">${escapeHtml(direction)}</span>
      <p><strong>${escapeHtml(payment.from)}</strong> has a ${formatNumber(payerShareKm)} km distance share in this period. <strong>${escapeHtml(payment.to)}</strong> paid ${formatMoneyFor(receiverFuelPaid, currency)} in fuel. This payment balances ${escapeHtml(payment.from)}'s fuel share against fuel paid by ${escapeHtml(payment.to)}.</p>
      <div class="settlement-mini-metrics" aria-label="Payment calculation summary">
        <span><b>${formatNumber(payerShareKm)} km</b><small>${escapeHtml(payment.from)} distance share</small></span>
        <span><b>${formatMoneyFor(payerFuelShare, currency)}</b><small>${escapeHtml(payment.from)} fuel share</small></span>
        <span><b>${formatMoneyFor(receiverFuelPaid, currency)}</b><small>${escapeHtml(payment.to)} fuel paid</small></span>
      </div>
    </div>
  `;
}

function renderPaymentEvidenceDetails(payment, options = {}) {
  const currency = options.currency || state.currency;
  const { payerTrips, payeeFuel, relatedBookings } = getPaymentEvidenceSources(payment, options);
  const tripItems = payerTrips.slice(0, 8).map((trip) => {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    const booking = findBookingForTrip(trip);
    const bookingText = booking ? ` · booking ${escapeHtml(formatTypedLogRef(booking, "booking"))}${booking.purpose ? ` · ${escapeHtml(booking.purpose)}` : ""}` : "";
    return `<li><span>${escapeHtml(formatTypedLogRef(trip, "trip"))} · ${escapeHtml(getTripPeriodLabel(trip))}${bookingText}</span><b>${formatNumber(km)} km</b></li>`;
  }).join("");
  const hiddenTrips = Math.max(0, payerTrips.length - 8);
  const fuelItems = payeeFuel.slice(0, 8).map((fuel) => {
    const linked = fuel.sourceTripId || fuel.sourceBookingId ? " · linked" : "";
    const liters = Number(fuel.liters || 0) > 0 ? ` · ${formatNumber(fuel.liters)} L` : "";
    return `<li><span>${escapeHtml(formatTypedLogRef(fuel, "fuel"))} · ${escapeHtml(formatDate(fuel.date))}${linked}${fuel.station ? ` · ${escapeHtml(fuel.station)}` : ""}</span><b>${formatMoneyFor(fuel.amount || 0, currency)}${liters}</b></li>`;
  }).join("");
  const hiddenFuel = Math.max(0, payeeFuel.length - 8);
  const bookingRefs = [...new Map(relatedBookings.map((booking) => [booking.id || booking.logRef || booking.start, booking])).values()]
    .slice(0, 6)
    .map((booking) => `<span class="log-ref">${escapeHtml(formatTypedLogRef(booking, "booking"))}${booking.purpose ? ` · ${escapeHtml(booking.purpose)}` : ""}</span>`)
    .join("");
  return `
    <div class="payment-evidence">
      <p class="entry-meta">Payment ${escapeHtml(formatMoneyFor(payment.amount || 0, currency))} balances ${escapeHtml(payment.from)}'s trip share against fuel paid by ${escapeHtml(payment.to)}. It is linked to the period evidence below, not to one single receipt.</p>
      ${bookingRefs ? `<div class="payment-evidence-refs"><strong>Booking links</strong>${bookingRefs}</div>` : ""}
      <div class="payment-evidence-grid">
        <section>
          <h4>Trips counted for ${escapeHtml(payment.from)}</h4>
          ${tripItems ? `<ul class="included-fuel-list payment-evidence-list">${tripItems}${hiddenTrips ? `<li><span>…and ${hiddenTrips} more trip${hiddenTrips === 1 ? "" : "s"}</span><b></b></li>` : ""}</ul>` : `<p class="entry-meta">No trips for ${escapeHtml(payment.from)} in this period.</p>`}
        </section>
        <section>
          <h4>Fuel paid by ${escapeHtml(payment.to)}</h4>
          ${fuelItems ? `<ul class="included-fuel-list payment-evidence-list">${fuelItems}${hiddenFuel ? `<li><span>…and ${hiddenFuel} more fuel log${hiddenFuel === 1 ? "" : "s"}</span><b></b></li>` : ""}</ul>` : `<p class="entry-meta">No fuel logs paid by ${escapeHtml(payment.to)} in this period.</p>`}
        </section>
      </div>
    </div>
  `;
}

function renderUnpaidPaymentCard(item) {
  const isMine = item.from === currentUser;
  const isOwedToMe = item.to === currentUser && item.from !== currentUser;
  const amountText = formatMoneyFor(item.amount, item.currency || state.currency);
  const contextText = item.scope === "closed"
    ? `${item.label} · closed ${item.closedAt ? formatDate(String(item.closedAt).slice(0, 10)) : "date unknown"}`
    : item.label;
  const helperText = item.scope === "closed"
    ? "This updates only the closed-period payment status and change log. The settlement amount stays frozen."
    : "This marks the current requested payment as paid.";
  const action = item.canMarkPaid
    ? `<button class="subtle-button compact-button" type="button" ${item.actionAttrs}>Mark paid</button>`
    : `<span class="request-note">Only ${escapeHtml(item.from)} or an admin can mark this paid.</span>`;
  const archiveLink = item.scope === "closed" && item.periodId
    ? `<button class="subtle-button compact-button secondary-link-button" type="button" data-view-closed-period="${escapeHtml(item.periodId)}">View closed period</button>`
    : "";
  const badge = isMine ? "You owe" : isOwedToMe ? "Owed to you" : "Unpaid";
  const paymentRef = item.paymentRef || createPaymentRef(item);
  const reminderAction = item.canSendReminder && item.reminderAttrs
    ? `<button class="subtle-button compact-button" type="button" ${item.reminderAttrs}>Send reminder</button>`
    : "";

  return `
    <article class="unpaid-payment-card ${isMine ? "is-mine" : ""} ${isOwedToMe ? "is-owed-to-me" : ""}" data-payment-ref="${escapeHtml(normalizePaymentRefValue(paymentRef))}">
      <div class="unpaid-payment-main">
        <div>
          <div class="payment-card-kicker"><span class="status-chip requested">${escapeHtml(badge)}</span><span class="log-ref payment-ref">${escapeHtml(formatPaymentRef(paymentRef))}</span></div>
          <strong>${escapeHtml(item.from)} pays ${escapeHtml(item.to)}</strong>
          <p>${escapeHtml(contextText)}</p>
          <p class="payment-evidence-line">${escapeHtml(renderPaymentEvidenceSummary(item, item.scope === "closed" ? { trips: item.periodTrips || [], fuel: item.periodFuel || [], currency: item.currency || state.currency } : { currency: item.currency || state.currency }))}</p>
        </div>
        <div class="unpaid-payment-amount">
          <b>${amountText}</b>
          <span class="status-chip requested">Requested</span>
        </div>
      </div>
      <div class="unpaid-payment-actions">
        ${action}
        ${reminderAction}
        ${archiveLink}
        <span class="request-note">${escapeHtml(helperText)}</span>
      </div>
    </article>
  `;
}

function isBookingAuditEntry(entry) {
  return entry?.entityType === "booking" || String(entry?.type || "").startsWith("booking_");
}

function getSettlementAuditEntries(entries = state.auditLog) {
  return auditLog.normalizeAuditEntries(entries).filter((entry) => !isBookingAuditEntry(entry));
}

function getBookingActivityEntries(entries = state.auditLog) {
  return auditLog.normalizeAuditEntries(entries).filter(isBookingAuditEntry);
}

function renderAuditEntryCard(entry) {
  if (isBookingAuditEntry(entry)) return renderBookingActivityEntryCard(entry);
  const createdAt = new Date(entry.createdAt);
  const dateText = Number.isNaN(createdAt.getTime())
    ? entry.createdAt
    : `${createdAt.toLocaleDateString()} ${createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return `
    <article class="entry-card audit-entry-card">
      <header>
        <div>
          <strong>${escapeHtml(auditLog.actionLabel(entry.type))}</strong>
          <p>${escapeHtml(entry.summary)}</p>
        </div>
        <span class="entry-meta">${escapeHtml(dateText)}</span>
      </header>
      <p class="entry-meta">By ${escapeHtml(entry.actor)}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ""}</p>
    </article>
  `;
}

function buildBookingAuditMetadata(booking) {
  if (!booking) return {};
  const startMs = bookingStartMs(booking);
  const endMs = bookingEndMs(booking);
  const durationHours = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round(((endMs - startMs) / 36_000) ) / 100
    : 0;
  return {
    logRef: booking.logRef || createLogRef(booking.id),
    member: booking.member || "",
    start: booking.start || "",
    end: booking.end || "",
    period: formatBookingRange(booking),
    durationHours,
    purpose: booking.purpose || "",
    createdBy: booking.createdBy || ""
  };
}

function getBookingActivityContext(entry) {
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const booking = (state.bookings || []).find((item) => item.id === entry.entityId) || null;
  const logRef = metadata.logRef || booking?.logRef || createLogRef(entry.entityId || metadata.start || entry.id);
  const member = booking?.member || metadata.member || parseBookingActivitySummaryPart(entry.summary, 1) || "Driver";
  const period = booking ? formatBookingRange(booking) : metadata.period || parseBookingActivitySummaryPart(entry.summary, 2) || entry.summary || "Period unknown";
  const purpose = booking?.purpose || metadata.purpose || entry.detail || "No purpose added";
  const start = booking?.start || metadata.start || "";
  const end = booking?.end || metadata.end || "";
  const durationHours = booking ? getBookingDurationHours(booking) : Number(metadata.durationHours || 0);
  const relatedTrip = findTripForBooking(entry.entityId);
  const relatedFuel = relatedTrip ? findFullTankFuelForTrip(relatedTrip) || findFuelForTrip(relatedTrip.id) : null;
  return { logRef, member, period, purpose, start, end, durationHours, relatedTrip, relatedFuel };
}

function parseBookingActivitySummaryPart(summary, index) {
  const parts = String(summary || "").split(" · ").map((part) => part.trim()).filter(Boolean);
  return parts[index] || "";
}

function getBookingDurationHours(booking) {
  const startMs = bookingStartMs(booking);
  const endMs = bookingEndMs(booking);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.round(((endMs - startMs) / 36_000)) / 100;
}

function formatDurationHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 24) return `${formatNumber(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round((hours % 24) * 10) / 10;
  return rest ? `${days} d ${formatNumber(rest)} h` : `${days} d`;
}

function renderBookingActivityEntryCard(entry) {
  const createdAt = new Date(entry.createdAt);
  const dateText = Number.isNaN(createdAt.getTime())
    ? entry.createdAt
    : `${createdAt.toLocaleDateString()} ${createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const context = getBookingActivityContext(entry);
  const status = entry.type === "booking_deleted"
    ? "Cancelled"
    : context.relatedTrip
      ? (context.relatedFuel ? "Trip + fuel logged" : "Trip logged")
      : "Booked";
  const tripRef = context.relatedTrip ? formatTypedLogRef(context.relatedTrip, "trip") : "";
  const fuelRef = context.relatedFuel ? formatTypedLogRef(context.relatedFuel, "fuel") : "";
  const lifecycle = context.relatedTrip
    ? `<p class="booking-activity-linked">Linked: trip ${escapeHtml(tripRef)}${fuelRef ? ` · fuel ${escapeHtml(fuelRef)}` : ""}</p>`
    : `<p class="booking-activity-linked muted">No trip logged yet.</p>`;
  return `
    <article class="entry-card audit-entry-card booking-activity-card" data-booking-ref="${escapeHtml(normalizeLogRefValue(context.logRef))}">
      <header class="booking-activity-header">
        <div>
          <div class="booking-activity-kicker">
            <span class="log-ref">${escapeHtml(formatTypedLogRef({ logRef: context.logRef }, "booking"))}</span>
            <span class="status-chip ${context.relatedTrip ? "paid" : "requested"}">${escapeHtml(status)}</span>
          </div>
          <strong>${escapeHtml(auditLog.actionLabel(entry.type))}</strong>
          <p>${escapeHtml(context.member)} · ${escapeHtml(context.period)}</p>
        </div>
        <span class="entry-meta">${escapeHtml(dateText)}</span>
      </header>
      <dl class="booking-activity-details">
        <div><dt>Driver</dt><dd>${escapeHtml(context.member)}</dd></div>
        <div><dt>Duration</dt><dd>${escapeHtml(formatDurationHours(context.durationHours))}</dd></div>
        <div><dt>Purpose</dt><dd>${escapeHtml(context.purpose)}</dd></div>
        <div><dt>Changed by</dt><dd>${escapeHtml(entry.actor)}</dd></div>
      </dl>
      ${entry.detail && entry.type === "booking_updated" ? `<p class="entry-meta">Changes: ${escapeHtml(entry.detail)}</p>` : ""}
      ${lifecycle}
    </article>
  `;
}

function renderBookingActivityLog() {
  if (!els.bookingActivityLog) return;
  const entries = getBookingActivityEntries().slice(0, 40);
  if (!entries.length) {
    els.bookingActivityLog.innerHTML = `<p class="entry-meta">No booking activity yet.</p>`;
    return;
  }

  els.bookingActivityLog.innerHTML = entries.map(renderAuditEntryCard).join("");
}

function renderAuditLog() {
  if (!els.auditLog) return;
  const entries = getSettlementAuditEntries().slice(0, 40);
  if (!entries.length) {
    els.auditLog.innerHTML = `<p class="entry-meta">No important changes have been recorded yet.</p>`;
    return;
  }

  els.auditLog.innerHTML = entries.map(renderAuditEntryCard).join("");
}


function getCurrentWorkspaceContext() {
  const ledgerId = getActiveLedgerId();
  const linkedLedgers = getWorkspaceLedgerOptions();
  const linked = linkedLedgers.find((ledger) => String(ledger.ledger_id || "") === String(ledgerId || "")) || null;
  const label = linked ? getWorkspaceOptionLabel(linked) : String(ledgerId || "current workspace").trim();
  const slug = String(linked?.slug || ledgerId || "").trim();
  const confirmed = Boolean(linked);
  const role = confirmed ? normalizeWorkspaceRole(linked?.role || "member") : "unknown";
  return {
    ledgerId,
    label: label || "Current workspace",
    slug,
    role,
    inviteRequired: linked?.invite_required !== false,
    switchingEnabled: linkedLedgers.length > 1,
    confirmed
  };
}

function getSelectedWorkspaceIdFromUi() {
  // Canonical workspace selection lives in activeLedgerId. The <select> can lag behind
  // during render/startup, so diagnostics must not trust stale DOM values.
  const active = String(getActiveLedgerId() || "").trim();
  if (active) return active;
  return String(els?.activeWorkspace?.value || "").trim() || getConfiguredLedgerId();
}

function getSelectedWorkspaceLabelFromUi() {
  const value = getSelectedWorkspaceIdFromUi();
  return getWorkspaceLabelByLedgerId(value) || value || getCurrentWorkspaceContext().label;
}

function getCurrentWorkspaceLabel() {
  return getCurrentWorkspaceContext().label;
}

function buildDataIoWorkspaceContext(meta = {}) {
  const selectedWorkspaceId = String(meta.selectedWorkspaceId || getSelectedWorkspaceIdFromUi() || getActiveLedgerId() || "").trim();
  const selectedWorkspaceLabel = String(meta.selectedWorkspaceLabel || getSelectedWorkspaceLabelFromUi() || getWorkspaceLabelByLedgerId(selectedWorkspaceId) || selectedWorkspaceId || "Current workspace").trim();
  const session = getWorkspaceSessionSnapshot({
    selectedWorkspaceId,
    selectedWorkspaceLabel,
    loadedWorkspaceId: meta.loadedWorkspaceId,
    loadedWorkspaceLabel: meta.loadedWorkspaceLabel
  });
  const workspaceMismatch = Boolean(meta.workspaceMismatch !== undefined ? meta.workspaceMismatch : session.workspaceMismatch);
  return {
    selectedWorkspaceId: session.selectedWorkspaceId,
    selectedWorkspaceLabel: session.selectedWorkspaceLabel,
    loadedWorkspaceId: session.loadedWorkspaceId,
    loadedWorkspaceLabel: session.loadedWorkspaceLabel,
    workspaceMismatch,
    loadStatus: session.loadStatus,
    workspaceLabel: meta.workspaceLabel || (workspaceMismatch
      ? `${session.selectedWorkspaceLabel} · loaded ${session.loadedWorkspaceLabel}`
      : session.loadedWorkspaceLabel)
  };
}

// Guardrail compatibility: assertActiveWorkspaceDataConfirmed("lookup vehicle information") still guards vehicle lookup before Render calls.
// Guardrail compatibility: resultCode: "WORKSPACE_SWITCHED" remains the stable success code for completed workspace switches.
// Guardrail text: Use the workspace selector to reload this app around another linked workspace.
function renderWorkspaceScopeSummary(ledger = calculateLedger()) {
  const context = getCurrentWorkspaceContext();
  const workspaceConfirmed = isActiveWorkspaceDataConfirmed();
  const workspaceStatusText = activeWorkspaceLoadInProgress
    ? `Loading ${context.label}…`
    : workspaceConfirmed
      ? `Current workspace · ${context.label}`
      : `Workspace not confirmed · ${context.label}`;
  if (els.topbarWorkspaceScope) {
    els.topbarWorkspaceScope.textContent = workspaceStatusText;
  }
  if (!els.workspaceScopeSummary) return;
  const tripCount = Number(Array.isArray(state.trips) ? state.trips.length : 0);
  const fuelCount = Number(Array.isArray(state.fuel) ? state.fuel.length : 0);
  const bookingCount = Number(Array.isArray(state.bookings) ? state.bookings.length : 0);
  els.workspaceScopeSummary.className = "workspace-scope-summary";
  els.workspaceScopeSummary.innerHTML = `
    <div class="workspace-scope-grid">
      <article>
        <span>Workspace</span>
        <strong>${escapeHtml(context.label)}</strong>
        <small>${escapeHtml(context.slug || context.ledgerId)}</small>
      </article>
      <article>
        <span>Current scope</span>
        <strong>Insights are per workspace</strong>
        <small>This view uses only the selected workspace, not every workspace you belong to.</small>
      </article>
      <article>
        <span>Current period</span>
        <strong>${tripCount} trips · ${fuelCount} fuel logs</strong>
        <small>${bookingCount} booking${bookingCount === 1 ? "" : "s"} · ${formatNumber(ledger?.totalKm || 0)} km logged.</small>
      </article>
      <article>
        <span>Workspace status</span>
        <strong>${activeWorkspaceLoadInProgress ? "Loading…" : workspaceConfirmed ? "Loaded and isolated" : "Not confirmed"}</strong>
        <small>${activeWorkspaceLoadInProgress ? "Editing is temporarily locked while this workspace loads." : workspaceConfirmed ? "Actions are scoped to this workspace only." : "Use Sync now before editing so old workspace data cannot bleed into this one."}</small>
      </article>
      <article>
        <span>Workspace session</span>
        <strong>${escapeHtml(getWorkspaceSessionSnapshot().loadStatus)}</strong>
        <small>URL ${escapeHtml(readActiveWorkspaceIdFromCurrentUrl() || "none")} · remembered ${escapeHtml(readScopedRememberedWorkspaceIdForCurrentUser() || "none")} · selected ${escapeHtml(getWorkspaceSessionSnapshot().selectedWorkspaceId || "none")} · loaded ${escapeHtml(getWorkspaceSessionSnapshot().loadedWorkspaceId || "none")}</small>
        <small>Decision: ${escapeHtml(lastWorkspaceResolution.decision || "unknown")} · linked ${escapeHtml(String(getWorkspaceLedgerOptions().length || 0))}</small>
      </article>
    </div>
  `;
}

function render() {
  if (adminUiBatchDepth > 0) {
    adminUiRenderPending = true;
    return;
  }
  document.body.classList.toggle("auth-locked", Boolean(supabaseClient && !currentSession));
  renderSettings();
  renderPeopleSelectors();
  renderTripEstimatorParticipants();
  syncStartOdometerDefault();
  renderTripBookingContext();
  const ledger = calculateLedger();
  renderSettleActionBadge(ledger);
  renderSummary(ledger);
  renderBalances(ledger);
  renderSettlements(ledger);
  renderUnpaidPayments(ledger);
  renderBookings();
  renderPendingLogs();
  renderHistory();
  renderAuditLog();
  renderBookingActivityLog();
  renderClosedPeriods();
  renderTripEstimate();
  renderActiveWorkspaceSelector();
  renderWorkspaceScopeSummary(ledger);
  renderFuelIntelligence(ledger);
  renderStationInsights(ledger);
  renderSmartPredictions(ledger);
  renderMonthlyMemberSummaries(ledger);
  renderSystemHealth(ledger);
  renderDatabaseDiagnosticsPanel(ledger);
  renderMemberManagementPanel();
  renderWorkspaceInvitesPanel();
  renderInviteRedemptionPanel();
  renderMemberProfileSetupPanel();
  renderSupabaseLoadMonitor();
  renderAdminGuardrailOverview();
  renderSyncHealthBanner();
  renderRetentionCleanupSummary();
  renderTestLabReport(null, { persist: false });
  els.resetPeriod.disabled = !canManageSettings() || (state.trips.length === 0 && state.fuel.length === 0);
  els.resetPeriod.classList.toggle("hidden", !canManageSettings());
  els.resetData.disabled = !canManageSettings();
  els.resetData.classList.toggle("hidden", !canManageSettings());
  if (els.dataToolsPanel) els.dataToolsPanel.classList.toggle("hidden", !canUseGlobalAdminTools());
  updateAdvancedAdminToolsUi();
  if (els.systemHealthPanel) els.systemHealthPanel.classList.toggle("hidden", !canUseGlobalAdminTools());
  if (els.databaseDiagnosticsPanel) els.databaseDiagnosticsPanel.classList.toggle("hidden", !canUseGlobalAdminTools());
  if (els.memberManagementPanel) els.memberManagementPanel.classList.toggle("hidden", !canManageSettings());
  if (els.workspaceInvitesPanel) els.workspaceInvitesPanel.classList.toggle("hidden", !currentSession);
  renderSectionNavigation();
  updateEditUi();
}


async function initializeSync() {
  if (supabaseClient) {
    await initializeSupabase();
    return;
  }

  await loadRemoteState();
}

async function initializeSupabase() {
  setSyncStatus("Login");
  const { data } = await supabaseClient.auth.getSession();
  currentSession = data.session;
  if (currentSession) applyWorkspacePreferenceForCurrentUser("initial-session");
  if (currentSession?.user?.email) {
    localStorage.setItem(rememberedLoginEmailKey, currentSession.user.email);
    localStorage.removeItem(pendingLoginEmailKey);
  }
  if (currentSession) beginStartupHydration("initial-session");
  updateAuthUi();
  if (currentSession) {
    await refreshLinkedWorkspacesAfterInvite().catch((error) => console.warn("Initial workspace list refresh failed", error));
    await refreshAuthBoundMemberProfile();
    scheduleWorkspaceInviteRefresh("startup-session");
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;
    if (session) applyWorkspacePreferenceForCurrentUser(`auth-${String(event || "session").toLowerCase()}`);
    initializeInviteDeepLink();
    if (session?.user?.email) {
      localStorage.setItem(rememberedLoginEmailKey, session.user.email);
      localStorage.removeItem(pendingLoginEmailKey);
    }
    if (!session) resetAuthBoundMemberProfile();
    if (session && !lastCloudSyncAt) beginStartupHydration(`auth-${String(event || "session").toLowerCase()}`);
    updateAuthUi();
    if (session) {
      await refreshLinkedWorkspacesAfterInvite().catch((error) => console.warn("Auth workspace list refresh failed", error));
      await refreshAuthBoundMemberProfile();
      scheduleWorkspaceInviteRefresh("auth-session");
      subscribeToLedgerEvents();
      subscribeToSupabaseState();
      const authEvent = String(event || "auth-change").toLowerCase();
      const userKey = String(session.user?.id || session.user?.email || "");
      const now = Date.now();
      const isSameUser = userKey && userKey === lastAuthCloudSyncUserKey;
      const isRefreshOnly = /token_refreshed|user_updated|session_updated|initial_session/.test(authEvent);
      const isSignedInEvent = /signed_in/.test(authEvent);
      const isWithinAuthCooldown = now - Number(lastAuthCloudSyncAt || 0) < supabaseAuthRefreshSyncCooldownMs;
      const isDuplicateAuthEvent = isSameUser && isWithinAuthCooldown && (isRefreshOnly || isSignedInEvent || authEvent === "auth-change");
      if (isDuplicateAuthEvent) {
        recordSupabaseLoadEvent("auth-sync-skip", `${authEvent} cooldown`);
        finishStartupHydration(`auth-skip:${authEvent}`);
        updateAuthUi();
        render();
        return;
      }
      lastAuthCloudSyncUserKey = userKey;
      lastAuthCloudSyncAt = now;
      lastAuthCloudSyncEventAt = now;
      await loadSupabaseStateWithTimeout(
        { force: true, reason: `auth-${authEvent}`, background: Boolean(lastCloudSyncAt) },
        supabaseStartupLoadTimeoutMs,
        "Cloud sync after sign-in is delayed. Retrying in the background."
      );
      finishStartupHydration(`auth-loaded:${authEvent}`);
      updateAuthUi();
      render();
    } else {
      finishStartupHydration("signed-out");
      lastAuthCloudSyncUserKey = "";
      lastAuthCloudSyncAt = 0;
      lastAuthCloudSyncEventAt = 0;
      unsubscribeFromLedgerEvents();
      unsubscribeFromSupabaseState();
    }
  });

  if (currentSession) {
    beginStartupHydration("startup");
    updateAuthUi();
    subscribeToLedgerEvents();
    subscribeToSupabaseState();
    await loadSupabaseStateWithTimeout(
      { force: true, reason: "startup" },
      supabaseStartupLoadTimeoutMs,
      "Startup cloud sync is delayed. Retrying in the background."
    );
    finishStartupHydration("startup-loaded");
    updateAuthUi();
    render();
  }
}

async function loadSupabaseStateWithTimeout(options, timeoutMs, timeoutMessage) {
  let timedOut = false;
  let completed = false;
  let timeoutId = null;
  const reason = String(options?.reason || "cloud-sync");
  const startedAt = Date.now();
  const isBackgroundSync = Boolean(options?.background);
  const isManualSync = Boolean(options?.manual) || /^manual-/.test(reason);
  const isAdminDiagnosticsSync = reason === "manual-admin" || reason === "admin-diagnostics" || /^admin-/.test(reason);
  const shouldShowDelayedStatus = () => {
    if (shouldSuppressStartupHydrationDelay()) return false;
    if (isAdminDiagnosticsSync) return false;
    if (isManualSync) return shouldSurfaceManualSyncDelay(startedAt);
    if (!isBackgroundSync) return true;
    return shouldSurfaceBackgroundSyncDelay(startedAt);
  };
  const timeout = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      if (completed) return;
      timedOut = true;
      markSupabaseLoadTimedOut(`${reason}-timeout`);
      if (shouldShowDelayedStatus()) {
        lastSyncError = timeoutMessage || "Cloud sync is delayed.";
        lastCloudRetryAt = new Date().toISOString();
        setSyncStatus("Delayed");
        render();
        recordSupabaseLoadEvent("cloud-sync-delayed-fallback", timeoutMessage || "cloud sync delayed");
        recordSyncDiagnostic("timeout", timeoutMessage || "Cloud sync timed out.", { reason, timeoutMs, elapsedMs: Date.now() - startedAt });
      } else if (isAdminDiagnosticsSync) {
        restoreHealthySyncStatusAfterQuietSync(`${reason}-diagnostics-timeout`);
        recordSupabaseLoadEvent("admin-diagnostics-timeout", `${reason} timed out after a healthy sync`);
        recordSyncDiagnostic("admin-diagnostics-timeout", `${reason} timed out after a healthy sync. Core app sync remains healthy.`, { reason, timeoutMs, elapsedMs: Date.now() - startedAt });
      } else if (isManualSync) {
        restoreHealthySyncStatusAfterQuietSync(`${reason}-timeout-after-healthy-sync`);
        recordSupabaseLoadEvent("cloud-sync-delayed-manual-quiet", `${reason} timed out after a healthy sync`);
        recordSyncDiagnostic("manual-load-timeout-after-healthy-sync", `${reason} timed out after a healthy sync`, { reason, timeoutMs, elapsedMs: Date.now() - startedAt });
      } else {
        recordSupabaseLoadEvent("cloud-sync-delayed-background", `${reason} timed out after a healthy sync`);
        recordSyncDiagnostic("background-timeout", `${reason} timed out after a healthy sync`, { reason, timeoutMs, elapsedMs: Date.now() - startedAt });
      }
      resolve(false);
    }, timeoutMs);
  });

  const load = loadSupabaseState(options).catch((error) => {
    if (!timedOut) throw error;
    console.warn("Background cloud load failed after timeout", error);
    return false;
  });

  const result = await Promise.race([load, timeout]);
  completed = true;
  if (timeoutId) window.clearTimeout(timeoutId);
  if (result === true) {
    clearSyncDelay(`${reason}-completed`);
    renderSyncHealthBanner();
  }
  if (result === false && !timedOut) {
    if (isAdminDiagnosticsSync && !shouldShowDelayedStatus()) {
      restoreHealthySyncStatusAfterQuietSync(`${reason}-diagnostics-incomplete`);
      recordSupabaseLoadEvent("admin-diagnostics-incomplete", `${reason} returned without a fresh load after a healthy sync`);
      recordSyncDiagnostic("admin-diagnostics-incomplete", `${reason} did not complete. Core app sync remains healthy.`, { reason, elapsedMs: Date.now() - startedAt });
    } else if (isManualSync && !shouldShowDelayedStatus()) {
      restoreHealthySyncStatusAfterQuietSync(`${reason}-incomplete-after-healthy-sync`);
      recordSupabaseLoadEvent("manual-sync-incomplete-quiet", `${reason} returned without a fresh load after a healthy sync`);
      recordSyncDiagnostic("manual-load-incomplete-after-healthy-sync", `${reason} returned without a fresh load after a healthy sync`, { reason, elapsedMs: Date.now() - startedAt });
    } else if (isBackgroundSync && !shouldShowDelayedStatus()) {
      recordSupabaseLoadEvent("background-sync-incomplete", `${reason} returned without a fresh load after a healthy sync`);
      recordSyncDiagnostic("background-incomplete", `${reason} returned without a fresh load after a healthy sync`, { reason, elapsedMs: Date.now() - startedAt });
    } else {
      markCloudSyncDidNotComplete(timeoutMessage || "Cloud sync did not complete.");
    }
  }
  return result;
}

function markCloudSyncDidNotComplete(message = "Cloud sync did not complete.") {
  if (!els.syncStatus || String(els.syncStatus.dataset.status || "") !== "syncing") return;
  lastSyncError = message;
  lastCloudRetryAt = new Date().toISOString();
  setSyncStatus("Delayed");
  renderSupabaseLoadMonitor();
}


window.addEventListener("focus", () => {
  if (!supabaseClient || !currentSession || liveSyncEnabled) return;
  const now = Date.now();
  const recentFocusAttempt = now - Number(lastFocusSyncAttemptAt || 0) < supabaseFocusReloadCooldownMs;
  const recentLoadAttempt = now - Number(lastSupabaseLoadAt || 0) < supabaseFocusReloadCooldownMs;
  const recentHealthySync = hasRecentHealthyCloudSync(now, syncDelayHealthyGraceMs);
  const foregroundWriteActive = hasForegroundWriteInFlight(now);
  if (foregroundWriteActive || recentHealthySync || recentFocusAttempt || recentLoadAttempt) {
    const detail = foregroundWriteActive
      ? "foreground write in progress"
      : recentHealthySync
        ? "recent healthy sync"
        : recentFocusAttempt
          ? "focus attempt cooldown"
          : "cloud load cooldown";
    recordSupabaseLoadEvent("focus-sync-skip", detail);
    recordSyncDiagnostic("focus-sync-skip", `Skipped window-focus refresh during ${detail}.`, { reason: "window-focus", foregroundWriteActive, recentHealthySync, recentFocusAttempt, recentLoadAttempt });
    return;
  }
  lastFocusSyncAttemptAt = now;
  const timeoutMs = hasRecentHealthyCloudSync(now, recentHealthyFocusSyncGraceMs)
    ? Math.max(supabaseStartupLoadTimeoutMs, recentHealthyFocusSyncGraceMs)
    : supabaseStartupLoadTimeoutMs;
  recordSupabaseLoadEvent("focus-sync-start", hasRecentHealthyCloudSync(now) ? "background refresh after healthy sync" : "background refresh without recent healthy sync");
  loadSupabaseStateWithTimeout(
    { reason: "window-focus", background: true },
    timeoutMs,
    "Focus cloud sync is delayed. You can keep using local data."
  ).catch((error) => {
    console.warn("Focus sync failed", error);
  });
});

document.addEventListener("visibilitychange", () => {
  handleRealtimeVisibilityChange();
});

function getPendingLoginInviteCode() {
  return normalizeInviteCodeInput(els.loginInviteCode?.value || localStorage.getItem(pendingWorkspaceInviteCodeKey) || "");
}

function rememberLoginInviteCode() {
  const inviteCode = normalizeInviteCodeInput(els.loginInviteCode?.value || "");
  if (inviteCode) {
    localStorage.setItem(pendingWorkspaceInviteCodeKey, inviteCode);
  } else {
    localStorage.removeItem(pendingWorkspaceInviteCodeKey);
  }
  return inviteCode;
}

function hydrateLoginInviteCodeInput() {
  if (!els.loginInviteCode || currentSession) return;
  const storedInviteCode = normalizeInviteCodeInput(localStorage.getItem(pendingWorkspaceInviteCodeKey) || "");
  if (storedInviteCode && !els.loginInviteCode.value) els.loginInviteCode.value = storedInviteCode;
}

async function verifyLoginInviteEmailBeforeOtp(inviteCode, email) {
  const normalizedInviteCode = normalizeInviteCodeInput(inviteCode);
  const normalizedLoginEmail = normalizeEmail(email);
  if (!normalizedInviteCode) return true;
  if (!supabaseClient) return false;
  const operationId = createDataIoOperationId("invite-email-preflight", "check");
  recordDataIoDiagnostic("start", {
    source: "invite-email-preflight",
    route: "supabase-rpc",
    rpc: "check_ledger_invite_email",
    operation: "check",
    operationId,
    resultCode: "INVITE_EMAIL_PREFLIGHT_STARTED",
    ok: true,
    detail: "Check invite email before sending login code"
  });
  try {
    const { data, error } = await supabaseClient.rpc("check_ledger_invite_email", {
      invite_code: normalizedInviteCode,
      login_email: normalizedLoginEmail
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const allowed = Boolean(result?.allowed);
    const resultCode = String(result?.result_code || (allowed ? "INVITE_EMAIL_ALLOWED" : "INVITE_EMAIL_BLOCKED"));
    const message = String(result?.message || "Invite email check completed.");
    recordDataIoDiagnostic(allowed ? "success" : "error", {
      source: "invite-email-preflight",
      route: "supabase-rpc",
      rpc: "check_ledger_invite_email",
      operation: "check",
      operationId,
      resultCode,
      ok: allowed,
      detail: message
    });
    if (!allowed) {
      els.authMessage.textContent = message;
      showUserError(message);
      return false;
    }
    els.authMessage.textContent = message;
    return true;
  } catch (error) {
    const message = describeInviteEmailPreflightError(error);
    recordDataIoDiagnostic("error", {
      source: "invite-email-preflight",
      route: "supabase-rpc",
      rpc: "check_ledger_invite_email",
      operation: "check",
      operationId,
      resultCode: error?.code || "INVITE_EMAIL_PREFLIGHT_ERROR",
      statusCode: error?.status || "",
      errorCode: error?.code || "INVITE_EMAIL_PREFLIGHT_ERROR",
      ok: false,
      error,
      detail: message
    });
    els.authMessage.textContent = message;
    showUserError(message);
    return false;
  } finally {
    renderSupabaseLoadMonitor();
  }
}

function describeInviteEmailPreflightError(error) {
  const message = String(error?.message || error || "Invite email check failed.");
  if (/check_ledger_invite_email|PGRST202|Could not find the function/i.test(message)) {
    return "Invite email check is not installed yet. Apply migration 037_invite_email_preflight.sql, then try the invite link again.";
  }
  if (/invalid|expired|revoked|already used/i.test(message)) {
    return "Invite code is invalid, expired, revoked, or already used. Ask the workspace admin for a fresh invite.";
  }
  return message;
}

async function redeemPendingLoginInviteAfterSignIn() {
  let pendingInviteCode = "";
  try {
    pendingInviteCode = normalizeInviteCodeInput(localStorage.getItem(pendingWorkspaceInviteCodeKey) || els.loginInviteCode?.value || "");
  } catch (error) {
    console.warn("Could not read pending workspace invite code", error);
    pendingInviteCode = normalizeInviteCodeInput(els.loginInviteCode?.value || "");
  }
  if (!pendingInviteCode) return false;
  els.authMessage.textContent = "Signed in. Redeeming workspace invite...";
  if (els.redeemInviteCode) els.redeemInviteCode.value = pendingInviteCode;
  try {
    const redeemed = await redeemWorkspaceInvite(pendingInviteCode);
    if (redeemed) {
      localStorage.removeItem(pendingWorkspaceInviteCodeKey);
      if (els.loginInviteCode) els.loginInviteCode.value = "";
      els.authMessage.textContent = `Invite accepted. Joined ${getCurrentWorkspaceLabel()}.`;
      return true;
    }
  } catch (error) {
    console.warn("Pending workspace invite redemption failed", error);
  }
  els.authMessage.textContent = "Signed in, but the workspace invite could not be redeemed. Check the invite code below or ask the admin for a fresh invite.";
  return false;
}

function updateAuthUi() {
  const hydrating = isStartupHydrating();
  document.body.classList.toggle("auth-locked", Boolean(supabaseClient && !currentSession));
  document.body.classList.toggle("startup-hydrating", hydrating);

  if (!supabaseClient) {
    els.authPanel.classList.add("hidden");
    document.body.classList.remove("auth-locked");
    document.body.classList.remove("startup-hydrating");
    return;
  }

  const pendingEmail = localStorage.getItem(pendingLoginEmailKey);
  const rememberedEmail = localStorage.getItem(rememberedLoginEmailKey);
  const showOtpForm = Boolean(pendingEmail || loginRequestedFromUrl);
  const authHeading = document.querySelector("#authHeading");
  const authEyebrow = els.authPanel?.querySelector(".eyebrow");

  if (hydrating) {
    els.authPanel.classList.remove("hidden");
    els.loginForm.classList.add("hidden");
    els.otpForm.classList.add("hidden");
    els.signOut.classList.add("hidden");
    if (authEyebrow) authEyebrow.textContent = "Loading";
    if (authHeading) authHeading.textContent = "Loading workspace";
    els.authMessage.textContent = "Your signed-in session is active. Loading workspace data before showing the app.";
    if (!["saving", "syncing"].includes(els.syncStatus.dataset.status || "")) {
      setSyncStatus("Syncing", { source: "startup-hydration" });
    }
    updateLoginCooldown();
    updatePwaUi();
    return;
  }

  if (authEyebrow) authEyebrow.textContent = "Login";
  if (authHeading) authHeading.textContent = "Join the shared car";
  els.authPanel.classList.remove("hidden");
  els.loginForm.classList.toggle("hidden", Boolean(currentSession));
  els.otpForm.classList.toggle("hidden", Boolean(currentSession) || !showOtpForm);
  els.signOut.classList.toggle("hidden", !currentSession);
  if (pendingEmail && !els.loginEmail.value) els.loginEmail.value = pendingEmail;
  if (!pendingEmail && !currentSession) els.loginEmail.value = "";
  hydrateLoginInviteCodeInput();

  const profile = getCurrentMemberProfile();
  const email = getLoggedInEmail();
  els.authMessage.textContent = currentSession
    ? profile
      ? `Signed in as ${email}. If you log out or the session expires, sign in again with this email and a fresh email login code. You do not need the invite link again.`
      : `Signed in as ${email}, but this email is not assigned to a member yet. Ask an admin to add it.`
    : pendingEmail
      ? `Enter the login code sent to ${pendingEmail}.`
      : loginRequestedFromUrl
        ? "Enter your email and the login code from the email."
        : rememberedEmail
          ? "Welcome back. Enter your email to sign in on this device if your saved session has expired."
          : "Enter your email to sign in. If this is your first time, open or paste a workspace invite. Returning users only need email + email login code.";
  if (!currentSession) {
    finishStartupHydration("signed-out");
    setSyncStatus("Login");
  } else if (!["saving", "syncing", "local", "delayed"].includes(els.syncStatus.dataset.status || "")) {
    setSyncStatus(normalizedReadModeActive ? "Tables" : "Cloud");
  }
  updateLoginCooldown();
  updatePwaUi();
}

async function sendLoginLink() {
  if (!supabaseClient) return;

  const email = els.loginEmail.value.trim();
  const inviteCode = rememberLoginInviteCode();
  if (!email) return;

  if (isLoginCoolingDown()) {
    updateLoginCooldown();
    return;
  }

  const inviteEmailAllowed = await verifyLoginInviteEmailBeforeOtp(inviteCode, email);
  if (!inviteEmailAllowed) return;

  startLoginCooldown();

  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] }
  });

  if (error?.status === 429 || error?.message?.toLowerCase().includes("rate limit")) {
    els.authMessage.textContent =
      "Supabase is rate limiting login links. Wait about 60 seconds before trying again.";
    updateLoginCooldown();
    return;
  }

  if (error) {
    els.authMessage.textContent = error.message;
    return;
  }

  localStorage.setItem(pendingLoginEmailKey, email);
  els.otpForm.classList.remove("hidden");
  els.loginCode.focus();
  els.authMessage.textContent = inviteCode
    ? "Invite email accepted. Check your email and enter the email login code. If the invite was restricted to one email, it will only redeem for this exact email."
    : "Check your email and enter the email login code. Returning users do not need an invite link again.";
}

async function verifyLoginCode() {
  if (!supabaseClient) return;

  const email = localStorage.getItem(pendingLoginEmailKey) || els.loginEmail.value.trim();
  const token = els.loginCode.value.trim();

  if (!email || !token) {
    els.authMessage.textContent = "Enter both your email and the login code.";
    return;
  }

  const { data, error } = await supabaseClient.auth.verifyOtp({
    email,
    token,
    type: "email"
  });

  if (error) {
    els.authMessage.textContent = error.message;
    return;
  }

  currentSession = data.session;
  localStorage.setItem(rememberedLoginEmailKey, email);
  localStorage.removeItem(pendingLoginEmailKey);
  els.loginCode.value = "";
  els.authMessage.textContent = "Signed in.";
  updateAuthUi();

  if (currentSession) {
    const redeemedInvite = await redeemPendingLoginInviteAfterSignIn();
    if (!redeemedInvite) {
      await loadSupabaseStateWithTimeout(
        { force: true, reason: "login" },
        supabaseStartupLoadTimeoutMs,
        "Login cloud sync is delayed. You can keep using local data and try again."
      );
    }
  }
}

function startLoginCooldown() {
  const cooldownUntil = Date.now() + 60_000;
  localStorage.setItem(loginCooldownKey, String(cooldownUntil));
  updateLoginCooldown();
}

function isLoginCoolingDown() {
  return Number(localStorage.getItem(loginCooldownKey) || 0) > Date.now();
}

function updateLoginCooldown() {
  window.clearTimeout(loginCooldownTimer);

  if (currentSession || !supabaseClient) {
    els.loginForm.querySelector("button").disabled = false;
    return;
  }

  const cooldownUntil = Number(localStorage.getItem(loginCooldownKey) || 0);
  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const button = els.loginForm.querySelector("button");

  if (secondsLeft <= 0) {
    button.disabled = false;
    button.textContent = "Send login link";
    return;
  }

  button.disabled = true;
  button.textContent = `Wait ${secondsLeft}s`;
  loginCooldownTimer = window.setTimeout(updateLoginCooldown, 1000);
}


function normalizeVehiclePlateInput(value = "") {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

function normalizeVehicleText(value = "", { max = 80, allowUnknown = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!allowUnknown && /^(unknown|ukendt|ingen|ingen norm|n\/a|na|null|undefined|-+)$/i.test(text)) return "";
  return text.slice(0, max);
}

function normalizeVehicleInfo(info) {
  if (!info || typeof info !== "object") return null;
  const consumption = Number(info.consumptionLPer100Km || info.consumption_l_per_100km || info.fuelConsumptionLPer100Km || 0);
  const tank = Number(info.tankCapacityL || info.tank_capacity_l || 0);
  const co2 = Number(info.co2GPerKm || info.co2_g_per_km || 0);
  const engineVolume = Number(info.engineVolumeCc || info.engine_volume_cc || info.engineVolume || info.engine_volume || 0);
  const enginePower = Number(info.enginePowerKw || info.engine_power_kw || info.enginePower || info.engine_power || 0);
  const drivingNoise = Number(info.drivingNoiseDb || info.driving_noise_db || info.drivingNoise || info.driving_noise || 0);
  const motMileage = Number(info.motMileageKm || info.mot_mileage_km || info.motMileage || info.mileage || 0);
  return {
    plate: normalizeVehiclePlateInput(info.plate || info.registrationNumber || info.numberPlate || ""),
    make: normalizeVehicleText(info.make || info.brand || "", { max: 80 }),
    model: normalizeVehicleText(info.model || "", { max: 120 }),
    variant: normalizeVehicleText(info.variant || info.version || "", { max: 120 }),
    fuelType: normalizeVehicleFuelType(info.fuelType || info.fuel_type || info.fuel || ""),
    consumptionLPer100Km: Number.isFinite(consumption) && consumption > 0 ? round(consumption) : "",
    tankCapacityL: Number.isFinite(tank) && tank > 0 ? round(tank) : "",
    co2GPerKm: Number.isFinite(co2) && co2 > 0 ? round(co2) : "",
    year: normalizeVehicleText(info.year || info.modelYear || info.model_year || "", { max: 20 }),
    firstRegDate: normalizeVehicleText(info.firstRegDate || info.first_reg_date || "", { max: 32 }),
    color: normalizeVehicleText(info.color || "", { max: 40 }),
    chassisType: normalizeVehicleText(info.chassisType || info.chassis_type || "", { max: 60 }),
    engineVolumeCc: Number.isFinite(engineVolume) && engineVolume > 0 ? Math.round(engineVolume) : "",
    enginePowerKw: Number.isFinite(enginePower) && enginePower > 0 ? round(enginePower) : "",
    isHybrid: info.isHybrid === true || info.is_hybrid === true,
    euroNorm: normalizeVehicleText(info.euroNorm || info.euro_norm || "", { max: 40 }),
    particleFilter: info.particleFilter === true || info.particleFilter === 1 || info.particle_filter === true || info.particle_filter === 1,
    drivingNoiseDb: Number.isFinite(drivingNoise) && drivingNoise > 0 ? round(drivingNoise) : "",
    motDate: normalizeVehicleText(info.motDate || info.mot_date || "", { max: 32 }),
    motResult: normalizeVehicleText(info.motResult || info.mot_result || "", { max: 80 }),
    motMileageKm: Number.isFinite(motMileage) && motMileage > 0 ? Math.round(motMileage) : "",
    nextInspectionDate: normalizeVehicleText(info.nextInspectionDate || info.next_inspection_date || "", { max: 32 }),
    source: normalizeVehicleText(info.source || "vehicle-lookup", { max: 120, allowUnknown: true }),
    checkedAt: String(info.checkedAt || info.checked_at || "").trim().slice(0, 80)
  };
}

function normalizeVehicleFuelType(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (/diesel/.test(text)) return "diesel";
  if (/95|petrol|benzin|gasoline/.test(text)) return "95";
  if (/electric|elbil|ev/.test(text)) return "electric";
  if (/hybrid/.test(text)) return "hybrid";
  return text.slice(0, 40);
}

function displayVehicleFuelType(value = "") {
  const normalized = normalizeVehicleFuelType(value);
  if (normalized === "95") return "Petrol 95";
  if (normalized === "diesel") return "Diesel";
  if (normalized === "electric") return "Electric";
  if (normalized === "hybrid") return "Hybrid";
  return normalizeVehicleText(value, { max: 40 });
}

function addVehicleFact(facts, value, formatter = null) {
  const raw = typeof formatter === "function" ? formatter(value) : value;
  const text = normalizeVehicleText(raw, { max: 120 });
  if (text) facts.push(text);
}

function getVehicleLookupReadinessSnapshot() {
  const currentSessionActive = Boolean(currentSession);
  const canManage = canManageSettings();
  const workspaceConfirmed = isActiveWorkspaceDataConfirmed();
  const plate = String(state.vehiclePlate || els.vehiclePlate?.value || "").trim();
  let reason = "ready";
  if (!currentSessionActive) reason = "not_signed_in";
  else if (!canManage) reason = "not_workspace_admin";
  else if (!workspaceConfirmed) reason = activeWorkspaceLoadInProgress || supabaseLoadInFlight || startupHydrationActive ? "workspace_loading" : "workspace_not_loaded";
  else if (!plate) reason = "plate_missing";
  return {
    ready: currentSessionActive && canManage && workspaceConfirmed && Boolean(plate),
    buttonEnabled: Boolean(els.vehicleLookupButton && !els.vehicleLookupButton.disabled),
    reason,
    hasSession: currentSessionActive,
    canManageSettings: canManage,
    workspaceConfirmed,
    platePresent: Boolean(plate),
    activeWorkspaceLoadInProgress,
    supabaseLoadInFlight,
    startupHydrationActive,
    session: getWorkspaceSessionSnapshot()
  };
}

function renderVehicleLookupSummary() {
  if (!els.vehicleLookupSummary) return;
  const info = normalizeVehicleInfo(state.vehicleInfo);
  if (!info) {
    els.vehicleLookupSummary.textContent = state.vehiclePlate
      ? "No saved vehicle lookup yet. Manual fuel settings are used."
      : "Optional. Enter a plate and lookup can suggest fuel settings when the Render vehicle API is configured.";
    return;
  }
  const parts = [info.make, info.model, info.variant, info.year].map((part) => normalizeVehicleText(part, { max: 120 })).filter(Boolean).join(" ");
  const facts = [];
  addVehicleFact(facts, info.fuelType, displayVehicleFuelType);
  if (info.isHybrid) facts.push("Hybrid");
  if (info.consumptionLPer100Km) facts.push(`${formatNumber(info.consumptionLPer100Km)} L/100 km`);
  if (info.tankCapacityL) facts.push(`${formatNumber(info.tankCapacityL)} L tank`);
  if (info.co2GPerKm) facts.push(`${formatNumber(info.co2GPerKm)} g CO₂/km`);
  addVehicleFact(facts, info.euroNorm);
  if (info.engineVolumeCc) facts.push(`${formatNumber(info.engineVolumeCc)} cc`);
  if (info.enginePowerKw) facts.push(`${formatNumber(info.enginePowerKw)} kW`);
  addVehicleFact(facts, info.color);
  addVehicleFact(facts, info.chassisType);
  if (info.firstRegDate) facts.push(`first reg ${info.firstRegDate}`);
  if (info.nextInspectionDate) facts.push(`next inspection ${info.nextInspectionDate}`);
  els.vehicleLookupSummary.textContent = `${info.plate || state.vehiclePlate || "Vehicle"}: ${parts || "vehicle details saved"}${facts.length ? ` · ${facts.join(" · ")}` : ""}.`;
}

function applyVehicleLookupToSettings(vehicle) {
  const info = normalizeVehicleInfo(vehicle);
  if (!info) return false;
  state.vehicleInfo = info;
  state.vehiclePlate = info.plate || normalizeVehiclePlateInput(els.vehiclePlate?.value || state.vehiclePlate || "");
  state.vehicleLookupSource = info.source || "vehicle-lookup";
  state.vehicleLookupAt = info.checkedAt || new Date().toISOString();
  if (info.fuelType && info.fuelType !== "electric" && info.fuelType !== "hybrid") state.fuelType = info.fuelType;
  if (info.consumptionLPer100Km) state.fuelConsumption = Math.max(0.1, Number(info.consumptionLPer100Km));
  if (info.tankCapacityL) state.fuelTankCapacity = Math.max(1, Number(info.tankCapacityL));
  if (els.vehiclePlate) els.vehiclePlate.value = state.vehiclePlate;
  if (els.fuelType && state.fuelType) els.fuelType.value = state.fuelType;
  if (els.fuelConsumption) els.fuelConsumption.value = state.fuelConsumption;
  if (els.fuelTankCapacity) els.fuelTankCapacity.value = state.fuelTankCapacity;
  renderVehicleLookupSummary();
  return true;
}

async function lookupVehicleByPlateFromUi() {
  if (!canManageSettings()) {
    showUserError("Only an admin can lookup and apply vehicle settings.");
    return false;
  }
  if (!assertActiveWorkspaceDataConfirmed("lookup vehicle information", "vehicle-lookup")) return false;
  if (!currentSession?.access_token) {
    showUserError("Sign in before looking up a vehicle.");
    return false;
  }
  const plate = normalizeVehiclePlateInput(els.vehiclePlate?.value || state.vehiclePlate || "");
  if (!plate || plate.length < 2) {
    if (els.vehicleLookupStatus) els.vehicleLookupStatus.textContent = "Enter a number plate first.";
    return false;
  }
  const ledgerId = getActiveLedgerId();
  const operationId = createDataIoOperationId("vehicle-lookup", "lookup");
  const workspaceContext = buildDataIoWorkspaceContext();
  const traceMeta = {
    source: "vehicle-lookup",
    route: "render-api",
    endpoint: renderVehicleLookupUrl,
    operation: "lookup",
    operationId,
    ledgerId,
    selectedWorkspaceId: workspaceContext.selectedWorkspaceId,
    selectedWorkspaceLabel: workspaceContext.selectedWorkspaceLabel,
    loadedWorkspaceId: workspaceContext.loadedWorkspaceId,
    loadedWorkspaceLabel: workspaceContext.loadedWorkspaceLabel,
    workspaceMismatch: workspaceContext.workspaceMismatch,
    staleAfterMs: vehicleLookupTimeoutMs,
    detail: `Lookup vehicle ${plate}`
  };
  if (els.vehicleLookupButton) els.vehicleLookupButton.disabled = true;
  if (els.vehicleLookupStatus) els.vehicleLookupStatus.textContent = "Looking up vehicle through Render...";
  if (els.vehicleLookupSummary) els.vehicleLookupSummary.textContent = `Looking up ${plate}…`;
  let shouldRefreshOwnerActivityAfterLookup = true;
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "VEHICLE_LOOKUP_STARTED" });
  try {
    const { result } = await callRenderJson(renderVehicleLookupUrl, {
      method: "POST",
      body: { ledgerId, plate },
      timeoutMs: vehicleLookupTimeoutMs,
      timeoutLabel: "Vehicle lookup",
      allowResultOkFalse: true
    });
    if (!result?.ok) {
      const softError = new Error(result?.message || "Vehicle lookup did not return data.");
      softError.code = result?.code || "VEHICLE_LOOKUP_FAILED";
      softError.resultCode = softError.code;
      softError.payload = result;
      throw softError;
    }
    applyVehicleLookupToSettings(result.vehicle || {});
    const lookedUpVehicleInfo = normalizeVehicleInfo(state.vehicleInfo);
    addAuditEntry({
      type: "vehicle_lookup_completed",
      entityType: "vehicle",
      entityId: plate,
      summary: `${plate} · ${lookedUpVehicleInfo?.make || "Vehicle"} ${lookedUpVehicleInfo?.model || ""}`.trim(),
      detail: [
        lookedUpVehicleInfo?.source ? `Provider: ${lookedUpVehicleInfo.source}` : "",
        lookedUpVehicleInfo?.fuelType ? `Fuel: ${lookedUpVehicleInfo.fuelType}` : "",
        lookedUpVehicleInfo?.consumptionLPer100Km ? `Consumption: ${lookedUpVehicleInfo.consumptionLPer100Km} L/100 km` : "",
        lookedUpVehicleInfo?.firstRegDate ? `First registration: ${lookedUpVehicleInfo.firstRegDate}` : ""
      ].filter(Boolean).join(" · "),
      metadata: {
        plate,
        provider: lookedUpVehicleInfo?.source || "vehicle-lookup",
        hasConsumption: Boolean(lookedUpVehicleInfo?.consumptionLPer100Km)
      }
    });
    saveState({ queueRemote: false, reason: "vehicle lookup local audit breadcrumb" });
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, resultCode: "VEHICLE_LOOKUP_OK", detail: result.message || "Vehicle lookup completed" });
    renderSupabaseLoadMonitor();
    if (els.vehicleLookupStatus) els.vehicleLookupStatus.textContent = "Vehicle lookup found data. Review the suggested fuel settings, then Save settings.";
    return true;
  } catch (error) {
    const payload = error?.payload || {};
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError" || /timed out|timeout/i.test(String(error?.code || error?.resultCode || error?.message || error || ""));
    const code = String(payload?.code || error?.code || error?.status || "");
    const notConfigured = /not configured|VEHICLE_LOOKUP_NOT_CONFIGURED/.test(String(payload?.message || error?.message || error || code));
    const providerUnavailable = /VEHICLE_LOOKUP_PROVIDER_ERROR|VEHICLE_LOOKUP_PROVIDER_UNAVAILABLE|502|503/.test(String(payload?.message || error?.message || error || code));
    const resultCode = timedOut ? "VEHICLE_LOOKUP_TIMEOUT" : notConfigured ? "VEHICLE_LOOKUP_NOT_CONFIGURED" : providerUnavailable ? "VEHICLE_LOOKUP_PROVIDER_UNAVAILABLE" : "VEHICLE_LOOKUP_ERROR";
    shouldRefreshOwnerActivityAfterLookup = !timedOut && !providerUnavailable;
    recordDataIoDiagnostic(timedOut ? "timeout" : notConfigured ? "skipped" : "error", { ...traceMeta, ok: false, error, resultCode, errorCode: code, detail: timedOut ? `Vehicle lookup for ${plate} timed out.` : String(payload?.message || error?.message || error || "Vehicle lookup failed.") });
    const message = notConfigured
      ? "Vehicle lookup API is not configured on Render yet. Keep using manual fuel settings."
      : timedOut
        ? `Vehicle lookup for ${plate} timed out after ${Math.round(vehicleLookupTimeoutMs / 1000)}s. Manual fuel settings are still safe to use. Check Data I/O → Vehicle & settings for the result code.`
        : providerUnavailable
          ? "Vehicle lookup provider is unavailable right now. Keep using manual fuel settings or try again later."
          : `Vehicle lookup failed: ${String(payload?.message || error?.message || error || "Unknown error")}`;
    if (els.vehicleLookupStatus) els.vehicleLookupStatus.textContent = message;
    if (els.vehicleLookupSummary) els.vehicleLookupSummary.textContent = "";
    return false;
  } finally {
    if (els.vehicleLookupButton) els.vehicleLookupButton.disabled = !canManageSettings() || !currentSession || !isActiveWorkspaceDataConfirmed();
    if (shouldRefreshOwnerActivityAfterLookup) {
      maybeRefreshOwnerActivityAfterMemberAction({ reason: "vehicle-lookup", success: true });
    }
    renderSupabaseLoadMonitor();
  }
}

function renderSettings() {
  const canManage = canManageSettings();
  const workspaceConfirmed = isActiveWorkspaceDataConfirmed();
  const canEditSettings = canManage && workspaceConfirmed;

  if (els.settingsPanel) {
    els.settingsPanel.classList.toggle("hidden", !canManage);
  }
  if (canManage && !workspaceConfirmed && els.vehicleLookupStatus) {
    maybeRecordSettingsWorkspaceLocked();
    const session = getWorkspaceSessionSnapshot({
      selectedWorkspaceId: getActiveLedgerId(),
      selectedWorkspaceLabel: getWorkspaceLabelByLedgerId(getActiveLedgerId())
    });
    els.vehicleLookupStatus.textContent = activeWorkspaceLoadInProgress || supabaseLoadInFlight || startupHydrationActive
      ? `Loading ${session.selectedWorkspaceLabel} before settings can be edited…`
      : `${session.selectedWorkspaceLabel} is selected, but ${session.loadedWorkspaceLabel} is still loaded. Use Sync now or switch workspace to retry.`;
  } else if (canManage && workspaceConfirmed && els.vehicleLookupStatus && /Loading .*before settings|settings are locked|Vehicle lookup is blocked/i.test(String(els.vehicleLookupStatus.textContent || ""))) {
    els.vehicleLookupStatus.textContent = "Workspace loaded. Enter a plate to look up vehicle details, or edit settings manually.";
  }

  const isEditingSettings = Boolean(els.settingsForm && els.settingsForm.contains(document.activeElement));
  if (!isEditingSettings) {
    els.currency.value = state.currency;
    if (els.fuelType) els.fuelType.value = state.fuelType || defaults.fuelType;
    if (els.fuelConsumption) els.fuelConsumption.value = state.fuelConsumption || defaults.fuelConsumption;
    if (els.fuelTankCapacity) els.fuelTankCapacity.value = state.fuelTankCapacity || defaults.fuelTankCapacity;
    if (els.fuelFallbackPrice) els.fuelFallbackPrice.value = state.fuelFallbackPrice || defaults.fuelFallbackPrice;
    const fuelPriceRange = getFuelPriceWarningRange(state);
    if (els.fuelPriceWarningMin) els.fuelPriceWarningMin.value = fuelPriceRange.minDkkPerLiter;
    if (els.fuelPriceWarningMax) els.fuelPriceWarningMax.value = fuelPriceRange.maxDkkPerLiter;
    if (els.fuelWarningThreshold) els.fuelWarningThreshold.value = state.fuelWarningThreshold || defaults.fuelWarningThreshold;
    if (els.vehiclePlate) els.vehiclePlate.value = state.vehiclePlate || "";
    renderVehicleLookupSummary();
  }
  if (!isEditingSettings) {
    if (els.paymentRemindersEnabled) els.paymentRemindersEnabled.checked = state.paymentRemindersEnabled !== false;
    if (els.paymentReminderAfterDays) els.paymentReminderAfterDays.value = Number.isFinite(Number(state.paymentReminderAfterDays)) ? Number(state.paymentReminderAfterDays) : defaults.paymentReminderAfterDays;
    if (els.paymentReminderRepeatDays) els.paymentReminderRepeatDays.value = Math.max(1, Number(state.paymentReminderRepeatDays) || defaults.paymentReminderRepeatDays);
    if (els.paymentReminderMaxCount) els.paymentReminderMaxCount.value = Math.max(1, Number(state.paymentReminderMaxCount) || defaults.paymentReminderMaxCount);
    els.members.value = state.members
      .map((name) => {
        const profile = getMemberProfile(name);
        return [name, profile.email, profile.role === "admin" ? "admin" : ""]
          .filter(Boolean)
          .join(" | ");
      })
      .join("\n");
  }

  els.currency.disabled = !canEditSettings;
  if (els.fuelType) els.fuelType.disabled = !canEditSettings;
  if (els.fuelConsumption) els.fuelConsumption.disabled = !canEditSettings;
  if (els.fuelTankCapacity) els.fuelTankCapacity.disabled = !canEditSettings;
  if (els.fuelFallbackPrice) els.fuelFallbackPrice.disabled = !canEditSettings;
  if (els.fuelPriceWarningMin) els.fuelPriceWarningMin.disabled = !canEditSettings;
  if (els.fuelPriceWarningMax) els.fuelPriceWarningMax.disabled = !canEditSettings;
  if (els.fuelWarningThreshold) els.fuelWarningThreshold.disabled = !canEditSettings;
  if (els.vehiclePlate) els.vehiclePlate.disabled = !canEditSettings;
  if (els.vehicleLookupButton) els.vehicleLookupButton.disabled = !canEditSettings || !currentSession;
  if (els.paymentRemindersEnabled) els.paymentRemindersEnabled.disabled = !canEditSettings;
  if (els.paymentReminderAfterDays) els.paymentReminderAfterDays.disabled = !canEditSettings;
  if (els.paymentReminderRepeatDays) els.paymentReminderRepeatDays.disabled = !canEditSettings;
  if (els.paymentReminderMaxCount) els.paymentReminderMaxCount.disabled = !canEditSettings;
  els.members.disabled = !canEditSettings;
  els.settingsForm.querySelector("button").disabled = !canEditSettings;
}

function getActiveSettlementRequestLock() {
  const ledger = calculateLedger();
  const lockedSettlements = ledger.settlements
    .map((settlement) => ({
      ...settlement,
      status: normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)])
    }))
    .filter((settlement) => settlement.status === "requested" || settlement.status === "paid");

  return {
    lockedSettlements,
    count: lockedSettlements.length,
    requestedCount: lockedSettlements.filter((settlement) => settlement.status === "requested").length,
    paidCount: lockedSettlements.filter((settlement) => settlement.status === "paid").length,
    amount: roundMoney(lockedSettlements.reduce((total, settlement) => total + Number(settlement.amount || 0), 0))
  };
}

function isCurrentPeriodLockedForNewEntries() {
  return getActiveSettlementRequestLock().count > 0;
}

function getPeriodEntryLockMessage() {
  const lock = getActiveSettlementRequestLock();
  if (!lock.count) return "";
  const paymentWord = lock.count === 1 ? "payment" : "payments";
  const statusParts = [
    lock.requestedCount ? `${lock.requestedCount} requested` : "",
    lock.paidCount ? `${lock.paidCount} paid` : ""
  ].filter(Boolean).join(", ");
  return `This settlement period has ${lock.count} active ${paymentWord} (${statusParts}, ${formatMoney(lock.amount)}). Reopen the active payment${lock.count === 1 ? "" : "s"} before changing trips, fuel logs, or amounts that affect the settlement.`;
}

function assertCurrentPeriodAllowsMoneyChanges(action = "change this period") {
  if (!isCurrentPeriodLockedForNewEntries()) return true;
  const message = getPeriodEntryLockMessage();
  showAppMessage(message, "warning", { timeoutMs: 6500 });
  showUserError(message);
  renderPeriodEntryLock();
  return false;
}

function assertCurrentPeriodAllowsNewEntries() {
  return assertCurrentPeriodAllowsMoneyChanges("log new trips or fuel");
}

function renderPeriodEntryLock() {
  if (!els.periodEntryLock) return;
  const message = getPeriodEntryLockMessage();
  els.periodEntryLock.classList.toggle("hidden", !message);
  els.periodEntryLock.innerHTML = message
    ? `<p class="eyebrow">Period locked</p><h2>Reopen payment requests before changing this period</h2><p class="section-note">${escapeHtml(message)}</p><p class="section-note">To correct an entry, reopen the requested/paid settlement first, then use History → Edit on your current-period log.</p>`
    : "";
}

function buildSyncHealthBannerState() {
  clearRecoverableSyncDelayAfterHealthySync("render-banner-after-healthy-sync");

  if (isStartupHydrating() || shouldSuppressStartupHydrationDelay()) {
    return null;
  }

  if (supabaseClient && !currentSession) {
    return {
      level: "warning",
      title: "Sign in to sync",
      message: pendingLocalChanges > 0
        ? `${pendingLocalChanges} local change${pendingLocalChanges === 1 ? "" : "s"} saved on this device only. Sign in before switching devices.`
        : "This device is using local data until you sign in.",
      action: "Sign in above"
    };
  }

  if (lastSyncError) {
    return {
      level: "error",
      title: "Sync delayed",
      message: `${lastSyncError} Changes are kept on this device and will be retried.`,
      action: "Tap Sync now",
      diagnostics: latestSyncDiagnostics(4)
    };
  }

  if (pendingLocalChanges > 0) {
    return {
      level: "warning",
      title: "Unsynced local changes",
      message: `${pendingLocalChanges} change${pendingLocalChanges === 1 ? " is" : "s are"} saved locally and waiting to sync.`,
      action: "Tap Sync now"
    };
  }

  if (supabaseClient && currentSession && normalizedTableStatus?.checked && normalizedTableStatus.ok === false) {
    return {
      level: "warning",
      title: "Database fallback active",
      message: "The app is using the JSON fallback because normalized table health is degraded.",
      action: "Admin can check diagnostics"
    };
  }

  return null;
}

function renderSyncHealthBanner() {
  if (!els.syncHealthBanner) return;
  const banner = buildSyncHealthBannerState();
  els.syncHealthBanner.classList.toggle("hidden", !banner);
  if (!banner) {
    els.syncHealthBanner.innerHTML = "";
    delete els.syncHealthBanner.dataset.level;
    return;
  }

  els.syncHealthBanner.dataset.level = banner.level;
  els.syncHealthBanner.innerHTML = `
    <div>
      <strong>${escapeHtml(banner.title)}</strong>
      <p>${escapeHtml(banner.message)}</p>
    </div>
    <button class="subtle-button compact-button" type="button" data-sync-health-action>${escapeHtml(banner.action)}</button>
    ${banner.diagnostics?.length ? `
      <details class="sync-diagnostics-details">
        <summary>Show sync details</summary>
        <ul>
          ${banner.diagnostics.map((entry) => `<li><strong>${escapeHtml(entry.stage)}</strong> · ${escapeHtml(new Date(entry.at).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}: ${escapeHtml(entry.detail || entry.error?.message || "No detail")}<br><small>${escapeHtml([entry.error?.code ? `code ${entry.error.code}` : "", entry.error?.hint ? `hint: ${entry.error.hint}` : "", entry.online === false ? "browser reports offline" : "", entry.normalizedTableOk === false ? "normalized tables not healthy" : ""].filter(Boolean).join(" · "))}</small></li>`).join("")}
        </ul>
      </details>
    ` : ""}
  `;
}

function focusSyncHealthAction() {
  if (supabaseClient && !currentSession && els.loginEmail) {
    setActiveView("log");
    els.loginEmail.focus();
    return;
  }
  handleManualSyncNow("banner").catch((error) => {
    console.warn("Sync health action failed", error);
  });
}

function renderLogEntryPanelsVisibility() {
  const locked = isCurrentPeriodLockedForNewEntries();
  if (els.tripLogPanel) els.tripLogPanel.classList.toggle("hidden", locked);
  if (els.fuelLogPanel) els.fuelLogPanel.classList.toggle("hidden", locked);
}

function renderPeopleSelectors() {
  const stateNames = getMemberNames();
  const profile = getCurrentMemberProfile();
  const displayProfile = currentSession ? getSignedInDisplayProfile() : null;
  const loggedIn = Boolean(currentSession);
  const knownLoggedInMember = Boolean(profile && !profile.pendingInvite);
  const displayName = displayProfile?.name || "";
  const names = displayName && !stateNames.includes(displayName) ? [displayName, ...stateNames] : stateNames;

  if (loggedIn) {
    currentUser = displayName;
  } else if (!stateNames.includes(currentUser)) {
    currentUser = stateNames[0] || "";
  }
  if (currentUser) localStorage.setItem(userKey, currentUser);

  const options = names
    .map((member) => `<option value="${escapeHtml(member)}">${escapeHtml(member)}</option>`)
    .join("");
  els.tripDriver.innerHTML = options;
  if (els.bookingMember) els.bookingMember.innerHTML = options;
  els.fuelPayer.innerHTML = options;
  els.currentUser.innerHTML = options;

  if (currentUser) {
    els.currentUser.value = currentUser;
    els.tripDriver.value = currentUser;
    if (els.bookingMember) els.bookingMember.value = currentUser;
    els.fuelPayer.value = currentUser;
  }

  const authRequired = Boolean(supabaseClient);
  const canUse = !authRequired || (loggedIn && knownLoggedInMember);
  const periodLocked = isCurrentPeriodLockedForNewEntries();
  const canLogEntries = canUse && !periodLocked;
  const lockToLoggedInUser = authRequired || loggedIn;
  els.currentUser.disabled = lockToLoggedInUser;
  els.tripDriver.disabled = lockToLoggedInUser || periodLocked;
  els.fuelPayer.disabled = lockToLoggedInUser || periodLocked;

  setFormDisabled(els.tripForm, !canLogEntries);
  if (els.bookingForm) setFormDisabled(els.bookingForm, !canUse);
  setFormDisabled(els.fuelForm, !canLogEntries);
  if (els.bookingMember) els.bookingMember.disabled = !canUse || lockToLoggedInUser;
  renderPeriodEntryLock();
  renderLogEntryPanelsVisibility();

  renderParticipantOptions();
}

function setFormDisabled(form, disabled) {
  for (const control of form.querySelectorAll("input, select, textarea, button")) {
    control.disabled = disabled;
  }
}

function renderParticipantOptions() {
  const disabledAttr = canUseAppAsMember() ? "" : " disabled";
  els.tripParticipants.innerHTML = state.members
    .map(
      (member) => `
        <label class="participant-option">
          <input type="checkbox" value="${escapeHtml(member)}" data-participant="${escapeHtml(member)}" checked${disabledAttr} />
          <span>${escapeHtml(member)}</span>
        </label>
      `
    )
    .join("");
  ensureSelectedTripDriverParticipant();
}

function ensureSelectedTripDriverParticipant() {
  const driver = els.tripDriver?.value;
  if (!driver || !els.tripParticipants) return false;
  const driverCheckbox = els.tripParticipants.querySelector(
    `[data-participant="${cssEscape(driver)}"]`
  );
  if (!driverCheckbox) return false;
  driverCheckbox.checked = true;
  return true;
}

function renderTripEstimatorParticipants() {
  if (!els.tripEstimatorParticipants) return;

  const members = getMemberNames();
  const existing = TripActions.getCheckedCheckboxValues(els.tripEstimatorParticipants);
  const profile = getCurrentMemberProfile();
  const fallback = profile?.name ? [profile.name] : members;
  const defaultSelection = new Set(TripActions.normalizeTripParticipantSelection(members, existing, fallback));

  els.tripEstimatorParticipants.innerHTML = members
    .map((member) => `
      <label class="participant-option">
        <input type="checkbox" value="${escapeHtml(member)}" ${defaultSelection.has(member) ? "checked" : ""} />
        <span>${escapeHtml(member)}</span>
      </label>
    `)
    .join("");
}

function getTripEstimatorParticipants() {
  return TripActions.getCheckedCheckboxValues(els.tripEstimatorParticipants);
}

function renderTripEstimate() {
  if (!els.tripEstimateResult || !els.tripEstimateDistance) return;

  if (supabaseClient && !currentSession) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Sign in to estimate trip costs.";
    return;
  }

  const distance = Number(els.tripEstimateDistance.value || 0);
  const participants = getTripEstimatorParticipants();

  if (distance <= 0) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Enter a distance to estimate the fuel cost.";
    return;
  }

  if (participants.length === 0) {
    els.tripEstimateResult.className = "trip-estimate-result empty-state";
    els.tripEstimateResult.textContent = "Choose at least one person joining the trip.";
    return;
  }

  const estimate = calculateTripCostEstimate(distance, participants.length);
  const refuel = estimate.refuel || buildRefuelPlanning(distance);
  const route = getTripPlannerRoute();
  const routeUrl = getRouteMapUrl(route);
  const routeLink = routeUrl
    ? `<a class="route-map-link" href="${escapeHtml(routeUrl)}" target="_blank" rel="noopener">Open driving route in maps</a>`
    : "";
  const routeGuidance = buildRouteRefuelGuidance(route, refuel);
  const stationSuggestion = refuel.stationCandidates?.length
    ? `<div class="trip-refuel-stations"><strong>Logged stations to consider</strong>${refuel.stationCandidates.map((station) => `
        <a href="${escapeHtml(getStationMapUrl(station))}" target="_blank" rel="noopener">
          <span>${escapeHtml(station.name)}</span>
          <small>${formatMoneyFor(station.avgPrice, state.currency)}/L · ${station.logCount} log${station.logCount === 1 ? "" : "s"}${station.coordinates ? " · map ready" : ""}</small>
        </a>`).join("")}</div>`
    : `<p class="entry-meta">Add station/place to fuel logs to get station suggestions.</p>`;
  els.tripEstimateResult.className = "trip-estimate-result";
  els.tripEstimateResult.innerHTML = `
    <div class="trip-estimate-cards">
      <article>
        <span>Estimated fuel cost</span>
        <strong>${formatMoney(estimate.totalCost)}</strong>
      </article>
      <article>
        <span>Per person</span>
        <strong>${formatMoney(estimate.perPerson)}</strong>
      </article>
      <article>
        <span>Estimated liters</span>
        <strong>${formatNumber(refuel.plannedLiters)} L</strong>
      </article>
      <article>
        <span>${refuel.latestFuelOdometer ? "Range after trip" : "Full-tank range"}</span>
        <strong>${refuel.latestFuelOdometer ? `${formatNumber(refuel.projectedRangeRemaining)} km left` : `${formatNumber(refuel.fullTankRange)} km full`}</strong>
      </article>
      <article>
        <span>Tank capacity</span>
        <strong>${formatNumber(refuel.tankCapacity)} L</strong>
      </article>
      <article>
        <span>People</span>
        <strong>${participants.length}</strong>
      </article>
    </div>
    <p>${escapeHtml(estimate.explanation)}</p>
    <div class="trip-refuel-note ${refuel.tone === "warning" ? "is-warning" : ""}">
      <strong>Hypothetical refuel planning</strong>
      <span>${escapeHtml(refuel.recommendation)}</span>
    </div>
    <div class="trip-plan-actions">
      <button class="subtle-button compact-button" type="button" data-use-plan-for-booking="true">Use this estimate for booking</button>
      <small>This stays a calculator until you save it as an actual booking.</small>
    </div>
    <div class="trip-route-note">
      <strong>${route.hasRoute ? "Route helper" : "Optional route helper"}</strong>
      <span>${escapeHtml(routeGuidance)}</span>
      ${routeLink}
    </div>
    ${stationSuggestion}
    <small>${escapeHtml(participants.join(", "))}</small>
  `;
}


function buildFuelIntelligence(ledger) {
  const stats = ledger.historicalFuelStats || calculateHistoricalFuelStats({ currentTrips: state.trips, currentFuel: state.fuel });
  const tripCount = state.trips.length + state.closedPeriods.reduce((sum, period) => sum + (Array.isArray(period.trips) ? period.trips.length : 0), 0);
  const fuelLogCount = state.fuel.length + state.closedPeriods.reduce((sum, period) => sum + (Array.isArray(period.fuel) ? period.fuel.length : 0), 0);
  const logsWithLiters = Number(stats.fuelLogsWithLiters || 0);
  const km = Number(stats.totalTripKm || 0);
  const fallbackConsumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && Number(latestFuelPrice.price) > 0 ? Number(latestFuelPrice.price) : 0;
  const hasHistoricalCost = stats.costPerKm > 0 && km >= 50;
  const hasHistoricalConsumption = stats.litersPer100Km > 0 && logsWithLiters > 0;
  const consumptionLooksRealistic = !hasHistoricalConsumption || (stats.litersPer100Km >= 3 && stats.litersPer100Km <= 10);
  const canUseHistoricalForPlanning = hasHistoricalCost && consumptionLooksRealistic;
  const confidenceScore = [km >= 500, km >= 1500, logsWithLiters >= 3, logsWithLiters >= 8, Number(stats.periodsWithTripKm || 0) >= 2, consumptionLooksRealistic].filter(Boolean).length;
  const confidence = confidenceScore >= 5 ? "High" : confidenceScore >= 3 ? "Medium" : "Low";
  const confidenceClass = canUseHistoricalForPlanning && confidence === "High" ? "ok" : confidence === "Low" ? "issue" : "warning";
  const estimateSource = canUseHistoricalForPlanning
    ? "Historical fuel cost per km"
    : livePrice
      ? "Car setting + live diesel reference price"
      : "Car setting + fallback fuel price";
  const effectiveConsumption = canUseHistoricalForPlanning && stats.litersPer100Km > 0 ? stats.litersPer100Km : fallbackConsumption;
  const effectivePrice = stats.pricePerLiter > 0 ? stats.pricePerLiter : Number(livePrice || fallbackPrice);
  const planningCostPerKm = canUseHistoricalForPlanning
    ? stats.costPerKm
    : (effectiveConsumption / 100) * effectivePrice;
  const warnings = [];
  if (tripCount === 0) warnings.push("Add trips to learn cost per km.");
  if (fuelLogCount === 0) warnings.push("Add fuel receipts to learn real fuel cost.");
  if (fuelLogCount > 0 && logsWithLiters === 0) warnings.push("Add liters on fuel receipts to learn DKK/L and L/100 km.");
  if (hasHistoricalConsumption && !consumptionLooksRealistic) {
    warnings.push(`Historical consumption looks unusual: ${formatNumber(stats.litersPer100Km)} L/100 km, so the booking estimate uses the car setting (${formatNumber(fallbackConsumption)} L/100 km) instead.`);
  }
  return {
    stats,
    tripCount,
    fuelLogCount,
    logsWithLiters,
    confidence,
    confidenceClass,
    estimateSource,
    effectiveConsumption,
    effectivePrice,
    planningCostPerKm,
    canUseHistoricalForPlanning,
    consumptionLooksRealistic,
    warnings
  };
}

function renderFuelIntelligence(ledger) {
  if (!els.fuelIntelligence) return;
  const intel = buildFuelIntelligence(ledger);
  const stats = intel.stats;
  const hasData = intel.tripCount > 0 || intel.fuelLogCount > 0;

  if (!hasData) {
    els.fuelIntelligence.className = "fuel-intelligence empty-state";
    els.fuelIntelligence.textContent = "Add trips and fuel receipts to build fuel intelligence.";
    return;
  }

  els.fuelIntelligence.className = "fuel-intelligence";
  els.fuelIntelligence.innerHTML = `
    <div class="fuel-intelligence-grid">
      <article>
        <span>Confidence</span>
        <strong><span class="status-pill status-${intel.confidenceClass === "ok" ? "ok" : "warning"}">${intel.confidence}</span></strong>
        <small>Based on ${formatNumber(stats.totalTripKm || 0)} km and ${intel.logsWithLiters} fuel log${intel.logsWithLiters === 1 ? "" : "s"} with liters.</small>
      </article>
      <article>
        <span>Planning source</span>
        <strong>${escapeHtml(intel.estimateSource)}</strong>
        <small>${intel.canUseHistoricalForPlanning ? "The trip estimator trusts the historical average." : "The trip estimator is avoiding unusual historical data."}</small>
      </article>
      <article>
        <span>Planning cost</span>
        <strong>${intel.planningCostPerKm > 0 ? `${formatMoneyFor(intel.planningCostPerKm, state.currency)}/km` : "Not enough data"}</strong>
        <small>${intel.canUseHistoricalForPlanning ? `${formatMoneyFor(stats.totalPaid, state.currency)} historical fuel across ${formatNumber(stats.totalTripKm)} km.` : `${formatNumber(intel.effectiveConsumption)} L/100 km × ${formatMoneyFor(intel.effectivePrice, state.currency)}/L.`}</small>
      </article>
      <article>
        <span>Fuel price</span>
        <strong>${stats.pricePerLiter > 0 ? `${formatMoneyFor(stats.pricePerLiter, state.currency)}/L` : `${formatMoneyFor(intel.effectivePrice, state.currency)}/L`}</strong>
        <small>${stats.pricePerLiter > 0 ? "Receipt average." : latestFuelPrice?.price ? "Live reference price." : "Fallback setting."}</small>
      </article>
      <article>
        <span>Consumption</span>
        <strong>${stats.litersPer100Km > 0 ? `${formatNumber(stats.litersPer100Km)} L/100 km` : `${formatNumber(intel.effectiveConsumption)} L/100 km`}</strong>
        <small>${stats.kmPerLiter > 0 ? `${formatNumber(stats.kmPerLiter)} km/L from receipts.` : "Using car setting until enough liters are logged."}</small>
      </article>
      <article>
        <span>Data set</span>
        <strong>${intel.tripCount} trips · ${intel.fuelLogCount} fuel logs</strong>
        <small>${Number(stats.periodsWithTripKm || 0)} period${Number(stats.periodsWithTripKm || 0) === 1 ? "" : "s"} with distance.</small>
      </article>
    </div>
    ${intel.warnings.length ? `<div class="fuel-intelligence-notes"><strong>Data notes</strong><ul>${intel.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
  `;
}


function getAllFuelLogsForInsights() {
  const rows = [];
  state.fuel.forEach((fuel) => rows.push({ ...fuel, periodLabel: "Current period", periodStatus: "open" }));
  state.closedPeriods.forEach((period) => {
    const label = period.label || period.closedAt || "Closed period";
    (Array.isArray(period.fuel) ? period.fuel : []).forEach((fuel) => rows.push({ ...fuel, periodLabel: label, periodStatus: "closed" }));
  });
  return rows;
}

function getFuelStationName(fuel) {
  return String(fuel.station || fuel.stationName || fuel.station_name || "").trim();
}

function getFuelStationBrand(fuel) {
  return String(fuel.stationBrand || fuel.brand || fuel.station_brand || "").trim();
}

function getFuelStationCoordinates(fuel) {
  const info = fuel.stationInfo || {};
  const latitude = Number(info.latitude ?? fuel.stationLat ?? fuel.station_lat ?? fuel.stationLatitude ?? 0);
  const longitude = Number(info.longitude ?? fuel.stationLng ?? fuel.station_lng ?? fuel.stationLongitude ?? 0);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude === 0 || longitude === 0) return null;
  return { latitude, longitude };
}

function getStationMapUrl(station) {
  const coords = station.coordinates || null;
  if (coords) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coords.latitude},${coords.longitude}`)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${station.name || "fuel station"} ${station.brand || ""}`.trim())}`;
}


function getTripPlannerRoute() {
  return TripActions.readPlannerRoute(els.tripEstimateStart?.value || "", els.tripEstimateDestination?.value || "");
}

function getRouteMapUrl(route) {
  return TripActions.buildRouteMapUrl(route);
}

function useTripPlanForBooking() {
  if (!els.tripEstimateDistance || !els.bookingPurpose || !els.bookingStart || !els.bookingEnd) return;
  const distanceKm = Number(els.tripEstimateDistance.value || 0);
  if (!(distanceKm > 0)) {
    showAppMessage("Enter a planned distance before turning the plan into a booking.");
    return;
  }
  const route = getTripPlannerRoute();
  const participants = getTripEstimatorParticipants();
  const routeLabel = route.hasRoute ? `${route.start} → ${route.destination}` : "Planned trip";
  tripPlannerBookingDraft = {
    distanceKm,
    routeFrom: route.start || "",
    routeTo: route.destination || "",
    participants
  };
  const existingPurpose = els.bookingPurpose.value.trim();
  const estimateText = `${routeLabel} · ${formatNumber(distanceKm)} km estimate`;
  els.bookingPurpose.value = existingPurpose || estimateText;
  setBookingCalendarAnchor(els.bookingStart.value || localDateString());
  updateBookingAvailabilityPreview();
  renderBookings();
  render();
  els.bookingPurpose.scrollIntoView({ behavior: "smooth", block: "center" });
  els.bookingPurpose.focus({ preventScroll: true });
  showAppMessage("Plan copied to the booking form. Choose the booking time and click Add booking to save it.");
}

function buildRouteRefuelGuidance(route, refuel) {
  if (!route?.hasRoute) {
    return "Add start and destination to get a map route link. Station suggestions still come from your logged receipt history.";
  }
  const stationCount = refuel.stationCandidates?.length || 0;
  return `Route link ready: ${route.start} → ${route.destination}. ${stationCount ? "Use the station cards to compare your logged stations, then open map links and decide whether they fit the route." : "Add station/place to fuel logs to get reusable station suggestions."}`;
}

function getFuelPricePerLiter(fuel) {
  const amount = Number(fuel.amount) || 0;
  const liters = Number(fuel.liters) || 0;
  const explicit = Number(fuel.pricePerLiter || fuel.price_per_liter) || 0;
  if (explicit > 0) return explicit;
  if (amount > 0 && liters > 0) return amount / liters;
  return 0;
}

function buildStationInsights() {
  const fuelLogs = getAllFuelLogsForInsights();
  const withStation = fuelLogs.filter((fuel) => getFuelStationName(fuel));
  const usable = withStation.filter((fuel) => Number(fuel.amount) > 0 && Number(fuel.liters) > 0);
  const groups = new Map();

  usable.forEach((fuel) => {
    const name = getFuelStationName(fuel);
    const brand = getFuelStationBrand(fuel);
    const key = `${brand || "station"}::${name}`.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        brand,
        logs: [],
        amount: 0,
        liters: 0,
        minPrice: Infinity,
        maxPrice: 0,
        latestDate: "",
        coordinates: null,
        locationCount: 0
      });
    }
    const group = groups.get(key);
    const amount = Number(fuel.amount) || 0;
    const liters = Number(fuel.liters) || 0;
    const price = getFuelPricePerLiter(fuel);
    const coordinates = getFuelStationCoordinates(fuel);
    group.logs.push({ ...fuel, pricePerLiter: price });
    group.amount += amount;
    group.liters += liters;
    if (coordinates) {
      group.locationCount += 1;
      if (!group.coordinates) group.coordinates = coordinates;
    }
    group.minPrice = Math.min(group.minPrice, price || group.minPrice);
    group.maxPrice = Math.max(group.maxPrice, price || 0);
    if (fuel.date && String(fuel.date) > group.latestDate) group.latestDate = String(fuel.date);
  });

  const stations = Array.from(groups.values()).map((group) => ({
    ...group,
    avgPrice: group.liters > 0 ? group.amount / group.liters : 0,
    logCount: group.logs.length
  })).sort((a, b) => b.logCount - a.logCount || a.avgPrice - b.avgPrice);

  const priceStations = stations.filter((station) => station.avgPrice > 0);
  const cheapest = priceStations.filter((station) => station.logCount >= 1).sort((a, b) => a.avgPrice - b.avgPrice)[0] || null;
  const mostUsed = stations[0] || null;
  const totalAmount = usable.reduce((sum, fuel) => sum + (Number(fuel.amount) || 0), 0);
  const totalLiters = usable.reduce((sum, fuel) => sum + (Number(fuel.liters) || 0), 0);
  const overallAvg = totalLiters > 0 ? totalAmount / totalLiters : 0;
  const livePrice = latestFuelPrice && Number(latestFuelPrice.price) > 0 ? Number(latestFuelPrice.price) : 0;
  const referencePrice = overallAvg || livePrice || Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice;
  const currentFuel = state.fuel.map((fuel) => ({ ...fuel, periodStatus: "open", periodLabel: "Current period" }));
  const odometerFuelLogs = fuelLogs
    .filter((fuel) => Number(fuel.odometer) > 0)
    .sort((a, b) => Number(b.odometer || 0) - Number(a.odometer || 0));
  const fullTankLogs = odometerFuelLogs.filter((fuel) => fuel.fullTank || fuel.full_tank);
  const reviewLogs = usable
    .map((fuel) => {
      const price = getFuelPricePerLiter(fuel);
      const station = getFuelStationName(fuel);
      const reasons = [];
      if (price > 0 && referencePrice > 0 && price > referencePrice * 1.12) {
        reasons.push(`${formatMoneyFor(price, state.currency)}/L is ${formatNumber(((price / referencePrice) - 1) * 100)}% above the reference average.`);
      }
      if (price > 0 && (isFuelPriceOutsideWarningRange(price))) {
        reasons.push(`${formatMoneyFor(price, state.currency)}/L is outside the configured fuel price range (${formatFuelPriceWarningRange()}).`);
      }
      const stationGroup = stations.find((item) => item.name === station);
      if (stationGroup && stationGroup.logCount >= 3 && price > stationGroup.avgPrice * 1.15) {
        reasons.push(`Higher than your usual ${escapeHtml(station)} average of ${formatMoneyFor(stationGroup.avgPrice, state.currency)}/L.`);
      }
      return { fuel, price, station, reasons };
    })
    .filter((item) => item.reasons.length)
    .slice(0, 6);

  const currentReviewLogs = reviewLogs.filter((item) => currentFuel.some((fuel) => fuel.id === item.fuel.id));
  const latestFullTank = fullTankLogs[0] || null;
  const latestOdometerFuel = odometerFuelLogs[0] || null;

  return {
    totalFuelLogs: fuelLogs.length,
    withStationCount: withStation.length,
    usableCount: usable.length,
    stations,
    cheapest,
    mostUsed,
    totalAmount,
    totalLiters,
    overallAvg,
    referencePrice,
    latestFullTank,
    latestOdometerFuel,
    reviewLogs,
    currentReviewLogs
  };
}

function getFuelTankCapacity(source = state) {
  return Math.max(1, Number(source?.fuelTankCapacity) || defaults.fuelTankCapacity);
}

function getFuelWarningUsedPercent(source = state) {
  return Math.min(100, Math.max(1, Number(source?.fuelWarningThreshold) || defaults.fuelWarningThreshold));
}

function getTankLowRangeThresholdPercent(source = state) {
  return Math.min(100, Math.max(1, Number(source?.fuelWarningThreshold) || defaults.fuelWarningThreshold));
}

function isFullTankFuelLog(fuel) {
  return Boolean(fuel?.fullTank || fuel?.full_tank);
}

function getFuelOdometerValue(fuel) {
  const value = Number(fuel?.odometer ?? fuel?.odometer_km ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getTankTimelineFuelLogs(options = {}) {
  const excludeFuelId = options.excludeFuelId || null;
  return getAllFuelLogsForInsights()
    .filter((fuel) => !excludeFuelId || fuel.id !== excludeFuelId)
    .map((fuel) => ({ ...fuel, odometerValue: getFuelOdometerValue(fuel) }))
    .filter((fuel) => fuel.odometerValue > 0)
    .sort((a, b) => a.odometerValue - b.odometerValue);
}

function getLatestFullTankFuelBeforeOdometer(targetOdometer = 0, options = {}) {
  const target = Number(targetOdometer) || 0;
  if (target <= 0) return null;
  return getTankTimelineFuelLogs(options)
    .filter((fuel) => isFullTankFuelLog(fuel) && fuel.odometerValue <= target)
    .sort((a, b) => b.odometerValue - a.odometerValue)[0] || null;
}

function estimateTankStateAtOdometer(targetOdometer = 0, options = {}) {
  const odometer = Number(targetOdometer) || 0;
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const tankCapacity = getFuelTankCapacity();
  const baseline = getLatestFullTankFuelBeforeOdometer(odometer, options);
  if (!baseline || odometer <= 0) {
    return {
      enforced: false,
      odometer,
      consumption,
      tankCapacity,
      latestFuelOdometer: Number(baseline?.odometerValue || 0),
      litersAddedSinceFull: 0,
      litersUsedSinceFull: 0,
      estimatedLitersRemainingRaw: tankCapacity,
      estimatedLitersRemaining: tankCapacity,
      estimatedRangeRemaining: tankCapacity / consumption * 100,
      kmSinceFuel: 0
    };
  }

  const latestFuelOdometer = Number(baseline.odometerValue || 0);
  const kmSinceFuel = Math.max(0, odometer - latestFuelOdometer);
  const litersUsedSinceFull = kmSinceFuel * consumption / 100;
  const litersAddedSinceFull = getTankTimelineFuelLogs(options)
    .filter((fuel) => !isFullTankFuelLog(fuel) && fuel.odometerValue > latestFuelOdometer && fuel.odometerValue <= odometer)
    .reduce((sum, fuel) => sum + (Number(fuel.liters) || 0), 0);
  const estimatedLitersRemainingRaw = tankCapacity - litersUsedSinceFull + litersAddedSinceFull;
  const estimatedLitersRemaining = Math.min(tankCapacity, estimatedLitersRemainingRaw);
  const estimatedRangeRemaining = Math.max(0, estimatedLitersRemaining) / consumption * 100;

  return {
    enforced: true,
    odometer,
    consumption,
    tankCapacity,
    latestFuelOdometer,
    litersAddedSinceFull,
    litersUsedSinceFull,
    estimatedLitersRemainingRaw,
    estimatedLitersRemaining,
    estimatedRangeRemaining,
    kmSinceFuel
  };
}


function extractEstimatedDistanceFromText(text = "") {
  const match = String(text || "").match(/(\d+(?:[.,]\d+)?)\s*km\s*estimate/i);
  return match ? Number(match[1].replace(",", ".")) || 0 : 0;
}

function getActiveTripEstimateDistanceKm() {
  const context = getActiveTripLogContext();
  if (Number(context?.plannedDistanceKm || 0) > 0) return Number(context.plannedDistanceKm);
  if (context?.purpose) {
    const contextDistance = extractEstimatedDistanceFromText(context.purpose);
    if (contextDistance > 0) return contextDistance;
  }
  const noteDistance = extractEstimatedDistanceFromText(els.tripNote?.value || "");
  if (noteDistance > 0) return noteDistance;
  const distance = Number(els.endKm?.value || 0) - Number(els.startKm?.value || 0);
  return distance > 0 ? round(distance) : 0;
}

function clearTripCorrectionPanel() {
  if (!els.tripCorrectionPanel) return;
  els.tripCorrectionPanel.classList.add("hidden");
  els.tripCorrectionPanel.replaceChildren();
  delete els.tripCorrectionPanel.dataset.suggestedStart;
  delete els.tripCorrectionPanel.dataset.suggestedEnd;
}

function buildTripOdometerCorrection(startKm = 0, endKm = 0) {
  const start = Number(startKm) || 0;
  const end = Number(endKm) || 0;
  if (!(start > 0) || !(end > 0) || end > start) return null;
  const estimateDistance = getActiveTripEstimateDistanceKm();
  const safeDistance = estimateDistance > 0 ? estimateDistance : Math.max(1, Math.abs(end - start));
  const suggestedEnd = round(start + safeDistance);
  const suggestedStart = Math.max(0, round(end - safeDistance));
  return {
    start,
    end,
    distance: round(end - start),
    estimateDistance: round(safeDistance),
    suggestedEnd,
    suggestedStart,
    hasBookingEstimate: estimateDistance > 0
  };
}

function showTripOdometerCorrection(correction) {
  if (!els.tripCorrectionPanel || !correction) return;
  els.tripCorrectionPanel.dataset.suggestedStart = String(correction.suggestedStart);
  els.tripCorrectionPanel.dataset.suggestedEnd = String(correction.suggestedEnd);
  const estimateLabel = correction.hasBookingEstimate ? "booking estimate" : "current odometer gap";
  els.tripCorrectionPanel.innerHTML = `
    <strong>Trip odometer needs a correction</strong>
    <p>End odometer ${formatNumber(correction.end)} km is lower than start odometer ${formatNumber(correction.start)} km. Use the ${escapeHtml(estimateLabel)} of about ${formatNumber(correction.estimateDistance)} km to choose a safe adjustment, or edit manually.</p>
    <div class="fuel-correction-math">
      <strong>Why these suggestions?</strong>
      <ul>
        <li>Current entry would calculate ${formatNumber(correction.distance)} km, which is not valid for a trip.</li>
        <li>Keeping the start odometer ${formatNumber(correction.start)} km means the end odometer should be about ${formatNumber(correction.suggestedEnd)} km.</li>
        <li>Keeping the end odometer ${formatNumber(correction.end)} km means the start odometer should be about ${formatNumber(correction.suggestedStart)} km.</li>
      </ul>
    </div>
    <div class="fuel-correction-actions">
      <button type="button" class="subtle-button compact-button" data-trip-correction-action="set-end">Keep ${formatNumber(correction.start)} km → set end to ${formatNumber(correction.suggestedEnd)} km</button>
      <button type="button" class="subtle-button compact-button" data-trip-correction-action="set-start">Keep ${formatNumber(correction.end)} km → set start to ${formatNumber(correction.suggestedStart)} km</button>
      <button type="button" class="subtle-button compact-button" data-trip-correction-action="manual">Edit manually</button>
    </div>
  `;
  els.tripCorrectionPanel.classList.remove("hidden");
  els.tripCorrectionPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function applyTripCorrection(action) {
  if (!els.tripCorrectionPanel) return;
  if (action === "set-end") {
    const value = Number(els.tripCorrectionPanel.dataset.suggestedEnd || 0);
    if (value > 0 && els.endKm) els.endKm.value = String(value);
  } else if (action === "set-start") {
    const value = Number(els.tripCorrectionPanel.dataset.suggestedStart || 0);
    if (value >= 0 && els.startKm) els.startKm.value = String(value);
  }
  clearTripCorrectionPanel();
  els.endKm?.focus();
}

function validateTripOdometerChronology(startKm = 0, endKm = 0) {
  const correction = buildTripOdometerCorrection(startKm, endKm);
  if (!correction) return true;
  showTripOdometerCorrection(correction);
  showUserWarning("Trip odometer needs a correction before saving.");
  return false;
}

function buildTripFuelRangeImpact(startKm = 0, endKm = 0, options = {}) {
  const insights = buildStationInsights();
  const latestFuelOdometer = Number(insights.latestFullTank?.odometer || 0);
  const proposedEndKm = Number(endKm) || 0;
  const proposedStartKm = Number(startKm) || 0;
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const tankCapacity = getFuelTankCapacity();
  const warningLitersRemaining = tankCapacity * getTankLowRangeThresholdPercent() / 100;

  if (!latestFuelOdometer || proposedEndKm <= latestFuelOdometer) {
    return {
      enforced: false,
      latestFuelOdometer,
      consumption,
      tankCapacity,
      warningLitersRemaining,
      projectedLiters: 0,
      projectedLitersRemaining: tankCapacity,
      projectedRangeRemaining: tankCapacity / consumption * 100,
      projectedKmSinceFuel: 0,
      proposedDistanceKm: Math.max(0, proposedEndKm - proposedStartKm)
    };
  }

  const currentRangeOdometer = Number(getLatestRangeOdometer(latestFuelOdometer, { excludeTripId: options.excludeTripId }) || latestFuelOdometer);
  const projectedOdometer = Math.max(currentRangeOdometer, proposedEndKm);
  const projectedState = estimateTankStateAtOdometer(projectedOdometer, { excludeFuelId: options.excludeFuelId });
  const projectedKmSinceFuel = Math.max(0, projectedOdometer - Number(projectedState.latestFuelOdometer || latestFuelOdometer));
  const projectedLiters = projectedState.litersUsedSinceFull - projectedState.litersAddedSinceFull;
  const projectedLitersRemaining = projectedState.estimatedLitersRemainingRaw;
  const projectedRangeRemaining = Math.max(0, projectedState.estimatedLitersRemaining) / consumption * 100;
  return {
    enforced: true,
    latestFuelOdometer: projectedState.latestFuelOdometer || latestFuelOdometer,
    currentRangeOdometer,
    projectedOdometer,
    projectedKmSinceFuel,
    consumption,
    tankCapacity,
    warningLitersRemaining,
    projectedLiters,
    projectedLitersRemaining,
    projectedRangeRemaining,
    proposedDistanceKm: Math.max(0, proposedEndKm - proposedStartKm)
  };
}

function validateTripAgainstEstimatedTankRange(startKm = 0, endKm = 0, options = {}) {
  const impact = buildTripFuelRangeImpact(startKm, endKm, options);
  if (!impact.enforced) return true;
  const overflowLiters = impact.projectedLiters - impact.tankCapacity;
  if (overflowLiters > 0.05) {
    showUserError(`This trip would exceed the estimated fuel remaining since the last full-tank log at ${formatNumber(impact.latestFuelOdometer)} km. Estimated use would reach ${formatNumber(impact.projectedLiters)} L, but the tank capacity is ${formatNumber(impact.tankCapacity)} L. Add a fuel log before saving this trip, or check the odometer values.`);
    return false;
  }
  return true;
}

function normalizeFuelChronologyDate(value) {
  if (!value) return "";
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function findFuelOdometerChronologyIssue(fuelInput = {}, options = {}) {
  const odometer = Number(fuelInput.odometer) || 0;
  const date = normalizeFuelChronologyDate(fuelInput.date);
  if (!date || odometer <= 0) return null;

  const candidateLogs = (Array.isArray(state.fuel) ? state.fuel : [])
    .filter((fuel) => fuel && fuel.id !== options.excludeFuelId)
    .map((fuel) => ({
      ...fuel,
      chronologyDate: normalizeFuelChronologyDate(fuel.date),
      chronologyOdometer: Number(fuel.odometer) || 0
    }))
    .filter((fuel) => fuel.chronologyDate && fuel.chronologyOdometer > 0);

  const previous = candidateLogs
    .filter((fuel) => fuel.chronologyDate < date)
    .sort((a, b) => b.chronologyDate.localeCompare(a.chronologyDate) || b.chronologyOdometer - a.chronologyOdometer)[0] || null;

  if (previous && odometer < previous.chronologyOdometer) {
    return {
      type: "below-previous",
      relatedFuel: previous,
      message: `This odometer is lower than the previous fuel log from ${formatDate(previous.date)}: ${formatNumber(previous.chronologyOdometer)} km. Enter ${formatNumber(previous.chronologyOdometer)} km or higher, or correct the earlier fuel log first.`
    };
  }

  const next = candidateLogs
    .filter((fuel) => fuel.chronologyDate > date)
    .sort((a, b) => a.chronologyDate.localeCompare(b.chronologyDate) || a.chronologyOdometer - b.chronologyOdometer)[0] || null;

  if (next && odometer > next.chronologyOdometer) {
    return {
      type: "above-next",
      relatedFuel: next,
      message: `This odometer is higher than the next fuel log from ${formatDate(next.date)}: ${formatNumber(next.chronologyOdometer)} km. Lower it, move the date, or correct the later fuel log first.`
    };
  }

  return null;
}

function validateFuelOdometerChronology(fuelInput = {}, options = {}) {
  const issue = findFuelOdometerChronologyIssue(fuelInput, options);
  if (!issue) return true;
  showUserError(issue.message);
  showAppMessage(issue.message, "error");
  const details = document.querySelector("#fuelDetails");
  if (details) details.open = true;
  els.fuelOdometer?.focus();
  return false;
}


function clearFuelCorrectionPanel() {
  if (!els.fuelCorrectionPanel) return;
  els.fuelCorrectionPanel.classList.add("hidden");
  els.fuelCorrectionPanel.innerHTML = "";
  delete els.fuelCorrectionPanel.dataset.suggestedLiters;
  delete els.fuelCorrectionPanel.dataset.suggestedOdometer;
  delete els.fuelCorrectionPanel.dataset.suggestedAmount;
}


function buildFuelOverfillCorrection(fuelInput = {}, tankBeforeFuel = null, options = {}) {
  const liters = Number(fuelInput.liters) || 0;
  const odometer = Number(fuelInput.odometer) || 0;
  const tankCapacity = getFuelTankCapacity();
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const estimatedBefore = Math.max(0, Math.min(tankCapacity, Number(tankBeforeFuel?.estimatedLitersRemaining || 0)));
  const availableSpace = Math.max(0, tankCapacity - estimatedBefore);
  const safeLiters = Math.max(0, round(availableSpace));
  const latestFuelOdometer = Number(tankBeforeFuel?.latestFuelOdometer || 0);
  const kmSinceFuel = latestFuelOdometer > 0 && odometer > latestFuelOdometer
    ? Math.max(0, odometer - latestFuelOdometer)
    : Math.max(0, Number(tankBeforeFuel?.kmSinceFuel || 0));
  const expectedLitersFromOdometer = Math.max(0, round(kmSinceFuel * consumption / 100));
  const extraLitersNeeded = Math.max(0, liters - availableSpace);
  const extraKmNeeded = extraLitersNeeded > 0 ? extraLitersNeeded * 100 / consumption : 0;
  const suggestedOdometer = odometer > 0 && extraKmNeeded > 0 ? Math.ceil(odometer + extraKmNeeded) : 0;
  const expectedKmFromEnteredLiters = liters > 0 ? liters * 100 / consumption : 0;
  const expectedOdometerFromEnteredLiters = latestFuelOdometer > 0 && expectedKmFromEnteredLiters > 0
    ? Math.ceil(latestFuelOdometer + expectedKmFromEnteredLiters)
    : suggestedOdometer;
  return {
    tankCapacity,
    consumption,
    estimatedBefore,
    availableSpace,
    safeLiters,
    kmSinceFuel,
    expectedLitersFromOdometer,
    expectedKmFromEnteredLiters,
    expectedOdometerFromEnteredLiters,
    extraLitersNeeded,
    extraKmNeeded,
    suggestedOdometer,
    latestFuelOdometer,
    currentOdometer: odometer,
    currentLiters: liters,
    fullTank: Boolean(fuelInput.fullTank)
  };
}

function renderFuelCorrectionPanel(message, correction) {
  if (!els.fuelCorrectionPanel || !correction) return;
  const safeLiters = Math.max(0, Number(correction.safeLiters) || 0);
  const suggestedOdometer = Math.max(0, Number(correction.suggestedOdometer) || 0);
  els.fuelCorrectionPanel.dataset.suggestedLiters = String(safeLiters);
  els.fuelCorrectionPanel.dataset.suggestedOdometer = String(suggestedOdometer);
  const expectedLiters = Math.max(0, Number(correction.expectedLitersFromOdometer) || 0);
  const expectedKmFromLiters = Math.max(0, Number(correction.expectedKmFromEnteredLiters) || 0);
  const expectedOdometer = Math.max(0, Number(correction.expectedOdometerFromEnteredLiters || correction.suggestedOdometer) || 0);
  const previousOdometerLine = correction.latestFuelOdometer > 0
    ? `<li>Previous full-tank odometer: <strong>${formatNumber(correction.latestFuelOdometer)} km</strong></li>`
    : "";
  const odometerMathLine = correction.latestFuelOdometer > 0 && correction.currentOdometer > 0
    ? `<li>Current odometer ${formatNumber(correction.currentOdometer)} km is <strong>${formatNumber(correction.kmSinceFuel)} km</strong> after that full tank.</li>`
    : "";
  const litersMathLine = correction.kmSinceFuel > 0
    ? `<li>At ${formatNumber(correction.consumption)} L/100 km, that distance uses about <strong>${formatNumber(expectedLiters)} L</strong>.</li>`
    : "";
  const enteredLitersMathLine = correction.currentLiters > 0 && expectedOdometer > 0
    ? `<li>${formatNumber(correction.currentLiters)} L at ${formatNumber(correction.consumption)} L/100 km means about <strong>${formatNumber(expectedKmFromLiters)} km</strong> of driving, so the odometer would be about <strong>${formatNumber(expectedOdometer)} km</strong>.</li>`
    : "";
  const differenceLine = correction.currentLiters > 0 && expectedLiters > 0
    ? `<li>Entered fuel is <strong>${formatNumber(Math.max(0, correction.currentLiters - expectedLiters))} L</strong> above the odometer-based estimate.</li>`
    : "";
  const litersAction = safeLiters > 0
    ? `<button class="subtle-button compact-button" type="button" data-fuel-correction-action="set-liters">Keep ${formatNumber(correction.currentOdometer)} km → set liters to ${formatNumber(safeLiters)} L</button>`
    : "";
  const odometerAction = suggestedOdometer > 0
    ? `<button class="subtle-button compact-button" type="button" data-fuel-correction-action="set-odometer">Keep ${formatNumber(correction.currentLiters)} L → set odometer to about ${formatNumber(suggestedOdometer)} km</button>`
    : "";
  els.fuelCorrectionPanel.innerHTML = `
    <strong>Fuel log needs a correction</strong>
    <p>${escapeHtml(message)}</p>
    <small>Estimated before this receipt: ${formatNumber(correction.estimatedBefore)} L in a ${formatNumber(correction.tankCapacity)} L tank. At ${formatNumber(correction.consumption)} L/100 km, choose a safe adjustment below or edit manually.</small>
    <div class="fuel-correction-math" aria-label="Fuel correction calculation">
      <strong>Why these suggestions?</strong>
      <ul>
        ${previousOdometerLine}
        ${odometerMathLine}
        ${litersMathLine}
        ${enteredLitersMathLine}
        ${differenceLine}
      </ul>
    </div>
    <div class="fuel-correction-actions">
      ${litersAction}
      ${odometerAction}
      <button class="subtle-button compact-button" type="button" data-fuel-correction-action="dismiss">Edit manually</button>
    </div>
  `;
  els.fuelCorrectionPanel.classList.remove("hidden");
  els.fuelCorrectionPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function applyFuelCorrection(action) {
  if (!els.fuelCorrectionPanel || !action) return;
  if (action === "set-liters") {
    const suggested = Number(els.fuelCorrectionPanel.dataset.suggestedLiters || 0);
    if (suggested > 0 && els.fuelLiters) {
      els.fuelLiters.value = String(suggested);
      els.fuelLiters.focus();
      showAppMessage(`Liters adjusted to ${formatNumber(suggested)} L. Review and save again.`, "info");
    }
  } else if (action === "set-odometer") {
    const suggested = Number(els.fuelCorrectionPanel.dataset.suggestedOdometer || 0);
    if (suggested > 0 && els.fuelOdometer) {
      els.fuelOdometer.value = String(suggested);
      const details = document.querySelector("#fuelDetails");
      if (details) details.open = true;
      els.fuelOdometer.focus();
      showAppMessage(`Odometer adjusted to about ${formatNumber(suggested)} km. Review and save again.`, "info");
    }
  } else if (action === "set-amount") {
    const suggested = Number(els.fuelCorrectionPanel.dataset.suggestedAmount || 0);
    if (suggested > 0 && els.fuelAmount) {
      els.fuelAmount.value = String(suggested);
      els.fuelAmount.focus();
      showAppMessage(`Amount adjusted to ${formatMoneyFor(suggested, state.currency)}. Review and save again.`, "info");
    }
  }
  clearFuelCorrectionPanel();
}

function validateFuelAgainstEstimatedTankCapacity(fuelInput = {}, options = {}) {
  const liters = Number(fuelInput.liters) || 0;
  const odometer = Number(fuelInput.odometer) || 0;
  const fullTank = Boolean(fuelInput.fullTank);
  const tankCapacity = getFuelTankCapacity();
  const toleranceLiters = 0.5;

  if (liters > tankCapacity + toleranceLiters) {
    const message = `This fuel log is ${formatNumber(liters)} L, but the configured tank capacity is ${formatNumber(tankCapacity)} L. Check the receipt or update the tank capacity before saving.`;
    showUserError(message);
    showAppMessage(message, "error");
    return false;
  }

  if (odometer <= 0) return true;

  const tankBeforeFuel = estimateTankStateAtOdometer(odometer, { excludeFuelId: options.excludeFuelId });
  if (!tankBeforeFuel.enforced) return true;

  const estimatedBefore = Math.max(0, Math.min(tankCapacity, tankBeforeFuel.estimatedLitersRemaining));
  const availableSpace = Math.max(0, tankCapacity - estimatedBefore);
  const projectedAfter = fullTank ? tankCapacity : estimatedBefore + liters;

  if (liters > availableSpace + toleranceLiters) {
    const message = fullTank
      ? `This full-tank fuel log adds ${formatNumber(liters)} L, but the tank is estimated to have about ${formatNumber(estimatedBefore)} L already. Only about ${formatNumber(availableSpace)} L should fit. Check the odometer/liters, or add the missing trip before this fuel log.`
      : `This fuel log would overfill the tank. The tank is estimated to have about ${formatNumber(estimatedBefore)} L already, so only about ${formatNumber(availableSpace)} L should fit before reaching the configured ${formatNumber(tankCapacity)} L capacity.`;
    const correction = buildFuelOverfillCorrection(fuelInput, tankBeforeFuel, options);
    renderFuelCorrectionPanel(message, correction);
    showUserError(`${message} Use one of the suggested corrections below, or edit manually.`, { timeoutMs: 7200 });
    return false;
  }

  if (!fullTank && projectedAfter > tankCapacity + toleranceLiters) {
    const message = `This fuel log would raise the estimated tank level to ${formatNumber(projectedAfter)} L, above the configured ${formatNumber(tankCapacity)} L capacity.`;
    const correction = buildFuelOverfillCorrection(fuelInput, tankBeforeFuel, options);
    renderFuelCorrectionPanel(message, correction);
    showUserError(`${message} Use one of the suggested corrections below, or edit manually.`, { timeoutMs: 7200 });
    return false;
  }

  return true;
}

function buildRefuelPlanning(distanceKm = 0) {
  const insights = buildStationInsights();
  const consumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const tankCapacity = getFuelTankCapacity();
  const warningUsedPercent = getFuelWarningUsedPercent();
  const tankLowRangeThresholdPercent = getTankLowRangeThresholdPercent();
  const warningLitersUsed = tankCapacity * warningUsedPercent / 100;
  const warningLitersRemaining = tankCapacity * tankLowRangeThresholdPercent / 100;
  const plannedLiters = distanceKm > 0 ? distanceKm * consumption / 100 : 100 * consumption / 100;
  const latestFuelOdometer = Number(insights.latestFullTank?.odometer || insights.latestOdometerFuel?.odometer || 0);
  const currentOdometer = Number(getLatestRangeOdometer(latestFuelOdometer) || latestFuelOdometer || 0);
  const currentTankState = estimateTankStateAtOdometer(currentOdometer);
  const kmSinceFuel = currentTankState.enforced ? currentTankState.kmSinceFuel : 0;
  const litersSinceFuel = currentTankState.enforced ? Math.max(0, currentTankState.litersUsedSinceFull - currentTankState.litersAddedSinceFull) : 0;
  const projectedLiters = litersSinceFuel + plannedLiters;
  const estimatedLitersRemaining = currentTankState.enforced ? Math.max(0, currentTankState.estimatedLitersRemaining) : Math.max(0, tankCapacity - litersSinceFuel);
  const projectedLitersRemaining = Math.max(0, estimatedLitersRemaining - plannedLiters);
  const estimatedRangeRemaining = estimatedLitersRemaining > 0 ? estimatedLitersRemaining / consumption * 100 : 0;
  const projectedRangeRemaining = projectedLitersRemaining > 0 ? projectedLitersRemaining / consumption * 100 : 0;
  const fullTankRange = tankCapacity / consumption * 100;
  const stationCandidates = insights.stations
    .filter((station) => station.avgPrice > 0)
    .sort((a, b) => a.avgPrice - b.avgPrice || b.logCount - a.logCount)
    .slice(0, 3);
  let recommendation = `Tank capacity is ${formatNumber(tankCapacity)} L. Log full-tank odometer readings to estimate remaining range.`;
  let tone = "neutral";
  if (latestFuelOdometer > 0) {
    const currentRangeText = `${formatNumber(estimatedLitersRemaining)} L / ${formatNumber(estimatedRangeRemaining)} km`;
    if (distanceKm > 0) {
      recommendation = `This planned trip would use about ${formatNumber(plannedLiters)} L. After the trip: about ${formatNumber(projectedLitersRemaining)} L / ${formatNumber(projectedRangeRemaining)} km remaining.`;
      if (litersSinceFuel > 0) {
        recommendation += ` Including completed driving since the last full-tank log, total estimated use would be ${formatNumber(projectedLiters)} L.`;
      }
      if (projectedLiters >= tankCapacity) {
        tone = "warning";
        recommendation += " Refuel before or during this trip.";
      } else if (projectedLitersRemaining <= warningLitersRemaining) {
        tone = "warning";
        recommendation += " This would leave the tank below the configured low-range warning threshold; plan a refuel stop.";
      } else {
        recommendation += ` This plan is still only an estimate; before saving it as a booking, the car is currently estimated at about ${currentRangeText} remaining.`;
      }
    } else {
      recommendation = `Current range since the last logged fuel odometer: about ${currentRangeText} remaining. Full-tank range is about ${formatNumber(fullTankRange)} km.`;
      if (estimatedLitersRemaining <= warningLitersRemaining) tone = "warning";
    }
  } else if (distanceKm > 0) {
    recommendation = `This trip is expected to use about ${formatNumber(plannedLiters)} L. A full ${formatNumber(tankCapacity)} L tank gives about ${formatNumber(fullTankRange)} km at ${formatNumber(consumption)} L/100 km. Add full-tank odometer logs to make remaining-range predictions smarter.`;
  }
  return { insights, consumption, tankCapacity, warningUsedPercent, tankLowRangeThresholdPercent, warningLitersUsed, warningLitersRemaining, plannedLiters, kmSinceFuel, litersSinceFuel, projectedLiters, estimatedLitersRemaining, projectedLitersRemaining, estimatedRangeRemaining, projectedRangeRemaining, fullTankRange, latestFuelOdometer, stationCandidates, recommendation, tone };
}

function renderStationInsights() {
  if (!els.stationInsights) return;
  const insights = buildStationInsights();
  if (!insights.withStationCount) {
    els.stationInsights.className = "station-insights empty-state";
    els.stationInsights.textContent = "Add station/place and liters to fuel logs to compare stations.";
    return;
  }
  if (!insights.usableCount) {
    els.stationInsights.className = "station-insights empty-state";
    els.stationInsights.textContent = "Station names are logged. Add liters to compare DKK/L by station.";
    return;
  }

  const topStations = insights.stations.slice(0, 8);
  const stationRows = topStations.map((station) => `
    <tr>
      <td>
        <strong>${escapeHtml(station.name)}</strong>
        ${station.brand ? `<span>${escapeHtml(station.brand)}</span>` : ""}
        <small>${station.coordinates ? `${Number(station.coordinates.latitude).toFixed(5)}, ${Number(station.coordinates.longitude).toFixed(5)}` : "No saved GPS coordinate"}</small>
        <a href="${escapeHtml(getStationMapUrl(station))}" target="_blank" rel="noopener">Open map</a>
      </td>
      <td>${station.logCount}</td>
      <td>${formatNumber(station.liters)} L</td>
      <td><strong>${formatMoneyFor(station.avgPrice, state.currency)}/L</strong></td>
      <td>${Number.isFinite(station.minPrice) ? `${formatMoneyFor(station.minPrice, state.currency)}–${formatMoneyFor(station.maxPrice, state.currency)}` : "—"}</td>
      <td>${escapeHtml(station.latestDate || "—")}</td>
    </tr>`).join("");
  const reviewList = insights.reviewLogs.length
    ? `<div class="fuel-intelligence-notes"><strong>Fuel receipts worth reviewing</strong><ul>${insights.reviewLogs.map((item) => {
        const fuel = item.fuel;
        const canEdit = fuel.periodStatus === "open" && canManageFuelEntry(fuel) && !isCurrentPeriodLockedForNewEntries();
        return `<li><strong>${escapeHtml(fuel.date || "No date")} · ${escapeHtml(item.station)}</strong> · ${formatMoneyFor(fuel.amount, state.currency)} · ${formatNumber(fuel.liters)} L · ${formatMoneyFor(item.price, state.currency)}/L<br><span>${item.reasons.join(" ")}</span>${canEdit ? ` <button class="link-button" type="button" data-edit="fuel:${escapeHtml(fuel.id)}">Edit</button>` : ""}</li>`;
      }).join("")}</ul></div>`
    : `<p class="entry-meta">No station-level fuel price outliers found.</p>`;

  els.stationInsights.className = "station-insights fuel-intelligence";
  els.stationInsights.innerHTML = `
    <div class="fuel-intelligence-grid">
      <article>
        <span>Station coverage</span>
        <strong>${insights.withStationCount} / ${insights.totalFuelLogs}</strong>
        <small>Fuel logs with a station/place. ${insights.usableCount} include liters for DKK/L analysis.</small>
      </article>
      <article>
        <span>Average receipt price</span>
        <strong>${insights.overallAvg > 0 ? `${formatMoneyFor(insights.overallAvg, state.currency)}/L` : "Not enough data"}</strong>
        <small>Across ${formatNumber(insights.totalLiters)} logged liters.</small>
      </article>
      <article>
        <span>Cheapest logged station</span>
        <strong>${insights.cheapest ? escapeHtml(insights.cheapest.name) : "Not enough data"}</strong>
        <small>${insights.cheapest ? `${formatMoneyFor(insights.cheapest.avgPrice, state.currency)}/L · ${insights.cheapest.logCount} log${insights.cheapest.logCount === 1 ? "" : "s"}` : "Add more station fuel logs."}</small>
      </article>
      <article>
        <span>Most used station</span>
        <strong>${insights.mostUsed ? escapeHtml(insights.mostUsed.name) : "Not enough data"}</strong>
        <small>${insights.mostUsed ? `${insights.mostUsed.logCount} fuel log${insights.mostUsed.logCount === 1 ? "" : "s"} · ${formatMoneyFor(insights.mostUsed.avgPrice, state.currency)}/L avg.` : ""}</small>
      </article>
    </div>
    <div class="station-insight-table">
      <div class="station-table-title">
        <strong>Logged station comparison</strong>
        <span>Exact station details come from what was saved on each fuel receipt: station name, brand, GPS coordinate when available, and receipt DKK/L.</span>
      </div>
      <div class="table-scroll station-table-wrap">
        <table class="compact-table station-comparison-table">
          <thead><tr><th>Station</th><th>Logs</th><th>Liters</th><th>Avg DKK/L</th><th>Range</th><th>Latest</th></tr></thead>
          <tbody>${stationRows}</tbody>
        </table>
      </div>
    </div>
    ${reviewList}
    <div class="trip-refuel-note">
      <strong>About route-based refuel suggestions</strong>
      <span>This app can recommend stations you have actually logged. True route planning with stations along the route would require a routing/maps API, so it is a later integration rather than a local-only calculation.</span>
    </div>
    <p class="entry-meta">Station insights use logged receipts only. They are hints, not proof that one station is always cheapest.</p>
  `;
}

function calculateTripCostEstimate(distanceKm, participantCount) {
  const intel = buildFuelIntelligence(calculateLedger());
  const historical = intel.stats;
  const fallbackConsumption = Math.max(0.1, Number(state.fuelConsumption) || defaults.fuelConsumption);
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const livePrice = latestFuelPrice && latestFuelPrice.price > 0 ? Number(latestFuelPrice.price) : 0;
  const pricePerLiter = historical.pricePerLiter > 0 ? historical.pricePerLiter : livePrice || fallbackPrice;

  let totalCost = 0;
  let explanation = "";

  if (intel.canUseHistoricalForPlanning) {
    totalCost = distanceKm * historical.costPerKm;
    explanation = `${formatNumber(distanceKm)} km × trusted historical ${formatMoneyFor(historical.costPerKm, state.currency)}/km, based on ${formatNumber(historical.totalTripKm)} logged km.`;
  } else {
    const consumption = fallbackConsumption;
    totalCost = (distanceKm * consumption / 100) * pricePerLiter;
    const priceSource = historical.pricePerLiter > 0 ? "historical receipt average" : livePrice ? "live diesel reference price" : "fallback fuel price";
    const reason = historical.litersPer100Km > 0 && !intel.consumptionLooksRealistic
      ? ` Historical consumption (${formatNumber(historical.litersPer100Km)} L/100 km) looks unusual, so it is ignored for planning.`
      : "";
    explanation = `${formatNumber(distanceKm)} km × ${formatNumber(consumption)} L/100 km (car setting) × ${formatMoneyFor(pricePerLiter, state.currency)}/L (${priceSource}).${reason}`;
  }

  const refuel = buildRefuelPlanning(distanceKm);

  return {
    totalCost: roundMoney(totalCost),
    perPerson: roundMoney(totalCost / participantCount),
    explanation,
    refuel
  };
}

function getMonthlySummaryPeriods() {
  return [
    { id: (state.currentPeriodId || "current"), label: "Current period", status: "open", trips: state.trips, fuel: state.fuel },
    ...state.closedPeriods.map((period) => ({
      id: period.id,
      label: period.label || "Closed period",
      status: "closed",
      trips: Array.isArray(period.trips) ? period.trips : [],
      fuel: Array.isArray(period.fuel) ? period.fuel : []
    }))
  ];
}

function ensureMonthlyPersonRow(month, personName) {
  if (!month.people[personName]) {
    month.people[personName] = {
      name: personName,
      drivenTrips: 0,
      joinedTrips: 0,
      distanceShare: 0,
      drivenKm: 0,
      fuelLogs: 0,
      fuelPaid: 0,
      liters: 0,
      fuelShare: 0,
      net: 0
    };
  }
  return month.people[personName];
}

function buildMonthlyMemberSummaries() {
  const months = new Map();

  const ensureMonth = (key) => {
    if (!months.has(key)) {
      months.set(key, {
        key,
        label: monthLabelFromKey(key),
        tripCount: 0,
        fuelLogCount: 0,
        totalTripKm: 0,
        totalParticipantKm: 0,
        totalFuelPaid: 0,
        totalLiters: 0,
        people: {}
      });
    }
    return months.get(key);
  };

  for (const period of getMonthlySummaryPeriods()) {
    for (const trip of Array.isArray(period.trips) ? period.trips : []) {
      const key = monthKeyFromDate(trip.date || trip.trip_date);
      const month = ensureMonth(key);
      const start = Number(trip.startKm ?? trip.start_km ?? 0);
      const end = Number(trip.endKm ?? trip.end_km ?? 0);
      const km = Math.max(0, end - start);
      if (km <= 0) continue;

      const participants = getTripParticipants({ ...trip, driver: trip.driver || trip.driverName || trip.driver_name }).filter(Boolean);
      const uniqueParticipants = Array.from(new Set(participants));
      const share = uniqueParticipants.length ? km / uniqueParticipants.length : km;
      const driver = trip.driver || trip.driverName || trip.driver_name;

      month.tripCount += 1;
      month.totalTripKm += km;
      month.totalParticipantKm += share * Math.max(1, uniqueParticipants.length || 1);

      if (driver) {
        const row = ensureMonthlyPersonRow(month, driver);
        row.drivenTrips += 1;
        row.drivenKm += km;
      }

      uniqueParticipants.forEach((name) => {
        const row = ensureMonthlyPersonRow(month, name);
        row.joinedTrips += 1;
        row.distanceShare += share;
      });
    }

    for (const fuel of Array.isArray(period.fuel) ? period.fuel : []) {
      const key = monthKeyFromDate(fuel.date || fuel.payment_date);
      const month = ensureMonth(key);
      const payer = fuel.payer || fuel.payerName || fuel.payer_name;
      const amount = Number(fuel.amount || 0);
      const liters = Number(fuel.liters || 0);
      if (!payer || amount <= 0) continue;

      month.fuelLogCount += 1;
      month.totalFuelPaid += amount;
      month.totalLiters += Math.max(0, liters);

      const row = ensureMonthlyPersonRow(month, payer);
      row.fuelLogs += 1;
      row.fuelPaid += amount;
      row.liters += Math.max(0, liters);
    }
  }

  for (const month of months.values()) {
    const rate = month.totalParticipantKm > 0 ? month.totalFuelPaid / month.totalParticipantKm : 0;
    Object.values(month.people).forEach((person) => {
      person.distanceShare = round(person.distanceShare);
      person.drivenKm = round(person.drivenKm);
      person.fuelShare = roundMoney(person.distanceShare * rate);
      person.net = roundMoney(person.fuelPaid - person.fuelShare);
    });
    month.totalTripKm = round(month.totalTripKm);
    month.totalParticipantKm = round(month.totalParticipantKm);
    month.totalFuelPaid = roundMoney(month.totalFuelPaid);
    month.totalLiters = round(month.totalLiters);
    month.fuelRate = month.totalParticipantKm > 0 ? roundMoney(month.totalFuelPaid / month.totalParticipantKm) : 0;
  }

  return Array.from(months.values()).sort((a, b) => String(b.key).localeCompare(String(a.key)));
}


function getEntryReviewReferencePrice() {
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  if (latestFuelPrice && Number(latestFuelPrice.price) > 0) return Number(latestFuelPrice.price);
  const paidWithLiters = state.fuel.filter((fuel) => Number(fuel.amount || 0) > 0 && Number(fuel.liters || 0) > 0);
  const totalPaid = paidWithLiters.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0);
  const totalLiters = paidWithLiters.reduce((sum, fuel) => sum + Number(fuel.liters || 0), 0);
  if (totalPaid > 0 && totalLiters > 0) return totalPaid / totalLiters;
  return fallbackPrice;
}

function getFuelEntryReviewSignal(fuel, ledger = null) {
  if (!fuel) return null;
  const amount = Number(fuel.amount || 0);
  const liters = Number(fuel.liters || 0);
  const referencePrice = getEntryReviewReferencePrice();
  const messages = [];
  let level = "ok";

  const setLevel = (next) => {
    if (next === "issue" || level !== "issue") level = next;
  };

  if (amount >= 500 && !(liters > 0)) {
    setLevel("issue");
    messages.push("Large fuel payment without liters. Add liters so the app can verify DKK/L and consumption.");
  }

  if (amount > 0 && liters > 0) {
    const pricePerLiter = amount / liters;
    if (isFuelPriceOutsideWarningRange(pricePerLiter)) {
      setLevel("issue");
      messages.push(`${formatMoneyFor(pricePerLiter, state.currency)}/L is outside the configured fuel price range (${formatFuelPriceWarningRange()}).`);
    } else if (referencePrice > 0) {
      const difference = Math.abs(pricePerLiter - referencePrice) / referencePrice;
      if (difference >= 0.25) {
        setLevel("warning");
        messages.push(`${formatMoneyFor(pricePerLiter, state.currency)}/L differs from the reference price (${formatMoneyFor(referencePrice, state.currency)}/L).`);
      }
    }
  }

  const duplicates = state.fuel.filter((other) =>
    other !== fuel
      && other.payer === fuel.payer
      && other.date === fuel.date
      && Math.abs(Number(other.amount || 0) - amount) < 0.01
  );
  if (duplicates.length) {
    setLevel("issue");
    messages.push("Possible duplicate: same payer, date, and amount exists in this period.");
  }

  const activeLedger = ledger || calculateLedger();
  const estimate = activeLedger.fuelEstimate || calculateFuelEstimate(activeLedger);
  if (estimate?.hasEstimate && estimate.coveragePercent > 135 && amount > 0 && activeLedger.totalPaid > 0) {
    const shareOfFuel = amount / activeLedger.totalPaid;
    if (shareOfFuel >= 0.3) {
      setLevel("warning");
      messages.push(`Large share of period fuel: ${formatMoneyFor(amount, state.currency)} of ${formatMoneyFor(activeLedger.totalPaid, state.currency)} (${formatNumber(shareOfFuel * 100)}%). Check that it belongs to this period.`);
    }
  }

  if (!messages.length) return null;
  return {
    level,
    title: level === "issue" ? "Likely needs review" : "Review suggestion",
    messages
  };
}

function getTripEntryReviewSignal(trip, ledger = null) {
  if (!trip) return null;
  const start = Number(trip.startKm || 0);
  const end = Number(trip.endKm || 0);
  const km = Math.max(0, end - start);
  const messages = [];
  let level = "ok";
  const setLevel = (next) => {
    if (next === "issue" || level !== "issue") level = next;
  };

  if (!(end > start)) {
    setLevel("issue");
    messages.push("End odometer must be higher than start odometer.");
  } else if (km > 1000) {
    setLevel("warning");
    messages.push(`${formatNumber(km)} km is unusually long for one trip. Check start/end odometer.`);
  }

  const activeLedger = ledger || calculateLedger();
  const estimate = activeLedger.fuelEstimate || calculateFuelEstimate(activeLedger);
  if (estimate?.hasEstimate && estimate.coveragePercent > 135 && activeLedger.totalTripKm > 0 && km > 0) {
    const tripShare = km / activeLedger.totalTripKm;
    if (state.trips.length > 2 && tripShare >= 0.5) {
      setLevel("warning");
      messages.push(`Large share of period distance: ${formatNumber(km)} km of ${formatNumber(activeLedger.totalTripKm)} km (${formatNumber(tripShare * 100)}%). Check odometer if that was not intentional.`);
    }
  }

  if (!messages.length) return null;
  return {
    level,
    title: level === "issue" ? "Likely needs review" : "Review suggestion",
    messages
  };
}

function renderEntryReviewSignal(signal) {
  if (!signal) return "";
  return `
    <div class="entry-review-signal ${escapeHtml(signal.level)}">
      <strong>${escapeHtml(signal.title)}</strong>
      <ul>${signal.messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>
    </div>
  `;
}

function getHistoryReviewCandidateCount(ledger = null) {
  const activeLedger = ledger || calculateLedger();
  const tripCandidates = state.trips.filter((trip) => getTripEntryReviewSignal(trip, activeLedger)).length;
  const fuelCandidates = state.fuel.filter((fuel) => getFuelEntryReviewSignal(fuel, activeLedger)).length;
  return { tripCandidates, fuelCandidates, total: tripCandidates + fuelCandidates };
}

function getAnomalyEditTarget(type, entry) {
  if (!entry?.id) return null;
  if (type === "fuel" && canManageFuelEntry(entry)) return `fuel:${entry.id}`;
  if (type === "trips" && canManageTripEntry(entry)) return `trips:${entry.id}`;
  return null;
}

function getAnomalyOwnerText(type, entry) {
  if (type === "fuel") return `${entry?.payer || "the fuel payer"} can edit this fuel log from History.`;
  return `${entry?.driver || "the driver"} can edit this trip from History.`;
}

function createEntryAnomaly({ severity = "warning", text, type, entry }) {
  return {
    severity,
    text,
    target: getAnomalyEditTarget(type, entry),
    ownerText: getAnomalyOwnerText(type, entry),
    entryLevel: true
  };
}

function getCurrentPeriodFuelAnomalies(ledger) {
  const anomalies = [];
  const fallbackPrice = Math.max(0.1, Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice);
  const referencePrice = latestFuelPrice && Number(latestFuelPrice.price) > 0 ? Number(latestFuelPrice.price) : fallbackPrice;

  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    const label = `${fuel.payer || "Unknown"}${fuel.date ? ` · ${formatDate(fuel.date)}` : ""}`;

    if (amount >= 500 && !(liters > 0)) {
      anomalies.push(createEntryAnomaly({
        severity: "warning",
        text: `${label}: ${formatMoney(amount)} is missing liters, so DKK/L and consumption cannot be verified.`,
        type: "fuel",
        entry: fuel
      }));
      continue;
    }

    if (amount > 0 && liters > 0) {
      const pricePerLiter = amount / liters;
      if (isFuelPriceOutsideWarningRange(pricePerLiter)) {
        anomalies.push(createEntryAnomaly({
          severity: "issue",
          text: `${label}: ${formatMoneyFor(pricePerLiter, state.currency)}/L looks outside the configured fuel price range (${formatFuelPriceWarningRange()}).`,
          type: "fuel",
          entry: fuel
        }));
      } else if (referencePrice > 0) {
        const difference = Math.abs(pricePerLiter - referencePrice) / referencePrice;
        if (difference >= 0.25) {
          anomalies.push(createEntryAnomaly({
            severity: "warning",
            text: `${label}: ${formatMoneyFor(pricePerLiter, state.currency)}/L differs a lot from the current/reference price (${formatMoneyFor(referencePrice, state.currency)}/L).`,
            type: "fuel",
            entry: fuel
          }));
        }
      }
    }
  }

  for (const trip of state.trips) {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    const label = `${trip.driver || "Unknown"}${trip.date ? ` · ${formatDate(trip.date)}` : ""}`;
    if (km > 1000) {
      anomalies.push(createEntryAnomaly({
        severity: "warning",
        text: `${label}: ${formatNumber(km)} km is unusually long for one trip; check start/end odometer.`,
        type: "trips",
        entry: trip
      }));
    }
  }

  if (ledger.totalTripKm > 0 && ledger.totalFuelLiters > 0) {
    const periodConsumption = ledger.totalFuelLiters / ledger.totalTripKm * 100;
    if (periodConsumption < 3 || periodConsumption > 9) {
      const entryAnomalyCount = anomalies.filter((item) => item.entryLevel).length;
      anomalies.push({
        severity: "issue",
        text: `Current period consumption is ${formatNumber(periodConsumption)} L/100 km. That is unusual for this car; check fuel logs, trip distance, or whether fuel belongs to this period.`,
        ownerText: entryAnomalyCount
          ? "Review the linked fuel/trip anomalies above, or use History to edit your own current-period entries."
          : "No single bad entry was identified. This warning comes from the period total; review recent fuel logs and trip distance in History."
      });
    }
  }

  return anomalies;
}

function isCriticalFuelValidationWarning(warning) {
  const text = String(warning || "").toLowerCase();
  return text.includes("unusually high")
    || text.includes("unusual price")
    || text.includes("unusual for this car")
    || text.includes("duplicate fuel")
    || text.includes("wrong amounts")
    || text.includes("wrong amount");
}

function getCurrentPeriodHealthPrediction(ledger) {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const validationWarnings = getFuelValidationWarnings(ledger);
  const criticalValidationWarnings = validationWarnings.filter(isCriticalFuelValidationWarning);
  const fuelAnomalies = getCurrentPeriodFuelAnomalies(ledger);
  const openPayments = ledger.settlements.filter((settlement) => {
    const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]);
    return status === "open";
  }).length;
  const paidPayments = ledger.settlements.filter((settlement) => normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]) === "paid").length;

  let status = "Looks normal";
  let tone = "ok";
  const reasons = [];
  const actions = [];

  if (!ledger.totalTripKm && !ledger.totalPaid) {
    return {
      status: "Waiting for data",
      tone: "warning",
      reasons: ["Add trips and fuel logs to get a useful current-period prediction."],
      actions: ["Log real trips and receipts before using predictions."],
      estimate,
      validationWarnings,
      fuelAnomalies,
      openPayments,
      paidPayments
    };
  }

  if (criticalValidationWarnings.length || fuelAnomalies.some((item) => item.severity === "issue")) {
    status = "Check before settling";
    tone = "issue";
  } else if (validationWarnings.length || fuelAnomalies.length || openPayments > 0) {
    status = "Caution";
    tone = "warning";
  }

  if (estimate.hasEstimate) {
    if (estimate.coveragePercent > 135) {
      reasons.push(`Fuel logged is ${formatNumber(estimate.coveragePercent)}% of the expected amount for this period.`);
      actions.push("Check for duplicate fuel logs, wrong amounts/liters, or missing trip distance.");
    } else if (estimate.coveragePercent < 70) {
      reasons.push(`Fuel logged is only ${formatNumber(estimate.coveragePercent)}% of expected.`);
      actions.push("Add missing fuel receipts before requesting payments.");
    } else {
      reasons.push(`Fuel coverage is ${formatNumber(estimate.coveragePercent)}% of expected.`);
    }
  }

  if (fuelAnomalies.length) {
    const entryLinked = fuelAnomalies.filter((item) => item.entryLevel).length;
    reasons.push(`${fuelAnomalies.length} anomaly ${fuelAnomalies.length === 1 ? "was" : "were"} detected${entryLinked ? `, including ${entryLinked} linked entr${entryLinked === 1 ? "y" : "ies"}` : " at period level"}.`);
  }
  if (openPayments > 0) {
    reasons.push(`${openPayments} final payment${openPayments === 1 ? " is" : "s are"} still open.`);
  }
  if (paidPayments > 0) {
    reasons.push(`${paidPayments} payment${paidPayments === 1 ? " is" : "s are"} marked paid, so the period is locked for new entries.`);
  }

  if (paidPayments > 0 && (fuelAnomalies.length || validationWarnings.length)) {
    actions.push("This period is locked because a payment is marked Paid. Reopen the paid payment before correcting trips or fuel logs.");
    actions.push("Review the outlier links below, or use History to edit your own current-period entries.");
    actions.push("After corrections, request/mark paid again, then close the period as admin.");
  } else {
    if (fuelAnomalies.length || criticalValidationWarnings.length) {
      actions.push("Review the outlier links below, or use History to edit your own current-period entries before settling.");
    }
    if (openPayments > 0) {
      actions.push("Request open final payments before closing the period.");
    }
    if (paidPayments > 0) {
      actions.push("Close the period before logging more trips/fuel, or reopen the paid payment to correct this period.");
    }
  }

  if (!actions.length) {
    actions.push(tone === "ok" ? "No obvious data issue. Continue with the normal settlement flow." : "Review the warnings before requesting payments.");
  }

  return { status, tone, reasons, actions, estimate, validationWarnings, fuelAnomalies, openPayments, paidPayments };
}

function getLatestMonthlySignal() {
  const months = buildMonthlyMemberSummaries().filter((month) => month.tripCount || month.fuelLogCount);
  if (!months.length) return null;
  const latest = months[0];
  const people = Object.values(latest.people || {})
    .filter((person) => person.joinedTrips || person.drivenTrips || person.fuelLogs || person.fuelPaid)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  if (!people.length) return { month: latest, text: "No active members in the latest month yet." };
  const biggest = people[0];
  const direction = biggest.net >= 0 ? "paid more than their estimated share" : "used more fuel than they paid for";
  return {
    month: latest,
    text: `${biggest.name} has the largest monthly net in ${latest.label}: ${formatMoneyFor(biggest.net, state.currency)} (${direction}).`
  };
}

function getUpcomingEstimatedBookingDistance() {
  const now = new Date();
  return (state.bookings || []).reduce((sum, booking) => {
    const end = parseBookingDate(booking.end);
    const distance = Number(booking.plannedDistanceKm || 0);
    if (!end || end < now || !(distance > 0)) return sum;
    return sum + distance;
  }, 0);
}

function buildSmartPredictions(ledger) {
  const intel = buildFuelIntelligence(ledger);
  const health = getCurrentPeriodHealthPrediction(ledger);
  const distance = els.tripEstimateDistance ? Number(els.tripEstimateDistance.value || 0) : 0;
  const participants = Math.max(1, getTripEstimatorParticipants().length || 1);
  const planDistance = distance > 0 ? distance : 100;
  const planEstimate = calculateTripCostEstimate(planDistance, participants);
  const actualRefuel = buildRefuelPlanning(0);
  const upcomingBookingDistance = getUpcomingEstimatedBookingDistance();
  const upcomingBookingRefuel = upcomingBookingDistance > 0 ? buildRefuelPlanning(upcomingBookingDistance) : null;
  const monthlySignal = intel.consumptionLooksRealistic ? getLatestMonthlySignal() : null;
  const historicalQuality = intel.consumptionLooksRealistic && intel.confidence !== "Low" ? "Good" : intel.confidence === "Low" ? "Limited" : "Needs cleanup";
  const planningConfidence = intel.canUseHistoricalForPlanning ? intel.confidence : latestFuelPrice?.price || intel.effectivePrice ? "Medium" : "Low";
  const planningNote = distance > 0 ? "Using your booking estimate distance." : "Using a 100 km reference because no planned booking distance is entered.";
  return { intel, health, planDistance, participants, planEstimate, actualRefuel, upcomingBookingDistance, upcomingBookingRefuel, monthlySignal, historicalQuality, planningConfidence, planningNote };
}

function renderSmartPredictions(ledger) {
  if (!els.smartPredictions) return;
  const prediction = buildSmartPredictions(ledger);
  const hasData = state.trips.length || state.fuel.length || state.closedPeriods.length;

  if (!hasData) {
    els.smartPredictions.className = "smart-predictions empty-state";
    els.smartPredictions.textContent = "Add trips and fuel receipts to get smart predictions.";
    return;
  }

  const health = prediction.health;
  const toneClass = health.tone === "ok" ? "ok" : health.tone === "issue" ? "issue" : "warning";
  const entryAnomalyCount = health.fuelAnomalies.filter((item) => item.entryLevel).length;
  const reviewCandidateCounts = getHistoryReviewCandidateCount(ledger);
  const editableAnomalyCount = health.fuelAnomalies.filter((item) => item.target).length;
  const anomalyItems = health.fuelAnomalies.slice(0, 6).map((item) => {
    const action = item.target
      ? ` <button class="subtle-button compact-button" type="button" data-edit="${escapeHtml(item.target)}">Edit</button>`
      : "";
    const owner = item.target ? "" : item.ownerText ? ` <small>${escapeHtml(item.ownerText)}</small>` : "";
    return `<li>${escapeHtml(item.text)}${action}${owner}</li>`;
  }).join("");
  const hiddenAnomalyCount = Math.max(0, health.fuelAnomalies.length - 6);
  const hasPeriodLevelWarning = health.fuelAnomalies.some((item) => !item.entryLevel);
  const outlierHelp = health.fuelAnomalies.length
    ? editableAnomalyCount
      ? "Use Edit on linked items before settlement."
      : entryAnomalyCount
        ? "Use History to ask the owner to edit linked entries."
        : reviewCandidateCounts.total
          ? `Period-level warning; ${reviewCandidateCounts.total} candidate entr${reviewCandidateCounts.total === 1 ? "y" : "ies"} worth reviewing in History.`
          : "Period-level warning; no single bad entry found."
    : "No current-period outlier found.";
  const historicalTone = prediction.historicalQuality === "Good" ? "ok" : "warning";
  const planningTone = prediction.planningConfidence === "High" ? "ok" : prediction.planningConfidence === "Low" ? "issue" : "warning";
  const tankNow = prediction.actualRefuel;
  const tankNowText = tankNow.latestFuelOdometer
    ? `${formatNumber(tankNow.estimatedRangeRemaining)} km now`
    : `${formatNumber(tankNow.fullTankRange)} km full`;
  const upcomingBookingCard = prediction.upcomingBookingRefuel ? `
      <article class="smart-card smart-card-${prediction.upcomingBookingRefuel.tone === "warning" ? "warning" : "ok"}">
        <span>Booked trip range</span>
        <strong>${formatNumber(prediction.upcomingBookingRefuel.projectedRangeRemaining)} km after bookings</strong>
        <small>Saved bookings include ${formatNumber(prediction.upcomingBookingDistance)} km of estimated driving. ${escapeHtml(prediction.upcomingBookingRefuel.recommendation)}</small>
      </article>` : "";

  els.smartPredictions.className = "smart-predictions";
  els.smartPredictions.innerHTML = `
    <div class="smart-prediction-grid">
      <article class="smart-card smart-card-${toneClass}">
        <span>Current period health</span>
        <strong>${escapeHtml(health.status)}</strong>
        <small>${health.reasons.length ? escapeHtml(health.reasons[0]) : "No unusual signal found."}</small>
      </article>
      <article>
        <span>Planning estimate</span>
        <strong>${formatMoneyFor(prediction.planEstimate.totalCost, state.currency)}</strong>
        <small>${formatNumber(prediction.planDistance)} km · ${prediction.participants} person${prediction.participants === 1 ? "" : "s"} · ${formatMoneyFor(prediction.planEstimate.perPerson, state.currency)} each.</small>
      </article>
      <article>
        <span>Planning source</span>
        <strong>${escapeHtml(prediction.intel.estimateSource)}</strong>
        <small>${escapeHtml(prediction.planningNote)}</small>
      </article>
      <article>
        <span>Planning confidence</span>
        <strong><span class="status-pill status-${planningTone}">${prediction.planningConfidence}</span></strong>
        <small>${prediction.intel.canUseHistoricalForPlanning ? "Uses clean historical cost/km." : "Uses car setting because historical data is not trusted for planning."}</small>
      </article>
      <article class="smart-card smart-card-${tankNow.tone === "warning" ? "warning" : "ok"}">
        <span>Tank range now</span>
        <strong>${tankNowText}</strong>
        <small>${escapeHtml(tankNow.recommendation)} Unsaved Plan Trip estimates are only shown in the Plan panel.</small>
      </article>
      ${upcomingBookingCard}
      <article>
        <span>Historical data quality</span>
        <strong><span class="status-pill status-${historicalTone}">${prediction.historicalQuality}</span></strong>
        <small>${prediction.intel.consumptionLooksRealistic ? "Historical consumption looks plausible." : "Historical consumption looks unusual and is ignored for planning."}</small>
      </article>
      <article>
        <span>Outliers to review</span>
        <strong>${health.fuelAnomalies.length}</strong>
        <small>${escapeHtml(outlierHelp)}</small>
      </article>
    </div>
    <div class="smart-prediction-details">
      <article>
        <h3>Suggested action</h3>
        <ul>${health.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>
      </article>
      <article>
        <h3>Why this estimate?</h3>
        <p>${escapeHtml(prediction.planEstimate.explanation)}</p>
        ${!prediction.intel.consumptionLooksRealistic ? `<p>After the production reset and a few real fuel logs, the historical model will become more useful.</p>` : ""}
        ${prediction.monthlySignal ? `<p>${escapeHtml(prediction.monthlySignal.text)}</p>` : ""}
      </article>
      ${health.fuelAnomalies.length ? `<article><h3>Outliers and next steps</h3><ul>${anomalyItems}${hiddenAnomalyCount ? `<li>${hiddenAnomalyCount} more not shown here. Use History to review all current-period entries.</li>` : ""}${hasPeriodLevelWarning && reviewCandidateCounts.total ? `<li>No definite bad entry was identified, but ${reviewCandidateCounts.total} candidate entr${reviewCandidateCounts.total === 1 ? "y is" : "ies are"} worth reviewing in History.</li>` : ""}</ul>${hasPeriodLevelWarning ? `<button class="subtle-button compact-button" type="button" data-review-period="true">Review period data</button><p class="entry-meta">Opens History and expands current-period trips/fuel so you can inspect totals, review candidate entries, and edit entries you own.</p>` : ""}</article>` : ""}
    </div>
  `;
}


function renderMonthlyMemberSummaries() {
  if (!els.monthlyMemberSummaries) return;
  const months = buildMonthlyMemberSummaries().filter((month) => month.tripCount || month.fuelLogCount);

  if (!months.length) {
    els.monthlyMemberSummaries.className = "monthly-summary empty-state";
    els.monthlyMemberSummaries.textContent = "Add trips and fuel receipts to build monthly member summaries.";
    return;
  }

  els.monthlyMemberSummaries.className = "monthly-summary";
  els.monthlyMemberSummaries.innerHTML = months.slice(0, 12).map((month, index) => renderMonthlySummaryCard(month, index === 0)).join("");
}

function renderMonthlySummaryCard(month, open) {
  const people = Object.values(month.people)
    .filter((person) => person.joinedTrips || person.drivenTrips || person.fuelLogs || person.fuelPaid)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name));

  return `
    <details class="monthly-summary-card" ${open ? "open" : ""}>
      <summary>
        <div>
          <strong>${escapeHtml(month.label)}</strong>
          <p>${month.tripCount} trip${month.tripCount === 1 ? "" : "s"} · ${month.fuelLogCount} fuel log${month.fuelLogCount === 1 ? "" : "s"} · ${formatNumber(month.totalTripKm)} km</p>
        </div>
        <span>${formatMoneyFor(month.totalFuelPaid, state.currency)}</span>
      </summary>
      <div class="period-stats monthly-stats">
        <div><span>Trip km</span><b>${formatNumber(month.totalTripKm)} km</b></div>
        <div><span>Distance share</span><b>${formatNumber(month.totalParticipantKm)} km</b></div>
        <div><span>Fuel paid</span><b>${formatMoneyFor(month.totalFuelPaid, state.currency)}</b></div>
        <div><span>Fuel rate</span><b>${month.fuelRate > 0 ? `${formatMoneyFor(month.fuelRate, state.currency)}/km` : "-"}</b></div>
        <div><span>Liters</span><b>${month.totalLiters > 0 ? `${formatNumber(month.totalLiters)} L` : "-"}</b></div>
        <div><span>People active</span><b>${people.length}</b></div>
      </div>
      ${people.length ? `
        <div class="responsive-table-wrap">
          <table class="monthly-member-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Driven</th>
                <th>Joined</th>
                <th>Distance share</th>
                <th>Fuel paid</th>
                <th>Fuel share</th>
                <th>Monthly net</th>
              </tr>
            </thead>
            <tbody>
              ${people.map((person) => `
                <tr>
                  <td>${escapeHtml(person.name)}</td>
                  <td>${person.drivenTrips} · ${formatNumber(person.drivenKm)} km</td>
                  <td>${person.joinedTrips}</td>
                  <td>${formatNumber(person.distanceShare)} km</td>
                  <td>${formatMoneyFor(person.fuelPaid, state.currency)}${person.fuelLogs ? `<br><small>${person.fuelLogs} log${person.fuelLogs === 1 ? "" : "s"}</small>` : ""}</td>
                  <td>${formatMoneyFor(person.fuelShare, state.currency)}</td>
                  <td><strong class="${person.net >= 0 ? "positive-net" : "negative-net"}">${person.net >= 0 ? "+" : ""}${formatMoneyFor(person.net, state.currency)}</strong></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        <p class="entry-meta">Monthly net = fuel paid minus estimated fuel share for that month. Positive means the person paid more fuel than their share; negative means they used more fuel than they paid for.</p>
      ` : `<p class="entry-meta">No member activity for this month.</p>`}
    </details>
  `;
}

function renderSummary(ledger) {
  els.totalKm.textContent = formatNumber(ledger.totalKm);
  els.fuelRate.textContent = `${formatMoney(ledger.fuelRate)}/km`;
  els.totalCost.textContent = formatMoney(ledger.totalCost);
  els.totalPaid.textContent = formatMoney(ledger.totalPaid);
}

function renderBalances(ledger) {
  els.peopleBalances.innerHTML = state.members
    .map((member) => {
      const person = ledger.people[member];
      return `
        <article class="person-card">
          <header>
            <strong>${escapeHtml(member)}</strong>
          </header>
          <div class="stat-row"><span>Distance share</span><b>${formatNumber(person.km)} km</b></div>
          <div class="stat-row"><span>Fuel share</span><b>${formatMoney(person.tripCost)}</b></div>
          <div class="stat-row"><span>Fuel paid</span><b>${formatMoney(person.fuelPaid)}</b></div>
        </article>
      `;
    })
    .join("");
}

function shouldShowSettlementToCurrentUser(settlement) {
  if (!settlement) return false;
  if (canManageSettings()) return true;
  const profile = getCurrentMemberProfile();
  if (!profile?.name) return false;
  return settlement.from === profile.name || settlement.to === profile.name;
}

function getVisibleSettlements(ledger) {
  return (ledger?.settlements || []).filter(shouldShowSettlementToCurrentUser);
}


function getSettlementProgress(ledger) {
  return summarizeSettlementProgress(ledger?.settlements, (item) => state.paymentStatuses[settlementKey(item)]);
}

function buildClosePeriodSummary(ledger) {
  const progress = getSettlementProgress(ledger);
  const requestedNotPaid = progress.requestedCount;
  return [
    `${progress.totalCount} final payment${progress.totalCount === 1 ? "" : "s"}`,
    `${progress.paidCount} paid`,
    `${requestedNotPaid} requested but not marked paid`,
    `${progress.openCount} open`
  ].join(" · ");
}

function buildClosePeriodConfirmation(ledger) {
  const progress = getSettlementProgress(ledger);
  const lines = [
    `Close ${ledger.period.label}?`,
    "",
    `This archives ${formatNumber(ledger.totalKm)} participant km and ${formatMoney(ledger.totalPaid)} in fuel, then starts a fresh period.`,
    "",
    `Settlement status: ${buildClosePeriodSummary(ledger)}.`
  ];

  if (progress.requestedCount > 0) {
    lines.push(
      "",
      `${progress.requestedCount} payment${progress.requestedCount === 1 ? " is" : "s are"} requested but not marked paid yet. You can still close the period if the MobilePay requests have been sent, but this period will be archived with those payment${progress.requestedCount === 1 ? "" : "s"} still marked Requested.`
    );
  }

  lines.push("", "Continue?");
  return lines.join("\n");
}

function renderSettlements(ledger) {
  const isAdminView = canManageSettings();
  const settlementProgress = getSettlementProgress(ledger);
  els.closePeriod.classList.toggle("hidden", !isAdminView);
  els.closePeriod.disabled = !isAdminView || (state.trips.length === 0 && state.fuel.length === 0) || settlementProgress.openCount > 0;
  els.closePeriod.title = settlementProgress.openCount > 0 ? "Request all settlement payments before closing this period." : "Close this settlement period and start a fresh one for new trips/fuel.";

  renderSettlementWarning(ledger);
  renderPeriodBreakdown(ledger);

  const visibleSettlements = getVisibleSettlements(ledger);

  if (ledger.settlements.length === 0) {
    els.paymentOverview.replaceChildren();
    if (els.memberActionPanel) els.memberActionPanel.replaceChildren();
    els.settlements.replaceChildren(emptyNode("All even."));
    return;
  }

  // Rendering must be read-only. Stale payment status keys are ignored here and
  // cleaned up during explicit save/period-close flows instead of writing while rendering.
  renderPaymentOverview(ledger, visibleSettlements);
  renderMemberActionPanel(ledger, visibleSettlements);

  if (visibleSettlements.length === 0) {
    els.settlements.replaceChildren(emptyNode("No final payments involve you in this period."));
    return;
  }

  els.settlements.innerHTML = visibleSettlements
    .map(
      (item) => {
        const key = settlementKey(item);
        const status = normalizePaymentStatus(state.paymentStatuses[key]);
        const fromPerson = ledger.people[item.from];
        const toPerson = ledger.people[item.to];
        const message = `${item.from} pays ${item.to} ${formatMoney(item.amount)} for shared car fuel`;
        const paymentRef = createPaymentRef({ scope: "current", key, from: item.from, to: item.to, amount: item.amount });
        const normalizedPaymentRef = normalizePaymentRefValue(paymentRef);
        const canRequest = canManageSettlementRequest(item);
        const canMarkPaid = canMarkSettlementPaid(item);
        const pending = pendingSettlementRequestKeys.has(key);
        let requestControls = "";

        if (status === "open") {
          requestControls += canRequest
            ? `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="requested" ${pending ? "disabled" : ""}>${pending ? "Requesting..." : "Requested"}</button>`
            : `<span class="request-note">Only ${escapeHtml(item.to)} can request this payment.</span>`;
        } else if (status === "requested") {
          if (canMarkPaid) {
            const mobilePayPrompt = getMobilePayReturnPrompt(key);
            requestControls += `<button class="subtle-button compact-button" type="button" data-copy="${escapeHtml(formatPaymentAmountOnly(item.amount))}">Copy amount</button>`;
            requestControls += `<button class="primary-action compact-button" type="button" data-open-mobilepay="true" data-payment-key="${escapeHtml(key)}">Open MobilePay</button>`;
            requestControls += `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="paid" ${pending ? "disabled" : ""}>${pending ? "Marking paid..." : "Mark paid"}</button>`;
            requestControls += mobilePayPrompt
              ? `<span class="request-note mobilepay-helper">MobilePay opened. After paying ${escapeHtml(mobilePayPrompt.amount)} to ${escapeHtml(mobilePayPrompt.to)}, return here and tap Mark paid.</span>`
              : `<span class="request-note mobilepay-helper">Open MobilePay, pay manually, then return and tap Mark paid.</span>`;
          } else {
            requestControls += `<span class="request-note">Waiting for ${escapeHtml(item.from)} to pay.</span>`;
          }
          if (canRequest) {
            requestControls += `<button class="subtle-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-reminder="true" ${pending ? "disabled" : ""}>Send reminder</button>`;
            requestControls += `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open" ${pending ? "disabled" : ""}>${pending ? "Reopening..." : "Reopen"}</button>`;
          }
        } else if (status === "paid") {
          requestControls += `<span class="request-note">Marked paid in the app.</span>`;
          if (canRequest || canManageSettings()) {
            requestControls += `<button class="text-button compact-button" type="button" data-payment-key="${escapeHtml(key)}" data-payment-status="open" ${pending ? "disabled" : ""}>${pending ? "Reopening..." : "Reopen"}</button>`;
          }
        }

        return `
        <article class="settlement-card ${status === "requested" ? "is-requested" : ""} ${status === "paid" ? "is-paid" : ""}" data-payment-ref="${escapeHtml(normalizedPaymentRef)}">
          <div class="settlement-main">
            <div class="settlement-kicker">
              <span class="log-ref payment-ref">${escapeHtml(formatPaymentRef(paymentRef))}</span>
              <span class="status-chip ${status}">${statusLabel(status)}</span>
            </div>
            <div class="settlement-route" aria-label="${escapeHtml(message)}">
              <span class="settlement-person">${escapeHtml(item.from)}</span>
              <span class="settlement-route-action">pays</span>
              <span class="settlement-person">${escapeHtml(item.to)}</span>
            </div>
            ${renderSettlementPaymentStory(item, ledger, { trips: state.trips, fuel: state.fuel, currency: state.currency })}
            <p class="payment-evidence-line">${escapeHtml(renderPaymentEvidenceSummary(item, { trips: state.trips, fuel: state.fuel, currency: state.currency, chargedKm: Number(optionalRecordValue(ledger?.people, item.from)?.km || 0) }))}</p>
            <div class="settlement-detail-row">
              <details class="settlement-details">
                <summary>Calculation</summary>
                ${renderSettlementMathDetails(item, ledger)}
              </details>
              <details class="settlement-details">
                <summary>Linked trips & fuel</summary>
                ${renderPaymentEvidenceDetails(item, { trips: state.trips, fuel: state.fuel, currency: state.currency })}
              </details>
            </div>
          </div>
          <div class="settlement-actions">
            <strong>${formatMoney(item.amount)}</strong>
            <div class="settlement-action-buttons">${requestControls}</div>
          </div>
        </article>
      `;
      }
    )
    .join("");
}

function cloudSyncAgeMs() {
  const timestamp = Date.parse(lastCloudSyncAt || lastCloudSaveAt || "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Infinity;
}

function shouldWarnBeforeCriticalCloudAction() {
  if (!supabaseClient || !currentSession) return false;
  if (pendingLocalChanges > 0 || lastSyncError) return true;
  return cloudSyncAgeMs() > 10 * 60 * 1000;
}

async function confirmFreshCloudStateForCriticalAction(actionLabel) {
  if (!shouldWarnBeforeCriticalCloudAction()) return true;
  const message = lastSyncError
    ? `${actionLabel} changes shared data, but the latest cloud sync failed: ${lastSyncError}. Try syncing now before continuing?`
    : pendingLocalChanges > 0
      ? `${actionLabel} changes shared data, but this device has ${pendingLocalChanges} unsynced local change${pendingLocalChanges === 1 ? "" : "s"}. Sync now before continuing?`
      : `${actionLabel} changes shared data. Your last confirmed cloud sync is more than 10 minutes old. Sync now before continuing?`;
  if (!confirmUserAction(message)) return false;
  const loaded = await loadSupabaseStateWithTimeout(
    { force: true, reason: `critical-action:${actionLabel}`, manual: true },
    supabaseStartupLoadTimeoutMs,
    `${actionLabel} cloud refresh is delayed.`
  );
  if (loaded) return true;
  return confirmUserAction(`${actionLabel} could not refresh shared data first. Continue anyway using the local copy?`);
}

async function closeCurrentPeriod(options = {}) {
  if (!(await confirmFreshCloudStateForCriticalAction("Close period"))) return;
  if (!canManageSettings() && !options.allowMemberClose) {
    showUserError("Only an admin can close periods manually.");
    return;
  }
  if (state.trips.length === 0 && state.fuel.length === 0) {
    showUserError("Add trips or fuel before closing a period.");
    return;
  }

  const ledger = calculateLedger();
  const settlementProgress = getSettlementProgress(ledger);
  const readiness = window.FuelPeriodClosing?.getClosePeriodReadiness({
    isAdmin: canManageSettings(),
    closingInProgress: closingPeriodInProgress,
    trips: state.trips,
    fuel: state.fuel,
    closedPeriods: state.closedPeriods,
    progress: settlementProgress,
    options
  });
  if (readiness && !readiness.ok) {
    showUserError(readiness.firstMessage);
    return;
  }

  const missingRequiredFuel = getMissingRequiredFuelTasksForCurrentPeriod();
  if (missingRequiredFuel.length > 0 && !options.skipRequiredBookingFuel) {
    showUserError(buildMissingRequiredFuelMessage(missingRequiredFuel, "close this period"));
    setActiveView("log");
    render();
    window.setTimeout(() => els.pendingLogsPanel?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return;
  }

  if (!options.skipFuelValidation && isFuelEstimateWarningActive(ledger)) {
    if (!confirmUserAction(buildFuelValidationMessage(ledger, "close this period anyway"))) return;
  }

  if (!options.skipConfirm && !confirmUserAction(buildClosePeriodConfirmation(ledger))) {
    return;
  }

  closingPeriodInProgress = true;
  els.closePeriod.disabled = true;
  els.closePeriod.textContent = "Closing...";

  try {
    try {
      await exportAdminSafetyBackup("close current period");
      assertFreshAdminSafetyBackup("close current period");
    } catch (error) {
      showUserError(error.message || String(error));
      return;
    }

  const period = {
    id: crypto.randomUUID(),
    closedAt: new Date().toISOString(),
    label: ledger.period.label,
    currency: state.currency,
    totalTripKm: ledger.totalTripKm,
    totalKm: ledger.totalKm,
    fuelRate: roundMoney(ledger.fuelRate),
    totalCost: ledger.totalCost,
    totalPaid: ledger.totalPaid,
    entryFingerprint: readiness?.entryFingerprint || window.FuelPeriodClosing?.periodEntryFingerprint?.(state.trips, state.fuel) || "",
    people: state.members.map((member) => ({
      name: member,
      km: ledger.people[member].km,
      fuelShare: ledger.people[member].tripCost,
      fuelPaid: ledger.people[member].fuelPaid
    })),
    settlements: ledger.settlements.map((item) => {
      const key = settlementKey(item);
      return {
        ...item,
        status: normalizePaymentStatus(state.paymentStatuses[key]),
        requestedAt: getPaymentAuditCreatedAtIso(state.auditLog, key, "payment_requested"),
        lastReminderAt: getPaymentAuditCreatedAtIso(state.auditLog, key, "payment_reminder_sent"),
        reminderCount: getPaymentAuditEntries(state.auditLog, key, "payment_reminder_sent").length,
        paymentKey: key
      };
    }),
    trips: structuredClone(state.trips),
    fuel: structuredClone(state.fuel),
    auditLog: []
  };

  const closeAuditEntry = makeAuditEntry({
    type: "settlement_closed",
    entityType: "settlement_period",
    entityId: period.id,
    summary: `${period.label} · ${formatMoney(period.totalCost)}`,
    detail: `${period.trips.length} trip${period.trips.length === 1 ? "" : "s"}, ${period.fuel.length} fuel log${period.fuel.length === 1 ? "" : "s"}`
  });
  const unpaidCloseNoticeEntries = await buildSettlementClosedUnpaidNoticeEntries(ledger, period);
  period.auditLog = auditLog.normalizeAuditEntries([
    ...unpaidCloseNoticeEntries,
    closeAuditEntry,
    ...getSettlementAuditEntries(state.auditLog)
  ]);

  if (!(await closeNormalizedPeriodFirst(period))) {
    return;
  }

  state.closedPeriods.unshift(period);
  state.trips = [];
  state.fuel = [];
  state.paymentStatuses = {};
  state.auditLog = getBookingActivityEntries(state.auditLog);
  auditLogDirty = true;
  state.lastOdometer = getLatestOdometer();
  saveState();
  setDefaultDates();
  setActiveHistorySection("archive");
  render();
  showAppMessage("Settlement period closed. A fresh period is ready.");
  } finally {
    closingPeriodInProgress = false;
    if (els.closePeriod) {
      els.closePeriod.textContent = "Close period";
    }
  }
}

async function closeNormalizedPeriodFirst(periodSnapshot) {
  if (!supabaseClient || !currentSession) return true;

  try {
    setSyncStatus("Saving", { source: "period-close" });
    const context = await getNormalizedWriteContext();
    if (!context?.openPeriodId) return true;

    periodCloseRpcArmUntil = Date.now() + 5000;
    const rpcResult = await closeNormalizedPeriodWithRpc(context, periodSnapshot);
    if (rpcResult.ok) {
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: "Closed the normalized settlement period through the database transaction RPC and opened a fresh period. JSON will be updated as backup."
      };
      return true;
    }

    if (!rpcResult.shouldFallback) {
      throw rpcResult.error || new Error("Could not close the normalized settlement period.");
    }

    console.warn("Period-close RPC is unavailable; falling back to guarded table updates. Apply the latest supabase-schema.sql to enable transactional period closing.", rpcResult.error);
    await closeNormalizedPeriodWithGuardedTableUpdates(context, periodSnapshot);

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Closed the normalized settlement period with guarded table updates. Apply the latest Supabase schema to use the transaction RPC."
    };
    return true;
  } catch (error) {
    console.warn("Table-primary period close failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not close the normalized settlement period, so JSON was not changed: ${error.message || error}`
    };
    showUserError("Could not close this period in the normalized database. The period was not archived. Check the console for details.");
    render();
    return false;
  }
}

async function closeNormalizedPeriodWithRpc(context, periodSnapshot) {
  if (Date.now() > periodCloseRpcArmUntil) {
    throw new Error("Blocked close_settlement_period RPC outside the real close-period flow.");
  }
  if (!context?.openPeriodId || !periodSnapshot || typeof periodSnapshot !== "object") {
    throw new Error("Blocked close_settlement_period RPC because the open period or snapshot is missing.");
  }
  const { data, error } = await supabaseClient.rpc("close_settlement_period", {
    target_ledger_id: context.ledgerId,
    target_period_id: context.openPeriodId,
    period_snapshot: periodSnapshot
  });

  if (!error) return { ok: true, data };

  return {
    ok: false,
    error,
    shouldFallback: isMissingPeriodCloseRpcError(error)
  };
}

function isMissingPeriodCloseRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || /close_settlement_period/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message);
}

async function closeNormalizedPeriodWithGuardedTableUpdates(context, periodSnapshot) {
  const existingPeriod = await supabaseClient
    .from("settlement_periods")
    .select("id, snapshot_json")
    .eq("id", context.openPeriodId)
    .maybeSingle();
  if (existingPeriod.error) throw existingPeriod.error;
  if (existingPeriod.data?.snapshot_json?.entryFingerprint === periodSnapshot.entryFingerprint) {
    throw new Error("This settlement period snapshot has already been written to the normalized database.");
  }

  const closedAt = periodSnapshot.closedAt || new Date().toISOString();
  const closeResult = await supabaseClient
    .from("settlement_periods")
    .update({
      status: "closed",
      label: periodSnapshot.label || "Closed period",
      closed_at: closedAt,
      snapshot_json: periodSnapshot,
      updated_at: new Date().toISOString()
    })
    .eq("id", context.openPeriodId)
    .eq("status", "open")
    .is("closed_at", null);
  if (closeResult.error) throw closeResult.error;

  await ensureOpenSettlementPeriod(context.ledgerId);
}

function renderSettlementWarning(ledger) {
  const warnings = getFuelValidationWarnings(ledger);
  const settlementProgress = getSettlementProgress(ledger);
  const missingRequiredFuel = getMissingRequiredFuelTasksForCurrentPeriod();
  const messages = [];

  if (missingRequiredFuel.length > 0) {
    messages.push(`${missingRequiredFuel.length} multi-day booking trip${missingRequiredFuel.length === 1 ? " needs" : "s need"} a linked full-tank fuel log before this period can be closed.`);
  }

  if (settlementProgress.openCount > 0) {
    messages.push(`Request all settlement payments before closing this period. ${settlementProgress.openCount} payment${settlementProgress.openCount === 1 ? " is" : "s are"} still not requested.`);
  }

  if (warnings.length > 0) {
    messages.push(`Settlement check: ${warnings[0]}`);
  }

  if (messages.length > 0) {
    els.settlementWarning.classList.remove("hidden");
    els.settlementWarning.textContent = messages.join(" ");
    return;
  }

  els.settlementWarning.classList.add("hidden");
  els.settlementWarning.textContent = "";
}

function renderPeriodBreakdown(ledger) {
  const activityStats = buildPeriodActivityStats(ledger);
  const fuelByPerson = Object.entries(ledger.fuelByPerson || {})
    .filter(([, amount]) => amount > 0)
    .map(([name, amount]) => {
      const liters = Number(optionalRecordValue(ledger.fuelLitersByPerson, name) || 0);
      const detail = liters > 0 ? `${formatMoney(amount)} · ${formatNumber(liters)} L` : formatMoney(amount);
      return `<li><span>${escapeHtml(name)}</span><b>${detail}</b></li>`;
    })
    .join("") || `<li><span>Fuel payments</span><b>None yet</b></li>`;

  const periodSummaryCard = `
    <div class="period-breakdown-card wide-breakdown settlement-period-overview period-summary-card">
      <span>Current settlement period</span>
      <div class="period-counter-grid compact-counters">
        <div><strong>${activityStats.tripCount}</strong><small>Trips</small></div>
        <div><strong>${activityStats.fuelCount}</strong><small>Fuel logs</small></div>
        <div><strong>${formatNumber(activityStats.totalTripKm)} km</strong><small>Trip km</small></div>
        <div><strong>${formatNumber(ledger.totalShareKm)} km</strong><small>Participant km</small></div>
        <div><strong>${formatMoney(activityStats.totalFuelPaid)}</strong><small>Fuel paid</small></div>
        <div><strong>${ledger.totalTripKm > 0 && ledger.totalPaid > 0 ? `${formatMoney(ledger.totalPaid / ledger.totalTripKm)}/km` : "—"}</strong><small>Cost per trip km</small></div>
      </div>
      <small>This is the active open period only. These totals are what the current settlement uses.</small>
    </div>
  `;

  const detailedCards = `
    ${renderFuelEstimateCard(ledger)}
    <div class="period-breakdown-card wide-breakdown fuel-consumption-card">
      <span>Fuel consumption in this period</span>
      <strong>${ledger.receiptConsumption > 0 ? `${formatNumber(ledger.receiptConsumption)} L/100 km` : "Not enough data"}</strong>
      <small>${ledger.receiptKmPerLiter > 0 ? `${formatNumber(ledger.receiptKmPerLiter)} km/L · ${formatNumber(ledger.totalFuelLiters)} L logged.` : "Add liters on fuel receipts to build consumption statistics."}</small>
    </div>
    ${renderHistoricalFuelStatsCard(ledger.historicalFuelStats)}
    <div class="period-breakdown-card wide-breakdown">
      <span>Fuel payments by payer</span>
      <ul>${fuelByPerson}</ul>
    </div>
    <div class="period-breakdown-card wide-breakdown full-breakdown">
      <span>Activity by person</span>
      <small>Per-person totals for this open settlement period.</small>
      ${renderPeriodActivityTable(activityStats)}
    </div>
  `;

  if (!canManageSettings()) {
    els.periodBreakdown.innerHTML = `
      ${periodSummaryCard}
      <details class="member-period-details wide-breakdown">
        <summary>Show period details</summary>
        <div class="period-breakdown member-period-details-grid">
          ${detailedCards}
        </div>
      </details>
    `;
    return;
  }

  els.periodBreakdown.innerHTML = `
    ${periodSummaryCard}
    ${detailedCards}
  `;
}

function buildPeriodActivityStats(ledger) {
  const byPerson = Object.fromEntries(
    state.members.map((member) => [
      member,
      {
        name: member,
        driverTrips: 0,
        joinedTrips: 0,
        distanceShare: Number(optionalRecordValue(ledger.people, member)?.km || 0),
        fuelLogs: 0,
        fuelPaid: Number(optionalRecordValue(ledger.people, member)?.fuelPaid || 0)
      }
    ])
  );

  let totalTripKm = 0;
  for (const trip of state.trips) {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    totalTripKm += km;
    if (byPerson[trip.driver]) byPerson[trip.driver].driverTrips += 1;
    for (const participant of getTripParticipants(trip)) {
      if (byPerson[participant]) byPerson[participant].joinedTrips += 1;
    }
  }

  let totalFuelPaid = 0;
  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    totalFuelPaid += amount;
    if (byPerson[fuel.payer]) byPerson[fuel.payer].fuelLogs += 1;
  }

  return {
    tripCount: state.trips.length,
    fuelCount: state.fuel.length,
    totalTripKm: round(totalTripKm),
    totalFuelPaid: roundMoney(totalFuelPaid),
    people: Object.values(byPerson)
      .filter((person) => person.driverTrips || person.joinedTrips || person.fuelLogs || person.distanceShare || person.fuelPaid)
      .sort((a, b) => (b.distanceShare + b.fuelPaid) - (a.distanceShare + a.fuelPaid) || a.name.localeCompare(b.name))
  };
}

function renderPeriodActivityTable(stats) {
  if (!stats.people.length) {
    return `<p class="entry-meta">No trips or fuel logs in this settlement period yet.</p>`;
  }

  return `
    <div class="activity-table" role="table" aria-label="Current period activity by person">
      <div class="activity-row activity-head" role="row">
        <span>Person</span>
        <span>Trips driven</span>
        <span>Trips joined</span>
        <span>Distance share</span>
        <span>Fuel logs</span>
        <span>Fuel paid</span>
      </div>
      ${stats.people.map((person) => `
        <div class="activity-row" role="row">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${person.driverTrips}</span>
          <span>${person.joinedTrips}</span>
          <span>${formatNumber(person.distanceShare)} km</span>
          <span>${person.fuelLogs}</span>
          <span>${formatMoney(person.fuelPaid)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHistoricalFuelStatsCard(stats = {}) {
  if (!stats.periodsWithTripKm) {
    return `
      <div class="period-breakdown-card wide-breakdown">
        <span>Historical average</span>
        <strong>Not enough data yet</strong>
        <small>Close settlement periods and enter liters on fuel receipts to build reliable planning stats.</small>
      </div>
    `;
  }

  const consumptionText = stats.litersPer100Km > 0
    ? `${formatNumber(stats.litersPer100Km)} L/100 km · ${formatNumber(stats.kmPerLiter)} km/L`
    : "Add liters to fuel logs";
  const priceText = stats.pricePerLiter > 0
    ? `${formatMoneyFor(stats.pricePerLiter, state.currency)}/L`
    : "Add liters to fuel logs";

  return `
    <div class="period-breakdown-card wide-breakdown">
      <span>Historical average for planning</span>
      <ul>
        <li><span>Fuel cost per trip km</span><b>${stats.costPerKm > 0 ? `${formatMoneyFor(stats.costPerKm, state.currency)}/km` : "Not enough data"}</b></li>
        <li><span>Average fuel price</span><b>${priceText}</b></li>
        <li><span>Fuel consumption</span><b>${consumptionText}</b></li>
        <li><span>Data used</span><b>${formatNumber(stats.totalTripKm)} km · ${formatMoneyFor(stats.totalPaid, state.currency)} · ${stats.fuelLogsWithLiters} fuel logs with liters</b></li>
      </ul>
    </div>
  `;
}

function renderFuelPaymentList(fuelPayments) {
  if (!fuelPayments || fuelPayments.length === 0) {
    return `<p class="entry-meta">No fuel payments have been added to this period.</p>`;
  }

  return `
    <ul class="included-fuel-list">
      ${fuelPayments
        .map((fuel) => {
          const liters = Number(fuel.liters || 0);
          const literText = liters > 0 ? ` · ${formatNumber(liters)} L · ${formatMoneyFor(Number(fuel.amount || 0) / liters, state.currency)}/L` : "";
          return `<li><span>${escapeHtml(fuel.payer)} · ${formatDate(fuel.date)}${literText}</span><b>${formatMoney(fuel.amount)}</b></li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderSettlementMathDetails(settlement, ledger) {
  const fromPerson = optionalRecordValue(ledger.people, settlement.from) || {};
  const toPerson = optionalRecordValue(ledger.people, settlement.to) || {};
  const fromFuelShare = Number(fromPerson.tripCost || 0);
  const fromFuelPaid = Number(fromPerson.fuelPaid || 0);
  const fromOwes = Math.max(0, fromFuelShare - fromFuelPaid);
  const toFuelShare = Number(toPerson.tripCost || 0);
  const toFuelPaid = Number(toPerson.fuelPaid || 0);
  const toIsOwed = Math.max(0, toFuelPaid - toFuelShare);

  return `
    <div class="settlement-math">
      <p class="entry-meta">The receipts form one shared fuel pool. The app first calculates each person’s fuel share from their distance share, then balances people who paid too little with people who paid too much.</p>
      <ul class="included-fuel-list settlement-math-list">
        <li><span>${escapeHtml(settlement.from)} distance share</span><b>${formatNumber(fromPerson.km || 0)} km</b></li>
        <li><span>${escapeHtml(settlement.from)} fuel share</span><b>${formatMoney(fromFuelShare)}</b></li>
        <li><span>${escapeHtml(settlement.from)} fuel paid</span><b>${formatMoney(fromFuelPaid)}</b></li>
        <li class="math-total"><span>${escapeHtml(settlement.from)} still owes</span><b>${formatMoney(fromOwes)}</b></li>
        <li><span>${escapeHtml(settlement.to)} fuel paid</span><b>${formatMoney(toFuelPaid)}</b></li>
        <li><span>${escapeHtml(settlement.to)} own fuel share</span><b>${formatMoney(toFuelShare)}</b></li>
        <li class="math-total"><span>${escapeHtml(settlement.to)} is owed</span><b>${formatMoney(toIsOwed)}</b></li>
        <li class="math-result"><span>This payment settles</span><b>${formatMoney(settlement.amount)}</b></li>
      </ul>
      <p class="entry-meta">So ${escapeHtml(settlement.from)} is not paying for a specific receipt. ${escapeHtml(settlement.from)} is paying ${escapeHtml(settlement.to)} because ${escapeHtml(settlement.to)} paid more into the shared fuel pool than their own share.</p>
    </div>
  `;
}

function renderFuelEstimateCard(ledger) {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  if (!estimate.hasEstimate || ledger.totalTripKm <= 0) {
    return `
      <div class="period-breakdown-card wide-breakdown estimate-card">
        <span>Fuel estimate</span>
        <strong>Not enough data yet</strong>
        <small>Add trip kilometers and configure fuel settings to estimate expected fuel cost.</small>
      </div>
    `;
  }

  const source = estimate.source === "live" ? "Circle K/INGO live price" : "fallback price";
  return `
    <div class="period-breakdown-card wide-breakdown estimate-card ${estimate.warningLevel !== "ok" ? "is-warning" : ""}">
      <span>Expected fuel cost check</span>
      <strong>${formatMoney(estimate.expectedCost)}</strong>
      <small>${formatNumber(ledger.totalTripKm)} km × ${formatNumber(estimate.consumption)} L/100 km × ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L (${escapeHtml(source)}). Logged fuel: ${formatMoney(ledger.totalPaid)} · Coverage: ${formatNumber(estimate.coveragePercent)}%.</small>
    </div>
  `;
}

function scheduleFuelPriceRefresh(delayMs = fuelPriceRefreshIntervalMs) {
  window.clearTimeout(fuelPriceTimer);
  fuelPriceTimer = window.setTimeout(refreshFuelPriceEstimate, delayMs);
}

function fetchFuelPriceWithTimeout(url, timeoutMs = fuelPriceFetchTimeoutMs) {
  if (typeof AbortController === "undefined") return fetch(url);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => window.clearTimeout(timeout));
}

async function refreshFuelPriceEstimate() {
  if (fuelPriceInFlight) return;
  window.clearTimeout(fuelPriceTimer);
  fuelPriceInFlight = true;
  const fuelType = state.fuelType || defaults.fuelType;
  try {
    const response = await fetchFuelPriceWithTimeout(`${fuelPriceUrl}?fuelType=${encodeURIComponent(fuelType)}`);
    if (response.ok) {
      const data = await response.json();
      if (data?.price) {
        latestFuelPrice = data;
        render();
      }
    }
  } catch (error) {
    // The app falls back to the configured manual price if the public price API is unavailable or slow.
  } finally {
    fuelPriceInFlight = false;
    scheduleFuelPriceRefresh();
  }
}

function getFuelValidationWarnings(ledger) {
  const warnings = [];
  const hasTrips = state.trips.length > 0 || ledger.totalTripKm > 0;
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const noFuel = hasTrips && ledger.totalPaid <= 0;

  if (noFuel && estimate.hasEstimate) {
    warnings.push(`No fuel payments have been added yet. Based on ${formatNumber(ledger.totalTripKm)} trip km, ${formatNumber(estimate.consumption)} L/100 km and ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L, expected fuel cost is about ${formatMoney(estimate.expectedCost)}.`);
  } else if (noFuel) {
    warnings.push("There are trips in this period, but no fuel payments yet. Add every refuel receipt before requesting settlements.");
  } else if (estimate.hasEstimate && estimate.missingAmount > 0) {
    warnings.push(`Fuel payments look incomplete. Expected about ${formatMoney(estimate.expectedCost)} for ${formatNumber(ledger.totalTripKm)} trip km, but only ${formatMoney(ledger.totalPaid)} has been logged (${formatNumber(estimate.coveragePercent)}% of expected).`);
  } else if (estimate.hasEstimate && estimate.excessAmount > 0) {
    warnings.push(`Fuel payments look unusually high. Expected about ${formatMoney(estimate.expectedCost)} for ${formatNumber(ledger.totalTripKm)} trip km, but ${formatMoney(ledger.totalPaid)} has been logged (${formatNumber(estimate.coveragePercent)}% of expected). Check for duplicate fuel logs, wrong amounts, or missing trips.`);
  }

  const largePaymentWithoutLiters = state.fuel.find((fuel) => Number(fuel.amount || 0) >= 500 && !(Number(fuel.liters || 0) > 0));
  if (largePaymentWithoutLiters) {
    warnings.push(`${largePaymentWithoutLiters.payer} logged ${formatMoney(largePaymentWithoutLiters.amount)} without liters. Add liters from the receipt to verify the price per liter.`);
  }

  for (const fuel of state.fuel) {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    if (!(amount > 0 && liters > 0)) continue;
    const pricePerLiter = amount / liters;
    if (isFuelPriceOutsideWarningRange(pricePerLiter)) {
      warnings.push(`${fuel.payer}'s fuel log on ${formatDate(fuel.date)} has an unusual price: ${formatMoneyFor(pricePerLiter, state.currency)}/L.`);
    }
  }

  if (ledger.totalTripKm > 0 && ledger.totalFuelLiters > 0) {
    const litersPer100Km = ledger.totalFuelLiters / ledger.totalTripKm * 100;
    if (litersPer100Km < 3 || litersPer100Km > 9) {
      warnings.push(`Receipt-based fuel consumption is unusual for this car: ${formatNumber(litersPer100Km)} L/100 km. Check liters, trip distance, and whether fuel belongs to this period.`);
    }
  }

  return warnings;
}

function isFuelEstimateWarningActive(ledger) {
  return getFuelValidationWarnings(ledger).length > 0;
}

function buildFuelValidationMessage(ledger, actionLabel = "continue") {
  const estimate = ledger.fuelEstimate || calculateFuelEstimate(ledger);
  const warnings = getFuelValidationWarnings(ledger);
  const lines = [
    "Fuel sanity check",
    "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    `Trips in this period: ${formatNumber(ledger.totalTripKm)} km`,
    `Fuel logged: ${formatMoney(ledger.totalPaid)}`,
  ];

  if (estimate.hasEstimate) {
    lines.push(
      `Expected fuel cost: about ${formatMoney(estimate.expectedCost)}`,
      `Coverage: ${formatNumber(estimate.coveragePercent)}% of expected`,
      `Low warning below: ${formatNumber(estimate.threshold)}%`,
      `High warning above: ${formatNumber(estimate.highThreshold)}%`,
      "",
      `This estimate uses ${formatNumber(estimate.consumption)} L/100 km and ${formatMoneyFor(estimate.pricePerLiter, state.currency)}/L.`
    );
  }

  lines.push(
    "",
    "Check that fuel amounts, liters, and all trips in this period are correct before requesting payments.",
    "",
    `Are you sure you want to ${actionLabel}?`
  );

  return lines.join("\n");
}

function renderPaymentOverview(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  const hiddenCount = Math.max(0, (ledger.settlements || []).length - visibleSettlements.length);
  const missingRequiredFuel = getMissingRequiredFuelTasksForCurrentPeriod();
  const totals = visibleSettlements.reduce(
    (acc, item) => {
      const status = normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]);
      acc.totalCount += 1;
      acc.totalAmount += item.amount;
      if (status === "paid") {
        acc.paidCount += 1;
        acc.paidAmount += item.amount;
      } else if (status === "requested") {
        acc.requestedCount += 1;
        acc.requestedAmount += item.amount;
      } else {
        acc.openCount += 1;
        acc.openAmount += item.amount;
      }
      return acc;
    },
    { totalCount: 0, totalAmount: 0, requestedCount: 0, requestedAmount: 0, paidCount: 0, paidAmount: 0, openCount: 0, openAmount: 0 }
  );

  els.paymentOverview.innerHTML = `
    <div class="payment-overview-card primary-overview">
      <span>Current settlement</span>
      <strong>${escapeHtml(ledger.period.label)}</strong>
      <small>${formatNumber(ledger.totalShareKm)} participant km · ${formatMoney(ledger.totalPaid)} fuel · ${formatMoney(ledger.fuelRate)}/km</small>
    </div>
    <div class="payment-overview-card">
      <span>Final payments</span>
      <strong>${totals.totalCount} · ${formatMoney(totals.totalAmount)}</strong>
      <small>${hiddenCount ? `Showing ${totals.totalCount} payment${totals.totalCount === 1 ? "" : "s"} relevant to you. ${hiddenCount} other payment${hiddenCount === 1 ? "" : "s"} hidden.` : "Net payments after trips and fuel receipts are balanced."}</small>
    </div>
    <div class="payment-overview-card">
      <span>Payment status</span>
      <strong>${totals.openCount} open · ${totals.requestedCount} requested · ${totals.paidCount} paid</strong>
      <small>${formatMoney(totals.openAmount)} open; ${formatMoney(totals.requestedAmount)} requested; ${formatMoney(totals.paidAmount)} paid.</small>
    </div>
    <div class="payment-overview-card ${missingRequiredFuel.length ? "needs-attention" : ""}">
      <span>Required fuel logs</span>
      <strong>${missingRequiredFuel.length}</strong>
      <small>${missingRequiredFuel.length ? "Close is blocked until each multi-day booking trip has linked full-tank fuel." : "No required booking-fuel tasks blocking settlement close."}</small>
    </div>
  `;
}


function getMemberActionSummary(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  const profile = getCurrentMemberProfile();
  const isAdmin = canManageSettings();
  const visible = visibleSettlements || [];
  const requested = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "requested");
  const paid = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "paid");
  const open = visible.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "open");
  const name = profile?.name || currentUser;
  const sum = (rows) => rows.reduce((total, item) => total + Number(item.amount || 0), 0);

  const openToMe = name ? open.filter((item) => item.to === name) : [];
  const requestedFromMe = name ? requested.filter((item) => item.from === name) : [];
  const paidFromMe = name ? paid.filter((item) => item.from === name) : [];
  const openFromMe = name ? open.filter((item) => item.from === name) : [];
  const requestedToMe = name ? requested.filter((item) => item.to === name) : [];
  const paidToMe = name ? paid.filter((item) => item.to === name) : [];

  if (isAdmin) {
    const all = ledger.settlements || [];
    const allRequested = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "requested");
    const allPaid = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "paid");
    const allOpenItems = all.filter((item) => normalizePaymentStatus(state.paymentStatuses[settlementKey(item)]) === "open");
    const adminCanRequest = name ? allOpenItems.filter((item) => item.to === name) : [];
    const otherFuelPayersMustRequest = name ? allOpenItems.filter((item) => item.to !== name) : allOpenItems;
    const requestedYouCanManage = name
      ? allRequested.filter((item) => item.to === name || item.from === name)
      : allRequested;
    const readyText = allOpenItems.length
      ? `${allOpenItems.length} open payment${allOpenItems.length === 1 ? "" : "s"} must be requested before closing the period.`
      : `Ready to close: ${all.length} final payment${all.length === 1 ? "" : "s"} · ${allPaid.length} paid · ${allRequested.length} requested but not marked paid · 0 open.`;
    const adminActionText = allOpenItems.length
      ? `You can request ${adminCanRequest.length} payment${adminCanRequest.length === 1 ? "" : "s"} where you are the recipient. ${otherFuelPayersMustRequest.length} open payment${otherFuelPayersMustRequest.length === 1 ? "" : "s"} must be requested by another fuel payer.`
      : allRequested.length
        ? `${allRequested.length} payment${allRequested.length === 1 ? " is" : "s are"} requested but not marked paid. You can close anyway if the MobilePay requests have been sent.`
        : "All final payments are marked paid. The period is ready to close.";
    return {
      isAdmin,
      actionCount: allOpenItems.length,
      title: "Settlement status",
      body: all.length
        ? `${allRequested.length} requested and ${allPaid.length} paid of ${all.length} final payment${all.length === 1 ? "" : "s"}. ${readyText}`
        : "No final payments are needed for this period.",
      detail: all.length
        ? `${adminActionText}${requestedYouCanManage.length ? ` ${requestedYouCanManage.length} requested payment${requestedYouCanManage.length === 1 ? "" : "s"} involving you can be reopened if needed.` : ""}`
        : "Admin period-wide summary."
    };
  }

  if (openToMe.length) {
    return {
      isAdmin,
      actionCount: openToMe.length,
      title: "What do I need to do?",
      body: `Request ${openToMe.length} payment${openToMe.length === 1 ? "" : "s"} totaling ${formatMoney(sum(openToMe))}.`,
      detail: "You paid fuel and these payments are ready for you to request."
    };
  }

  if (requestedFromMe.length) {
    const recipients = requestedFromMe.map((item) => `${item.to} ${formatMoney(item.amount)}`).join(", ");
    return {
      isAdmin,
      actionCount: requestedFromMe.length,
      title: "What do I need to do?",
      body: `You have been asked to pay ${formatMoney(sum(requestedFromMe))}: ${recipients}.`,
      detail: "Pay in MobilePay, then mark the payment as paid in the app."
    };
  }

  if (paidFromMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You marked ${formatMoney(sum(paidFromMe))} as paid.`,
      detail: "No further action is needed unless the recipient asks you to reopen it."
    };
  }

  if (openFromMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You owe ${formatMoney(sum(openFromMe))}, but the fuel payer has not requested it yet.`,
      detail: "No action is needed until the fuel payer requests payment."
    };
  }

  if (requestedToMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `You requested ${formatMoney(sum(requestedToMe))}. Waiting for MobilePay payment.`,
      detail: "The payer can mark it as paid after paying."
    };
  }

  if (paidToMe.length) {
    return {
      isAdmin,
      actionCount: 0,
      title: "What do I need to do?",
      body: `${formatMoney(sum(paidToMe))} has been marked as paid to you.`,
      detail: "Check MobilePay if needed. You can reopen the payment if it was marked paid by mistake."
    };
  }

  return {
    isAdmin,
    actionCount: 0,
    title: "What do I need to do?",
    body: visible.length ? "Your visible payments are balanced for now." : "No final payments involve you in this period.",
    detail: "Only payments involving your member profile are shown below."
  };
}

function renderSettleActionBadge(ledger) {
  const settleTab = els.sectionTabs.find((button) => button.dataset.viewTab === "settle");
  if (!settleTab) return;
  const summary = getMemberActionSummary(ledger);
  let badge = settleTab.querySelector(".tab-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    settleTab.appendChild(badge);
  }
  const count = Number(summary.actionCount || 0);
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.classList.toggle("hidden", count <= 0);
  settleTab.setAttribute("aria-label", count > 0 ? `Settle, ${count} action${count === 1 ? "" : "s"}` : "Settle");
}

function renderMemberActionPanel(ledger, visibleSettlements = getVisibleSettlements(ledger)) {
  if (!els.memberActionPanel) return;
  if (!currentSession && supabaseClient) {
    els.memberActionPanel.replaceChildren();
    return;
  }

  const summary = getMemberActionSummary(ledger, visibleSettlements);
  els.memberActionPanel.innerHTML = `
    <div class="member-action-card ${summary.isAdmin ? "is-admin" : ""}">
      <span>${escapeHtml(summary.title)}</span>
      <strong>${escapeHtml(summary.body)}</strong>
      <small>${escapeHtml(summary.detail)}</small>
    </div>
  `;
}


function paymentActionProgressLabel(nextStatus) {
  return nextStatus === "requested" ? "Requesting..." : nextStatus === "paid" ? "Marking paid..." : "Reopening...";
}

function paymentActionCompleteLabel(nextStatus) {
  return nextStatus === "requested" ? "Requested" : nextStatus === "paid" ? "Paid" : "Request payment";
}

function paymentActionTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
  error.name = "PaymentActionTimeoutError";
  error.isPaymentActionTimeout = true;
  return error;
}


async function withNormalizedWriteContextTimeout(actionPromise, source, timeoutMs = normalizedWriteContextTimeoutMs) {
  let timeoutId = null;
  const label = `${source || "Normalized write"} setup`;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = paymentActionTimeoutError(label, timeoutMs);
      error.isNormalizedWriteContextTimeout = true;
      reject(error);
    }, timeoutMs);
  });
  if (actionPromise && typeof actionPromise.catch === "function") {
    actionPromise.catch(() => {});
  }
  try {
    return await Promise.race([actionPromise, timeout]);
  } catch (error) {
    if (error?.isNormalizedWriteContextTimeout || error?.isPaymentActionTimeout) {
      recordDataIoDiagnostic("timeout", {
        source: source || "normalized-write-context",
        route: "normalized-write-context",
        operation: "prepare",
        error,
        detail: `${label} timed out before the backend write started.`
      });
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function withPaymentStatusActionTimeout(actionPromise, label, timeoutMs = paymentStatusActionTimeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(paymentActionTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([actionPromise, timeout]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function withPaymentBackendStartTimeout(actionPromise, label, timeoutMs = paymentStatusActionBackendStartTimeoutMs) {
  try {
    return await withPaymentStatusActionTimeout(actionPromise, label, timeoutMs);
  } catch (error) {
    if (error?.isPaymentActionTimeout) {
      recordSupabaseLoadEvent("payment-action-backend-not-started", `${label} timed out before backend write started`);
      recordSyncDiagnostic("payment-action-backend-not-started", `${label} timed out before the Render/Supabase payment write started.`, { timeoutMs, error });
    }
    throw error;
  }
}

function clearPaymentActionSavingUi(reason = "payment-action-finished") {
  recordSyncDiagnostic("payment-action-finished", reason, { reason });
  finishForegroundOperationsBySource("payment-status-action", reason);
  finishForegroundOperationsBySource("settlement-request-save", reason);
  if (els.syncStatus && ["saving", "syncing"].includes(String(els.syncStatus.dataset.status || ""))) {
    restoreHealthySyncStatusAfterQuietSync(reason);
  }
  clearVisibleSavingFailsafe();
}

function applyPaymentActionLocally(key, nextStatus, auditEntry, reason = "payment-action-local-apply") {
  state.paymentStatuses[key] = nextStatus;
  auditLogDirty = true;
  state.auditLog = auditLog.normalizeAuditEntries([auditEntry, ...(state.auditLog || [])]);
  state.updatedAt = new Date().toISOString();
  writeLocalState();
  recordSupabaseLoadEvent(reason, "updated local payment status without full-state remote save");
}

async function updatePaymentStatus(button) {
  if (!(await confirmFreshCloudStateForCriticalAction("Update payment status"))) return;
  const key = button.dataset.paymentKey;
  if (pendingSettlementRequestKeys.has(key)) return;

  const ledger = calculateLedger();
  const settlement = ledger.settlements.find((item) => settlementKey(item) === key);

  const requestedStatus = normalizePaymentStatus(button.dataset.paymentStatus);
  const previousStatus = normalizePaymentStatus(state.paymentStatuses[key]);
  const mayChangeRequest = requestedStatus === "requested" || requestedStatus === "open";
  const mayMarkPaid = requestedStatus === "paid";

  if (!settlement || (mayChangeRequest && !canManageSettlementRequest(settlement) && !canManageSettings()) || (mayMarkPaid && !canMarkSettlementPaid(settlement))) {
    showPermissionBlocked(describePaymentPermissionMessage(settlement, requestedStatus));
    render();
    return;
  }

  if (!isValidPaymentStatusTransition(previousStatus, requestedStatus)) {
    showAppMessage(paymentStatusTransitionMessage(previousStatus, requestedStatus), "warning");
    render();
    return;
  }

  if (button.dataset.paymentStatus === "requested" && isFuelEstimateWarningActive(ledger)) {
    if (!confirmUserAction(buildFuelValidationMessage(ledger, "request this payment anyway"))) {
      render();
      return;
    }
  }

  const nextStatus = requestedStatus;
  const paymentAuditInfo = buildPaymentAuditInfo(settlement, previousStatus, nextStatus);
  const auditEntry = makeAuditEntry({
    type: nextStatus === "requested" ? "payment_requested" : nextStatus === "paid" ? "payment_marked_paid" : "payment_reopened",
    entityType: "payment",
    entityId: key,
    summary: paymentAuditInfo.summary,
    detail: paymentAuditInfo.detail,
    metadata: paymentAuditInfo.metadata
  });
  pendingSettlementRequestKeys.add(key);
  button.disabled = true;
  button.textContent = paymentActionProgressLabel(nextStatus);
  setSyncStatus("Saving", { source: "payment-status-action" });

  let actionSucceeded = false;
  try {
    const tableSaved = await withPaymentStatusActionTimeout(
      saveSettlementRequestToNormalizedTableFirst(settlement, nextStatus, { previousStatus, auditEntry, skipVisibleSaving: true }),
      "Payment status normalized save",
      paymentStatusActionNormalizedTimeoutMs
    );
    if (!tableSaved) return;

    // Make the completed action visible to the UI and smoke tests as soon as
    // the normalized/table-primary gate allows the change. The server/Render
    // write may still merge back a canonical state, but the local payment
    // status and audit breadcrumb should not wait on that second round trip.
    applyPaymentActionLocally(key, nextStatus, auditEntry);
    render();

    if (supabaseClient) {
      // The Render/Supabase payment action already persisted the normalized
      // status transactionally. Keep the browser state in sync without calling
      // saveState(), because saveState() queues the generic full-state save stack
      // and causes payment actions to fan out into repeated Supabase saves,
      // reconciliation skips, JSON mirror checks, and ledger event attempts.
      lastCloudSaveAt = new Date().toISOString();
      lastCloudSyncAt = lastCloudSaveAt;
      markRemoteSaveSucceeded("Tables");
      scheduleJsonMirrorBackup();
    } else {
      const backendApplied = await withPaymentStatusActionTimeout(
        applyBackendPaymentAction({
          action: "payment_status",
          scope: "current",
          paymentKey: key,
          previousStatus,
          nextStatus,
          auditEntry
        }),
        "Payment status local backend save"
      );
      if (!backendApplied) {
        saveState();
      }
    }
    actionSucceeded = true;
    if (["paid", "open", "requested"].includes(nextStatus)) clearMobilePayReturnPrompt(key);

    const paymentMessage = nextStatus === "requested"
      ? `Payment request sent to ${settlement.from}.`
      : nextStatus === "paid"
        ? `Payment to ${settlement.to} marked paid.`
        : "Payment request reopened. You can now correct the settlement if needed.";
    showAppMessage(paymentMessage);

    if (nextStatus === "requested") {
      sendSettlementPush(settlement, paymentAuditInfo.metadata).catch((error) => {
        console.warn("Settlement push notification failed", error);
      });
    }
  } catch (error) {
    console.warn("Payment status action did not complete", error);
    recordSyncDiagnostic("payment-action-timeout", error?.message || "Payment action did not complete.", { error, paymentKey: key, nextStatus });
    showUserError(error?.isPaymentActionTimeout
      ? "The payment request is taking too long. The button was reset; try Sync now and request it again if it was not saved."
      : `Could not update the payment request: ${error.message || error}`);
  } finally {
    pendingSettlementRequestKeys.delete(key);
    button.disabled = false;
    button.textContent = actionSucceeded ? paymentActionCompleteLabel(nextStatus) : paymentActionCompleteLabel(previousStatus);
    clearPaymentActionSavingUi(actionSucceeded ? "payment-action-success" : "payment-action-reset");
    render();
  }

  // Requesting or marking a payment must never close the period automatically.
  // A period can contain requested/paid payments while the admin reviews it.
  // Closing is an explicit admin-only action via the Close period button.
}

async function sendPaymentReminder(button) {
  const isClosedPayment = Boolean(button.dataset.closedPeriodId);
  if (isClosedPayment) {
    await sendClosedPaymentReminder(button);
    return;
  }

  const key = button.dataset.paymentKey;
  if (pendingSettlementRequestKeys.has(key)) return;

  const ledger = calculateLedger();
  const settlement = ledger.settlements.find((item) => settlementKey(item) === key);
  const status = normalizePaymentStatus(state.paymentStatuses[key]);

  if (!settlement || status !== "requested" || (!canManageSettlementRequest(settlement) && !canManageSettings())) {
    showPermissionBlocked(describePaymentPermissionMessage(settlement, "requested"));
    render();
    return;
  }

  pendingSettlementRequestKeys.add(key);
  const originalText = button.textContent || "Send reminder";
  button.disabled = true;
  button.textContent = "Sending...";

  const paymentRef = createPaymentRef({ scope: "current", key, from: settlement.from, to: settlement.to, amount: settlement.amount });
  const pushResult = await sendPaymentReminderPush(settlement, { paymentRef, url: makePaymentDeepLink(paymentRef, { scope: "current" }) }).catch((error) => {
    console.warn("Payment reminder notification failed", error);
    return { attempted: true, sent: 0, failed: 1, reason: error.message || "send-failed" };
  });

  const auditInfo = buildPaymentReminderAuditInfo(settlement, pushResult, paymentRef);
  const auditEntry = makeAuditEntry({
    type: "payment_reminder_sent",
    entityType: "payment",
    entityId: key,
    summary: auditInfo.summary,
    detail: auditInfo.detail,
    metadata: auditInfo.metadata
  });
  const backendApplied = await applyBackendPaymentAction({
    action: "payment_reminder",
    scope: "current",
    paymentKey: key,
    auditEntry
  });
  if (!backendApplied) {
    auditLogDirty = true;
    state.auditLog = auditLog.normalizeAuditEntries([auditEntry, ...(state.auditLog || [])]);
    saveState();
  }

  pendingSettlementRequestKeys.delete(key);
  render();

  if (pushResult.sent > 0) {
    showAppMessage(`Reminder ${formatPaymentRef(paymentRef)} sent to ${settlement.from}.`);
  } else {
    showAppMessage(`Reminder ${formatPaymentRef(paymentRef)} recorded. ${settlement.from} does not appear to have an active notification subscription yet.`, "warning");
  }
  button.textContent = originalText;
}

async function sendClosedPaymentReminder(button) {
  const period = findClosedPeriod(button.dataset.closedPeriodId);
  const index = Number(button.dataset.closedSettlementIndex);
  const settlement = optionalRecordValue(period?.settlements, index);
  const key = settlement && period ? settlementKeyForPeriod(settlement, period.id) : "";
  if (!period || !settlement || normalizePaymentStatus(settlement.status) !== "requested" || (!canManageSettlementRequest(settlement) && !canManageSettings())) {
    showPermissionBlocked(describePaymentPermissionMessage(settlement, "requested"));
    render();
    return;
  }
  if (pendingSettlementRequestKeys.has(key)) return;
  pendingSettlementRequestKeys.add(key);
  const originalText = button.textContent || "Send reminder";
  button.disabled = true;
  button.textContent = "Sending...";

  const paymentRef = createPaymentRef({ scope: "closed", key, from: settlement.from, to: settlement.to, amount: settlement.amount });
  const pushResult = await sendPaymentReminderPush(settlement, { paymentRef, url: makePaymentDeepLink(paymentRef, { scope: "closed", periodId: period?.id || "" }) }).catch((error) => {
    console.warn("Closed payment reminder notification failed", error);
    return { attempted: true, sent: 0, failed: 1, reason: error.message || "send-failed" };
  });
  const auditInfo = buildPaymentReminderAuditInfo(settlement, pushResult, paymentRef);
  const auditEntry = makeAuditEntry({
    type: "payment_reminder_sent",
    entityType: "payment",
    entityId: key,
    summary: auditInfo.summary,
    detail: `${auditInfo.detail} · Closed period payment reminder`,
    metadata: { ...auditInfo.metadata, periodId: period.id }
  });
  const backendApplied = await applyBackendPaymentAction({
    action: "payment_reminder",
    scope: "closed",
    periodId: period.id,
    settlementIndex: index,
    auditEntry
  });
  expandedClosedPeriodIds.add(period.id);
  if (!backendApplied) {
    period.auditLog = auditLog.normalizeAuditEntries([auditEntry, ...(period.auditLog || [])]);
    auditLogDirty = true;
    saveState();
    await saveRemoteState();
  }
  pendingSettlementRequestKeys.delete(key);
  render();
  if (pushResult.sent > 0) {
    showAppMessage(`Reminder ${formatPaymentRef(paymentRef)} sent to ${settlement.from}.`);
  } else {
    showAppMessage(`Reminder ${formatPaymentRef(paymentRef)} recorded. ${settlement.from} does not appear to have an active notification subscription yet.`, "warning");
  }
  button.textContent = originalText;
}


async function updateClosedPaymentStatus(button) {
  if (!(await confirmFreshCloudStateForCriticalAction("Update closed-period payment"))) return;
  const period = findClosedPeriod(button.dataset.closedPeriodId);
  const index = Number(button.dataset.closedSettlementIndex);
  const nextStatus = normalizePaymentStatus(button.dataset.closedPaymentStatus);
  const settlement = optionalRecordValue(period?.settlements, index);
  const previousStatus = normalizePaymentStatus(settlement?.status);

  if (!period || !settlement || nextStatus !== "paid" || previousStatus !== "requested" || !canMarkSettlementPaid(settlement)) {
    showPermissionBlocked(describePaymentPermissionMessage(settlement, nextStatus));
    render();
    return;
  }

  button.disabled = true;
  button.textContent = "Marking paid...";

  const paymentAuditInfo = buildPaymentAuditInfo(settlement, previousStatus, "paid");
  const auditEntry = makeAuditEntry({
    type: "payment_marked_paid",
    entityType: "payment",
    entityId: settlementKeyForPeriod(settlement, period.id),
    summary: paymentAuditInfo.summary,
    detail: `${paymentAuditInfo.detail} · Closed period payment status updated after settlement close`,
    metadata: paymentAuditInfo.metadata
  });
  const backendApplied = await applyBackendPaymentAction({
    action: "payment_status",
    scope: "closed",
    periodId: period.id,
    settlementIndex: index,
    previousStatus,
    nextStatus: "paid",
    auditEntry
  });
  expandedClosedPeriodIds.add(period.id);
  if (!backendApplied) {
    settlement.status = "paid";
    period.auditLog = auditLog.normalizeAuditEntries([auditEntry, ...(period.auditLog || [])]);
    auditLogDirty = true;
    saveState();
    await saveRemoteState();
  }
  render();
  showAppMessage(`Closed-period payment to ${settlement.to} marked paid.`);
}

function getPaymentReminderSettings() {
  return {
    enabled: state.paymentRemindersEnabled !== false,
    afterDays: Math.max(0, Number(state.paymentReminderAfterDays ?? defaults.paymentReminderAfterDays)),
    repeatDays: Math.max(1, Number(state.paymentReminderRepeatDays || defaults.paymentReminderRepeatDays)),
    maxCount: Math.max(1, Number(state.paymentReminderMaxCount ?? defaults.paymentReminderMaxCount))
  };
}

function auditEntryTime(entry) {
  const time = Date.parse(entry?.createdAt || "");
  return Number.isNaN(time) ? 0 : time;
}

function getPaymentAuditEntries(entries, paymentKey, type) {
  return auditLog.normalizeAuditEntries(entries)
    .filter((entry) => entry.entityType === "payment" && entry.entityId === paymentKey && (!type || entry.type === type));
}

function getPaymentAuditCreatedAtIso(entries, paymentKey, type) {
  const matches = getPaymentAuditEntries(entries, paymentKey, type);
  const latest = matches.reduce((latestValue, entry) => Math.max(latestValue, auditEntryTime(entry)), 0);
  return latest ? new Date(latest).toISOString() : "";
}

function parseReminderTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getClosedPaymentFallbackRequestedAt(period, settlement) {
  const settlementFallbacks = [settlement?.requestedAt, settlement?.requested_at, settlement?.paymentRequestedAt];
  for (const candidate of settlementFallbacks) {
    const parsed = parseReminderTimestamp(candidate);
    if (parsed) return parsed;
  }
  const periodFallbacks = [period?.closedAt, period?.createdAt, period?.endedAt, period?.endDate, period?.periodEnd, period?.updatedAt];
  for (const candidate of periodFallbacks) {
    const parsed = parseReminderTimestamp(candidate);
    if (parsed) return parsed;
  }
  return 0;
}

function getPaymentReminderDueInfo(entries, paymentKey, settings, now = Date.now(), fallbackRequestedAt = 0) {
  if (!settings.enabled) return { due: false, reason: "disabled" };
  const requestedEntries = getPaymentAuditEntries(entries, paymentKey, "payment_requested");
  let requestedAt = requestedEntries.reduce((latest, entry) => Math.max(latest, auditEntryTime(entry)), 0);
  const inferredRequestedAt = !requestedAt && Boolean(fallbackRequestedAt);
  if (!requestedAt && fallbackRequestedAt) requestedAt = fallbackRequestedAt;
  if (!requestedAt) return { due: false, reason: "missing-request-time" };

  const reminderEntries = getPaymentAuditEntries(entries, paymentKey, "payment_reminder_sent");
  if (settings.maxCount > 0 && reminderEntries.length >= settings.maxCount) {
    return { due: false, reason: "max-reminders" };
  }

  const lastReminderAt = reminderEntries.reduce((latest, entry) => Math.max(latest, auditEntryTime(entry)), 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const dueAt = lastReminderAt
    ? lastReminderAt + settings.repeatDays * dayMs
    : requestedAt + settings.afterDays * dayMs;

  return {
    due: now >= dueAt,
    requestedAt,
    inferredRequestedAt,
    lastReminderAt,
    reminderCount: reminderEntries.length,
    dueAt
  };
}

async function runAutomaticPaymentReminders() {
  const settings = getPaymentReminderSettings();
  if (!settings.enabled) return;

  // Supabase production reminders are handled by the scheduled backend job.
  // Keeping app-open automatic reminders active at the same time can deliver
  // duplicate push notifications when a cron/manual curl run and an open app
  // inspect the same stale payment state. Local JSON mode keeps this fallback.
  if (supabaseClient) {
    console.info("Automatic app-open payment reminders skipped; scheduled backend reminders handle Supabase ledgers.");
    return;
  }

  const now = Date.now();
  let sentOrRecorded = 0;
  let changed = false;

  const ledger = calculateLedger();
  for (const settlement of ledger.settlements || []) {
    const key = settlementKey(settlement);
    if (normalizePaymentStatus(state.paymentStatuses[key]) !== "requested") continue;
    const due = getPaymentReminderDueInfo(state.auditLog, key, settings, now);
    if (!due.due) continue;
    const paymentRef = createPaymentRef({ scope: "current", key, from: settlement.from, to: settlement.to, amount: settlement.amount });
    const pushResult = await sendPaymentReminderPush(settlement, { paymentRef, url: makePaymentDeepLink(paymentRef, { scope: "current" }) }).catch((error) => ({ attempted: true, sent: 0, failed: 1, reason: error.message || "send-failed" }));
    const auditInfo = buildPaymentReminderAuditInfo(settlement, pushResult, paymentRef);
    addAuditEntry({
      type: "payment_reminder_sent",
      entityType: "payment",
      entityId: key,
      summary: auditInfo.summary,
      detail: `${auditInfo.detail} · Automatic reminder`,
      metadata: { ...auditInfo.metadata, automatic: true, reminderCount: due.reminderCount + 1 }
    });
    sentOrRecorded += 1;
    changed = true;
  }

  for (const period of state.closedPeriods || []) {
    const settlements = Array.isArray(period.settlements) ? period.settlements : [];
    for (const settlement of settlements) {
      if (normalizePaymentStatus(settlement.status) !== "requested") continue;
      const key = settlementKeyForPeriod(settlement, period.id);
      const fallbackRequestedAt = getClosedPaymentFallbackRequestedAt(period, settlement);
      const due = getPaymentReminderDueInfo(period.auditLog, key, settings, now, fallbackRequestedAt);
      if (!due.due) continue;
      const paymentRef = createPaymentRef({ scope: "closed", key, from: settlement.from, to: settlement.to, amount: settlement.amount });
      const pushResult = await sendPaymentReminderPush(settlement, { paymentRef, url: makePaymentDeepLink(paymentRef, { scope: "closed", periodId: period?.id || "" }) }).catch((error) => ({ attempted: true, sent: 0, failed: 1, reason: error.message || "send-failed" }));
      const auditInfo = buildPaymentReminderAuditInfo(settlement, pushResult, paymentRef);
      period.auditLog = auditLog.normalizeAuditEntries([
        makeAuditEntry({
          type: "payment_reminder_sent",
          entityType: "payment",
          entityId: key,
          summary: auditInfo.summary,
          detail: `${auditInfo.detail} · Automatic reminder for closed settlement`,
          metadata: { ...auditInfo.metadata, automatic: true, reminderCount: due.reminderCount + 1, periodId: period.id }
        }),
        ...(period.auditLog || [])
      ]);
      sentOrRecorded += 1;
      changed = true;
    }
  }

  if (changed) {
    saveState();
    render();
    showAppMessage(`${sentOrRecorded} overdue payment reminder${sentOrRecorded === 1 ? "" : "s"} recorded${supabaseClient ? " and notification delivery attempted" : ""}.`, "success", { timeoutMs: 6000 });
  }
}

async function copySettlement(button) {
  const text = button.dataset.copy;
  const originalText = button.dataset.originalText || button.textContent || "Copy";
  button.dataset.originalText = originalText;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    showAppMessage("Amount copied.");
  } catch (error) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.className = "clipboard-copy-helper";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    button.textContent = "Copied";
  }

  window.setTimeout(() => {
    button.textContent = button.dataset.originalText || "Copy";
  }, 1600);
}


function exportLedgerBackup() {
  const filename = `fuel-ledger-backup-${localDateString()}.json`;
  const backup = {
    exportedAt: new Date().toISOString(),
    app: "Fuel Ledger",
    version: 1,
    state: normalizeState(state)
  };
  downloadTextFile(filename, JSON.stringify(backup, null, 2), "application/json");
  setDataToolsMessage("Backup exported.");
}

async function importLedgerBackup() {
  const file = optionalRecordValue(els.importLedgerFile?.files, 0);
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const validation = dataStore.validateBackupPayload(parsed);
    if (!validation.ok) {
      throw new Error(validation.errors.slice(0, 5).join(" "));
    }
    const importedState = normalizeState(validation.state);
    const memberCount = importedState.members.length;
    const tripCount = importedState.trips.length;
    const fuelCount = importedState.fuel.length;
    const periodCount = importedState.closedPeriods.length;
    const warningText = validation.warnings.length
      ? `\n\nWarnings:\n- ${validation.warnings.slice(0, 5).join("\n- ")}${validation.warnings.length > 5 ? "\n- …" : ""}`
      : "";

    if (!requireTypedAdminConfirmation({
      phrase: "IMPORT BACKUP",
      title: "Import backup and replace current state?",
      detail: `This will replace the current ledger with ${memberCount} people, ${tripCount} current trips, ${fuelCount} current fuel payments, and ${periodCount} closed periods.${warningText}

A backup of the current state is exported first.`
    })) {
      return;
    }

    await exportAdminSafetyBackup("import backup");
    assertFreshAdminSafetyBackup("import backup");

    state = importedState;
    state.lastOdometer = getLatestOdometer();
    markNormalizedReconciliationDirty("import backup");
    saveState();
    setDefaultDates();
    render();
    setDataToolsMessage("Backup imported and saved.");
  } catch (error) {
    setDataToolsMessage(`Could not import backup: ${error.message || "invalid JSON"}`);
  } finally {
    if (els.importLedgerFile) els.importLedgerFile.value = "";
  }
}

function downloadLedgerCsv() {
  const date = localDateString();
  const trips = [];
  for (const trip of state.trips) trips.push(csvTripRow(trip, "current", ""));
  for (const period of state.closedPeriods) {
    for (const trip of period.trips || []) trips.push(csvTripRow(trip, "closed", period.label || period.closedAt || ""));
  }

  const fuel = [];
  for (const item of state.fuel) fuel.push(csvFuelRow(item, "current", ""));
  for (const period of state.closedPeriods) {
    for (const item of period.fuel || []) fuel.push(csvFuelRow(item, "closed", period.label || period.closedAt || ""));
  }

  downloadTextFile(
    `fuel-ledger-trips-${date}.csv`,
    toCsv([
      ["period_status", "period", "date", "driver", "start_km", "end_km", "trip_km", "participants", "participant_count", "note"],
      ...trips
    ]),
    "text/csv;charset=utf-8"
  );
  downloadTextFile(
    `fuel-ledger-fuel-${date}.csv`,
    toCsv([
      ["period_status", "period", "date", "payer", "amount", "currency", "liters", "price_per_liter", "odometer", "station", "station_brand", "station_latitude", "station_longitude", "user_latitude", "user_longitude", "full_tank"],
      ...fuel
    ]),
    "text/csv;charset=utf-8"
  );
  setDataToolsMessage("CSV files downloaded.");
}


function downloadCurrentPeriodReport() {
  const ledger = calculateLedger();
  const activity = buildPeriodActivityStats(ledger);
  const settlements = ledger.settlements || [];
  const requestedSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "requested");
  const paidSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "paid");
  const openSettlements = settlements.filter((settlement) => getSettlementStatus(settlement) === "open");
  const periodLabel = ledger.period?.label || "Current settlement period";
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const lines = [];
  lines.push(`# Fuel Ledger report - ${periodLabel}`);
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Period totals");
  lines.push(`- Trips: ${activity.tripCount}`);
  lines.push(`- Fuel logs: ${activity.fuelCount}`);
  lines.push(`- Trip km: ${formatNumber(activity.totalTripKm)} km`);
  lines.push(`- Participant km: ${formatNumber(ledger.totalShareKm)} km`);
  lines.push(`- Fuel paid: ${formatMoney(ledger.totalPaid)}`);
  lines.push(`- Fuel cost per participant km: ${ledger.totalShareKm > 0 ? `${formatMoney(ledger.fuelRate)}/km` : "-"}`);
  lines.push(`- Fuel cost per trip km: ${ledger.totalTripKm > 0 ? `${formatMoney(ledger.totalPaid / ledger.totalTripKm)}/km` : "-"}`);
  lines.push(`- Fuel consumption: ${ledger.receiptConsumption > 0 ? `${formatNumber(ledger.receiptConsumption)} L/100 km (${formatNumber(ledger.receiptKmPerLiter)} km/L)` : "Not enough liter data"}`);
  lines.push("");
  lines.push("## Final payments");
  lines.push(`- Total final payment lines: ${settlements.length}`);
  lines.push(`- Requested: ${requestedSettlements.length} (${formatMoney(requestedSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  lines.push(`- Paid: ${paidSettlements.length} (${formatMoney(paidSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  lines.push(`- Open: ${openSettlements.length} (${formatMoney(openSettlements.reduce((sum, item) => sum + Number(item.amount || 0), 0))})`);
  if (settlements.length) {
    lines.push("");
    for (const settlement of settlements) {
      lines.push(`- ${settlement.from} pays ${settlement.to}: ${formatMoney(settlement.amount)} (${statusLabel(getSettlementStatus(settlement))})`);
    }
  } else {
    lines.push("- No payments needed.");
  }
  lines.push("");
  lines.push("## Activity by person");
  if (activity.people.length) {
    lines.push("| Person | Trips driven | Trips joined | Distance share | Fuel logs | Fuel paid | Fuel share | Net |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const person of activity.people) {
      const ledgerPerson = ledger.people[person.name] || {};
      lines.push(`| ${markdownCell(person.name)} | ${person.driverTrips} | ${person.joinedTrips} | ${formatNumber(person.distanceShare)} km | ${person.fuelLogs} | ${formatMoney(person.fuelPaid)} | ${formatMoney(ledgerPerson.tripCost || 0)} | ${formatMoney(ledgerPerson.net || 0)} |`);
    }
  } else {
    lines.push("No activity in this period.");
  }
  lines.push("");
  lines.push("## Fuel payments by payer");
  const fuelPayers = Object.entries(ledger.fuelByPerson || {}).filter(([, amount]) => Number(amount || 0) > 0);
  if (fuelPayers.length) {
    for (const [name, amount] of fuelPayers) {
      const liters = Number(optionalRecordValue(ledger.fuelLitersByPerson, name) || 0);
      lines.push(`- ${name}: ${formatMoney(amount)}${liters > 0 ? ` · ${formatNumber(liters)} L` : ""}`);
    }
  } else {
    lines.push("- No fuel payments in this period.");
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("Final payments are not one payment per trip. They are the netted result after all trips and fuel receipts in the open period are balanced.");

  downloadTextFile(`fuel-ledger-period-report-${localDateString()}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
  setDataToolsMessage("Current period report downloaded.");
}


function findClosedPeriod(periodId) {
  return state.closedPeriods.find((item) => item.id === periodId);
}

function closedPeriodFileStem(period) {
  const closedDate = String(period.closedAt || localDateString()).slice(0, 10);
  const idPart = String(period.id || "period").slice(0, 8);
  return `fuel-ledger-closed-period-${closedDate}-${idPart}`;
}

function downloadClosedPeriodReport(periodId) {
  const period = findClosedPeriod(periodId);
  if (!period) {
    showUserError("Could not find that closed period.");
    return;
  }

  const lines = buildClosedPeriodReportLines(period);
  downloadTextFile(`${closedPeriodFileStem(period)}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
}

function downloadClosedPeriodCsv(periodId) {
  const period = findClosedPeriod(periodId);
  if (!period) {
    showUserError("Could not find that closed period.");
    return;
  }

  const rows = buildClosedPeriodCsvRows(period);
  exportCsvTextFile(`${closedPeriodFileStem(period)}-summary.csv`, toCsv(rows));
}

function downloadClosedPeriodAuditCsv(periodId) {
  const period = findClosedPeriod(periodId);
  if (!period) {
    showUserError("Could not find that closed period.");
    return;
  }

  const rows = buildClosedPeriodAuditCsvRows(period);
  exportCsvTextFile(`${closedPeriodFileStem(period)}-change-log.csv`, toCsv(rows));
}

function buildClosedPeriodCsvRows(period) {
  const currency = period.currency || state.currency;
  const trips = Array.isArray(period.trips) ? period.trips : [];
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  const people = Array.isArray(period.people) ? period.people : [];
  const rows = [[
    "section",
    "period_label",
    "closed_at",
    "currency",
    "date",
    "person",
    "from",
    "to",
    "status",
    "amount",
    "km",
    "liters",
    "rate",
    "description",
    "note"
  ]];

  rows.push([
    "period_summary",
    period.label || "Closed period",
    period.closedAt || "",
    currency,
    "",
    "",
    "",
    "",
    "",
    Number(period.totalPaid || 0),
    Number(period.totalKm || 0),
    fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0),
    Number(period.fuelRate || 0),
    `${trips.length} trip${trips.length === 1 ? "" : "s"}; ${fuel.length} fuel log${fuel.length === 1 ? "" : "s"}; ${settlements.length} final payment${settlements.length === 1 ? "" : "s"}`,
    ""
  ]);

  for (const person of people) {
    rows.push([
      "person",
      period.label || "Closed period",
      period.closedAt || "",
      currency,
      "",
      person.name || "",
      "",
      "",
      "",
      Number(person.fuelPaid || 0),
      Number(person.km || 0),
      "",
      "",
      `Fuel share ${formatMoneyFor(person.fuelShare || 0, currency)}`,
      ""
    ]);
  }

  for (const settlement of settlements) {
    rows.push([
      "settlement",
      period.label || "Closed period",
      period.closedAt || "",
      currency,
      "",
      "",
      settlement.from || "",
      settlement.to || "",
      normalizePaymentStatus(settlement.status),
      Number(settlement.amount || 0),
      "",
      "",
      "",
      `${settlement.from || "Someone"} pays ${settlement.to || "someone"}`,
      ""
    ]);
  }

  for (const trip of trips) {
    const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
    rows.push([
      "trip",
      period.label || "Closed period",
      period.closedAt || "",
      currency,
      trip.date || "",
      trip.driver || "",
      "",
      "",
      "",
      "",
      round(km),
      "",
      "",
      `Participants: ${getTripParticipants(trip).join("; ")}`,
      trip.note || ""
    ]);
  }

  for (const item of fuel) {
    const amount = Number(item.amount || 0);
    const liters = Number(item.liters || 0);
    rows.push([
      "fuel",
      period.label || "Closed period",
      period.closedAt || "",
      currency,
      item.date || "",
      item.payer || "",
      "",
      "",
      "",
      amount,
      item.odometer || "",
      liters || "",
      liters > 0 ? roundMoney(amount / liters) : "",
      item.station || "",
      item.note || ""
    ]);
  }

  return rows;
}

function buildClosedPeriodAuditCsvRows(period) {
  const entries = auditLog.normalizeAuditEntries(period.auditLog);
  return [
    ["period_label", "closed_at", "created_at", "action", "summary", "actor", "detail", "entity_type", "entity_id", "payment_from", "payment_to", "payment_amount", "payment_currency", "previous_status", "next_status"],
    ...entries.map((entry) => [
      period.label || "Closed period",
      period.closedAt || "",
      entry.createdAt || "",
      auditLog.actionLabel(entry.type),
      entry.summary || "",
      entry.actor || "",
      entry.detail || "",
      entry.entityType || "",
      entry.entityId || "",
      entry.metadata?.from || "",
      entry.metadata?.to || "",
      entry.metadata?.amount ?? "",
      entry.metadata?.currency || "",
      entry.metadata?.previousStatus || "",
      entry.metadata?.nextStatus || ""
    ])
  ];
}

function buildClosedPeriodReportLines(period) {
  const currency = period.currency || state.currency;
  const trips = Array.isArray(period.trips) ? period.trips : [];
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  const people = Array.isArray(period.people) ? period.people : [];
  const requested = settlements.filter((item) => normalizePaymentStatus(item.status) === "requested");
  const paid = settlements.filter((item) => normalizePaymentStatus(item.status) === "paid");
  const open = settlements.filter((item) => normalizePaymentStatus(item.status) === "open");
  const totalLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const label = period.label || "Closed settlement period";

  const lines = [];
  lines.push(`# Fuel Ledger closed period - ${label}`);
  lines.push("");
  lines.push(`Closed: ${period.closedAt ? formatDate(String(period.closedAt).slice(0, 10)) : "-"}`);
  lines.push(`Report generated: ${generatedAt}`);
  lines.push("");
  lines.push("## Period totals");
  lines.push(`- Trips: ${trips.length}`);
  lines.push(`- Fuel logs: ${fuel.length}`);
  lines.push(`- Trip km: ${formatNumber(period.totalTripKm || period.totalKm || 0)} km`);
  lines.push(`- Participant km: ${formatNumber(period.totalKm || 0)} km`);
  lines.push(`- Fuel paid: ${formatMoneyFor(period.totalPaid || 0, currency)}`);
  lines.push(`- Fuel rate: ${formatMoneyFor(period.fuelRate || 0, currency)}/km`);
  if (totalLiters > 0) lines.push(`- Liters logged: ${formatNumber(totalLiters)} L`);
  lines.push("");
  lines.push("## Final payments");
  lines.push(`- Total final payments: ${settlements.length}`);
  lines.push(`- Paid: ${paid.length} (${formatMoneyFor(paid.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  lines.push(`- Requested but not marked paid: ${requested.length} (${formatMoneyFor(requested.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  lines.push(`- Open / not requested: ${open.length} (${formatMoneyFor(open.reduce((sum, item) => sum + Number(item.amount || 0), 0), currency)})`);
  if (settlements.length) {
    lines.push("");
    for (const item of settlements) {
      lines.push(`- ${item.from} pays ${item.to}: ${formatMoneyFor(item.amount || 0, currency)} (${statusLabel(item.status)})`);
    }
  } else {
    lines.push("- No payments were needed.");
  }
  lines.push("");
  lines.push("## Activity by person");
  if (people.length) {
    lines.push("| Person | Distance share | Fuel share | Fuel paid |");
    lines.push("|---|---:|---:|---:|");
    for (const person of people) {
      lines.push(`| ${markdownCell(person.name)} | ${formatNumber(person.km || 0)} km | ${formatMoneyFor(person.fuelShare || 0, currency)} | ${formatMoneyFor(person.fuelPaid || 0, currency)} |`);
    }
  } else {
    lines.push("No people activity was saved for this period.");
  }
  lines.push("");
  lines.push("## Trips");
  if (trips.length) {
    for (const trip of [...trips].sort(byNewest)) {
      const km = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
      lines.push(`- ${formatDate(trip.date)} · ${trip.driver} · ${formatNumber(km)} km · ${formatNumber(trip.startKm || 0)} to ${formatNumber(trip.endKm || 0)} km · split: ${getTripParticipants(trip).join(", ")}${trip.note ? ` · ${trip.note}` : ""}`);
    }
  } else {
    lines.push("No trips saved in this period.");
  }
  lines.push("");
  lines.push("## Fuel logs");
  if (fuel.length) {
    for (const item of [...fuel].sort(byNewest)) {
      const liters = Number(item.liters || 0);
      const price = liters > 0 ? ` · ${formatNumber(liters)} L · ${formatMoneyFor(Number(item.amount || 0) / liters, currency)}/L` : "";
      const odometer = item.odometer ? ` · ${formatNumber(item.odometer)} km` : "";
      const station = item.station ? ` · ${item.station}` : "";
      lines.push(`- ${formatDate(item.date)} · ${item.payer} · ${formatMoneyFor(item.amount || 0, currency)}${price}${odometer}${station}`);
    }
  } else {
    lines.push("No fuel logs saved in this period.");
  }
  lines.push("");
  lines.push("## Note");
  lines.push("Final payments are netted across the whole settlement period. They are not one payment per trip.");
  return lines;
}


function csvTripRow(trip, periodStatus, periodLabel) {
  const participants = getTripParticipants(trip);
  return [
    periodStatus,
    periodLabel,
    trip.date || "",
    trip.driver || "",
    trip.startKm ?? "",
    trip.endKm ?? "",
    round(Number(trip.endKm || 0) - Number(trip.startKm || 0)),
    participants.join("; "),
    participants.length,
    trip.note || ""
  ];
}

function csvFuelRow(fuel, periodStatus, periodLabel) {
  const liters = Number(fuel.liters || 0);
  const amount = Number(fuel.amount || 0);
  return [
    periodStatus,
    periodLabel,
    fuel.date || "",
    fuel.payer || "",
    amount,
    state.currency,
    liters || "",
    liters > 0 ? roundMoney(amount / liters) : "",
    fuel.odometer || "",
    fuel.station || "",
    fuel.stationInfo?.brand || "",
    fuel.stationInfo?.latitude || "",
    fuel.stationInfo?.longitude || "",
    fuel.location?.latitude || "",
    fuel.location?.longitude || "",
    fuel.fullTank ? "yes" : "no"
  ];
}

async function removeUnusedTestUsers() {
  const removable = state.members.filter((member) => /test/i.test(member) && !memberHasLedgerData(member));

  if (removable.length === 0) {
    setDataToolsMessage("No unused test users found.");
    return;
  }

  if (!confirmUserAction(`Remove these unused test users?\n\n${removable.join("\n")}`)) return;

  try {
    await exportAdminSafetyBackup("remove unused test users");
    assertFreshAdminSafetyBackup("remove unused test users");
  } catch (error) {
    showUserError(error.message || String(error));
    return;
  }

  state.members = state.members.filter((member) => !removable.includes(member));
  for (const member of removable) delete state.memberProfiles[member];
  markNormalizedReconciliationDirty("remove unused test users");
  if (!state.members.includes(currentUser)) {
    currentUser = getCurrentMemberProfile()?.name || state.members[0] || "";
    localStorage.setItem(userKey, currentUser);
  }
  saveState();
  render();
  setDataToolsMessage(`Removed ${removable.length} unused test user${removable.length === 1 ? "" : "s"}.`);
}

function memberHasLedgerData(member) {
  const inCurrentTrips = state.trips.some(
    (trip) => trip.driver === member || getTripParticipants(trip).includes(member)
  );
  const inBookings = state.bookings.some((booking) => booking.member === member);
  const inCurrentFuel = state.fuel.some((fuel) => fuel.payer === member);
  const inPayments = Object.keys(state.paymentStatuses || {}).some((key) => key.includes(`${member}->`) || key.includes(`->${member}:`));
  const inClosedPeriods = state.closedPeriods.some((period) => {
    return (
      (period.people || []).some((person) => person.name === member) ||
      (period.trips || []).some((trip) => trip.driver === member || getTripParticipants(trip).includes(member)) ||
      (period.fuel || []).some((fuel) => fuel.payer === member) ||
      (period.settlements || []).some((settlement) => settlement.from === member || settlement.to === member)
    );
  });
  return inCurrentTrips || inBookings || inCurrentFuel || inPayments || inClosedPeriods;
}



function shouldUseCsvFallbackPanel() {
  const userAgent = String(navigator.userAgent || "");
  const vendor = String(navigator.vendor || "");
  const platform = String(navigator.platform || "");
  const isIosLike = /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(userAgent) && /Apple/.test(vendor) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(userAgent);
  const isStandalonePwa = Boolean(window.navigator.standalone) || window.matchMedia?.("(display-mode: standalone)")?.matches;
  return isSafari || isIosLike || isStandalonePwa;
}

function exportCsvTextFile(filename, csvText) {
  const safeFilename = sanitizeDownloadFilename(filename);
  if (shouldUseCsvFallbackPanel()) {
    showCsvExportPanel(safeFilename, csvText);
    return;
  }
  downloadTextFile(safeFilename, csvText, "text/csv;charset=utf-8");
}

function showCsvExportPanel(filename, csvText) {
  const safeFilename = sanitizeDownloadFilename(filename);
  document.querySelector(".csv-export-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "csv-export-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "CSV export");
  overlay.innerHTML = `
    <div class="csv-export-dialog">
      <header>
        <div>
          <h3>CSV export ready</h3>
          <p>Safari and home-screen PWAs can block direct CSV downloads. Copy the CSV, or try the download button below.</p>
        </div>
        <button class="subtle-button compact-button" type="button" data-csv-export-close>Close</button>
      </header>
      <label class="csv-export-filename">
        <span>Filename</span>
        <input type="text" readonly value="${escapeHtml(safeFilename)}">
      </label>
      <textarea class="csv-export-text" readonly spellcheck="false"></textarea>
      <div class="button-row compact-actions">
        <button class="primary-button compact-button" type="button" data-csv-export-copy>Copy CSV</button>
        <button class="subtle-button compact-button" type="button" data-csv-export-download>Try download</button>
      </div>
    </div>
  `;

  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.closest("[data-csv-export-close]")) {
      close();
    }
  });
  overlay.querySelector(".csv-export-text").value = csvText;
  overlay.querySelector("[data-csv-export-copy]").addEventListener("click", async () => {
    const textarea = overlay.querySelector(".csv-export-text");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(csvText);
      } else {
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
      }
      showAppMessage?.("CSV copied to clipboard.");
    } catch (error) {
      console.warn("CSV copy failed", error);
      textarea.focus();
      textarea.select();
      showAppMessage?.("Copy failed. Select the CSV text and copy manually.", "warning");
    }
  });
  overlay.querySelector("[data-csv-export-download]").addEventListener("click", () => {
    downloadTextFile(safeFilename, csvText, "text/csv;charset=utf-8");
  });

  document.body.append(overlay);
  showAppMessage?.("CSV export is ready. Copy it or try downloading.");
}

function sanitizeDownloadFilename(filename) {
  const safeName = String(filename || "fuel-ledger-download.txt")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safeName || "fuel-ledger-download.txt";
}

function downloadTextFile(filename, content, type = "text/plain") {
  const safeFilename = sanitizeDownloadFilename(filename);
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename;
  link.rel = "noopener";
  link.className = "hidden-download-link";
  document.body.append(link);

  try {
    link.click();
    showAppMessage?.(`Download started: ${safeFilename}`);
  } catch (error) {
    console.warn("Download click failed", error);
    window.open(url, "_blank", "noopener");
    showAppMessage?.("Download opened in a new tab. Use Share or Save if needed.", "warning");
  }

  // Safari/iOS PWA downloads can fail if the Blob URL is revoked immediately.
  // Keep the temporary URL alive briefly so the browser has time to finish starting the transfer.
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 10000);
}

function setDataToolsMessage(message) {
  if (!els.dataToolsMessage) return;
  els.dataToolsMessage.textContent = message;
}



function describeCurrentActor() {
  const profile = getCurrentMemberProfile();
  if (profile?.name) return profile.name;
  const email = getLoggedInEmail();
  return email || "This user";
}

function describeTripPermissionMessage(trip, action = "edit") {
  const owner = trip?.driver || "the driver";
  const actor = describeCurrentActor();
  if (canManageSettings()) return "";
  if (!getCurrentMemberProfile() && supabaseClient) {
    return `You are signed in as ${actor}, but this email is not linked to a ledger member. Ask an admin to add your email before changing trip logs.`;
  }
  return `Only ${owner}, the trip creator, or an admin can ${action} this trip. You are signed in as ${actor}.`;
}

function describeFuelPermissionMessage(fuel, action = "edit") {
  const owner = fuel?.payer || "the fuel payer";
  const actor = describeCurrentActor();
  if (canManageSettings()) return "";
  if (!getCurrentMemberProfile() && supabaseClient) {
    return `You are signed in as ${actor}, but this email is not linked to a ledger member. Ask an admin to add your email before changing fuel logs.`;
  }
  return `Only ${owner}, the fuel payer/creator, or an admin can ${action} this fuel log. You are signed in as ${actor}.`;
}

function showPermissionBlocked(message) {
  if (!message) return;
  showAppMessage(message, "warning", { timeoutMs: 7000 });
  showUserError(message);
}

function renderPermissionNote(message) {
  return message ? `<p class="entry-meta permission-note">${escapeHtml(message)}</p>` : "";
}

function describePaymentPermissionMessage(settlement, nextStatus) {
  const actor = describeCurrentActor();
  if (!settlement) return "This payment no longer exists in the current settlement. Refresh and try again.";
  if (nextStatus === "paid") {
    return `Only ${settlement.from}, the person who owes this payment, can mark it as paid. You are signed in as ${actor}.`;
  }
  if (nextStatus === "requested") {
    return `Only ${settlement.to}, the fuel payer receiving this payment, can request it. You are signed in as ${actor}.`;
  }
  return `Only ${settlement.to}, the fuel payer who requested this payment, or an admin can reopen it. You are signed in as ${actor}.`;
}

function canManageTripEntry(trip) {
  return permissionHelpers.canManageTripEntryForProfile(trip, getCurrentMemberProfile(), { noMemberEmailsConfigured: canManageSettings() });
}

function canManageFuelEntry(fuel) {
  return permissionHelpers.canManageFuelEntryForProfile(fuel, getCurrentMemberProfile(), { noMemberEmailsConfigured: canManageSettings() });
}

function canManageBookingEntry(booking) {
  return permissionHelpers.canManageBookingEntryForProfile(booking, getCurrentMemberProfile(), { noMemberEmailsConfigured: canManageSettings() });
}

function showLogViewForEditing() {
  activeView = "log";
  localStorage.setItem(viewStorageKey, activeView);
  renderSectionNavigation();
}

function showBookViewForEditing() {
  activeView = "book";
  localStorage.setItem(viewStorageKey, activeView);
  renderSectionNavigation();
}

function showHistoryForPeriodReview() {
  activeView = "history";
  localStorage.setItem(viewStorageKey, activeView);
  render();
  const historySection = document.querySelector('[data-view="history"]');
  if (historySection) {
    historySection.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  document.querySelectorAll('[data-view="history"] details.history-group').forEach((details) => {
    details.open = true;
  });
}

function editEntry(value) {
  const [type, id] = String(value || "").split(":");
  if (type === "trips") {
    const trip = state.trips.find((entry) => entry.id === id);
    if (!canManageTripEntry(trip)) {
      showPermissionBlocked(describeTripPermissionMessage(trip, "edit"));
      return;
    }
    if (!assertCurrentPeriodAllowsMoneyChanges("edit trip logs")) return;
    startTripEdit(id);
    return;
  }
  if (type === "bookings") {
    const booking = state.bookings.find((entry) => entry.id === id);
    if (!canManageBookingEntry(booking)) {
      showPermissionBlocked(describeBookingPermissionMessage(booking, "edit"));
      return;
    }
    startBookingEdit(id);
    return;
  }
  if (type === "fuel") {
    const fuel = state.fuel.find((entry) => entry.id === id);
    if (!canManageFuelEntry(fuel)) {
      showPermissionBlocked(describeFuelPermissionMessage(fuel, "edit"));
      return;
    }
    if (!assertCurrentPeriodAllowsMoneyChanges("edit fuel logs")) return;
    startFuelEdit(id);
  }
}

function startTripEdit(id) {
  const trip = state.trips.find((entry) => entry.id === id);
  if (!trip) return;

  showLogViewForEditing();
  editingFuelId = null;
  editingBookingId = null;
  clearTripLoggingContext();
  clearTripCorrectionPanel();
  editingTripId = id;
  syncTripDateBounds();
  renderPeopleSelectors();
  els.tripDriver.value = trip.driver;
  els.tripDate.value = trip.date;
  els.startKm.value = trip.startKm;
  els.endKm.value = trip.endKm;
  els.tripNote.value = trip.note || "";
  renderParticipantOptions();
  const participants = new Set(getTripParticipants(trip));
  for (const input of els.tripParticipants.querySelectorAll("input")) {
    input.checked = participants.has(input.value);
  }
  updateEditUi();
  els.tripForm.scrollIntoView({ behavior: "smooth", block: "start" });
  els.startKm.focus();
}


function getActiveTripLogContext() {
  return PlannerBookingBridge.getBookingLinkedTripContext({
    pendingContext: pendingTripBookingContext,
    editingTripId,
    trips: state.trips,
    bookings: state.bookings,
    createLogRef,
    extractEstimatedDistanceFromText
  });
}

function renderTripBookingContext() {
  if (!els.tripBookingContext) return;
  const context = getActiveTripLogContext();
  els.tripBookingContext.classList.toggle("hidden", !context);
  els.tripLogPanel?.classList.toggle("booking-trip-active", Boolean(context));
  if (!context) {
    els.tripBookingContext.replaceChildren();
    return;
  }
  const period = getTripPeriodLabel({
    date: els.tripDate?.value || "",
    bookingStart: context.bookingStart,
    bookingEnd: context.bookingEnd
  });
  els.tripBookingContext.innerHTML = PlannerBookingBridge.renderTripBookingContextHtml(context, {
    driver: els.tripDriver?.value || "",
    period,
    escapeHtml,
    formatTypedLogRef
  });
}

function buildFuelContextFromTrip(trip) {
  return PlannerBookingBridge.buildFuelContextFromTrip(trip, {
    bookings: state.bookings,
    createLogRef,
    isTripFromMultiDayBooking,
    round
  });
}

function prefillFuelFromTripContext(context) {
  if (!context) return;
  renderPeopleSelectors();
  if (context.member && getMemberNames().includes(context.member)) els.fuelPayer.value = context.member;
  syncFuelDateBounds();
  els.fuelDate.value = context.date || (context.bookingEnd ? localDateString(new Date(context.bookingEnd)) : localDateString());
  if (els.fuelOdometer) els.fuelOdometer.value = context.odometer || "";
  const details = document.querySelector("#fuelDetails");
  if (details) details.open = true;
  renderFuelTripContext();
}

function renderFuelTripContext() {
  if (!els.fuelTripContext) return;
  const context = pendingFuelTripContext;
  els.fuelTripContext.classList.toggle("hidden", !context);
  els.fuelTripContext.classList.toggle("is-required", Boolean(context?.requiredFuel));
  els.fuelLogPanel?.classList.toggle("linked-fuel-active", Boolean(context));
  if (!context) {
    els.fuelTripContext.replaceChildren();
    return;
  }
  const period = getTripPeriodLabel({
    date: context.date,
    bookingStart: context.bookingStart,
    bookingEnd: context.bookingEnd
  });
  els.fuelTripContext.innerHTML = PlannerBookingBridge.renderFuelTripContextHtml(context, {
    period,
    escapeHtml,
    formatNumber,
    formatTypedLogRef
  });
}


function isSameCalendarDayValue(a, b) {
  const first = a ? new Date(a) : null;
  const second = b ? new Date(b) : null;
  if (!first || !second || Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false;
  return localDateString(first) === localDateString(second);
}

function findTripForBooking(bookingId) {
  if (!bookingId) return null;
  const activeTrip = state.trips.find((trip) => trip.sourceBookingId === bookingId);
  if (activeTrip) return activeTrip;
  for (const period of state.closedPeriods || []) {
    const archivedTrip = (period.trips || []).find((trip) => trip.sourceBookingId === bookingId);
    if (archivedTrip) {
      return {
        ...archivedTrip,
        archivedPeriodId: period.id,
        archivedPeriodLabel: period.label,
        archivedAt: period.closedAt
      };
    }
  }
  return null;
}

function findFuelForTrip(tripId) {
  return state.fuel.find((fuel) => fuel.sourceTripId === tripId) || null;
}

function findFullTankFuelForTrip(trip) {
  if (!trip?.id) return null;
  const ref = normalizeLogRefValue(trip.logRef || createLogRef(trip.id));
  return (state.fuel || []).find((fuel) => {
    if (!fuel?.fullTank) return false;
    if (fuel.sourceTripId === trip.id) return true;
    if (ref && normalizeLogRefValue(fuel.logRef) === ref) return true;
    return false;
  }) || null;
}

function findBookingForTrip(trip) {
  if (!trip) return null;
  if (trip.sourceBookingId) {
    const byId = state.bookings.find((booking) => booking.id === trip.sourceBookingId);
    if (byId) return byId;
  }
  const notePurpose = String(trip.note || "").replace(/^Booking:\s*/i, "").trim().toLowerCase();
  if (!notePurpose) return null;
  const tripDate = normalizedDate(trip.date);
  return (state.bookings || []).find((booking) => {
    if (booking.member && trip.driver && booking.member !== trip.driver) return false;
    if (String(booking.purpose || "").trim().toLowerCase() !== notePurpose) return false;
    const bookingEnd = parseBookingDate(booking.end);
    return bookingEnd && localDateString(bookingEnd) === tripDate;
  }) || null;
}

function isTripFromMultiDayBooking(trip, booking = null) {
  if (!trip && !booking) return false;
  const start = trip?.bookingStart || booking?.start || null;
  const end = trip?.bookingEnd || booking?.end || null;
  return Boolean(start && end && !isSameCalendarDayValue(start, end));
}

function getMissingRequiredFuelTasksForCurrentPeriod() {
  return (state.trips || [])
    .map((trip) => ({
      trip,
      booking: findBookingForTrip(trip)
    }))
    .filter(({ trip, booking }) => Boolean(booking) && isTripFromMultiDayBooking(trip, booking))
    .filter(({ trip }) => !findFullTankFuelForTrip(trip))
    .map(({ trip, booking }) => ({
      trip,
      booking,
      logRef: trip.logRef || createLogRef(trip.id),
      distanceKm: Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0))
    }));
}

function buildMissingRequiredFuelMessage(tasks, actionLabel = "continue") {
  const list = tasks.slice(0, 5).map((task) => {
    const purpose = task.booking?.purpose || String(task.trip?.note || "").replace(/^Booking:\s*/i, "") || "booking trip";
    return `- ${formatLogRef(task)} · ${task.trip?.driver || task.booking?.member || "Driver"} · ${formatNumber(task.distanceKm || 0)} km · ${purpose}`;
  });
  const extra = tasks.length > 5 ? [`- …and ${tasks.length - 5} more`] : [];
  return [
    "Required fuel log missing",
    "",
    "Multi-day booking trips must have a linked fuel receipt before this settlement period can be closed.",
    "",
    ...list,
    ...extra,
    "",
    `Add fuel from Pending logs, then ${actionLabel}.`
  ].join("\n");
}

function buildPendingLogTasks() {
  const now = Date.now();
  const tasks = [];

  for (const booking of state.bookings || []) {
    const bookingEnd = parseBookingDate(booking.end);
    if (!bookingEnd || bookingEnd.getTime() > now) continue;
    const trip = findTripForBooking(booking.id);
    if (!trip) {
      tasks.push({
        type: "trip",
        id: `trip-${booking.id}`,
        logRef: booking.logRef || createLogRef(booking.id),
        booking,
        dueAt: booking.end,
        canAct: canCreateTripFromBooking(booking)
      });
      continue;
    }
    if (!findFuelForTrip(trip.id)) {
      tasks.push({
        type: "fuel",
        id: `fuel-${trip.id}`,
        logRef: trip.logRef || booking.logRef || createLogRef(trip.id),
        booking,
        trip,
        dueAt: trip.bookingEnd || booking.end || trip.date,
        required: isTripFromMultiDayBooking(trip, booking),
        canAct: canManageTripEntry(trip)
      });
    }
  }

  return tasks.sort((a, b) => new Date(b.dueAt || 0) - new Date(a.dueAt || 0));
}

function renderPendingLogs() {
  if (!els.pendingLogList) return;
  const tasks = buildPendingLogTasks();
  if (!tasks.length) {
    els.pendingLogList.innerHTML = `<article class="pending-log-card is-empty"><strong>No pending logs</strong><p class="entry-meta">Ended bookings with missing trip or fuel details will appear here.</p></article>`;
    return;
  }

  els.pendingLogList.innerHTML = tasks.map((task) => {
    const booking = task.booking || {};
    const trip = task.trip || null;
    const period = getTripPeriodLabel({
      date: trip?.date || "",
      bookingStart: trip?.bookingStart || booking.start,
      bookingEnd: trip?.bookingEnd || booking.end
    });
    const title = task.type === "trip" ? "Trip log needed" : (task.required ? "Fuel log required" : "Fuel log suggested");
    const description = task.type === "trip"
      ? "Enter the final odometer to complete this booking."
      : `${formatNumber(Math.max(0, Number(trip?.endKm || 0) - Number(trip?.startKm || 0)))} km logged. Add the matching refuel receipt${task.required ? " for this multi-day booking" : " if fuel was bought"}.`;
    const action = task.type === "trip"
      ? `<button class="action-button compact-button" type="button" data-complete-pending-trip="${escapeHtml(booking.id || "")}" ${task.canAct ? "" : "disabled"}>Complete trip</button>`
      : `<button class="action-button compact-button" type="button" data-add-fuel-for-trip="${escapeHtml(trip?.id || "")}" data-add-fuel-booking="${escapeHtml(booking.id || "")}" data-add-fuel-log-ref="${escapeHtml(formatLogRef(task))}" ${task.canAct ? "" : "disabled"}>Add fuel</button>`;
    const bookingRef = formatTypedLogRef(booking, "booking");
    const taskRef = task.type === "trip" ? bookingRef : formatTypedLogRef(trip || task, "trip");
    const bookingMeta = `Booking ${bookingRef}`;
    return `
      <article class="pending-log-card ${task.required ? "is-required" : ""}" data-log-ref="${escapeHtml(normalizeLogRefValue(formatLogRef(task)))}" data-booking-ref="${escapeHtml(bookingRef)}" data-pending-log-type="${escapeHtml(task.type)}">
        <div class="pending-log-main">
          <div>
            <p class="eyebrow">${escapeHtml(taskRef)}${task.type === "fuel" ? ` · ${escapeHtml(bookingRef)}` : ""}</p>
            <h3>${escapeHtml(title)}</h3>
          </div>
          <span class="status-pill">${task.type === "trip" ? "Odometer" : (task.required ? "Required" : "Suggested")}</span>
        </div>
        <p>${escapeHtml(period)}</p>
        <p class="entry-meta">${escapeHtml(booking.member || trip?.driver || "Driver")} · ${escapeHtml(bookingMeta)}${booking.purpose ? ` · ${escapeHtml(booking.purpose)}` : ""}</p>
        <p class="section-note">${escapeHtml(description)}</p>
        <div class="pending-log-actions">${action}</div>
      </article>
    `;
  }).join("");
}


function normalizeLogRefValue(value) {
  const compact = compactTypedRefValue(value, ["BOK", "TRP", "FUL", "LOG"]);
  return compact ? `#${compact}` : "";
}

function formatTypedLogRef(entry, type = "log") {
  const compact = normalizeLogRefValue(formatLogRef(entry || {})).replace(/^#/, "");
  const prefixMap = { booking: "bok", trip: "trp", fuel: "ful", log: "log" };
  const prefix = prefixMap[type] || String(type || "log").toLowerCase();
  return compact ? `${prefix}-${compact}` : `${prefix}-unknown`;
}

function logRefEquals(entryOrRef, rawRef) {
  const left = typeof entryOrRef === "string" ? entryOrRef : formatLogRef(entryOrRef || {});
  return normalizeLogRefValue(left) === normalizeLogRefValue(rawRef);
}

function makeLogDeepLink(logRef) {
  const compact = normalizeLogRefValue(logRef).replace(/^#/, "");
  const path = `${window.location.origin}${window.location.pathname}`;
  return compact ? `${path}#log=${encodeURIComponent(compact)}` : path;
}

function readLogRefFromUrl() {
  const rawHash = String(window.location.hash || "").replace(/^#/, "");
  if (!rawHash) return "";
  const params = new URLSearchParams(rawHash);
  return params.get("log") || params.get("pending-log") || params.get("logRef") || "";
}

function findPendingLogTaskByRef(logRef) {
  const target = normalizeLogRefValue(logRef);
  if (!target) return null;
  return buildPendingLogTasks().find((task) => logRefEquals(task, target)) || null;
}

function findCurrentLogEntryByRef(logRef) {
  const target = normalizeLogRefValue(logRef);
  if (!target) return null;
  const booking = (state.bookings || []).find((entry) => logRefEquals(entry, target));
  if (booking) return { type: "booking", entry: booking };
  const trip = (state.trips || []).find((entry) => logRefEquals(entry, target));
  if (trip) return { type: "trip", entry: trip };
  const fuel = (state.fuel || []).find((entry) => logRefEquals(entry, target));
  if (fuel) return { type: "fuel", entry: fuel };
  for (const period of state.closedPeriods || []) {
    const closedTrip = (period.trips || []).find((entry) => logRefEquals(entry, target));
    if (closedTrip) return { type: "closed-trip", entry: closedTrip, period };
    const closedFuel = (period.fuel || []).find((entry) => logRefEquals(entry, target));
    if (closedFuel) return { type: "closed-fuel", entry: closedFuel, period };
  }
  return null;
}

function scrollToPendingLogRef(logRef) {
  const target = normalizeLogRefValue(logRef);
  if (!target) return false;
  const card = Array.from(document.querySelectorAll("[data-log-ref]")).find((entry) => normalizeLogRefValue(entry.dataset.logRef) === target);
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("highlight-pulse");
  window.setTimeout(() => card.classList.remove("highlight-pulse"), 4200);
  return true;
}

function handleLogDeepLink(options = {}) {
  const logRef = readLogRefFromUrl();
  if (!logRef) return false;
  const normalizedRef = normalizeLogRefValue(logRef);
  const task = findPendingLogTaskByRef(normalizedRef);

  if (task?.type === "trip" && task.booking?.id && task.canAct) {
    startTripFromBooking(task.booking.id);
    return true;
  }

  if (task?.type === "fuel" && task.trip?.id && task.canAct) {
    startFuelFromTrip(task.trip.id);
    return true;
  }

  setActiveView("log");
  window.setTimeout(() => {
    if (!scrollToPendingLogRef(normalizedRef)) {
      els.pendingLogList?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 0);

  if (!options.silent) {
    const current = findCurrentLogEntryByRef(normalizedRef);
    const message = task
      ? `Log ${normalizedRef} is pending, but you do not have permission to complete it on this device.`
      : current
        ? `Log ${normalizedRef} is already recorded. Open History to review completed or archived entries.`
        : `Could not find log ${normalizedRef}. It may have been deleted or is not synced on this device yet.`;
    showAppMessage(message, task ? "warning" : "info", { timeoutMs: 7000 });
  }
  return true;
}

function readPaymentRefFromUrl() {
  const rawHash = String(window.location.hash || "").replace(/^#/, "");
  if (!rawHash) return "";
  const params = new URLSearchParams(rawHash);
  return params.get("payment") || params.get("paymentRef") || params.get("pay") || "";
}

function readPaymentLinkContextFromUrl() {
  const rawHash = String(window.location.hash || "").replace(/^#/, "");
  const params = new URLSearchParams(rawHash);
  return {
    payment: params.get("payment") || params.get("paymentRef") || params.get("pay") || "",
    scope: String(params.get("scope") || "").trim().toLowerCase(),
    periodId: params.get("period") || params.get("periodId") || ""
  };
}

function findPaymentItemByRef(paymentRef) {
  const target = normalizePaymentRefValue(paymentRef);
  if (!target) return null;
  return getUnpaidPaymentItems(calculateLedger()).find((item) => paymentRefEquals(item, target)) || null;
}

function scrollToPaymentRef(paymentRef, options = {}) {
  const target = normalizePaymentRefValue(paymentRef);
  if (!target) return false;
  const selectors = Array.isArray(options.selectors) && options.selectors.length ? options.selectors : ["[data-payment-ref]"];
  for (const selector of selectors) {
    const card = Array.from(document.querySelectorAll(selector)).find((entry) => normalizePaymentRefValue(entry.dataset.paymentRef) === target);
    if (!card) continue;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("highlight-pulse");
    window.setTimeout(() => card.classList.remove("highlight-pulse"), 4200);
    return true;
  }
  return false;
}

function schedulePaymentRefHighlight(paymentRef, options = {}) {
  const attempts = Array.isArray(options.attempts) && options.attempts.length ? options.attempts : [80, 250, 650];
  for (const delay of attempts) {
    window.setTimeout(() => {
      if (!scrollToPaymentRef(paymentRef, options) && options.fallback) {
        options.fallback();
      }
    }, delay);
  }
}

function handlePaymentDeepLink(options = {}) {
  const linkContext = readPaymentLinkContextFromUrl();
  if (!linkContext.payment) return false;
  const normalizedRef = normalizePaymentRefValue(linkContext.payment);
  const item = findPaymentItemByRef(normalizedRef);
  const requestedScope = ["current", "closed"].includes(linkContext.scope) ? linkContext.scope : "";
  const resolvedScope = item?.scope || requestedScope;

  if (resolvedScope === "closed") {
    const periodId = item?.periodId || linkContext.periodId || "";
    if (periodId) expandedClosedPeriodIds.add(periodId);
    setActiveHistorySection("archive");
    setActiveView("history");
    schedulePaymentRefHighlight(normalizedRef, {
      selectors: [".archive-payment-card[data-payment-ref]"],
      fallback: () => {
        const periodCard = periodId ? document.querySelector(`[data-period-id="${cssEscape(periodId)}"]`) : null;
        (periodCard || document.querySelector("#closedPeriods"))?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  } else if (resolvedScope === "current") {
    setActiveView("settle");
    schedulePaymentRefHighlight(normalizedRef, {
      selectors: [".settlement-card[data-payment-ref]"],
      fallback: () => els.settlements?.scrollIntoView({ behavior: "smooth", block: "start" })
    });
  } else {
    setActivePaymentSection("all");
    setActiveView("payments");
    schedulePaymentRefHighlight(normalizedRef, {
      selectors: [".unpaid-payment-card[data-payment-ref]", "[data-payment-ref]"],
      fallback: () => els.unpaidPaymentList?.scrollIntoView({ behavior: "smooth", block: "start" })
    });
  }

  if (!options.silent && !item) {
    showAppMessage(`Could not find unpaid payment ${normalizedRef}. It may already be paid, archived differently, or not synced on this device yet.`, "info", { timeoutMs: 7000 });
  }
  return true;
}

function handleStartupDeepLinks(options = {}) {
  return handlePaymentDeepLink(options) || handleLogDeepLink(options);
}

function findTripForFuelFollowup({ tripId = "", bookingId = "", logRef = "" } = {}) {
  const normalizedRef = normalizeLogRefValue(logRef);
  if (tripId) {
    const exactTrip = state.trips.find((entry) => entry.id === tripId);
    if (exactTrip) return exactTrip;
  }
  if (bookingId) {
    const bookingTrip = state.trips.find((entry) => entry.sourceBookingId === bookingId);
    if (bookingTrip) return bookingTrip;
  }
  if (normalizedRef) {
    const refTrip = state.trips.find((entry) => normalizeLogRefValue(formatLogRef(entry)) === normalizedRef || normalizeLogRefValue(entry.logRef) === normalizedRef);
    if (refTrip) return refTrip;
  }
  return null;
}

function startFuelFromPendingAction(button) {
  const trip = findTripForFuelFollowup({
    tripId: button?.dataset?.addFuelForTrip || "",
    bookingId: button?.dataset?.addFuelBooking || "",
    logRef: button?.dataset?.addFuelLogRef || ""
  });
  if (!trip) {
    const message = "Could not find the linked trip for this fuel follow-up. Open History and edit the trip, or reload and try again.";
    showAppMessage(message, "error", { timeoutMs: 7000 });
    console.warn("Pending fuel follow-up could not resolve trip", {
      tripId: button?.dataset?.addFuelForTrip || "",
      bookingId: button?.dataset?.addFuelBooking || "",
      logRef: button?.dataset?.addFuelLogRef || ""
    });
    return;
  }
  startFuelFromTrip(trip.id);
}

function startFuelFromTrip(id) {
  const trip = findTripForFuelFollowup({ tripId: id });
  if (!trip) {
    showAppMessage("Could not find the linked trip for this fuel follow-up.", "error", { timeoutMs: 7000 });
    return;
  }
  if (!canManageTripEntry(trip)) {
    showUserError("Only the trip driver or an admin can add fuel for this trip.");
    return;
  }
  if (!assertCurrentPeriodAllowsMoneyChanges("add fuel for this trip")) return;
  editingTripId = null;
  editingFuelId = null;
  editingBookingId = null;
  clearTripLoggingContext();
  pendingFuelTripContext = buildFuelContextFromTrip(trip);
  els.fuelForm?.reset();
  clearFuelLocation();
  prefillFuelFromTripContext(pendingFuelTripContext);
  updateEditUi();
  setActiveView("log");
  setTimeout(() => {
    els.fuelLogPanel?.scrollIntoView({ behavior: "smooth", block: "center" });
    els.fuelForm?.scrollIntoView({ behavior: "smooth", block: "center" });
    els.fuelAmount?.focus({ preventScroll: true });
  }, 0);
  showAppMessage(`Fuel form filled for trip ${formatLogRef(trip)}.`);
}

function startBookingEdit(id) {
  const booking = state.bookings.find((entry) => entry.id === id);
  if (!booking) return;

  showBookViewForEditing();
  editingTripId = null;
  editingFuelId = null;
  clearTripLoggingContext();
  clearFuelLoggingContext();
  editingBookingId = id;
  syncTripDateBounds();
  renderPeopleSelectors();
  els.bookingMember.value = booking.member;
  els.bookingStart.value = booking.start;
  els.bookingEnd.value = booking.end;
  els.bookingPurpose.value = booking.purpose || "";
  renderBookingConflictNotice(null);
  updateEditUi();
  els.bookingForm.scrollIntoView({ behavior: "smooth", block: "start" });
  els.bookingStart.focus();
}

function startFuelEdit(id) {
  const fuel = state.fuel.find((entry) => entry.id === id);
  if (!fuel) return;

  showLogViewForEditing();
  editingTripId = null;
  editingBookingId = null;
  clearTripLoggingContext();
  clearFuelLoggingContext();
  editingFuelId = id;
  syncTripDateBounds();
  renderPeopleSelectors();
  els.fuelPayer.value = fuel.payer;
  els.fuelDate.value = fuel.date;
  els.fuelAmount.value = fuel.amount;
  if (els.fuelLiters) els.fuelLiters.value = fuel.liters || "";
  if (els.fuelOdometer) els.fuelOdometer.value = fuel.odometer || "";
  if (els.fuelStation) els.fuelStation.value = fuel.station || fuel.stationInfo?.name || "";
  if (els.fuelLatitude) els.fuelLatitude.value = fuel.location?.latitude || "";
  if (els.fuelLongitude) els.fuelLongitude.value = fuel.location?.longitude || "";
  if (els.fuelStationLatitude) els.fuelStationLatitude.value = fuel.stationInfo?.latitude || "";
  if (els.fuelStationLongitude) els.fuelStationLongitude.value = fuel.stationInfo?.longitude || "";
  if (els.fuelStationBrand) els.fuelStationBrand.value = fuel.stationInfo?.brand || "";
  if (els.fuelLocationPrivacyMode) {
    els.fuelLocationPrivacyMode.value = fuel.locationPrivacyMode || window.FuelLocationPrivacy?.inferFuelLocationPrivacyMode?.(fuel) || "station-only";
  }
  if (els.fuelFullTank) els.fuelFullTank.checked = Boolean(fuel.fullTank);
  const details = document.querySelector("#fuelDetails");
  if (details) details.open = true;
  updateEditUi();
  els.fuelForm.scrollIntoView({ behavior: "smooth", block: "start" });
  els.fuelAmount.focus();
}

function updateEditUi() {
  if (els.tripSubmit) els.tripSubmit.textContent = editingTripId ? "Save trip changes" : "Add trip";
  if (els.cancelTripEdit) els.cancelTripEdit.classList.toggle("hidden", !editingTripId);
  if (els.bookingSubmit) els.bookingSubmit.textContent = editingBookingId ? "Save booking changes" : "Add booking";
  if (els.cancelBookingEdit) els.cancelBookingEdit.classList.toggle("hidden", !editingBookingId);
  if (els.fuelSubmit) els.fuelSubmit.textContent = editingFuelId ? "Save fuel changes" : "Add fuel";
  if (els.cancelFuelEdit) els.cancelFuelEdit.classList.toggle("hidden", !editingFuelId);
}

function startTripFromBooking(id) {
  const booking = state.bookings.find((item) => item.id === id);
  if (!booking) return;
  const existingTrip = findTripForBooking(booking.id);
  if (existingTrip) {
    showUserError(`Booking ${formatTypedLogRef(booking, "booking")} has already been logged as trip ${formatTypedLogRef(existingTrip, "trip")}.`);
    render();
    return;
  }
  if (!canCreateTripFromBooking(booking)) {
    showUserError("Only the booked driver can turn this booking into a trip log.");
    return;
  }

  editingTripId = null;
  editingFuelId = null;
  editingBookingId = null;
  clearFuelLoggingContext();
  clearTripCorrectionPanel();
  pendingTripBookingContext = PlannerBookingBridge.buildTripContextFromBooking(booking, {
    createLogRef,
    extractEstimatedDistanceFromText
  });
  setTripFormBookingContextDataset(pendingTripBookingContext);
  renderPeopleSelectors();
  if (getMemberNames().includes(booking.member)) els.tripDriver.value = booking.member;
  const bookingEnd = parseBookingDate(booking.end);
  const bookingStart = parseBookingDate(booking.start);
  if (bookingEnd) els.tripDate.value = localDateString(bookingEnd);
  else if (bookingStart) els.tripDate.value = localDateString(bookingStart);
  syncTripDateBounds();
  syncStartOdometerDefault();
  els.endKm.value = "";
  els.tripNote.value = booking.purpose ? `Booking: ${booking.purpose}` : "Booking";
  renderTripBookingContext();
  updateEditUi();
  setActiveView("log");
  const tripParticipants = PlannerBookingBridge.plannedTripParticipantsFromBooking(booking);
  TripActions.setCheckboxSelection(els.tripParticipants, tripParticipants);
  setTimeout(() => {
    els.tripForm.scrollIntoView({ behavior: "smooth", block: "start" });
    els.endKm.focus();
  }, 0);
  showAppMessage("Trip form filled from booking. Add the end odometer when you park.");
}

function canCreateTripFromBooking(booking) {
  if (!booking) return false;
  if (findTripForBooking(booking.id)) return false;
  if (!supabaseClient) return true;
  return getCurrentMemberProfile()?.name === booking.member;
}

function renderHistory() {
  if (state.trips.length === 0) {
    els.tripList.replaceChildren(emptyNode());
  } else {
    els.tripList.innerHTML = renderCategorizedTrips(state.trips);
  }

  if (state.fuel.length === 0) {
    els.fuelList.replaceChildren(emptyNode());
  } else {
    els.fuelList.innerHTML = renderCategorizedFuel(state.fuel);
  }
}

function tripRenderingDeps() {
  return {
    escapeHtml,
    formatNumber,
    formatDate,
    localDateString,
    round,
    byNewest,
    groupBy,
    calculateLedger,
    getTripParticipants,
    getTripCategory,
    getTripEntryReviewSignal,
    renderEntryReviewSignal,
    canManageTripEntry,
    renderPermissionNote,
    describeTripPermissionMessage
  };
}

function renderCategorizedTrips(trips) {
  return window.TripRendering.renderCategorizedTrips(trips, tripRenderingDeps());
}

function createLogRef(id = crypto.randomUUID()) {
  const compact = String(id || crypto.randomUUID()).replace(/[^a-z0-9]/gi, "").toUpperCase();
  return `#${(compact || "LOG000").slice(0, 6)}`;
}

function formatLogRef(entry) {
  return entry?.logRef || createLogRef(entry?.id || "");
}

function formatDateTimeShort(value) {
  return window.TripRendering.formatDateTimeShort(value, tripRenderingDeps());
}

function getTripPeriodLabel(trip) {
  return window.TripRendering.getTripPeriodLabel(trip, tripRenderingDeps());
}

function renderTripEntryCard(trip, ledger = null) {
  return window.TripRendering.renderTripEntryCard(trip, ledger, tripRenderingDeps());
}

function fuelRenderingDeps() {
  return {
    escapeHtml,
    formatNumber,
    formatDate,
    formatMoney,
    formatMoneyFor,
    round,
    roundMoney,
    byNewest,
    groupBy,
    calculateLedger,
    formatLogRef,
    formatTypedLogRef,
    formatFuelAmountLitersAndPrice,
    getFuelEntryReviewSignal,
    renderEntryReviewSignal,
    canManageFuelEntry,
    renderPermissionNote,
    describeFuelPermissionMessage
  };
}

function renderCategorizedFuel(fuelLogs) {
  return window.FuelRendering.renderCategorizedFuel(fuelLogs, fuelRenderingDeps());
}

function renderFuelEntryCard(fuel, ledger = null) {
  return window.FuelRendering.renderFuelEntryCard(fuel, ledger, fuelRenderingDeps());
}

function getTripCategory(trip) {
  const text = `${trip.note || ""} ${trip.purpose || ""}`.toLowerCase();
  if (text.includes("auto test") || text.includes("stress")) return "Test";
  if (text.includes("fuel") || text.includes("refuel") || text.includes("tank")) return "Fuel";
  if (text.includes("holiday") || text.includes("vacation") || text.includes("weekend")) return "Trip";
  if (text.includes("work") || text.includes("office")) return "Work";
  return "General";
}

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] = groups[key] || [];
    groups[key].push(item);
    return groups;
  }, {});
}

function renderSystemHealth(ledger) {
  if (!els.systemHealthPanel || !els.systemHealthSummary || !els.systemHealthList) return;

  const checks = buildSystemHealthChecks(ledger);
  const counts = checks.reduce(
    (acc, check) => {
      acc[check.level] = (acc[check.level] || 0) + 1;
      return acc;
    },
    { issue: 0, warning: 0, ok: 0 }
  );

  els.systemHealthSummary.innerHTML = `
    <article class="health-summary-card ${counts.issue ? "has-issue" : ""}">
      <span>Needs attention</span>
      <strong>${counts.issue || 0}</strong>
    </article>
    <article class="health-summary-card ${counts.warning ? "has-warning" : ""}">
      <span>Warnings</span>
      <strong>${counts.warning || 0}</strong>
    </article>
    <article class="health-summary-card">
      <span>Looks good</span>
      <strong>${counts.ok || 0}</strong>
    </article>
  `;

  els.systemHealthList.innerHTML = checks
    .map(
      (check) => `
        <article class="health-check ${check.level}">
          <div>
            <strong>${escapeHtml(check.title)}</strong>
            <p>${escapeHtml(check.message)}</p>
          </div>
          <span>${healthLevelLabel(check.level)}</span>
        </article>
      `
    )
    .join("");
}




function memberRoleLabel(role) {
  return role === "admin" ? "Admin" : "Member";
}

function memberRoleDescription(role) {
  return role === "admin"
    ? "Can manage members, settings, diagnostics, exports, and admin tools."
    : "Can use the ledger, create allowed trips/fuel logs, and manage their own payments.";
}

function describeManagedMember(member) {
  const name = member?.name || "This member";
  const email = member?.email ? ` · ${member.email}` : "";
  const status = member?.is_active ? "Active" : "Inactive";
  return `${name}${email} · ${memberRoleLabel(member?.role)} · ${status}`;
}

function confirmManagedMemberRoleChange(existingMember, nextRole) {
  const currentRole = existingMember?.role === "admin" ? "admin" : "member";
  if (currentRole === nextRole) return true;
  const name = existingMember?.name || "this member";
  const message = nextRole === "admin"
    ? `Promote ${name} to admin? Admins can manage members, settings, diagnostics, exports, and reset tools.`
    : `Change ${name} from admin to member? They will lose access to member management, settings, diagnostics, exports, and reset tools.`;
  return confirmUserAction(message);
}

function renderMemberManagementPanel() {
  if (!els.memberManagementPanel) return;
  const canManage = canManageSettings();
  els.memberManagementPanel.classList.toggle("hidden", !canManage);
  if (!canManage) return;

  if (!memberManagementStatus.loaded && !memberManagementStatus.loading && supabaseClient && currentSession) {
    refreshMemberManagement().catch((error) => {
      memberManagementStatus.error = error.message || String(error);
      renderMemberManagementPanel();
    });
  }

  if (els.memberManagementMessage) {
    els.memberManagementMessage.textContent = memberManagementStatus.loading
      ? "Loading members..."
      : memberManagementStatus.error
        ? `Could not load members: ${memberManagementStatus.error}`
        : "Active members can use the app. Admins can manage members, settings, diagnostics, exports, and reset tools. Keep at least one active admin.";
  }

  if (!els.memberManagementList) return;
  const rows = memberManagementStatus.rows || [];
  if (!rows.length && !memberManagementStatus.loading) {
    els.memberManagementList.innerHTML = `<p class="empty-state">No members found in the normalized table.</p>`;
    return;
  }

  const activeAdmins = rows.filter((member) => member.is_active && member.role === "admin");
  const currentEmail = getLoggedInEmail();
  els.memberManagementList.innerHTML = `
    <div class="member-management-header">
      <span>Name</span>
      <span>Email</span>
      <span>MobilePay</span>
      <span>Role / access</span>
      <span>Status</span>
      <span>Actions</span>
    </div>
    ${rows.map((member) => renderManagedMemberRow(member, activeAdmins.length, currentEmail)).join("")}
  `;
}

function renderManagedMemberRow(member, activeAdminCount, currentEmail) {
  const isSelf = normalizeEmail(member.email || "") === currentEmail;
  const isLastAdmin = member.is_active && member.role === "admin" && activeAdminCount <= 1;
  const statusText = member.is_active ? "Active" : "Inactive";
  const statusClass = member.is_active ? "status-ok" : "status-warning";
  const disableDanger = isSelf || isLastAdmin;
  const role = member.role === "admin" ? "admin" : "member";
  const roleLabel = memberRoleLabel(role);
  const roleDescription = memberRoleDescription(role);
  const dangerTitle = isSelf
    ? "You cannot deactivate or demote yourself here. Add another admin first."
    : isLastAdmin
      ? "At least one active admin is required. Add or promote another admin first."
      : "";
  const rowNote = isSelf
    ? "You are signed in as this member. Another admin must change your role or deactivate you."
    : isLastAdmin
      ? "Protected because this is the only active admin."
      : roleDescription;
  return `
    <div class="member-management-row ${member.is_active ? "" : "inactive"}" data-member-id="${escapeHtml(member.id)}">
      <div class="member-field-stack">
        <input class="member-row-name" type="text" value="${escapeHtml(member.name || "")}" aria-label="Member name" />
        <small>${escapeHtml(member.is_active ? "Visible in the app" : "Inactive member")}</small>
      </div>
      <div class="member-field-stack">
        <input class="member-row-email" type="email" value="${escapeHtml(member.email || "")}" placeholder="login email" aria-label="Login email" />
        <small>Must match the email used to sign in.</small>
      </div>
      <div class="member-field-stack">
        <input class="member-row-mobilepay" type="tel" value="${escapeHtml(formatPhoneDisplay(member.mobilepay_phone || ""))}" placeholder="MobilePay phone" aria-label="MobilePay phone" />
        <small>Used for payment links when available.</small>
      </div>
      <div class="member-field-stack">
        <select class="member-row-role" ${disableDanger ? "data-protect-admin=\"true\"" : ""} aria-label="Role for ${escapeHtml(member.name || "member")}">
          <option value="member" ${role === "admin" ? "" : "selected"}>Member</option>
          <option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>
        </select>
        <small><strong>${escapeHtml(roleLabel)}:</strong> ${escapeHtml(rowNote)}</small>
      </div>
      <span class="status-pill ${statusClass}">${statusText}</span>
      <div class="button-row compact-actions">
        <button class="subtle-button" type="button" data-member-action="save">Save</button>
        ${member.is_active
          ? `<button class="danger-button" type="button" data-member-action="deactivate" ${disableDanger ? "disabled" : ""} title="${escapeHtml(dangerTitle)}">Deactivate</button>`
          : `<button class="subtle-button" type="button" data-member-action="reactivate">Reactivate</button>`}
      </div>
    </div>
  `;
}

async function callMemberManagementRoute(action, payload = {}) {
  if (typeof fetch !== "function") throw new Error("Render member management requires browser fetch support.");
  const accessToken = await getFreshRenderAccessToken();
  if (!accessToken) throw new Error("Sign in before managing members.");
  const ledgerId = getActiveLedgerId();
  const response = await fetch(renderMemberManagementUrl, {
    method: "POST",
    headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ledgerId, action, ...payload })
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
  if (!response.ok || !result?.ok) {
    const message = result?.message || result?.error || text || `Render member management failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = result?.code || response.status;
    throw error;
  }
  return result;
}

async function refreshMemberManagement() {
  if (!supabaseClient || !currentSession) return;
  memberManagementStatus.loading = true;
  memberManagementStatus.error = "";
  renderMemberManagementPanel();
  try {
    const result = await callMemberManagementRoute("list");
    memberManagementStatus.rows = Array.isArray(result.members) ? result.members : [];
    memberManagementStatus.loaded = true;
  } catch (error) {
    memberManagementStatus.error = error.message || String(error);
    memberManagementStatus.loaded = true;
  } finally {
    memberManagementStatus.loading = false;
    renderMemberManagementPanel();
  }
}

function getManagedMemberPayloadFromRow(row) {
  return {
    id: row.dataset.memberId,
    name: row.querySelector(".member-row-name")?.value.trim() || "",
    email: normalizeEmail(row.querySelector(".member-row-email")?.value || "") || null,
    mobilepay_phone: normalizePhone(row.querySelector(".member-row-mobilepay")?.value || "") || null,
    role: row.querySelector(".member-row-role")?.value === "admin" ? "admin" : "member"
  };
}

function protectAgainstAdminLockout(payload, existingMember, nextActive = existingMember?.is_active !== false) {
  const currentEmail = getLoggedInEmail();
  const isSelf = normalizeEmail(existingMember?.email || "") === currentEmail;
  if (isSelf && (!nextActive || payload.role !== "admin")) {
    showUserError("You cannot deactivate or demote yourself. Add another admin first, then ask that admin to change your role if needed.");
    return false;
  }

  const rows = memberManagementStatus.rows || [];
  const activeAdminsAfter = rows.filter((member) => {
    if (member.id !== existingMember?.id) return member.is_active && member.role === "admin";
    return nextActive && payload.role === "admin";
  });
  if (activeAdminsAfter.length === 0) {
    showUserError("At least one active admin is required.");
    return false;
  }
  return true;
}

async function upsertManagedMemberRpc(payload) {
  const result = await callMemberManagementRoute("upsert", { member: {
    id: payload.id || null,
    name: payload.name,
    email: payload.email || null,
    mobilepayPhone: payload.mobilepay_phone || null,
    role: payload.role,
    isActive: payload.is_active !== false
  }});
  return { ok: true, data: result.member || result.result };
}

async function setManagedMemberActiveRpc(memberId, isActive) {
  const result = await callMemberManagementRoute("set-active", { memberId, isActive: Boolean(isActive) });
  return { ok: true, data: result.member || result.result };
}

async function saveManagedMember(row) {
  const payload = getManagedMemberPayloadFromRow(row);
  if (!payload.name) {
    showUserError("Member name is required.");
    return;
  }
  const existing = (memberManagementStatus.rows || []).find((member) => member.id === payload.id);
  if (!protectAgainstAdminLockout(payload, existing, existing?.is_active !== false)) return;
  if (!confirmManagedMemberRoleChange(existing, payload.role)) return;

  let result;
  try {
    result = await upsertManagedMemberRpc({ ...payload, is_active: existing?.is_active !== false });
  } catch (error) {
    showUserError(`Could not save member: ${error.message || error}. Apply the latest Supabase schema if the member-management RPC is missing.`);
    return;
  }
  await afterMemberManagementChange(`${payload.name} saved as ${memberRoleLabel(payload.role)}.`);
}

async function setManagedMemberActive(row, isActive) {
  const payload = getManagedMemberPayloadFromRow(row);
  const existing = (memberManagementStatus.rows || []).find((member) => member.id === payload.id);
  if (!isActive && !confirmUserAction(`Deactivate ${describeManagedMember(existing)}? They will no longer be able to access the app.`)) return;
  if (!protectAgainstAdminLockout(payload, existing, isActive)) return;

  let result;
  try {
    result = await setManagedMemberActiveRpc(payload.id, isActive);
  } catch (error) {
    showUserError(`Could not update member: ${error.message || error}. Apply the latest Supabase schema if the member-activation RPC is missing.`);
    return;
  }
  await afterMemberManagementChange(isActive ? `${existing?.name || "Member"} reactivated.` : `${existing?.name || "Member"} deactivated.`);
}

async function addManagedMember() {
  const name = els.newMemberName?.value.trim() || "";
  const email = normalizeEmail(els.newMemberEmail?.value || "");
  const mobilepayPhone = normalizePhone(els.newMemberMobilePayPhone?.value || "");
  const role = els.newMemberRole?.value === "admin" ? "admin" : "member";
  if (!name) {
    showUserError("Member name is required.");
    return;
  }
  if (!email) {
    showUserError("Login email is required before inviting a member.");
    return;
  }

  let result;
  try {
    result = await upsertManagedMemberRpc({
      id: null,
      name,
      email,
      mobilepay_phone: mobilepayPhone || null,
      role,
      is_active: true
    });
  } catch (error) {
    showUserError(`Could not add member: ${error.message || error}. Apply the latest Supabase schema if the member-management RPC is missing.`);
    return;
  }
  if (els.newMemberName) els.newMemberName.value = "";
  if (els.newMemberEmail) els.newMemberEmail.value = "";
  if (els.newMemberMobilePayPhone) els.newMemberMobilePayPhone.value = "";
  if (els.newMemberRole) els.newMemberRole.value = "member";
  await afterMemberManagementChange(`${name} added as ${memberRoleLabel(role)}.`);
}

async function afterMemberManagementChange(message) {
  if (els.memberManagementMessage) els.memberManagementMessage.textContent = message;
  await traceAdminToolOperation("refresh-members", "Refresh member management", refreshMemberManagement);
  memberManagementStatus.error = "";
  await loadSupabaseStateWithTimeout(
    { force: true, reason: "member-management" },
    supabaseStartupLoadTimeoutMs,
    "Member management cloud refresh is delayed."
  );
  await refreshDatabaseDiagnostics().catch(() => {});
  await checkNormalizedTablesAgainstCurrentState({ force: true, reason: "admin-action" }).catch(() => {});
  render();
}


function setRedeemInviteMessage(message, tone = "") {
  if (!els.redeemInviteMessage) return;
  els.redeemInviteMessage.textContent = message || "";
  els.redeemInviteMessage.classList.toggle("error-text", tone === "error");
  els.redeemInviteMessage.classList.toggle("success-text", tone === "success");
}

function renderInviteRedemptionPanel() {
  if (!els.inviteRedemptionPanel) return;
  const visible = Boolean(supabaseClient && currentSession && !isStartupHydrating());
  els.inviteRedemptionPanel.classList.toggle("hidden", !visible);
  if (els.redeemInviteButton) els.redeemInviteButton.disabled = !visible;
  if (!visible) {
    setRedeemInviteMessage(supabaseClient ? "Sign in before redeeming an invite code." : "Invite redemption requires Supabase sign-in.");
    return;
  }
  const currentMessage = String(els.redeemInviteMessage?.textContent || "").trim();
  if (!currentMessage || /sign in before redeeming/i.test(currentMessage)) {
    setRedeemInviteMessage("Paste an invite code to join another workspace.");
  }
}

function normalizeInviteCodeInput(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function getInviteCodeFromParams(params) {
  for (const name of inviteDeepLinkParamNames) {
    const code = normalizeInviteCodeInput(params.get(name) || "");
    if (code) return code;
  }
  return "";
}

function readInviteCodeFromCurrentUrl() {
  let inviteCode = "";
  try {
    inviteCode = getInviteCodeFromParams(new URLSearchParams(window.location.search || ""));
    if (!inviteCode) {
      const rawHash = String(window.location.hash || "").replace(/^#/, "");
      inviteCode = getInviteCodeFromParams(new URLSearchParams(rawHash));
    }
  } catch (error) {
    console.warn("Could not read invite code from URL", error);
  }
  return inviteCode;
}

function removeInviteCodeFromCurrentUrl() {
  if (!window.history || !window.history.replaceState) return;
  try {
    const url = new URL(window.location.href);
    let changed = false;
    inviteDeepLinkParamNames.forEach((name) => {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    });
    const rawHash = String(url.hash || "").replace(/^#/, "");
    if (rawHash) {
      const hashParams = new URLSearchParams(rawHash);
      let hashChanged = false;
      inviteDeepLinkParamNames.forEach((name) => {
        if (hashParams.has(name)) {
          hashParams.delete(name);
          hashChanged = true;
        }
      });
      if (hashChanged) {
        const nextHash = hashParams.toString();
        url.hash = nextHash ? `#${nextHash}` : "";
        changed = true;
      }
    }
    if (changed) window.history.replaceState(window.history.state, document.title, url.toString());
  } catch (error) {
    console.warn("Could not remove invite code from URL", error);
  }
}

function initializeInviteDeepLink() {
  const inviteCode = readInviteCodeFromCurrentUrl();
  if (!inviteCode) {
    hydrateLoginInviteCodeInput();
    return "";
  }
  localStorage.setItem(pendingWorkspaceInviteCodeKey, inviteCode);
  if (els.loginInviteCode && !currentSession) els.loginInviteCode.value = inviteCode;
  if (els.redeemInviteCode && currentSession) els.redeemInviteCode.value = inviteCode;
  removeInviteCodeFromCurrentUrl();
  recordSupabaseLoadEvent("invite-link-detected", "workspace invite code stored for redemption");
  return inviteCode;
}

function buildWorkspaceInviteLink(inviteCode) {
  const code = normalizeInviteCodeInput(inviteCode);
  if (!code) return "";
  const url = new URL(window.location.href);
  url.hash = "";
  inviteDeepLinkParamNames.forEach((name) => url.searchParams.delete(name));
  removeWorkspaceScopeFromUrlObject(url);
  url.searchParams.set("invite", code);
  return url.toString();
}

function describeInviteRedeemError(error) {
  const message = String(error?.message || error || "Invite redemption failed.");
  if (/signed-in user email/i.test(message) || /JWT|auth/i.test(message)) return "Sign in with the email that should join this workspace, then try the invite code again.";
  if (/different email address/i.test(message)) return "This invite is restricted to a different email address. Ask the workspace admin for a code for your signed-in email.";
  if (/invalid|expired|revoked|already used/i.test(message)) return "Invite code is invalid, expired, revoked, or already used. Ask the workspace admin for a fresh invite.";
  if (/gen_random_bytes/i.test(message) || /digest\(/i.test(message) || /pgcrypto/i.test(message)) return describeWorkspaceInviteError(error);
  return message;
}

async function refreshLinkedWorkspacesAfterInvite(preferredLedgerId = "") {
  if (!supabaseClient || !currentSession) return [];
  const preferred = String(preferredLedgerId || "").trim();
  if (preferred) setActiveLedgerId(preferred, { persist: true });
  const { data, error } = await supabaseClient.rpc("list_my_ledgers");
  if (error) throw error;
  workspaceInviteStatus.ledgers = normalizeWorkspaceLedgerList(data);
  workspaceInviteStatus.loaded = true;
  lastWorkspaceInviteRefreshAt = Date.now();
  reconcileActiveLedgerSelection({ allowWhileLoading: true, reason: "refresh-linked-workspaces", preferredLedgerId: preferred });
  renderActiveWorkspaceSelector();
  return workspaceInviteStatus.ledgers;
}

async function redeemWorkspaceInvite(inviteCodeOverride = "") {
  if (!supabaseClient || !currentSession) {
    showUserError("Sign in before redeeming an invite code.");
    setRedeemInviteMessage("Sign in before redeeming an invite code.", "error");
    return false;
  }
  const inviteCode = normalizeInviteCodeInput(inviteCodeOverride || els.redeemInviteCode?.value || "");
  if (!inviteCode) {
    showUserError("Enter an invite code before joining a workspace.");
    setRedeemInviteMessage("Enter an invite code before joining a workspace.", "error");
    els.redeemInviteCode?.focus();
    return false;
  }

  if (els.redeemInviteButton) els.redeemInviteButton.disabled = true;
  setRedeemInviteMessage("Redeeming invite...");
  const operationId = createDataIoOperationId("workspace-invite-redeem", "redeem");
  const traceMeta = {
    source: "workspace-invite-redeem",
    route: "supabase-rpc",
    rpc: "redeem_ledger_invite",
    operation: "redeem",
    operationId,
    staleAfterMs: workspaceInviteRequestTimeoutMs,
    detail: "Redeem workspace invite"
  };
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "INVITE_REDEEM_STARTED" });
  try {
    const { data, error } = await supabaseClient.rpc("redeem_ledger_invite", { invite_code: inviteCode });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const joinedLedgerId = String(result?.ledger_id || "").trim();
    if (joinedLedgerId) setActiveLedgerId(joinedLedgerId, { persist: true });
    const ledgers = await refreshLinkedWorkspacesAfterInvite(joinedLedgerId);
    const targetLedger = joinedLedgerId || String(ledgers[0]?.ledger_id || getActiveLedgerId());
    if (targetLedger && isLedgerLinkedToCurrentUser(targetLedger)) {
      setRedeemInviteMessage("Invite accepted. Switching workspace...", "success");
      if (els.redeemInviteCode) els.redeemInviteCode.value = "";
      await switchActiveWorkspace(targetLedger, "invite-redemption");
      setRedeemInviteMessage(`Joined ${getCurrentWorkspaceLabel()}. Next, confirm your profile below.`, "success");
      setMemberProfileSetupMessage("Invite accepted. Confirm your display name and optional MobilePay phone.", "success");
    } else {
      if (els.redeemInviteCode) els.redeemInviteCode.value = "";
      setRedeemInviteMessage("Invite accepted. Refreshing workspace list. Next, confirm your profile below.", "success");
      setMemberProfileSetupMessage("Invite accepted. Confirm your display name and optional MobilePay phone.", "success");
      await loadSupabaseStateWithTimeout(
        { force: true, reason: "invite-redemption" },
        supabaseStartupLoadTimeoutMs,
        "Invite accepted, but workspace sync is delayed. Use Sync now to retry."
      );
    }
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, resultCode: "INVITE_REDEEMED", detail: `Invite redeemed for ${getCurrentWorkspaceLabel()}` });
    if (canManageSettings()) await refreshWorkspaceInvites();
    return true;
  } catch (error) {
    const message = describeInviteRedeemError(error);
    recordDataIoDiagnostic("error", { ...traceMeta, ok: false, error, resultCode: "INVITE_REDEEM_ERROR", detail: message });
    showUserError(`Could not redeem invite: ${message}`);
    setRedeemInviteMessage(message, "error");
    return false;
  } finally {
    if (els.redeemInviteButton) els.redeemInviteButton.disabled = false;
    render();
  }
}


function setMemberProfileSetupMessage(message = "", tone = "") {
  if (!els.memberProfileSetupMessage) return;
  els.memberProfileSetupMessage.textContent = message || "";
  els.memberProfileSetupMessage.classList.toggle("error-text", tone === "error");
  els.memberProfileSetupMessage.classList.toggle("success-text", tone === "success");
}

function isLikelyGeneratedInviteName(name, email) {
  const value = String(name || "").trim().toLowerCase();
  const local = normalizeEmail(String(email || "").split("@")[0] || "");
  if (!value) return true;
  if (!local) return false;
  const normalizedValue = normalizeEmail(value.replace(/\s+/g, ""));
  const normalizedLocal = normalizeEmail(local.replace(/[._-]+/g, ""));
  return normalizedValue === local || normalizedValue === normalizedLocal || /^new member(?:[-\s]?\w+)?$/i.test(value);
}

function shouldShowMemberProfileSetup(profile = getCurrentMemberProfile()) {
  if (!supabaseClient || !currentSession || !profile || profile.pendingInvite) return false;
  if (!normalizeEmail(profile.email || getLoggedInEmail())) return false;
  return true;
}

function renderMemberProfileSetupPanel() {
  if (!els.memberProfileSetupPanel) return;
  const profile = getCurrentMemberProfile();
  const visible = shouldShowMemberProfileSetup(profile);
  els.memberProfileSetupPanel.classList.toggle("hidden", !visible);
  if (!visible) return;
  const email = normalizeEmail(profile.email || getLoggedInEmail());
  const name = String(profile.name || "").trim();
  const phone = normalizePhone(profile.mobilepayPhone || profile.mobilepay_phone || "");
  const generated = isLikelyGeneratedInviteName(name, email);
  if (els.memberProfileEmail) els.memberProfileEmail.value = email;
  if (els.memberProfileName && !els.memberProfileName.dataset.touched) els.memberProfileName.value = name || inferMemberNameFromEmail(email);
  if (els.memberProfileMobilePayPhone && !els.memberProfileMobilePayPhone.dataset.touched) els.memberProfileMobilePayPhone.value = formatPhoneDisplay(phone);
  if (els.memberProfileSetupIntro) {
    els.memberProfileSetupIntro.textContent = generated
      ? `Welcome to ${getCurrentWorkspaceLabel()}. Confirm the display name and optional MobilePay phone this workspace will see.`
      : `Signed in as ${email}. You can update your display name and optional MobilePay phone for ${getCurrentWorkspaceLabel()}.`;
  }
  if (!els.memberProfileSetupMessage?.textContent) {
    setMemberProfileSetupMessage(generated ? "Please confirm your profile after joining by invite." : "Returning users only need their email login code; no invite code is needed again.");
  }
}

async function saveOwnMemberProfileFromSetup() {
  if (!supabaseClient || !currentSession) {
    setMemberProfileSetupMessage("Sign in before saving your profile.", "error");
    return false;
  }
  const ledgerId = getActiveLedgerId();
  const name = String(els.memberProfileName?.value || "").trim();
  const mobilepayPhone = normalizePhone(els.memberProfileMobilePayPhone?.value || "");
  if (!name) {
    setMemberProfileSetupMessage("Enter the display name your workspace should see.", "error");
    els.memberProfileName?.focus();
    return false;
  }
  if (els.saveMemberProfileSetup) els.saveMemberProfileSetup.disabled = true;
  setMemberProfileSetupMessage("Saving profile...");
  const operationId = createDataIoOperationId("member-profile", "save");
  recordDataIoDiagnostic("start", {
    source: "member-profile-setup",
    route: "supabase-rpc",
    rpc: "update_own_ledger_member_profile",
    operation: "update",
    operationId,
    resultCode: "PROFILE_SAVE_STARTED",
    ok: true,
    detail: "Save own member profile"
  });
  try {
    const { data, error } = await supabaseClient.rpc("update_own_ledger_member_profile", {
      target_ledger_id: ledgerId,
      member_name: name,
      member_mobilepay_phone: mobilepayPhone || null
    });
    if (error) throw error;
    const saved = Array.isArray(data) ? data[0] : data;
    authBoundMemberProfile = {
      ...(authBoundMemberProfile || {}),
      id: saved?.member_id || authBoundMemberProfile?.id || "",
      name: saved?.name || name,
      email: normalizeEmail(saved?.email || getLoggedInEmail()),
      role: saved?.role === "admin" ? "admin" : "member",
      mobilepayPhone: normalizePhone(saved?.mobilepay_phone || mobilepayPhone || ""),
      authBound: true
    };
    authBoundMemberProfileLedgerId = ledgerId;
    const previousName = getMemberNames().find((member) => normalizeEmail(getMemberProfile(member).email) === authBoundMemberProfile.email);
    if (previousName && previousName !== authBoundMemberProfile.name) {
      state.members = state.members.map((member) => member === previousName ? authBoundMemberProfile.name : member);
      delete state.memberProfiles[previousName];
    } else if (!getMemberNames().includes(authBoundMemberProfile.name)) {
      state.members.push(authBoundMemberProfile.name);
    }
    state.memberProfiles[authBoundMemberProfile.name] = {
      email: authBoundMemberProfile.email,
      role: authBoundMemberProfile.role,
      mobilepayPhone: authBoundMemberProfile.mobilepayPhone
    };
    currentUser = authBoundMemberProfile.name;
    localStorage.setItem(userKey, currentUser);
    recordDataIoDiagnostic("success", {
      source: "member-profile-setup",
      route: "supabase-rpc",
      rpc: "update_own_ledger_member_profile",
      operation: "update",
      operationId,
      resultCode: "PROFILE_SAVED",
      ok: true,
      detail: "Own member profile saved"
    });
    setMemberProfileSetupMessage("Profile saved. Returning logins only need your email and email login code.", "success");
    render();
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", {
      source: "member-profile-setup",
      route: "supabase-rpc",
      rpc: "update_own_ledger_member_profile",
      operation: "update",
      operationId,
      resultCode: "PROFILE_SAVE_ERROR",
      ok: false,
      error,
      detail: "Own member profile save failed"
    });
    const message = String(error?.message || error || "Profile save failed.");
    setMemberProfileSetupMessage(message, "error");
    showUserError(`Could not save profile: ${message}`);
    return false;
  } finally {
    if (els.saveMemberProfileSetup) els.saveMemberProfileSetup.disabled = false;
    renderSupabaseLoadMonitor();
  }
}

function setWorkspaceInvitesMessage(message = "") {
  if (els.workspaceInvitesMessage) els.workspaceInvitesMessage.textContent = message;
}

function describeWorkspaceRefreshError(error) {
  const message = String(error?.message || error || "Workspace invite refresh failed.");
  if (/timed out/i.test(message)) return "Workspace invite refresh timed out. Check your connection and try Refresh again.";
  if (/JWT|auth|not authenticated|permission|403|row-level security/i.test(message)) return "Could not load workspace invite tools for this signed-in user. Refresh after sign-in, or check the workspace admin role.";
  return message;
}

async function withWorkspaceInviteRequestTimeout(requestPromise, label, timeoutMs = workspaceInviteRequestTimeoutMs) {
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve(requestPromise),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function formatInviteExpiry(value) {
  if (!value) return "No expiry reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function isInviteActive(invite) {
  if (!invite || invite.revoked_at) return false;
  if (Number(invite.uses_count || 0) >= Number(invite.max_uses || 1)) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return false;
  return true;
}

function setCreateWorkspaceMessage(message, tone = "") {
  if (!els.createWorkspaceMessage) return;
  els.createWorkspaceMessage.textContent = message || "";
  els.createWorkspaceMessage.classList.toggle("error-text", tone === "error");
  els.createWorkspaceMessage.classList.toggle("success-text", tone === "success");
}

function normalizeWorkspaceSlugInput(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function describeWorkspaceCreateError(error) {
  const message = String(error && error.message ? error.message : error || "Workspace creation failed.");
  if (/already in use|duplicate|23505/i.test(message)) return "That workspace slug is already in use. Try another name or custom slug.";
  if (/signed-in user email|JWT|auth|not authenticated/i.test(message)) return "Sign in before creating a workspace.";
  if (/row-level security|permission|403/i.test(message)) return "Supabase blocked workspace creation. Check that migration 025_workspace_foundation.sql is applied and the user is signed in.";
  return message;
}

async function createPrivateWorkspaceFromUi() {
  const actionKey = "workspace-create";
  if (activeMemberActionOperations.has(actionKey)) {
    recordMemberActionSkip(actionKey, "Create private workspace", { operation: "create" });
    setCreateWorkspaceMessage("Workspace creation is already running. Wait for it to finish before trying again.", "error");
    if (typeof showUserWarning === "function") showUserWarning("Workspace creation is already running. Wait for it to finish before trying again.");
    return false;
  }
  if (!supabaseClient || !currentSession) {
    setCreateWorkspaceMessage("Sign in before creating a workspace.", "error");
    return;
  }
  const name = String(els.newWorkspaceName && els.newWorkspaceName.value || "").trim();
  const slug = normalizeWorkspaceSlugInput(els.newWorkspaceSlug && els.newWorkspaceSlug.value || name);
  if (!name || name.length < 3) {
    setCreateWorkspaceMessage("Enter a workspace name with at least 3 characters.", "error");
    return;
  }
  if (!slug || slug.length < 3) {
    setCreateWorkspaceMessage("Enter a workspace slug with at least 3 letters or numbers.", "error");
    return;
  }
  const submitButton = els.createWorkspaceForm ? els.createWorkspaceForm.querySelector('button[type="submit"]') : null;
  if (submitButton) submitButton.disabled = true;
  setCreateWorkspaceMessage("Creating private workspace... This can take up to 15 seconds.");
  activeMemberActionOperations.add(actionKey);
  const operationId = createDataIoOperationId("workspace-create", "create");
  const traceMeta = {
    source: "workspace-create",
    route: "supabase-rpc",
    rpc: "create_private_ledger_workspace",
    operation: "create",
    operationId,
    staleAfterMs: workspaceInviteRequestTimeoutMs,
    detail: `Create private workspace ${name}`
  };
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "WORKSPACE_CREATE_STARTED" });
  try {
    const response = await withWorkspaceInviteRequestTimeout(
      supabaseClient.rpc("create_private_ledger_workspace", {
        workspace_name: name,
        workspace_slug: slug
      }),
      "Workspace creation"
    );
    if (response.error) throw response.error;
    const result = Array.isArray(response.data) ? response.data[0] : response.data;
    const newLedgerId = result && result.ledger_id ? result.ledger_id : slug;
    setActiveLedgerId(newLedgerId, { persist: true });
    if (els.newWorkspaceName) els.newWorkspaceName.value = "";
    if (els.newWorkspaceSlug) els.newWorkspaceSlug.value = "";
    workspaceInviteStatus.loaded = false;
    await refreshLinkedWorkspacesAfterInvite(newLedgerId).catch((error) => console.warn("Workspace list refresh after create failed", error));
    await switchActiveWorkspace(newLedgerId, "create-workspace");
    setCreateWorkspaceMessage(`Created ${result && result.name ? result.name : name}. You are admin of this private workspace. Create invite codes here to add other people.`, "success");
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, resultCode: "WORKSPACE_CREATED", detail: `Created private workspace ${result && result.name ? result.name : name}` });
    scheduleWorkspaceInviteRefresh("after-create-workspace");
    return true;
  } catch (error) {
    const timedOut = /timed out|timeout/i.test(String(error?.message || error || ""));
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", {
      ...traceMeta,
      ok: false,
      error,
      resultCode: timedOut ? "WORKSPACE_CREATE_TIMEOUT" : "WORKSPACE_CREATE_ERROR",
      detail: timedOut ? "Workspace creation timed out before the browser received a result." : describeWorkspaceCreateError(error)
    });
    if (timedOut) {
      const recovered = await reconcileWorkspaceCreateAfterTimeout({ name, slug, traceMeta });
      if (recovered) return true;
    }
    setCreateWorkspaceMessage(describeWorkspaceCreateError(error), "error");
    showUserError(`Could not create workspace: ${describeWorkspaceCreateError(error)}`);
    return false;
  } finally {
    activeMemberActionOperations.delete(actionKey);
    if (submitButton) submitButton.disabled = false;
    renderWorkspaceInvitesPanel();
  }
}

async function reconcileWorkspaceCreateAfterTimeout({ name, slug, traceMeta }) {
  const verifyMeta = {
    ...traceMeta,
    operationId: createDataIoOperationId("workspace-create-verify", "refresh"),
    operation: "verify",
    rpc: "list_my_ledgers",
    detail: `Verify whether timed-out workspace creation completed for ${name}`
  };
  recordDataIoDiagnostic("start", { ...verifyMeta, ok: true, resultCode: "WORKSPACE_CREATE_VERIFY_STARTED" });
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    const { data, error } = await withWorkspaceInviteRequestTimeout(
      supabaseClient.rpc("list_my_ledgers"),
      "Workspace creation verification",
      7000
    );
    if (error) throw error;
    const ledgers = Array.isArray(data) ? data : [];
    const match = ledgers.find((ledger) => {
      const ledgerId = String(ledger.ledger_id || ledger.id || "").toLowerCase();
      const ledgerSlug = String(ledger.slug || ledger.ledger_slug || "").toLowerCase();
      const ledgerName = String(ledger.name || ledger.ledger_name || "").trim().toLowerCase();
      return ledgerId === slug.toLowerCase() || ledgerSlug === slug.toLowerCase() || ledgerName === name.trim().toLowerCase();
    });
    if (match) {
      workspaceInviteStatus.ledgers = normalizeWorkspaceLedgerList(ledgers);
      workspaceInviteStatus.loaded = true;
      const newLedgerId = match.ledger_id || match.id || slug;
      setActiveLedgerId(newLedgerId, { persist: true });
      recordDataIoDiagnostic("success", {
        ...verifyMeta,
        ok: true,
        resultCode: "WORKSPACE_CREATE_CONFIRMED_AFTER_TIMEOUT",
        detail: `Workspace ${match.name || match.ledger_name || name} was created even though the first request timed out.`
      });
      setCreateWorkspaceMessage(`Created ${match.name || match.ledger_name || name}. The first request timed out, but refresh confirmed the workspace exists.`, "success");
      await switchActiveWorkspace(newLedgerId, "create-workspace-timeout-confirmed");
      scheduleWorkspaceInviteRefresh("after-create-timeout-confirmed");
      return true;
    }
    recordDataIoDiagnostic("error", {
      ...verifyMeta,
      ok: false,
      resultCode: "WORKSPACE_CREATE_NOT_CONFIRMED_AFTER_TIMEOUT",
      detail: "Workspace creation timed out and the follow-up workspace list did not show the new workspace."
    });
    setCreateWorkspaceMessage("Workspace creation timed out. I refreshed your workspace list and did not find the new workspace yet. Please wait a moment, press Refresh, then retry only if it still is not listed.", "error");
    showUserError("Could not confirm whether the workspace was created. Refresh workspace tools before trying again.");
    return false;
  } catch (verifyError) {
    recordDataIoDiagnostic("error", {
      ...verifyMeta,
      ok: false,
      error: verifyError,
      resultCode: "WORKSPACE_CREATE_VERIFY_ERROR",
      detail: describeWorkspaceRefreshError(verifyError)
    });
    return false;
  }
}

function renderInviteWorkspaceScope() {
  if (!els.inviteWorkspaceScope) return;
  const context = getCurrentWorkspaceContext();
  els.inviteWorkspaceScope.textContent = `Creating invite for: ${context.label}. Codes created here join only this workspace.`;
}

function renderWorkspaceInvitesPanel() {
  renderInviteWorkspaceScope();
  const isSignedIn = Boolean(currentSession);
  const isCurrentWorkspaceAdmin = canManageSettings();
  document.querySelectorAll(".account-current-workspace-invite-card, .account-active-invites-card").forEach((card) => {
    card.classList.toggle("hidden", !isCurrentWorkspaceAdmin);
  });
  if (!els.workspaceList && !els.inviteList) return;
  if (supabaseClient && !isSignedIn) {
    if (els.workspaceList) els.workspaceList.innerHTML = `<p class="empty-state">Sign in before loading workspace tools.</p>`;
    if (els.inviteList) els.inviteList.innerHTML = `<p class="empty-state">Sign in to review invites.</p>`;
    return;
  }
  if (activeView === "account" && !workspaceInviteStatus.loaded && !workspaceInviteStatus.loading && canRefreshWorkspaceInviteTools()) {
    scheduleWorkspaceInviteRefresh("account-panel-render");
  }
  if (workspaceInviteStatus.loading) {
    if (els.workspaceList) els.workspaceList.innerHTML = `<p class="empty-state">Loading workspaces and invites...</p>`;
    if (els.inviteList) els.inviteList.innerHTML = `<p class="empty-state">Loading invites...</p>`;
    return;
  }
  if (workspaceInviteStatus.error) {
    const message = escapeHtml(workspaceInviteStatus.error);
    if (els.workspaceList) els.workspaceList.innerHTML = `<p class="empty-state">Could not load workspace tools: ${message}</p>`;
    if (els.inviteList) els.inviteList.innerHTML = "";
    return;
  }

  reconcileActiveLedgerSelection();
  const currentLedgerId = getActiveLedgerId();
  const ledgers = workspaceInviteStatus.ledgers || [];
  if (els.workspaceList) {
    els.workspaceList.innerHTML = ledgers.length
      ? ledgers.map((ledger) => `
        <div class="member-management-row workspace-row ${ledger.ledger_id === currentLedgerId ? "current" : ""}">
          <div class="member-field-stack">
            <strong>${escapeHtml(getWorkspaceOptionLabel(ledger))}</strong>
            <small>${escapeHtml(ledger.ledger_id === currentLedgerId ? `Current selected workspace · ${ledger.ledger_id}` : `Linked workspace · ${ledger.ledger_id}`)}</small>
          </div>
          <span class="status-pill ${ledger.role === "admin" ? "status-ok" : ""}">${escapeHtml(ledger.role || "member")}</span>
          <span class="entry-meta">${ledger.invite_required === false ? "Public signup flag on" : "Invite required"}</span>
          <div class="button-row compact-actions">
            <button class="subtle-button" type="button" data-workspace-action="switch" data-ledger-id="${escapeHtml(ledger.ledger_id)}" ${ledger.ledger_id === currentLedgerId ? "disabled" : ""}>Use workspace</button>
          </div>
        </div>
      `).join("")
      : `<p class="empty-state">No linked workspaces found for this signed-in email.</p>`;
  }

  const invites = workspaceInviteStatus.invites || [];
  if (els.inviteList) {
    els.inviteList.innerHTML = invites.length
      ? invites.map((invite) => {
        const active = isInviteActive(invite);
        const uses = `${Number(invite.uses_count || 0)} / ${Number(invite.max_uses || 1)} used`;
        return `
          <div class="member-management-row invite-row ${active ? "" : "inactive"}" data-invite-id="${escapeHtml(invite.id)}">
            <div class="member-field-stack">
              <strong>${escapeHtml(invite.invited_email || "Anyone with code")}</strong>
              <small>${escapeHtml(formatInviteExpiry(invite.expires_at))}</small>
            </div>
            <span class="status-pill ${active ? "status-ok" : "status-warning"}">${active ? "Active" : "Inactive"}</span>
            <span class="entry-meta">${escapeHtml(invite.role || "member")} · ${escapeHtml(uses)}</span>
            <div class="button-row compact-actions">
              <button class="danger-button" type="button" data-invite-action="revoke" ${active ? "" : "disabled"}>Revoke</button>
            </div>
          </div>
        `;
      }).join("")
      : `<p class="empty-state">No invites found for this ledger.</p>`;
  }
}

async function refreshWorkspaceMembershipProbe(reason = "workspace-membership-probe") {
  workspaceMembershipProbeStatus = {
    checked: false,
    ok: false,
    loading: true,
    error: "",
    reason: String(reason || "workspace-membership-probe"),
    signedInEmail: normalizeEmail(getLoggedInEmail() || ""),
    rows: []
  };
  if (!supabaseClient || !currentSession) {
    workspaceMembershipProbeStatus = {
      ...workspaceMembershipProbeStatus,
      checked: true,
      ok: false,
      loading: false,
      error: "Not signed in; membership probe skipped."
    };
    return workspaceMembershipProbeStatus;
  }
  const signedInEmail = normalizeEmail(getLoggedInEmail() || "");
  if (!signedInEmail) {
    workspaceMembershipProbeStatus = {
      ...workspaceMembershipProbeStatus,
      checked: true,
      ok: false,
      loading: false,
      error: "Signed-in email is not available; membership probe skipped."
    };
    return workspaceMembershipProbeStatus;
  }
  try {
    const { data, error } = await withWorkspaceInviteRequestTimeout(
      supabaseClient
        .from("ledger_members")
        .select("id,ledger_id,email,name,role,is_active,created_at,updated_at")
        .ilike("email", signedInEmail)
        .limit(50),
      "Workspace membership probe"
    );
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []).map((row) => ({
      id: String(row.id || ""),
      ledgerId: String(row.ledger_id || ""),
      email: normalizeEmail(row.email || ""),
      name: String(row.name || ""),
      role: normalizeWorkspaceRole(row.role || "member"),
      isActive: row.is_active !== false,
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || ""
    }));
    workspaceMembershipProbeStatus = {
      checked: true,
      ok: true,
      loading: false,
      error: "",
      reason: String(reason || "workspace-membership-probe"),
      signedInEmail,
      rows
    };
    return workspaceMembershipProbeStatus;
  } catch (error) {
    workspaceMembershipProbeStatus = {
      checked: true,
      ok: false,
      loading: false,
      error: describeWorkspaceRefreshError(error),
      reason: String(reason || "workspace-membership-probe"),
      signedInEmail,
      rows: []
    };
    return workspaceMembershipProbeStatus;
  }
}

function canRefreshWorkspaceInviteTools() {
  return Boolean(supabaseClient && currentSession);
}

function scheduleWorkspaceInviteRefresh(reason = "workspace-invite-refresh") {
  if (!canRefreshWorkspaceInviteTools()) return null;
  const normalizedReason = String(reason || "workspace-invite-refresh");
  const manual = /manual|after-create|invite|redeem|switch|refresh-button|account-tab-open|account-panel-render|startup-session|auth-session|initial-session/i.test(normalizedReason);
  const now = Date.now();
  if (!manual && workspaceInviteStatus.loaded && !workspaceInviteStatus.loading && getWorkspaceLedgerOptions().length > 1 && now - Number(lastWorkspaceInviteRefreshAt || 0) < workspaceInviteRefreshFreshMs) {
    recordDataIoDiagnostic("skip", {
      source: "workspace-tools-refresh",
      route: "supabase-rpc",
      rpc: "list_my_ledgers",
      operation: "refresh",
      ok: true,
      resultCode: "WORKSPACE_REFRESH_RECENT",
      detail: `Skipped duplicate workspace refresh (${normalizedReason}); the workspace list is already fresh.`
    });
    return Promise.resolve(workspaceInviteStatus);
  }
  if (workspaceInviteStatus.loading && workspaceInviteRefreshPromise) {
    if (manual) workspaceInviteRefreshQueued = true;
    recordDataIoDiagnostic("skip", {
      source: "workspace-tools-refresh",
      route: "supabase-rpc",
      rpc: "list_my_ledgers",
      operation: "refresh",
      ok: true,
      resultCode: manual ? "WORKSPACE_REFRESH_QUEUED" : "WORKSPACE_REFRESH_IN_FLIGHT",
      detail: manual ? `Queued workspace refresh (${normalizedReason}) behind the current refresh.` : `Skipped duplicate workspace refresh (${normalizedReason}); a refresh is already running.`
    });
    return workspaceInviteRefreshPromise;
  }
  workspaceInviteRefreshPromise = refreshWorkspaceInvites({ reason: normalizedReason }).finally(() => {
    workspaceInviteRefreshPromise = null;
    if (workspaceInviteRefreshQueued) {
      workspaceInviteRefreshQueued = false;
      scheduleWorkspaceInviteRefresh(`${normalizedReason}-queued`);
    }
  });
  return workspaceInviteRefreshPromise;
}

async function ensureWorkspaceInviteToolsReady(reason = "workspace-invite-ready") {
  if (!canRefreshWorkspaceInviteTools()) return false;
  if (workspaceInviteStatus.loaded && !workspaceInviteStatus.loading) return true;
  await (scheduleWorkspaceInviteRefresh(reason) || Promise.resolve());
  return workspaceInviteStatus.loaded && !workspaceInviteStatus.error;
}

async function refreshWorkspaceInvites({ reason = "manual" } = {}) {
  if (!supabaseClient || !currentSession) return;
  if (els.refreshWorkspaceInvites) els.refreshWorkspaceInvites.disabled = true;
  workspaceInviteStatus.loading = true;
  workspaceInviteStatus.error = "";
  renderWorkspaceInvitesPanel();
  const operationId = createDataIoOperationId("workspace-tools-refresh", "refresh");
  const traceMeta = {
    source: "workspace-tools-refresh",
    route: "supabase-rpc",
    rpc: "list_my_ledgers",
    operation: "refresh",
    operationId,
    staleAfterMs: workspaceInviteRequestTimeoutMs,
    detail: `Refresh workspace tools (${reason})`
  };
  recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "WORKSPACE_REFRESH_STARTED" });
  try {
    const { data: ledgers, error: ledgersError } = await withWorkspaceInviteRequestTimeout(
      supabaseClient.rpc("list_my_ledgers"),
      "Workspace list refresh"
    );
    if (ledgersError) throw ledgersError;
    workspaceInviteStatus.rawLedgers = Array.isArray(ledgers) ? ledgers : [];
    workspaceInviteStatus.ledgers = normalizeWorkspaceLedgerList(ledgers);
    workspaceInviteStatus.loaded = true;
    await refreshWorkspaceMembershipProbe(reason).catch((probeError) => console.warn("Workspace membership probe failed", probeError));
    reconcileActiveLedgerSelection({ allowWhileLoading: true, reason });
    const ledgerId = getActiveLedgerId();
    if (canManageSettings()) {
      const { data: invites, error: invitesError } = await withWorkspaceInviteRequestTimeout(
        supabaseClient
          .from("ledger_invites")
          .select("id,ledger_id,role,invited_email,max_uses,uses_count,expires_at,revoked_at,created_at")
          .eq("ledger_id", ledgerId)
          .order("created_at", { ascending: false })
          .limit(25),
        "Invite list refresh"
      );
      if (invitesError) throw invitesError;
      workspaceInviteStatus.invites = Array.isArray(invites) ? invites : [];
    } else {
      workspaceInviteStatus.invites = [];
    }
    workspaceInviteStatus.loaded = true;
    lastWorkspaceInviteRefreshAt = Date.now();
    recordDataIoDiagnostic("success", { ...traceMeta, ok: true, resultCode: "WORKSPACE_REFRESHED", detail: `Loaded ${workspaceInviteStatus.ledgers.length} workspace(s)${canManageSettings() ? ` and ${workspaceInviteStatus.invites.length} invite(s)` : ""}.` });
  } catch (error) {
    const timedOut = /timed out|timeout/i.test(String(error?.message || error || ""));
    workspaceInviteStatus.error = describeWorkspaceRefreshError(error);
    workspaceInviteStatus.loaded = Boolean(getWorkspaceLedgerOptions().length);
    workspaceInviteStatus.invites = [];
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", {
      ...traceMeta,
      ok: false,
      error,
      resultCode: timedOut ? "WORKSPACE_REFRESH_TIMEOUT" : "WORKSPACE_REFRESH_ERROR",
      detail: timedOut ? "Workspace/invite panel refresh timed out. Existing workspace data remains usable; use Refresh only when you need the latest invite list." : workspaceInviteStatus.error
    });
  } finally {
    workspaceInviteStatus.loading = false;
    if (els.refreshWorkspaceInvites) els.refreshWorkspaceInvites.disabled = false;
    renderWorkspaceInvitesPanel();
  }
}

function renderCreatedInvite(result) {
  if (!els.createdInviteResult) return;
  if (!result) {
    els.createdInviteResult.textContent = "";
    return;
  }
  const inviteCode = result.invite_code || "";
  const inviteLink = buildWorkspaceInviteLink(inviteCode);
  const role = result.role || "member";
  const email = result.invited_email || "any signed-in user with this code";
  const context = getCurrentWorkspaceContext();
  const workspaceLabel = result.workspace_name || result.ledger_name || context.label;
  els.createdInviteResult.innerHTML = `
    <strong>Invite created for ${escapeHtml(workspaceLabel)}.</strong>
    <p>This code joins <strong>${escapeHtml(workspaceLabel)}</strong> only. It will not add the person to your other workspaces.</p>
    <p>Share the invite link below with ${escapeHtml(email)} out-of-band, such as SMS, email, or chat. The code is shown once and cannot be recovered later because Supabase stores only a hash.</p>
    <div class="copyable-code" data-created-invite-code="true">${escapeHtml(inviteCode)}</div>
    <div class="button-row compact-actions">
      <button class="primary-button compact-button" type="button" data-copy="${escapeHtml(inviteLink)}">Copy invite link</button>
      <button class="subtle-button compact-button" type="button" data-copy="${escapeHtml(inviteCode)}">Copy code only</button>
    </div>
    <p class="entry-meta">Workspace: ${escapeHtml(workspaceLabel)} · Role: ${escapeHtml(role)} · Expires: ${escapeHtml(formatInviteExpiry(result.expires_at))}</p>
    <p class="entry-meta">New users can open the invite link or paste the code on the login screen before requesting their email login code. Existing signed-in users can paste the code in the Join another workspace card.</p>
  `;
}

function describeWorkspaceInviteError(error) {
  const message = String(error?.message || error || "Invite creation failed.");
  if (/gen_random_bytes/i.test(message) || /digest\(/i.test(message) || /pgcrypto/i.test(message)) {
    return "Supabase invite code generator is not installed. Apply migrations 027_invite_code_generation_pgcrypto_fix.sql and 028_invite_code_hash_pgcrypto_fix.sql, then try again.";
  }
  return message;
}

async function createWorkspaceInvite() {
  if (!supabaseClient || !currentSession || !canManageSettings()) return;
  await ensureWorkspaceInviteToolsReady("before-create-invite").catch(() => false);
  reconcileActiveLedgerSelection();
  const ledgerId = getActiveLedgerId();
  const context = getCurrentWorkspaceContext();
  const email = normalizeEmail(els.inviteEmail?.value || "") || null;
  const role = els.inviteRole?.value === "admin" ? "admin" : "member";
  const expiresInHours = Math.max(1, Math.min(Number(els.inviteExpiresHours?.value || 168), 720));
  const maxUses = Math.max(1, Math.min(Number(els.inviteMaxUses?.value || 1), 25));
  if (role === "admin" && !confirmUserAction("Create an admin invite? Only share admin invites with someone who should manage members, backups, and diagnostics.")) return;
  const inviteTraceMeta = {
    source: "workspace-invite-create",
    route: "supabase-rpc",
    rpc: "create_ledger_invite",
    operation: "create",
    operationId: createDataIoOperationId("workspace-invite-create"),
    ledgerId,
    staleAfterMs: workspaceInviteRequestTimeoutMs,
    detail: `Creating invite for ${context.label}`
  };
  setWorkspaceInvitesMessage("Creating invite... This can take up to 15 seconds on a cold Supabase function.");
  recordDataIoDiagnostic("start", { ...inviteTraceMeta, ok: true, resultCode: "STARTED" });
  try {
    const { data, error } = await withWorkspaceInviteRequestTimeout(
      supabaseClient.rpc("create_ledger_invite", {
        target_ledger_id: ledgerId,
        invite_role: role,
        invite_email: email,
        expires_in_hours: expiresInHours,
        max_uses: maxUses
      }),
      "Invite creation"
    );
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    workspaceInviteStatus.lastCreatedInvite = result || null;
    renderCreatedInvite(result);
    const inviteCode = normalizeInviteCodeInput(result?.invite_code || "");
    recordDataIoDiagnostic("success", {
      ...inviteTraceMeta,
      ok: true,
      resultCode: inviteCode ? "INVITE_CREATED" : "OK",
      detail: inviteCode ? `Invite created for ${context.label}; code returned once.` : `Invite created for ${context.label}; no code was returned.`
    });
    setWorkspaceInvitesMessage(`Invite created for ${context.label}. Copy the invite link now; the code will not be shown again after refresh.`);
    if (els.inviteEmail) els.inviteEmail.value = "";
    if (els.inviteRole) els.inviteRole.value = "member";
    if (els.inviteExpiresHours) els.inviteExpiresHours.value = "168";
    if (els.inviteMaxUses) els.inviteMaxUses.value = "1";
    scheduleWorkspaceInviteRefresh("after-create-invite");
    renderCreatedInvite(result);
  } catch (error) {
    const timedOut = /timed out|timeout/i.test(String(error?.message || error || ""));
    recordDataIoDiagnostic(timedOut ? "timeout" : "error", {
      ...inviteTraceMeta,
      ok: false,
      error,
      resultCode: timedOut ? "INVITE_CREATE_TIMEOUT" : "INVITE_CREATE_ERROR",
      detail: timedOut ? "Invite creation timed out before the browser received a result." : "Invite creation failed before a code was returned."
    });
    showUserError(`Could not create invite: ${describeWorkspaceInviteError(error)}`);
    setWorkspaceInvitesMessage(timedOut ? "Invite creation timed out before the browser received a code. Refresh invites before retrying, because the server may still have created it." : "Invite creation failed before a code was returned.");
  } finally {
    renderWorkspaceInvitesPanel();
  }
}

async function revokeWorkspaceInvite(inviteId) {
  if (!supabaseClient || !currentSession || !canManageSettings() || !inviteId) return;
  if (!confirmUserAction("Revoke this invite? The code will stop working immediately.")) return;
  const ledgerId = getActiveLedgerId();
  setWorkspaceInvitesMessage("Revoking invite...");
  try {
    const { error } = await supabaseClient.rpc("revoke_ledger_invite", {
      target_ledger_id: ledgerId,
      target_invite_id: inviteId
    });
    if (error) throw error;
    setWorkspaceInvitesMessage("Invite revoked.");
    await refreshWorkspaceInvites();
  } catch (error) {
    showUserError(`Could not revoke invite: ${error.message || error}`);
    setWorkspaceInvitesMessage("Invite revoke failed.");
  }
}


async function runProductionActivityReset() {
  if (!supabaseClient || !currentSession) {
    showUserError("Sign in as an admin before resetting production activity.");
    return;
  }
  if (!canManageSettings()) {
    showUserError("Only an admin can reset production activity.");
    return;
  }
  const warning = [
    "This will permanently delete/reset all activity tables for this ledger:",
    "- bookings and booking activity",
    "- trips and trip participants",
    "- fuel logs",
    "- settlement requests",
    "- open and closed settlement periods",
    "",
    "Members, emails, roles, MobilePay phones, and ledger settings are kept.",
    "A JSON backup download will start before the reset."
  ].join("\n");
  if (!(await requireRenderVerifiedAdvancedAdminAction({
    actionLabel: "production activity reset",
    phrase: "RESET PRODUCTION",
    title: "Reset production activity?",
    detail: warning
  }))) return;

  try {
    await exportAdminSafetyBackup("production activity reset");
    assertFreshAdminSafetyBackup("production activity reset");
  } catch (error) {
    showUserError(error.message || String(error));
    return;
  }

  els.productionActivityReset.disabled = true;
  if (els.authMessage) els.authMessage.textContent = "Resetting production activity...";
  try {
    if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");
    const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
    const { data, error } = await supabaseClient.rpc("production_activity_reset", { target_ledger_id: ledgerId });
    if (error) throw error;

    state.bookings = [];
    state.trips = [];
    state.fuel = [];
    state.closedPeriods = [];
    state.paymentStatuses = {};
    state.lastOdometer = "";
    editTripId = null;
    editFuelId = null;
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: `Production activity reset complete. New open period ${shortId(data?.open_period_id || "")}.`
    };
    await loadSupabaseStateWithTimeout(
      { force: true, reason: "production-reset" },
      supabaseStartupLoadTimeoutMs,
      "Production reset cloud refresh is delayed."
    );
    await saveJsonMirrorBackup({ force: true, reason: "production activity reset JSON mirror backup" }).catch((error) => console.warn("JSON backup after reset failed", error));
    await refreshDatabaseDiagnostics().catch(() => {});
    await checkNormalizedTablesAgainstCurrentState({ force: true, reason: "admin-action" }).catch(() => {});
    setDefaultDates();
    setActiveView("log");
    if (els.authMessage) els.authMessage.textContent = "Production activity reset complete. You are ready to enter real bookings, trips, and fuel logs.";
  } catch (error) {
    console.error("Production activity reset failed", error);
    showUserError(`Production reset failed: ${error.message || error}`);
  } finally {
    els.productionActivityReset.disabled = false;
    render();
  }
}










function shortId(value) {
  const text = String(value || "");
  return text.length > 8 ? `${text.slice(0, 8)}...` : text || "none";
}

function buildSystemHealthChecks(ledger) {
  const checks = [];
  const profiles = getMemberNames().map(getMemberProfile);
  const membersWithoutEmail = profiles.filter((profile) => !profile.email);
  const nonAdminProfiles = profiles.filter((profile) => profile.role !== "admin");
  const adminProfiles = profiles.filter((profile) => profile.role === "admin");
  const fuelWithMissingLiters = state.fuel.filter((fuel) => Number(fuel.amount || 0) >= 300 && !Number(fuel.liters || 0));
  const suspiciousPriceLogs = state.fuel.filter((fuel) => {
    const amount = Number(fuel.amount || 0);
    const liters = Number(fuel.liters || 0);
    if (!amount || !liters) return false;
    const price = amount / liters;
    return isFuelPriceOutsideWarningRange(price);
  });
  const unusualTrips = state.trips.filter((trip) => {
    const km = Number(trip.endKm || 0) - Number(trip.startKm || 0);
    return km <= 0 || km > 1500;
  });
  const openFuelWarnings = getFuelValidationWarnings(ledger);
  const currentPeriodHasData = state.trips.length > 0 || state.fuel.length > 0;
  const pushSubscriptionHint = pushEnabled
    ? "Push notifications are enabled on this device."
    : pushSupported
      ? "Push is supported, but not enabled on this device yet."
      : "Push is not enabled or not supported on this device/browser.";

  checks.push({
    level: currentSession ? "ok" : "issue",
    title: "Authentication",
    message: currentSession ? `Signed in as ${getLoggedInEmail()}.` : "Nobody is signed in, so changes cannot be saved to cloud."
  });

  const syncStatus = els.syncStatus?.dataset.status || "";
  const hasHealthyDatabaseSync = hasRecentHealthyCloudSync(Date.now(), 24 * 60 * 60 * 1000);
  const databaseSaveOk = ["cloud", "tables", "shared"].includes(syncStatus) || (normalizedReadModeActive && hasHealthyDatabaseSync && !lastSyncError);
  checks.push({
    level: databaseSaveOk ? "ok" : (syncStatus === "saving" || syncStatus === "syncing" || hasHealthyDatabaseSync ? "warning" : "issue"),
    title: normalizedReadModeActive ? "Database tables" : "Database saving",
    message: normalizedReadModeActive
      ? (lastCloudSyncAt
        ? `Latest normalized-table sync: ${new Date(lastCloudSyncAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}. JSON is only a manual/periodic backup snapshot, so an older JSON backup timestamp is not a primary database failure.`
        : "Normalized tables are the primary save target. No confirmed table sync timestamp is available yet in this session.")
      : lastCloudSaveAt
        ? `Last cloud JSON save: ${new Date(lastCloudSaveAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.`
        : lastSyncError
          ? `Last save/load error: ${lastSyncError}.`
          : "No confirmed database save yet in this session."
  });

  checks.push({
    level: adminProfiles.length ? "ok" : "issue",
    title: "Admin users",
    message: adminProfiles.length
      ? `${adminProfiles.map((profile) => profile.name).join(", ")} can manage settings and data tools.`
      : "No admin user is configured. Add one in Group settings."
  });

  checks.push({
    level: membersWithoutEmail.length ? "warning" : "ok",
    title: "People with email",
    message: membersWithoutEmail.length
      ? `${membersWithoutEmail.map((profile) => profile.name).join(", ")} ${membersWithoutEmail.length === 1 ? "has" : "have"} no email attached.`
      : `${nonAdminProfiles.length + adminProfiles.length} people have email/profile data configured.`
  });

  checks.push({
    level: fuelWithMissingLiters.length ? "warning" : "ok",
    title: "Fuel logs with liters",
    message: fuelWithMissingLiters.length
      ? `${fuelWithMissingLiters.length} current fuel payment${fuelWithMissingLiters.length === 1 ? "" : "s"} over 300 DKK ${fuelWithMissingLiters.length === 1 ? "is" : "are"} missing liters.`
      : "Current fuel logs have liters where it matters, or there are no large fuel logs missing liters."
  });

  checks.push({
    level: suspiciousPriceLogs.length ? "warning" : "ok",
    title: "Receipt price checks",
    message: suspiciousPriceLogs.length
      ? `${suspiciousPriceLogs.length} fuel log${suspiciousPriceLogs.length === 1 ? "" : "s"} have unusual DKK/L values for the configured range. Check amount, liters, or Group settings.`
      : "No current fuel logs have suspicious DKK/L values."
  });

  checks.push({
    level: unusualTrips.length ? "warning" : "ok",
    title: "Trip distance checks",
    message: unusualTrips.length
      ? `${unusualTrips.length} trip${unusualTrips.length === 1 ? "" : "s"} look unusual. Check odometer values and very long test trips.`
      : "Current trip distances look plausible."
  });

  checks.push({
    level: openFuelWarnings.length ? "warning" : "ok",
    title: "Open settlement fuel sanity",
    message: openFuelWarnings.length
      ? `${openFuelWarnings.length} fuel sanity warning${openFuelWarnings.length === 1 ? "" : "s"} in the current period. Review before requesting settlement.`
      : currentPeriodHasData
        ? "Current period fuel amount looks plausible against distance and settings."
        : "No current trips or fuel payments to validate."
  });

  checks.push({
    level: pushEnabled ? "ok" : (pushSupported ? "warning" : "warning"),
    title: "Push notifications on this device",
    message: pushSubscriptionHint
  });

  const bookingDiagnostics = getBookingDiagnostics();
  checks.push({
    level: bookingDiagnostics.invalid.length ? "issue" : "ok",
    title: "Booking date integrity",
    message: bookingDiagnostics.invalid.length
      ? `${bookingDiagnostics.invalid.length} booking${bookingDiagnostics.invalid.length === 1 ? "" : "s"} have missing or invalid start/end times.`
      : "All booking start/end times can be read."
  });
  checks.push({
    level: bookingDiagnostics.overlaps.length ? "issue" : "ok",
    title: "Booking overlaps",
    message: bookingDiagnostics.overlaps.length
      ? `${bookingDiagnostics.overlaps.length} overlapping booking pair${bookingDiagnostics.overlaps.length === 1 ? "" : "s"} found locally.`
      : "No overlapping bookings found in the local booking list."
  });
  checks.push({
    level: bookingDiagnostics.upcoming ? "ok" : "warning",
    title: "Upcoming car bookings",
    message: bookingDiagnostics.upcoming
      ? `${bookingDiagnostics.upcoming} upcoming or active booking${bookingDiagnostics.upcoming === 1 ? "" : "s"} are visible.`
      : "No upcoming bookings are currently visible."
  });

  if (normalizedTableStatus.details && normalizedTableStatus.details.length) {
    normalizedTableStatus.details.forEach((detail) => checks.push(detail));
  } else {
    checks.push({
      level: normalizedTableStatus.checked ? (normalizedTableStatus.ok ? "ok" : "warning") : "warning",
      title: "Normalized database tables",
      message: normalizedTableStatus.message
    });
  }

  checks.push({
    level: state.closedPeriods.length ? "ok" : "warning",
    title: "Archive history",
    message: state.closedPeriods.length
      ? `${state.closedPeriods.length} closed settlement period${state.closedPeriods.length === 1 ? "" : "s"} archived.`
      : "No closed periods yet. Close periods regularly to keep settlements clean."
  });

  return checks;
}

function getBookingDiagnostics() {
  const bookings = Array.isArray(state.bookings) ? state.bookings : [];
  const invalid = bookings.filter((booking) => !Number.isFinite(bookingStartMs(booking)) || !Number.isFinite(bookingEndMs(booking)) || bookingEndMs(booking) <= bookingStartMs(booking));
  const validBookings = bookings.filter((booking) => !invalid.includes(booking));
  const overlaps = [];
  validBookings.forEach((booking, index) => {
    validBookings.slice(index + 1).forEach((other) => {
      if (bookingStartMs(booking) < bookingEndMs(other) && bookingEndMs(booking) > bookingStartMs(other)) {
        overlaps.push([booking, other]);
      }
    });
  });
  return {
    invalid,
    overlaps,
    upcoming: bookings.filter((booking) => bookingEndMs(booking) >= Date.now()).length
  };
}

function healthLevelLabel(level) {
  if (level === "issue") return "Fix";
  if (level === "warning") return "Check";
  return "OK";
}

function renderClosedPeriods() {
  if (!els.periodList) return;
  const periods = getFilteredClosedPeriods();
  renderClosedPeriodArchiveSummary(periods);

  if (state.closedPeriods.length === 0) {
    els.periodList.replaceChildren(emptyNode("No closed periods yet."));
    return;
  }

  if (getClosedPeriodsVisibleToCurrentUser().length === 0) {
    els.periodList.replaceChildren(emptyNode("No closed periods involve you yet."));
    return;
  }

  if (periods.length === 0) {
    els.periodList.replaceChildren(emptyNode("No closed periods match the current search or filter."));
    return;
  }

  els.periodList.innerHTML = periods
    .map((period) => renderClosedPeriodCard(period))
    .join("");
}

function memberNameKey(value) {
  return String(value || "").trim().toLowerCase();
}

function currentMemberNameForVisibility() {
  return getCurrentMemberProfile()?.name || currentUser || "";
}

function tripInvolvesMember(trip, memberName) {
  const key = memberNameKey(memberName);
  if (!key || !trip) return false;
  if (memberNameKey(trip.driver) === key) return true;
  return getTripParticipants(trip).some((participant) => memberNameKey(participant) === key);
}

function closedPeriodInvolvesCurrentMember(period) {
  if (canManageSettings()) return true;
  const memberName = currentMemberNameForVisibility();
  const key = memberNameKey(memberName);
  if (!key || !period) return false;

  const trips = Array.isArray(period.trips) ? period.trips : [];
  if (trips.some((trip) => tripInvolvesMember(trip, memberName))) return true;

  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  if (fuel.some((item) => memberNameKey(item.payer) === key)) return true;

  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  if (settlements.some((settlement) => memberNameKey(settlement.from) === key || memberNameKey(settlement.to) === key)) return true;

  const people = Array.isArray(period.people) ? period.people : [];
  return people.some((person) => {
    if (memberNameKey(person.name || person.person) !== key) return false;
    return Number(person.km || 0) > 0 || Number(person.fuelPaid || 0) > 0 || Number(person.fuelShare || 0) > 0;
  });
}

function getClosedPeriodsVisibleToCurrentUser() {
  const periods = Array.isArray(state.closedPeriods) ? state.closedPeriods : [];
  return periods.filter((period) => closedPeriodInvolvesCurrentMember(period));
}

function getFilteredClosedPeriods() {
  const query = String(closedPeriodFilters.query || "").trim().toLowerCase();
  const statusFilter = closedPeriodFilters.status || "all";
  const periods = getClosedPeriodsVisibleToCurrentUser().filter((period) => {
    if (statusFilter !== "all" && !closedPeriodHasSettlementStatus(period, statusFilter)) return false;
    if (!query) return true;
    return closedPeriodSearchText(period).includes(query);
  });

  periods.sort((a, b) => {
    if (closedPeriodFilters.sort === "oldest") {
      return closedPeriodTimestamp(a) - closedPeriodTimestamp(b);
    }
    if (closedPeriodFilters.sort === "fuel-desc") {
      return closedPeriodFuelTotal(b) - closedPeriodFuelTotal(a);
    }
    if (closedPeriodFilters.sort === "trips-desc") {
      return closedPeriodTripCount(b) - closedPeriodTripCount(a);
    }
    return closedPeriodTimestamp(b) - closedPeriodTimestamp(a);
  });

  return periods;
}

function renderClosedPeriodArchiveSummary(periods) {
  if (!els.periodArchiveSummary) return;
  const total = getClosedPeriodsVisibleToCurrentUser().length;
  const visible = periods.length;
  const fuelTotal = periods.reduce((sum, period) => sum + closedPeriodFuelTotal(period), 0);
  const tripCount = periods.reduce((sum, period) => sum + closedPeriodTripCount(period), 0);
  const paymentCount = periods.reduce((sum, period) => sum + (Array.isArray(period.settlements) ? period.settlements.length : 0), 0);
  const currency = periods[0]?.currency || state.currency;
  els.periodArchiveSummary.textContent = total === 0
    ? "No completed settlement periods yet."
    : `Showing ${visible} of ${total} completed period${total === 1 ? "" : "s"} · ${tripCount} trip${tripCount === 1 ? "" : "s"} · ${formatMoneyFor(fuelTotal, currency)} fuel · ${paymentCount} payment${paymentCount === 1 ? "" : "s"}`;
}

function closedPeriodTimestamp(period) {
  const value = Date.parse(period.closedAt || period.createdAt || "");
  return Number.isNaN(value) ? 0 : value;
}

function closedPeriodFuelTotal(period) {
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  return Number(period.totalPaid || fuel.reduce((sum, item) => sum + Number(item.amount || 0), 0));
}

function closedPeriodTripCount(period) {
  return Array.isArray(period.trips) ? period.trips.length : 0;
}

function closedPeriodHasSettlementStatus(period, status) {
  return (Array.isArray(period.settlements) ? period.settlements : []).some((settlement) => normalizePaymentStatus(settlement.status) === status);
}

function closedPeriodSearchText(period) {
  const parts = [
    period.label,
    period.closedAt,
    period.currency,
    ...(Array.isArray(period.people) ? period.people.map((person) => person.name || person.person || "") : []),
    ...(Array.isArray(period.trips) ? period.trips.flatMap((trip) => [trip.driver, trip.note, ...(Array.isArray(trip.participants) ? trip.participants : [])]) : []),
    ...(Array.isArray(period.fuel) ? period.fuel.flatMap((fuel) => [fuel.payer, fuel.station, fuel.note]) : []),
    ...(Array.isArray(period.settlements) ? period.settlements.flatMap((settlement) => [settlement.from, settlement.to, settlement.status]) : []),
    ...auditLog.normalizeAuditEntries(period.auditLog).flatMap((entry) => [entry.type, entry.summary, entry.actor, entry.detail])
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function renderClosedPeriodCard(period) {
  const currency = period.currency || state.currency;
  const trips = Array.isArray(period.trips) ? period.trips : [];
  const fuel = Array.isArray(period.fuel) ? period.fuel : [];
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  const people = Array.isArray(period.people) ? period.people : [];
  const paidSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "paid");
  const requestedSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "requested");
  const openSettlements = settlements.filter((settlement) => normalizePaymentStatus(settlement.status) === "open");
  const paidAmount = paidSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const requestedAmount = requestedSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const openAmount = openSettlements.reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  const totalLiters = fuel.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const totalFuelPaid = Number(period.totalPaid || fuel.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const totalTripKm = Number(period.totalTripKm || trips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
  const participantKm = Number(period.totalKm || 0);
  const closedDate = period.closedAt ? formatDate(String(period.closedAt).slice(0, 10)) : "Unknown date";

  const isExpanded = expandedClosedPeriodIds.has(period.id);
  const lazyAttribute = isExpanded ? "" : ' data-lazy-closed-period="true"';
  const expandedDetails = isExpanded ? `
      <div class="archive-actions button-row compact-actions">
        <button class="subtle-button compact-button" type="button" data-archive-csv="${escapeHtml(period.id)}">Export CSV</button>
        <button class="subtle-button compact-button" type="button" data-archive-audit-csv="${escapeHtml(period.id)}">Export change log CSV</button>
      </div>

      <div class="period-stats archive-period-stats">
        <div><span>Trip km</span><b>${formatNumber(totalTripKm)} km</b></div>
        <div><span>Participant km</span><b>${formatNumber(participantKm)} km</b></div>
        <div><span>Fuel rate</span><b>${formatMoneyFor(period.fuelRate || 0, currency)}/km</b></div>
        <div><span>Fuel paid</span><b>${formatMoneyFor(totalFuelPaid, currency)}</b></div>
        <div><span>Liters</span><b>${totalLiters > 0 ? `${formatNumber(totalLiters)} L` : "-"}</b></div>
        <div><span>Final payments</span><b>${settlements.length}</b></div>
      </div>

      <div class="archive-status-grid">
        <div class="archive-status-card paid"><span>Paid</span><b>${paidSettlements.length} · ${formatMoneyFor(paidAmount, currency)}</b></div>
        <div class="archive-status-card requested"><span>Requested</span><b>${requestedSettlements.length} · ${formatMoneyFor(requestedAmount, currency)}</b></div>
        <div class="archive-status-card open"><span>Open at close</span><b>${openSettlements.length} · ${formatMoneyFor(openAmount, currency)}</b></div>
      </div>

      <details class="archive-subsection" open>
        <summary>Final payments</summary>
        ${renderPeriodSettlements(period)}
      </details>

      <details class="archive-subsection">
        <summary>Activity by person</summary>
        ${renderClosedPeriodPeople(people, currency)}
      </details>

      <details class="archive-subsection">
        <summary>Trips (${trips.length})</summary>
        ${renderClosedPeriodTrips(trips)}
      </details>

      <details class="archive-subsection">
        <summary>Fuel logs (${fuel.length})</summary>
        ${renderClosedPeriodFuel(fuel, currency)}
      </details>

      <details class="archive-subsection">
        <summary>Change log (${auditLog.normalizeAuditEntries(period.auditLog).length})</summary>
        ${renderClosedPeriodAuditLog(period)}
      </details>
  ` : `
      <p class="entry-meta archive-lazy-note">Open this period to load final payments, trips, fuel logs, exports, and change log details.</p>
  `;

  return `
    <details class="period-card archived-period-card" data-period-id="${escapeHtml(period.id)}"${lazyAttribute} ${isExpanded ? "open" : ""}>
      <summary>
        <div>
          <strong>${escapeHtml(period.label || "Closed period")}</strong>
          <p>Closed ${closedDate} · ${trips.length} trip${trips.length === 1 ? "" : "s"} · ${fuel.length} fuel log${fuel.length === 1 ? "" : "s"}</p>
        </div>
        <span>${formatMoneyFor(totalFuelPaid, currency)} fuel</span>
      </summary>
      ${expandedDetails}
    </details>
  `;
}

function renderClosedPeriodAuditLog(period) {
  const entries = auditLog.normalizeAuditEntries(period.auditLog).slice(0, 60);
  if (!entries.length) {
    return `<p class="entry-meta">No change log was saved for this period.</p>`;
  }

  return `
    <div class="audit-entry-list archived-audit-list">
      ${entries.map((entry) => {
        const createdAt = new Date(entry.createdAt);
        const dateText = Number.isNaN(createdAt.getTime())
          ? entry.createdAt
          : `${createdAt.toLocaleDateString()} ${createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        return `
          <article class="entry-card audit-entry-card archived-audit-entry">
            <header>
              <div>
                <strong>${escapeHtml(auditLog.actionLabel(entry.type))}</strong>
                <p>${escapeHtml(entry.summary)}</p>
              </div>
              <span class="entry-meta">${escapeHtml(dateText)}</span>
            </header>
            <p class="entry-meta">By ${escapeHtml(entry.actor)}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ""}</p>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderPeriodSettlements(period) {
  const settlements = Array.isArray(period.settlements) ? period.settlements : [];
  if (settlements.length === 0) {
    return `<p class="entry-meta">No payments were needed.</p>`;
  }

  return `
    <div class="period-settlements archive-payment-list">
      ${settlements
        .map(
          (settlement, index) => {
            const status = normalizePaymentStatus(settlement.status);
            const canMarkPaid = status === "requested" && canMarkSettlementPaid(settlement);
            const amountText = formatMoneyFor(settlement.amount, period.currency || state.currency);
            const paymentRef = createPaymentRef({
              scope: "closed",
              key: settlementKeyForPeriod(settlement, period.id || "closed"),
              from: settlement.from,
              to: settlement.to,
              amount: settlement.amount
            });
            const statusNote = status === "paid"
              ? `Paid after settlement close. Amounts remain frozen.`
              : status === "requested"
                ? `Waiting for payment. The settlement amount is frozen, but the status can still be updated here.`
                : `Not requested when this period was closed.`;
            const permissionNote = `Only ${settlement.from} or an admin can mark this closed-period payment paid.`;
            return `
            <article class="archive-payment-card ${status}" data-payment-ref="${escapeHtml(normalizePaymentRefValue(paymentRef))}">
              <div class="archive-payment-header">
                <div class="archive-payment-main">
                  <div class="archive-payment-kicker">
                    <span class="log-ref payment-ref">${escapeHtml(formatPaymentRef(paymentRef))}</span>
                    <span class="status-chip ${status}">${statusLabel(status)}</span>
                  </div>
                  <div class="archive-payment-route" aria-label="${escapeHtml(`${settlement.from} pays ${settlement.to}`)}">
                    <span class="archive-payment-person">${escapeHtml(settlement.from)}</span>
                    <span class="archive-payment-direction">pays</span>
                    <span class="archive-payment-person">${escapeHtml(settlement.to)}</span>
                  </div>
                  <p>${escapeHtml(statusNote)}</p>
                  <p class="payment-evidence-line">${escapeHtml(renderPaymentEvidenceSummary(settlement, { trips: period.trips || [], fuel: period.fuel || [], currency: period.currency || state.currency, chargedKm: Number(optionalRecordValue(period?.ledger?.people, settlement.from)?.km || settlement?.km || 0) }))}</p>
                </div>
                <div class="archive-payment-amount">
                  <b>${amountText}</b>
                </div>
              </div>
              <details class="settlement-details archive-payment-evidence">
                <summary>Linked trips & fuel evidence</summary>
                ${renderPaymentEvidenceDetails(settlement, { trips: period.trips || [], fuel: period.fuel || [], currency: period.currency || state.currency })}
              </details>
              ${canMarkPaid ? `
                <div class="archive-payment-action-row">
                  <button class="subtle-button compact-button archive-payment-button" type="button" data-closed-period-id="${escapeHtml(period.id)}" data-closed-settlement-index="${index}" data-closed-payment-status="paid">Mark paid</button>
                  <span class="request-note">Updates only this payment status and the closed-period change log.</span>
                </div>
              ` : ""}
              ${status === "requested" && !canMarkPaid ? `<p class="request-note archive-payment-permission-note">${escapeHtml(permissionNote)}</p>` : ""}
            </article>
          `;
          }
        )
        .join("")}
    </div>
  `;
}

function renderClosedPeriodPeople(people, currency) {
  if (!Array.isArray(people) || people.length === 0) {
    return `<p class="entry-meta">No per-person activity was saved for this period.</p>`;
  }

  return `
    <div class="archive-table-wrap">
      <table class="activity-table archive-activity-table">
        <thead><tr><th>Person</th><th>Distance share</th><th>Fuel share</th><th>Fuel paid</th></tr></thead>
        <tbody>
          ${people.map((person) => `
            <tr>
              <td><strong>${escapeHtml(person.name)}</strong></td>
              <td>${formatNumber(person.km || 0)} km</td>
              <td>${formatMoneyFor(person.fuelShare || 0, currency)}</td>
              <td>${formatMoneyFor(person.fuelPaid || 0, currency)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderClosedPeriodTrips(trips) {
  if (!Array.isArray(trips) || trips.length === 0) {
    return `<p class="entry-meta">No trips saved in this period.</p>`;
  }
  const grouped = groupBy([...trips].sort(byNewest), (trip) => trip.driver || "Unknown");
  return Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([driver, items]) => {
      const km = items.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0);
      return `
        <details class="history-group archive-entry-group">
          <summary><strong>${escapeHtml(driver)}</strong><span>${items.length} trip${items.length === 1 ? "" : "s"} · ${formatNumber(km)} km</span></summary>
          <div class="entry-list grouped-entry-list">
            ${items.map((trip) => {
              const tripKm = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
              return `
                <article class="entry-card archive-entry-card archive-log-card">
                  <div class="archive-log-card-head">
                    <strong>${escapeHtml(trip.driver || "Unknown")}</strong>
                    ${trip.logRef ? `<span class="log-ref">${escapeHtml(formatTypedLogRef(trip, "trip"))}</span>` : ""}
                  </div>
                  <p>${formatNumber(tripKm)} km · ${getTripPeriodLabel(trip)} · ${formatNumber(trip.startKm || 0)} to ${formatNumber(trip.endKm || 0)} km</p>
                  <p class="entry-meta">Split between ${getTripParticipants(trip).map(escapeHtml).join(", ")}</p>
                  ${trip.note ? `<p>${escapeHtml(trip.note)}</p>` : ""}
                </article>
              `;
            }).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderClosedPeriodFuel(fuel, currency) {
  return window.FuelRendering.renderClosedPeriodFuel(fuel, currency, fuelRenderingDeps());
}

function getTripDateLimitForActiveContext() {
  const context = getActiveTripLogContext();
  const bookingEnd = context?.bookingEnd ? parseBookingDate(context.bookingEnd) : null;
  if (bookingEnd) return localDateString(bookingEnd);
  // Standalone trips can be corrected independently of the current calendar date.
  // Cross-period safety is enforced by explicit period and odometer validation.
  return "";
}

function syncTripDateBounds() {
  if (!els.tripDate) return;
  const maxDate = getTripDateLimitForActiveContext();
  if (maxDate) els.tripDate.max = maxDate;
  else els.tripDate.removeAttribute("max");
}

function setTripFormBookingContextDataset(context) {
  if (!els.tripForm) return;
  if (!context) {
    delete els.tripForm.dataset.sourceBookingId;
    delete els.tripForm.dataset.sourceBookingLogRef;
    delete els.tripForm.dataset.sourceBookingStart;
    delete els.tripForm.dataset.sourceBookingEnd;
    delete els.tripForm.dataset.sourceBookingParticipants;
    return;
  }
  els.tripForm.dataset.sourceBookingId = context.bookingId || "";
  els.tripForm.dataset.sourceBookingLogRef = context.logRef || "";
  els.tripForm.dataset.sourceBookingStart = context.bookingStart || "";
  els.tripForm.dataset.sourceBookingEnd = context.bookingEnd || "";
  els.tripForm.dataset.sourceBookingParticipants = JSON.stringify(normalizeBookingTripParticipants(context.plannedParticipants || []));
}

function getTripFormBookingContextDataset() {
  if (!els.tripForm?.dataset?.sourceBookingId) return null;
  return {
    bookingId: els.tripForm.dataset.sourceBookingId,
    logRef: els.tripForm.dataset.sourceBookingLogRef || "",
    bookingStart: els.tripForm.dataset.sourceBookingStart || null,
    bookingEnd: els.tripForm.dataset.sourceBookingEnd || null,
    plannedParticipants: parseTripFormBookingParticipantsDataset()
  };
}

function parseTripFormBookingParticipantsDataset() {
  if (!els.tripForm?.dataset?.sourceBookingParticipants) return [];
  try {
    const parsed = JSON.parse(els.tripForm.dataset.sourceBookingParticipants);
    return normalizeBookingTripParticipants(parsed);
  } catch (error) {
    return [];
  }
}

function normalizeBookingTripParticipants(participants = []) {
  return TripActions.normalizeTripParticipantSelection(getMemberNames(), participants, []);
}

function getSelectedTripParticipantsForSubmit(context = null) {
  const selected = getSelectedParticipants();
  const planned = normalizeBookingTripParticipants(context?.plannedParticipants || []);
  if (!planned.length) return selected;

  const members = getMemberNames();
  const selectedSet = new Set(selected);
  const plannedSet = new Set(planned);
  const selectedAllMembers = members.length > planned.length
    && selected.length === members.length
    && members.every((member) => selectedSet.has(member));
  const plannedDiffersFromAllMembers = members.some((member) => !plannedSet.has(member));

  // If a booking-planned trip form is re-rendered back to the default all-member
  // checkbox state before submit, keep the booking estimate's participant list.
  if (selectedAllMembers && plannedDiffersFromAllMembers) return planned;
  return selected;
}

function clearTripLoggingContext() {
  pendingTripBookingContext = null;
  setTripFormBookingContextDataset(null);
  syncTripDateBounds();
  renderTripBookingContext();
}

function clearFuelLoggingContext() {
  pendingFuelTripContext = null;
  syncFuelDateBounds();
  renderFuelTripContext();
}

function getFuelDateLimitForActiveContext() {
  return "";
}

function syncFuelDateBounds() {
  if (!els.fuelDate) return;
  // Fuel receipts can be corrected independently of the current calendar date
  // or booking end date. A previous build set a max date here, which blocked
  // fixing later-dated fuel logs discovered by Test Lab. Keep this field
  // unrestricted and rely on explicit odometer/period validation instead.
  els.fuelDate.removeAttribute("max");
}

function setDefaultDates() {
  const today = localDateString();
  syncTripDateBounds();
  syncFuelDateBounds();
  if (!pendingTripBookingContext && !editingTripId) {
    els.tripDate.value = today;
  } else if (!els.tripDate.value) {
    const context = getActiveTripLogContext();
    const bookingEnd = context?.bookingEnd ? parseBookingDate(context.bookingEnd) : null;
    els.tripDate.value = bookingEnd ? localDateString(bookingEnd) : today;
  }
  if (pendingFuelTripContext) {
    const bookingEnd = pendingFuelTripContext.bookingEnd ? parseBookingDate(pendingFuelTripContext.bookingEnd) : null;
    els.fuelDate.value = els.fuelDate.value || pendingFuelTripContext.date || (bookingEnd ? localDateString(bookingEnd) : today);
  } else if (!editingFuelId) {
    els.fuelDate.value = today;
  } else if (!els.fuelDate.value) {
    els.fuelDate.value = today;
  }
  setDefaultBookingTimes();
  syncStartOdometerDefault();
}

function setDefaultBookingTimes() {
  if (!els.bookingStart || !els.bookingEnd) return;
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  if (!els.bookingStart.value) els.bookingStart.value = toDateTimeLocalInputValue(now);
  if (!els.bookingEnd.value) els.bookingEnd.value = toDateTimeLocalInputValue(end);
}


function setBookingDateHint(dateKey) {
  if (!els.bookingStart || !els.bookingEnd || !dateKey) return;
  const start = parseBookingDate(els.bookingStart.value) || new Date();
  const end = parseBookingDate(els.bookingEnd.value) || new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const durationMs = Math.max(30 * 60 * 1000, end.getTime() - start.getTime());
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) return;
  start.setFullYear(year, month - 1, day);
  const nextEnd = new Date(start.getTime() + durationMs);
  els.bookingStart.value = toDateTimeLocalInputValue(start);
  els.bookingEnd.value = toDateTimeLocalInputValue(nextEnd);
  updateBookingAvailabilityPreview();
}

function startBookingFromCalendarDate(dateKey) {
  setBookingDateHint(dateKey);
  if (els.bookingPurpose && !els.bookingPurpose.value) els.bookingPurpose.focus();
  const panel = document.querySelector("#bookingPanel");
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
  showAppMessage("Booking form pre-filled from calendar. Adjust the time if needed, then add the booking.", "success");
}

function setBookingQuickDate(daysFromToday) {
  if (!els.bookingStart || !els.bookingEnd) return;
  const start = parseBookingDate(els.bookingStart.value) || new Date();
  const end = parseBookingDate(els.bookingEnd.value) || new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const target = new Date();
  target.setDate(target.getDate() + Math.max(0, Number(daysFromToday) || 0));
  const durationMs = Math.max(30 * 60 * 1000, end.getTime() - start.getTime());
  start.setFullYear(target.getFullYear(), target.getMonth(), target.getDate());
  const nextEnd = new Date(start.getTime() + durationMs);
  els.bookingStart.value = toDateTimeLocalInputValue(start);
  els.bookingEnd.value = toDateTimeLocalInputValue(nextEnd);
  updateBookingAvailabilityPreview();
}

function setBookingQuickWeekend() {
  if (!els.bookingStart || !els.bookingEnd) return;
  const start = parseBookingDate(els.bookingStart.value) || new Date();
  const today = new Date();
  const day = today.getDay();
  const daysUntilSaturday = (6 - day + 7) % 7 || 7;
  const saturday = new Date(today);
  saturday.setDate(today.getDate() + daysUntilSaturday);
  start.setFullYear(saturday.getFullYear(), saturday.getMonth(), saturday.getDate());
  start.setHours(9, 0, 0, 0);
  els.bookingStart.value = toDateTimeLocalInputValue(start);
  els.bookingEnd.value = toDateTimeLocalInputValue(new Date(start.getTime() + 4 * 60 * 60 * 1000));
  updateBookingAvailabilityPreview();
}

function setBookingDuration(hours) {
  if (!els.bookingStart || !els.bookingEnd) return;
  const start = parseBookingDate(els.bookingStart.value) || new Date();
  const durationHours = Math.max(0.5, Number(hours) || 2);
  els.bookingStart.value = toDateTimeLocalInputValue(start);
  els.bookingEnd.value = toDateTimeLocalInputValue(new Date(start.getTime() + durationHours * 60 * 60 * 1000));
  updateBookingAvailabilityPreview();
}

function setBookingAllDay() {
  if (!els.bookingStart || !els.bookingEnd) return;
  const start = parseBookingDate(els.bookingStart.value) || new Date();
  start.setHours(8, 0, 0, 0);
  const end = new Date(start);
  end.setHours(22, 0, 0, 0);
  els.bookingStart.value = toDateTimeLocalInputValue(start);
  els.bookingEnd.value = toDateTimeLocalInputValue(end);
  updateBookingAvailabilityPreview();
}

function getBookingDraftFromForm() {
  if (!els.bookingMember || !els.bookingStart || !els.bookingEnd) return null;
  return {
    id: editingBookingId || "__draft__",
    member: els.bookingMember.value,
    start: normalizeBookingDateTime(els.bookingStart.value),
    end: normalizeBookingDateTime(els.bookingEnd.value),
    purpose: els.bookingPurpose?.value?.trim() || ""
  };
}

function updateBookingAvailabilityPreview() {
  renderBookingAvailabilityPreview(getBookingDraftFromForm(), editingBookingId);
}

function getSelectedParticipants() {
  return Array.from(els.tripParticipants.querySelectorAll("input:checked")).map((input) => input.value);
}

function getMemberNames() {
  return Array.isArray(state.members) ? state.members : [];
}

function normalizeMembers(members) {
  if (!Array.isArray(members) || members.length === 0) return structuredClone(defaults.members);
  return members
    .map((member) => (typeof member === "string" ? member : member?.name))
    .map((member) => String(member || "").trim())
    .filter(Boolean);
}

function normalizeMemberProfiles(members, profiles) {
  const names = normalizeMembers(members);
  const sourceProfiles = profiles && typeof profiles === "object" ? profiles : {};
  return Object.fromEntries(
    names.map((name, index) => {
      const inline = Array.isArray(members) ? members.find((member) => member?.name === name) : null;
      const saved = sourceProfiles[name] || inline || {};
      return [
        name,
        {
          email: normalizeEmail(saved.email || ""),
          role: saved.role === "admin" || (index === 0 && !profiles) ? "admin" : "member",
          mobilepayPhone: normalizePhone(saved.mobilepayPhone || saved.mobilepay_phone || "")
        }
      ];
    })
  );
}

function getMemberProfile(name) {
  const profile = optionalRecordValue(state.memberProfiles, name) || {};
  return { name, email: normalizeEmail(profile.email || ""), role: profile.role === "admin" ? "admin" : "member", mobilepayPhone: normalizePhone(profile.mobilepayPhone || profile.mobilepay_phone || "") };
}

function getLoggedInEmail() {
  return normalizeEmail(currentSession?.user?.email || "");
}

function getCurrentMemberProfile() {
  const email = getLoggedInEmail();
  if (!email) return null;

  if (supabaseClient && currentSession) {
    if (authBoundMemberProfile && authBoundMemberProfileLedgerId === getActiveLedgerId()) {
      return authBoundMemberProfile;
    }

    const linkedFallback = getAuthBoundMemberProfileFallback();
    if (linkedFallback) return linkedFallback;

    // In Supabase/workspace mode, local JSON member profiles are display/cache data only.
    // Do not let stale JSON assign the signed-in email to the first local admin while
    // the authoritative ledger_members/list_my_ledgers membership is still loading.
    return {
      name: inferAuthBoundMemberName(email),
      email,
      role: "member",
      mobilepayPhone: "",
      authBound: true,
      pendingInvite: true
    };
  }

  const match = getMemberNames()
    .map(getMemberProfile)
    .find((profile) => profile.email === email);
  if (match) return match;

  return null;
}

function canUseAppAsMember() {
  if (!supabaseClient) return true;
  return Boolean(currentSession && getCurrentMemberProfile());
}

function canManageSettings() {
  if (!supabaseClient) return true;
  if (!currentSession) return false;
  const profile = getCurrentMemberProfile();
  return Boolean(profile && !profile.pendingInvite && profile.role === "admin");
}

function isPrimaryConfiguredWorkspace() {
  return String(getActiveLedgerId() || "") === String(getConfiguredLedgerId() || "");
}

const configuredAppOwnerEmails = Object.freeze(["chrjohn94@gmail.com"]);

function getConfiguredAppOwnerEmails() {
  return configuredAppOwnerEmails
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

function getPrimaryAppOwnerEmail() {
  const firstMember = normalizeMembers(state.members)[0] || "";
  const profile = firstMember ? optionalRecordValue(state.memberProfiles, firstMember) || {} : {};
  const primaryMemberEmail = normalizeEmail(profile.email || "");
  return primaryMemberEmail || getConfiguredAppOwnerEmails()[0] || "";
}

function isSignedInPrimaryAppOwner() {
  if (!supabaseClient) return true;
  if (!currentSession || !isPrimaryConfiguredWorkspace()) return false;
  const signedInEmail = getLoggedInEmail();
  const ownerEmails = new Set([
    getPrimaryAppOwnerEmail(),
    ...getConfiguredAppOwnerEmails()
  ].map((email) => normalizeEmail(email)).filter(Boolean));
  return Boolean(signedInEmail && ownerEmails.has(signedInEmail));
}

function canUseGlobalAdminTools() {
  if (!canManageSettings()) return false;
  if (!supabaseClient) return true;
  return isSignedInPrimaryAppOwner();
}

function requireGlobalAdminToolsPermission(actionLabel = "admin tools") {
  if (canUseGlobalAdminTools()) return true;
  const ownerEmail = getPrimaryAppOwnerEmail();
  const ownerHint = ownerEmail ? ` Only the app owner (${ownerEmail}) can use owner diagnostics.` : " Configure the primary app owner email on the first member before using owner diagnostics.";
  const message = `This action is restricted to the Fuel Ledger app owner. Workspace admins can manage only their own workspace settings, members, and invites.${ownerHint}`;
  showUserError(message);
  if (typeof setDataToolsMessage === "function") setDataToolsMessage(`${actionLabel}: ${message}`);
  return false;
}

function canManageSettlementRequest(settlement) {
  if (!supabaseClient) return true;
  return permissionHelpers.canManageSettlementRequestForProfile(settlement, getCurrentMemberProfile());
}

function canMarkSettlementPaid(settlement) {
  if (!settlement) return false;
  if (!supabaseClient) return true;
  return permissionHelpers.canMarkSettlementPaidForProfile(settlement, getCurrentMemberProfile());
}

function noMemberEmailsConfigured() {
  return getMemberNames().every((name) => !getMemberProfile(name).email);
}


function ensureMemberForLoggedInUser() {
  if (supabaseClient) return false;
  const email = getLoggedInEmail();
  if (!email) return false;

  const existing = getMemberNames()
    .map(getMemberProfile)
    .find((profile) => profile.email === email);
  if (existing) return false;

  const names = getMemberNames();
  const inferredName = inferMemberNameFromEmail(email);

  let targetName = "";
  if (noMemberEmailsConfigured() && names[0]) {
    targetName = names[0];
  } else {
    targetName = findBestUnassignedMemberName(inferredName, email);
  }

  if (!targetName) {
    targetName = makeUniqueMemberName(inferredName || email.split("@")[0] || "New member");
    state.members.push(targetName);
  }

  const current = getMemberProfile(targetName);
  const role = noMemberEmailsConfigured() && targetName === names[0] ? "admin" : current.role;
  state.memberProfiles[targetName] = {
    ...current,
    email,
    role: role === "admin" ? "admin" : "member",
    mobilepayPhone: normalizePhone(current.mobilepayPhone || "")
  };
  currentUser = targetName;
  localStorage.setItem(userKey, currentUser);
  els.authMessage.textContent = `Signed in as ${targetName}.`;
  return true;
}

function inferMemberNameFromEmail(email) {
  const local = email.split("@")[0] || "";
  const clean = local
    .replace(/[+].*$/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .trim();

  if (!clean) return "New member";

  return clean
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function findBestUnassignedMemberName(inferredName, email) {
  const localFirst = normalizeEmail(email.split("@")[0].split(/[._-]/)[0] || "");
  const inferredFirst = normalizeEmail((inferredName || "").split(/\s+/)[0] || "");

  return getMemberNames().find((name) => {
    const profile = getMemberProfile(name);
    if (profile.email) return false;
    const normalizedName = normalizeEmail(name);
    return normalizedName === normalizeEmail(inferredName) || normalizedName === localFirst || normalizedName === inferredFirst;
  }) || "";
}

function makeUniqueMemberName(baseName) {
  const existing = new Set(getMemberNames().map((name) => normalizeEmail(name)));
  let candidate = baseName.trim() || "New member";
  let counter = 2;
  while (existing.has(normalizeEmail(candidate))) {
    candidate = `${baseName} ${counter}`;
    counter += 1;
  }
  return candidate;
}

function parseMemberSettings(value) {
  return value
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const name = parts[0];
      const email = normalizeEmail(parts.find((part, index) => index > 0 && part.includes("@")) || "");
      const role = parts.some((part) => part.toLowerCase() === "admin") ? "admin" : "member";
      return { name, email, role };
    })
    .filter((member) => member.name);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function loadState() {
  return await dataStore.loadLocalState({ storageKey: makeWorkspaceScopedStorageKey(), defaults, normalizeState });
}

function saveState(options = {}) {
  const { queueRemote = true, reason = "saveState" } = options || {};
  recordSupabaseLoadEvent("local-save", queueRemote ? "saveState queued a local change" : `${reason}; local state saved without queued browser full-state write`);
  state.updatedAt = new Date().toISOString();
  dataStore.saveLocalState({
    storageKey: makeWorkspaceScopedStorageKey(),
    state,
    afterSave: () => {
      if (!queueRemote) {
        recordSupabaseLoadEvent("browser-full-state-save-skip", reason || "explicit local-only save after Render backend write");
        return;
      }
      markLocalChangeQueued();
      queueRemoteSave();
    }
  });
}

function writeLocalState() {
  dataStore.writeLocalState({ storageKey: makeWorkspaceScopedStorageKey(), state });
}

function stateUpdatedMs(candidate) {
  const updated = Date.parse(candidate?.updatedAt || "");
  return Number.isFinite(updated) ? updated : 0;
}

function makeClientId() {
  return dataStore.makeClientId();
}

async function applyBackendPaymentAction(payload) {
  // Phase 2A: in server-backed/local mode, payment status changes and payment
  // reminder audit entries are applied by server.py in one state mutation.
  // Supabase mode still uses the existing table/RLS path until the same action
  // contract is implemented as Supabase RPCs.
  if (supabaseClient) return false;
  try {
    // A payment action may happen immediately after creating trips/fuel. Flush the
    // current browser state to server.py first, then cancel any older debounced
    // saves so they cannot overwrite the server-authoritative payment result.
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
    await saveRemoteState();
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();

    const response = await fetch(paymentActionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Payment action failed (${response.status})`);
    const result = await response.json();
    if (result?.state) {
      state = normalizeState(result.state);
      writeLocalState();
    }
    if (typeof queueRemoteSave.cancel === "function") queueRemoteSave.cancel();
    setSyncStatus("Shared");
    return true;
  } catch (error) {
    console.warn("Backend payment action failed; using client fallback", error);
    return false;
  }
}

function normalizeTripEntries(trips) {
  if (!Array.isArray(trips)) return [];

  return trips.map((trip) => ({
    ...trip,
    id: trip.id || makeClientId(),
    participants: Array.isArray(trip.participants) ? trip.participants : (trip.driver ? [trip.driver] : []),
    startKm: round(Number(trip.startKm || 0)),
    endKm: round(Number(trip.endKm || 0)),
    note: trip.note ? String(trip.note) : ""
  }));
}

function normalizeBookingEntries(bookings) {
  if (!Array.isArray(bookings)) return [];

  return bookings
    .map((booking) => ({
      ...booking,
      id: booking.id || makeClientId(),
      member: String(booking.member || booking.driver || "").trim(),
      start: normalizeBookingDateTime(booking.start || booking.startAt || ""),
      end: normalizeBookingDateTime(booking.end || booking.endAt || ""),
      purpose: booking.purpose ? String(booking.purpose) : "",
      createdBy: booking.createdBy ? String(booking.createdBy) : ""
    }))
    .filter((booking) => booking.member && booking.start && booking.end && Date.parse(booking.end) > Date.parse(booking.start));
}

function normalizeState(saved) {
  if (!saved) return structuredClone(defaults);

  return {
    ...structuredClone(defaults),
    ...saved,
    members: normalizeMembers(saved.members),
    memberProfiles: normalizeMemberProfiles(saved.members, saved.memberProfiles),
    trips: normalizeTripEntries(saved.trips),
    bookings: normalizeBookingEntries(saved.bookings),
    fuel: normalizeFuelEntries(saved.fuel),
    paymentStatuses: normalizePaymentStatuses(saved.paymentStatuses),
    auditLog: auditLog.normalizeAuditEntries(saved.auditLog),
    currentPeriodId: saved.currentPeriodId || "",
    closedPeriods: Array.isArray(saved.closedPeriods)
      ? saved.closedPeriods.map((period) => ({
          ...period,
          settlements: Array.isArray(period.settlements)
            ? period.settlements.map((settlement) => ({
                ...settlement,
                status: normalizePaymentStatus(settlement.status)
              }))
            : [],
          auditLog: auditLog.normalizeAuditEntries(period.auditLog)
        }))
      : [],
    testLabReports: normalizeTestLabReports(saved.testLabReports || saved.lastTestLabReport),
    lastOdometer: saved.lastOdometer ?? "",
    fuelType: getFuelTypeForState(saved),
    fuelConsumption: getFuelConsumptionForState(saved),
    fuelTankCapacity: Math.max(1, Number(saved.fuelTankCapacity) || defaults.fuelTankCapacity),
    fuelFallbackPrice: getFuelFallbackPriceForState(saved),
    fuelPriceWarningMinDkkPerLiter: getFuelPriceWarningRange(saved).minDkkPerLiter,
    fuelPriceWarningMaxDkkPerLiter: getFuelPriceWarningRange(saved).maxDkkPerLiter,
    fuelWarningThreshold: Number(saved.fuelWarningThreshold) || defaults.fuelWarningThreshold,
    paymentRemindersEnabled: saved.paymentRemindersEnabled !== false,
    paymentReminderAfterDays: Math.max(0, Number(saved.paymentReminderAfterDays ?? defaults.paymentReminderAfterDays)),
    paymentReminderRepeatDays: Math.max(1, Number(saved.paymentReminderRepeatDays || defaults.paymentReminderRepeatDays)),
    paymentReminderMaxCount: Math.max(1, Number(saved.paymentReminderMaxCount ?? defaults.paymentReminderMaxCount)),
    vehiclePlate: normalizeVehiclePlateInput(saved.vehiclePlate || saved.numberPlate || saved.licensePlate || ""),
    vehicleInfo: normalizeVehicleInfo(saved.vehicleInfo),
    vehicleLookupSource: saved.vehicleLookupSource || (saved.vehicleInfo ? "lookup" : "manual"),
    vehicleLookupAt: saved.vehicleLookupAt || "",
    carSettingsVersion: saved.carSettingsVersion || defaults.carSettingsVersion,
    updatedAt: saved.updatedAt || ""
  };
}

function normalizeFuelLocation(location) {
  if (!location || typeof location !== "object") return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function normalizeFuelEntries(fuelEntries) {
  if (!Array.isArray(fuelEntries)) return [];

  return fuelEntries.map((fuel) => {
    const amount = roundMoney(Number(fuel.amount || 0));
    const liters = Number(fuel.liters || 0) > 0 ? round(Number(fuel.liters || 0)) : "";
    return {
      ...fuel,
      id: fuel.id || makeClientId(),
      amount,
      liters,
      pricePerLiter: liters ? roundMoney(amount / liters) : (Number(fuel.pricePerLiter || 0) > 0 ? roundMoney(Number(fuel.pricePerLiter)) : ""),
      odometer: Number(fuel.odometer || 0) > 0 ? round(Number(fuel.odometer || 0)) : "",
      station: fuel.station ? String(fuel.station).trim() : "",
      locationPrivacyMode: window.FuelLocationPrivacy?.normalizeLocationPrivacyMode?.(fuel.locationPrivacyMode) || (fuel.location ? "full" : (fuel.stationInfo ? "station-only" : "no-coordinates")),
      location: normalizeFuelLocation(fuel.location),
      stationInfo: normalizeFuelLocation(fuel.stationInfo)
        ? {
            ...normalizeFuelLocation(fuel.stationInfo),
            name: fuel.stationInfo?.name ? String(fuel.stationInfo.name).trim() : (fuel.station ? String(fuel.station).trim() : ""),
            brand: fuel.stationInfo?.brand ? String(fuel.stationInfo.brand).trim() : ""
          }
        : null,
      fullTank: Boolean(fuel.fullTank)
    };
  });
}

function isOldDefaultFuelSetup(saved) {
  return (
    !saved.carSettingsVersion &&
    (!saved.fuelType || saved.fuelType === "95") &&
    (!saved.fuelConsumption || Number(saved.fuelConsumption) === 6) &&
    (!saved.fuelFallbackPrice || Number(saved.fuelFallbackPrice) === 16.5)
  );
}

function getFuelTypeForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelType;
  return saved.fuelType || defaults.fuelType;
}

function getFuelConsumptionForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelConsumption;
  return Number(saved.fuelConsumption) || defaults.fuelConsumption;
}

function getFuelFallbackPriceForState(saved) {
  if (isOldDefaultFuelSetup(saved)) return defaults.fuelFallbackPrice;
  return Number(saved.fuelFallbackPrice) || defaults.fuelFallbackPrice;
}


async function initializePwa() {
  pushSupported = notifications.isPushSupported();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updatePwaUi();
  });

  if ("serviceWorker" in navigator) {
    try {
      let serviceWorkerControllerChanged = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (serviceWorkerControllerChanged) return;
        serviceWorkerControllerChanged = true;
        recordSyncDiagnostic("service-worker-controllerchange", "App update activated; reloading once so page files and the service-worker cache use the same build.");
        recordSupabaseLoadEvent("service-worker-controllerchange", "Service-worker update activated; one controlled reload will complete the handoff.");
        if (!state.pendingLocalChanges && !hasForegroundWriteInFlight()) {
          window.setTimeout(() => window.location.reload(), 250);
        }
      });

      const registration = await navigator.serviceWorker.register("/service-worker.js");
      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            recordSyncDiagnostic("service-worker-update-ready", "New app shell is ready; activating it now and reloading once if no local changes are pending.");
            recordSupabaseLoadEvent("service-worker-update-ready", "Waiting service worker requested to activate immediately.");
            newWorker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      await registration.update();
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  await refreshPushState();
  updatePwaUi();
}

async function refreshPushState() {
  pushEnabled = await notifications.refreshPushState(pushSupported);
}

function updatePwaUi() {
  if (isStartupHydrating()) {
    if (els.pwaPanel) els.pwaPanel.classList.add("hidden");
    return;
  }
  notifications.updatePwaUi({
    els,
    currentSession,
    deferredInstallPrompt,
    pushSupported,
    pushEnabled
  });
}

async function enablePushNotifications() {
  const enabled = await notifications.enablePushNotifications({
    supabaseClient,
    pushSupported,
    pushConfigUrl,
    pushSubscriptionsUrl,
    setCurrentSession: (session) => { currentSession = session; },
    updateAuthUi,
    updatePwaUi,
    refreshPushState,
    showMessage: showAppMessage
  });
  pushEnabled = enabled || await notifications.refreshPushState(pushSupported);
  updatePwaUi();
}

async function sendSettlementPush(settlement, metadata = {}) {
  const paymentRef = normalizePaymentRefValue(metadata.paymentRef || createPaymentRef({ scope: "current", key: settlementKey(settlement || {}), from: settlement?.from, to: settlement?.to, amount: settlement?.amount }));
  return notifications.sendSettlementPush({
    supabaseClient,
    sendPushUrl,
    settlement,
    getMemberProfile,
    formatMoney,
    settlementKey,
    paymentRef: formatPaymentRef(paymentRef),
    paymentUrl: makePaymentDeepLink(paymentRef, { scope: "current" })
  });
}

async function sendBookingPush(booking) {
  if (!notifications.sendPushNotification || !supabaseClient || !booking) return { attempted: false, sent: 0, failed: 0, reason: "unavailable" };
  const loggedInEmail = getLoggedInEmail();
  const recipients = getMemberNames()
    .map(getMemberProfile)
    .filter((profile) => profile.email && profile.email !== loggedInEmail && profile.name !== booking.member);

  const bookingRef = formatTypedLogRef(booking, "booking");
  const results = await Promise.all(recipients.map((profile) => notifications.sendPushNotification({
    supabaseClient,
    sendPushUrl,
    targetEmail: profile.email,
    title: `Fuel Ledger booking ${bookingRef}`,
    body: `${bookingRef} · ${booking.member} booked the car: ${formatBookingRange(booking)}${booking.purpose ? ` · ${booking.purpose}` : ""}`,
    url: `${window.location.origin}/`,
    tag: `booking:${booking.id}:${profile.email}`
  })));

  return results.reduce((summary, result) => ({
    attempted: summary.attempted || result.attempted,
    sent: summary.sent + Number(result.sent || 0),
    failed: summary.failed + Number(result.failed || 0),
    reason: result.reason || summary.reason
  }), { attempted: false, sent: 0, failed: 0, reason: "" });
}


async function sendFuelFollowupPush(trip) {
  if (!notifications.sendPushNotification || !supabaseClient || !trip?.sourceBookingId) {
    return { attempted: false, sent: 0, failed: 0, reason: "unavailable" };
  }
  const profile = getMemberProfile(trip.driver);
  if (!profile.email) return { attempted: false, sent: 0, failed: 0, reason: "missing-driver-email" };
  const distance = Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0));
  const logRef = formatLogRef(trip);
  const displayLogRef = formatTypedLogRef(trip, "trip");
  return notifications.sendPushNotification({
    supabaseClient,
    sendPushUrl,
    targetEmail: profile.email,
    title: `Fuel log needed ${displayLogRef}`,
    body: `${displayLogRef} · ${formatNumber(distance)} km logged. Add the matching fuel receipt when ready.`,
    url: makeLogDeepLink(logRef),
    tag: `pending-fuel:${trip.id}`
  });
}

async function sendPaymentReminderPush(settlement, metadata = {}) {
  const paymentRef = normalizePaymentRefValue(metadata.paymentRef || createPaymentRef({ scope: "current", key: settlementKey(settlement || {}), from: settlement?.from, to: settlement?.to, amount: settlement?.amount }));
  return notifications.sendPaymentReminderPush({
    supabaseClient,
    sendPushUrl,
    settlement,
    getMemberProfile,
    formatMoney,
    settlementKey,
    paymentRef: formatPaymentRef(paymentRef),
    paymentUrl: metadata.url || makePaymentDeepLink(paymentRef, { scope: "current" })
  });
}

async function sendPaymentCloseNoticePush(settlement, metadata = {}) {
  if (!notifications.sendPushNotification || !supabaseClient || !settlement) {
    return { attempted: false, sent: 0, failed: 0, reason: "unavailable" };
  }
  const paymentRef = normalizePaymentRefValue(metadata.paymentRef || createPaymentRef({ scope: "current", key: settlementKey(settlement || {}), from: settlement?.from, to: settlement?.to, amount: settlement?.amount }));
  const profile = getMemberProfile(settlement.from);
  if (!profile.email) return { attempted: false, sent: 0, failed: 0, reason: "missing-payer-email" };
  return notifications.sendPushNotification({
    supabaseClient,
    sendPushUrl,
    targetEmail: profile.email,
    title: `Settlement closed, payment still unpaid ${formatPaymentRef(paymentRef)}`.trim(),
    body: `${formatPaymentRef(paymentRef)} · ${settlement.to} closed the settlement while ${formatMoney(settlement.amount)} is still requested from you.`,
    url: metadata.url || makePaymentDeepLink(paymentRef, { scope: "closed" }),
    tag: `${settlementKey(settlement)}:closed-unpaid:${paymentRef}`
  });
}



async function hasFreshSupabaseSession() {
  const session = await supabaseHelpers.getFreshSession(supabaseClient);
  if (!session) {
    currentSession = null;
    updateAuthUi();
    return false;
  }
  currentSession = session;
  return true;
}

async function getFreshRenderAccessToken() {
  if (!supabaseClient) return "";
  const session = await supabaseHelpers.getFreshSession(supabaseClient);
  if (!session?.access_token) {
    currentSession = null;
    updateAuthUi();
    return "";
  }
  currentSession = session;
  return session.access_token;
}

async function buildRenderRequestHeaders(extraHeaders = {}) {
  const accessToken = await getFreshRenderAccessToken();
  if (!accessToken) {
    const error = new Error("Sign in before calling the Render backend.");
    error.code = "AUTH_REQUIRED";
    error.resultCode = "AUTH_REQUIRED";
    throw error;
  }
  return {
    ...extraHeaders,
    "Authorization": `Bearer ${accessToken}`
  };
}

function createRenderApiTimeoutError(label, timeoutMs) {
  const error = paymentActionTimeoutError(label || "Render API", timeoutMs);
  error.code = error.code || "RENDER_API_TIMEOUT";
  error.resultCode = error.resultCode || error.code;
  return error;
}

async function callRenderJson(endpoint, options = {}) {
  if (typeof fetch !== "function") throw new Error("Render API calls require browser fetch support.");
  const method = options.method || "POST";
  const timeoutMs = Number(options.timeoutMs || 12000);
  const timeoutLabel = options.timeoutLabel || `Render API ${endpoint}`;
  const allowResultOkFalse = options.allowResultOkFalse === true;
  const setTimer = typeof window !== "undefined" && window.setTimeout ? window.setTimeout.bind(window) : setTimeout;
  const clearTimer = typeof window !== "undefined" && window.clearTimeout ? window.clearTimeout.bind(window) : clearTimeout;
  let controller = null;
  let timeoutId = 0;
  try {
    const requestAndReadPromise = (async () => {
      const headers = await buildRenderRequestHeaders({
        "Content-Type": "application/json",
        ...(options.headers || {})
      });
      controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const response = await fetch(endpoint, {
        method,
        signal: controller ? controller.signal : undefined,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      const text = await response.text();
      return { response, text };
    })();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimer(() => {
        if (controller) controller.abort();
        reject(createRenderApiTimeoutError(timeoutLabel, timeoutMs));
      }, timeoutMs);
    });
    const { response, text } = await Promise.race([requestAndReadPromise, timeoutPromise]);
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    if (!response.ok || (!allowResultOkFalse && !result?.ok)) {
      const message = result?.message || result?.error || text || `Render API call failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.code = result?.code || response.status;
      error.resultCode = result?.code || response.status;
      error.payload = result;
      throw error;
    }
    return { response, text, result };
  } catch (error) {
    if (error?.name === "AbortError") throw createRenderApiTimeoutError(timeoutLabel, timeoutMs);
    throw error;
  } finally {
    if (timeoutId) clearTimer(timeoutId);
  }
}

function isRenderAuthRejected(response, result, text) {
  if (response?.status === 401) return true;
  const message = String(result?.message || result?.error || text || "");
  return /sign in before|auth session not ready|missing bearer token/i.test(message);
}

function buildSettingsSavePayload() {
  const ledgerId = getActiveLedgerId();
  const now = new Date().toISOString();
  const members = getMemberNames().map((name) => {
    const profile = getMemberProfile(name);
    return {
      name,
      email: profile.email || "",
      role: profile.role === "admin" ? "admin" : "member",
      mobilepayPhone: normalizePhone(profile.mobilepayPhone || profile.mobilepay_phone || "")
    };
  });
  return {
    ledgerId,
    settings: {
      currency: state.currency || defaults.currency,
      fuelType: state.fuelType || defaults.fuelType,
      fuelConsumption: Number(state.fuelConsumption) || defaults.fuelConsumption,
      fuelTankCapacity: getFuelTankCapacity(),
      fuelFallbackPrice: Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice,
      fuelWarningThreshold: Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold,
      vehiclePlate: normalizeVehiclePlateInput(state.vehiclePlate || ""),
      vehicleInfo: normalizeVehicleInfo(state.vehicleInfo),
      vehicleLookupSource: state.vehicleLookupSource || (state.vehicleInfo ? "lookup" : "manual"),
      vehicleLookupAt: state.vehicleLookupAt || "",
      paymentRemindersEnabled: state.paymentRemindersEnabled !== false,
      paymentReminderAfterDays: Number(state.paymentReminderAfterDays ?? defaults.paymentReminderAfterDays),
      paymentReminderRepeatDays: Number(state.paymentReminderRepeatDays || defaults.paymentReminderRepeatDays),
      paymentReminderMaxCount: Number(state.paymentReminderMaxCount ?? defaults.paymentReminderMaxCount),
      updatedAt: now
    },
    members
  };
}

function formatSettingsPersistedSummary(persisted = {}) {
  const parts = [];
  parts.push(`fuel=${persisted.fuelType ? "yes" : "no"}`);
  parts.push(`tank=${persisted.fuelTankCapacity ? "yes" : "no"}`);
  parts.push(`consumption=${persisted.fuelConsumption ? "yes" : "no"}`);
  parts.push(`plate=${persisted.vehiclePlate ? "yes" : "no"}`);
  parts.push(`vehicleInfo=${persisted.vehicleInfo ? "yes" : "no"}`);
  return parts.join(", ");
}

function formatSettingsSavedConfirmation(result = {}) {
  const saved = result?.settings || {};
  const persisted = result?.persisted || {};
  const plate = normalizeVehiclePlateInput(saved.vehiclePlate || saved.vehicleInfo?.plate || "");
  const vehicleLabel = saved.vehicleInfo?.summary || [saved.vehicleInfo?.make, saved.vehicleInfo?.model].filter(Boolean).join(" ").trim();
  if (persisted.vehicleInfo && plate && vehicleLabel) {
    return `Settings saved. Vehicle info for ${plate} (${vehicleLabel}) is saved.`;
  }
  if (persisted.vehicleInfo && plate) {
    return `Settings saved. Vehicle info for ${plate} is saved.`;
  }
  if (persisted.vehiclePlate && plate) {
    return `Settings saved. Vehicle plate ${plate} is saved.`;
  }
  return "Settings saved.";
}

function assertSettingsSaveVerified(result, payload) {
  if (!result?.verified) {
    throw new Error("Settings save did not return backend verification.");
  }
  const requested = payload?.settings || {};
  const saved = result?.settings || {};
  const requestedPlate = normalizeVehiclePlateInput(requested.vehiclePlate || requested.vehicleInfo?.plate || "");
  const savedPlate = normalizeVehiclePlateInput(saved.vehiclePlate || saved.vehicleInfo?.plate || "");
  if (requestedPlate && savedPlate !== requestedPlate) {
    throw new Error("Settings save verification failed: vehicle plate was not returned by the backend.");
  }
  if (requested.vehicleInfo && Object.keys(requested.vehicleInfo).length && !result?.persisted?.vehicleInfo) {
    throw new Error("Settings save verification failed: vehicle details were not persisted. Apply Supabase migration 038_vehicle_settings_columns.sql.");
  }
}

function applySavedSettingsResult(result) {
  const saved = result?.settings || {};
  if (saved.currency) state.currency = saved.currency;
  if (saved.fuelType) state.fuelType = saved.fuelType;
  if (Number(saved.fuelConsumption) > 0) state.fuelConsumption = Number(saved.fuelConsumption);
  if (Number(saved.fuelTankCapacity) > 0) state.fuelTankCapacity = Number(saved.fuelTankCapacity);
  if (Number(saved.fuelFallbackPrice) > 0) state.fuelFallbackPrice = Number(saved.fuelFallbackPrice);
  if (Number(saved.fuelWarningThreshold) > 0) state.fuelWarningThreshold = Number(saved.fuelWarningThreshold);
  state.vehiclePlate = normalizeVehiclePlateInput(saved.vehiclePlate || state.vehiclePlate || "");
  state.vehicleInfo = normalizeVehicleInfo(saved.vehicleInfo || state.vehicleInfo);
  state.vehicleLookupSource = saved.vehicleLookupSource || state.vehicleLookupSource || (state.vehicleInfo ? "lookup" : "manual");
  state.vehicleLookupAt = saved.vehicleLookupAt || state.vehicleLookupAt || "";
  state.updatedAt = saved.updatedAt || new Date().toISOString();
}

async function saveSettingsViaRender({ traceMeta } = {}) {
  if (typeof fetch !== "function") throw new Error("Render settings save requires browser fetch support.");
  const payload = buildSettingsSavePayload();
  try {
    const { result: apiResult } = await callRenderJson(renderSettingsSaveUrl, {
      method: "POST",
      body: payload,
      timeoutMs: 12000,
      timeoutLabel: "Render settings save API"
    });
    const verifiedResult = apiResult?.result && typeof apiResult.result === "object"
      ? { ...apiResult.result, settings: apiResult.settings || apiResult.result.settings }
      : apiResult;
    assertSettingsSaveVerified(verifiedResult, payload);
    applySavedSettingsResult(verifiedResult);
    saveState({ queueRemote: false, reason: "backend settings save confirmed" });
    return verifiedResult;
  } catch (error) {
    if (error?.code === "RENDER_API_TIMEOUT") {
      error.code = "SETTINGS_SAVE_TIMEOUT";
      error.resultCode = "SETTINGS_SAVE_TIMEOUT";
    }
    throw error;
  }
}

async function ensureOpenSettlementPeriod(ledgerId) {
  return supabaseHelpers.ensureOpenSettlementPeriod(supabaseClient, ledgerId);
}

async function getNormalizedWriteContext(options = {}) {
  if (!supabaseClient || !currentSession) return null;
  if (!(await hasFreshSupabaseSession())) return null;

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const source = options.source || "normalized-write-context";
  const renderContext = await getRenderWriteContext({ ledgerId, source });
  if (renderContext) return renderContext;

  const syncDirectory = options.syncDirectory !== false;

  // Important: regular members are allowed to write trips, fuel, and settlement
  // request rows, but they are not allowed to update ledger settings or the
  // member directory. Do not upsert ledgers/ledger_members here for every save,
  // otherwise non-admin trip/fuel saves fail before reaching the table they are
  // actually allowed to write. Settlement/payment status saves also skip this
  // directory reconciliation so a payment action never touches ledgers while
  // saving settlement_requests.
  if (syncDirectory && canManageSettings()) {
    await syncLedgerDirectoryForAdmin(ledgerId);
  } else {
    recordDataIoDiagnostic("skip", {
      source,
      route: "direct-table",
      table: "ledgers",
      operation: "upsert",
      ok: true,
      detail: syncDirectory ? "Skipped ledger directory sync because current user cannot manage settings." : "Skipped ledger directory sync for this write source."
    });
  }

  const membersResult = await traceDataIo({ source, route: "direct-table", table: "ledger_members", operation: "select" }, () => supabaseClient
    .from("ledger_members")
    .select("id,name,email")
    .eq("ledger_id", ledgerId)
    .eq("is_active", true));
  if (membersResult.error) throw membersResult.error;

  const members = membersResult.data || [];
  const memberIdsByName = Object.fromEntries(members.map((member) => [member.name, member.id]));
  const currentEmail = String(currentSession?.user?.email || "").toLowerCase();
  const currentMemberId = members.find((member) => String(member.email || "").toLowerCase() === currentEmail)?.id || null;

  const openPeriodId = await ensureOpenSettlementPeriod(ledgerId);

  return { ledgerId, openPeriodId, memberIdsByName, currentMemberId };
}


async function getRenderNormalizedStateRows(ledgerId) {
  const operationId = createDataIoOperationId("state-load");
  const traceMeta = { source: "state-load", route: "render-api", endpoint: renderStateLoadUrl, operation: "load", operationId };
  if (!ledgerId || typeof fetch !== "function") return null;

  let controller = null;
  let timeoutId = 0;
  try {
    const accessToken = await getFreshRenderAccessToken();
    if (!accessToken) {
      recordDataIoDiagnostic("skip", {
        ...traceMeta,
        ok: true,
        code: "AUTH_SESSION_NOT_READY",
        detail: "Skipped Render state load until Supabase session is ready; using browser normalized table load."
      });
      return null;
    }

    recordDataIoDiagnostic("start", { ...traceMeta, ok: true });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render state load API", 12000));
      }, 12000);
    });
    const fetchPromise = fetch(renderStateLoadUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok && result?.stateRows) {
      recordSupabaseLoadEvent("render-state-load", "normalized state via Render backend API");
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true });
      return result.stateRows;
    }

    const message = result?.message || result?.error || text || `Render state load failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    if (isRenderAuthRejected(response, result, text)) {
      recordDataIoDiagnostic("skip", {
        ...traceMeta,
        ok: true,
        code: "RENDER_AUTH_NOT_READY",
        detail: "Render state load did not accept the current session yet; using browser normalized table load."
      });
      return null;
    }
    recordDataIoDiagnostic("error", { ...traceMeta, error, detail: `HTTP ${response.status}; falling back to browser normalized table load.` });
    return null;
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render state load API", 12000);
    recordDataIoDiagnostic(timedOut ? "timeout" : "exception", { ...traceMeta, error, detail: "Falling back to browser normalized table load." });
    return null;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function getRenderWriteContext({ ledgerId, source = "normalized-write-context" } = {}) {
  const traceMeta = { source, route: "render-api", endpoint: renderWriteContextUrl, operation: "prepare" };
  if (!currentSession?.access_token || !ledgerId) return null;

  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render write context API", writeContextActionTimeoutMs));
      }, writeContextActionTimeoutMs);
    });
    const fetchPromise = fetch(renderWriteContextUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok && result?.context?.ledgerId && result?.context?.openPeriodId) {
      recordSupabaseLoadEvent("render-write-context", "write context via Render backend API");
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true });
      return result.context;
    }

    const message = result?.message || result?.error || text || `Render write context failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    recordDataIoDiagnostic("error", { ...traceMeta, error, detail: `HTTP ${response.status}; falling back to direct Supabase context.` });
    return null;
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render write context API", writeContextActionTimeoutMs);
    recordDataIoDiagnostic(timedOut ? "timeout" : "exception", { ...traceMeta, error, detail: "Falling back to direct Supabase context." });
    return null;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function cachePaymentWriteContext(context) {
  if (!context?.ledgerId || !context?.openPeriodId || !context?.memberIdsByName) return null;
  cachedPaymentWriteContext = {
    ledgerId: context.ledgerId,
    openPeriodId: context.openPeriodId,
    memberIdsByName: { ...context.memberIdsByName },
    currentMemberId: context.currentMemberId || null,
    cachedAt: Date.now()
  };
  return cachedPaymentWriteContext;
}

function getCachedPaymentWriteContext() {
  if (!cachedPaymentWriteContext) return null;
  if (Date.now() - Number(cachedPaymentWriteContext.cachedAt || 0) > paymentWriteContextCacheMaxAgeMs) return null;
  if (cachedPaymentWriteContext.ledgerId !== supabaseHelpers.getLedgerId(supabaseConfig)) return null;
  return cachedPaymentWriteContext;
}

async function getPaymentActionBackendContext() {
  const cached = getCachedPaymentWriteContext();
  if (cached) {
    recordSupabaseLoadEvent("payment-action-context-cache", "using cached normalized write context");
    return cached;
  }
  const context = await withPaymentBackendStartTimeout(
    getNormalizedWriteContext({ syncDirectory: false, source: "payment-action-context" }),
    "Payment action backend context"
  );
  return cachePaymentWriteContext(context);
}

function buildSettlementRequestPayload(context, settlement, nextStatus) {
  const fromMemberId = context.memberIdsByName[settlement?.from] || null;
  const toMemberId = context.memberIdsByName[settlement?.to] || null;
  if (!fromMemberId || !toMemberId) {
    throw new Error("Could not match settlement members in normalized ledger_members.");
  }

  const now = new Date().toISOString();
  const payload = {
    ledger_id: context.ledgerId,
    period_id: context.openPeriodId,
    from_member_id: fromMemberId,
    to_member_id: toMemberId,
    amount: roundMoney(settlement.amount),
    currency: state.currency || "DKK",
    status: nextStatus,
    updated_at: now
  };

  if (nextStatus === "requested") {
    payload.requested_at = now;
    payload.requested_by_member_id = toMemberId;
    payload.paid_at = null;
  } else if (nextStatus === "paid") {
    payload.paid_at = now;
  } else {
    payload.requested_at = null;
    payload.requested_by_member_id = null;
    payload.paid_at = null;
  }

  return payload;
}

async function savePaymentStatusBackendFirst(settlement, nextStatus, options = {}) {
  if (!supabaseClient || !currentSession) return true;
  try {
    if (!options.skipVisibleSaving) setSyncStatus("Saving", { source: "payment-status-action" });
    const context = await getPaymentActionBackendContext();
    if (!context) {
      recordSupabaseLoadEvent("payment-action-backend-skipped", "normalized write context unavailable before backend write");
      recordSyncDiagnostic("payment-action-backend-skipped", "Payment action stopped before backend write because normalized write context was unavailable.");
      return false;
    }

    recordSupabaseLoadEvent("settlement-directory-sync-skip", "payment status save skipped ledger directory reconciliation");
    const payload = buildSettlementRequestPayload(context, settlement, nextStatus);
    const actionRpcOptions = { ...options, operationId: createDataIoOperationId("settlement-request-save") };
    const actionRpcResult = await applyPaymentStatusActionRpc(context, payload, actionRpcOptions);

    if (actionRpcResult.ok) {
      recordSupabaseLoadEvent("settlement-table-write", `${settlement?.from || "?"} -> ${settlement?.to || "?"}: ${nextStatus}`);
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: `${actionRpcResult.backend === "render-api" ? "Render backend API" : "Backend payment action RPC"} saved the settlement status, stale-row cleanup, and ledger event in one database transaction. JSON audit remains a backup.`
      };
      return true;
    }

    if (!actionRpcResult.shouldFallback) throw actionRpcResult.error || new Error("Could not save payment action.");

    console.warn("Payment action RPC is unavailable; falling back to settlement request transaction RPC. Apply the latest supabase-schema.sql to enable backend-owned payment actions.", actionRpcResult.error);
    const rpcResult = await saveSettlementRequestStatusRpc(context, payload);
    if (rpcResult.ok) {
      recordSupabaseLoadEvent("settlement-table-write", `${settlement?.from || "?"} -> ${settlement?.to || "?"}: ${nextStatus}`);
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: "Table-primary write saved the settlement request status and stale-row cleanup through the database transaction RPC. Apply the latest Supabase schema to add backend-owned payment ledger events."
      };
      return true;
    }

    if (!rpcResult.shouldFallback) throw rpcResult.error || new Error("Could not save settlement request status.");
    throw rpcResult.error || new Error("Payment backend RPCs are unavailable; refusing local-only payment status write.");
  } catch (error) {
    recordDataIoDiagnostic("error", { source: "settlement-request-save", route: "backend-first", operation: nextStatus, error });
    console.warn("Backend-first payment action failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save payment action through backend first: ${error.message || error}`
    };
    showUserError("Could not save this payment action through the backend. No local-only payment change was kept. Check the diagnostics for details.");
    render();
    return false;
  }
}


async function syncLedgerDirectoryViaRender(ledgerPayload, memberPayloads, source = "ledger-directory-sync") {
  const traceMeta = { source, route: "render-api", endpoint: renderLedgerDirectorySyncUrl, operation: "upsert" };
  if (!currentSession?.access_token || !ledgerPayload?.id) return { ok: false, shouldFallback: true };

  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, ledgerId: ledgerPayload.id });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render ledger directory sync API", 12000));
      }, 12000);
    });
    const fetchPromise = fetch(renderLedgerDirectorySyncUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledger: ledgerPayload, members: memberPayloads })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-ledger-directory-sync", "ledger directory via Render backend API");
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true, ledgerId: ledgerPayload.id });
      return { ok: true, backend: "render-api", result };
    }

    const message = result?.message || result?.error || text || `Render ledger directory sync failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    const shouldFallback = [404, 405, 501].includes(response.status);
    recordDataIoDiagnostic("error", {
      ...traceMeta,
      error,
      ledgerId: ledgerPayload.id,
      detail: shouldFallback ? `HTTP ${response.status}; falling back to direct Supabase ledger directory sync.` : `HTTP ${response.status}; not falling back.`
    });
    return { ok: false, shouldFallback, error };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render ledger directory sync API", 12000);
    recordDataIoDiagnostic(timedOut ? "timeout" : "exception", {
      ...traceMeta,
      error,
      ledgerId: ledgerPayload.id,
      detail: "Falling back to direct Supabase ledger directory sync."
    });
    return { ok: false, shouldFallback: true, error };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function upsertLedgerSettings(ledgerPayload, source = "ledger-directory-sync") {
  if (!ledgerPayload?.slug) {
    const error = new Error("Refusing to upsert ledgers without slug.");
    recordDataIoDiagnostic("blocked", {
      source,
      route: "direct-table",
      table: "ledgers",
      operation: "upsert",
      detail: "ledgers upsert blocked before Supabase because slug is required",
      error
    });
    throw error;
  }
  const result = await traceDataIo({ source, route: "direct-table", table: "ledgers", operation: "upsert" }, () =>
    supabaseClient.from("ledgers").upsert(ledgerPayload).select("id").single()
  );
  if (!result.error) return result.data;

  // Older production databases may not have fuel_tank_capacity_l yet. Keep the
  // app usable until the schema migration from supabase-schema.sql is applied.
  const message = String(result.error?.message || "");
  const code = String(result.error?.code || "");
  if ((code === "PGRST204" || message.includes("fuel_tank_capacity_l")) && Object.prototype.hasOwnProperty.call(ledgerPayload, "fuel_tank_capacity_l")) {
    const fallbackPayload = { ...ledgerPayload };
    delete fallbackPayload.fuel_tank_capacity_l;
    const fallbackResult = await traceDataIo({ source: `${source}:fallback`, route: "direct-table", table: "ledgers", operation: "upsert" }, () =>
      supabaseClient.from("ledgers").upsert(fallbackPayload).select("id").single()
    );
    if (!fallbackResult.error) return fallbackResult.data;
    throw fallbackResult.error;
  }
  throw result.error;
}


function failClosedBrowserWriteFallback(source, operation, error, detail) {
  const blockedError = error instanceof Error ? error : new Error(String(error || detail || "Browser write fallback is disabled."));
  const message = detail || "Browser Supabase write fallback is disabled; Render must own this write.";
  recordDataIoDiagnostic("blocked", {
    source,
    route: "browser-write-fallback",
    operation: operation || "fallback-blocked",
    detail: message,
    error: blockedError
  });
  return {
    ok: false,
    error: new Error(`${message}${blockedError?.message ? ` ${blockedError.message}` : ""}`),
    shouldFallback: false,
    backend: "render-api"
  };
}

async function syncLedgerDirectoryForAdmin(ledgerId) {
  const now = new Date().toISOString();
  const ledgerPayload = {
    id: ledgerId,
    slug: String(ledgerId || getConfiguredLedgerId()).trim() || getConfiguredLedgerId(),
    name: "Fuel Ledger",
    currency: state.currency || "DKK",
    fuel_type: state.fuelType || defaults.fuelType,
    estimated_consumption_l_per_100km: Number(state.fuelConsumption) || defaults.fuelConsumption,
    fuel_tank_capacity_l: getFuelTankCapacity(),
    fallback_fuel_price: Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice,
    low_fuel_threshold_percent: Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold,
    updated_at: now
  };

  const memberPayloads = getMemberNames().map((name) => {
    const profile = getMemberProfile(name);
    return {
      ledger_id: ledgerId,
      name,
      email: profile.email || null,
      role: profile.role === "admin" ? "admin" : "member",
      is_active: true,
      updated_at: now
    };
  });

  const renderResult = await syncLedgerDirectoryViaRender(ledgerPayload, memberPayloads);
  if (renderResult.ok) return;

  const blocked = failClosedBrowserWriteFallback(
    "ledger-directory-sync",
    "upsert",
    renderResult.error || new Error("Render ledger directory sync failed."),
    "Browser ledger-directory direct-table fallback is disabled; Render /api/ledgers/sync must own ledger/member directory writes."
  );
  throw blocked.error;
}

async function saveTripToNormalizedTablesFirst(trip) {
  if (!supabaseClient || !currentSession) return true;
  let savedThroughNormalizedTables = false;
  try {
    setSyncStatus("Saving", { source: "trip-save" });
    const context = await withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "trip-save" }), "trip-save");
    if (!context) return true;
    const payload = {
      legacy_id: trip.id,
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      driver_member_id: context.memberIdsByName[trip.driver] || null,
      trip_date: normalizedDate(trip.date),
      start_km: Number(trip.startKm || 0),
      end_km: Number(trip.endKm || 0),
      note: trip.note || null,
      created_by_member_id: context.currentMemberId,
      deleted_at: null,
      updated_at: new Date().toISOString()
    };

    const participantMemberIds = [...new Set(getTripParticipants(trip).map((name) => context.memberIdsByName[name]).filter(Boolean))];
    const rpcResult = await saveTripWithParticipantsRpc(context, payload, participantMemberIds);

    if (rpcResult.ok) {
      savedThroughNormalizedTables = true;
      recordSupabaseLoadEvent("trip-table-write", trip?.id ? `trip ${String(trip.id).slice(0, 8)}` : "trip");
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: "Table-primary write saved the trip and participants through the database transaction RPC. JSON will be updated as backup."
      };
      setSyncStatus("Tables");
      return true;
    }

    if (!rpcResult.shouldFallback) throw rpcResult.error || new Error("Could not save trip with participants.");

    console.warn("Trip transaction RPC is unavailable; falling back to guarded table writes. Apply the latest supabase-schema.sql to enable atomic trip writes.", rpcResult.error);
    await saveTripWithParticipantsGuardedTableUpdates(payload, participantMemberIds);
    savedThroughNormalizedTables = true;
    recordSupabaseLoadEvent("trip-table-write", trip?.id ? `trip ${String(trip.id).slice(0, 8)}` : "trip");
    recordDataIoDiagnostic("success", { source: "trip-save", route: "direct-table", table: "trips", operation: "upsert", ok: true, detail: "Saved through guarded table fallback." });

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the trip with guarded table updates. Apply the latest Supabase schema to use the transaction RPC."
    };
    setSyncStatus("Tables");
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", { source: "trip-save", route: "normalized-write", operation: "save", error });
    console.warn("Table-primary trip write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save trip to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    showUserError("Could not save this trip to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  } finally {
    finishForegroundOperationsBySource("trip-save", savedThroughNormalizedTables ? "trip-save-normalized-write-saved" : "trip-save-normalized-write-ended");
    clearVisibleSavingFailsafe();
  }
}


async function saveTripWithParticipantsRpc(context, payload, participantMemberIds) {
  const renderResult = await saveTripWithParticipantsViaRender(context, payload, participantMemberIds);
  if (renderResult.ok || !renderResult.shouldFallback) return renderResult;

  return failClosedBrowserWriteFallback(
    "trip-save",
    "upsert",
    renderResult.error,
    "Browser trip Supabase RPC/table fallback is disabled; Render /api/trips/upsert must own trip writes."
  );
}

async function saveTripWithParticipantsViaRender(context, payload, participantMemberIds) {
  const operationId = createDataIoOperationId("trip-save");
  const traceMeta = { source: "trip-save", route: "render-api", endpoint: renderTripUpsertUrl, operation: "upsert", operationId };
  if (!currentSession?.access_token) {
    const error = new Error("No active Supabase session for Render trip save API.");
    recordDataIoDiagnostic("error", { ...traceMeta, error });
    return { ok: false, shouldFallback: true, backend: "render-api", error };
  }

  let controller = null;
  let timeoutId = 0;
  let finished = false;
  const finishTripRenderDiagnostic = (phase, meta = {}) => {
    if (finished) return;
    finished = true;
    recordDataIoDiagnostic(phase, { ...traceMeta, ...meta });
  };

  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "TRIP_SAVE_STARTED" });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render trip save API", tripSaveActionTimeoutMs));
      }, tripSaveActionTimeoutMs);
    });
    const fetchPromise = fetch(renderTripUpsertUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        context: { ledgerId: context.ledgerId, openPeriodId: context.openPeriodId },
        trip: payload,
        participantMemberIds
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-trip-save", "upsert via Render backend API");
      finishTripRenderDiagnostic("success", { ok: true, resultCode: "TRIP_SAVED" });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render trip save failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    finishTripRenderDiagnostic("error", { error, detail: `HTTP ${response.status}`, resultCode: "TRIP_SAVE_ERROR" });
    return {
      ok: false,
      error,
      shouldFallback: response.status === 404 || response.status === 405 || response.status === 501,
      backend: "render-api"
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render trip save API", tripSaveActionTimeoutMs);
    finishTripRenderDiagnostic(timedOut ? "timeout" : "exception", { error, resultCode: timedOut ? "TRIP_SAVE_TIMEOUT" : "TRIP_SAVE_ERROR" });
    console.warn("Render trip save API failed", error);
    return { ok: false, error, shouldFallback: !timedOut, backend: "render-api" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (!finished) {
      finishTripRenderDiagnostic("exception", { error: new Error("Render trip save ended without a recorded finish diagnostic.") });
    }
  }
}

function isMissingTripTransactionRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || /upsert_trip_with_participants/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message);
}

async function saveTripWithParticipantsGuardedTableUpdates(payload, participantMemberIds) {
  const tripResult = await traceDataIo({ source: "trip-save", route: "direct-table", table: "trips", operation: "upsert" }, () => supabaseClient
    .from("trips")
    .upsert(payload, { onConflict: "ledger_id,legacy_id" })
    .select("id")
    .single());
  if (tripResult.error) throw tripResult.error;

  const tripId = tripResult.data.id;
  const deleteParticipants = await traceDataIo({ source: "trip-save", route: "direct-table", table: "trip_participants", operation: "delete" }, () => supabaseClient.from("trip_participants").delete().eq("trip_id", tripId));
  if (deleteParticipants.error) throw deleteParticipants.error;

  const participantPayloads = participantMemberIds.map((memberId) => ({ trip_id: tripId, member_id: memberId }));
  if (!participantPayloads.length) throw new Error("Trip must include at least one participant.");

  const participantResult = await traceDataIo({ source: "trip-save", route: "direct-table", table: "trip_participants", operation: "upsert" }, () => supabaseClient
    .from("trip_participants")
    .upsert(participantPayloads, { onConflict: "trip_id,member_id" }));
  if (participantResult.error) throw participantResult.error;

  return tripId;
}


async function saveFuelPaymentRpc(context, payload) {
  const renderResult = await saveFuelPaymentViaRender(context, payload);
  if (renderResult.ok || !renderResult.shouldFallback) return renderResult;

  return failClosedBrowserWriteFallback(
    "fuel-save",
    "upsert",
    renderResult.error,
    "Browser fuel Supabase RPC/table fallback is disabled; Render /api/fuel/upsert must own fuel writes."
  );
}

async function saveFuelPaymentViaRender(context, payload) {
  const operationId = createDataIoOperationId("fuel-save");
  const traceMeta = { source: "fuel-save", route: "render-api", endpoint: renderFuelUpsertUrl, operation: "upsert", operationId };
  if (!currentSession?.access_token) {
    const error = new Error("No active Supabase session for Render fuel save API.");
    recordDataIoDiagnostic("error", { ...traceMeta, error });
    return { ok: false, shouldFallback: true, backend: "render-api", error };
  }

  let controller = null;
  let timeoutId = 0;
  let finished = false;
  const finishFuelRenderDiagnostic = (phase, meta = {}) => {
    if (finished) return;
    finished = true;
    recordDataIoDiagnostic(phase, { ...traceMeta, ...meta });
  };

  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, resultCode: "FUEL_SAVE_STARTED" });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render fuel save API", fuelSaveActionTimeoutMs));
      }, fuelSaveActionTimeoutMs);
    });
    const fetchPromise = fetch(renderFuelUpsertUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        context: { ledgerId: context.ledgerId, openPeriodId: context.openPeriodId },
        fuel: payload
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-fuel-save", "upsert via Render backend API");
      finishFuelRenderDiagnostic("success", { ok: true, resultCode: "FUEL_SAVED" });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render fuel save failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    finishFuelRenderDiagnostic("error", { error, detail: `HTTP ${response.status}`, resultCode: "FUEL_SAVE_ERROR" });
    return {
      ok: false,
      error,
      shouldFallback: response.status === 404 || response.status === 405 || response.status === 501,
      backend: "render-api"
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render fuel save API", fuelSaveActionTimeoutMs);
    finishFuelRenderDiagnostic(timedOut ? "timeout" : "exception", { error, resultCode: timedOut ? "FUEL_SAVE_TIMEOUT" : "FUEL_SAVE_ERROR" });
    console.warn("Render fuel save API failed", error);
    return { ok: false, error, shouldFallback: !timedOut, backend: "render-api" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (!finished) {
      finishFuelRenderDiagnostic("exception", { error: new Error("Render fuel save ended without a recorded finish diagnostic.") });
    }
  }
}

function isMissingFuelPaymentRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || (/upsert_fuel_payment/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message));
}

async function saveFuelWithGuardedTableUpdate(payload) {
  const fuelResult = await traceDataIo({ source: "fuel-save", route: "direct-table", table: "fuel_payments", operation: "upsert" }, () => supabaseClient
    .from("fuel_payments")
    .upsert(payload, { onConflict: "ledger_id,legacy_id" }));
  if (fuelResult.error) throw fuelResult.error;
  return true;
}

async function saveFuelToNormalizedTablesFirst(fuel) {
  if (!supabaseClient || !currentSession) return true;
  let savedThroughNormalizedTables = false;
  try {
    setSyncStatus("Saving", { source: "fuel-save" });
    const context = await withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "fuel-save" }), "fuel-save");
    if (!context) return true;
    const liters = nullableNumber(fuel.liters);
    const amount = Number(fuel.amount || 0);
    const payload = {
      legacy_id: fuel.id,
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      payer_member_id: context.memberIdsByName[fuel.payer] || null,
      payment_date: normalizedDate(fuel.date),
      amount,
      currency: state.currency || "DKK",
      liters,
      price_per_liter: liters ? roundMoney(amount / liters) : nullableNumber(fuel.pricePerLiter),
      odometer: nullableNumber(fuel.odometer),
      station_name: fuel.station || fuel.stationInfo?.name || null,
      station_brand: fuel.stationInfo?.brand || null,
      station_lat: fuel.stationInfo?.latitude || null,
      station_lng: fuel.stationInfo?.longitude || null,
      user_lat: fuel.location?.latitude || null,
      user_lng: fuel.location?.longitude || null,
      full_tank: Boolean(fuel.fullTank),
      created_by_member_id: context.currentMemberId,
      deleted_at: null,
      updated_at: new Date().toISOString()
    };

    const rpcResult = await saveFuelPaymentRpc(context, payload);
    if (!rpcResult.ok) {
      if (!rpcResult.shouldFallback) throw rpcResult.error;
      console.warn("Fuel payment RPC is unavailable; falling back to guarded table upsert", rpcResult.error);
      await saveFuelWithGuardedTableUpdate(payload);
    }

    savedThroughNormalizedTables = true;
    recordSupabaseLoadEvent("fuel-table-write", fuel?.id ? `fuel ${String(fuel.id).slice(0, 8)}` : "fuel");
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: rpcResult.backend === "render-api"
        ? "Render backend API saved the fuel log to normalized tables. JSON will be updated as backup."
        : "Table-primary write saved the fuel log to normalized tables. JSON will be updated as backup."
    };
    if (!rpcResult.ok) {
      recordDataIoDiagnostic("success", { source: "fuel-save", route: "direct-table", table: "fuel_payments", operation: "save", ok: true, detail: "Saved through guarded table fallback." });
    }
    setSyncStatus("Tables");
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", { source: "fuel-save", route: "normalized-write", operation: "save", error });
    console.warn("Table-primary fuel write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save fuel log to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    showUserError("Could not save this fuel log to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  } finally {
    finishForegroundOperationsBySource("fuel-save", savedThroughNormalizedTables ? "fuel-save-normalized-write-saved" : "fuel-save-normalized-write-ended");
    clearVisibleSavingFailsafe();
  }
}


async function saveBookingRpc(context, payload) {
  const renderResult = await saveBookingViaRender(context, payload);
  if (renderResult.ok || !renderResult.shouldFallback) return renderResult;

  return failClosedBrowserWriteFallback(
    "booking-save",
    "upsert",
    renderResult.error,
    "Browser booking Supabase RPC/table fallback is disabled; Render /api/bookings/upsert must own booking writes."
  );
}

async function saveBookingViaRender(context, payload) {
  const operationId = createDataIoOperationId("booking-save");
  const traceMeta = { source: "booking-save", route: "render-api", endpoint: renderBookingUpsertUrl, operation: "upsert", operationId };
  if (!currentSession?.access_token) {
    const error = new Error("No active Supabase session for Render booking save API.");
    recordDataIoDiagnostic("error", { ...traceMeta, error });
    return { ok: false, shouldFallback: true, backend: "render-api", error };
  }

  let controller = null;
  let timeoutId = 0;
  let finished = false;
  const finishBookingRenderDiagnostic = (phase, meta = {}) => {
    if (finished) return;
    finished = true;
    recordDataIoDiagnostic(phase, { ...traceMeta, ...meta });
  };

  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render booking save API", bookingSaveActionTimeoutMs));
      }, bookingSaveActionTimeoutMs);
    });
    const fetchPromise = fetch(renderBookingUpsertUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        context: { ledgerId: context.ledgerId },
        booking: payload
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-booking-save", "upsert via Render backend API");
      finishBookingRenderDiagnostic("success", { ok: true });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render booking save failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    finishBookingRenderDiagnostic("error", { error, detail: `HTTP ${response.status}` });
    return {
      ok: false,
      error,
      shouldFallback: response.status === 404 || response.status === 405 || response.status === 501,
      backend: "render-api"
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render booking save API", bookingSaveActionTimeoutMs);
    finishBookingRenderDiagnostic(timedOut ? "timeout" : "exception", { error });
    console.warn("Render booking save API failed", error);
    return { ok: false, error, shouldFallback: !timedOut, backend: "render-api" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (!finished) {
      finishBookingRenderDiagnostic("exception", { error: new Error("Render booking save ended without a recorded finish diagnostic.") });
    }
  }
}

function isMissingBookingTransactionRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || /upsert_car_booking|soft_delete_car_booking/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message);
}

async function saveBookingWithGuardedTableUpdate(payload) {
  const bookingResult = await traceDataIo({ source: "booking-save", route: "direct-table", table: "car_bookings", operation: "upsert" }, () => supabaseClient
    .from("car_bookings")
    .upsert(payload, { onConflict: "ledger_id,legacy_id" }));
  if (bookingResult.error) throw bookingResult.error;
}

async function softDeleteBookingRpc(context, legacyBookingId) {
  const renderResult = await softDeleteBookingViaRender(context, legacyBookingId);
  if (renderResult.ok || !renderResult.shouldFallback) return renderResult;

  return failClosedBrowserWriteFallback(
    "booking-delete",
    "delete",
    renderResult.error,
    "Browser booking-delete Supabase RPC/table fallback is disabled; Render /api/bookings/delete must own booking deletes."
  );
}

async function softDeleteBookingViaRender(context, legacyBookingId) {
  const operationId = createDataIoOperationId("booking-delete");
  const traceMeta = { source: "booking-delete", route: "render-api", endpoint: renderBookingDeleteUrl, operation: "delete", operationId };
  if (!currentSession?.access_token) {
    const error = new Error("No active Supabase session for Render booking delete API.");
    recordDataIoDiagnostic("error", { ...traceMeta, error });
    return { ok: false, shouldFallback: true, backend: "render-api", error };
  }

  let controller = null;
  let timeoutId = 0;
  let finished = false;
  const finishBookingDeleteRenderDiagnostic = (phase, meta = {}) => {
    if (finished) return;
    finished = true;
    recordDataIoDiagnostic(phase, { ...traceMeta, ...meta });
  };

  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render booking delete API", bookingSaveActionTimeoutMs));
      }, bookingSaveActionTimeoutMs);
    });
    const fetchPromise = fetch(renderBookingDeleteUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        context: { ledgerId: context.ledgerId },
        legacyBookingId
      })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-booking-delete", "soft delete via Render backend API");
      finishBookingDeleteRenderDiagnostic("success", { ok: true });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render booking delete failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    finishBookingDeleteRenderDiagnostic("error", { error, detail: `HTTP ${response.status}` });
    return {
      ok: false,
      error,
      shouldFallback: response.status === 404 || response.status === 405 || response.status === 501,
      backend: "render-api"
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render booking delete API", bookingSaveActionTimeoutMs);
    finishBookingDeleteRenderDiagnostic(timedOut ? "timeout" : "exception", { error });
    console.warn("Render booking delete API failed", error);
    return { ok: false, error, shouldFallback: !timedOut, backend: "render-api" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
    if (!finished) {
      finishBookingDeleteRenderDiagnostic("exception", { error: new Error("Render booking delete ended without a recorded finish diagnostic.") });
    }
  }
}

async function saveBookingToNormalizedTablesFirst(booking) {
  recordSupabaseLoadEvent("booking-table-write", booking?.id ? `booking ${String(booking.id).slice(0, 8)}` : "booking");
  if (!supabaseClient || !currentSession) return true;
  try {
    setSyncStatus("Saving", { source: "booking-save" });
    const context = await withNormalizedWriteContextTimeout(getNormalizedWriteContext({ source: "booking-save" }), "booking-save");
    if (!context) return true;
    const payload = {
      legacy_id: booking.id,
      ledger_id: context.ledgerId,
      member_id: context.memberIdsByName[booking.member] || null,
      start_at: bookingDateTimeToIso(booking.start),
      end_at: bookingDateTimeToIso(booking.end),
      purpose: booking.purpose || null,
      created_by_member_id: context.currentMemberId,
      deleted_at: null,
      updated_at: new Date().toISOString()
    };

    const rpcResult = await saveBookingRpc(context, payload);

    if (rpcResult.ok) {
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: rpcResult.backend === "render-api"
          ? "Render backend API saved the booking to normalized tables. JSON will be updated as backup."
          : "Table-primary write saved the booking through the database transaction RPC. JSON will be updated as backup."
      };
      if (rpcResult.backend === "supabase-rpc") {
        recordDataIoDiagnostic("success", { source: "booking-save", route: "supabase-rpc", rpc: "upsert_car_booking", operation: "save", ok: true });
      }
      return true;
    }

    if (!rpcResult.shouldFallback) throw rpcResult.error || new Error("Could not save booking.");

    console.warn("Booking transaction RPC is unavailable; falling back to direct table write. Apply the latest supabase-schema.sql to enable hardened booking writes.", rpcResult.error);
    await saveBookingWithGuardedTableUpdate(payload);
    recordDataIoDiagnostic("success", { source: "booking-save", route: "direct-table", table: "car_bookings", operation: "upsert", ok: true, detail: "Saved through guarded table fallback." });

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the booking with direct table update. Apply the latest Supabase schema to use the transaction RPC."
    };
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", { source: "booking-save", route: "normalized-write", operation: "save", error });
    console.warn("Table-primary booking write failed", error);
    if (isMissingBookingTableError(error)) {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: "Booking table is not installed yet. Saving booking to JSON backup until supabase-schema.sql has been run."
      };
      return true;
    }
    const message = isBookingOverlapError(error)
      ? "The car is already booked for that time. Refresh the calendar and choose another slot."
      : `Could not save booking to normalized tables, so JSON was not changed: ${error.message || error}`;
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message
    };
    showUserError(message);
    render();
    return false;
  }
}

async function pruneStaleSettlementRequests(context) {
  if (!supabaseClient || !context?.openPeriodId) return;
  const currentPairIds = new Set(
    calculateLedger().settlements
      .map((settlement) => {
        const fromId = context.memberIdsByName[settlement.from];
        const toId = context.memberIdsByName[settlement.to];
        return fromId && toId ? `${fromId}->${toId}` : "";
      })
      .filter(Boolean)
  );

  const existing = await traceDataIo({ source: "settlement-request-prune", route: "direct-table", table: "settlement_requests", operation: "select-stale" }, () => supabaseClient
    .from("settlement_requests")
    .select("id,from_member_id,to_member_id")
    .eq("ledger_id", context.ledgerId)
    .eq("period_id", context.openPeriodId));
  if (existing.error) throw existing.error;

  const staleIds = (existing.data || [])
    .filter((request) => !currentPairIds.has(`${request.from_member_id}->${request.to_member_id}`))
    .map((request) => request.id);
  if (!staleIds.length) return;

  // RLS allows ledger members to update settlement request rows, but not necessarily delete them.
  // Mark old payment-line rows as cancelled so they do not count in health checks or reload state.
  const cancellation = await traceDataIo({ source: "settlement-request-prune", route: "direct-table", table: "settlement_requests", operation: "cancel-stale" }, () => supabaseClient
    .from("settlement_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .in("id", staleIds));
  if (cancellation.error) throw cancellation.error;
}


function currentSettlementPairKeys(context) {
  return calculateLedger().settlements
    .map((settlement) => {
      const fromId = context.memberIdsByName[settlement.from];
      const toId = context.memberIdsByName[settlement.to];
      return fromId && toId ? `${fromId}->${toId}` : "";
    })
    .filter(Boolean);
}

async function saveSettlementRequestStatusRpc(context, payload) {
  const { data, error } = await traceDataIo({ source: "settlement-request-save", route: "supabase-rpc", rpc: "upsert_settlement_request_status", operation: "rpc" }, () => supabaseClient.rpc("upsert_settlement_request_status", {
    target_ledger_id: context.ledgerId,
    target_open_period_id: context.openPeriodId,
    payer_member_id: payload.from_member_id,
    recipient_member_id: payload.to_member_id,
    amount_value: payload.amount,
    currency_value: payload.currency,
    next_status: payload.status,
    current_pair_keys: currentSettlementPairKeys(context)
  }));

  if (!error) return { ok: true, data };

  return {
    ok: false,
    error,
    shouldFallback: isMissingSettlementRequestStatusRpcError(error)
  };
}

async function applyPaymentStatusActionRpc(context, payload, options = {}) {
  const auditEntry = options.auditEntry || {};
  const rpcPayload = {
    target_ledger_id: context.ledgerId,
    target_open_period_id: context.openPeriodId,
    payer_member_id: payload.from_member_id,
    recipient_member_id: payload.to_member_id,
    amount_value: payload.amount,
    currency_value: payload.currency,
    previous_status: normalizePaymentStatus(options.previousStatus),
    next_status: payload.status,
    audit_summary: auditEntry.summary || "",
    audit_detail: auditEntry.detail || "",
    audit_metadata: auditEntry.metadata || {},
    current_pair_keys: currentSettlementPairKeys(context)
  };

  recordSupabaseLoadEvent("payment-action-backend-start", payload.status || "payment-status");
  recordSyncDiagnostic("payment-action-backend-start", "Attempting Render backend payment action.", { backend: "render-api", operation: payload.status });
  const renderResult = await applyPaymentStatusActionViaRender(context, payload, options, rpcPayload);
  if (renderResult.ok || !renderResult.shouldFallback) return renderResult;

  return failClosedBrowserWriteFallback(
    "settlement-request-save",
    rpcPayload.next_status || "payment-status",
    renderResult.error,
    "Browser payment-action Supabase RPC fallback is disabled; Render /api/payments/status-action must own payment status writes."
  );
}

async function applyPaymentStatusActionViaRender(context, payload, options = {}, rpcPayload = {}) {
  const operationId = options.operationId || createDataIoOperationId("settlement-request-save");
  const traceMeta = { source: "settlement-request-save", route: "render-api", endpoint: renderPaymentStatusActionUrl, operation: payload.status, operationId };
  if (!currentSession?.access_token) {
    return { ok: false, shouldFallback: true, backend: "render-api", error: new Error("No active Supabase session for Render payment action API.") };
  }

  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true });
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), paymentStatusActionTimeoutMs);
    const response = await fetch(renderPaymentStatusActionUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        context: { ledgerId: context.ledgerId, openPeriodId: context.openPeriodId },
        settlement: {
          from_member_id: payload.from_member_id,
          to_member_id: payload.to_member_id,
          amount: payload.amount,
          currency: payload.currency,
          status: payload.status
        },
        previousStatus: normalizePaymentStatus(options.previousStatus),
        auditEntry: options.auditEntry || {},
        currentPairKeys: currentSettlementPairKeys(context)
      })
    }).finally(() => window.clearTimeout(timeoutId));

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-payment-action", `${payload.status} via Render backend API`);
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true });
      return { ok: true, data: result.result, backend: "render-api" };
    }

    const message = result?.message || result?.error || text || `Render payment action failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    recordDataIoDiagnostic("error", { ...traceMeta, error, detail: `HTTP ${response.status}` });
    return {
      ok: false,
      error,
      shouldFallback: response.status === 404 || response.status === 405 || response.status === 501,
      backend: "render-api"
    };
  } catch (error) {
    recordDataIoDiagnostic(error?.name === "AbortError" ? "timeout" : "exception", { ...traceMeta, error });
    console.warn("Render payment action API failed; falling back to direct Supabase RPC", error);
    if (error?.name === "AbortError") {
      error = paymentActionTimeoutError("Render payment action API", paymentStatusActionTimeoutMs);
      error.isRenderPaymentActionTimeout = true;
      return { ok: false, error, shouldFallback: false, backend: "render-api" };
    }
    return { ok: false, error, shouldFallback: true, backend: "render-api" };
  }
}

function isMissingSettlementRequestStatusRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || (/upsert_settlement_request_status/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message));
}

function isMissingPaymentStatusActionRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "PGRST202" || (/apply_payment_status_action/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message));
}

async function saveSettlementRequestToNormalizedTableFirst(settlement, nextStatus, options = {}) {
  if (options.auditEntry) {
    return savePaymentStatusBackendFirst(settlement, nextStatus, options);
  }
  recordSupabaseLoadEvent("settlement-table-write", `${settlement?.from || "?"} -> ${settlement?.to || "?"}: ${nextStatus}`);
  if (!supabaseClient || !currentSession) return true;
  try {
    if (!options.skipVisibleSaving) setSyncStatus("Saving", { source: "settlement-request-save" });
    const context = await getNormalizedWriteContext({ syncDirectory: false, source: "settlement-request-save" });
    if (!context) return false;
    recordSupabaseLoadEvent("settlement-directory-sync-skip", "payment status save skipped ledger directory reconciliation");

    const fromMemberId = context.memberIdsByName[settlement.from] || null;
    const toMemberId = context.memberIdsByName[settlement.to] || null;
    if (!fromMemberId || !toMemberId) {
      throw new Error("Could not match settlement members in normalized ledger_members.");
    }

    const now = new Date().toISOString();
    const payload = {
      ledger_id: context.ledgerId,
      period_id: context.openPeriodId,
      from_member_id: fromMemberId,
      to_member_id: toMemberId,
      amount: roundMoney(settlement.amount),
      currency: state.currency || "DKK",
      status: nextStatus,
      updated_at: now
    };

    if (nextStatus === "requested") {
      payload.requested_at = now;
      payload.requested_by_member_id = toMemberId;
      payload.paid_at = null;
    } else if (nextStatus === "paid") {
      payload.paid_at = now;
    } else {
      payload.requested_at = null;
      payload.requested_by_member_id = null;
      payload.paid_at = null;
    }

    const actionRpcOptions = options.auditEntry
      ? { ...options, operationId: createDataIoOperationId("settlement-request-save") }
      : options;
    const actionRpcResult = options.auditEntry
      ? await applyPaymentStatusActionRpc(context, payload, actionRpcOptions)
      : { ok: false, shouldFallback: true };
    if (actionRpcResult.ok) {
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: `${actionRpcResult.backend === "render-api" ? "Render backend API" : "Backend payment action RPC"} saved the settlement status, stale-row cleanup, and ledger event in one database transaction. JSON audit remains a backup.`
      };
      return true;
    }

    if (options.auditEntry && !actionRpcResult.shouldFallback) throw actionRpcResult.error || new Error("Could not save payment action.");

    if (options.auditEntry) {
      console.warn("Payment action RPC is unavailable; falling back to settlement request transaction RPC. Apply the latest supabase-schema.sql to enable backend-owned payment actions.", actionRpcResult.error);
    }

    const rpcResult = await saveSettlementRequestStatusRpc(context, payload);
    if (rpcResult.ok) {
      normalizedTableStatus = {
        checked: true,
        ok: true,
        message: "Table-primary write saved the settlement request status and stale-row cleanup through the database transaction RPC. Apply the latest Supabase schema to add backend-owned payment ledger events."
      };
      return true;
    }

    if (!rpcResult.shouldFallback) throw rpcResult.error || new Error("Could not save settlement request status.");

    console.warn("Settlement request transaction RPC is unavailable; falling back to guarded table writes. Apply the latest supabase-schema.sql to enable atomic settlement request writes.", rpcResult.error);
    const result = await traceDataIo({ source: "settlement-request-save", route: "direct-table", table: "settlement_requests", operation: nextStatus }, () => supabaseClient
      .from("settlement_requests")
      .upsert(payload, { onConflict: "period_id,from_member_id,to_member_id" }));
    if (result.error) throw result.error;

    await pruneStaleSettlementRequests(context).catch((error) => {
      console.warn("Could not prune stale settlement request rows", error);
    });

    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary write saved the settlement request status with guarded table updates. Apply the latest Supabase schema to use the transaction RPC."
    };
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", { source: "settlement-request-save", route: "normalized-write", operation: nextStatus, error });
    console.warn("Table-primary settlement request write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not save settlement request to normalized tables, so JSON was not changed: ${error.message || error}`
    };
    showUserError("Could not save this settlement request to the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}

async function softDeleteNormalizedEntryFirst(type, id) {
  if (!supabaseClient || !currentSession) return true;
  const deleteSource = `${type || "entry"}-delete`;
  const deleteTraceMeta = {
    source: deleteSource,
    route: "normalized-write",
    operation: "soft-delete",
    operationId: createDataIoOperationId(deleteSource, "soft-delete"),
    resultCode: "ENTRY_DELETE_STARTED",
    detail: `Soft-delete ${type || "entry"} ${String(id || "").slice(0, 12)}`
  };
  recordDataIoDiagnostic("start", { ...deleteTraceMeta, ok: true });
  try {
    const context = await getNormalizedWriteContext({ source: deleteSource });
    if (!context) {
      recordDataIoDiagnostic("skipped", { ...deleteTraceMeta, ok: true, resultCode: "ENTRY_DELETE_SKIPPED", detail: "No normalized write context available." });
      return true;
    }
    const table = type === "trips" ? "trips" : type === "fuel" ? "fuel_payments" : type === "bookings" ? "car_bookings" : null;
    if (!table) {
      recordDataIoDiagnostic("skipped", { ...deleteTraceMeta, ok: true, resultCode: "ENTRY_DELETE_SKIPPED", detail: "Unknown entry type." });
      return true;
    }
    if (type === "bookings") {
      const rpcResult = await softDeleteBookingRpc(context, id);
      if (!rpcResult.ok) {
        if (!rpcResult.shouldFallback) throw rpcResult.error || new Error("Could not delete booking.");
        console.warn("Booking delete RPC is unavailable; falling back to direct table soft-delete. Apply the latest supabase-schema.sql to enable hardened booking deletes.", rpcResult.error);
        const fallbackResult = await supabaseClient
          .from(table)
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("ledger_id", context.ledgerId)
          .eq("legacy_id", id);
        if (fallbackResult.error) throw fallbackResult.error;
      }
    } else {
      const result = await supabaseClient
        .from(table)
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("ledger_id", context.ledgerId)
        .eq("legacy_id", id);
      if (result.error) throw result.error;
    }
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary delete saved to normalized tables. JSON will be updated as backup."
    };
    recordDataIoDiagnostic("success", { ...deleteTraceMeta, ok: true, resultCode: "ENTRY_DELETED", table });
    return true;
  } catch (error) {
    recordDataIoDiagnostic("error", { ...deleteTraceMeta, ok: false, error, resultCode: "ENTRY_DELETE_ERROR" });
    console.warn("Table-primary delete failed", error);
    if (type === "bookings" && isMissingBookingTableError(error)) {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: "Booking table is not installed yet. Deleting booking from JSON backup only."
      };
      return true;
    }
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Could not delete from normalized tables, so JSON was not changed: ${error.message || error}`
    };
    showUserError("Could not delete this entry from the normalized database. The local JSON backup was not changed. Check the console for details.");
    render();
    return false;
  }
}


function hasFreshNormalizedTableLoadForReconciliation() {
  return Boolean(lastNormalizedTableLoadAt && Date.now() - lastNormalizedTableLoadAt <= reconciliationFreshLoadMaxAgeMs);
}

async function ensureReconciliationSoftDeleteSafety(summary = {}) {
  const tripCount = Number(summary.trips || 0);
  const fuelCount = Number(summary.fuel || 0);
  const bookingCount = Number(summary.bookings || 0);
  const total = tripCount + fuelCount + bookingCount;
  if (total <= 0) return true;

  const details = [`${tripCount} trips`, `${fuelCount} fuel logs`, `${bookingCount} bookings`].join(", ");
  if (!hasFreshNormalizedTableLoadForReconciliation()) {
    recordSupabaseLoadEvent("reconciliation-soft-delete-blocked", `stale normalized table load; would hide ${details}`);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Admin reconciliation skipped ${total} soft-delete candidate${total === 1 ? "" : "s"} because normalized tables were not freshly loaded first (${details}). Reload cloud data, then retry if the JSON backup is known to be current.`,
      details: [`Blocked reconciliation soft-deletes: ${details}`]
    };
    return false;
  }

  try {
    const backedUp = await saveJsonMirrorBackup({ force: true, reason: "admin reconciliation safety backup" });
    if (!backedUp) {
      recordSupabaseLoadEvent("reconciliation-soft-delete-blocked", `JSON mirror backup failed; would hide ${details}`);
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Admin reconciliation skipped ${total} soft-delete candidate${total === 1 ? "" : "s"} because a fresh JSON mirror backup could not be saved first (${details}).`,
        details: [`Blocked reconciliation soft-deletes before backup: ${details}`]
      };
      return false;
    }
  } catch (error) {
    recordSupabaseLoadEvent("reconciliation-soft-delete-blocked", error.message || "JSON mirror backup failed");
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `Admin reconciliation skipped ${total} soft-delete candidate${total === 1 ? "" : "s"} because the pre-delete JSON mirror backup failed: ${error.message || error}`,
      details: [`Blocked reconciliation soft-deletes before backup: ${details}`]
    };
    return false;
  }

  recordSupabaseLoadEvent("reconciliation-soft-delete-armed", `fresh load and backup complete; hiding ${details}`);
  return true;
}

async function syncNormalizedTablesFromJson() {
  if (!supabaseClient || !currentSession) return;
  if (!(await hasFreshSupabaseSession())) return;

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);

  // Phase 2AA: table-primary writes already saved the specific trip/fuel/request row.
  // A full JSON-to-table reconciliation can touch admin-only tables and can also
  // soft-delete rows if a non-admin device has stale backup JSON. Only admins may
  // run the full reconciliation; regular members keep the table-primary write and
  // JSON backup snapshot paths separate.
  if (!canManageSettings()) {
    recordSupabaseLoadEvent("normalized-reconciliation-skip", "auth-bound member is not confirmed admin; skipping ledgers/table reconciliation");
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: "Table-primary save complete. Full JSON-to-table reconciliation is admin-only."
    };
    return;
  }

  try {
    const ledgerPayload = {
      id: ledgerId,
      slug: String(ledgerId || getConfiguredLedgerId()).trim() || getConfiguredLedgerId(),
      name: "Fuel Ledger",
      currency: state.currency || "DKK",
      fuel_type: state.fuelType || defaults.fuelType,
      estimated_consumption_l_per_100km: Number(state.fuelConsumption) || defaults.fuelConsumption,
      fuel_tank_capacity_l: getFuelTankCapacity(),
      fallback_fuel_price: Number(state.fuelFallbackPrice) || defaults.fuelFallbackPrice,
      low_fuel_threshold_percent: Number(state.fuelWarningThreshold) || defaults.fuelWarningThreshold,
      updated_at: new Date().toISOString()
    };

    await upsertLedgerSettings(ledgerPayload);

    const memberPayloads = getMemberNames().map((name) => {
      const profile = getMemberProfile(name);
      return {
        ledger_id: ledgerId,
        name,
        email: profile.email || null,
        role: profile.role === "admin" ? "admin" : "member",
        is_active: true,
        updated_at: new Date().toISOString()
      };
    });

    if (memberPayloads.length) {
      const upsertMembers = await supabaseClient
        .from("ledger_members")
        .upsert(memberPayloads, { onConflict: "ledger_id,name" })
        .select("id,name,email,role,is_active,mobilepay_phone");
      if (upsertMembers.error) throw upsertMembers.error;
    }

    const membersResult = await supabaseClient
      .from("ledger_members")
      .select("id,name,email")
      .eq("ledger_id", ledgerId)
      .eq("is_active", true);
    if (membersResult.error) throw membersResult.error;

    const members = membersResult.data || [];
    const memberIdsByName = Object.fromEntries(members.map((member) => [member.name, member.id]));
    const currentEmail = String(currentSession?.user?.email || "").toLowerCase();
    const currentMemberId = members.find((member) => String(member.email || "").toLowerCase() === currentEmail)?.id || null;

    let openPeriodId = null;
    const openPeriodResult = await supabaseClient
      .from("settlement_periods")
      .select("id")
      .eq("ledger_id", ledgerId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (openPeriodResult.error) throw openPeriodResult.error;
    openPeriodId = openPeriodResult.data?.id || null;

    if (!openPeriodId) {
      const insertPeriod = await supabaseClient
        .from("settlement_periods")
        .insert({ ledger_id: ledgerId, status: "open", label: "Current period" })
        .select("id")
        .single();
      if (insertPeriod.error) throw insertPeriod.error;
      openPeriodId = insertPeriod.data.id;
    }

    const tripPayloads = state.trips.map((trip) => ({
      legacy_id: trip.id,
      ledger_id: ledgerId,
      period_id: openPeriodId,
      driver_member_id: memberIdsByName[trip.driver] || null,
      trip_date: normalizedDate(trip.date),
      start_km: Number(trip.startKm || 0),
      end_km: Number(trip.endKm || 0),
      note: trip.note || null,
      created_by_member_id: currentMemberId,
      deleted_at: null,
      updated_at: new Date().toISOString()
    })).filter((trip) => trip.legacy_id && trip.end_km > trip.start_km);

    let tableTrips = [];
    if (tripPayloads.length) {
      const upsertTrips = await supabaseClient
        .from("trips")
        .upsert(tripPayloads, { onConflict: "ledger_id,legacy_id" })
        .select("id,legacy_id");
      if (upsertTrips.error) throw upsertTrips.error;
      tableTrips = upsertTrips.data || [];
    }

    const existingTripsResult = await supabaseClient
      .from("trips")
      .select("id,legacy_id")
      .eq("ledger_id", ledgerId)
      .eq("period_id", openPeriodId)
      .is("deleted_at", null);
    if (existingTripsResult.error) throw existingTripsResult.error;

    const activeTripIds = new Set(state.trips.map((trip) => trip.id));
    const tripsToSoftDelete = (existingTripsResult.data || []).filter((trip) => trip.legacy_id && !activeTripIds.has(trip.legacy_id));

    const tripIdsByLegacyId = Object.fromEntries([...(existingTripsResult.data || []), ...tableTrips].map((trip) => [trip.legacy_id, trip.id]));
    for (const trip of state.trips) {
      const normalizedTripId = tripIdsByLegacyId[trip.id];
      if (!normalizedTripId) continue;

      const deleteParticipants = await supabaseClient
        .from("trip_participants")
        .delete()
        .eq("trip_id", normalizedTripId);
      if (deleteParticipants.error) throw deleteParticipants.error;

      const uniqueParticipantIds = [...new Set(
        getTripParticipants(trip)
          .map((name) => memberIdsByName[name])
          .filter(Boolean)
      )];

      const participantPayloads = uniqueParticipantIds
        .map((memberId) => ({ trip_id: normalizedTripId, member_id: memberId }));

      if (participantPayloads.length) {
        const upsertParticipants = await supabaseClient
          .from("trip_participants")
          .upsert(participantPayloads, { onConflict: "trip_id,member_id" });
        if (upsertParticipants.error) throw upsertParticipants.error;
      }
    }

    const fuelPayloads = state.fuel.map((fuel) => {
      const liters = nullableNumber(fuel.liters);
      const amount = Number(fuel.amount || 0);
      return {
        legacy_id: fuel.id,
        ledger_id: ledgerId,
        period_id: openPeriodId,
        payer_member_id: memberIdsByName[fuel.payer] || null,
        payment_date: normalizedDate(fuel.date),
        amount,
        currency: state.currency || "DKK",
        liters,
        price_per_liter: liters ? roundMoney(amount / liters) : nullableNumber(fuel.pricePerLiter),
        odometer: nullableNumber(fuel.odometer),
        station_name: fuel.station || fuel.stationInfo?.name || null,
        station_brand: fuel.stationInfo?.brand || null,
        station_lat: fuel.stationInfo?.latitude || null,
        station_lng: fuel.stationInfo?.longitude || null,
        user_lat: fuel.location?.latitude || null,
        user_lng: fuel.location?.longitude || null,
        full_tank: Boolean(fuel.fullTank),
        created_by_member_id: currentMemberId,
        deleted_at: null,
        updated_at: new Date().toISOString()
      };
    }).filter((fuel) => fuel.legacy_id && fuel.amount > 0);

    if (fuelPayloads.length) {
      const upsertFuel = await supabaseClient
        .from("fuel_payments")
        .upsert(fuelPayloads, { onConflict: "ledger_id,legacy_id" });
      if (upsertFuel.error) throw upsertFuel.error;
    }

    const existingFuelResult = await supabaseClient
      .from("fuel_payments")
      .select("id,legacy_id")
      .eq("ledger_id", ledgerId)
      .eq("period_id", openPeriodId)
      .is("deleted_at", null);
    if (existingFuelResult.error) throw existingFuelResult.error;

    const activeFuelIds = new Set(state.fuel.map((fuel) => fuel.id));
    const fuelToSoftDelete = (existingFuelResult.data || []).filter((fuel) => fuel.legacy_id && !activeFuelIds.has(fuel.legacy_id));

    let skippedBookingSyncForTestLab = false;
    let existingBookings = [];
    if (suppressNormalizedBookingWrites) {
      skippedBookingSyncForTestLab = true;
    }

    const bookingPayloads = skippedBookingSyncForTestLab ? [] : state.bookings.map((booking) => ({
      legacy_id: booking.id,
      ledger_id: ledgerId,
      member_id: memberIdsByName[booking.member] || null,
      start_at: bookingDateTimeToIso(booking.start),
      end_at: bookingDateTimeToIso(booking.end),
      purpose: booking.purpose || null,
      created_by_member_id: currentMemberId,
      deleted_at: null,
      updated_at: new Date().toISOString()
    })).filter((booking) => booking.legacy_id && booking.member_id && booking.start_at && booking.end_at);

    if (!skippedBookingSyncForTestLab) {
      const existingBookingsResult = await supabaseClient
        .from("car_bookings")
        .select("id,legacy_id,member_id,start_at,end_at,purpose")
        .eq("ledger_id", ledgerId)
        .is("deleted_at", null);
      if (existingBookingsResult.error) throw existingBookingsResult.error;
      existingBookings = existingBookingsResult.data || [];
    }

    const isoKey = (value) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value || "") : date.toISOString();
    };
    const bookingSignature = (booking) => [
      booking.member_id || "",
      isoKey(booking.start_at),
      isoKey(booking.end_at),
      String(booking.purpose || "")
    ].join("|");
    const existingByLegacyId = new Map(existingBookings.filter((booking) => booking.legacy_id).map((booking) => [booking.legacy_id, booking]));
    const existingBySignature = new Map(existingBookings.map((booking) => [bookingSignature(booking), booking]));
    const sameBookingFields = (pair) => {
      const left = pair.left;
      const right = pair.right;
      return String(left.member_id || "") === String(right.member_id || "")
        && isoKey(left.start_at) === isoKey(right.start_at)
        && isoKey(left.end_at) === isoKey(right.end_at)
        && String(left.purpose || "") === String(right.purpose || "");
    };
    const bookingRangesOverlap = (pair) => {
      const left = pair.left;
      const right = pair.right;
      if (String(left.member_id || "") !== String(right.member_id || "")) return false;
      const leftStart = new Date(left.start_at).getTime();
      const leftEnd = new Date(left.end_at).getTime();
      const rightStart = new Date(right.start_at).getTime();
      const rightEnd = new Date(right.end_at).getTime();
      if ([leftStart, leftEnd, rightStart, rightEnd].some((value) => Number.isNaN(value))) return false;
      return leftStart < rightEnd && leftEnd > rightStart;
    };
    const findOverlappingExistingBooking = (query) => {
      const payload = query.payload;
      const allowedExistingId = query.allowedExistingId || null;
      return existingBookings.find((booking) => (
        (!allowedExistingId || booking.id !== allowedExistingId) && bookingRangesOverlap({ left: payload, right: booking })
      ));
    };
    const bookingPayloadsToInsert = [];
    const bookingPayloadsToUpdate = [];

    for (const payload of bookingPayloads) {
      const existingByLegacy = existingByLegacyId.get(payload.legacy_id);
      if (existingByLegacy) {
        if (sameBookingFields({ left: existingByLegacy, right: payload })) continue;
        if (findOverlappingExistingBooking({ payload, allowedExistingId: existingByLegacy.id })) continue;
        bookingPayloadsToUpdate.push({ id: existingByLegacy.id, payload });
        continue;
      }

      const matchingExisting = existingBySignature.get(bookingSignature(payload));
      if (matchingExisting) {
        bookingPayloadsToUpdate.push({ id: matchingExisting.id, payload });
        existingByLegacyId.set(payload.legacy_id, { ...matchingExisting, ...payload, id: matchingExisting.id });
        continue;
      }

      if (findOverlappingExistingBooking({ payload })) continue;
      bookingPayloadsToInsert.push(payload);
    }

    for (const item of bookingPayloadsToUpdate) {
      const updateResult = await supabaseClient
        .from("car_bookings")
        .update({
          legacy_id: item.payload.legacy_id,
          member_id: item.payload.member_id,
          start_at: item.payload.start_at,
          end_at: item.payload.end_at,
          purpose: item.payload.purpose,
          updated_at: item.payload.updated_at,
          deleted_at: null
        })
        .eq("id", item.id);
      if (updateResult.error) throw updateResult.error;
    }

    for (const payload of bookingPayloadsToInsert) {
      const insertResult = await supabaseClient
        .from("car_bookings")
        .insert(payload);
      if (insertResult.error) {
        if (!isBookingOverlapError(insertResult.error)) throw insertResult.error;
      }
    }

    const activeBookingIds = new Set(state.bookings.map((booking) => booking.id));
    const bookingsToSoftDelete = existingBookings.filter((booking) => booking.legacy_id && !activeBookingIds.has(booking.legacy_id));

    const canApplyReconciliationSoftDeletes = await ensureReconciliationSoftDeleteSafety({
      trips: tripsToSoftDelete.length,
      fuel: fuelToSoftDelete.length,
      bookings: bookingsToSoftDelete.length
    });

    const reconciliationSoftDeleteCount = tripsToSoftDelete.length + fuelToSoftDelete.length + bookingsToSoftDelete.length;

    if (canApplyReconciliationSoftDeletes) {
      for (const trip of tripsToSoftDelete) {
        const deleted = await supabaseClient
          .from("trips")
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", trip.id);
        if (deleted.error) throw deleted.error;
      }

      for (const fuel of fuelToSoftDelete) {
        const deleted = await supabaseClient
          .from("fuel_payments")
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", fuel.id);
        if (deleted.error) throw deleted.error;
      }

      for (const booking of bookingsToSoftDelete) {
        const deleted = await supabaseClient
          .from("car_bookings")
          .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", booking.id);
        if (deleted.error) throw deleted.error;
      }
    }

    normalizedTableStatus = {
      checked: true,
      ok: canApplyReconciliationSoftDeletes || reconciliationSoftDeleteCount === 0,
      message: !canApplyReconciliationSoftDeletes && reconciliationSoftDeleteCount > 0
        ? `Dual-write sync updated normalized rows but skipped ${reconciliationSoftDeleteCount} reconciliation soft-delete candidate${reconciliationSoftDeleteCount === 1 ? "" : "s"} until a fresh normalized-table load and pre-delete JSON backup are available.`
        : skippedBookingSyncForTestLab
          ? `Dual-write sync is active. Normalized members/trips/fuel were updated from JSON; booking writes were skipped for a temporary Test Lab run (${getMemberNames().length} members, ${state.trips.length} trips, ${state.fuel.length} fuel logs).`
          : `Dual-write sync is active. Normalized tables were updated from JSON (${getMemberNames().length} members, ${state.trips.length} trips, ${state.bookings.length} bookings, ${state.fuel.length} fuel logs).`,
      details: canApplyReconciliationSoftDeletes
        ? [`Reconciliation soft-deletes applied: ${tripsToSoftDelete.length} trips, ${fuelToSoftDelete.length} fuel logs, ${bookingsToSoftDelete.length} bookings.`]
        : [`Reconciliation soft-deletes skipped: ${tripsToSoftDelete.length} trips, ${fuelToSoftDelete.length} fuel logs, ${bookingsToSoftDelete.length} bookings.`]
    };
  } catch (error) {
    console.warn("Normalized table dual-write failed", error);
    normalizedTableStatus = {
      checked: true,
      ok: false,
      message: `JSON was saved, but normalized table dual-write failed: ${error.message || error}`
    };
  }

  render();
}



async function loadStateFromNormalizedTables(jsonFallbackState) {
  recordSupabaseLoadEvent("normalized-table-load", "loadStateFromNormalizedTables");
  if (!supabaseClient || !currentSession) return null;
  if (!(await hasFreshSupabaseSession())) return null;

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const renderStateRows = await getRenderNormalizedStateRows(ledgerId);
  let participantResult = { data: [], error: null };
  let membersResult;
  let periodsResult;
  let tripsResult;
  let fuelResult;
  let bookingsResult;
  let requestsResult;

  if (renderStateRows) {
    membersResult = { data: renderStateRows.members || [], error: null };
    periodsResult = { data: renderStateRows.periods || [], error: null };
    tripsResult = { data: renderStateRows.trips || [], error: null };
    fuelResult = { data: renderStateRows.fuel || [], error: null };
    bookingsResult = { data: renderStateRows.bookings || [], error: null };
    requestsResult = { data: renderStateRows.requests || [], error: null };
    participantResult = { data: renderStateRows.tripParticipants || [], error: null };
  } else {
    [membersResult, periodsResult, tripsResult, fuelResult, bookingsResult, requestsResult] = await Promise.all([
      supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId).eq("is_active", true).order("created_at", { ascending: true }),
      supabaseClient.from("settlement_periods").select("id,status,label,closed_at,snapshot_json,created_at").eq("ledger_id", ledgerId).order("created_at", { ascending: true }),
      supabaseClient.from("trips").select("id,legacy_id,period_id,driver_member_id,trip_date,start_km,end_km,note,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("trip_date", { ascending: true }),
      supabaseClient.from("fuel_payments").select("id,legacy_id,period_id,payer_member_id,payment_date,amount,currency,liters,price_per_liter,odometer,station_name,station_brand,station_lat,station_lng,user_lat,user_lng,full_tank,deleted_at,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("payment_date", { ascending: true }),
      supabaseClient.from("car_bookings").select("id,legacy_id,member_id,start_at,end_at,purpose,deleted_at,created_by_member_id,created_at").eq("ledger_id", ledgerId).is("deleted_at", null).order("start_at", { ascending: true }),
      supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status").eq("ledger_id", ledgerId)
    ]);
  }

  const firstError = [membersResult, periodsResult, tripsResult, fuelResult, bookingsResult, requestsResult, participantResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const linkedWorkspace = getLinkedWorkspaceForActiveLedger();
  const renderLedger = renderStateRows && renderStateRows.ledger && typeof renderStateRows.ledger === "object" ? renderStateRows.ledger : null;
  const ledger = renderLedger || {
    id: ledgerId,
    name: linkedWorkspace?.name || jsonFallbackState?.ledgerName || "Fuel Ledger",
    currency: jsonFallbackState?.currency || defaults.currency,
    fuel_type: jsonFallbackState?.fuelType || defaults.fuelType,
    estimated_consumption_l_per_100km: Number(jsonFallbackState?.fuelConsumption) || defaults.fuelConsumption,
    fuel_tank_capacity_l: Number(jsonFallbackState?.fuelTankCapacity) || defaults.fuelTankCapacity,
    fallback_fuel_price: Number(jsonFallbackState?.fuelFallbackPrice) || defaults.fuelFallbackPrice,
    low_fuel_threshold_percent: Number(jsonFallbackState?.fuelWarningThreshold) || defaults.fuelWarningThreshold
  };
  const members = membersResult.data || [];
  const periods = periodsResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const tableBookings = bookingsResult.data || [];
  const tableRequests = requestsResult.data || [];
  let openPeriod = periods.find((period) => period.status === "open") || null;
  if (!openPeriod && ledger && members.length) {
    const openPeriodId = await ensureOpenSettlementPeriod(ledgerId);
    openPeriod = { id: openPeriodId, status: "open", label: "Current period", created_at: new Date().toISOString() };
    recordSupabaseLoadEvent("normalized-open-period-created", ledgerId);
  }

  if (!ledger || members.length === 0 || !openPeriod) return null;

  const memberById = Object.fromEntries(members.map((member) => [member.id, member]));
  const memberNames = members.map((member) => member.name).filter(Boolean);
  const memberProfiles = Object.fromEntries(
    members.map((member) => [
      member.name,
      {
        email: normalizeEmail(member.email || ""),
        role: member.role === "admin" ? "admin" : "member",
        mobilepayPhone: normalizePhone(member.mobilepay_phone || "")
      }
    ])
  );

  if (!renderStateRows) {
    participantResult = tableTrips.length
      ? await supabaseClient
          .from("trip_participants")
          .select("trip_id,member_id")
          .in("trip_id", tableTrips.map((trip) => trip.id))
      : { data: [], error: null };
  }
  if (participantResult.error) throw participantResult.error;

  const participantNamesByTripId = {};
  for (const participant of participantResult.data || []) {
    const memberName = memberById[participant.member_id]?.name;
    if (!memberName) continue;
    if (!participantNamesByTripId[participant.trip_id]) participantNamesByTripId[participant.trip_id] = [];
    participantNamesByTripId[participant.trip_id].push(memberName);
  }

  const activeTrips = tableTrips.filter((trip) => !openPeriod || !trip.period_id || trip.period_id === openPeriod.id);
  const activeFuel = tableFuel.filter((fuel) => !openPeriod || !fuel.period_id || fuel.period_id === openPeriod.id);
  const fallbackTripsById = Object.fromEntries((jsonFallbackState.trips || []).map((trip) => [trip.id, trip]));
  const fallbackFuelById = Object.fromEntries((jsonFallbackState.fuel || []).map((fuel) => [fuel.id, fuel]));

  // Safety fallback: if normalized tables are empty but the JSON mirror still has
  // active rows, keep using JSON instead of showing an empty settlement period.
  // This protects users from partial/failed dual-write deployments.
  if (activeTrips.length === 0 && activeFuel.length === 0 && tableBookings.length === 0 && ((jsonFallbackState.trips || []).length || (jsonFallbackState.fuel || []).length || (jsonFallbackState.bookings || []).length)) {
    return null;
  }

  const trips = activeTrips.map((trip) => {
    const driver = memberById[trip.driver_member_id]?.name || memberNames[0] || "";
    const participants = participantNamesByTripId[trip.id]?.length ? [...new Set(participantNamesByTripId[trip.id])] : (driver ? [driver] : []);
    const legacyId = trip.legacy_id || trip.id;
    const fallbackTrip = fallbackTripsById[legacyId] || {};
    return {
      id: legacyId,
      logRef: fallbackTrip.logRef || createLogRef(legacyId),
      sourceBookingId: fallbackTrip.sourceBookingId || null,
      bookingStart: fallbackTrip.bookingStart || null,
      bookingEnd: fallbackTrip.bookingEnd || null,
      driver,
      date: normalizedDate(trip.trip_date),
      startKm: round(Number(trip.start_km || 0)),
      endKm: round(Number(trip.end_km || 0)),
      participants,
      note: trip.note || fallbackTrip.note || ""
    };
  });

  const fuel = activeFuel.map((item) => {
    const payer = memberById[item.payer_member_id]?.name || memberNames[0] || "";
    const liters = Number(item.liters || 0) > 0 ? round(Number(item.liters)) : "";
    const amount = roundMoney(Number(item.amount || 0));
    const stationName = item.station_name || "";
    const hasUserLocation = Number.isFinite(Number(item.user_lat)) && Number.isFinite(Number(item.user_lng));
    const hasStationLocation = Number.isFinite(Number(item.station_lat)) && Number.isFinite(Number(item.station_lng));
    const legacyId = item.legacy_id || item.id;
    const fallbackFuel = fallbackFuelById[legacyId] || {};
    return {
      id: legacyId,
      logRef: fallbackFuel.logRef || createLogRef(legacyId),
      sourceTripId: fallbackFuel.sourceTripId || null,
      sourceBookingId: fallbackFuel.sourceBookingId || null,
      bookingStart: fallbackFuel.bookingStart || null,
      bookingEnd: fallbackFuel.bookingEnd || null,
      payer,
      date: normalizedDate(item.payment_date),
      amount,
      liters,
      pricePerLiter: liters ? roundMoney(amount / liters) : (Number(item.price_per_liter || 0) > 0 ? roundMoney(Number(item.price_per_liter)) : ""),
      odometer: Number(item.odometer || 0) > 0 ? round(Number(item.odometer)) : "",
      station: stationName,
      location: hasUserLocation ? { latitude: Number(item.user_lat), longitude: Number(item.user_lng) } : null,
      stationInfo: hasStationLocation
        ? {
            name: stationName,
            brand: item.station_brand || "",
            latitude: Number(item.station_lat),
            longitude: Number(item.station_lng)
          }
        : null,
      fullTank: Boolean(item.full_tank || fallbackFuel.fullTank)
    };
  });

  const bookings = tableBookings.map((item) => ({
    id: item.legacy_id || item.id,
    member: memberById[item.member_id]?.name || memberNames[0] || "",
    start: toDateTimeLocalInputValue(item.start_at),
    end: toDateTimeLocalInputValue(item.end_at),
    purpose: item.purpose || "",
    createdBy: memberById[item.created_by_member_id]?.name || ""
  }));

  const closedPeriodSnapshotsFromTables = periods
    .filter((period) => period.status === "closed" && period.snapshot_json)
    .map((period) => period.snapshot_json);

  const closedPeriodsFromTables = mergeClosedPeriodPaymentState(
    closedPeriodSnapshotsFromTables,
    jsonFallbackState.closedPeriods
  );

  const paymentStatusesFromTables = {};
  const activeRequests = tableRequests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
  for (const request of activeRequests) {
    const fromName = memberById[request.from_member_id]?.name;
    const toName = memberById[request.to_member_id]?.name;
    if (!fromName || !toName) continue;
    const key = settlementKeyForPeriod({
      from: fromName,
      to: toName,
      currency: request.currency || ledger.currency || jsonFallbackState.currency || "DKK"
    }, openPeriod.id);
    paymentStatusesFromTables[key] = normalizePaymentStatus(request.status);
  }

  lastNormalizedTableLoadAt = Date.now();
  cachePaymentWriteContext({
    ledgerId,
    openPeriodId: openPeriod.id,
    memberIdsByName: Object.fromEntries(members.map((member) => [member.name, member.id])),
    currentMemberId: members.find((member) => String(member.email || "").toLowerCase() === String(currentSession?.user?.email || "").toLowerCase())?.id || null
  });

  return normalizeState({
    ...jsonFallbackState,
    currency: ledger.currency || defaults.currency,
    fuelType: ledger.fuel_type || defaults.fuelType,
    fuelConsumption: Number(ledger.estimated_consumption_l_per_100km) || defaults.fuelConsumption,
    fuelTankCapacity: Number(ledger.fuel_tank_capacity_l) || defaults.fuelTankCapacity,
    fuelFallbackPrice: Number(ledger.fallback_fuel_price) || defaults.fuelFallbackPrice,
    fuelWarningThreshold: Number(ledger.low_fuel_threshold_percent) || defaults.fuelWarningThreshold,
    vehiclePlate: normalizeVehiclePlateInput(ledger.vehicle_plate || jsonFallbackState.vehiclePlate || ""),
    vehicleInfo: normalizeVehicleInfo(ledger.vehicle_info || jsonFallbackState.vehicleInfo),
    vehicleLookupSource: ledger.vehicle_lookup_source || jsonFallbackState.vehicleLookupSource || (ledger.vehicle_info ? "lookup" : "manual"),
    vehicleLookupAt: ledger.vehicle_lookup_at || jsonFallbackState.vehicleLookupAt || "",
    members: memberNames,
    memberProfiles,
    trips,
    bookings,
    fuel,
    currentPeriodId: openPeriod.id,
    paymentStatuses: paymentStatusesFromTables,
    closedPeriods: closedPeriodsFromTables.length ? closedPeriodsFromTables : jsonFallbackState.closedPeriods
  });
}


function mergeClosedPeriodPaymentState(tablePeriods, jsonPeriods) {
  const normalizedTablePeriods = Array.isArray(tablePeriods) ? tablePeriods : [];
  const normalizedJsonPeriods = Array.isArray(jsonPeriods) ? jsonPeriods : [];
  if (!normalizedTablePeriods.length) return normalizedJsonPeriods;
  if (!normalizedJsonPeriods.length) return normalizedTablePeriods;

  const jsonById = new Map(normalizedJsonPeriods
    .filter((period) => period && period.id)
    .map((period) => [period.id, period]));

  return normalizedTablePeriods.map((tablePeriod) => {
    const jsonPeriod = jsonById.get(tablePeriod?.id);
    if (!jsonPeriod) return tablePeriod;

    const jsonSettlements = Array.isArray(jsonPeriod.settlements) ? jsonPeriod.settlements : [];
    const jsonSettlementByKey = new Map(jsonSettlements.map((settlement, index) => [
      settlementKeyForPeriod(settlement, jsonPeriod.id || tablePeriod.id || `closed-${index}`),
      settlement
    ]));

    const mergedSettlements = Array.isArray(tablePeriod.settlements)
      ? tablePeriod.settlements.map((settlement, index) => {
          const key = settlementKeyForPeriod(settlement, tablePeriod.id || `closed-${index}`);
          const jsonSettlement = jsonSettlementByKey.get(key) || jsonSettlements[index];
          if (!jsonSettlement) return settlement;
          return {
            ...settlement,
            status: normalizePaymentStatus(jsonSettlement.status || settlement.status)
          };
        })
      : [];

    return {
      ...tablePeriod,
      settlements: mergedSettlements,
      auditLog: Array.isArray(jsonPeriod.auditLog) && jsonPeriod.auditLog.length
        ? auditLog.normalizeAuditEntries(jsonPeriod.auditLog)
        : tablePeriod.auditLog
    };
  });
}

async function checkNormalizedTablesAgainstCurrentState({ force = false, silent = false, reason = "manual" } = {}) {
  if (!supabaseClient || !currentSession) return;
  const now = Date.now();
  if (supabaseLoadSafety.normalizedCheckInFlight) return;
  if (!force && now - supabaseLoadSafety.lastNormalizedCheckAt < supabaseLoadSafety.normalizedCheckCooldownMs) {
    return;
  }
  supabaseLoadSafety.normalizedCheckInFlight = true;
  supabaseLoadSafety.lastNormalizedCheckAt = now;
  recordSupabaseLoadEvent(`normalized-health:${reason}`);
  try {
  if (!(await hasFreshSupabaseSession())) return;

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const [membersResult, tripsResult, fuelResult, bookingsResult, periodsResult, requestsResult] = await Promise.all([
    supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId),
    supabaseClient.from("trips").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("fuel_payments").select("id,period_id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("car_bookings").select("id,deleted_at").eq("ledger_id", ledgerId).is("deleted_at", null),
    supabaseClient.from("settlement_periods").select("id,status").eq("ledger_id", ledgerId),
    supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,currency,status,paid_at").eq("ledger_id", ledgerId)
  ]);

  const firstError = [membersResult, tripsResult, fuelResult, bookingsResult, periodsResult, requestsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const tableMembers = membersResult.data || [];
  const tableTrips = tripsResult.data || [];
  const tableFuel = fuelResult.data || [];
  const tableBookings = bookingsResult.data || [];
  const tablePeriods = periodsResult.data || [];
  const tableRequests = requestsResult.data || [];
  const activeMembers = tableMembers.filter((member) => member.is_active !== false);
  const openPeriod = tablePeriods.find((period) => period.status === "open") || null;
  const activeTableTrips = tableTrips.filter((trip) => !openPeriod || !trip.period_id || trip.period_id === openPeriod.id);
  const activeTableFuel = tableFuel.filter((fuel) => !openPeriod || !fuel.period_id || fuel.period_id === openPeriod.id);
  const admins = activeMembers.filter((member) => member.role === "admin");
  const membersWithoutEmail = activeMembers.filter((member) => !member.email);
  const mismatchParts = [];

  if (activeMembers.length !== getMemberNames().length) {
    mismatchParts.push(`members ${activeMembers.length} in tables vs ${getMemberNames().length} in app`);
  }

  if (activeTableTrips.length !== state.trips.length) {
    mismatchParts.push(`trips ${activeTableTrips.length} in the open table period vs ${state.trips.length} in app`);
  }

  if (activeTableFuel.length !== state.fuel.length) {
    mismatchParts.push(`fuel logs ${activeTableFuel.length} in the open table period vs ${state.fuel.length} in app`);
  }

  if (tableBookings.length !== state.bookings.length) {
    mismatchParts.push(`bookings ${tableBookings.length} in the table vs ${state.bookings.length} in app`);
  }

  const openPeriods = tablePeriods.filter((period) => period.status === "open").length;
  if (openPeriods !== 1) {
    mismatchParts.push(`${openPeriods} open normalized periods`);
  }

  const activeTableRequests = tableRequests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
  const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
  const currentActiveRequests = activeTableRequests.filter((request) => {
    const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
    const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
    if (!fromName || !toName) return false;
    return currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
  });
  const staleActiveRequests = activeTableRequests.length - currentActiveRequests.length;
  const requestedStatuses = calculateLedger().settlements.filter(
    (settlement) => ["requested", "paid"].includes(normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]))
  ).length;
  const requestedTableStatuses = currentActiveRequests.filter((request) => ["requested", "paid"].includes(normalizePaymentStatus(request.status))).length;
  if (requestedTableStatuses !== requestedStatuses) {
    mismatchParts.push(`requested payments ${requestedTableStatuses} current table rows vs ${requestedStatuses} visible in app`);
  }
  if (staleActiveRequests > 0) {
    mismatchParts.push(`${staleActiveRequests} stale settlement request row${staleActiveRequests === 1 ? "" : "s"} from old payment lines`);
  }

  if (!admins.length) {
    mismatchParts.push("no normalized admin user");
  }

  const normalizedDetails = [
    {
      level: activeMembers.length === getMemberNames().length && admins.length ? "ok" : "warning",
      title: "Normalized members",
      message: `${activeMembers.length} active table member${activeMembers.length === 1 ? "" : "s"}; ${getMemberNames().length} in the app; ${admins.length} admin${admins.length === 1 ? "" : "s"}.`
    },
    {
      level: activeTableTrips.length === state.trips.length ? "ok" : "warning",
      title: "Normalized trips",
      message: `${activeTableTrips.length} open-period table trip${activeTableTrips.length === 1 ? "" : "s"}; ${state.trips.length} visible requested/paid in the app.`
    },
    {
      level: activeTableFuel.length === state.fuel.length ? "ok" : "warning",
      title: "Normalized fuel logs",
      message: `${activeTableFuel.length} open-period table fuel log${activeTableFuel.length === 1 ? "" : "s"}; ${state.fuel.length} visible requested/paid in the app.`
    },
    {
      level: tableBookings.length === state.bookings.length ? "ok" : "warning",
      title: "Normalized bookings",
      message: `${tableBookings.length} table booking${tableBookings.length === 1 ? "" : "s"}; ${state.bookings.length} visible in the app.`
    },
    {
      level: openPeriods === 1 ? "ok" : "warning",
      title: "Normalized open period",
      message: openPeriods === 1 ? "Exactly one open settlement period exists." : `${openPeriods} open settlement periods found.`
    },
    {
      level: requestedTableStatuses === requestedStatuses && staleActiveRequests === 0 ? "ok" : "warning",
      title: "Normalized payment requests",
      message: staleActiveRequests
        ? `${requestedTableStatuses} requested/paid current payment${requestedTableStatuses === 1 ? "" : "s"}; ${requestedStatuses} visible requested/paid in the app; ${staleActiveRequests} stale request row${staleActiveRequests === 1 ? "" : "s"} ignored.`
        : `${requestedTableStatuses} requested/paid current payment${requestedTableStatuses === 1 ? "" : "s"}; ${requestedStatuses} visible requested/paid in the app.`
    }
  ];

  normalizedTableStatus = {
    checked: true,
    ok: mismatchParts.length === 0,
    message: mismatchParts.length
      ? `Normalized table check found: ${mismatchParts.join("; ")}. JSON remains available as fallback until this is resolved.`
      : normalizedReadModeActive
        ? `Reading from normalized tables first; open period tables match the app state.`
        : `Normalized tables match the current JSON counts.`,
    details: normalizedDetails,
    membersWithoutEmail: membersWithoutEmail.length,
    admins: admins.length
  };

  if (!silent) render();
  } finally {
    supabaseLoadSafety.normalizedCheckInFlight = false;
  }
}

async function loadRemoteState() {
  recordSupabaseLoadEvent(supabaseClient ? "supabase-load" : "server-load", "loadRemoteState");
  if (supabaseClient) {
    await loadSupabaseStateWithTimeout(
      { reason: "loadRemoteState" },
      supabaseStartupLoadTimeoutMs,
      "Cloud sync is delayed. You can keep using local data."
    );
    return;
  }

  try {
    setSyncStatus("Syncing", { source: "server-load" });
    const response = await fetch(apiStateUrl);
    if (!response.ok) throw new Error("State request failed");
    const remoteState = normalizeState(await response.json());
    const localState = loadState();
    const localHasData = hasLedgerData(localState);
    const remoteHasData = hasLedgerData(remoteState);
    const localIsNewer = localHasData && stateUpdatedMs(localState) > stateUpdatedMs(remoteState);
    state = (!remoteHasData && localHasData) || localIsNewer ? localState : remoteState;
    state.lastOdometer = getLatestOdometer();
    writeLocalState();
    setDefaultDates();
    render();
    if (state === localState) {
      markLocalChangeQueued();
      queueRemoteSave();
    } else {
      markRemoteSaveSucceeded("Shared");
    }
  } catch (error) {
    markRemoteSaveFailed(error);
  }
}

async function saveRemoteState() {
  if (supabaseClient && suppressNextQueuedRemoteSaveReason && Date.now() - Number(lastRenderJsonMirrorBackupAt || 0) < 30000) {
    const reason = suppressNextQueuedRemoteSaveReason;
    suppressNextQueuedRemoteSaveReason = "";
    recordSupabaseLoadEvent("browser-full-state-save-skip", reason || "recent Render JSON mirror backup already saved current state");
    markRemoteSaveSucceeded("Tables");
    return;
  }
  recordSupabaseLoadEvent(supabaseClient ? "supabase-save" : "server-save", "saveRemoteState");
  if (supabaseClient) {
    await saveSupabaseState();
    return;
  }

  try {
    setSyncStatus("Saving", { source: "server-save" });
    const response = await fetch(apiStateUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    if (!response.ok) throw new Error("State save failed");
    state = normalizeState(await response.json());
    writeLocalState();
    markRemoteSaveSucceeded("Shared");
  } catch (error) {
    markRemoteSaveFailed(error);
  }
}

function markSupabaseLoadTimedOut(reason = "load-timeout") {
  if (!supabaseLoadInFlight) return;
  supabaseLoadInFlight = false;
  supabaseLoadStartedAt = 0;
  supabaseLoadToken += 1;
  recordSupabaseLoadEvent("supabase-load-timeout", reason);
  renderSupabaseLoadMonitor();
}

function isCurrentSupabaseLoad(loadToken) {
  return supabaseLoadInFlight && loadToken === supabaseLoadToken;
}

function isAdminDiagnosticsLoadReason(reason = "") {
  return reason === "manual-admin" || reason === "admin-diagnostics" || /^admin-/.test(String(reason || ""));
}

async function tryRenderAdminDiagnosticsStateLoad(reason, loadToken, jsonFallbackState) {
  if (!isAdminDiagnosticsLoadReason(reason)) return false;

  try {
    const normalizedState = await loadStateFromNormalizedTables(jsonFallbackState || state);
    if (!normalizedState) return false;
    if (!isCurrentSupabaseLoad(loadToken)) {
      recordSupabaseLoadEvent("supabase-load-stale-result", `admin render state (${reason})`);
      return false;
    }

    normalizedReadModeActive = true;
    applyIncomingState(normalizedState, "Tables");
    lastCloudSyncAt = new Date().toISOString();
    lastSyncError = "";
    lastCloudRetryAt = "";
    lastSyncDiagnostic = null;
    normalizedTableStatus = {
      checked: true,
      ok: true,
      message: `Reading from Render normalized state first; trips/bookings/fuel write to tables first (${normalizedState.members.length} members, ${normalizedState.trips.length} trips, ${normalizedState.bookings.length} bookings, ${normalizedState.fuel.length} fuel logs). JSON remains available as fallback.`
    };
    await loadCloudTestLabReports({ reason: "load normalized Test Lab report history after admin Render state load" });
    scheduleNormalizedTableCheck({ delayMs: 120000, reason: "admin-render-load" });
    clearSyncDelay(`admin-render-load-success:${reason}`);
    recordSupabaseLoadEvent("render-admin-diagnostics-load", reason);
    recordSyncDiagnostic("admin-render-load-success", "Admin diagnostics refreshed from Render state load.", { reason, route: "render-api", endpoint: renderStateLoadUrl });
    markActiveWorkspaceConfirmed(reason);
    setSyncStatus("Tables");
    return true;
  } catch (error) {
    recordSyncDiagnostic("admin-render-load-fallback", error?.message || "Admin Render state load failed; falling back to legacy load.", { reason, error });
    return false;
  }
}

async function loadSupabaseState(options = {}) {
  const { force = false, reason = "loadSupabaseState" } = options || {};
  recordSupabaseLoadEvent("supabase-load", reason);
  if (!currentSession) {
    setSyncStatus("Login");
    return false;
  }

  const now = Date.now();
  if (shouldDeferBackgroundCloudLoad(reason, now)) {
    recordSupabaseLoadEvent("supabase-load-skip", `deferred during foreground write (${reason})`);
    recordSyncDiagnostic("background-load-deferred", `${reason} was deferred because a foreground write is active.`, { reason, pendingSettlementRequests: pendingSettlementRequestKeys.size });
    renderSupabaseLoadMonitor();
    return false;
  }
  if (supabaseLoadInFlight) {
    const loadAgeMs = now - Number(supabaseLoadStartedAt || lastSupabaseLoadAt || 0);
    if (loadAgeMs > supabaseStaleLoadMs) {
      markSupabaseLoadTimedOut(`stale load replaced (${reason})`);
    } else {
      recordSupabaseLoadEvent("supabase-load-skip", `already loading (${reason})`);
      if (/^manual-/.test(reason)) {
        recordSyncDiagnostic("manual-load-skipped-existing-sync", `Manual sync skipped because another cloud load is already running.`, { reason, loadAgeMs });
      }
      return false;
    }
  }
  if (!force && now - lastSupabaseLoadAt < supabaseLoadCooldownMs) {
    recordSupabaseLoadEvent("supabase-load-skip", `cooldown (${reason})`);
    return false;
  }

  supabaseLoadInFlight = true;
  supabaseLoadStartedAt = now;
  const loadToken = ++supabaseLoadToken;
  lastSupabaseLoadAt = now;
  markActiveWorkspaceLoading(reason);

  try {
    clearRecoverableSyncDelayAfterHealthySync(`load-start:${reason}`);
    setSyncStatus("Syncing", { source: reason });
    recordSyncDiagnostic("load-start", reason, { force });

    if (await tryRenderAdminDiagnosticsStateLoad(reason, loadToken, state)) {
      return true;
    }

    const { data, error } = await supabaseClient
      .from("car_share_ledgers")
      .select("state,updated_at")
      .eq("id", supabaseHelpers.getLedgerId(supabaseConfig))
      .maybeSingle();

    if (error) {
      recordSyncDiagnostic("json-mirror-load-error", error.message || "Could not read car_share_ledgers.", { reason, error });
      throw error;
    }
    if (!data) {
      recordSupabaseLoadEvent("supabase-json-mirror-missing", reason);
      recordSyncDiagnostic("json-mirror-missing", "No JSON mirror row returned for this ledger.", { reason });
    }
    if (!isCurrentSupabaseLoad(loadToken)) {
      recordSupabaseLoadEvent("supabase-load-stale-result", reason);
      return false;
    }

    lastCloudSaveAt = data?.updated_at || new Date().toISOString();
    lastCloudSyncAt = new Date().toISOString();
    lastJsonMirrorSaveAt = data?.updated_at || "";
    lastSyncError = "";
    lastCloudRetryAt = "";
    lastSyncDiagnostic = null;
    if (els.authMessage && currentSession) els.authMessage.textContent = `Signed in as ${currentSession.user.email}.`;
    const jsonState = normalizeState(data?.state || null);
    let loadedFromTables = false;

    try {
      const normalizedState = await loadStateFromNormalizedTables(jsonState);
      if (normalizedState) {
        if (!isCurrentSupabaseLoad(loadToken)) {
          recordSupabaseLoadEvent("supabase-load-stale-result", `normalized tables (${reason})`);
          return false;
        }
        normalizedReadModeActive = true;
        applyIncomingState(normalizedState, "Tables");
        loadedFromTables = true;
        normalizedTableStatus = {
          checked: true,
          ok: true,
          message: `Reading from normalized tables first; trips/bookings/fuel write to tables first (${normalizedState.members.length} members, ${normalizedState.trips.length} trips, ${normalizedState.bookings.length} bookings, ${normalizedState.fuel.length} fuel logs). JSON remains available as fallback.`
        };
      }
    } catch (tableError) {
      normalizedTableStatus = {
        checked: true,
        ok: false,
        message: `Could not read normalized tables, so JSON was used as fallback: ${tableError.message || tableError}`
      };
      recordSyncDiagnostic("normalized-table-fallback", tableError.message || "Could not read normalized tables.", { reason, error: tableError });
    }

    if (!loadedFromTables) {
      if (!isCurrentSupabaseLoad(loadToken)) {
        recordSupabaseLoadEvent("supabase-load-stale-result", `json fallback (${reason})`);
        return false;
      }
      normalizedReadModeActive = false;
      applyIncomingState(jsonState, "Cloud");
      await syncNormalizedTablesFromJson();
    }

    if (!isCurrentSupabaseLoad(loadToken)) {
      recordSupabaseLoadEvent("supabase-load-stale-result", `post-load (${reason})`);
      return false;
    }
    await loadCloudTestLabReports({ reason: "load normalized Test Lab report history after cloud state load" });
    scheduleNormalizedTableCheck({ delayMs: 120000, reason: "load" });
    if (ensureMemberForLoggedInUser()) await saveSupabaseState({ reason: "member-bootstrap" });
    clearSyncDelay(`load-success:${reason}`);
    recordSyncDiagnostic("load-success", loadedFromTables ? "Loaded from normalized tables." : "Loaded from JSON mirror fallback.", { reason, loadedFromTables });
    markActiveWorkspaceConfirmed(reason);
    setSyncStatus(loadedFromTables ? "Tables" : "Cloud");
    return true;
  } catch (error) {
    markActiveWorkspaceLoadFailed(reason);
    lastSyncError = error.message || "Could not load cloud data.";
    lastCloudRetryAt = new Date().toISOString();
    recordSyncDiagnostic("load-error", lastSyncError, { reason, error });
    els.authMessage.textContent = `${lastSyncError} The app could not load the shared cloud data.`;
    setSyncStatus("Delayed");
    return false;
  } finally {
    if (isCurrentSupabaseLoad(loadToken)) {
      supabaseLoadInFlight = false;
      supabaseLoadStartedAt = 0;
      if (els.syncStatus && String(els.syncStatus.dataset.status || "") === "syncing") {
        if (lastSyncError) {
          setSyncStatus("Delayed");
        } else {
          setSyncStatus(normalizedReadModeActive ? "Tables" : "Cloud");
        }
      }
    }
    renderSupabaseLoadMonitor();
  }
}



function classifyJsonMirrorBackupReason(reason = "", force = false) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (/manual|save-json-backup|admin manual/.test(normalized)) return "manual";
  if (/audit|scheduled json mirror backup|deferred audit/.test(normalized)) return "audit-cadence";
  if (/safety backup|json mirror backup|backup before|cleanup|reset|import|close current period|period close|retention|generated|test lab|reconciliation|purge|production activity/.test(normalized)) return "safety";
  if (force && /backup/.test(normalized)) return "safety";
  return "";
}

function isJsonMirrorBackupReasonAllowed(reason = "", force = false) {
  return Boolean(classifyJsonMirrorBackupReason(reason, force));
}

function markNormalizedReconciliationDirty(reason = "state-change") {
  normalizedReconciliationDirty = true;
  recordSupabaseLoadEvent("normalized-reconciliation-dirty", reason);
}

function shouldRunNormalizedReconciliation(reason = "saveSupabaseState") {
  if (!supabaseClient || !currentSession) return false;
  if (!normalizedReadModeActive) return true;
  if (normalizedReconciliationDirty) return true;
  return /member|settings|reset|import|test-lab|generated|reconciliation|bootstrap/i.test(String(reason || ""));
}

function scheduleJsonMirrorBackup(delayMs = auditJsonMirrorBackupIntervalMs) {
  if (!supabaseClient || !currentSession || !canManageSettings()) return;
  if (jsonMirrorBackupTimer) return;
  jsonMirrorBackupTimer = window.setTimeout(async () => {
    jsonMirrorBackupTimer = null;
    if (!auditLogDirty) return;
    try {
      const saved = await saveJsonMirrorBackup({ force: true, reason: "deferred audit JSON mirror backup" });
      if (saved) auditLogDirty = false;
    } catch (error) {
      console.warn("Deferred JSON mirror backup failed", error);
    }
  }, Math.max(1000, Number(delayMs) || auditJsonMirrorBackupIntervalMs));
}

async function saveSupabaseState(options = {}) {
  const { reason = "saveSupabaseState" } = options || {};
  recordSupabaseLoadEvent("supabase-save", reason);
  if (!currentSession) {
    setSyncStatus("Login");
    return;
  }

  try {
    setSyncStatus("Saving", { source: reason });
    ignoreRealtimeUntil = Date.now() + 1500;

    // Phase 2AB: normalized row/RPC writes are primary for routine trip, fuel,
    // booking, and payment changes. Avoid full JSON-to-table reconciliation on
    // every save; only run it when an admin/settings/import/reset/test-lab path
    // marked broader state as dirty or when normalized read mode is not active.
    if (shouldRunNormalizedReconciliation(reason)) {
      await syncNormalizedTablesFromJson();
      normalizedReconciliationDirty = false;
    } else {
      recordSupabaseLoadEvent("normalized-reconciliation-skip", `table-primary save (${reason})`);
    }

    // Audit entries still live in the JSON mirror, but a trip+fuel burst should
    // not upsert the full state twice. Save audit changes on a shorter mirror
    // cadence and keep a deferred backup armed if the cadence blocks this save.
    if (auditLogDirty) {
      const savedAuditMirror = await maybeSaveJsonMirrorBackup({
        minIntervalMs: auditJsonMirrorBackupIntervalMs,
        reason: "audit JSON mirror backup"
      });
      if (savedAuditMirror) {
        auditLogDirty = false;
      } else {
        scheduleJsonMirrorBackup();
      }
    } else {
      recordSupabaseLoadEvent("json-mirror-manual-only", `table-primary save (${reason}); JSON mirror unchanged`);
    }

    lastCloudSaveAt = new Date().toISOString();
    lastCloudSyncAt = lastCloudSaveAt;
    lastSyncError = "";
    lastCloudRetryAt = "";
    markRemoteSaveSucceeded("Tables");
    scheduleNormalizedTableCheck({ delayMs: 180000, reason: "save" });
    if (reason !== "member-bootstrap" && !reason.startsWith("test-lab")) {
      publishLedgerEvent({
        type: "ledger_updated",
        title: "Shared ledger updated",
        body: `${ledgerEventActorName()} saved new shared ledger changes.`,
        metadata: { reason }
      }).catch((error) => console.warn("Ledger event publish failed", error));
    }
    if (ensureMemberForLoggedInUser()) await saveSupabaseState({ reason: "member-bootstrap" });
  } catch (error) {
    markRemoteSaveFailed(error, "Could not save table data.");
    els.authMessage.textContent = `${lastSyncError} Changes on this device may not be saved to the cloud.`;
  }
}

async function maybeSaveJsonMirrorBackup(options = {}) {
  const { minIntervalMs = jsonMirrorBackupIntervalMs, reason = "scheduled JSON mirror backup" } = options || {};
  const lastSaved = Number(localStorage.getItem(`${makeWorkspaceScopedStorageKey()}:jsonMirrorSavedAt`) || 0);
  if (Date.now() - lastSaved < minIntervalMs) {
    recordSupabaseLoadEvent("json-mirror-skip", `${reason}; interval not reached`);
    return false;
  }
  return saveJsonMirrorBackup({ force: false, reason });
}


async function saveJsonMirrorBackupViaRender({ force = false, reason = "", savedAt = "" } = {}) {
  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const traceMeta = { source: "json-mirror-backup", route: "render-api", endpoint: renderJsonMirrorBackupUrl, operation: "upsert" };
  if (!currentSession?.access_token || !ledgerId) return { ok: false, shouldFallback: true };

  let controller = null;
  let timeoutId = 0;
  try {
    recordDataIoDiagnostic("start", { ...traceMeta, ok: true, ledgerId });
    controller = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        if (controller) controller.abort();
        reject(paymentActionTimeoutError("Render JSON mirror backup API", 12000));
      }, 12000);
    });
    const fetchPromise = fetch(renderJsonMirrorBackupUrl, {
      method: "POST",
      signal: controller.signal,
      headers: await buildRenderRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ledgerId, state, reason, force, updatedAt: savedAt })
    });

    const response = await Promise.race([fetchPromise, timeoutPromise]);
    window.clearTimeout(timeoutId);
    timeoutId = 0;

    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }

    if (response.ok && result?.ok) {
      recordSupabaseLoadEvent("render-json-mirror-backup", reason || (force ? "forced JSON mirror backup" : "scheduled JSON mirror backup"));
      recordDataIoDiagnostic("success", { ...traceMeta, ok: true, ledgerId });
      return { ok: true, backend: "render-api", result };
    }

    const message = result?.message || result?.error || text || `Render JSON mirror backup failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    const shouldFallback = [404, 405, 501].includes(response.status);
    recordDataIoDiagnostic("error", {
      ...traceMeta,
      error,
      ledgerId,
      detail: shouldFallback ? `HTTP ${response.status}; falling back to direct Supabase JSON mirror backup.` : `HTTP ${response.status}; not falling back.`
    });
    return { ok: false, shouldFallback, error };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "PaymentActionTimeoutError";
    if (timedOut && error?.name !== "PaymentActionTimeoutError") error = paymentActionTimeoutError("Render JSON mirror backup API", 12000);
    recordDataIoDiagnostic(timedOut ? "timeout" : "exception", {
      ...traceMeta,
      error,
      ledgerId,
      detail: "Falling back to direct Supabase JSON mirror backup."
    });
    return { ok: false, shouldFallback: true, error };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

async function saveJsonMirrorBackup({ force = false, reason = "" } = {}) {
  const resolvedReason = reason || (force ? "manual JSON mirror backup" : "scheduled JSON mirror backup");
  const mirrorPurpose = classifyJsonMirrorBackupReason(resolvedReason, force);
  if (!mirrorPurpose) {
    recordSupabaseLoadEvent("json-mirror-blocked-ordinary-save", `blocked JSON mirror write for ordinary save reason: ${resolvedReason}`);
    return false;
  }
  recordSupabaseLoadEvent("json-mirror-save", `${resolvedReason}; purpose=${mirrorPurpose}`);
  if (!supabaseClient || !currentSession) return false;
  if (!canManageSettings()) return false;
  if (!force && normalizedReadModeActive && !hasLedgerData(state)) return false;

  const savedAt = new Date().toISOString();
  reason = resolvedReason;
  const renderResult = await saveJsonMirrorBackupViaRender({ force, reason, savedAt });
  if (renderResult.ok) {
    lastRenderJsonMirrorBackupAt = Date.now();
    lastJsonMirrorSaveAt = savedAt;
    localStorage.setItem(`${makeWorkspaceScopedStorageKey()}:jsonMirrorSavedAt`, String(Date.now()));
    lastCloudSaveAt = savedAt;
    lastCloudSyncAt = savedAt;
    return true;
  }
  if (!renderResult.shouldFallback) {
    throw renderResult.error || new Error("Render JSON mirror backup failed.");
  }

  const { error } = await supabaseClient
    .from("car_share_ledgers")
    .upsert({
      id: supabaseHelpers.getLedgerId(supabaseConfig),
      state,
      updated_at: savedAt
    });

  if (error) {
    if (String(error.code || "") === "42501" || /permission|policy|rls/i.test(String(error.message || ""))) {
      return false;
    }
    throw error;
  }

  recordDataIoDiagnostic("success", {
    source: "json-mirror-backup",
    route: "direct-table",
    table: "car_share_ledgers",
    operation: "upsert",
    ok: true,
    ledgerId: supabaseHelpers.getLedgerId(supabaseConfig),
    detail: "Saved through direct Supabase JSON mirror fallback."
  });
  lastJsonMirrorSaveAt = savedAt;
  localStorage.setItem(`${makeWorkspaceScopedStorageKey()}:jsonMirrorSavedAt`, String(Date.now()));
  lastCloudSaveAt = savedAt;
  lastCloudSyncAt = savedAt;
  return true;
}

function applyIncomingState(nextState, status = "Live") {
  state = normalizeState(nextState);
  state.lastOdometer = getLatestOdometer();
  writeLocalState();
  setDefaultDates();
  render();
  setSyncStatus(status);
  updateAuthUi();
}


function currentSessionEmail() {
  return String(currentSession?.user?.email || "").trim().toLowerCase();
}

function ledgerEventActorName() {
  return currentUser || currentSessionEmail() || "Someone";
}

function rememberLedgerEventId(id) {
  if (!id) return false;
  if (ledgerEventNotificationIds.has(id)) return false;
  ledgerEventNotificationIds.add(id);
  if (ledgerEventNotificationIds.size > 200) {
    const first = ledgerEventNotificationIds.values().next().value;
    ledgerEventNotificationIds.delete(first);
  }
  return true;
}

async function publishLedgerEvent(event = {}) {
  if (!supabaseClient || !currentSession) return false;
  const now = Date.now();
  if (!event.force && now - lastLedgerEventPublishAt < ledgerEventPublishCooldownMs) {
    recordSupabaseLoadEvent("ledger-event-skip", "event publish cooldown");
    return false;
  }

  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  const actorEmail = currentSessionEmail();
  const title = String(event.title || "Shared ledger updated").slice(0, 120);
  const body = String(event.body || `${ledgerEventActorName()} updated the shared fuel ledger.`).slice(0, 500);
  const eventType = String(event.type || "ledger_updated").slice(0, 80);

  try {
    recordSupabaseLoadEvent("ledger-event-publish", eventType);
    const { error } = await supabaseClient.from("ledger_events").insert({
      ledger_id: ledgerId,
      event_type: eventType,
      title,
      body,
      actor_email: actorEmail,
      target_email: event.targetEmail ? String(event.targetEmail).trim().toLowerCase() : null,
      metadata: event.metadata || {}
    });
    if (error) throw error;
    lastLedgerEventPublishAt = now;
    return true;
  } catch (error) {
    // Event notifications are intentionally best-effort. A missing table or RLS
    // mismatch must never block saving trips, fuel, bookings, or payments.
    recordSupabaseLoadEvent("ledger-event-failed", error.message || "event insert failed");
    console.warn("Ledger event notification failed", error);
    return false;
  }
}

function scheduleLedgerEventAutoSync(row = null) {
  if (!supabaseClient || !currentSession) return;
  if (document.visibilityState === "hidden") {
    recordSupabaseLoadEvent("ledger-event-auto-sync-skip", "page hidden; sync on next focus");
    return;
  }

  if (pendingLocalChanges > 0) {
    recordSupabaseLoadEvent("ledger-event-auto-sync-skip", "pending local changes");
    showAppMessage("New shared update available, but this device has unsynced local changes. Save or sync before refreshing shared data.", "warning");
    return;
  }

  const now = Date.now();
  const elapsed = now - lastLedgerEventAutoSyncAt;
  const delayMs = elapsed >= ledgerEventAutoSyncCooldownMs
    ? ledgerEventAutoSyncDebounceMs
    : Math.max(ledgerEventAutoSyncDebounceMs, ledgerEventAutoSyncCooldownMs - elapsed);

  if (ledgerEventAutoSyncTimer) window.clearTimeout(ledgerEventAutoSyncTimer);
  recordSupabaseLoadEvent("ledger-event-auto-sync-scheduled", `${row?.event_type || "ledger_events"}; ${Math.round(delayMs / 1000)}s`);

  ledgerEventAutoSyncTimer = window.setTimeout(async () => {
    ledgerEventAutoSyncTimer = null;
    if (!supabaseClient || !currentSession) return;
    if (pendingLocalChanges > 0) {
      recordSupabaseLoadEvent("ledger-event-auto-sync-skip", "pending local changes at run");
      return;
    }
    if (hasForegroundWriteInFlight()) {
      recordSupabaseLoadEvent("ledger-event-auto-sync-skip", "foreground write active");
      recordSyncDiagnostic("background-load-deferred", "Ledger event refresh was deferred because a foreground write is active.", { reason: "ledger-event-auto-sync" });
      return;
    }
    lastLedgerEventAutoSyncAt = Date.now();
    recordSupabaseLoadEvent("ledger-event-auto-sync", row?.event_type || "ledger_events");
    showAppMessage("New shared update detected. Refreshing shared data automatically...", "info");
    await loadSupabaseStateWithTimeout(
      { force: true, reason: "ledger-event-auto-sync" },
      supabaseStartupLoadTimeoutMs,
      "Automatic cloud sync is delayed. You can still tap Sync now."
    );
  }, delayMs);
}

function handleLedgerEventNotification(row) {
  if (!row || !rememberLedgerEventId(row.id)) return;
  const actorEmail = String(row.actor_email || "").trim().toLowerCase();
  const targetEmail = String(row.target_email || "").trim().toLowerCase();
  const me = currentSessionEmail();
  if (actorEmail && me && actorEmail === me) return;
  if (targetEmail && me && targetEmail !== me) return;

  const title = row.title || "New shared update";
  const body = row.body || "Someone updated the shared fuel ledger.";
  recordSupabaseLoadEvent("ledger-event-notification", row.event_type || "ledger_events");
  showAppMessage(`${title}: ${body} Refreshing shared data automatically...`, "info");
  setSyncStatus("Cloud");
  scheduleLedgerEventAutoSync(row);
}

function subscribeToLedgerEvents() {
  if (!supabaseClient || !currentSession) return;
  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  if (ledgerEventsChannel && ledgerEventsChannelLedgerId === ledgerId) {
    recordSupabaseLoadEvent("ledger-events-subscription-skip", "already subscribed for active ledger");
    return;
  }
  if (ledgerEventsChannel) unsubscribeFromLedgerEvents();
  if (document.visibilityState === "hidden") {
    recordSupabaseLoadEvent("ledger-events-subscription-skip", "page hidden");
    return;
  }
  ledgerEventsChannelLedgerId = ledgerId;
  ledgerEventsChannel = supabaseClient
    .channel(`ledger-events:${ledgerId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ledger_events", filter: `ledger_id=eq.${ledgerId}` },
      (payload) => handleLedgerEventNotification(payload.new)
    )
    .subscribe((status) => {
      recordSupabaseLoadEvent("ledger-events-subscription", status || "subscribe");
      renderSupabaseLoadMonitor();
    });
}

function unsubscribeFromLedgerEvents() {
  if (!supabaseClient || !ledgerEventsChannel) return;
  supabaseClient.removeChannel(ledgerEventsChannel);
  ledgerEventsChannel = null;
  ledgerEventsChannelLedgerId = "";
  renderSupabaseLoadMonitor();
}

function pauseRealtimeForHiddenPage() {
  if (hiddenRealtimePauseTimer) window.clearTimeout(hiddenRealtimePauseTimer);
  hiddenRealtimePauseTimer = window.setTimeout(() => {
    hiddenRealtimePauseTimer = null;
    if (document.visibilityState !== "hidden") return;
    const hadLedgerEvents = Boolean(ledgerEventsChannel);
    const hadBroadRealtime = Boolean(supabaseStateChannel);
    unsubscribeFromLedgerEvents();
    unsubscribeFromSupabaseState();
    if (hadLedgerEvents || hadBroadRealtime) {
      recordSupabaseLoadEvent("realtime-paused-hidden", hadBroadRealtime ? "ledger events + broad realtime" : "ledger events");
    }
  }, hiddenRealtimePauseDelayMs);
}

function resumeRealtimeForVisiblePage() {
  if (hiddenRealtimePauseTimer) {
    window.clearTimeout(hiddenRealtimePauseTimer);
    hiddenRealtimePauseTimer = null;
  }
  if (!supabaseClient || !currentSession) return;
  subscribeToLedgerEvents();
  if (liveSyncEnabled) subscribeToSupabaseState({ force: true });
  recordSupabaseLoadEvent("realtime-resumed-visible", liveSyncEnabled ? "ledger events + broad realtime" : "ledger events");
}

function handleRealtimeVisibilityChange() {
  if (!supabaseClient || !currentSession) return;
  if (document.visibilityState === "hidden") {
    pauseRealtimeForHiddenPage();
  } else {
    resumeRealtimeForVisiblePage();
  }
}

function subscribeToSupabaseState({ force = false } = {}) {
  if (!supabaseClient) return;
  const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
  if (supabaseStateChannel && supabaseStateChannelLedgerId === ledgerId) {
    recordSupabaseLoadEvent("realtime-subscription-skip", "already subscribed for active ledger");
    return;
  }
  if (supabaseStateChannel) unsubscribeFromSupabaseState();
  if (document.visibilityState === "hidden") {
    recordSupabaseLoadEvent("realtime-disabled", "Realtime subscription skipped while page is hidden.");
    return;
  }
  if (!force && !liveSyncEnabled) {
    recordSupabaseLoadEvent("realtime-disabled", "Realtime subscription skipped; live sync is off by default.");
    return;
  }

  supabaseStateChannelLedgerId = ledgerId;
  supabaseStateChannel = supabaseClient
    .channel(`ledger:${ledgerId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "car_share_ledgers", filter: `id=eq.${ledgerId}` },
      (payload) => {
        if (Date.now() < ignoreRealtimeUntil) {
          recordSupabaseLoadEvent("realtime-ignored-self-save", payload.eventType || "ledger");
          return;
        }
        recordSupabaseLoadEvent("realtime-ledger-event", payload.eventType || "ledger");
        if (payload.new?.state) applyIncomingState(payload.new.state);
      }
    )
    .subscribe();
}

function unsubscribeFromSupabaseState() {
  if (!supabaseClient || !supabaseStateChannel) return;
  supabaseClient.removeChannel(supabaseStateChannel);
  supabaseStateChannel = null;
  supabaseStateChannelLedgerId = "";
}

function markLocalChangeQueued() {
  pendingLocalChanges += 1;
  lastLocalSaveAt = state.updatedAt || new Date().toISOString();
  if (!supabaseClient || currentSession) {
    setSyncStatus("Queued");
  } else {
    setSyncStatus("Login");
  }
}

function markRemoteSaveSucceeded(label) {
  pendingLocalChanges = 0;
  lastSyncError = "";
  clearSyncDelay(`save-success:${label || "cloud"}`);
  setSyncStatus(label);
}

function markRemoteSaveFailed(error, fallbackMessage = "Could not save shared data.") {
  lastSyncError = error?.message || fallbackMessage;
  lastCloudRetryAt = new Date().toISOString();
  recordSyncDiagnostic("save-error", lastSyncError, { error });
  setSyncStatus("Local");
}

function setSyncStatus(label, options = {}) {
  const requestedSource = normalizeVisibleSyncSource(options.source, label);
  if (!shouldAllowVisibleSyncStatus(label, requestedSource)) {
    recordBlockedVisibleSyncStatus(label, requestedSource, options);
    if (String(label || "").toLowerCase() === "saving" || String(label || "").toLowerCase() === "syncing") {
      return;
    }
  }
  const display = window.FuelSyncStatus?.syncDisplayForStatus
    ? window.FuelSyncStatus.syncDisplayForStatus(label, {
        pendingCount: pendingLocalChanges,
        lastCloudSaveAt,
        lastCloudSyncAt,
        lastLocalSaveAt,
        lastSyncError,
        lastCloudRetryAt
      })
    : { text: label === "Tables" ? "Database" : label, status: String(label || "").toLowerCase(), detail: "" };

  els.syncStatus.textContent = display.text;
  els.syncStatus.dataset.status = display.status;

  if (display.status === "saving") {
    beginForegroundOperation(requestedSource, { detail: String(label || "Saving") });
    if (!visibleSavingStartedAt) {
      visibleSavingStartedAt = Date.now();
      visibleSavingSource = requestedSource;
      recordSyncDiagnostic("saving-start", visibleSavingSource, { source: visibleSavingSource, activeForeground: foregroundOperationSummary() });
    }
    scheduleVisibleSavingFailsafe(visibleSavingSource);
  } else if (visibleSavingStartedAt) {
    const savingAgeMs = Date.now() - visibleSavingStartedAt;
    const clearedForeground = finishAllForegroundOperations(`status:${String(label || display.status || "cleared")}`);
    recordSyncDiagnostic("saving-clear", String(label || display.status || "cleared"), {
      source: visibleSavingSource,
      nextStatus: display.status,
      savingAgeMs,
      clearedForeground
    });
    visibleSavingStartedAt = 0;
    visibleSavingSource = "";
    clearVisibleSavingFailsafe();
  } else {
    clearVisibleSavingFailsafe();
  }

  if (display.status === "syncing") {
    if (!visibleSyncingStartedAt) {
      visibleSyncingStartedAt = Date.now();
      visibleSyncingSource = requestedSource;
      recordSyncDiagnostic("syncing-start", visibleSyncingSource, { source: visibleSyncingSource });
    }
    scheduleVisibleSyncingFailsafe(visibleSyncingSource);
  } else if (visibleSyncingStartedAt) {
    const syncingAgeMs = Date.now() - visibleSyncingStartedAt;
    recordSyncDiagnostic("syncing-clear", String(label || display.status || "cleared"), {
      source: visibleSyncingSource,
      nextStatus: display.status,
      syncingAgeMs
    });
    visibleSyncingStartedAt = 0;
    visibleSyncingSource = "";
    clearVisibleSyncingFailsafe();
  } else {
    clearVisibleSyncingFailsafe();
  }

  if (els.syncDetail) {
    els.syncDetail.textContent = display.detail;
  }

  renderSyncHealthBanner();
}

function hasLedgerData(candidate) {
  return (
    candidate.trips.length > 0 ||
    candidate.bookings.length > 0 ||
    candidate.fuel.length > 0 ||
    candidate.closedPeriods.length > 0 ||
    Object.keys(candidate.paymentStatuses).length > 0
  );
}

function emptyNode(text = "Nothing logged yet.") {
  const node = els.emptyTemplate.content.firstElementChild.cloneNode(true);
  node.textContent = text;
  return node;
}


// formatMoney is defined in utils.js so critical runtime-module smoke checks can
// verify utility availability before app.js-specific helpers run.

function getLedgerPeriod() {
  const dates = [...state.trips.map((trip) => trip.date), ...state.fuel.map((fuel) => fuel.date)]
    .filter(Boolean)
    .sort();

  if (dates.length === 0) {
    return { start: "", end: "", label: "Current ledger" };
  }

  const start = dates[0];
  const end = dates[dates.length - 1];

  return {
    start,
    end,
    label: start === end ? formatDate(start) : `${formatDate(start)} - ${formatDate(end)}`
  };
}


function getLatestRangeOdometer(fuelBaselineOdometer = 0, options = {}) {
  const excludeTripId = options.excludeTripId || null;
  const activeLatest = state.trips.reduce((latest, trip) => {
    if (excludeTripId && trip.id === excludeTripId) return latest;
    return Math.max(latest, Number(trip.endKm) || 0);
  }, 0);
  const archivedLatest = state.closedPeriods.reduce((latest, period) => {
    const periodLatest = (period.trips || []).reduce(
      (tripLatest, trip) => Math.max(tripLatest, Number(trip.endKm) || 0),
      0
    );
    return Math.max(latest, periodLatest);
  }, 0);
  const fuelLatest = state.fuel.reduce((latest, fuel) => Math.max(latest, Number(fuel.odometer) || 0), 0);
  const latest = Math.max(activeLatest, archivedLatest, fuelLatest, Number(fuelBaselineOdometer) || 0);
  return latest > 0 ? round(latest) : "";
}

function getLatestOdometer() {
  const activeLatest = state.trips.reduce((latest, trip) => Math.max(latest, trip.endKm), 0);
  const archivedLatest = state.closedPeriods.reduce((latest, period) => {
    const periodLatest = (period.trips || []).reduce(
      (tripLatest, trip) => Math.max(tripLatest, trip.endKm),
      0
    );
    return Math.max(latest, periodLatest);
  }, 0);
  const latest = Math.max(activeLatest, archivedLatest, Number(state.lastOdometer) || 0);
  return latest > 0 ? round(latest) : "";
}

function syncStartOdometerDefault() {
  if (state.lastOdometer !== "" && document.activeElement !== els.startKm) {
    els.startKm.value = state.lastOdometer;
  }
  if (els.fuelOdometer && state.lastOdometer !== "" && document.activeElement !== els.fuelOdometer && !els.fuelOdometer.value) {
    els.fuelOdometer.value = state.lastOdometer;
  }
}

function settlementKeyForPeriod(item, periodId = state.currentPeriodId || "") {
  // Closed-period payments may carry the original current-period key so reminder
  // repeat-window metadata survives the transition from open to closed period.
  if (item && item.paymentKey) return item.paymentKey;
  // Settlement request status is tied to the payer/recipient pair inside one settlement period.
  // Do not include the amount: fuel/trip edits can slightly change the amount, and then
  // a requested payment would appear to reset after refresh even though the database row exists.
  const currency = item.currency || state.currency || "DKK";
  const periodPart = periodId || "current";
  return `${periodPart}:${item.from}->${item.to}:${currency}`;
}

function settlementKey(item) {
  return settlementKeyForPeriod(item);
}

function getSettlementStatus(settlement) {
  return normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]);
}

(function () {
  const root = typeof window !== "undefined" ? window : globalThis;

  const ENDPOINTS = Object.freeze({
    legacyState: "/api/state",
    pushConfig: "/api/push-config",
    fuelPrice: "/api/fuel-price",
    pushSubscriptions: "/api/push-subscriptions",
    sendPush: "/api/send-push",
    legacyPaymentAction: "/api/payment-action",
    paymentStatusAction: "/api/payments/status-action",
    tripUpsert: "/api/trips/upsert",
    fuelUpsert: "/api/fuel/upsert",
    bookingUpsert: "/api/bookings/upsert",
    bookingDelete: "/api/bookings/delete",
    writeContext: "/api/context/write",
    stateLoad: "/api/state/load",
    appContext: "/api/app/context",
    workspaceTools: "/api/workspace/tools",
    settingsSave: "/api/settings/save",
    memberManagement: "/api/members/manage",
    ledgerDirectorySync: "/api/ledgers/sync",
    jsonMirrorBackup: "/api/backups/json-mirror",
    adminTestDataCreate: "/api/admin/test-data/create",
    adminTestDataCleanup: "/api/admin/test-data/cleanup",
    retentionPreview: "/api/admin/retention/preview",
    retentionCleanup: "/api/admin/retention/cleanup",
    adminHealth: "/api/admin/health",
    adminReportSave: "/api/admin/reports/save",
    adminSecurityHealth: "/api/admin/security-health",
    ownerActivity: "/api/owner/activity",
    ownerGlobalDiagnostics: "/api/owner/global-diagnostics",
    vehicleLookup: "/api/vehicle/lookup",
    backendPing: "/api/ping"
  });

  function normalizeEndpointKey(value) {
    return String(value || "").trim().replace(/[-_./:\s]+([a-z0-9])/gi, (_, char) => char.toUpperCase()).replace(/^[A-Z]/, (char) => char.toLowerCase());
  }

  function endpoint(name, fallback = "") {
    const direct = ENDPOINTS[name];
    if (direct) return direct;
    const normalized = normalizeEndpointKey(name);
    return ENDPOINTS[normalized] || fallback || String(name || "");
  }

  function makeHeaders(base = {}, { accessToken = "", contentType = "application/json" } = {}) {
    const headers = { ...(base || {}) };
    if (contentType && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = contentType;
    }
    if (accessToken && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }

  function createTimeoutError(label = "Render API", timeoutMs = 0, factory = null) {
    if (typeof factory === "function") return factory(label, timeoutMs);
    const error = new Error(`${label} did not respond within ${timeoutMs}ms.`);
    error.name = "RenderApiTimeoutError";
    error.code = "RENDER_API_TIMEOUT";
    error.timeoutMs = timeoutMs;
    return error;
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    return { response, text, result, status: response.status, ok: response.ok };
  }

  async function requestJson(url, options = {}) {
    if (typeof fetch !== "function") {
      const error = new Error("Browser fetch is unavailable.");
      error.code = "FETCH_UNAVAILABLE";
      throw error;
    }

    const timeoutMs = Number(options.timeoutMs || 0);
    const timeoutLabel = options.timeoutLabel || "Render API";
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const setTimer = root?.setTimeout ? root.setTimeout.bind(root) : setTimeout;
    const clearTimer = root?.clearTimeout ? root.clearTimeout.bind(root) : clearTimeout;
    let timeoutId = 0;

    const fetchOptions = {
      method: options.method || "POST",
      headers: makeHeaders(options.headers || {}, {
        accessToken: options.accessToken || "",
        contentType: options.contentType === undefined ? "application/json" : options.contentType
      })
    };
    if (controller) fetchOptions.signal = controller.signal;
    if (options.body !== undefined) {
      fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const runRequest = async () => {
      const response = await fetch(url, fetchOptions);
      return parseJsonResponse(response);
    };

    try {
      if (!timeoutMs || timeoutMs <= 0) return runRequest();
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimer(() => {
          try { if (controller) controller.abort(); } catch (_) {}
          reject(createTimeoutError(timeoutLabel, timeoutMs, options.timeoutErrorFactory));
        }, timeoutMs);
      });
      return await Promise.race([runRequest(), timeoutPromise]);
    } finally {
      if (timeoutId) clearTimer(timeoutId);
    }
  }

  root.FuelRenderApiClient = Object.freeze({
    ENDPOINTS,
    endpoint,
    makeHeaders,
    parseJsonResponse,
    requestJson
  });
})();

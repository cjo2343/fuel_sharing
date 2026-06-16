(function () {
  const BUILD_INFO = Object.freeze({
    appName: "Fuel Ledger",
    version: "2026.06.16.116",
    buildLabel: "admin-health-summary-polish",
    updatedAt: "2026-06-16T07:10:00.000Z",
    expectedServiceWorkerCache: "fuel-ledger-v215",
    releaseNotes: Object.freeze([
      "Period close now takes the same admin safety backup path before archiving current activity.",
      "Destructive admin backup reasons are listed in code and checked by validation.",
      "Deployment and hardening docs now explain the backup-before-destructive-action rule.",
      "JSON mirror writes remain manual, safety, or audit-cadence only.",
      "Local/server-backed trip submits now flush immediately so booking-to-trip smoke tests and payment actions read the exact saved participants.",
      "Startup cloud sync now times out cleanly and unlocks manual Sync now retries instead of leaving the app stuck in Syncing.",
      "CSP style rules now use style-src self without unsafe-inline; helper positioning moved to stylesheet classes and header tests block regressions.",
      "Cloud sync timeout recovery now covers manual Sync now, login/auth refresh, focus refresh, member/admin refreshes, and ledger-event auto-sync, and successful loads clear their timeout timer.",
      "Auth token refresh events now skip redundant forced cloud loads for the same user during a short cooldown, preventing refresh loops from showing false Cloud delayed warnings.",
      "Background auth refresh syncs no longer overwrite a healthy synced state with Cloud delayed; duplicate signed-in/auth-change events are cooldown-skipped.",
      "Generated Test Data writes/removals now require the advanced admin unlock plus typed confirmation, and cleanup uses strict auto-test id matching.",
      "Retention cleanup now prunes old cloud Test Lab report history while keeping the newest reports and never touching ledger accounting history.",
      "Diagnostic report redaction now covers JWTs, Authorization values, API keys, passwords, cookies, and sensitive URL query parameters without hiding build versions or timestamps.",
      "Booking-to-trip conversion now preserves planned estimate participants even if the trip form briefly re-renders to the default all-member selection before submit.",
      "Settlement request status updates now use a transaction RPC when available so payment status saves and stale payment-line cleanup succeed or fail together.",
      "Security Health now reports Fuel Ledger schema migration tracking so missing Supabase migration IDs are visible after deployment.",
      "Security Health now detects schema drift across expected tables, columns, and key RLS policies.",
      "Admin diagnostics now include a plain-language overall health summary plus dedicated migration and schema-shape cards."
    ])
  });

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "Unknown";
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  window.FUEL_LEDGER_BUILD = BUILD_INFO;

  function serviceWorkerStatus() {
    if (!("serviceWorker" in navigator)) return "Not supported in this browser";
    if (!navigator.serviceWorker.controller) return "Installed or waiting for next reload";
    return "Active on this page";
  }

  function requestServiceWorkerInfo(timeoutMs = 1200) {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller || typeof MessageChannel === "undefined") {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => resolve(null), timeoutMs);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data || null);
      };
      navigator.serviceWorker.controller.postMessage({ type: "GET_BUILD_INFO" }, [channel.port2]);
    });
  }

  function escapeBuildInfoText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBuildInfoPanel(target, serviceWorkerInfo = null) {
    if (!target) return;
    const serviceWorkerCache = serviceWorkerInfo?.cacheName || "Not reported yet";
    const cacheMatches = serviceWorkerInfo?.cacheName
      ? serviceWorkerInfo.cacheName === BUILD_INFO.expectedServiceWorkerCache
      : null;
    const cacheClass = cacheMatches === false ? "warning" : "ok";
    const cacheNote = cacheMatches === false
      ? "Cache mismatch — close/reopen the app or refresh once."
      : cacheMatches === true
        ? "Cache matches this build."
        : "Reload once if this looks stale.";
    const releaseNotes = (BUILD_INFO.releaseNotes || [])
      .map((note) => `<li>${escapeBuildInfoText(note)}</li>`)
      .join("");

    target.innerHTML = `
      <div class="build-info-grid">
        <article class="diagnostic-card ok">
          <strong>App version</strong>
          <p>${BUILD_INFO.version}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>Build label</strong>
          <p>${BUILD_INFO.buildLabel}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>Updated</strong>
          <p>${formatDateTime(BUILD_INFO.updatedAt)}</p>
        </article>
        <article class="diagnostic-card ${cacheClass}">
          <strong>Service worker cache</strong>
          <p>${serviceWorkerCache}</p>
          <small>${cacheNote}</small>
        </article>
        <article class="diagnostic-card ok">
          <strong>Expected cache</strong>
          <p>${BUILD_INFO.expectedServiceWorkerCache}</p>
        </article>
        <article class="diagnostic-card ok">
          <strong>PWA status</strong>
          <p>${serviceWorkerStatus()}</p>
        </article>
        <article class="diagnostic-card ok release-note-card">
          <strong>Latest notes</strong>
          <ul>${releaseNotes}</ul>
        </article>
      </div>
    `;
  }

  function renderBuildInfo(serviceWorkerInfo = null) {
    document.querySelectorAll("#buildInfoPanel, #aboutBuildInfoPanel").forEach((target) => {
      renderBuildInfoPanel(target, serviceWorkerInfo);
    });
  }

  async function refreshBuildInfo() {
    renderBuildInfo(null);
    const serviceWorkerInfo = await requestServiceWorkerInfo();
    renderBuildInfo(serviceWorkerInfo);
    return serviceWorkerInfo;
  }

  window.FuelBuildInfo = {
    BUILD_INFO,
    renderBuildInfo,
    refreshBuildInfo,
    serviceWorkerStatus
  };

  refreshBuildInfo();
  window.addEventListener("load", () => refreshBuildInfo());
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", () => refreshBuildInfo());
  }
})();

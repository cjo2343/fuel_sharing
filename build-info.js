(function () {
  const BUILD_INFO = Object.freeze({
    appName: "Fuel Ledger",
    version: "2026.06.12.27",
    buildLabel: "settlement-payment-polish",
    updatedAt: "2026-06-12T23:30:00+02:00",
    expectedServiceWorkerCache: "fuel-ledger-v64"
  });

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "Unknown";
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

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

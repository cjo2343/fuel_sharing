(function () {
  function normalizePendingCount(value) {
    const count = Number(value || 0);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function pluralizeChange(count) {
    return `${count} unsynced change${count === 1 ? "" : "s"}`;
  }

  function formatSaveTime(isoValue, fallback = "") {
    if (!isoValue) return fallback;
    const time = new Date(isoValue);
    if (Number.isNaN(time.getTime())) return fallback;
    return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function syncDisplayForStatus(label, options = {}) {
    const pendingCount = normalizePendingCount(options.pendingCount);
    const lastCloudSaveAt = options.lastCloudSaveAt || "";
    const lastCloudSyncAt = options.lastCloudSyncAt || lastCloudSaveAt || "";
    const lastLocalSaveAt = options.lastLocalSaveAt || "";
    const lastSyncError = options.lastSyncError || "";
    const lastCloudRetryAt = options.lastCloudRetryAt || "";
    const normalizedLabel = String(label || "").trim() || "Local";
    const status = normalizedLabel.toLowerCase();
    const pendingText = pendingCount ? pluralizeChange(pendingCount) : "";
    const localTime = formatSaveTime(lastLocalSaveAt, "now");

    if (normalizedLabel === "Tables") {
      return {
        text: "Database",
        status: "tables",
        detail: lastCloudSaveAt
          ? `Synced ${formatSaveTime(lastCloudSyncAt || lastCloudSaveAt)} · live sync off`
          : "Synced through database tables · live sync off"
      };
    }

    if (normalizedLabel === "Cloud") {
      return {
        text: "Cloud",
        status: "cloud",
        detail: lastCloudSyncAt ? `Synced ${formatSaveTime(lastCloudSyncAt)} · live sync off` : "Saved to Supabase · live sync off"
      };
    }

    if (normalizedLabel === "Shared") {
      return {
        text: "Shared",
        status: "shared",
        detail: lastCloudSyncAt ? `Synced ${formatSaveTime(lastCloudSyncAt)}` : "Saved to shared file"
      };
    }

    if (normalizedLabel === "Queued") {
      return {
        text: "Unsynced",
        status: "queued",
        detail: `${pendingText || "Changes"} saved on this device; waiting to sync${localTime ? ` (${localTime})` : ""}.`
      };
    }

    if (normalizedLabel === "Saving") {
      return {
        text: "Saving",
        status: "saving",
        detail: pendingText ? `Saving ${pendingText}...` : "Saving changes..."
      };
    }

    if (normalizedLabel === "Syncing") {
      return { text: "Syncing", status: "syncing", detail: "Refreshing shared data..." };
    }

    if (normalizedLabel === "Login") {
      return {
        text: "Login",
        status: "login",
        detail: pendingText
          ? `Sign in to sync ${pendingText}; saved on this device only.`
          : "Sign in to save changes"
      };
    }

    if (normalizedLabel === "Delayed") {
      const retryText = lastCloudRetryAt ? ` Retrying since ${formatSaveTime(lastCloudRetryAt)}.` : " Retrying in the background.";
      return {
        text: "Cloud delayed",
        status: "delayed",
        detail: `${lastSyncError || "Cloud sync is taking longer than expected."}${retryText}`
      };
    }

    if (normalizedLabel === "Local") {
      return {
        text: "Local only",
        status: "local",
        detail: pendingText
          ? `${pendingText} saved on this device only${lastSyncError ? `: ${lastSyncError}` : "."}`
          : (lastSyncError ? `Not saved: ${lastSyncError}` : "Not saved to cloud")
      };
    }

    return { text: normalizedLabel, status, detail: "" };
  }

  window.FuelSyncStatus = {
    normalizePendingCount,
    pluralizeChange,
    formatSaveTime,
    syncDisplayForStatus
  };
})();

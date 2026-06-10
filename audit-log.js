(function () {
  const maxAuditEntries = 250;

  function normalizeAuditEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => ({
        id: entry.id || makeAuditId(),
        createdAt: entry.createdAt || entry.timestamp || new Date().toISOString(),
        actor: String(entry.actor || "Unknown"),
        type: String(entry.type || "change"),
        entityType: String(entry.entityType || "app"),
        entityId: entry.entityId ? String(entry.entityId) : "",
        summary: String(entry.summary || "App change"),
        detail: entry.detail ? String(entry.detail) : "",
        metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {}
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, maxAuditEntries);
  }

  function makeAuditId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createEntry({ type, actor, entityType, entityId, summary, detail = "", metadata = {} }) {
    return {
      id: makeAuditId(),
      createdAt: new Date().toISOString(),
      actor: actor || "Unknown",
      type: type || "change",
      entityType: entityType || "app",
      entityId: entityId || "",
      summary: summary || "App change",
      detail,
      metadata: metadata && typeof metadata === "object" ? metadata : {}
    };
  }

  function actionLabel(type) {
    const labels = {
      trip_created: "Trip created",
      trip_updated: "Trip updated",
      trip_deleted: "Trip deleted",
      fuel_created: "Fuel log created",
      fuel_updated: "Fuel log updated",
      fuel_deleted: "Fuel log deleted",
      payment_requested: "Payment requested",
      payment_marked_paid: "Payment marked paid",
      payment_reopened: "Payment reopened",
      settlement_closed: "Settlement closed",
      settlement_reopened: "Settlement reopened"
    };
    return labels[type] || "App change";
  }

  window.FuelAuditLog = {
    maxAuditEntries,
    normalizeAuditEntries,
    createEntry,
    actionLabel
  };
})();

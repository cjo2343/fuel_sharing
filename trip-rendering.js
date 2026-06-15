(function () {
  function formatDateTimeShort(value, deps) {
    const parsed = value ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleDateString("en-DK", { day: "2-digit", month: "short" }) + ` ${parsed.toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function getTripPeriodLabel(trip, deps = {}) {
    const formatDate = deps.formatDate || ((value) => value || "Date unknown");
    const localDateString = deps.localDateString || ((date) => {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
      return date.toISOString().slice(0, 10);
    });
    const start = trip?.bookingStart;
    const end = trip?.bookingEnd;
    const startDate = start ? localDateString(new Date(start)) : "";
    const endDate = end ? localDateString(new Date(end)) : "";
    if (start && end && startDate && endDate) {
      if (startDate === endDate) {
        const startTime = new Date(start).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit" });
        const endTime = new Date(end).toLocaleTimeString("en-DK", { hour: "2-digit", minute: "2-digit" });
        return `${formatDate(startDate)} · ${startTime}-${endTime}`;
      }
      return `${formatDateTimeShort(start, deps)} – ${formatDateTimeShort(end, deps)}`;
    }
    return trip?.date ? formatDate(trip.date) : "Date unknown";
  }

  function renderTripEntryCard(trip, ledger = null, deps = {}) {
    const escapeHtml = deps.escapeHtml || ((value) => String(value ?? ""));
    const formatNumber = deps.formatNumber || ((value) => String(value ?? ""));
    const round = deps.round || ((value) => Math.round(Number(value || 0)));
    const getTripParticipants = deps.getTripParticipants || (() => []);
    const getTripCategory = deps.getTripCategory || (() => "Trip");
    const getTripEntryReviewSignal = deps.getTripEntryReviewSignal || (() => null);
    const renderEntryReviewSignal = deps.renderEntryReviewSignal || (() => "");
    const canManageTripEntry = deps.canManageTripEntry || (() => false);
    const renderPermissionNote = deps.renderPermissionNote || (() => "");
    const describeTripPermissionMessage = deps.describeTripPermissionMessage || (() => "");
    const km = round(Number(trip.endKm || 0) - Number(trip.startKm || 0));
    const participants = getTripParticipants(trip);
    const category = getTripCategory(trip);
    const reviewSignal = getTripEntryReviewSignal(trip, ledger);
    return `
    <article class="entry-card" data-entry-type="trip" data-entry-id="${escapeHtml(trip.id)}" data-entry-short-id="${escapeHtml(String(trip.id || "").slice(0, 8))}">
      <header>
        <strong>${escapeHtml(trip.driver)}</strong>
        ${canManageTripEntry(trip) ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="trips:${trip.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="trips:${trip.id}">Delete</button></div>` : ""}
      </header>
      ${!canManageTripEntry(trip) ? renderPermissionNote(describeTripPermissionMessage(trip, "edit or delete")) : ""}
      <p>${formatNumber(km)} km · Total ${formatNumber(trip.endKm)} km <span class="category-chip">${escapeHtml(category)}</span></p>
      <p class="entry-meta"><strong title="Full id: ${escapeHtml(trip.id || "")}">#${escapeHtml(String(trip.id || "").slice(0, 8))}</strong> · ${escapeHtml(getTripPeriodLabel(trip, deps))} · ${formatNumber(trip.startKm)} to ${formatNumber(trip.endKm)} km</p>
      <p class="entry-meta">Split between ${participants.map(escapeHtml).join(", ")}</p>
      ${trip.note ? `<p>${escapeHtml(trip.note)}</p>` : ""}
      ${renderEntryReviewSignal(reviewSignal)}
    </article>
  `;
  }

  function renderCategorizedTrips(trips, deps = {}) {
    const escapeHtml = deps.escapeHtml || ((value) => String(value ?? ""));
    const formatNumber = deps.formatNumber || ((value) => String(value ?? ""));
    const round = deps.round || ((value) => Math.round(Number(value || 0)));
    const byNewest = deps.byNewest || (() => 0);
    const groupBy = deps.groupBy || ((items, getKey) => items.reduce((groups, item) => {
      const key = getKey(item);
      (groups[key] ||= []).push(item);
      return groups;
    }, {}));
    const ledger = typeof deps.calculateLedger === "function" ? deps.calculateLedger() : null;
    const sortedTrips = [...trips].sort(byNewest);
    const grouped = groupBy(sortedTrips, (trip) => trip.driver || "Unknown");
    const totalKm = round(sortedTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
    const summary = `
    <article class="entry-card history-summary-card">
      <strong>Current period trip log</strong>
      <p>${sortedTrips.length} trip${sortedTrips.length === 1 ? "" : "s"} · ${formatNumber(totalKm)} km total</p>
      <p class="entry-meta">Grouped by driver and collapsed by default. Open a driver to inspect the individual trips.</p>
    </article>
  `;

    return summary + Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([driver, driverTrips]) => {
        const driverKm = round(driverTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.endKm || 0) - Number(trip.startKm || 0)), 0));
        return `
        <details class="history-group">
          <summary>
            <strong>${escapeHtml(driver)}</strong>
            <span>${driverTrips.length} trip${driverTrips.length === 1 ? "" : "s"} · ${formatNumber(driverKm)} km</span>
          </summary>
          <div class="entry-list grouped-entry-list">
            ${driverTrips.map((trip) => renderTripEntryCard(trip, ledger, deps)).join("")}
          </div>
        </details>
      `;
      })
      .join("");
  }

  window.TripRendering = Object.freeze({
    formatDateTimeShort,
    getTripPeriodLabel,
    renderTripEntryCard,
    renderCategorizedTrips
  });
})();

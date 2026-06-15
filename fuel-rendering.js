(function () {
  function renderCategorizedFuel(fuelLogs, deps) {
    const ledger = deps.calculateLedger();
    const sortedFuel = [...fuelLogs].sort(deps.byNewest);
    const grouped = deps.groupBy(sortedFuel, (fuel) => fuel.payer || "Unknown");
    const totalPaid = deps.roundMoney(sortedFuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0));
    const totalLiters = deps.round(sortedFuel.reduce((sum, fuel) => sum + Number(fuel.liters || 0), 0));
    const summary = `
      <article class="entry-card history-summary-card">
        <strong>Current period fuel log</strong>
        <p>${sortedFuel.length} fuel log${sortedFuel.length === 1 ? "" : "s"} · ${deps.formatMoney(totalPaid)}${totalLiters > 0 ? ` · ${deps.formatNumber(totalLiters)} L` : ""}</p>
        <p class="entry-meta">Grouped by payer and collapsed by default. Open a payer to inspect the individual fuel logs.</p>
      </article>
    `;

    return summary + Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([payer, payerFuel]) => {
        const payerPaid = deps.roundMoney(payerFuel.reduce((sum, fuel) => sum + Number(fuel.amount || 0), 0));
        const payerLiters = deps.round(payerFuel.reduce((sum, fuel) => sum + Number(fuel.liters || 0), 0));
        return `
          <details class="history-group">
            <summary>
              <strong>${deps.escapeHtml(payer)}</strong>
              <span>${payerFuel.length} fuel log${payerFuel.length === 1 ? "" : "s"} · ${deps.formatMoney(payerPaid)}${payerLiters > 0 ? ` · ${deps.formatNumber(payerLiters)} L` : ""}</span>
            </summary>
            <div class="entry-list grouped-entry-list">
              ${payerFuel.map((fuel) => renderFuelEntryCard(fuel, ledger, deps)).join("")}
            </div>
          </details>
        `;
      })
      .join("");
  }

  function renderFuelEntryCard(fuel, ledger = null, deps) {
    const reviewSignal = deps.getFuelEntryReviewSignal(fuel, ledger);
    return `
      <article class="entry-card" data-entry-type="fuel" data-entry-id="${deps.escapeHtml(fuel.id)}" data-entry-short-id="${deps.escapeHtml(String(fuel.id || "").slice(0, 8))}">
        <header>
          <strong>${deps.escapeHtml(fuel.payer)}</strong>
          ${deps.canManageFuelEntry(fuel) ? `<div class="entry-actions"><button class="subtle-button compact-button" type="button" data-edit="fuel:${fuel.id}">Edit</button><button class="text-button compact-button" type="button" data-delete="fuel:${fuel.id}">Delete</button></div>` : ""}
        </header>
        ${!deps.canManageFuelEntry(fuel) ? deps.renderPermissionNote(deps.describeFuelPermissionMessage(fuel, "edit or delete")) : ""}
        <p>${deps.formatFuelAmountLitersAndPrice(fuel)}</p>
        <p class="entry-meta"><strong title="Full id: ${deps.escapeHtml(fuel.id || "")}">#${deps.escapeHtml(String(fuel.id || "").slice(0, 8))}</strong> · ${deps.formatDate(fuel.date)}${fuel.odometer ? ` · ${deps.formatNumber(fuel.odometer)} km` : ""}${fuel.station ? ` · ${deps.escapeHtml(fuel.station)}` : ""}${fuel.location?.latitude && fuel.location?.longitude ? ` · GPS saved` : ""}${fuel.fullTank ? " · full tank" : ""}</p>
        ${fuel.sourceTripId ? `<p class="entry-meta">Linked to trip ${deps.escapeHtml(deps.formatLogRef(fuel))}</p>` : ""}
        ${deps.renderEntryReviewSignal(reviewSignal)}
      </article>
    `;
  }

  function renderClosedPeriodFuel(fuel, currency, deps) {
    if (!Array.isArray(fuel) || fuel.length === 0) {
      return `<p class="entry-meta">No fuel logs saved in this period.</p>`;
    }
    const grouped = deps.groupBy([...fuel].sort(deps.byNewest), (item) => item.payer || "Unknown");
    return Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([payer, items]) => {
        const amount = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const liters = items.reduce((sum, item) => sum + Number(item.liters || 0), 0);
        return `
          <details class="history-group archive-entry-group">
            <summary><strong>${deps.escapeHtml(payer)}</strong><span>${items.length} fuel log${items.length === 1 ? "" : "s"} · ${deps.formatMoneyFor(amount, currency)}${liters > 0 ? ` · ${deps.formatNumber(liters)} L` : ""}</span></summary>
            <div class="entry-list grouped-entry-list">
              ${items.map((item) => {
                const itemLiters = Number(item.liters || 0);
                const price = itemLiters > 0 ? `${deps.formatNumber(itemLiters)} L · ${deps.formatMoneyFor(Number(item.amount || 0) / itemLiters, currency)}/L` : "No liters logged";
                return `
                  <article class="entry-card archive-entry-card archive-log-card">
                    <div class="archive-log-card-head">
                      <strong>${deps.escapeHtml(item.payer || "Unknown")}</strong>
                      ${item.logRef ? `<span class="log-ref">${deps.escapeHtml(deps.formatTypedLogRef(item, "fuel"))}</span>` : ""}
                    </div>
                    <p>${deps.formatMoneyFor(item.amount || 0, currency)} · ${price}</p>
                    <p class="entry-meta">${deps.formatDate(item.date)}${item.odometer ? ` · ${deps.formatNumber(item.odometer)} km` : ""}${item.station ? ` · ${deps.escapeHtml(item.station)}` : ""}${item.sourceTripId ? " · linked trip fuel" : ""}</p>
                  </article>
                `;
              }).join("")}
            </div>
          </details>
        `;
      })
      .join("");
  }

  window.FuelRendering = {
    renderCategorizedFuel,
    renderFuelEntryCard,
    renderClosedPeriodFuel
  };
})();

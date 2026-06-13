// Admin and database diagnostics helpers for Fuel Ledger.
// These helpers are loaded before app.js and run in the shared browser global scope.
// Keep sensitive event/button wiring in app.js; this file owns reusable admin diagnostics logic.
(function () {
  function renderDatabaseDiagnosticsPanel(ledger) {
    if (!els.databaseDiagnosticsPanel || !els.databaseDiagnosticsList) return;
  
    if (!supabaseClient) {
      els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Supabase</strong><p>Supabase is not configured in this build.</p></article>`;
      return;
    }
  
    if (!databaseDiagnosticsStatus.checked && !databaseDiagnosticsStatus.loading) {
      els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Not checked yet</strong><p>Click Refresh diagnostics to read the live database tables.</p></article>`;
      return;
    }
  
    if (databaseDiagnosticsStatus.loading) {
      els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card warning"><strong>Loading</strong><p>Reading normalized table counts from Supabase...</p></article>`;
      return;
    }
  
    if (databaseDiagnosticsStatus.error) {
      els.databaseDiagnosticsList.innerHTML = `<article class="diagnostic-card issue"><strong>Diagnostics failed</strong><p>${escapeHtml(databaseDiagnosticsStatus.error)}</p></article>`;
      return;
    }
  
    els.databaseDiagnosticsList.innerHTML = databaseDiagnosticsStatus.rows
      .map((row) => `
        <article class="diagnostic-card ${row.level || "ok"}">
          <strong>${escapeHtml(row.title)}</strong>
          <p>${escapeHtml(row.message)}</p>
        </article>
      `)
      .join("");
  }

  async function getCurrentSettlementRequestContext() {
    if (!supabaseClient || !currentSession) throw new Error("Sign in before checking settlement request rows.");
    if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");
  
    const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
    const [membersResult, periodsResult, requestsResult] = await Promise.all([
      supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone").eq("ledger_id", ledgerId),
      supabaseClient.from("settlement_periods").select("id,status").eq("ledger_id", ledgerId),
      supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status,requested_at,paid_at,updated_at").eq("ledger_id", ledgerId)
    ]);
  
    const firstError = [membersResult, periodsResult, requestsResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;
  
    const activeMembers = (membersResult.data || []).filter((member) => member.is_active !== false);
    const openPeriod = (periodsResult.data || []).find((period) => period.status === "open") || null;
    const activeRequests = (requestsResult.data || []).filter((request) =>
      normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id)
    );
    const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
    const currentRequests = activeRequests.filter((request) => {
      const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
      const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
      return fromName && toName && currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
    });
    const staleRequests = activeRequests.filter((request) => !currentRequests.some((current) => current.id === request.id));
  
    return { ledgerId, openPeriod, activeMembers, activeRequests, currentRequests, staleRequests };
  }

  async function cleanStaleSettlementRequests() {
    const { staleRequests } = await getCurrentSettlementRequestContext();
    if (!staleRequests.length) return 0;
  
    const { error } = await supabaseClient
      .from("settlement_requests")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("id", staleRequests.map((request) => request.id));
  
    if (error) throw error;
    return staleRequests.length;
  }


  function isGeneratedSoftDeletedTripRow(row) {
    if (!row || !row.deleted_at) return false;
    return String(row.legacy_id || "").startsWith(generatedTestPrefix) ||
      String(row.note || "").includes(generatedTestMarker);
  }

  function isGeneratedSoftDeletedFuelRow(row) {
    if (!row || !row.deleted_at) return false;
    return String(row.legacy_id || "").startsWith(generatedTestPrefix) ||
      String(row.station_name || "").includes(generatedTestMarker);
  }

  async function purgeSoftDeletedGeneratedTestRows({ dryRun = true } = {}) {
    if (!supabaseClient || !currentSession) throw new Error("Sign in before purging test rows.");
    if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");

    const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
    const [tripsResult, fuelResult] = await Promise.all([
      supabaseClient
        .from("trips")
        .select("id,legacy_id,note,deleted_at")
        .eq("ledger_id", ledgerId)
        .not("deleted_at", "is", null),
      supabaseClient
        .from("fuel_payments")
        .select("id,legacy_id,station_name,deleted_at")
        .eq("ledger_id", ledgerId)
        .not("deleted_at", "is", null)
    ]);

    const firstError = [tripsResult, fuelResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;

    const tripIds = (tripsResult.data || []).filter(isGeneratedSoftDeletedTripRow).map((row) => row.id);
    const fuelIds = (fuelResult.data || []).filter(isGeneratedSoftDeletedFuelRow).map((row) => row.id);

    const summary = { trips: tripIds.length, fuel: fuelIds.length, total: tripIds.length + fuelIds.length, dryRun: Boolean(dryRun) };
    if (dryRun || summary.total === 0) return summary;

    if (tripIds.length) {
      const deleteParticipants = await supabaseClient.from("trip_participants").delete().in("trip_id", tripIds);
      if (deleteParticipants.error) throw deleteParticipants.error;
      const deleteTrips = await supabaseClient.from("trips").delete().in("id", tripIds).eq("ledger_id", ledgerId);
      if (deleteTrips.error) throw deleteTrips.error;
    }

    if (fuelIds.length) {
      const deleteFuel = await supabaseClient.from("fuel_payments").delete().in("id", fuelIds).eq("ledger_id", ledgerId);
      if (deleteFuel.error) throw deleteFuel.error;
    }

    return summary;
  }

  async function refreshDatabaseDiagnostics() {
    if (!supabaseClient || !currentSession) {
      databaseDiagnosticsStatus = {
        checked: true,
        loading: false,
        error: "Sign in before running database diagnostics.",
        rows: []
      };
      render();
      return;
    }
  
    databaseDiagnosticsStatus = { checked: true, loading: true, error: "", rows: [] };
    render();
  
    try {
      if (!(await hasFreshSupabaseSession())) throw new Error("Session is not fresh. Sign out and back in if this persists.");
      const ledgerId = supabaseHelpers.getLedgerId(supabaseConfig);
      const [legacyResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult] = await Promise.all([
        supabaseClient.from("car_share_ledgers").select("state,updated_at").eq("id", ledgerId).maybeSingle(),
        supabaseClient.from("ledger_members").select("id,name,email,role,is_active,mobilepay_phone,updated_at").eq("ledger_id", ledgerId),
        supabaseClient.from("settlement_periods").select("id,status,label,opened_at,closed_at,created_at,updated_at").eq("ledger_id", ledgerId),
        supabaseClient.from("trips").select("id,period_id,deleted_at,created_at,updated_at").eq("ledger_id", ledgerId),
        supabaseClient.from("fuel_payments").select("id,period_id,deleted_at,created_at,updated_at").eq("ledger_id", ledgerId),
        supabaseClient.from("settlement_requests").select("id,period_id,from_member_id,to_member_id,amount,currency,status,requested_at,paid_at,updated_at").eq("ledger_id", ledgerId)
      ]);
  
      const firstError = [legacyResult, membersResult, periodsResult, tripsResult, fuelResult, requestsResult].find((result) => result.error)?.error;
      if (firstError) throw firstError;
  
      const legacyState = normalizeState(legacyResult.data?.state || {});
      const members = membersResult.data || [];
      const activeMembers = members.filter((member) => member.is_active !== false);
      const admins = activeMembers.filter((member) => member.role === "admin");
      const missingEmail = activeMembers.filter((member) => !member.email);
      const periods = periodsResult.data || [];
      const openPeriods = periods.filter((period) => period.status === "open");
      const openPeriod = openPeriods[0] || null;
      const trips = tripsResult.data || [];
      const fuel = fuelResult.data || [];
      const openTrips = trips.filter((trip) => !trip.deleted_at && (!openPeriod || !trip.period_id || trip.period_id === openPeriod.id));
      const openFuel = fuel.filter((item) => !item.deleted_at && (!openPeriod || !item.period_id || item.period_id === openPeriod.id));
      const softDeletedTrips = trips.filter((trip) => trip.deleted_at).length;
      const softDeletedFuel = fuel.filter((item) => item.deleted_at).length;
      const requests = requestsResult.data || [];
      const activeRequests = requests.filter((request) => normalizePaymentStatus(request.status) !== "cancelled" && (!openPeriod || request.period_id === openPeriod.id));
      const currentSettlementPairs = new Set(calculateLedger().settlements.map((settlement) => settlementKey(settlement)));
      const currentRequests = activeRequests.filter((request) => {
        const fromName = activeMembers.find((member) => member.id === request.from_member_id)?.name;
        const toName = activeMembers.find((member) => member.id === request.to_member_id)?.name;
        return fromName && toName && currentSettlementPairs.has(settlementKey({ from: fromName, to: toName, currency: state.currency || "DKK" }));
      });
      const requestedCurrentRows = currentRequests.filter((request) => ["requested", "paid"].includes(normalizePaymentStatus(request.status))).length;
      const visibleRequested = calculateLedger().settlements.filter(
        (settlement) => ["requested", "paid"].includes(normalizePaymentStatus(state.paymentStatuses[settlementKey(settlement)]))
      ).length;
      const staleRequestRows = activeRequests.length - currentRequests.length;
      const lastTableWrite = [
        ...members.map((row) => row.updated_at),
        ...periods.map((row) => row.updated_at),
        ...trips.map((row) => row.updated_at),
        ...fuel.map((row) => row.updated_at),
        ...requests.map((row) => row.updated_at)
      ].filter(Boolean).sort().pop() || "";
  
      const rows = [
        {
          level: normalizedReadModeActive ? "ok" : "warning",
          title: "Read mode",
          message: normalizedReadModeActive
            ? "The app is reading normalized tables first. JSON is fallback/backup."
            : "The app is not currently in normalized read-first mode."
        },
        {
          level: openPeriods.length === 1 ? "ok" : "warning",
          title: "Open period",
          message: openPeriod
            ? `${openPeriods.length} open period. Active ID ${shortId(openPeriod.id)} · ${openPeriod.label || "Current period"}.`
            : `${openPeriods.length} open periods found. The app needs exactly one.`
        },
        {
          level: activeMembers.length === state.members.length && admins.length && !missingEmail.length ? "ok" : "warning",
          title: "Members",
          message: `${activeMembers.length} active table members; ${state.members.length} visible in app; ${admins.length} admin; ${missingEmail.length} missing email.`
        },
        {
          level: openTrips.length === state.trips.length ? "ok" : "warning",
          title: "Trips",
          message: `${openTrips.length} open-period table trips; ${state.trips.length} visible in app; ${softDeletedTrips} soft-deleted rows kept for audit/history.`
        },
        {
          level: openFuel.length === state.fuel.length ? "ok" : "warning",
          title: "Fuel logs",
          message: `${openFuel.length} open-period table fuel logs; ${state.fuel.length} visible in app; ${softDeletedFuel} soft-deleted rows kept for audit/history.`
        },
        {
          level: requestedCurrentRows === visibleRequested && staleRequestRows === 0 ? "ok" : "warning",
          title: "Settlement requests",
          message: `${requestedCurrentRows} requested/paid current table rows; ${visibleRequested} visible requested/paid payments; ${staleRequestRows} stale active request row${staleRequestRows === 1 ? "" : "s"}${staleRequestRows ? " (safe to clean)" : ""}.`
        },
        {
          level: legacyState.trips.length === state.trips.length && legacyState.fuel.length === state.fuel.length ? "ok" : "warning",
          title: "JSON backup snapshot",
          message: `JSON snapshot has ${legacyState.members.length} members, ${legacyState.trips.length} trips, ${legacyState.fuel.length} fuel logs. Current app has ${state.members.length}, ${state.trips.length}, ${state.fuel.length}. It is now a manual/periodic safety backup, not the primary save target.`
        },
        {
          level: lastTableWrite ? "ok" : "warning",
          title: "Last table write",
          message: lastTableWrite
            ? `Latest normalized row update: ${new Date(lastTableWrite).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}. Last JSON backup snapshot: ${legacyResult.data?.updated_at ? new Date(legacyResult.data.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "unknown"}.`
            : "No updated_at values found in normalized tables."
        }
      ];
  
      databaseDiagnosticsStatus = { checked: true, loading: false, error: "", rows };
    } catch (error) {
      console.warn("Database diagnostics failed", error);
      databaseDiagnosticsStatus = {
        checked: true,
        loading: false,
        error: error.message || String(error),
        rows: []
      };
    }
  
    render();
  }

  window.renderDatabaseDiagnosticsPanel = renderDatabaseDiagnosticsPanel;
  window.getCurrentSettlementRequestContext = getCurrentSettlementRequestContext;
  window.cleanStaleSettlementRequests = cleanStaleSettlementRequests;
  window.purgeSoftDeletedGeneratedTestRows = purgeSoftDeletedGeneratedTestRows;
  window.refreshDatabaseDiagnostics = refreshDatabaseDiagnostics;

  window.FuelAdminTools = {
    renderDatabaseDiagnosticsPanel,
    getCurrentSettlementRequestContext,
    cleanStaleSettlementRequests,
    refreshDatabaseDiagnostics,
    purgeSoftDeletedGeneratedTestRows
  };
})();

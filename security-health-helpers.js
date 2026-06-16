// Supabase security health helpers for Test Lab and admin diagnostics.
// Loaded before app.js; exposes pure helpers on window.FuelSecurityHealth.
(function () {
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function pass(name, detail = "") {
    return { ok: true, name, detail };
  }

  function fail(name, detail = "") {
    return { ok: false, name, detail, level: "error" };
  }

  function warn(name, detail = "") {
    return { ok: true, name, detail, level: "warning", warning: true };
  }

  function isWarning(check) {
    return Boolean(check && check.ok && (check.warning || check.level === "warning"));
  }

  function errorMessage(error) {
    return String(error && (error.message || error.details || error.hint) || error || "");
  }

  function isMissingHealthcheckRpcError(error) {
    const code = String(error && error.code || "");
    const message = errorMessage(error);
    return code === "PGRST202" || /fuel_ledger_healthcheck/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message);
  }

  function normalizeHealthcheckRpcResult(input = {}) {
    const name = input.name || "Fuel Ledger healthcheck RPC is available";
    if (input.skipped) return pass(name, input.detail || "Skipped.");
    const error = input.error || null;
    if (error) {
      if (isMissingHealthcheckRpcError(error)) {
        return fail(name, "fuel_ledger_healthcheck is missing. Run the latest supabase-schema.sql before using live backend health checks.");
      }
      return fail(name, errorMessage(error) || "Healthcheck RPC failed.");
    }
    const data = input.data && typeof input.data === "object" ? input.data : {};
    if (input.ok === false || data.ok === false) {
      return fail(name, data.message || input.detail || "Healthcheck RPC returned an unhealthy result.");
    }
    const closeRpc = data.close_settlement_period_exists;
    const criticalRpcs = asObject(data.critical_rpcs);
    const missingCriticalRpcs = Object.entries(criticalRpcs)
      .filter(([, exists]) => exists !== true)
      .map(([rpcName]) => rpcName);
    if (closeRpc === false) {
      return fail("close_settlement_period RPC is installed", "The lightweight healthcheck ran, but close_settlement_period is missing from the schema.");
    }
    if (missingCriticalRpcs.length) {
      return fail("Critical write RPCs are installed", `Missing RPC(s): ${missingCriticalRpcs.join(", ")}. Run the latest Supabase migrations before disabling table fallbacks.`);
    }
    const schemaMigrations = asObject(data.schema_migrations);
    const missingSchemaMigrations = asArray(schemaMigrations.missing_migrations).filter(Boolean);
    if (missingSchemaMigrations.length) {
      return fail(
        "Fuel Ledger schema migrations are applied",
        `Missing migration(s): ${missingSchemaMigrations.join(", ")}. Run the latest Supabase migrations in order.`,
      );
    }
    const schemaDrift = asObject(data.schema_drift);
    const missingDriftTables = asArray(schemaDrift.missing_tables).filter(Boolean);
    const missingDriftColumns = asArray(schemaDrift.missing_columns).filter(Boolean);
    const missingDriftPolicies = asArray(schemaDrift.missing_policies).filter(Boolean);
    const driftIssues = [...missingDriftTables, ...missingDriftColumns, ...missingDriftPolicies];
    if (driftIssues.length) {
      return fail(
        "Fuel Ledger schema shape matches the app",
        `Missing schema object(s): ${driftIssues.slice(0, 12).join(", ")}${driftIssues.length > 12 ? `, and ${driftIssues.length - 12} more` : ""}. Run the latest Supabase migrations or re-apply supabase-schema.sql.`,
      );
    }
    const realtimePublication = asObject(data.realtime_publication);
    const realtimeExtraTables = asArray(realtimePublication.extra_tables).filter(Boolean);
    const ledgerEventsEnabled = realtimePublication.ledger_events_enabled;
    const details = [];
    if (Object.keys(criticalRpcs).length) details.push(`${Object.keys(criticalRpcs).length} critical RPC(s) available`);
    else if (closeRpc === true) details.push("close_settlement_period exists");
    if (schemaMigrations.latest_expected) {
      details.push(`schema migrations ${schemaMigrations.latest_applied || "unknown"}/${schemaMigrations.latest_expected}`);
    }
    if (schemaDrift.ok === true) details.push("schema drift OK");
    if (ledgerEventsEnabled === false) details.push("ledger_events is not in Realtime publication");
    if (realtimeExtraTables.length) details.push(`${realtimeExtraTables.length} extra Realtime table(s) published`);
    if (data.ledger_id) details.push(`ledger ${data.ledger_id}`);
    const result = pass(name, details.length ? details.join("; ") : input.detail || "Healthcheck RPC returned successfully.");
    if (realtimeExtraTables.length || ledgerEventsEnabled === false) {
      result.warning = true;
      result.level = "warning";
    }
    return result;
  }

  function isMissingRpcError(error) {
    return isMissingHealthcheckRpcError(error);
  }

  function normalizeRpcProbeResult(input = {}) {
    return normalizeHealthcheckRpcResult(input);
  }

  function summarizeSecurityStatus(status = {}) {
    const checks = asArray(status.checks);
    const failed = checks.filter((check) => !check.ok);
    const warnings = checks.filter(isWarning);
    return {
      checked: Boolean(status.checked),
      ok: status.checked ? failed.length === 0 : false,
      checkedAt: status.checkedAt || "",
      mode: status.mode || "unknown",
      failedCount: failed.length,
      warningCount: warnings.length,
      passedCount: checks.length - failed.length,
      checks
    };
  }

  function buildSupabaseSecurityChecks(input = {}) {
    const status = summarizeSecurityStatus(input.status || input.supabaseSecurityStatus || {});
    const checks = [];

    if (!status.checked) {
      checks.push(fail("Supabase security health has been checked", "Run Security health checks from Test Lab or refresh the scenario matrix."));
      return checks;
    }

    checks.push(status.ok
      ? pass("Supabase security health passed", `${status.passedCount} check(s) passed${status.warningCount ? ` with ${status.warningCount} warning(s)` : ""}.`)
      : fail("Supabase security health passed", `${status.failedCount} check(s) need attention.`));

    for (const check of status.checks) {
      if (!check.ok) checks.push(fail(check.name, check.detail || ""));
      else if (isWarning(check)) checks.push(warn(check.name, check.detail || ""));
      else checks.push(pass(check.name, check.detail || ""));
    }

    return checks;
  }

  function buildLocalSecurityChecks(input = {}) {
    const checks = [];
    const hasConfig = Boolean(input.hasSupabaseConfig);
    const hasSession = Boolean(input.hasSession);
    const isAdmin = Boolean(input.isAdmin);
    const hasMember = Boolean(input.hasMemberProfile);
    const normalizedStatus = asObject(input.normalizedTableStatus);

    checks.push(hasConfig ? pass("Supabase configuration is present") : pass("Local-only mode is explicit", "No usable Supabase configuration is present in this build."));
    if (hasConfig) {
      checks.push(hasSession ? pass("A Supabase session is active") : fail("A Supabase session is active", "Sign in before running live backend security checks."));
      checks.push(hasMember ? pass("Signed-in user maps to an active ledger member") : fail("Signed-in user maps to an active ledger member", "The current email is not linked to an active member."));
      checks.push(isAdmin ? pass("Current user can run admin-only security checks") : fail("Current user can run admin-only security checks", "Only admins should run Test Lab security checks."));
      if (normalizedStatus.checked) {
        checks.push(normalizedStatus.ok ? pass("Normalized table health is green", normalizedStatus.message || "") : fail("Normalized table health is green", normalizedStatus.message || ""));
      }
    }
    return checks;
  }

  function renderSecurityStatusText(status = {}) {
    const summary = summarizeSecurityStatus(status);
    if (!summary.checked) return "Supabase security health has not been checked yet.";
    const icon = summary.ok ? (summary.warningCount ? "OK with warnings" : "OK") : "Needs review";
    return `${icon}: ${summary.passedCount} passed, ${summary.warningCount || 0} warnings, ${summary.failedCount} failed${summary.checkedAt ? ` at ${summary.checkedAt}` : ""}.`;
  }

  window.FuelSecurityHealth = {
    pass,
    fail,
    warn,
    isMissingRpcError,
    isMissingHealthcheckRpcError,
    normalizeHealthcheckRpcResult,
    normalizeRpcProbeResult,
    summarizeSecurityStatus,
    buildSupabaseSecurityChecks,
    buildLocalSecurityChecks,
    renderSecurityStatusText
  };
})();

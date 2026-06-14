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

  function isMissingRpcError(error) {
    const code = String(error && error.code || "");
    if (code === "40001" || code === "42501" || code === "22023" || code === "23505") return false;
    const message = String(error && (error.message || error.details || error.hint) || error || "");
    return code === "PGRST202" || /close_settlement_period/i.test(message) && /not found|schema cache|could not find|does not exist/i.test(message);
  }

  function isExpectedClosePeriodProbeError(error) {
    const code = String(error && error.code || "");
    const message = String(error && (error.message || error.details || error.hint) || error || "");
    return code === "40001" || /not found or was already closed|open settlement period/i.test(message);
  }

  function normalizeRpcProbeResult(input = {}) {
    const name = input.name || "close_settlement_period RPC is available";
    if (input.skipped) return pass(name, input.detail || "Skipped.");
    if (input.ok) return pass(name, input.detail || "RPC probe succeeded.");
    const error = input.error || null;
    if (isExpectedClosePeriodProbeError(error)) {
      return pass(name, "RPC exists and rejected the harmless probe because the test period id is not an open period.");
    }
    if (isMissingRpcError(error)) {
      return fail(name, "RPC is missing from the Supabase schema. Run the latest supabase-schema.sql before relying on transactional period close.");
    }
    return fail(name, String(error && (error.message || error.details || error.hint) || error || "RPC probe failed."));
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
    isExpectedClosePeriodProbeError,
    normalizeRpcProbeResult,
    summarizeSecurityStatus,
    buildSupabaseSecurityChecks,
    buildLocalSecurityChecks,
    renderSecurityStatusText
  };
})();

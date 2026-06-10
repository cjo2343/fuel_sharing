(function () {
  function getSupabaseConfig() {
    return window.CAR_SHARE_SUPABASE || {};
  }

  function hasUsableSupabaseConfig(config) {
    return Boolean(
      config &&
        config.enabled &&
        config.url &&
        config.anonKey &&
        !config.url.includes("YOUR_PROJECT_REF") &&
        !config.anonKey.includes("YOUR_SUPABASE")
    );
  }

  function createSupabaseClient(config) {
    if (!hasUsableSupabaseConfig(config) || !window.supabase) return null;
    return window.supabase.createClient(config.url, config.anonKey);
  }

  function getLedgerId(config) {
    return config?.ledgerId || "main-car";
  }

  async function getFreshSession(client) {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session?.access_token) return null;
    return data.session;
  }

  async function ensureOpenSettlementPeriod(client, ledgerId) {
    const existing = await client
      .from("settlement_periods")
      .select("id")
      .eq("ledger_id", ledgerId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data?.id) return existing.data.id;

    const created = await client
      .from("settlement_periods")
      .insert({ ledger_id: ledgerId, status: "open", label: "Current period" })
      .select("id")
      .single();

    if (!created.error && created.data?.id) return created.data.id;

    // Another tab/device may have created the open period between our select and insert.
    // The database correctly rejects a second open period, so re-select and continue.
    if (created.error?.code === "23505") {
      const retry = await client
        .from("settlement_periods")
        .select("id")
        .eq("ledger_id", ledgerId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      if (retry.error) throw retry.error;
      if (retry.data?.id) return retry.data.id;
    }

    throw created.error || new Error("Could not create an open settlement period");
  }

  window.FuelSupabaseHelpers = {
    getSupabaseConfig,
    hasUsableSupabaseConfig,
    createSupabaseClient,
    getLedgerId,
    getFreshSession,
    ensureOpenSettlementPeriod
  };
})();
